const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { CHARACTER_DIR, DATA_DIR } = require('./appPaths');
const {
  ROLEPLAY_SECTIONS,
  buildRoleplayDistillationRequirements,
  analyzeRoleplaySkillCoverage,
  validateRoleplayDistillationManifest,
} = require('./roleplayDistillationContract');
const {
  buildUniversalDistillPrompt,
  buildUniversalCustomDistillPrompt,
  UNIVERSAL_DISTILL_SYSTEM_PROMPT,
} = require('./distillPrompt');
const {
  analyzeChatStyle,
  buildStyleStatsBlock,
  smartSampleMaterial,
} = require('./chatStyleProfiler');
// buildRoleplayDistillationRequirements() is consumed by the shared prompt builder.

function getCharacterDir(characterId) {
  return path.join(CHARACTER_DIR, characterId);
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE').substring(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

// 读取/创建 manifest.json（蒸馏元数据，记录来源、日期、覆盖范围）
function readManifest(characterId) {
  const filePath = path.join(getCharacterDir(characterId), 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return {
      schema_version: '1.2',
      character_id: characterId,
      distill_method: null,
      character_type: null,
      generated_at: null,
      last_updated_at: null,
      covered_until: null,
      sources: [],
      query_plan: [],
      search_diagnostics: {},
      citations: [],
      coverage_by_section: {},
      warnings: [],
      partial_result: false,
      input_summary: null,
      honesty_boundary: '',
    };
  }
}

function writeManifest(characterId, manifest) {
  const dir = getCharacterDir(characterId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'manifest.json');
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
}

// 通用 HTTP 抓取
async function fetchUrl(url, options = {}) {
  const defaultOpts = {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/json',
    },
    maxRedirects: 3,
    responseType: 'text',
  };
  const opts = { ...defaultOpts, ...options, headers: { ...defaultOpts.headers, ...(options.headers || {}) } };
  const maxAttempts = Math.max(1, Math.min(2, Number(options.maxAttempts || 2)));
  delete opts.maxAttempts;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.get(url, opts);
      return res.data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const retryable = !status || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt >= maxAttempts) break;
      await new Promise(resolve => setTimeout(resolve, 700 * attempt));
    }
  }
  throw lastError;
}

function canonicalizeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|source$|ref$|track|share_)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return String(rawUrl || '').trim();
  }
}

function contentFingerprint(content) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function scoreSource(url, title = '') {
  const text = `${url || ''} ${title || ''}`.toLowerCase();
  if (/kurobbs\.com|biligame\.com|wikipedia\.org|moegirl\.org|baidu\.com\/item/.test(text)) {
    return { tier: 'high', score: 0.9 };
  }
  if (/wiki|baike|fandom|official|官网|设定集/.test(text)) return { tier: 'high', score: 0.82 };
  if (/zhihu|tieba|forum|bbs|reddit/.test(text)) return { tier: 'medium', score: 0.58 };
  return { tier: 'medium', score: 0.68 };
}

function buildResearchQueryPlan(characterName, parsedHints) {
  const hint = parsedHints.searchQuery ? ` ${parsedHints.searchQuery}` : '';
  return [
    { section: 'identity_world', query: `"${characterName}"${hint} 身份 世界观 官方设定` },
    { section: 'personality_values', query: `"${characterName}"${hint} 性格 价值观 行为动机` },
    { section: 'speech_style', query: `"${characterName}"${hint} 台词 语录 说话风格` },
    { section: 'relationships', query: `"${characterName}"${hint} 人际关系 重要人物 羁绊` },
    { section: 'emotional_patterns', query: `"${characterName}"${hint} 情绪 触发 表现 反应` },
    { section: 'daily_interaction', query: `"${characterName}"${hint} 日常语音 关心 问候 互动习惯` },
  ];
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// 清洗 HTML 为纯文本
function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  let text = html;
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  text = text.replace(/\s+/g, ' ');
  return text.trim();
}

// 搜狗搜索（替代DuckDuckGo，国内可用）
async function searchSogou(query, maxResults = 8) {
  const results = [];
  try {
    const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
    const html = await fetchUrl(url, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    // 搜狗搜索结果有两种URL格式：
    // 1. data-url属性包含真实URL（优先）
    // 2. h3 > a 标签的href是重定向链接
    const seen = new Set();

    // 方法1：从data-url属性提取真实URL
    const dataUrlRegex = /<a[^>]*data-url=["'](https?:\/\/(?!www\.sogou\.com)[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = dataUrlRegex.exec(html)) !== null && results.length < maxResults) {
      const realUrl = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (realUrl && title && title.length > 2 && !seen.has(realUrl)) {
        seen.add(realUrl);
        results.push({ url: realUrl, title, isRedirect: false });
      }
    }

    // 方法2：从h3 > a标签提取（需要解析重定向）
    if (results.length < maxResults) {
      const resultRegex = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
        const rawUrl = match[1];
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        if (rawUrl.startsWith('/link?url=')) {
          const redirectUrl = 'https://www.sogou.com' + rawUrl;
          if (!seen.has(redirectUrl) && title && title.length > 2) {
            seen.add(redirectUrl);
            results.push({ url: redirectUrl, title, isRedirect: true });
          }
        }
      }
    }
  } catch (e) {
    console.error('[Distill] 搜狗搜索失败:', e.message);
  }
  return results;
}

// 跟随搜狗重定向获取真实URL
async function resolveSogouRedirect(redirectUrl) {
  try {
    const res = await axios.get(redirectUrl, {
      timeout: 10000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      responseType: 'text',
    });
    const html = typeof res.data === 'string' ? res.data : '';

    // 搜狗重定向页面用 window.location.replace("真实URL")
    const jsReplace = html.match(/window\.location\.replace\(["']([^"']+)["']\)/i);
    if (jsReplace && !jsReplace[1].includes('sogou.com')) {
      return jsReplace[1];
    }

    // meta refresh
    const metaRefresh = html.match(/URL=['"]?([^"'\s>]+)/i);
    if (metaRefresh && !metaRefresh[1].includes('sogou.com')) {
      return metaRefresh[1];
    }

    // 检查最终URL
    const finalUrl = res.request?.res?.responseUrl || res.config?.url;
    if (finalUrl && !finalUrl.includes('sogou.com')) {
      return finalUrl;
    }

    return null;
  } catch (e) {
    return null;
  }
}

// DuckDuckGo 搜索（备用，国内可能超时）
async function searchDuckDuckGo(query, maxResults = 8) {
  const results = [];
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await fetchUrl(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const rawUrl = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      let cleanUrl = rawUrl;
      const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        cleanUrl = decodeURIComponent(uddgMatch[1]);
      }
      if (cleanUrl && title && !cleanUrl.includes('duckduckgo')) {
        results.push({ url: cleanUrl, title });
      }
    }
  } catch (e) {
    console.error('[Distill] DuckDuckGo搜索失败:', e.message);
  }
  return results;
}

