interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

import { fetchPublicPage } from './read-only-fetch';
import { extractPromptUserText } from '../agent/prompt';

const SEARCH_TERMS = /搜索|查找|查询|打开|访问|网页|网站|官网|站点|核验|验证|最新|最近|实时|招标|采购|公告|新闻|资料|search|latest|recent|website|webpage|browse|verify|news|procurement|tender/i;

export function shouldSearch(prompt: string): boolean {
  prompt = extractPromptUserText(prompt);
  if (/(怎么回事|什么原因|为什么|失败|受限|报错|异常)/i.test(prompt)
    && /(帮我看|排查|定位|修复|解决)/i.test(prompt)
    && !/(查一下|帮我搜索|请搜索|search for|look up)/i.test(prompt)) {
    return false;
  }
  return SEARCH_TERMS.test(prompt);
}

/** Build a compact discovery query from a conversational request. */
export function buildSearchQuery(prompt: string): string {
  const normalized = extractPromptUserText(prompt)
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/请(?:帮我)?|帮我|帮忙|告诉我|能不能|可以吗/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const terms = normalized
    .split(/[^\p{Script=Han}A-Za-z0-9%.-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .filter((term) => !SEARCH_FILLER.has(term.toLowerCase()))
    .slice(0, 12);
  const query = terms.join(' ');
  return query || normalized.slice(0, 160);
}

export async function searchWeb(prompt: string): Promise<string> {
  if (!shouldSearch(prompt)) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const query = buildSearchQuery(prompt);
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; lark-channel-bridge/1.0)' },
    });
    if (!response.ok) return '';
    const html = await response.text();
    const results: SearchResult[] = [];
    const anchors = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const match of anchors.slice(0, 6)) {
      const url = decodeRedirect(decodeEntities(match[1] ?? ''));
      if (!/^https?:\/\//i.test(url)) continue;
      const title = cleanHtml(match[2] ?? '');
      const after = html.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 1800);
      const snippetMatch = after.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
      results.push({ title, url, snippet: cleanHtml(snippetMatch?.[1] ?? snippetMatch?.[2] ?? '') });
    }
    const candidates = results
      .filter((result) => result.title && result.url)
      .slice(0, 6);
    const pages = await Promise.all(
      candidates.slice(0, 3).map(async (result) => ({
        result,
        page: await fetchPublicPage(result.url),
      })),
    );
    return candidates
      .map((result, index) => {
        const page = pages.find((entry) => entry.result.url === result.url)?.page;
        const source = page ? `\n原文抓取:\n${page}` : '';
        return `${index + 1}. ${result.title}\nURL: ${result.url}\n摘要: ${result.snippet}${source}`;
      })
      .join('\n\n')
      .slice(0, 30_000);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

const SEARCH_FILLER = new Set([
  '请', '帮我', '帮忙', '一下', '现在', '目前', '然后', '是否', '有没有', '能否', '可以',
  '确认', '核实', '告诉我', '详细', '相关', '信息', '内容', '进行', '查看', '找到', '搜索',
  'search', 'please', 'find', 'look', 'check', 'tell', 'about', 'the', 'and', 'with',
]);

function decodeRedirect(url: string): string {
  try {
    const parsed = new URL(url.startsWith('//') ? `https:${url}` : url);
    const target = parsed.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : parsed.toString();
  } catch {
    return url;
  }
}

function cleanHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
