// owner-trace: wha1999/core/archive-rag
const fs = require('fs');
const path = require('path');
const { DATA_DIR, CHARACTER_DIR } = require('./appPaths');
const { selectRelevantUserArchiveResults } = require('./chatMemoryPolicy');
const { writeJsonAtomic } = require('./atomic-persistence');

const SEARCH_INDEX_VERSION = 3;
const KNOWLEDGE_INDEX_VERSION = 3;
const ARCHIVE_RECALL_INTENT = /(?:还记得|记不记得|记得吗|以前|之前|上次|当时|后来|曾经|说过|聊过|提过|约定|承诺|回忆|忘(?:了|记)|过去)/i;
const SEMANTIC_KEYWORD_GROUPS = Object.freeze([
  ['@affection', /\blove\b|喜欢|爱你|爱意|表白|心动|想你/i],
  ['@sleep', /睡眠|睡觉|失眠|睡不着|休息|困了|好梦/i],
  ['@health', /生病|不舒服|医院|看病|头疼|发烧|健康|手术/i],
  ['@work-study', /工作|上班|入职|离职|学习|考试|面试|作业|论文/i],
  ['@family', /家人|父亲|母亲|爸爸|妈妈|哥哥|姐姐|弟弟|妹妹|伴侣|妻子|丈夫/i],
  ['@food', /吃饭|早餐|午餐|晚餐|饿了|零食|点心|喝茶|奶茶/i],
  ['@mood-low', /难过|伤心|焦虑|害怕|担心|压力|疲惫|累了|孤独/i],
  ['@promise', /答应|承诺|约定|说好|记得要/i],
]);

function getDataPath(characterId, filename) {
  return path.join(DATA_DIR, `${characterId}_${filename}`);
}