// 百度贴吧搜索（通过搜狗搜索site:tieba.baidu.com间接获取）
async function searchTieba(characterName, searchHints = []) {
  const results = [];
  try {
    // 用搜狗搜索贴吧内容
    const query = `site:tieba.baidu.com ${characterName} ${searchHints.join(' ')} 剧情 设定`;
    const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
    const html = await fetchUrl(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    // 从data-url属性提取真实URL
    const dataUrlRegex = /<a[^>]*data-url=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const seen = new Set();
    while ((match = dataUrlRegex.exec(html)) !== null && results.length < 5) {
      const realUrl = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (realUrl.includes('tieba.baidu.com') && title && title.length > 2 && !seen.has(realUrl)) {
        seen.add(realUrl);
        results.push({ url: realUrl, title, isRedirect: false });
      }
    }
  } catch (e) {
    console.error('[Distill] 贴吧搜索失败:', e.message);
  }
  return results;
}

// 库洛Wiki API搜索（需要登录token，数据最全面）
// 支持战双帕弥什(pns, wiki_type=2)和鸣潮(mc, wiki_type=9)
async function searchKuroWiki(characterName, token, searchHints = [], characterContext = '', forceGameType = '') {
  const results = [];
  if (!token) return results;

  const API_BASE = 'https://api.kurobbs.com';
  const crypto = require('crypto');
  const devcode = crypto.randomBytes(16).toString('hex');

  // 根据用户指定或角色上下文判断游戏类型
  let wikiType = '2'; // 默认战双
  let gamePath = 'pns';

  if (forceGameType === 'mc') {
    // 用户手动选择鸣潮
    wikiType = '9';
    gamePath = 'mc';
  } else if (forceGameType === 'pns') {
    // 用户手动选择战双
    wikiType = '2';
    gamePath = 'pns';
  } else {
    // 自动判断：根据角色上下文关键词匹配
    const pnsKeywords = ['帕弥什', '构造体', '灰鸦', '空中花园', '感染体', '升格者', '战双', '指挥官'];
    const mcKeywords = ['共鸣者', '声骸', '漂泊者', '索拉里斯', '黑石', '鸣潮', '溯回', '频移'];
    const context = (characterContext || '') + characterName;
    const pnsScore = pnsKeywords.filter(k => context.includes(k)).length;
    const mcScore = mcKeywords.filter(k => context.includes(k)).length;
    if (mcScore > pnsScore) {
      wikiType = '9';
      gamePath = 'mc';
    }
  }
  console.log(`[KuroWiki] 游戏类型: ${gamePath === 'pns' ? '战双帕弥什' : '鸣潮'} (wiki_type=${wikiType})`);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'Origin': 'https://wiki.kurobbs.com',
    'Referer': 'https://wiki.kurobbs.com/',
    'source': 'h5',
    'wiki_type': wikiType,
    'devcode': devcode,
    'token': token,
  };

  function formUrl(obj) {
    return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  // 从搜索提示词中提取排除关键词（NOT后面的词）
  const excludeWords = [];
  for (let i = 0; i < searchHints.length; i++) {
    if (searchHints[i].toUpperCase() === 'NOT' && searchHints[i + 1]) {
      excludeWords.push(searchHints[i + 1]);
      i++;
    }
  }
  // 默认排除：战双帕弥什中"露西亚"是复制体，排除本体相关词条
  if (characterName === '露西亚' && excludeWords.length === 0) {
    excludeWords.push('深红', '逆冕');
  }

  function shouldExclude(title) {
    if (!title) return false;
    return excludeWords.some(w => title.includes(w));
  }

  // 从getPage结果中提取文本内容
  function extractPageContent(items) {
    let content = '';
    for (const item of (Array.isArray(items) ? items : []).slice(0, 8)) {
      const itemContent = item.content || item.text || item.body || '';
      const itemTitle = item.catalogueItemName || item.title || item.name || '';
      if (typeof itemContent === 'object') {
        const textList = itemContent.textList || [];
        const texts = textList.map(t => t.content || '').filter(t => t.length > 5);
        if (texts.length > 0) {
          content += `\n【${itemContent.title || itemTitle}】\n${texts.join('\n')}\n`;
        }
        if (itemContent.summary && itemContent.summary.length > 10) {
          content += `\n【${itemContent.title || itemTitle} - 摘要】\n${itemContent.summary}\n`;
        }
      } else if (typeof itemContent === 'string' && itemContent.length > 20) {
        const cleanContent = itemContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (cleanContent.length > 20) {
          content += `\n【${itemTitle}】\n${cleanContent.substring(0, 2000)}\n`;
        }
      }
    }
    return content;
  }

  // 递归收集目录树中所有叶子节点（hasItem或无children的节点）的id
  function collectLeafIds(nodes, result = []) {
    if (!Array.isArray(nodes)) return result;
    for (const node of nodes) {
      const children = node.children || [];
      if (children.length === 0) {
        const id = node.id || node.catalogueId;
        if (id) result.push({ id, name: node.name || '' });
      } else {
        collectLeafIds(children, result);
      }
    }
    return result;
  }

  // 递归查找名称匹配的目录节点及其子节点
  function findCataloguesByName(nodes, keywords, result = []) {
    if (!Array.isArray(nodes)) return result;
    for (const node of nodes) {
      const name = node.name || '';
      if (keywords.some(k => name.includes(k))) {
        // 收集这个节点下的所有叶子节点
        const leaves = collectLeafIds([node]);
        result.push(...leaves);
      }
      if (node.children) findCataloguesByName(node.children, keywords, result);
    }
    return result;
  }

  try {
    // ===== 1. 获取完整目录树，动态找到剧情相关目录 =====
    console.log('[KuroWiki] 获取目录树...');
    const treeRes = await axios.post(`${API_BASE}/wiki/core/catalogue/config/getTree`,
      formUrl({ wikiType }),
      { timeout: 15000, headers });

    if (treeRes.data.code !== 200 || !treeRes.data.data) {
      console.log('[KuroWiki] 获取目录树失败:', treeRes.data.msg);
      return results;
    }

    // 根据游戏类型搜索不同关键词的目录
    const storyKeywords = gamePath === 'pns'
      ? ['剧情', '档案']  // 战双：剧情(主线/间章/好感/活动等)、档案馆(人物档案)
      : ['剧情合集', '共鸣者']; // 鸣潮：剧情合集(潮汐/伴星/活动)、共鸣者(角色介绍)

    const storyCatalogues = findCataloguesByName(treeRes.data.data.children || [], storyKeywords);
    console.log(`[KuroWiki] 找到${storyCatalogues.length}个相关目录: ${storyCatalogues.map(c => c.name).join(', ')}`);

    // ===== 2. 搜索角色词条，用getEntryDetail获取完整内容 =====
    console.log('[KuroWiki] 搜索词条:', characterName);
    // 分页获取所有搜索结果
    let allRecords = [];
    let searchPage = 1;
    while (true) {
      const searchPageRes = await axios.post(`${API_BASE}/wiki/core/catalogue/item/search`,
        formUrl({ keyword: characterName, page: String(searchPage), limit: '100' }),
        { timeout: 15000, headers });

      if (searchPageRes.data.code !== 200 || !searchPageRes.data.data) break;
      const pageRecords = searchPageRes.data.data.results?.records || searchPageRes.data.data.records || [];
      allRecords = allRecords.concat(pageRecords);
      if (pageRecords.length < 100) break; // 没有更多了
      searchPage++;
    }

    if (allRecords.length > 0) {
      const filtered = allRecords.filter(r => {
        const title = r.content?.title || r.name || '';
        return !shouldExclude(title);
      });
      console.log(`[KuroWiki] 找到${allRecords.length}个词条，过滤后${filtered.length}个`);

      for (const entry of filtered.slice(0, 10)) {
        try {
          const entryId = entry.content?.linkConfig?.entryId || entry.content?.linkId || entry.entryId || entry.id;
          const entryTitle = entry.content?.title || entry.name || characterName;
          if (!entryId) continue;

          console.log(`[KuroWiki] 获取词条详情: ${entryTitle} (entryId=${entryId})`);

          // 使用getEntryDetail获取完整内容
          const detailRes = await axios.post(`${API_BASE}/wiki/core/catalogue/item/getEntryDetail`,
            formUrl({ id: String(entryId) }),
            { timeout: 15000, headers });

          if (detailRes.data.code !== 200 || !detailRes.data.data) continue;

          const detail = detailRes.data.data;
          const content = detail.content;
          let text = '';

          if (content && content.modules) {
            for (const mod of content.modules) {
              if (mod.components) {
                for (const comp of mod.components) {
                  if (comp.content && typeof comp.content === 'string') {
                    const cleanText = comp.content
                      .replace(/<br\s*\/?>/gi, '\n')
                      .replace(/<\/td>/gi, '\t')
                      .replace(/<\/tr>/gi, '\n')
                      .replace(/<[^>]+>/g, '')
                      .replace(/&nbsp;/g, ' ')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                      .replace(/&amp;/g, '&')
                      .replace(/\n{3,}/g, '\n\n')
                      .trim();
                    if (cleanText.length > 20) {
                      text += `\n【${comp.title || mod.title || ''}】\n${cleanText.substring(0, 3000)}\n`;
                    }
                  }
                }
              }
            }
          }

          if (text.length > 50) {
            results.push({
              content: text.substring(0, 8000),
              url: `https://wiki.kurobbs.com/${gamePath}/entry/${entryId}`,
              title: `[库洛Wiki] ${entryTitle}`,
              success: true,
            });
            console.log(`[KuroWiki] 获取词条成功: ${entryTitle} (${text.length}字)`);
          }
        } catch (e) {
          console.log(`[KuroWiki] 词条获取失败: ${e.message}`);
        }
      }
    }

    // ===== 3. 遍历剧情目录，筛选包含角色名的章节，用getEntryDetail获取完整内容 =====
    for (const cat of storyCatalogues) {
      try {
        console.log(`[KuroWiki] 获取目录内容: ${cat.name} (id=${cat.id})`);
        const pageRes = await axios.post(`${API_BASE}/wiki/core/catalogue/item/getPage`,
          formUrl({ catalogueId: String(cat.id), page: '1', limit: '100' }),
          { timeout: 15000, headers });

        if (pageRes.data.code !== 200 || !pageRes.data.data) continue;

        const items = pageRes.data.data.results?.records || pageRes.data.data.list || pageRes.data.data.records || [];
        // 筛选包含角色名的章节
        const relevantItems = items.filter(item => {
          const title = item.content?.title || item.name || '';
          return title.includes(characterName);
        });

        if (relevantItems.length === 0) continue;

        console.log(`[KuroWiki] ${cat.name}中找到${relevantItems.length}个相关章节`);

        let storyContent = '';
        for (const item of relevantItems.slice(0, 15)) {
          const entryId = item.content?.linkConfig?.entryId || item.content?.linkId || item.entryId || item.id;
          if (!entryId) continue;

          try {
            // 使用getEntryDetail获取完整剧情内容（包含HTML格式的对话文本）
            const detailRes = await axios.post(`${API_BASE}/wiki/core/catalogue/item/getEntryDetail`,
              formUrl({ id: String(entryId) }),
              { timeout: 15000, headers });

            if (detailRes.data.code !== 200 || !detailRes.data.data) continue;

            const detail = detailRes.data.data;
            const entryName = detail.name || item.content?.title || '';
            const content = detail.content;

            if (content && content.modules) {
              // 从modules中提取文本
              for (const mod of content.modules) {
                if (mod.components) {
                  for (const comp of mod.components) {
                    if (comp.content && typeof comp.content === 'string') {
                      // 清理HTML标签，提取纯文本
                      const cleanText = comp.content
                        .replace(/<br\s*\/?>/gi, '\n')
                        .replace(/<\/td>/gi, '\t')
                        .replace(/<\/tr>/gi, '\n')
                        .replace(/<[^>]+>/g, '')
                        .replace(/&nbsp;/g, ' ')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&amp;/g, '&')
                        .replace(/\n{3,}/g, '\n\n')
                        .trim();
                      if (cleanText.length > 20) {
                        storyContent += `\n【${entryName} - ${comp.title || mod.title || ''}】\n${cleanText.substring(0, 3000)}\n`;
                      }
                    }
                  }
                }
              }
            }
          } catch (e) {
            console.log(`[KuroWiki] 章节详情获取失败: ${e.message}`);
          }
        }

        if (storyContent.length > 50) {
          results.push({
            content: storyContent.substring(0, 12000),
            url: `https://wiki.kurobbs.com/${gamePath}/catalogue/list?fid=${cat.id}`,
            title: `[库洛Wiki] ${cat.name} - ${characterName}相关`,
            success: true,
          });
          console.log(`[KuroWiki] 获取剧情成功: ${cat.name} (${storyContent.length}字)`);
        }
      } catch (e) {
        console.log(`[KuroWiki] 目录${cat.name}获取失败: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[KuroWiki] 搜索失败:', e.message);
  }

  return results;
}
const LOW_QUALITY_DOMAINS = [
  'cloud.21cn.com',     // 天翼云手机
  'hongshouzi',         // 红手指云手机
  '17173.com',          // 17173游戏网（攻略为主，缺乏角色设定）
  'gamersky.com',       // 游民星空
  '3dmgame.com',        // 3DM
  'ali213.net',         // 游侠网
  'yxdown.com',         // 游讯网
];

function isLowQualitySource(url, title) {
  const lowerUrl = (url || '').toLowerCase();
  const lowerTitle = (title || '').toLowerCase();
  for (const domain of LOW_QUALITY_DOMAINS) {
    if (lowerUrl.includes(domain)) return true;
  }
  // 标题包含"攻略""兑换码""礼包""充值"等关键词的也过滤
  const lowQualityKeywords = ['攻略', '兑换码', '礼包码', '充值', '代练', '私服', '下载', '安装'];
  for (const kw of lowQualityKeywords) {
    if (lowerTitle.includes(kw)) return true;
  }
  return false;
}

// 萌娘百科（通过mzh移动版网页搜索+直接获取页面，内容更干净）
async function searchMoegirl(characterName, searchHints = []) {
  const results = [];
  const MOEGIRL_BASE = 'https://mzh.moegirl.org.cn';
  try {
    // 1. 通过网页搜索获取相关条目
    const searchQuery = [characterName, ...searchHints].join(' ');
    const searchUrl = `${MOEGIRL_BASE}/index.php?search=${encodeURIComponent(searchQuery)}&title=Special:%E6%90%9C%E7%B4%A2&limit=10`;
    const html = await fetchUrl(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    // 提取搜索结果中的条目链接
    const linkRegex = /<a[^>]*href="\/([^"]*)"[^>]*title="([^"]*)"[^>]*>/gi;
    let match;
    const seen = new Set();
    const titles = [];
    while ((match = linkRegex.exec(html)) !== null && titles.length < 8) {
      const title = match[2];
      if (title.includes(characterName) && !seen.has(title)) {
        seen.add(title);
        titles.push(title);
      }
    }

    // 2. 获取每个条目的页面内容（最多3个）
    for (const title of titles.slice(0, 3)) {
      try {
        const pageUrl = `${MOEGIRL_BASE}/${encodeURIComponent(title)}`;
        const pageHtml = await fetchUrl(pageUrl, {
          timeout: 12000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        });
        const text = htmlToText(pageHtml);
        if (text && text.length > 100) {
          results.push({
            content: text.substring(0, 6000),
            url: pageUrl,
            title: title,
            success: true,
          });
        }
      } catch (e) {
        console.log(`[Distill] 萌娘百科页面获取失败 ${title}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[Distill] 萌娘百科搜索失败:', e.message);
  }
  return results;
}

// Wikipedia API（适合现实人物 / 国际角色）
async function searchWikipedia(characterName, lang = 'zh') {
  const results = { content: '', url: '', title: '', success: false };
  try {
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(characterName)}&format=json&srlimit=3`;
    const searchData = await fetchUrl(searchUrl, { responseType: 'json' });
    if (searchData && searchData.query && searchData.query.search && searchData.query.search.length > 0) {
      const bestMatch = searchData.query.search[0];
      const title = bestMatch.title;
      // 获取摘要
      const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const summaryData = await fetchUrl(summaryUrl, { responseType: 'json' });
      if (summaryData && summaryData.extract) {
        results.content = summaryData.extract;
        results.url = summaryData.content_urls ? summaryData.content_urls.desktop.page : '';
        results.title = title;
        results.success = true;
      }
    }
  } catch (e) {
    console.error('[Distill] Wikipedia获取失败:', e.message);
  }
  return results;
}

// BWIKI 抓取（游戏角色）—— 先搜索再获取多个页面
async function searchBwiki(characterName, wikiPrefix) {
  const results = [];
  if (!wikiPrefix) return results;
  try {
    // 1. 搜索条目
    const searchUrl = `https://wiki.biligame.com/${wikiPrefix}/api.php?action=query&list=search&srsearch=${encodeURIComponent(characterName)}&format=json&srlimit=8`;
    const searchData = await fetchUrl(searchUrl, { responseType: 'json' });
    if (!searchData || !searchData.query || !searchData.query.search) return results;

    // 2. 获取每个页面的内容
    for (const item of searchData.query.search.slice(0, 5)) {
      const title = item.title;
      try {
        const apiUrl = `https://wiki.biligame.com/${wikiPrefix}/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json`;
        const data = await fetchUrl(apiUrl, { responseType: 'json' });
        if (data && data.parse && data.parse.wikitext && data.parse.wikitext['*']) {
          let wikitext = data.parse.wikitext['*'];
          const extractedLines = [];
          for (let pass = 0; pass < 10; pass++) {
            const templateRegex = /\{\{([\s\S]*?)\}\}/g;
            let found = false;
            let templateMatch;
            while ((templateMatch = templateRegex.exec(wikitext)) !== null) {
              found = true;
              const lines = templateMatch[1].split('\n');
              for (const line of lines) {
                const kvMatch = line.match(/^\s*\|([^=]+)=(.*)$/);
                if (kvMatch) {
                  const key = kvMatch[1].trim();
                  const value = kvMatch[2].trim();
                  if (value && value.length > 1 && value !== '<!--请勿删除-->') {
                    extractedLines.push(`${key}：${value}`);
                  }
                }
              }
            }
            wikitext = wikitext.replace(/\{\{[\s\S]*?\}\}/g, '');
            if (!found) break;
          }
          const content = extractedLines.join('\n');
          if (content.length > 50) {
            results.push({
              content: content.substring(0, 4000),
              url: `https://wiki.biligame.com/${wikiPrefix}/${encodeURIComponent(title)}`,
              title: title,
              success: true,
            });
          }
        }
      } catch (e) {
        console.log(`[Distill] BWIKI页面获取失败 ${title}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[Distill] BWIKI搜索失败:', e.message);
  }
  return results;
}

// 抓取网页正文
async function fetchWebPageContent(url, maxLen = 4000) {
  try {
    const html = await fetchUrl(url, { timeout: 10000 });
    const text = htmlToText(html);
    if (text.length > maxLen) return text.substring(0, maxLen);
    return text;
  } catch (e) {
    return '';
  }
}

// 通用深度爬虫：从起始URL出发，BFS深入抓取与角色相关的内容
// maxDepth: 最大深入层数（1=只抓起始页，2=再深入1层，3=再深入2层）
// maxPages: 最多抓取页面总数
// maxTotalLen: 内容总长度上限
async function deepCrawl(startUrl, characterName, options = {}) {
  const {
    maxDepth: requestedDepth = 3,
    maxPages: requestedPages = 8,
    maxTotalLen = 8000,
    searchMode = false, // true=搜索页模式，自动拼接角色名
  } = options;
  const maxDepth = Math.max(1, Math.min(5, Number(requestedDepth) || 3));
  const maxPages = Math.max(1, Math.min(30, Number(requestedPages) || 8));

  const visited = new Set();
  const contentHashes = new Set();
  const collectedContent = []; // { url, content, depth }
  let totalLen = 0;

  // 构建起始URL
  let startUrlFinal = String(startUrl || '').trim();
  if (searchMode) {
    if (startUrlFinal.includes('?') && (startUrlFinal.includes('keyword=') || startUrlFinal.includes('q=') || startUrlFinal.includes('search=') || startUrlFinal.includes('wd='))) {
      startUrlFinal += encodeURIComponent(characterName);
    } else if (startUrlFinal.endsWith('/') || startUrlFinal.endsWith('=')) {
      startUrlFinal += encodeURIComponent(characterName);
    } else if (startUrlFinal.includes('/search')) {
      startUrlFinal += '/' + encodeURIComponent(characterName);
    } else {
      startUrlFinal += encodeURIComponent(characterName);
    }
  }

  console.log(`[DeepCrawl] 开始深度爬取: ${startUrlFinal} (深度=${maxDepth}, 最大页数=${maxPages})`);

  // BFS队列: { url, depth }
  startUrlFinal = canonicalizeUrl(startUrlFinal);
  const queue = [{ url: startUrlFinal, depth: 1 }];

  while (queue.length > 0 && collectedContent.length < maxPages && totalLen < maxTotalLen) {
    const queued = queue.shift();
    const url = canonicalizeUrl(queued.url);
    const depth = queued.depth;
    if (visited.has(url)) continue;
    visited.add(url);

    // 抓取页面
    let html;
    try {
      html = await fetchUrl(url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
      });
    } catch (e) {
      console.log(`[DeepCrawl] 页面抓取失败 ${url}: ${e.message}`);
      continue;
    }

    const text = htmlToText(html);

    // 判断页面内容是否与角色相关
    const isRelevant = text.includes(characterName) || text.includes(characterName.toLowerCase());

    if (isRelevant) {
      const remainingLen = maxTotalLen - totalLen;
      const chunk = text.substring(0, Math.min(remainingLen, Math.floor(maxTotalLen / maxPages)));
      const hash = contentFingerprint(chunk);
      if (chunk.length > 30 && !contentHashes.has(hash)) { // 忽略过短或重复页面
        contentHashes.add(hash);
        collectedContent.push({ url, content: chunk, depth });
        totalLen += chunk.length;
        console.log(`[DeepCrawl] ✓ 第${depth}层 相关内容: ${url} (${chunk.length}字)`);
      }
    }

    // 如果还有深度余量，提取子链接加入队列
    if (depth < maxDepth && collectedContent.length < maxPages) {
      const childLinks = extractDetailLinks(html, url, characterName).slice(0, 8);
      for (const rawLink of childLinks) {
        const link = canonicalizeUrl(rawLink);
        if (!visited.has(link) && queue.length < maxPages * 2) {
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }

  console.log(`[DeepCrawl] 完成: 抓取${collectedContent.length}页, 共${totalLen}字`);
  return collectedContent;
}

// 百度百科（适合中文现实人物/历史人物/通用知识）
async function searchBaiduBaike(characterName) {
  const results = { content: '', url: '', title: '', success: false };
  try {
    // 百度百科搜索页
    const searchUrl = `https://baike.baidu.com/item/${encodeURIComponent(characterName)}`;
    const html = await fetchUrl(searchUrl, { timeout: 10000 });
    const text = htmlToText(html);
    // 提取正文区域（百度百科正文通常在 class="main-content" 或 lemma-summary 附近）
    const summaryMatch = text.match(/(?:内容简介|摘要|简介|概述)[:：]?\s*([\s\S]{100,4000}?)(?=目录|参考资料|扩展阅读|词条标签|$)/);
    let content = summaryMatch ? summaryMatch[1].trim() : text.substring(0, 4000);
    if (content.length > 4000) content = content.substring(0, 4000);
    if (content && content.length > 50) {
      results.content = content;
      results.url = searchUrl;
      results.title = characterName;
      results.success = true;
    }
  } catch (e) {
    console.error('[Distill] 百度百科获取失败:', e.message);
  }
  return results;
}

// 知乎搜索（适合深度讨论/人物评价）
async function searchZhihu(characterName, maxResults = 3) {
  const results = [];
  try {
    const searchUrl = `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(characterName)}`;
    const html = await fetchUrl(searchUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    });
    const text = htmlToText(html);
    // 知乎搜索结果通常是动态加载，这里简单提取可见文本
    if (text && text.length > 100) {
      results.push({
        title: `${characterName} - 知乎搜索`,
        url: searchUrl,
        content: text.substring(0, 3000),
      });
    }
  } catch (e) {
    console.error('[Distill] 知乎搜索失败:', e.message);
  }
  return results;
}

// 微博搜索（适合现实人物动态/公众人物）
async function searchWeibo(characterName) {
  const results = { content: '', url: '', title: '', success: false };
  try {
    const searchUrl = `https://s.weibo.com/weibo/${encodeURIComponent(characterName)}`;
    const html = await fetchUrl(searchUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const text = htmlToText(html);
    if (text && text.length > 100) {
      results.content = text.substring(0, 3000);
      results.url = searchUrl;
      results.title = `${characterName} - 微博搜索`;
      results.success = true;
    }
  } catch (e) {
    console.error('[Distill] 微博搜索失败:', e.message);
  }
  return results;
}


// 从页面HTML中提取子页面链接
// characterName用于优先排序，但也会保留非角色名链接（如目录页的章节链接）
function extractDetailLinks(html, baseUrl, characterName) {
  const links = [];
  const baseDomain = extractDomain(baseUrl);

  // 提取所有<a>标签的href
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  const seen = new Set();
  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1];
    const linkText = match[2].replace(/<[^>]+>/g, '').trim();

    // 跳过空链接、锚点、javascript、图片链接、文件下载
    if (!href || href.startsWith('#') || href.startsWith('javascript') || href.startsWith('mailto')) continue;
    if (/\.(jpg|jpeg|png|gif|svg|css|js|ico|pdf|zip|rar)(\?|$)/i.test(href)) continue;

    // 解析相对路径为绝对路径
    try {
      if (href.startsWith('/')) {
        href = baseDomain + href;
      } else if (!href.startsWith('http')) {
        href = baseUrl.replace(/\/[^/]*$/, '/') + href;
      }
    } catch (e) { continue; }

    // 排除明显无关链接（登录、注册、首页等）
    const isNav = /\/(login|register|signup|signin|logout|about|contact|privacy|terms|help|faq)(\/|$)/i.test(href);
    if (isNav) continue;

    // 排除外部域名链接（只爬同域）
    const linkDomain = extractDomain(href);
    if (linkDomain !== baseDomain) continue;

    if (seen.has(href)) continue;
    seen.add(href);

    // 优先级：链接文本包含角色名 > 有意义的内容链接 > 其他
    let priority = 0;
    const isRelevant = linkText.includes(characterName) || linkText.includes(characterName.toLowerCase());
    if (isRelevant) {
      priority = 2; // 最高优先
    } else if (linkText.length > 2 && !/^(首页|返回|更多|下载|分享|评论|点赞|收藏)$/.test(linkText)) {
      priority = 1; // 有意义的内容链接
    }

    links.push({ url: href, priority });
  }

  // 按优先级排序，同优先级内保持原始顺序，最多8个
  return links
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 8)
    .map(l => l.url);
}

// 提取域名（含协议）
function extractDomain(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    return url.replace(/(https?:\/\/[^/]+).*/, '$1');
  }
}

// 检测角色类型
function detectCharacterType(name, hints = []) {
  const allText = (name + ' ' + hints.join(' ')).toLowerCase();
  if (/动漫|anime|manga|漫画|二次元|角色|character/.test(allText)) return 'anime';
  if (/游戏|game|手游|网游/.test(allText)) return 'game';
  if (/现实|真人|real|人物|person|历史/.test(allText)) return 'real';
  return 'unknown';
}

// 解析搜索提示词，支持AND/OR/NOT逻辑
// 输入: ["露西亚", "战双", "NOT", "升格者"]
// 输出: { andTerms: ["露西亚", "战双"], orTerms: [], notTerms: ["升格者"], searchQuery: "露西亚 战双 -升格者" }
function parseSearchHints(hints) {
  const andTerms = [];
  const orTerms = [];
  const notTerms = [];
  let i = 0;
  while (i < hints.length) {
    const h = hints[i].trim();
    if (!h) { i++; continue; }
    if (h.toUpperCase() === 'NOT') {
      // 下一个词是排除词
      i++;
      if (i < hints.length && hints[i].trim()) {
        notTerms.push(hints[i].trim());
      }
    } else if (h.toUpperCase() === 'OR') {
      // 下一个词是OR词
      i++;
      if (i < hints.length && hints[i].trim()) {
        orTerms.push(hints[i].trim());
      }
    } else if (h.toUpperCase() === 'AND') {
      // AND是默认行为，跳过
      i++;
      if (i < hints.length && hints[i].trim()) {
        andTerms.push(hints[i].trim());
      }
    } else {
      andTerms.push(h);
    }
    i++;
  }

  // 构建搜索引擎友好的查询字符串
  // AND词用空格连接，NOT词用-前缀，OR词用OR连接
  const parts = [];
  if (andTerms.length > 0) parts.push(andTerms.join(' '));
  if (orTerms.length > 0) {
    const orPart = orTerms.length > 1 ? `(${orTerms.join(' OR ')})` : orTerms[0];
    parts.push(orPart);
  }
  const notParts = notTerms.map(t => `-${t}`);
  const searchQuery = [...parts, ...notParts].join(' ');

  return { andTerms, orTerms, notTerms, searchQuery };
}

// 检查文本是否匹配搜索提示词逻辑（AND/OR/NOT）
function matchesSearchHints(text, parsedHints) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  // NOT词：文本中不能包含
  for (const not of parsedHints.notTerms) {
    if (lowerText.includes(not.toLowerCase())) return false;
  }
  // AND词：文本中必须包含所有
  for (const and of parsedHints.andTerms) {
    if (!lowerText.includes(and.toLowerCase())) return false;
  }
  // OR词：文本中至少包含一个（如果没有OR词则忽略）
  if (parsedHints.orTerms.length > 0) {
    const hasOr = parsedHints.orTerms.some(or => lowerText.includes(or.toLowerCase()));
    if (!hasOr) return false;
  }
  return true;
}

