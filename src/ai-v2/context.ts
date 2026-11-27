// AI V2 — Context Builder：系统提示词 + 技能 + 记忆 + 预算裁剪
import type { AgentHistoryMessage, CapabilityInfo, V2ContentPart, V2ProviderMessage } from './types';
import { searchMemories } from './memory';
import { selectSkills } from './skills';

export interface BuiltContext {
  messages: V2ProviderMessage[];
  estimatedTokens: number;
  trimmedMessages: number;
  skillIds: string[];
  memoryIds: string[];
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if (code >= 0x2e80 && code <= 0x9fff) tokens += 1;
    else if (code >= 0xac00 && code <= 0xd7af) tokens += 1;
    else if (code >= 0xf900 && code <= 0xfaff) tokens += 1;
    else if (code >= 0x3040 && code <= 0x30ff) tokens += 1;
    else if (/\s/.test(char)) tokens += 0.1;
    else tokens += 0.28;
  }
  return Math.max(1, Math.ceil(tokens));
}

function takeTokenPrefix(text: string, limit: number): string {
  let used = 0;
  let index = 0;
  for (const character of text) {
    const code = character.codePointAt(0) || 0;
    const cost = (code >= 0x2e80 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0x3040 && code <= 0x30ff) ? 1 : /\s/u.test(character) ? 0.1 : 0.28;
    if (used + cost > limit) break;
    used += cost;
    index += character.length;
  }
  return text.slice(0, index);
}

export function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || !text) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  const notice = '…（已压缩）';
  const available = Math.floor(maxTokens) - estimateTokens(notice);
  if (available < 4) return takeTokenPrefix(text, maxTokens);
  const tail = takeTokenPrefix([...text].reverse().join(''), Math.floor(available * 0.25));
  return `${takeTokenPrefix(text, available - Math.ceil(estimateTokens(tail)))}${notice}${[...tail].reverse().join('')}`;
}

const IMAGE_TOKENS = 1000;
const MESSAGE_OVERHEAD = 6;

function messageTokens(message: V2ProviderMessage): number {
  const calls = message.tool_calls ? JSON.stringify(message.tool_calls) : '';
  const fields = estimateTokens(calls) + estimateTokens(message.name || '') + estimateTokens(message.tool_call_id || '');
  const content = Array.isArray(message.content)
    ? message.content.reduce((total, part) => total + (part.type === 'text' ? estimateTokens(part.text) : IMAGE_TOKENS), 0)
    : estimateTokens(message.content || '');
  // reasoning_content 在实际发请求前会被移除。
  return MESSAGE_OVERHEAD + fields + content;
}

export function estimateProviderMessages(messages: V2ProviderMessage[]): number {
  return messages.reduce((total, message) => total + messageTokens(message), 0);
}

function fitMessage(message: V2ProviderMessage, budget: number): V2ProviderMessage | null {
  if (messageTokens(message) <= budget) return message;
  const available = budget - messageTokens({ ...message, content: null });
  if (available < 1) return null;

  if (Array.isArray(message.content)) {
    const images = message.content.filter(part => part.type === 'image_url');
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const minimumText = Math.min(estimateTokens(text), 400);
    const kept = images.slice(0, Math.floor(Math.max(0, available - minimumText) / IMAGE_TOKENS));
    const notice = kept.length < images.length ? '\n部分图片因上下文预算省略。' : '';
    const textBudget = available - kept.length * IMAGE_TOKENS - estimateTokens(notice);
    const trimmed = truncateTextToTokens(text, textBudget);
    const content: V2ContentPart[] = [...(trimmed || notice ? [{ type: 'text' as const, text: trimmed + notice }] : []), ...kept];
    const fitted = { ...message, content };
    if (messageTokens(fitted) <= budget) return fitted;
    return { ...message, content: truncateTextToTokens(text, available) };
  }
  return { ...message, content: truncateTextToTokens(message.content || '', available) };
}

function collectMessageGroups(messages: V2ProviderMessage[]): V2ProviderMessage[][] {
  const groups: V2ProviderMessage[][] = [];
  for (const message of messages) {
    const previous = groups[groups.length - 1];
    if (message.role === 'tool' && previous?.[0].role === 'assistant') {
      previous.push(message);
    } else if (message.role !== 'tool') {
      groups.push([message]);
    }
  }
  return groups;
}

