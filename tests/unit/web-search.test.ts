import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSearchQuery, searchWeb, shouldSearch } from '../../src/web/search';

describe('read-only web search', () => {
  afterEach(() => vi.restoreAllMocks());

  it('detects search-oriented requests', () => {
    expect(shouldSearch('查找最近的采购公告')).toBe(true);
    expect(shouldSearch('打开这个官网核验公告原文')).toBe(true);
    expect(shouldSearch('网页访问一直失败，帮我看看到底怎么回事')).toBe(false);
    expect(shouldSearch('解释一下什么是碳管理')).toBe(false);
  });

  it('builds a focused query without relying on a domain-specific search rule', () => {
    const query = buildSearchQuery('请帮我确认最近一两天成都环境集团有没有两个碳管理平台项目，告诉我公告编号和预算');
    expect(query).toContain('成都环境集团');
    expect(query).toContain('碳管理平台');
    expect(query).not.toContain('site:cdenvironment.com');
    expect(query).not.toContain('请');
    expect(query).not.toContain('告诉我');
  });

  it('queries only user text from the real bridge envelope', () => {
    const prompt = `<bridge_context>\n${JSON.stringify({ chatId: 'oc_test', chatType: 'p2p', senderId: 'ou_test', botOpenId: 'ou_bot' })}\n</bridge_context>\n<bridge_instructions>["网页访问"]</bridge_instructions>\n<user_input>\n${JSON.stringify({ text: '查询成都环境集团碳管理采购公告' })}\n</user_input>`;
    expect(buildSearchQuery(prompt)).toBe('查询成都环境集团碳管理采购公告');
    expect(buildSearchQuery(prompt)).not.toContain('chatId');
    expect(shouldSearch(prompt.replace('查询成都环境集团碳管理采购公告', '你好'))).toBe(false);
  });

  it('extracts public result links and snippets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">标题</a><div class="result__snippet">摘要内容</div>',
      { status: 200 },
    )));
    const result = await searchWeb('最近的采购公告');
    expect(result).toContain('标题');
    expect(result).toContain('https://example.com/a');
    expect(result).toContain('摘要内容');
  });

  it('includes fetched public page text when a candidate is reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      if (String(input).includes('duckduckgo.com')) {
        return new Response(
          '<a class="result__a" href="https://example.com/a">标题</a><div class="result__snippet">摘要内容</div>',
          { status: 200 },
        );
      }
      return new Response('<html><body>官方原文内容</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }));
    const result = await searchWeb('最近的采购公告');
    expect(result).toContain('官方原文内容');
  });
});