// ============================================================
// 方法1：网络搜索蒸馏（实时更新，支持游戏/动漫/现实人物）
// ============================================================
async function distillFromWeb(characterId, options, aiClient, promptBuilder) {
  const {
    characterName,
    characterType = 'unknown',
    searchHints = [],
    knowledgeUrls = [],
    skillUrls = [],
    wikiPrefix = '',
    forceUpdate = false,
    existingSkill = '',
  } = options;

  const manifest = readManifest(characterId);
  const today = todayStr();

  console.log(`[Distill/Web] 开始为 ${characterName} 蒸馏 (类型: ${characterType})`);

  // 解析搜索提示词（AND/OR/NOT逻辑）
  const parsedHints = parseSearchHints(searchHints);
  console.log(`[Distill/Web] 搜索提示词解析: AND=${parsedHints.andTerms.join(',')}, OR=${parsedHints.orTerms.join(',')}, NOT=${parsedHints.notTerms.join(',')}, 查询="${parsedHints.searchQuery}"`);

  const sources = [];
  const researchChunks = [];

  // 1. 萌娘百科（动漫/游戏角色）—— 返回多个页面
  if (characterType === 'anime' || characterType === 'game' || characterType === 'unknown') {
    console.log('[Distill/Web] 尝试萌娘百科...');
    const moegirlResults = await searchMoegirl(characterName, parsedHints.andTerms);
    for (const mg of moegirlResults) {
      // 用matchesSearchHints过滤NOT词
      const mgMatches = parsedHints.notTerms.length === 0 || matchesSearchHints(mg.content, { ...parsedHints, andTerms: [characterName] });
      if (mgMatches) {
        sources.push({
          id: `moegirl_${Date.now()}_${sources.length}`,
          source: '萌娘百科',
          title: mg.title,
          url: mg.url,
          source_tier: 'high',
          retrieved_at: today,
          status: 'success',
        });
        researchChunks.push(`【萌娘百科 - ${mg.title}】\n${mg.content}`);
        console.log(`[Distill/Web] 萌娘百科: 成功 (${mg.title})`);
      } else {
        console.log(`[Distill/Web] 萌娘百科结果被NOT词过滤: ${mg.title}`);
      }
    }
    if (moegirlResults.length === 0) {
      sources.push({
        id: `moegirl_${Date.now()}`,
        source: '萌娘百科',
        url: 'https://zh.moegirl.org.cn',
        source_tier: 'high',
        retrieved_at: today,
        status: 'failed',
        warnings: '未找到条目或获取失败',
      });
    }
  }

  // 2. Wikipedia（现实人物/国际角色）
  if (characterType === 'real' || characterType === 'unknown') {
    console.log('[Distill/Web] 尝试 Wikipedia...');
    const wikiQuery = [characterName, ...parsedHints.andTerms].join(' ');
    const wiki = await searchWikipedia(wikiQuery, 'zh');
    if (wiki.success) {
      const wikiMatches = parsedHints.notTerms.length === 0 || matchesSearchHints(wiki.content, { ...parsedHints, andTerms: [characterName] });
      if (wikiMatches) {
        sources.push({
          id: `wiki_zh_${Date.now()}`,
          source: 'Wikipedia中文',
          title: wiki.title,
          url: wiki.url,
          source_tier: 'high',
          retrieved_at: today,
          status: 'success',
        });
        researchChunks.push(`【Wikipedia中文 - ${wiki.title}】\n${wiki.content}`);
        console.log('[Distill/Web] Wikipedia中文: 成功');
      } else {
        console.log('[Distill/Web] Wikipedia中文结果被NOT词过滤');
      }
    }
    // 也尝试英文 Wikipedia
    const wikiEn = await searchWikipedia(characterName, 'en');
    if (wikiEn.success) {
      const wikiEnMatches = parsedHints.notTerms.length === 0 || matchesSearchHints(wikiEn.content, { ...parsedHints, andTerms: [characterName] });
      if (wikiEnMatches) {
        sources.push({
          id: `wiki_en_${Date.now()}`,
          source: 'Wikipedia英文',
          title: wikiEn.title,
          url: wikiEn.url,
          source_tier: 'high',
          retrieved_at: today,
          status: 'success',
        });
        researchChunks.push(`【Wikipedia英文 - ${wikiEn.title}】\n${wikiEn.content}`);
        console.log('[Distill/Web] Wikipedia英文: 成功');
      } else {
        console.log('[Distill/Web] Wikipedia英文结果被NOT词过滤');
      }
    }
  }

  // 3. BWIKI（游戏角色）—— 自动从库洛设置推导前缀
  // 提前读取库洛token设置，用于推导BWIKI前缀
  const kuroTokenPath = path.join(DATA_DIR, 'kuro_token.json');
  const kuroWikiPath = path.join(getCharacterDir(characterId), 'references', 'kuro_wiki.md');
  let kuroToken = '';
  let kuroEnabled = true;
  let kuroGameType = '';
  try {
    if (fs.existsSync(kuroTokenPath)) {
      const kuroData = JSON.parse(fs.readFileSync(kuroTokenPath, 'utf-8'));
      kuroToken = kuroData.token || '';
      kuroEnabled = kuroData.enabled !== undefined ? kuroData.enabled : true;
      kuroGameType = kuroData.gameType || '';
    }
  } catch (e) {}

  const bwikiPrefixMap = { mc: 'wutheringwaves', pns: 'zspms' };
  const autoWikiPrefix = wikiPrefix || bwikiPrefixMap[kuroGameType] || '';
  if (autoWikiPrefix && (characterType === 'game' || characterType === 'unknown')) {
    console.log(`[Distill/Web] 尝试 BWIKI (${autoWikiPrefix})...`);
    const bwikiResults = await searchBwiki(characterName, autoWikiPrefix);
    for (const bw of bwikiResults) {
      // 过滤NOT词
      const bwMatches = parsedHints.notTerms.length === 0 || matchesSearchHints(bw.content, { ...parsedHints, andTerms: [] });
      if (bwMatches) {
        sources.push({
          id: `bwiki_${Date.now()}_${sources.length}`,
          source: 'BWIKI',
          title: bw.title,
          url: bw.url,
          source_tier: 'high',
          retrieved_at: today,
          status: 'success',
        });
        researchChunks.push(`【BWIKI - ${bw.title}】\n${bw.content}`);
        console.log(`[Distill/Web] BWIKI: 成功 (${bw.title})`);
      } else {
        console.log(`[Distill/Web] BWIKI结果被NOT词过滤: ${bw.title}`);
      }
    }
  }

  // 4. 通用搜索引擎：按资料维度规划查询，搜狗与 DuckDuckGo 同时执行但限制并发。
  const queryPlan = buildResearchQueryPlan(characterName, parsedHints);
  console.log(`[Distill/Web] 多源查询计划: ${queryPlan.map(item => item.section).join(', ')}`);
  const searchDiagnostics = {
    attempted: queryPlan.length * 2,
    succeeded: 0,
    failed: 0,
    resultCount: 0,
  };
  const searchBatches = await mapWithConcurrency(queryPlan, 2, async (planItem) => {
    const [sogouSettled, ddgSettled] = await Promise.allSettled([
      searchSogou(planItem.query, 4),
      searchDuckDuckGo(planItem.query, 4),
    ]);
    const sogou = sogouSettled.status === 'fulfilled' ? sogouSettled.value : [];
    const ddg = ddgSettled.status === 'fulfilled' ? ddgSettled.value : [];
    searchDiagnostics.succeeded += (sogou.length > 0 ? 1 : 0) + (ddg.length > 0 ? 1 : 0);
    searchDiagnostics.failed += (sogou.length === 0 ? 1 : 0) + (ddg.length === 0 ? 1 : 0);
    searchDiagnostics.resultCount += sogou.length + ddg.length;
    return [
      ...sogou.map(result => ({ ...result, engine: '搜狗搜索', querySection: planItem.section })),
      ...ddg.map(result => ({ ...result, engine: 'DuckDuckGo', querySection: planItem.section })),
    ];
  });

  const candidateMap = new Map();
  for (const candidate of searchBatches.flat()) {
    const text = `${candidate.title || ''} ${candidate.url || ''}`;
    if (!matchesSearchHints(text, { ...parsedHints, andTerms: [characterName] })) continue;
    if (isLowQualitySource(candidate.url, candidate.title)) continue;
    const key = canonicalizeUrl(candidate.url);
    const scored = scoreSource(candidate.url, candidate.title);
    const existing = candidateMap.get(key);
    if (!existing || scored.score > existing.sourceScore) {
      candidateMap.set(key, { ...candidate, canonicalUrl: key, sourceTier: scored.tier, sourceScore: scored.score });
    }
  }

  const crawledSearchUrls = new Set();
  for (const result of [...candidateMap.values()].sort((a, b) => b.sourceScore - a.sourceScore).slice(0, 8)) {
    let realUrl = result.url;
    if (result.isRedirect) realUrl = await resolveSogouRedirect(result.url) || result.url;
    realUrl = canonicalizeUrl(realUrl);
    if (!realUrl || crawledSearchUrls.has(realUrl)) continue;
    crawledSearchUrls.add(realUrl);

    const pages = await deepCrawl(realUrl, characterName, {
      maxDepth: 2,
      maxPages: 2,
      maxTotalLen: 3500,
    });
    const content = pages.map(page => page.content).join('\n\n').trim();
    const sourceRecord = {
      id: `search_${Date.now()}_${sources.length}`,
      source: result.engine,
      title: result.title,
      url: realUrl,
      canonical_url: realUrl,
      source_tier: result.sourceTier,
      source_score: result.sourceScore,
      query_section: result.querySection,
      retrieved_at: today,
      status: content ? 'success' : 'failed',
      page_count: pages.length,
    };
    if (content) {
      sourceRecord.evidence_excerpt = content.substring(0, 240);
      researchChunks.push(`【${result.engine} · ${result.querySection} · ${result.title}】\n${content}`);
    } else {
      sourceRecord.warnings = '搜索结果存在，但正文抓取失败或与角色无关';
    }
    sources.push(sourceRecord);
  }

  // 4.5 百度贴吧（通过搜狗搜索site:tieba.baidu.com获取剧情设定内容）
  console.log('[Distill/Web] 搜索百度贴吧内容...');
  const tiebaResults = await searchTieba(characterName, parsedHints.andTerms);
  for (const result of tiebaResults.slice(0, 3)) {
    if (isLowQualitySource(result.url, result.title)) continue;
    sources.push({
      id: `tieba_${Date.now()}_${sources.length}`,
      source: '百度贴吧',
      title: result.title,
      url: result.url,
      source_tier: 'medium',
      retrieved_at: today,
      status: 'success',
    });
    // 抓取贴吧帖子正文
    const pages = await deepCrawl(result.url, characterName, {
      maxDepth: 1,
      maxPages: 1,
      maxTotalLen: 4000,
    });
    if (pages.length > 0) {
      const content = pages.map(p => p.content).join('\n\n');
      researchChunks.push(`【贴吧 - ${result.title}】\n${content}`);
    }
  }

  // 4.5 百度百科（中文现实人物/历史人物/通用知识）
  if (characterType === 'real' || characterType === 'unknown') {
    console.log('[Distill/Web] 尝试百度百科...');
    const baikeQuery = [characterName, ...parsedHints.andTerms].join(' ');
    const baike = await searchBaiduBaike(baikeQuery);
    if (baike.success) {
      const baikeMatches = parsedHints.notTerms.length === 0 || matchesSearchHints(baike.content, { ...parsedHints, andTerms: [characterName] });
      if (baikeMatches) {
        sources.push({
          id: `baike_${Date.now()}`,
          source: '百度百科',
          title: baike.title,
          url: baike.url,
          source_tier: 'high',
          retrieved_at: today,
          status: 'success',
        });
        researchChunks.push(`【百度百科 - ${baike.title}】\n${baike.content}`);
        console.log('[Distill/Web] 百度百科: 成功');
      } else {
        console.log('[Distill/Web] 百度百科结果被NOT词过滤');
      }
    }
  }

  // 4.6 知乎搜索（深度讨论/人物评价）
  if (characterType === 'real' || characterType === 'unknown') {
    console.log('[Distill/Web] 尝试知乎搜索...');
    const zhihuQuery = [characterName, ...parsedHints.andTerms].join(' ');
    const zhihuResults = await searchZhihu(zhihuQuery, 2);
    for (const zhihu of zhihuResults) {
      if (zhihu.content) {
        sources.push({
          id: `zhihu_${Date.now()}_${sources.length}`,
          source: '知乎',
          title: zhihu.title,
          url: zhihu.url,
          source_tier: 'medium',
          retrieved_at: today,
          status: 'success',
        });
        researchChunks.push(`【${zhihu.title}】\n${zhihu.content}`);
      }
    }
  }

  // 4.7 库洛Wiki API（需要登录token，数据最全面）
  // kuroToken/kuroEnabled/kuroGameType 已在 BWIKI 段提前读取

  // 当角色类型是game时，尝试库洛wiki（需要开启且已登录）
  if ((characterType === 'game' || characterType === 'unknown') && kuroEnabled) {
    let kuroWikiContent = '';

    // 优先读取已有的kuro_wiki.md（永久缓存）
    if (fs.existsSync(kuroWikiPath) && !forceUpdate) {
      console.log('[Distill/Web] 读取已有的库洛Wiki缓存...');
      kuroWikiContent = fs.readFileSync(kuroWikiPath, 'utf-8');
      // 提取内容部分（跳过头部元信息）
      const contentStart = kuroWikiContent.indexOf('\n---\n');
      if (contentStart > 0) {
        kuroWikiContent = kuroWikiContent.substring(contentStart + 5);
      }
    } else if (kuroToken) {
      // 没有缓存或强制更新，从API获取
      console.log('[Distill/Web] 尝试库洛Wiki API...');
      let characterContext = '';
      try {
        const charMdPath = path.join(CHARACTER_DIR, String(characterId), 'character.md');
        if (fs.existsSync(charMdPath)) {
          characterContext = fs.readFileSync(charMdPath, 'utf-8');
        }
      } catch (e) {}
      const kuroResults = await searchKuroWiki(characterName, kuroToken, searchHints, characterContext, kuroGameType);

      // 保存为永久文档
      const refDir = path.join(getCharacterDir(characterId), 'references');
      if (!fs.existsSync(refDir)) fs.mkdirSync(refDir, { recursive: true });

      let kuroMdContent = `# ${characterName} - 库洛Wiki资料\n\n缓存日期: ${today}\n来源: wiki.kurobbs.com\n注意: 此文件为库洛Wiki数据缓存，蒸馏时自动读取，无需重新搜索\n\n---\n\n`;

      for (const kr of kuroResults) {
        const krMatches = parsedHints.notTerms.length === 0 || matchesSearchHints(kr.content, { ...parsedHints, andTerms: [characterName] });
        if (krMatches) {
          sources.push({
            id: `kurowiki_${Date.now()}_${sources.length}`,
            source: '库洛Wiki',
            title: kr.title,
            url: kr.url,
            source_tier: 'high',
            retrieved_at: today,
            status: 'success',
          });
          kuroWikiContent += `【库洛Wiki - ${kr.title}】\n${kr.content}\n\n`;
          kuroMdContent += `## ${kr.title}\n\n来源: ${kr.url}\n\n${kr.content}\n\n---\n\n`;
          console.log(`[Distill/Web] 库洛Wiki: 成功 (${kr.title})`);
        } else {
          console.log(`[Distill/Web] 库洛Wiki结果被NOT词过滤: ${kr.title}`);
        }
      }

      if (kuroResults.length === 0) {
        console.log('[Distill/Web] 库洛Wiki: 未找到相关词条');
      }

      // 写入永久文档
      fs.writeFileSync(kuroWikiPath, kuroMdContent, 'utf-8');
      console.log(`[Distill/Web] 库洛Wiki资料已缓存到 kuro_wiki.md`);
    } else {
      console.log('[Distill/Web] 库洛Wiki: 未登录且无缓存，跳过（登录后可获取最全面的角色资料）');
    }

    // 将库洛Wiki内容加入蒸馏
    if (kuroWikiContent.trim().length > 0) {
      researchChunks.push(`【库洛Wiki综合资料】\n${kuroWikiContent}`);
    }
  }

  // 5. 自定义知识网址（统一使用深度爬虫）
  for (const urlEntry of knowledgeUrls) {
    if (urlEntry.url || urlEntry.title) {
      try {
        let content = '';
        let entryUrl = urlEntry.url || '';
        if (urlEntry.type === 'bwiki' && urlEntry.title) {
          const prefix = urlEntry.wiki || 'zspms';
          const bwikiResults = await searchBwiki(urlEntry.title, prefix);
          if (bwikiResults.length > 0) {
            content = bwikiResults.map(b => `【${b.title}】\n${b.content}`).join('\n\n');
            entryUrl = bwikiResults[0].url;
          }
        } else if (urlEntry.type === 'api') {
          const data = await fetchUrl(urlEntry.url, { responseType: 'json' });
          content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
          if (content.length > 4000) content = content.substring(0, 4000);
        } else if (urlEntry.url) {
          // web和search类型统一使用深度爬虫
          const isSearch = urlEntry.type === 'search';
          const pages = await deepCrawl(urlEntry.url, characterName, {
            maxDepth: isSearch ? 2 : 3, // 搜索页2层，目录/普通页3层
            maxPages: isSearch ? 6 : 8,
            maxTotalLen: 8000,
            searchMode: isSearch,
          });
          if (pages.length > 0) {
            content = pages.map(p => p.content).join('\n\n');
            entryUrl = pages[0].url;
          }
        }
        if (content) {
          sources.push({
            id: `custom_${Date.now()}_${sources.length}`,
            source: urlEntry.type || 'web',
            title: urlEntry.title || urlEntry.url || '',
            url: urlEntry.url || '',
            source_tier: 'medium',
            retrieved_at: today,
            status: 'success',
          });
          researchChunks.push(`【自定义来源 - ${urlEntry.title || urlEntry.url}】\n${content}`);
        } else {
          sources.push({
            id: `custom_${Date.now()}_${sources.length}`,
            source: urlEntry.type || 'web',
            url: urlEntry.url || '',
            source_tier: 'medium',
            retrieved_at: today,
            status: 'failed',
            warnings: '未获取到内容（可能是SPA页面需要JS渲染）',
          });
        }
      } catch (e) {
        sources.push({
          id: `custom_${Date.now()}_${sources.length}`,
          source: urlEntry.type || 'web',
          url: urlEntry.url || '',
          source_tier: 'medium',
          retrieved_at: today,
          status: 'failed',
          warnings: e.message,
        });
      }
    }
  }

  // 6. 自定义 Skill 网址（统一使用深度爬虫）
  for (const urlEntry of skillUrls) {
    if (urlEntry.url) {
      try {
        let content = '';
        if (urlEntry.type === 'api') {
          const data = await fetchUrl(urlEntry.url, { responseType: 'json' });
          content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
          if (content.length > 4000) content = content.substring(0, 4000);
        } else {
          const pages = await deepCrawl(urlEntry.url, characterName, {
            maxDepth: 3,
            maxPages: 6,
            maxTotalLen: 6000,
          });
          if (pages.length > 0) {
            content = pages.map(p => p.content).join('\n\n');
          }
        }
        if (content) {
          researchChunks.push(`【Skill来源 - ${urlEntry.title || urlEntry.url}】\n${content}`);
        }
      } catch (e) {}
    }
  }

  // 内容哈希去重：不同URL转载同一正文时只保留一份，减少蒸馏token。
  const seenResearchHashes = new Set();
  const dedupedResearchChunks = [];
  for (const chunk of researchChunks) {
    const fingerprint = contentFingerprint(chunk);
    if (!seenResearchHashes.has(fingerprint)) {
      seenResearchHashes.add(fingerprint);
      dedupedResearchChunks.push(chunk);
    }
  }
  if (dedupedResearchChunks.length === 0) {
    throw new Error('所有资料源均未返回可用正文；已保留失败记录，请补充可信网址或稍后重试');
  }

  const coverageBySection = Object.fromEntries(queryPlan.map(item => [item.section, 0]));
  for (const source of sources.filter(item => item.status === 'success' && item.query_section)) {
    coverageBySection[source.query_section] = (coverageBySection[source.query_section] || 0) + 1;
  }
  const coverageKeywords = {
    identity_world: ['身份', '世界', '组织', '阵营', '背景'],
    personality_values: ['性格', '价值', '动机', '信念', '选择'],
    speech_style: ['台词', '语录', '说话', '口头禅', '表达'],
    relationships: ['关系', '同伴', '亲人', '朋友', '敌人'],
    emotional_patterns: ['情绪', '开心', '难过', '生气', '触发', '反应'],
    daily_interaction: ['日常', '问候', '关心', '聊天', '互动'],
  };
  for (const [section, keywords] of Object.entries(coverageKeywords)) {
    if (!coverageBySection[section]) {
      coverageBySection[section] = dedupedResearchChunks.filter(chunk => keywords.some(keyword => chunk.includes(keyword))).length;
    }
  }
  const distillWarnings = [];
  const successfulSources = sources.filter(item => item.status === 'success');
  if (successfulSources.length < 2) distillWarnings.push('独立成功来源不足2个，重要事实必须标记为待确认');
  for (const section of ROLEPLAY_SECTIONS.map(item => item.id)) {
    if (!coverageBySection[section]) distillWarnings.push(`资料覆盖不足: ${section}`);
  }
  const researchRoleplayCoverage = Object.fromEntries(ROLEPLAY_SECTIONS.map(section => [
    section.id,
    {
      covered: Number(coverageBySection[section.id] || 0) > 0,
      source_count: Number(coverageBySection[section.id] || 0),
    },
  ]));

  // 保存调研资料
  const refDir = path.join(getCharacterDir(characterId), 'references');
  if (!fs.existsSync(refDir)) fs.mkdirSync(refDir, { recursive: true });
  const researchContent = `# ${characterName} 调研资料\n\n调研日期: ${today}\n角色类型: ${characterType}\n\n${dedupedResearchChunks.join('\n\n---\n\n')}`;
  fs.writeFileSync(path.join(refDir, 'research.md'), researchContent, 'utf-8');

  // 将调研资料存入知识库索引（用于聊天时RAG检索）
  const archiveService = require('./archiveService');
  const knowledgeChunks = dedupedResearchChunks.map((chunk, i) => ({
    title: sources[i] ? `${sources[i].source} - ${sources[i].title}` : `资料${i + 1}`,
    content: chunk,
    source: sources[i] ? sources[i].url : '',
  }));
  archiveService.indexKnowledge(characterId, knowledgeChunks);
  console.log(`[Distill/Web] 知识库索引已更新: ${knowledgeChunks.length}条`);

  // 构建蒸馏 prompt
  const profile = promptBuilder.readCharacterProfile(characterId);
  const charMd = promptBuilder.readCharacterMd(characterId);

  const charInfo = `角色名: ${characterName}
身份: ${profile.role || '未知'}
风格: ${profile.style || ''}
背景: ${charMd.background || ''}
性格: ${charMd.personality || ''}
说话方式: ${charMd.speaking_style || ''}`;

  // 去重+压缩researchData：去除重复段落，节约token
  const uniqueChunks = dedupedResearchChunks;
  const researchData = uniqueChunks.join('\n\n').substring(0, 10000);

  const typeHint = {
    game: '游戏角色',
    anime: '动漫角色',
    real: '现实人物',
    unknown: '角色',
  }[characterType] || '角色';

  const skillPrompt = buildUniversalDistillPrompt({
    name: characterName,
    typeHint,
    charInfo,
    researchData,
    existingSkill,
    today,
  });

  const messages = [
    { role: 'system', content: UNIVERSAL_DISTILL_SYSTEM_PROMPT },
    { role: 'user', content: skillPrompt },
  ];

  // 先落盘研究阶段元数据；即使后续模型调用失败，也保留来源、覆盖率和失败线索。
  Object.assign(manifest, {
    schema_version: '1.2', distill_method: 'web', character_type: characterType,
    last_updated_at: today, sources, query_plan: queryPlan, search_diagnostics: searchDiagnostics,
    sources_attempted: sources.length + searchDiagnostics.attempted,
    sources_succeeded: successfulSources.length,
    sources_failed: sources.filter(item => item.status === 'failed').length + searchDiagnostics.failed,
    pages_visited: sources.reduce((sum, item) => sum + Number(item.page_count || 0), 0),
    coverage_by_section: researchRoleplayCoverage, warnings: distillWarnings,
    citations: successfulSources.map(item => ({
      title: item.title || item.source, url: item.canonical_url || item.url,
      source_tier: item.source_tier, source_score: item.source_score,
      evidence_excerpt: item.evidence_excerpt || (dedupedResearchChunks.find(chunk => item.title && chunk.includes(item.title)) || '').substring(0, 240),
      retrieved_at: item.retrieved_at,
    })),
    partial_result: distillWarnings.length > 0, generation_status: 'research_complete',
  });
  writeManifest(characterId, manifest);

  let skillContent;
  try {
    skillContent = await aiClient.chatWithAI(messages, { maxTokens: 8192, timeout: 180000 });
  } catch (error) {
    manifest.generation_status = 'failed';
    manifest.partial_result = true;
    manifest.warnings = [...new Set([...(manifest.warnings || []), `Skill生成失败: ${error.message}`])];
    writeManifest(characterId, manifest);
    throw error;
  }
  promptBuilder.writeSkill(characterId, skillContent);
  const skillCoverage = analyzeRoleplaySkillCoverage(skillContent);
  const finalRoleplayCoverage = Object.fromEntries(ROLEPLAY_SECTIONS.map(section => [
    section.id,
    {
      covered: !skillCoverage.missingSections.includes(section.id),
      source_count: Number(coverageBySection[section.id] || 0),
    },
  ]));
  const finalDistillWarnings = [...new Set([
    ...distillWarnings,
    ...skillCoverage.warnings,
    ...skillCoverage.missingSections.map(section => `生成结果缺少角色扮演章节: ${section}`),
  ])];

  // 自动补充角色信息字段（背景/性格/说话风格/喜好/故事）
  await autoFillCharacterFields(characterId, characterName, skillContent, researchData, promptBuilder, aiClient, today);

  // 更新 manifest
  manifest.distill_method = 'web';
  manifest.character_type = characterType;
  manifest.generated_at = manifest.generated_at || today;
  manifest.last_updated_at = today;
  manifest.covered_until = today;
  manifest.schema_version = '1.2';
  manifest.sources = sources;
  manifest.query_plan = queryPlan;
  manifest.search_diagnostics = searchDiagnostics;
  manifest.sources_attempted = sources.length + searchDiagnostics.attempted;
  manifest.sources_succeeded = successfulSources.length;
  manifest.sources_failed = sources.filter(item => item.status === 'failed').length + searchDiagnostics.failed;
  manifest.pages_visited = sources.reduce((sum, item) => sum + Number(item.page_count || 0), 0);
  manifest.coverage_by_section = finalRoleplayCoverage;
  manifest.citations = successfulSources.map(item => ({
    title: item.title || item.source,
    url: item.canonical_url || item.url,
    source_tier: item.source_tier,
    source_score: item.source_score,
    evidence_excerpt: item.evidence_excerpt || (dedupedResearchChunks.find(chunk => item.title && chunk.includes(item.title)) || '').substring(0, 240),
    retrieved_at: item.retrieved_at,
  }));
  manifest.warnings = finalDistillWarnings;
  manifest.partial_result = finalDistillWarnings.length > 0;
  manifest.generation_status = 'completed';
  manifest.input_summary = {
    character_name: characterName,
    search_hints: searchHints,
    wiki_prefix: autoWikiPrefix || wikiPrefix,
    source_count: sources.length,
    success_count: sources.filter(s => s.status === 'success').length,
  };
  manifest.honesty_boundary = `本Skill的资料检索完成于${today}。行为蒸馏基于截至该日期可检索到的公开资料。如果作品有新更新，可能无法反映最新内容。`;
  const manifestValidation = validateRoleplayDistillationManifest(manifest);
  if (!manifestValidation.valid) {
    manifest.partial_result = true;
    manifest.warnings = [...new Set([
      ...(manifest.warnings || []),
      ...manifestValidation.errors.map(error => `蒸馏契约校验: ${error}`),
    ])];
  }
  writeManifest(characterId, manifest);

  return {
    success: true,
    skill: skillContent,
    sources,
    manifest,
    researchPath: path.join(refDir, 'research.md'),
  };
}