/** 保留系统/任务记录和当前用户要求，再从最新回合往前填充。助手调用与其工具结果一起保留。 */
export function compactProviderMessages(
  messages: V2ProviderMessage[],
  budget = 32000,
): V2ProviderMessage[] {
  if (estimateProviderMessages(messages) <= budget) return messages;

  const compacted = messages.slice();
  let toolSeen = 0;
  for (let index = compacted.length - 1; index >= 0; index--) {
    const message = compacted[index];
    if (message.role !== 'tool') continue;
    if (++toolSeen > 2 && typeof message.content === 'string' && message.content.length > 1500) {
      compacted[index] = { ...message, content: `${message.content.slice(0, 1500)}\n…（较早工具结果已压缩）` };
    }
  }
  if (estimateProviderMessages(compacted) <= budget) return compacted;
  // 最近的结果也可能很大。缩短正文时保留 tool_call_id 与调用参数。
  for (let index = 0; index < compacted.length; index++) {
    const message = compacted[index];
    if (message.role === 'tool' && typeof message.content === 'string' && estimateTokens(message.content) > 1500) {
      compacted[index] = { ...message, content: truncateTextToTokens(message.content, 1500) };
    }
  }

  const firstBody = compacted.findIndex(message => message.role !== 'system');
  const systems = firstBody === -1 ? compacted : compacted.slice(0, firstBody);
  const body = firstBody === -1 ? [] : compacted.slice(firstBody);
  let userIndex = body.length - 1;
  while (userIndex >= 0 && body[userIndex].role !== 'user') userIndex--;
  const reservedUser = userIndex >= 0 ? Math.min(messageTokens(body[userIndex]), Math.floor(budget / 2)) : 0;
  const keptSystems: V2ProviderMessage[] = [];
  let remaining = budget;
  for (let index = 0; index < systems.length; index++) {
    const later = systems.slice(index + 1);
    const reservedLater = Math.min(estimateProviderMessages(later), Math.floor(budget / 4));
    const fitted = fitMessage(systems[index], remaining - reservedUser - reservedLater);
    if (fitted) {
      keptSystems.push(fitted);
      remaining -= messageTokens(fitted);
    }
  }

  const latestUser = userIndex >= 0 ? body[userIndex] : null;
  const groupsAfter = collectMessageGroups(userIndex >= 0 ? body.slice(userIndex + 1) : body);
  const userBudget = groupsAfter.length ? Math.max(reservedUser, Math.floor(remaining * 0.75)) : remaining;
  const user = latestUser ? fitMessage(latestUser, Math.min(remaining, userBudget)) : null;
  if (user) remaining -= messageTokens(user);

  const takeRecent = (groups: V2ProviderMessage[][]): V2ProviderMessage[] => {
    const chosen: V2ProviderMessage[][] = [];
    for (let index = groups.length - 1; index >= 0; index--) {
      let group = groups[index];
      let cost = estimateProviderMessages(group);
      if (cost > remaining) {
        const perMessage = Math.min(1500, Math.floor(remaining / group.length));
        const shorter = group.map(message => fitMessage(message, perMessage));
        if (shorter.some(message => !message)) break;
        group = shorter as V2ProviderMessage[];
        cost = estimateProviderMessages(group);
      }
      if (cost > remaining) break;
      chosen.push(group);
      remaining -= cost;
    }
    return chosen.reverse().flat();
  };

  const after = takeRecent(groupsAfter);
  const before = user ? takeRecent(collectMessageGroups(body.slice(0, userIndex))) : [];
  return [...keptSystems, ...before, ...(user ? [user] : []), ...after];
}

