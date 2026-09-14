import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const search = require('../../chat5-compat/services/worldKnowledgeSearch.js') as {
  shouldFetchLatestWorldContext(text: string): boolean;
  buildSearchQuery(characterName: string, userInput: string): string;
  extractSearchResults(html: string, limit?: number): Array<{ title: string; url: string }>;
  stripHtmlText(html: string, maxLength?: number): string;
};

describe('world knowledge search gate', () => {
  it('only opens the web lookup for explicit current-world questions', () => {
    expect(search.shouldFetchLatestWorldContext('最近战双帕弥什有什么官方活动或剧情更新？')).toBe(true);
    expect(search.shouldFetchLatestWorldContext('最近工作有点累，想聊聊日常。')).toBe(false);
  });

  it('builds a character-scoped query without treating the current reply as fact', () => {
    expect(search.buildSearchQuery('赛琳娜', '最近官方有什么新剧情？'))
      .toContain('赛琳娜 最近官方有什么新剧情');
  });

  it('extracts bounded search results and readable page text', () => {
    const html = '<a class="result__a" href="https://example.com/a">官方公告 <b>一</b></a>'
      + '<a class="result__a" href="https://example.com/b">第二条</a>';
    expect(search.extractSearchResults(html, 1)).toEqual([
      { title: '官方公告 一', url: 'https://example.com/a' },
    ]);
    expect(search.stripHtmlText('<p>第一段</p><script>ignore()</script>第二段')).toBe('第一段 第二段');
  });
});