// 自动补充角色信息字段（背景/性格/说话风格/喜好/故事）
// 基于生成的Skill内容和调研资料，自动填充角色信息区的各字段
// 只在字段为空时填充，不覆盖用户已手动填写的内容
async function autoFillCharacterFields(characterId, characterName, skillContent, researchData, promptBuilder, aiClient, today) {
  try {
    // 检查各字段是否已有内容（已有内容则不覆盖）
    const charMd = promptBuilder.readCharacterMd(characterId);
    const existingBackground = charMd.background;
    const existingPersonality = charMd.personality;
    const existingSpeaking = charMd.speaking_style;
    const existingLikes = charMd.likes;
    const existingStory = charMd.story;

    // 如果所有字段都已有内容，则不重复生成
    if (existingBackground && existingPersonality && existingSpeaking && existingLikes && existingStory) {
      console.log('[AutoFill] 所有字段已有内容，跳过自动补充');
      return;
    }

    console.log('[AutoFill] 开始自动补充角色信息字段...');

    // 优化：不再重复发送researchData，skillContent已包含所有提炼信息
    // 只用skillContent来补充字段，节约约4000 token
    const fillPrompt = `基于以下Skill内容，为角色"${characterName}"生成结构化的角色信息字段。

【Skill内容】
${skillContent.substring(0, 8000)}

请严格按以下JSON格式输出（只输出JSON，不要其他内容），每个字段要完整、立体、有细节：
{
  "background": "角色完整背景：出身、经历、身份变迁、所处世界观。200-500字。",
  "personality": "角色完整性格：包含表层性格、深层性格、性格矛盾点（如坚强与脆弱、理性与感性的冲突）。要体现人物的立体感，不能只写正面。200-400字。",
  "speakingStyle": "说话风格：句式偏好、用词习惯、语气节奏、口头禅、情绪表达方式。100-200字。",
  "likes": "喜好：喜爱的、厌恶的、内心心结。分条列出。",
  "story": "重要故事线：按时间顺序讲述关键故事线、转折点及结果。相关人物要在故事中体现。300-800字。"
}

注意：
- 只输出JSON，不要markdown代码块标记
- 字段内容要完整有细节，不能潦草
- 性格必须包含矛盾点
- 故事必须包含转折结果和相关人物`;

    const messages = [
      { role: 'system', content: '你是角色信息整理助手，只输出JSON格式的内容，不要输出其他解释。' },
      { role: 'user', content: fillPrompt },
    ];

    const fillResult = await aiClient.chatWithAI(messages, { maxTokens: 3000, timeout: 120000 });
    // 清理可能的markdown代码块标记
    let cleanResult = fillResult.trim();
    if (cleanResult.startsWith('```')) {
      cleanResult = cleanResult.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    let fields;
    try {
      fields = JSON.parse(cleanResult);
    } catch (e) {
      // 尝试提取JSON部分
      const jsonMatch = cleanResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        fields = JSON.parse(jsonMatch[0]);
      } else {
        console.error('[AutoFill] JSON解析失败:', e.message);
        return;
      }
    }

    // 只在字段为空时填充，写入character.md
    const updateFields = {};
    if (!existingBackground && fields.background) {
      updateFields.background = fields.background;
      console.log('[AutoFill] 已补充 background');
    }
    if (!existingPersonality && fields.personality) {
      updateFields.personality = fields.personality;
      console.log('[AutoFill] 已补充 personality');
    }
    if (!existingSpeaking && fields.speakingStyle) {
      updateFields.speaking_style = fields.speakingStyle;
      console.log('[AutoFill] 已补充 speaking_style');
    }
    if (!existingLikes && fields.likes) {
      updateFields.likes = fields.likes;
      console.log('[AutoFill] 已补充 likes');
    }
    if (!existingStory && fields.story) {
      updateFields.story = fields.story;
      console.log('[AutoFill] 已补充 story');
    }

    if (Object.keys(updateFields).length > 0) {
      promptBuilder.writeCharacterMd(characterId, updateFields);
    }

    console.log('[AutoFill] 角色信息字段补充完成');
  } catch (e) {
    console.error('[AutoFill] 自动补充字段失败:', e.message);
  }
}