export function buildAgentContext(params: {
  systemPrompt: string;
  history: AgentHistoryMessage[];
  query: string;
  userLogin?: string;
  capabilities: CapabilityInfo[];
  contextBudget?: number;
  memoryEnabled?: boolean;
}): BuiltContext {
  const budget = Math.max(6000, params.contextBudget || 32000);
  const skills = selectSkills(params.query);
  const memories = params.memoryEnabled === false
    ? []
    : searchMemories(params.userLogin, params.query, 5);

  const extraSections: string[] = [];
  if (params.capabilities.length) {
    extraSections.push([
      '# 当前激活能力',
      ...params.capabilities.map(item => `- ${item.id}：${item.label} — ${item.description}`),
    ].join('\n'));
  }
  // 项目发现：把「用户是不是在找项目」这个判断交给模型自己，而不是靠关键词正则去猜。
  // 只要 discover 能力包激活就常驻这段说明：措辞正常的、措辞奇怪的（「我想做个能 X 的东西」）都能盖到。
  if (params.capabilities.some(item => item.id === 'discover')) {
    extraSections.push([
      '# 项目发现（主动判断，不等用户说「找项目」）',
      '当用户的话里透出「我需要一个能解决 X 的东西」这层意思时——不管他说的是「找个项目」「有没有工具」「想实现一个功能」，还是只描述了一个痛点或想要的效果——都要主动识别为「他在寻求项目/方案推荐」，然后按下面做：',
      '',
      '1. 先在心里抽三个要素：他要做什么、跑在哪（手机/电脑/网页/嵌进自己项目）、最在意什么（能直接用 / 代码简单好改 / 维护活跃）。',
      '2. 这三项里缺两项以上，先问；但**最多问 2~3 个问题且一次问完**，每个问题给选项让他点，不要让他写长文。',
      '3. 能合理默认的就默认（语言优先跟他已有项目一致，规模默认中小型且能直接跑），并在回复里明说假设了什么。',
      '4. 用户表示「你看着办 / 随便 / 都行」时立即停止提问，用默认假设开搜。',
      '5. 搜索用 github_search_projects，拆成 2~3 组互补查询（主流一组 + 轻量一组），活跃度用 pushed: 过滤，限定符不要超过 3 个。',
      '6. 拿不准某个项目到底能不能满足需求时，调 github_project_detail 读 README，**不要凭仓库名猜**。',
      '7. 最终只给 2~4 个推荐，按「契合度 → 活跃度 → 上手成本」排序，第一个必须是你真心推荐的；每个写清「是什么 / 为什么适合你 / 怎么用 / 有什么坑」，并坦白哪些条件没满足。',
      '8. 不许没调搜索工具就凭记忆报项目名和 star 数。',
      '9. 只有当用户就是在问「当前这个仓库」时才不下发本流程；即使挂着仓库上下文，只要他想找的是别的项目或替代方案，照常按上面走。',
    ].join('\n'));
  }
  if (skills.length) {
    extraSections.push([
      '# 相关技能',
      ...skills.map(skill => `## ${skill.title}\n${skill.content}`),
    ].join('\n\n'));
  }
  if (memories.length) {
    extraSections.push([
      '# 相关长期记忆',
      ...memories.map(memory => `- ${memory.content}${memory.tags.length ? `（${memory.tags.join('、')}）` : ''}`),
    ].join('\n'));
  }

  let systemContent = [params.systemPrompt, ...extraSections].filter(Boolean).join('\n\n');
  let systemTokens = estimateTokens(systemContent);
  const maxSystemTokens = Math.max(1000, budget - 6000);
  if (systemTokens > maxSystemTokens) {
    systemContent = truncateTextToTokens(systemContent, maxSystemTokens);
    systemTokens = estimateTokens(systemContent);
  }

  // 给本轮输出和工具结果预留空间
  const historyBudget = Math.max(1500, budget - systemTokens - 6000);
  const selected: AgentHistoryMessage[] = [];
  let used = 0;
  for (let i = params.history.length - 1; i >= 0; i--) {
    const item = params.history[i];
    const cost = messageTokens(item);
    if (selected.length > 0 && used + cost > historyBudget) break;
    selected.unshift(item);
    used += cost;
  }
  const trimmedMessages = params.history.length - selected.length;
  if (trimmedMessages > 0) {
    systemContent += `\n\n# 上下文说明\n较早的 ${trimmedMessages} 条原始消息已省略。继续任务时先参考本机任务记录。`;
    if (estimateTokens(systemContent) > maxSystemTokens) {
      systemContent = truncateTextToTokens(systemContent, maxSystemTokens);
    }
    systemTokens = estimateTokens(systemContent);
  }

  const messages: V2ProviderMessage[] = [
    { role: 'system', content: systemContent },
    ...selected.map((item): V2ProviderMessage => ({ role: item.role, content: item.content })),
  ];

  return {
    messages,
    estimatedTokens: systemTokens + used,
    trimmedMessages,
    skillIds: skills.map(skill => skill.id),
    memoryIds: memories.map(memory => memory.id),
  };
}