// AI V2 — 内置技能（按需注入，不一次性塞进系统提示词）
export interface AgentSkill {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  /** 可选的中文表达规则：关键词表盖不住「帮我找个…项目」这种说法，用正则补一层 */
  patterns?: RegExp[];
  content: string;
}

export const SKILLS: AgentSkill[] = [
  {
    id: 'actions-debug',
    title: 'Actions 失败排查',
    description: '按 Job、失败步骤和日志证据定位 CI/CD 问题',
    keywords: ['actions', '工作流', 'ci', '构建失败', '部署失败', 'job', '日志', '报错'],
    content: [
      '处理 GitHub Actions 失败：',
      '1. 先确认失败的 workflow、run、job 和具体失败 step。',
      '2. 优先读取完整 Job 日志中的第一条错误，不要只看末尾摘要。',
      '3. 区分代码错误、依赖下载失败、密钥缺失、Runner 环境和临时网络问题。',
      '4. 给出最小修复方案；涉及修改文件时必须先读取目标文件。',
      '5. 修复后建议重跑失败 Job，并等待结果。',
    ].join('\n'),
  },
  {
    id: 'code-review',
    title: '代码审查',
    description: '优先检查正确性、回归风险、边界条件和可维护性',
    keywords: ['审查', 'review', '代码质量', '重构', 'bug', '风险', '检查'],
    content: [
      '代码审查规则：',
      '1. 先说明变更目的和影响范围。',
      '2. 优先找会导致错误、数据损坏、安全问题或回归的缺陷。',
      '3. 每个问题给出文件、位置、触发条件和修复建议。',
      '4. 不为了风格偏好制造大量低价值意见。',
      '5. 最后给出阻塞项和非阻塞项。',
    ].join('\n'),
  },
  {
    id: 'release',
    title: '发布与版本',
    description: '版本号、Release、APK、CI 产物校验流程',
    keywords: ['发布', 'release', '版本', 'apk', 'tag', '发版'],
    content: [
      '发布流程：',
      '1. 确认版本号、分支和待发布提交。',
      '2. 检查构建、测试和 CI 是否通过。',
      '3. 确认 Release 产物名称、大小和校验结果。',
      '4. 不覆盖已发布版本的 tag。',
      '5. 发布后核对线上部署和安装包版本。',
    ].join('\n'),
  },
  {
    id: 'repo-structure',
    title: '仓库结构分析',
    description: '从入口、目录、配置和依赖快速理解项目',
    keywords: ['仓库', '项目结构', '入口', '技术栈', '目录', '架构'],
    content: [
      '仓库分析顺序：',
      '1. 读取 README、package/build 配置和入口文件。',
      '2. 列出主要目录，而不是逐文件扫描。',
      '3. 识别运行时、框架、构建工具、测试和部署方式。',
      '4. 说明关键模块之间的依赖关系。',
      '5. 结论要附上实际读取过的文件依据。',
    ].join('\n'),
  },
  {
    id: 'project-discovery',
    title: '帮我找项目',
    description: '把模糊需求澄清成可搜索的条件，再全站找合适的 GitHub 项目',
    keywords: ['找项目', '推荐项目', '有什么项目', '替代', 'alternative', '类似', '用什么库', '找个工具', '想实现', '适合', '开源项目', '发现'],
    patterns: [
      /(找|推荐|求|想要|需要|有没有|搜|挑)[^。！？!?\n]{0,24}(项目|工具|库|框架|方案|软件|app|插件|服务|系统|应用|阅读器|编辑器|播放器|客户端|脚本|模板|平台)/i,
      /(帮我|给我|替我|我想|想)找/i,
      /(替代|平替|alternative|类似的东西|差不多的)/i,
      /(想实现|实现一个|做一个|想做个|开发一个)/i,
    ],
    content: [
      '帮用户找项目时，严格遵守以下流程（用户往往说不清自己的详细需求，所以他们描述得粗是很正常的）：',
      '',
      '【第一步：先判断需求清不清，别急着搜】',
      '1. 用户描述里已包含「做什么」+「运行环境或技术栈」+「规模/强度要求」中的至少两项 → 直接进入第三步搜索。',
      '2. 否则先问，但**最多问 2~3 个**问题，一次问完，不要一次问一个来回拉扯。',
      '3. 提问必须给选项，让用户点选而不是写小作文。例如：',
      '   「你打算怎么用它？A. 直接在手机/电脑上跑起来用 B. 当成库集成进自己的项目 C. 读源码学实现」',
      '   「更看重什么？A. 活跃维护少踩坑 B. 功能全 C. 代码简单好改」',
      '4. 能合理默认的就别问：不确定语言时优先选用户项目已有语言，不确定规模时默认「中小型、能直接跑」。',
      '5. 用户说「你看着办」「随便」时立即停止提问，用默认假设开搜，并在回复里明说假设了什么。',
      '',
      '【第二步：把需求翻译成搜索式】',
      '把澄清后的需求拆成 2~3 组互补的 query，而不是只搜一次：',
      '- 主流做法一组（关键词 + language: + stars:>500）',
      '- 轻量/小众一组（关键词 + stars:100..500，避免只被巨型项目埋没）',
      '- 活跃度过滤用 pushed:>YYYY-MM-DD（默认最近一年），排除弃坑项目',
      '不要堆叠过多限定符，超过 3 个容易零结果。',
      '',
      '【第三步：搜索并筛选】',
      '1. 调 github_search_projects 执行搜索。',
      '2. 对每个候选，重点看：最近推送时间、star 数、是否 archived、README 里有没有可行安装方式。',
      '3. 拿不准某个项目到底能不能满足需求时，调 github_project_detail 读 README，**不要凭仓库名猜**。',
      '4. 排除：已归档、README 明确写着「deprecated / no longer maintained」、与需求技术栈明显不兼容的。',
      '',
      '【第四步：给结论】',
      '1. 推荐 2~4 个，按「契合度 → 活跃度 → 上手成本」排序，第一个必须是你真正推荐的。',
      '2. 每个项目写清：一句话是什么、为什么适合这个用户、安装/使用方式、主要坑或限制。',
      '3. 明确说清哪些条件没满足或有妥协（例如「这个是 Web 版，没有原生 App」）。',
      '4. 最后可以补一句「如果不合适，告诉我更偏好哪一点，我再换一批」。',
      '',
      '【禁止】',
      '- 禁止在没调用搜索工具的情况下凭记忆报项目名和 star 数，数字会错。',
      '- 禁止一次返回一堆项目让用户自己挑；你必须给出筛选后的推荐意见。',
    ].join('\n'),
  },
];

export function selectSkills(query: string, max = 2): AgentSkill[] {
  const text = query.toLowerCase();
  if (!text.trim()) return [];
  const scored = SKILLS.map(skill => {
    let score = 0;
    for (const keyword of skill.keywords) {
      if (text.includes(keyword.toLowerCase())) score += keyword.length;
    }
    // 中文表达千变万化（「帮我找个…项目」不含任何固定关键词），用规则补一层
    for (const pattern of skill.patterns ?? []) {
      if (pattern.test(text)) score += 8;
    }
    return { skill, score };
    return { skill, score };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(item => item.skill);
}

export function getSkill(id: string): AgentSkill | undefined {
  return SKILLS.find(skill => skill.id === id);
}