// 网络蒸馏提示已移至 services/distillPrompt.js，供所有角色类型共用。

// 方法2：自定义导入蒸馏（用于纪念逝者/还原亲友聊天习惯）
// ============================================================
async function distillFromCustom(characterId, options, aiClient, promptBuilder) {
  const {
    characterName,
    personalityDesc = '',
    chatRecords = '',
    momentsPosts = '',
    otherNotes = '',
    relationship = '',
    purpose = 'memorial',
    existingSkill = '',
    imagePaths = [],  // 图片文件路径数组
    audioPaths = [],  // 语音文件路径数组
  } = options;

  const manifest = readManifest(characterId);
  const today = todayStr();

  console.log(`[Distill/Custom] 开始为 ${characterName} 蒸馏 (目的: ${purpose})`);
  console.log(`[Distill/Custom] 输入: 文字素材 + ${imagePaths.length}张图片 + ${audioPaths.length}条语音`);

  const sources = [];
  const inputChunks = [];

  // 记录文字输入来源
  if (personalityDesc && personalityDesc.trim()) {
    sources.push({
      id: `input_personality_${Date.now()}`,
      source: '用户输入-性格描述',
      retrieved_at: today,
      status: 'success',
      char_count: personalityDesc.length,
    });
    inputChunks.push(`【性格描述】\n${personalityDesc}`);
  }

  if (chatRecords && chatRecords.trim()) {
    sources.push({
      id: `input_chat_${Date.now()}`,
      source: '用户输入-聊天记录',
      retrieved_at: today,
      status: 'success',
      char_count: chatRecords.length,
    });
    inputChunks.push(`【聊天记录】\n${chatRecords.substring(0, 8000)}`);
  }

  if (momentsPosts && momentsPosts.trim()) {
    sources.push({
      id: `input_moments_${Date.now()}`,
      source: '用户输入-朋友圈/动态',
      retrieved_at: today,
      status: 'success',
      char_count: momentsPosts.length,
    });
    inputChunks.push(`【朋友圈/动态】\n${momentsPosts}`);
  }

  if (otherNotes && otherNotes.trim()) {
    sources.push({
      id: `input_notes_${Date.now()}`,
      source: '用户输入-其他备注',
      retrieved_at: today,
      status: 'success',
      char_count: otherNotes.length,
    });
    inputChunks.push(`【其他备注】\n${otherNotes}`);
  }

  // 处理图片输入：识别图片中的文字内容（聊天截图、手写信、朋友圈截图等）
  for (let i = 0; i < imagePaths.length; i++) {
    const imgPath = imagePaths[i];
    try {
      console.log(`[Distill/Custom] 识别图片 ${i + 1}/${imagePaths.length}: ${path.basename(imgPath)}`);
      const imageBuffer = fs.readFileSync(imgPath);
      const imageBase64 = 'data:image/' + path.extname(imgPath).slice(1) + ';base64,' + imageBuffer.toString('base64');
      const recognizedText = await aiClient.recognizeImage(imageBase64);

      sources.push({
        id: `input_image_${Date.now()}_${i}`,
        source: '用户上传-图片',
        title: path.basename(imgPath),
        retrieved_at: today,
        status: recognizedText.startsWith('[') ? 'failed' : 'success',
        char_count: recognizedText.length,
        warnings: recognizedText.startsWith('[') ? recognizedText : null,
      });

      if (!recognizedText.startsWith('[')) {
        inputChunks.push(`【图片识别内容 - ${path.basename(imgPath)}】\n${recognizedText}`);
      }
    } catch (e) {
      console.error(`[Distill/Custom] 图片识别失败 ${imgPath}:`, e.message);
      sources.push({
        id: `input_image_${Date.now()}_${i}`,
        source: '用户上传-图片',
        title: path.basename(imgPath),
        retrieved_at: today,
        status: 'failed',
        warnings: e.message,
      });
    }
  }

  // 处理语音输入：语音转文字
  for (let i = 0; i < audioPaths.length; i++) {
    const audioPath = audioPaths[i];
    try {
      console.log(`[Distill/Custom] 转写语音 ${i + 1}/${audioPaths.length}: ${path.basename(audioPath)}`);
      const audioBuffer = fs.readFileSync(audioPath);
      const ext = path.extname(audioPath).slice(1).toLowerCase();
      const mimeType = ext === 'mp3' ? 'audio/mpeg' : (ext === 'm4a' ? 'audio/mp4' : `audio/${ext}`);
      const transcribedText = await aiClient.transcribeAudio(audioBuffer, path.basename(audioPath), mimeType);

      sources.push({
        id: `input_audio_${Date.now()}_${i}`,
        source: '用户上传-语音',
        title: path.basename(audioPath),
        retrieved_at: today,
        status: transcribedText.startsWith('[') ? 'failed' : 'success',
        char_count: transcribedText.length,
        warnings: transcribedText.startsWith('[') ? transcribedText : null,
      });

      if (!transcribedText.startsWith('[')) {
        inputChunks.push(`【语音转写内容 - ${path.basename(audioPath)}】\n${transcribedText}`);
      }
    } catch (e) {
      console.error(`[Distill/Custom] 语音转写失败 ${audioPath}:`, e.message);
      sources.push({
        id: `input_audio_${Date.now()}_${i}`,
        source: '用户上传-语音',
        title: path.basename(audioPath),
        retrieved_at: today,
        status: 'failed',
        warnings: e.message,
      });
    }
  }

  // 保存调研资料
  const refDir = path.join(getCharacterDir(characterId), 'references');
  if (!fs.existsSync(refDir)) fs.mkdirSync(refDir, { recursive: true });
  const researchContent = `# ${characterName} 自定义导入资料\n\n导入日期: ${today}\n蒸馏目的: ${purpose}\n与用户关系: ${relationship || '未说明'}\n输入类型: 文字 + ${imagePaths.length}张图片 + ${audioPaths.length}条语音\n\n${inputChunks.join('\n\n---\n\n')}`;
  fs.writeFileSync(path.join(refDir, 'research.md'), researchContent, 'utf-8');

  // 将自定义资料存入知识库索引（用于聊天时RAG检索）
  const archiveService = require('./archiveService');
  const knowledgeChunks = inputChunks.map((chunk, i) => ({
    title: `自定义资料 ${i + 1}`,
    content: chunk,
    source: 'custom',
  }));
  archiveService.indexKnowledge(characterId, knowledgeChunks);
  console.log(`[Distill/Custom] 知识库索引已更新: ${knowledgeChunks.length}条`);

  // 构建蒸馏 prompt
  // 统计基于素材全文（不截断），保证说话习惯频率是真实数字；
  // 注入 prompt 的素材用头/中/尾智能抽样，避免硬截断丢掉中后段行为样本。
  const fullMaterial = inputChunks.join('\n\n');
  const styleStats = buildStyleStatsBlock(analyzeChatStyle(fullMaterial));
  const inputData = smartSampleMaterial(fullMaterial, 12000);
  const skillPrompt = buildUniversalCustomDistillPrompt({
    name: characterName,
    relationship,
    purpose,
    inputData,
    styleStats,
    existingSkill,
    today,
  });
  const successfulCustomSources = sources.filter(source => source.status === 'success');
  Object.assign(manifest, {
    schema_version: '1.2',
    distill_method: 'custom',
    character_type: purpose === 'memorial' ? 'memorial' : 'custom',
    last_updated_at: today,
    sources,
    citations: successfulCustomSources.map(source => ({
      title: source.title || source.source,
      source: source.source,
      retrieved_at: source.retrieved_at,
      evidence_excerpt: `${source.char_count || 0} 字用户提供素材`,
    })),
    coverage_by_section: Object.fromEntries(ROLEPLAY_SECTIONS.map(section => [
      section.id,
      { covered: false, source_count: successfulCustomSources.length },
    ])),
    warnings: ['人物Skill尚未生成；已保留导入资料和来源记录'],
    partial_result: true,
    generation_status: 'research_complete',
  });
  writeManifest(characterId, manifest);

  const messages = [
    { role: 'system', content: UNIVERSAL_DISTILL_SYSTEM_PROMPT },
    { role: 'user', content: skillPrompt },
  ];

  let skillContent;
  try {
    skillContent = await aiClient.chatWithAI(messages, { maxTokens: 6144, timeout: 180000 });
  } catch (error) {
    manifest.generation_status = 'failed';
    manifest.warnings = [...new Set([...(manifest.warnings || []), `Skill生成失败: ${error.message}`])];
    writeManifest(characterId, manifest);
    throw error;
  }
  promptBuilder.writeSkill(characterId, skillContent);
  const customSkillCoverage = analyzeRoleplaySkillCoverage(skillContent);
  const customCoverageBySection = Object.fromEntries(ROLEPLAY_SECTIONS.map(section => [
    section.id,
    {
      covered: !customSkillCoverage.missingSections.includes(section.id),
      source_count: successfulCustomSources.length,
    },
  ]));
  const customWarnings = [...new Set([
    ...customSkillCoverage.warnings,
    ...customSkillCoverage.missingSections.map(section => `生成结果缺少角色扮演章节: ${section}`),
  ])];

  // 自动补充角色信息字段（背景/性格/说话风格/喜好/故事）
  await autoFillCharacterFields(characterId, characterName, skillContent, inputData, promptBuilder, aiClient, today);

  // 更新 manifest
  manifest.distill_method = 'custom';
  manifest.schema_version = '1.2';
  manifest.character_type = purpose === 'memorial' ? 'memorial' : 'custom';
  manifest.generated_at = manifest.generated_at || today;
  manifest.last_updated_at = today;
  manifest.covered_until = today;
  manifest.sources = sources;
  manifest.citations = successfulCustomSources.map(source => ({
    title: source.title || source.source,
    source: source.source,
    retrieved_at: source.retrieved_at,
    evidence_excerpt: `${source.char_count || 0} 字用户提供素材`,
  }));
  manifest.coverage_by_section = customCoverageBySection;
  manifest.warnings = customWarnings;
  manifest.partial_result = customWarnings.length > 0;
  manifest.generation_status = 'completed';
  manifest.input_summary = {
    character_name: characterName,
    relationship,
    purpose,
    personality_chars: personalityDesc.length,
    chat_chars: chatRecords.length,
    moments_chars: momentsPosts.length,
    notes_chars: otherNotes.length,
    image_count: imagePaths.length,
    audio_count: audioPaths.length,
  };
  manifest.honesty_boundary = `本Skill基于用户提供的个人素材（文字${personalityDesc.length + chatRecords.length + momentsPosts.length + otherNotes.length}字 + 图片${imagePaths.length}张 + 语音${audioPaths.length}条）提炼，资料导入日期: ${today}。此Skill是对人物聊天风格和性格特征的还原，不能完全替代真实的人。`;
  const customManifestValidation = validateRoleplayDistillationManifest(manifest);
  if (!customManifestValidation.valid) {
    manifest.partial_result = true;
    manifest.warnings = [...new Set([
      ...(manifest.warnings || []),
      ...customManifestValidation.errors.map(error => `蒸馏契约校验: ${error}`),
    ])];
  }
  writeManifest(characterId, manifest);

  // 生成可搜索的历史记录md（图片简单描述，文字聊天图提取文字，用户提到关键词时可搜索到）
  await generateSearchableHistory(characterId, characterName, inputChunks, sources, today, relationship, aiClient);

  return {
    success: true,
    skill: skillContent,
    sources,
    manifest,
    researchPath: path.join(refDir, 'research.md'),
  };
}

