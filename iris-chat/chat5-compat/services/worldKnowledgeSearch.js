const axios = require('axios');

const SEARCH_URL = 'https://html.duckduckgo.com/html/';
const USER_AGENT = 'ChatX2/2.0 (on-demand world knowledge lookup)';
const LATEST_QUERY = /最新|最近|近期|刚更新|新剧情|新活动|新版本|发生了什么/;
const WORLD_QUERY = /剧情|活动|版本|更新|公告|官方|世界观|设定|事件|消息|战双|帕弥什|角色/;

function shouldFetchLatestWorldContext(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length >= 6 && LATEST_QUERY.test(value) && WORLD_QUERY.test(value);
}

function buildSearchQuery(characterName, userInput) {
  const name = String(characterName || '').replace(/\s+/g, ' ').trim();
  const input = String(userInput || '').replace(/\s+/g, ' ').trim();
  return `${name} ${input} 官方 公告 剧情 活动`.trim().slice(0, 240);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripHtmlText(html, maxLength = 2400) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return decodeHtmlEntities(text).slice(0, Math.max(120, Number(maxLength) || 2400)).trim();
}

function normalizeResultUrl(rawUrl) {
  const value = decodeHtmlEntities(rawUrl).trim();
  if (!value) return '';
  try {
    const parsed = new URL(value, SEARCH_URL);
    const redirected = parsed.searchParams.get('uddg');
    const target = redirected || parsed.toString();
    return /^https?:\/\//i.test(target) && !target.includes('duckduckgo.com') ? target : '';
  } catch {
    return '';
  }
}

function extractSearchResults(html, limit = 4) {
  const source = String(html || '');
  const results = [];
  const resultRegex = /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = resultRegex.exec(source)) !== null && results.length < Math.max(1, Number(limit) || 4)) {
    const url = normalizeResultUrl(match[1]);
    const title = stripHtmlText(match[2], 220);
    if (!url || !title) continue;
    results.push({ title, url });
  }
  return results;
}

async function fetchLatestWorldContext(characterName, userInput, options = {}) {
  if (!shouldFetchLatestWorldContext(userInput)) return '';
  const query = buildSearchQuery(characterName, userInput);
  const timeout = Math.max(3000, Number(options.timeout) || 8000);
  try {
    const searchResponse = await axios.get(SEARCH_URL, {
      params: { q: query },
      timeout,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    const results = extractSearchResults(searchResponse.data, 4);
    const sources = [];
    for (const result of results.slice(0, 3)) {
      try {
        const pageResponse = await axios.get(result.url, {
          timeout,
          maxRedirects: 3,
          responseType: 'text',
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        });
        const content = stripHtmlText(pageResponse.data, 1800);
        if (content.length >= 80) sources.push(`- ${result.title}\n  来源：${result.url}\n  ${content}`);
      } catch (error) {
        console.warn(`[WorldSearch] 页面读取失败: ${result.url}`, error.message);
      }
    }
    if (sources.length === 0) return '';
    return [
      '【按需联网资料（低优先级，仅供当前问题参考）】',
      ...sources,
      '以上内容来自临时网页检索，可能不完整或非官方；只在与用户当前问题直接相关时谨慎引用，不要当作已确认事实，也不要写入长期记忆。',
    ].join('\n');
  } catch (error) {
    console.warn('[WorldSearch] 搜索失败，继续使用本地角色资料:', error.message);
    return '';
  }
}

module.exports = {
  shouldFetchLatestWorldContext,
  buildSearchQuery,
  extractSearchResults,
  stripHtmlText,
  fetchLatestWorldContext,
};