function appendMessage(characterId, msg) {
  const filePath = getDataPath(characterId, 'messages.jsonl');
  const id = `m${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const record = {
    id,
    role: msg.role,
    content: msg.content,
    time: msg.time || new Date().toISOString().replace('T', ' ').substring(0, 19),
    tags: msg.tags || [],
    importance: msg.importance || (msg.role === 'user' ? 0.5 : 0.3),
  };
  try {
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
    updateIndex(characterId, record);
    return record;
  } catch (error) {
    console.error('[ArchiveService] 追加消息失败:', error.message);
    return record;
  }
}

function updateIndex(characterId, record) {
  const indexPath = getDataPath(characterId, 'search_index.json');
  let index = {};
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch (e) {
    index = { version: SEARCH_INDEX_VERSION, keywords: {}, records: {}, messageCount: 0, lastUpdated: '' };
  }
  if (index.version !== SEARCH_INDEX_VERSION) {
    rebuildIndexFromArchive(characterId);
    return;
  }

  if (!index.records) index.records = {};
  index.records[record.id] = {
    role: record.role,
    time: record.time,
    snippet: record.content.substring(0, 80),
    importance: record.importance,
  };

  const keywords = extractKeywords(record.content);
  for (const kw of keywords) {
    if (!index.keywords[kw]) {
      index.keywords[kw] = [];
    }
    index.keywords[kw].push(record.id);
    if (index.keywords[kw].length > 200) {
      index.keywords[kw] = index.keywords[kw].slice(-200);
    }
  }

  index.messageCount = (index.messageCount || 0) + 1;
  index.lastUpdated = new Date().toISOString().replace('T', ' ').substring(0, 19);

  try {
    writeJsonAtomic(indexPath, index);
  } catch (error) {
    console.error('[ArchiveService] 更新索引失败:', error.message);
  }
}

function extractKeywords(text, options = {}) {
  if (!text || typeof text !== 'string') return [];
  const original = text.toLowerCase();
  const cleaned = text
    .replace(/[\s\n\r]+/g, ' ')
    .replace(/[^\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ffa-zA-Z0-9\s]/g, ' ')
    .trim();
  const tokens = cleaned.split(/\s+/).filter(t => t.length > 0);
  const keywords = new Set();
  for (const token of tokens) {
    if (token.length >= 2 && token.length <= 8) {
      keywords.add(token);
    }
    if (/[\u4e00-\u9fff]/.test(token) && token.length >= 2) {
      for (let i = 0; i <= token.length - 2; i++) {
        keywords.add(token.substring(i, i + 2));
      }
      for (let i = 0; i <= token.length - 3; i++) {
        keywords.add(token.substring(i, i + 3));
      }
    }
  }
  const stopWords = new Set([
    '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那',
    '有', '没', '不', '也', '都', '就', '要', '会', '可以', '能', '想',
    '什么', '怎么', '为什么', '哪', '吗', '呢', '吧', '啊', '哦', '嗯',
    '好', '很', '还', '又', '再', '把', '被', '让', '给', '到', '从',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
    'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for', 'with', 'to',
  ]);
  if (options.semantic !== false) {
    for (const [semanticKey, pattern] of SEMANTIC_KEYWORD_GROUPS) {
      if (pattern.test(original)) keywords.add(semanticKey);
    }
  }
  return Array.from(keywords).filter(kw => !stopWords.has(kw));
}

function keywordWeight(keyword) {
  if (keyword.startsWith('@')) return 2.5;
  return keyword.length >= 3 ? 1.2 : 0.7;
}

function allowsPartialKeywordMatch(keyword, indexedKeyword) {
  if (keyword.startsWith('@') || indexedKeyword.startsWith('@')) return false;
  if (!/^[a-z0-9]+$/i.test(keyword) || !/^[a-z0-9]+$/i.test(indexedKeyword)) return false;
  return keyword.length >= 3 && indexedKeyword.length >= 3
    && (indexedKeyword.includes(keyword) || keyword.includes(indexedKeyword));
}

function search(characterId, query, topK = 5, options = {}) {
  const indexPath = getDataPath(characterId, 'search_index.json');
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch (e) {
    return [];
  }
  if (index.version !== SEARCH_INDEX_VERSION) {
    const rebuilt = rebuildIndexFromArchive(characterId);
    if (!rebuilt.success) return [];
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch (e) { return []; }
  }

  const queryKeywords = extractKeywords(query);
  if (queryKeywords.length === 0) return [];
  const requiredRole = options.role === 'user' || options.role === 'assistant' ? options.role : '';

  const scored = {};
  const addMatch = (rawEntry, keyword, weight) => {
    const entry = typeof rawEntry === 'string'
      ? { id: rawEntry, ...(index.records?.[rawEntry] || {}) }
      : rawEntry;
    if (!entry || !entry.id || !entry.role) return;
    if (requiredRole && entry.role !== requiredRole) return;
    if (!scored[entry.id]) {
      scored[entry.id] = {
        id: entry.id,
        role: entry.role,
        time: entry.time,
        snippet: entry.snippet,
        importance: entry.importance || 0.5,
        score: 0,
        matchCount: 0,
        matchedKeywords: new Set(),
        lexicalMatchedKeywords: new Set(),
      };
    }
    const item = scored[entry.id];
    item.score += weight;
    item.matchedKeywords.add(keyword);
    if (!keyword.startsWith('@')) item.lexicalMatchedKeywords.add(keyword);
    item.matchCount = item.matchedKeywords.size;
  };
  for (const kw of queryKeywords) {
    const exactMatches = index.keywords[kw] || [];
    for (const entry of exactMatches) {
      addMatch(entry, kw, keywordWeight(kw));
    }
    for (const [indexKw, entries] of Object.entries(index.keywords)) {
      if (indexKw !== kw && allowsPartialKeywordMatch(kw, indexKw)) {
        for (const entry of entries) {
          addMatch(entry, kw, 0.4);
        }
      }
    }
  }

  const now = Date.now();
  for (const entry of Object.values(scored)) {
    const msgTime = new Date(entry.time).getTime();
    const ageHours = (now - msgTime) / (1000 * 60 * 60);
    const freshness = Math.max(0, 1 - ageHours / (24 * 30));
    const coverage = entry.matchCount / Math.max(1, queryKeywords.length);
    entry.finalScore = entry.score * 0.65 + coverage * 0.2 + entry.importance * 0.1 + freshness * 0.05;
    entry.lexicalMatchCount = entry.lexicalMatchedKeywords.size;
    delete entry.matchedKeywords;
    delete entry.lexicalMatchedKeywords;
  }

  return Object.values(scored)
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, topK);
}

function searchUserContext(characterId, query, topK = 3, options = {}) {
  const scored = search(characterId, query, Math.max(topK * 4, topK), { role: 'user' });
  if (scored.length === 0) return [];
  const records = getMessagesByIds(characterId, scored.map(item => item.id));
  const hydrated = scored.map(item => {
    const record = records.get(item.id);
    const fullContent = String(record?.content || item.snippet || '').trim();
    return { ...item, snippet: fullContent, content: fullContent };
  });
  const hasRecallIntent = ARCHIVE_RECALL_INTENT.test(String(query || ''));
  const hasStrongTopicContinuation = hydrated.some(item =>
    Number(item.lexicalMatchCount) > 0 && Number(item.finalScore) >= 0.85
  );
  if (!hasRecallIntent && !hasStrongTopicContinuation) return [];
  return selectRelevantUserArchiveResults(hydrated, topK, options);
}

function getMessagesByIds(characterId, messageIds) {
  const wanted = new Set(Array.isArray(messageIds) ? messageIds : []);
  const found = new Map();
  if (wanted.size === 0) return found;
  const filePath = getDataPath(characterId, 'messages.jsonl');
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(line => line.trim());
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch (e) { continue; }
      if (wanted.has(record.id)) {
        found.set(record.id, record);
        if (found.size === wanted.size) break;
      }
    }
  } catch (e) {}
  return found;
}

function getMessageSnippet(characterId, messageId) {
  const filePath = getDataPath(characterId, 'messages.jsonl');
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      const record = JSON.parse(line);
      if (record.id === messageId) {
        return record;
      }
    }
  } catch (e) {}
  return null;
}

function getContextAround(characterId, messageId, before = 1, after = 1) {
  const filePath = getDataPath(characterId, 'messages.jsonl');
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const records = lines.map(l => JSON.parse(l));
    const targetIdx = records.findIndex(r => r.id === messageId);
    if (targetIdx === -1) return [];
    const start = Math.max(0, targetIdx - before);
    const end = Math.min(records.length, targetIdx + after + 1);
    return records.slice(start, end);
  } catch (e) {
    return [];
  }
}

function migrateFromChatHistory(characterId) {
  const historyPath = getDataPath(characterId, 'chat_history.json');
  const archivePath = getDataPath(characterId, 'messages.jsonl');
  const indexPath = getDataPath(characterId, 'search_index.json');

  if (fs.existsSync(archivePath)) {
    console.log(`[ArchiveService] ${characterId} 已有归档，跳过迁移`);
    return 0;
  }

  let history;
  try {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
  } catch (e) {
    console.log(`[ArchiveService] ${characterId} 无历史记录，跳过迁移`);
    return 0;
  }

  const index = { version: SEARCH_INDEX_VERSION, keywords: {}, records: {}, messageCount: 0, lastUpdated: '' };
  let count = 0;

  for (const msg of history) {
    const id = `m${Date.now()}_${count}_${Math.random().toString(36).substring(2, 6)}`;
    const importance = msg.role === 'user' ? 0.5 : 0.3;
    const record = {
      id,
      role: msg.role,
      content: msg.content,
      time: msg.time || new Date().toISOString().replace('T', ' ').substring(0, 19),
      tags: [],
      importance,
    };
    fs.appendFileSync(archivePath, JSON.stringify(record) + '\n', 'utf-8');
    index.records[record.id] = {
      role: record.role,
      time: record.time,
      snippet: record.content.substring(0, 80),
      importance: record.importance,
    };

    const keywords = extractKeywords(record.content);
    for (const kw of keywords) {
      if (!index.keywords[kw]) index.keywords[kw] = [];
      index.keywords[kw].push(record.id);
    }
    count++;
  }

  index.messageCount = count;
  index.lastUpdated = new Date().toISOString().replace('T', ' ').substring(0, 19);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

  console.log(`[ArchiveService] 迁移完成: ${characterId} ${count}条消息`);
  return count;
}

// 删除单条归档消息：按 time + content 前缀匹配，从 messages.jsonl 删除并重建索引
// 用于用户主动删除对话时同步清理归档，避免 RAG 索引保留已删除内容污染数据
function deleteArchiveMessage(characterId, time, contentPrefix) {
  const filePath = getDataPath(characterId, 'messages.jsonl');
  if (!fs.existsSync(filePath)) return false;
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const remaining = [];
    let removed = false;
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch (e) { remaining.push(line); continue; }
      const timeMatch = !time || record.time === time;
      const contentMatch = !contentPrefix ||
        (record.content && record.content.startsWith(contentPrefix.substring(0, 60)));
      if (timeMatch && contentMatch && !removed) {
        removed = true; // 仅删第一条匹配
        continue;
      }
      remaining.push(line);
    }
    if (removed) {
      fs.writeFileSync(filePath, remaining.map(r => r).join('\n') + '\n', 'utf-8');
      rebuildIndexFromArchive(characterId);
    }
    return removed;
  } catch (e) {
    console.error('[ArchiveService] 删除归档消息失败:', e.message);
    return false;
  }
}

// 清空所有归档：messages.jsonl + search_index.json
// 用于用户清空聊天记录时同步清理，避免归档残留
function clearAllArchive(characterId) {
  const messagesPath = getDataPath(characterId, 'messages.jsonl');
  const indexPath = getDataPath(characterId, 'search_index.json');
  try {
    if (fs.existsSync(messagesPath)) fs.writeFileSync(messagesPath, '', 'utf-8');
    if (fs.existsSync(indexPath)) {
      const empty = { version: SEARCH_INDEX_VERSION, keywords: {}, records: {}, messageCount: 0, lastUpdated: '' };
      writeJsonAtomic(indexPath, empty);
    }
    return true;
  } catch (e) {
    console.error('[ArchiveService] 清空归档失败:', e.message);
    return false;
  }
}

// 从 messages.jsonl 重建 search_index.json
// 用于手动重建索引（兜底清理污染数据）
function rebuildIndexFromArchive(characterId) {
  const messagesPath = getDataPath(characterId, 'messages.jsonl');
  const indexPath = getDataPath(characterId, 'search_index.json');
  const index = { version: SEARCH_INDEX_VERSION, keywords: {}, records: {}, messageCount: 0, lastUpdated: '' };
  let count = 0;
  try {
    if (fs.existsSync(messagesPath)) {
      const lines = fs.readFileSync(messagesPath, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch (e) { continue; }
        index.records[record.id] = {
          role: record.role,
          time: record.time,
          snippet: String(record.content || '').substring(0, 80),
          importance: record.importance || 0.5,
        };
        const keywords = extractKeywords(record.content);
        for (const kw of keywords) {
          if (!index.keywords[kw]) index.keywords[kw] = [];
          index.keywords[kw].push(record.id);
          if (index.keywords[kw].length > 200) {
            index.keywords[kw] = index.keywords[kw].slice(-200);
          }
        }
        count++;
      }
    }
    index.messageCount = count;
    index.lastUpdated = new Date().toISOString().replace('T', ' ').substring(0, 19);
    writeJsonAtomic(indexPath, index);
    console.log(`[ArchiveService] 重建索引完成: ${characterId} ${count}条`);
    return { success: true, count };
  } catch (e) {
    console.error('[ArchiveService] 重建索引失败:', e.message);
    return { success: false, error: e.message };
  }
}

module.exports = {
  appendMessage,
  search,
  searchUserContext,
  getMessageSnippet,
  getMessagesByIds,
  getContextAround,
  extractKeywords,
  migrateFromChatHistory,
  indexKnowledge,
  ensureKnowledgeIndex,
  searchKnowledge,
  deleteArchiveMessage,
  clearAllArchive,
  rebuildIndexFromArchive,
};

// ========== 知识库索引（蒸馏资料RAG检索） ==========

// 将调研资料分块存入知识库索引
// chunks: [{ title, content, source }]
function indexKnowledge(characterId, chunks) {
  const indexPath = getDataPath(characterId, 'knowledge_index.json');
  let index = {};
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch (e) {
    index = { version: KNOWLEDGE_INDEX_VERSION, keywords: {}, chunks: [], lastUpdated: '' };
  }

  // 清空旧索引（每次蒸馏重建）
  index = { version: KNOWLEDGE_INDEX_VERSION, keywords: {}, chunks: [], lastUpdated: '' };

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkId = `k${Date.now()}_${i}`;

    // 将内容分块存储（每块最多500字，便于精确检索）
    const content = chunk.content || '';
    const subChunks = splitIntoSubChunks(content, 500);

    for (let j = 0; j < subChunks.length; j++) {
      const subId = `${chunkId}_s${j}`;
      const subContent = subChunks[j];

      // 存储完整内容
      index.chunks.push({
        id: subId,
        title: chunk.title || '',
        source: chunk.source || '',
        content: subContent,
      });

      // 建立关键词索引
      const keywords = extractKeywords(subContent, { semantic: false });
      for (const kw of keywords) {
        if (!index.keywords[kw]) {
          index.keywords[kw] = [];
        }
        index.keywords[kw].push(subId);
        // 限制每个关键词最多100条引用
        if (index.keywords[kw].length > 100) {
          index.keywords[kw] = index.keywords[kw].slice(-100);
        }
      }
    }
  }

  index.lastUpdated = new Date().toISOString().replace('T', ' ').substring(0, 19);
  try {
    writeJsonAtomic(indexPath, index);
    console.log(`[KnowledgeIndex] 索引完成: ${characterId} ${index.chunks.length}块`);
  } catch (e) {
    console.error('[KnowledgeIndex] 写入索引失败:', e.message);
  }
}

// 将长文本分块
function splitIntoSubChunks(text, maxLen) {
  if (!text || text.length <= maxLen) return [text || ''];
  const chunks = [];
  // 按段落分割
  const paragraphs = text.split(/\n+/);
  let current = '';
  for (const p of paragraphs) {
    if (current.length + p.length + 1 > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = p;
    } else {
      current = current ? current + '\n' + p : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  // 如果单段超长，强制切割
  const result = [];
  for (const c of chunks) {
    if (c.length <= maxLen) {
      result.push(c);
    } else {
      for (let i = 0; i < c.length; i += maxLen) {
        result.push(c.substring(i, i + maxLen));
      }
    }
  }
  return result;
}

// 旧版本可能只有 references 文档而没有知识索引。首次相关查询时自动建立索引，
// 之后聊天只注入命中的小块，不把整份参考资料塞进每轮 prompt。
function ensureKnowledgeIndex(characterId) {
  const indexPath = getDataPath(characterId, 'knowledge_index.json');
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch (e) {}
  if (existing && existing.version === KNOWLEDGE_INDEX_VERSION) return existing;

  let chunks = [];
  if (existing && Array.isArray(existing.chunks) && existing.chunks.length > 0) {
    chunks = existing.chunks.map(chunk => ({
      title: chunk.title || '',
      source: chunk.source || '',
      content: chunk.content || '',
    }));
  } else {
    const referenceDir = path.join(CHARACTER_DIR, String(characterId), 'references');
    try {
      chunks = fs.readdirSync(referenceDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && /\.(?:md|txt|json)$/i.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
        .map(entry => ({
          title: entry.name,
          source: `references/${entry.name}`,
          content: fs.readFileSync(path.join(referenceDir, entry.name), 'utf-8').slice(0, 200000),
        }))
        .filter(chunk => chunk.content.trim());
    } catch (e) {}
  }
  if (chunks.length === 0) return null;
  indexKnowledge(characterId, chunks);
  try { return JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch (e) { return null; }
}

// 按关键词检索知识库
function searchKnowledge(characterId, query, topK = 3) {
  const index = ensureKnowledgeIndex(characterId);
  if (!index) return [];

  const queryKeywords = extractKeywords(query, { semantic: false });
  if (queryKeywords.length === 0) return [];

  // 计算每个chunk的匹配分数
  const scored = {};
  for (const kw of queryKeywords) {
    // 精确匹配
    const exactMatches = index.keywords[kw] || [];
    for (const entry of exactMatches) {
      const id = typeof entry === 'string' ? entry : entry.id;
      if (!id) continue;
      if (!scored[id]) {
        scored[id] = { id, score: 0, matchCount: 0 };
      }
      scored[id].score += 1.0;
      scored[id].matchCount += 1;
    }
    // 英文词允许轻量包含匹配；中文已有2-3字n-gram，不再全表模糊扫描。
    for (const [indexKw, entries] of Object.entries(index.keywords)) {
      if (indexKw !== kw && allowsPartialKeywordMatch(kw, indexKw)) {
        for (const entry of entries) {
          const id = typeof entry === 'string' ? entry : entry.id;
          if (!id) continue;
          if (!scored[id]) {
            scored[id] = { id, score: 0, matchCount: 0 };
          }
          scored[id].score += 0.3;
          scored[id].matchCount += 1;
        }
      }
    }
  }

  // 获取匹配的chunk内容
  const chunkMap = {};
  for (const chunk of index.chunks) {
    chunkMap[chunk.id] = chunk;
  }

  return Object.values(scored)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => chunkMap[s.id])
    .filter(c => c && c.content);
}