// 生成可搜索的历史记录md（与聊天记录归档系统兼容，用户提到关键词时可检索到）
async function generateSearchableHistory(characterId, characterName, inputChunks, sources, today, relationship, aiClient) {
  try {
    const historyDir = path.join(getCharacterDir(characterId), 'history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });

    const historyParts = [];
    historyParts.push(`# ${characterName} 的历史记录`);
    historyParts.push(`\n导入日期: ${today}`);
    historyParts.push(`关系: ${relationship || '未说明'}\n`);

    // 将所有素材整理为历史记录格式
    for (const chunk of inputChunks) {
      historyParts.push(`\n---\n\n${chunk}`);
    }

    // 对图片素材生成简单描述（如果图片识别内容已经是文字，直接保留）
    const imageSources = sources.filter(s => s.source === '用户上传-图片' && s.status === 'success');
    if (imageSources.length > 0) {
      historyParts.push(`\n---\n\n【图片素材摘要】`);
      for (const imgSrc of imageSources) {
        historyParts.push(`- ${imgSrc.title}: ${imgSrc.char_count || 0}字内容已提取`);
      }
    }

    const historyContent = historyParts.join('\n');
    const historyPath = path.join(historyDir, `imported_${today}.md`);
    fs.writeFileSync(historyPath, historyContent, 'utf-8');

    // 同时将内容添加到归档系统（使其可被RAG检索）
    const archiveService = require('./archiveService');
    const timestamp = `${today} ${new Date().toTimeString().substring(0, 8)}`;
    // 将历史记录作为"用户"消息归档，这样用户提到关键词时可以搜索到
    const archiveContent = `[历史记录导入] ${characterName}的素材资料：\n${inputChunks.join('\n\n').substring(0, 3000)}`;
    archiveService.appendMessage(characterId, {
      role: 'user',
      content: archiveContent,
      time: timestamp,
    });

    console.log(`[Distill/Custom] 历史记录已生成: ${historyPath}`);
  } catch (e) {
    console.error('[Distill/Custom] 生成历史记录失败:', e.message);
  }
}

// 自定义蒸馏提示已移至 services/distillPrompt.js，供个人素材与网络角色共用行为框架。\n\n
module.exports = {
  readManifest,
  writeManifest,
  distillFromWeb,
  distillFromCustom,
  detectCharacterType,
};
