// AI Assistant V2 — 项目发现工具包（全站搜索，不依赖当前打开的仓库）
//
// 与 github-read 的区别：那个包的所有工具都要求 ctx.repo（当前仓库上下文），
// 用户「想找一个能做 X 的项目」时根本没有当前仓库，所以必须独立成包。
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

function formatRepoBrief(repo: Record<string, any>, index: number): string {
  const lines: string[] = [];
  const archived = repo.archived ? ' · ⚠️已归档' : '';
  lines.push(
    `${index}. ${repo.full_name}  ★${repo.stargazers_count} · Fork ${repo.forks_count} · ` +
    `${repo.language || '语言未知'} · ${repo.open_issues_count} 个开放 issue${archived}`
  );
  lines.push(`   最近推送：${String(repo.pushed_at || '').slice(0, 10)}`);
  if (repo.description) {
    lines.push(`   ${String(repo.description).replace(/\s+/g, ' ').slice(0, 180)}`);
  }
  if (Array.isArray(repo.topics) && repo.topics.length) {
    lines.push(`   主题：${repo.topics.slice(0, 6).join(', ')}`);
  }
  lines.push(`   ${repo.html_url}`);
  return lines.join('\n');
}

const searchProjects: AgentTool = {
  name: 'github_search_projects',
  description:
    '在 GitHub 全站搜索仓库（不依赖当前打开的仓库），用于「帮我找一个能做 X 的项目」。' +
    'query 支持 GitHub 搜索限定符：language:typescript、stars:>500、pushed:>2025-01-01、topic:cli、license:mit。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词，可含 GitHub 限定符，例如「markdown editor language:typescript stars:>1000」',
      },
      sort: {
        type: 'string',
        enum: ['best-match', 'stars', 'forks', 'updated'],
        description: '排序方式，默认 best-match（综合匹配度）',
      },
      per_page: { type: 'number', description: '返回条数 1~20，默认 10' },
    },
    required: ['query'],
  },
  risk: 'read',
  async execute(args, ctx): Promise<ToolRunResult> {
    const query = String(args.query || '').trim();
    if (!query) return { ok: false, content: 'query 不能为空。' };

    const per = clampNumber(args.per_page, 1, 20, 10);
    const sortKey = String(args.sort || 'best-match');
    const sortMap: Record<string, string> = { stars: 'stars', forks: 'forks', updated: 'updated' };
    const sortQS = sortMap[sortKey] ? `&sort=${sortMap[sortKey]}&order=desc` : '';

    const data = await githubFetch(
      ctx,
      `/search/repositories?q=${encodeURIComponent(query)}${sortQS}&per_page=${per}`
    );
    const items = Array.isArray(data.items) ? (data.items as Record<string, any>[]) : [];
    const total = Number(data.total_count || 0);

    if (!items.length) {
      return {
        ok: true,
        content: `没有搜到匹配「${query}」的仓库。建议放宽条件：降低 stars 门槛、去掉语言限制，或改用更通用的关键词。`,
      };
    }

    const body = items.map((repo, i) => formatRepoBrief(repo, i + 1)).join('\n\n');
    return {
      ok: true,
      content: `「${query}」共 ${total.toLocaleString()} 个结果，以下是最相关的 ${items.length} 个：\n\n${body}`,
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
