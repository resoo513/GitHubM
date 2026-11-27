// AI Assistant V2 — 项目发现工具包（全站搜索，不依赖当前打开的仓库）
//
// 与 github-read 的区别：那个包的所有工具都要求 ctx.repo（当前仓库上下文），
// 用户「想找一个能做 X 的项目」时根本没有当前仓库，所以必须独立成包。
//
// 检索语法部分参考并提炼自 aaddrick/gh-cli-search（MIT）的 gh-search-repos 技能：
// 取其对 REST Search API 同样成立的部分（限定符词汇表、区间/比较运算、否定语法、
// 常见误用），丢掉纯 CLI 的 `--` 分隔符与 --% 之类 shell 技巧。
import type { AgentTool, ToolRunResult, ToolRuntimeContext } from '../types';
import { fetchWithResilience } from '@/services/github/http';

const API = 'https://api.github.com';

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function githubFetch(ctx: ToolRuntimeContext, path: string): Promise<Record<string, unknown>> {
  const res = await fetchWithResilience(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: ctx.signal,
  }, 'GET');
  const text = await res.text();
  if (!res.ok) {
    // 403/429 多半是限额，给出可操作的提示而不是把原始 JSON 丢给模型
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub 搜索接口触发限流（未登录 10 次/分钟，登录 30 次/分钟）。请等待约 1 分钟再试，或减少搜索次数。');
    }
    throw new Error(`GitHub 返回 ${res.status}：${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

function decodeGithubBase64(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * 清洗模型可能写歪的 query。
 * 模型偶尔会照抄 gh CLI 写法（`gh search repos -- "x"`），或误用 `NOT` 关键字
 * —— GitHub 搜索的否定只能写成 `-qualifier:value`。
 */
function normalizeQuery(raw: string): { query: string; notes: string[] } {
  const notes: string[] = [];
  let q = raw.trim();

  const stripped = q
    .replace(/^gh\s+search\s+repos?\s+/i, '')
    .replace(/^--\s+/, '')
    .replace(/^["']/, '')
    .replace(/["']$/, '');
  if (stripped !== q) {
    notes.push('已去掉 query 里的 `gh search repos` / `--` / 引号（这里直接走 REST API，不需要 shell 写法）');
    q = stripped;
  }

  // NOT language:go → -language:go
  const beforeNot = q;
  q = q.replace(/\bNOT\s+([a-z-]+:)/gi, '-$1');
  if (q !== beforeNot) notes.push('`NOT x:` 已改成 `-x:`（GitHub 搜索不支持 NOT 关键字）');

  return { query: q.replace(/\s+/g, ' ').trim(), notes };
}

/** 零结果时逐级放宽：先去 stars，再去 language，最后只留关键词 */
function relaxQueries(query: string): string[] {
  const out: string[] = [];
  const noStars = query.replace(/\s+stars:[^\s]+/gi, '').trim();
  if (noStars && noStars !== query) out.push(noStars);
  const noLang = noStars.replace(/\s+language:[^\s]+/gi, '').trim();
  if (noLang && noLang !== noStars) out.push(noLang);
  const keywordsOnly = noLang.replace(/\s+[a-z-]+:[^\s]+/gi, '').trim();
  if (keywordsOnly && keywordsOnly !== noLang) out.push(keywordsOnly);
  return out;
}

function formatRepoBrief(repo: Record<string, any>, index: number): string {
  // 只给模型最少但足够的字段：名字、热度、语言、活跃度、一句话定位
  // fork 数/issue 数/topics 这类字段会诱使模型堆际数据、把回答写成散文，故不提供
  const archived = repo.archived ? ' · ⚠️已归档' : '';
  const license = repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION'
    ? ` · ${repo.license.spdx_id}` : '';
  const head =
    `${index}. ${repo.full_name}  ★${repo.stargazers_count} · ${repo.language || '语言未知'}` +
    ` · 推送 ${String(repo.pushed_at || '').slice(0, 10)}${license}${archived}`;
  const desc = repo.description
    ? `   ${String(repo.description).replace(/\s+/g, ' ').slice(0, 110)}`
    : '   （无描述）';
  return `${head}\n${desc}\n   ${repo.html_url}`;
}

const searchProjects: AgentTool = {
  name: 'github_search_projects',
  description:
    '在 GitHub 全站搜索仓库（不依赖当前打开的仓库），用于「帮我找一个能做 X 的项目」「有没有替代 Y 的」这类需求。\n' +
    '\n' +
    'query 支持 GitHub 搜索限定符，写对能大幅提高命中率：\n' +
    '- 语言/主题/许可：language:typescript、topic:cli、license:mit\n' +
    '- 热度：stars:>500、stars:100..1000、forks:>100\n' +
    '- 活跃度：pushed:>2025-01-01、created:<2024-01-01\n' +
    '- 状态：archived:false、fork:false、in:name、in:description、in:readme\n' +
    '- 新手友好：good-first-issues:>=5、help-wanted-issues:>=3\n' +
    '- 否定：-language:php、-topic:deprecated（用减号，不要用 NOT）\n' +
    '\n' +
    '建议拆成 2~3 组互补查询而不是一次搜完：主流一组（stars:>500）、轻量一组（stars:50..500）。\n' +
    '零结果时会自动逐级放宽（去 stars、去 language）并告知放宽后的查询，不要自己反复重试同样的查询。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          '搜索关键词 + 可选限定符，例如「markdown editor language:typescript stars:>1000 archived:false」。限定符别超过 3 个，否则容易零结果。',
      },
      sort: {
        type: 'string',
        enum: ['best-match', 'stars', 'forks', 'updated', 'help-wanted-issues'],
        description: '排序方式，默认 best-match（综合匹配度）；找热门项目用 stars',
      },
      per_page: { type: 'number', description: '返回条数 1~20，默认 10' },
    },
    required: ['query'],
  },
  risk: 'read',
  async execute(args, ctx): Promise<ToolRunResult> {
    const raw = String(args.query || '').trim();
    if (!raw) return { ok: false, content: 'query 不能为空。' };

    const { query, notes: fixNotes } = normalizeQuery(raw);
    if (!query) return { ok: false, content: '清洗后 query 为空，请给出关键词。' };

    const per = clampNumber(args.per_page, 1, 20, 10);
    const sortKey = String(args.sort || 'best-match');
    const sortMap: Record<string, string> = {
      stars: 'stars',
      forks: 'forks',
      updated: 'updated',
      'help-wanted-issues': 'help-wanted-issues',
    };
    const sortQS = sortMap[sortKey] ? `&sort=${sortMap[sortKey]}&order=desc` : '';

    const attempts = [query, ...relaxQueries(query)];
    let usedQuery = query;
    let items: Record<string, any>[] = [];
    let total = 0;
    let relaxed = false;

    for (let i = 0; i < attempts.length; i++) {
      const candidate = attempts[i];
      // eslint-disable-next-line no-await-in-loop
      const data = await githubFetch(
        ctx,
        `/search/repositories?q=${encodeURIComponent(candidate)}${sortQS}&per_page=${per}`
      );
      const got = Array.isArray(data.items) ? (data.items as Record<string, any>[]) : [];
      if (got.length) {
        items = got;
        total = Number(data.total_count || 0);
        usedQuery = candidate;
        relaxed = i > 0;
        break;
      }
    }

    const prefix = fixNotes.length ? `（已修正 query）${fixNotes.join('；')}\n\n` : '';

    if (!items.length) {
      return {
        ok: true,
        content:
          prefix +
          `没有搜到匹配「${query}」的仓库，已尝试放宽条件仍无结果。\n` +
          '建议：换成更通用的核心名词（例如用 editor 而不是 markdown 公众号编辑器）、去掉所有限定符，或换个角度描述需求。',
      };
    }

    const body = items.map((repo, i) => formatRepoBrief(repo, i + 1)).join('\n\n');
    const relaxNote = relaxed ? `（原查询零结果，已自动放宽为「${usedQuery}」）\n` : '';
    return {
      ok: true,
      content:
        prefix + relaxNote +
        `「${usedQuery}」共 ${total.toLocaleString()} 个结果，以下是最相关的 ${items.length} 个：\n\n${body}`,
    };
  },
};

const projectDetail: AgentTool = {
  name: 'github_project_detail',
  description:
    '读取某个公开仓库的详情与 README 摘录，用于判断它到底能不能满足用户需求（是否活跃、怎么装、依赖什么、有没有坑）。' +
    '一般在 github_search_projects 之后，对候选项目逐个调用。',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: '仓库全名，例如 owner/name' },
      readme_chars: { type: 'number', description: 'README 摘录字符数，默认 2500，范围 500~6000' },
    },
    required: ['repo'],
  },
  risk: 'read',
  async execute(args, ctx): Promise<ToolRunResult> {
    const full = String(args.repo || '').trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(full)) {
      return { ok: false, content: 'repo 需要是 owner/name 格式，例如 facebook/react。' };
    }
    const chars = clampNumber(args.readme_chars, 500, 6000, 2500);

    const info = await githubFetch(ctx, `/repos/${encodeURIComponent(full.split('/')[0])}/${encodeURIComponent(full.split('/')[1])}`);

    let readme = '';
    try {
      const rm = await githubFetch(ctx, `/repos/${full}/readme`);
      if (typeof rm.content === 'string') {
        readme = decodeGithubBase64(rm.content).slice(0, chars);
      }
    } catch {
      // README 缺失或超大文件不致命，继续往下走
      readme = '';
    }

    const head = [
      `${info.full_name}`,
      `★${info.stargazers_count} · Fork ${info.forks_count} · ${info.language || '语言未知'} · ${info.open_issues_count} 个开放 issue`,
      `最近推送：${String(info.pushed_at || '').slice(0, 10)}｜创建于：${String(info.created_at || '').slice(0, 10)}`,
      `许可证：${info.license && (info.license as any).spdx_id ? (info.license as any).spdx_id : '无/未声明'}`,
      `主页：${info.html_url}`,
      info.archived ? '⚠️ 该仓库已归档（不再维护）' : '',
      info.description ? `简介：${info.description}` : '',
      Array.isArray(info.topics) && info.topics.length ? `主题：${(info.topics as string[]).join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const readmeBlock = readme
      ? `\n\n—— README 摘录（前 ${readme.length} 字符）——\n${readme}`
      : '\n\n（该仓库没有 README 或无法读取）';

    return { ok: true, content: head + readmeBlock };
  },
};

export const DISCOVER_TOOLS: AgentTool[] = [searchProjects, projectDetail];
