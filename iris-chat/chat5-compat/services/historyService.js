// owner-trace: wha1999/core/history
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./appPaths');
const {
  partitionHistoryForCompressionByBudget,
  estimateHistoryPromptChars,
  findDurableMemoryCandidates,
  COMPRESSION_TRIGGER_CHARS,
  COMPRESSION_KEEP_RECENT_CHARS,
  COMPRESSION_MIN_RECENT_MESSAGES,
} = require('./chatMemoryPolicy');
const { writeJsonAtomic } = require('./atomic-persistence');

function getDataPath(characterId, filename) {
  return path.join(DATA_DIR, `${characterId}_${filename}`);
}

function readHistory(characterId) {
  const filePath = getDataPath(characterId, 'chat_history.json');
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

function writeHistory(characterId, history) {
  const filePath = getDataPath(characterId, 'chat_history.json');
  try {
    writeJsonAtomic(filePath, history);
  } catch (error) {
    console.error('[HistoryService] 写入历史失败:', error.message);
  }
}

function clearHistory(characterId) {
  writeHistory(characterId, []);
  writeCompressed(characterId, getDefaultCompressedState());
}

function onHistoryMessageDeleted(characterId, deletedIndex) {
  const compressed = readCompressed(characterId);
  if (compressed.schema_version < 2) return;
  const activeStart = Number(compressed.active_start_index) || 0;
  if (Number(deletedIndex) >= 0 && Number(deletedIndex) < activeStart) {
    // 已删除内容可能被累计摘要概括。无法可靠地从自然语言摘要中局部删除，因此
    // 让现存完整原文重新成为活动历史，等待下一次达到阈值时再生成干净节点。
    const reset = getDefaultCompressedState();
    writeCompressed(characterId, reset);
  }
}

function addMessage(characterId, role, content, extra = {}) {
  const history = readHistory(characterId);
  const now = new Date();
  const y = now.getFullYear();
  const M = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const message = {
    role: role,
    content: content,
    time: `${y}-${M}-${d} ${h}:${m}:${s}`,
    ...extra,
  };
  history.push(message);
  writeHistory(characterId, history);
  return message;
}

function readCompressed(characterId) {
  const filePath = getDataPath(characterId, 'compressed_history.json');
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return getDefaultCompressedState();
  }
}

function getDefaultCompressedState() {
  return {
    schema_version: 2,
    history_mode: 'canonical_full',
    summary: '',
    active_start_index: 0,
    last_compressed_index: 0,
    nodes: [],
  };
}

// schema_version 2 起，chat_history.json 始终保存完整原文；active_start_index 只是
// “摘要节点”，提示词只发送节点后的原文。旧版文件没有该字段时，chat_history 本身
// 已经是旧节点后的活动后缀，因此从 0 开始兼容读取。
function readActiveHistory(characterId) {
  const history = readHistory(characterId);
  const compressed = readCompressed(characterId);
  const activeStart = compressed.schema_version >= 2
    ? Math.max(0, Math.min(history.length, Number(compressed.active_start_index) || 0))
    : 0;
  return history.slice(activeStart);
}

function writeCompressed(characterId, compressed) {
  const filePath = getDataPath(characterId, 'compressed_history.json');
  try {
    writeJsonAtomic(filePath, compressed);
  } catch (error) {
    console.error('[HistoryService] 写入压缩历史失败:', error.message);
  }
}

const MAX_COMPRESSED_SUMMARY_CHARS = 2400;

function readPositiveInt(name, fallback, minimum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function getCompressionPolicy() {
  const triggerChars = readPositiveInt(
    'HISTORY_COMPRESSION_TRIGGER_CHARS',
    COMPRESSION_TRIGGER_CHARS,
    20000,
  );
  const keepRecentChars = Math.min(
    triggerChars - 1000,
    readPositiveInt('HISTORY_COMPRESSION_KEEP_CHARS', COMPRESSION_KEEP_RECENT_CHARS, 4000),
  );
  const minRecentMessages = readPositiveInt(
    'HISTORY_COMPRESSION_MIN_RECENT_MESSAGES',
    COMPRESSION_MIN_RECENT_MESSAGES,
    4,
  );
  return { triggerChars, keepRecentChars, minRecentMessages };
}

function normalizeCompressedSummary(summary) {
  const cleaned = String(summary || '')
    .replace(/<!--emotion:[\s\S]*?-->/gi, '')
    .replace(/\[EMOTION\][\s\S]*?\[\/EMOTION\]/gi, '')
    .trim();
  if (cleaned.length <= MAX_COMPRESSED_SUMMARY_CHARS) return cleaned;
  const headLength = Math.floor(MAX_COMPRESSED_SUMMARY_CHARS * 0.68);
  const tailLength = MAX_COMPRESSED_SUMMARY_CHARS - headLength - 5;
  return `${cleaned.slice(0, headLength)}\n……\n${cleaned.slice(-tailLength)}`;
}

function removeCompressedMessagesSafely(characterId, compressedMessages) {
  const archivedCounts = new Map();
  for (const m of compressedMessages) {
    const key = `${m.time || ''}\u0000${m.role || ''}\u0000${m.content || ''}`;
    archivedCounts.set(key, (archivedCounts.get(key) || 0) + 1);
  }
  // 摘要调用期间用户可能继续聊天，因此必须重新读取磁盘，只删除本次已归档的旧消息，
  // 不能用开始时的 history 快照覆盖后来追加的新消息。
  const latestHistory = readHistory(characterId);
  const remaining = latestHistory.filter(m => {
    const key = `${m.time || ''}\u0000${m.role || ''}\u0000${m.content || ''}`;
    const count = archivedCounts.get(key) || 0;
    if (count <= 0) return true;
    archivedCounts.set(key, count - 1);
    return false;
  });
  writeHistory(characterId, remaining);
}

function needsCompression(characterId) {
  const activeHistory = readActiveHistory(characterId);
  return estimateHistoryPromptChars(activeHistory) >= getCompressionPolicy().triggerChars;
}

async function compressHistory(characterId, chatWithAI, memoryService, archiveService) {
  const history = readHistory(characterId);
  const compressed = readCompressed(characterId);
  const legacyMode = compressed.schema_version < 2;
  const activeStart = legacyMode
    ? 0
    : Math.max(0, Math.min(history.length, Number(compressed.active_start_index) || 0));
  const activeHistory = history.slice(activeStart);
  const policy = getCompressionPolicy();
  if (estimateHistoryPromptChars(activeHistory) < policy.triggerChars) return false;

  const { toCompress, keepRecent } = partitionHistoryForCompressionByBudget(activeHistory, {
    keepRecentChars: policy.keepRecentChars,
    minRecentMessages: policy.minRecentMessages,
  });
  const compressCount = toCompress.length;
  if (compressCount <= 0) return false;

  const archivedRecords = [];
  if (archiveService) {
    for (const msg of toCompress) {
      // 完整聊天已经保存在 canonical chat_history.json；RAG 归档只索引用户原话，
      // 避免重复保存/召回旧助手措辞并显著缩小索引。
      if (msg?.role !== 'user') continue;
      try {
        archivedRecords.push(archiveService.appendMessage(characterId, msg));
      } catch (e) {}
    }
  }

  try {
    const promptPath = path.join(__dirname, '..', 'prompts', 'compression_prompt.txt');
    let promptTemplate = fs.readFileSync(promptPath, 'utf-8');

    const historyText = toCompress.map(m => `[${m.time}] ${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n');
    promptTemplate = promptTemplate.replace('{{CHAT_HISTORY}}', historyText);
    promptTemplate = promptTemplate.replace('{{EXISTING_SUMMARY}}', compressed.summary || '（无）');
    const compactMemory = memoryService?.getCompactMemoryState
      ? memoryService.getCompactMemoryState(characterId)
      : {};
    promptTemplate = promptTemplate.replace('{{CURRENT_MEMORY}}', JSON.stringify(compactMemory));

    const messages = [
      { role: 'system', content: '你是对话压缩与长期记忆整理助手。严格依据用户原话，只输出提示要求的JSON。' },
      { role: 'user', content: promptTemplate },
    ];

    // 摘要上限为 2400 字符，连同 memory_updates JSON 需要比普通聊天更大的
    // 输出预算；否则模型可能在 JSON 末尾被截断，反而触发重试或本地降级。
    const rawResult = await chatWithAI(messages, { maxTokens: 2048 });
    const parsedResult = parseCompressionResult(rawResult);
    const summary = normalizeCompressedSummary(parsedResult.summary);
    if (!summary) throw new Error('压缩结果没有可用摘要');

    compressed.summary = summary;
    compressed.last_compressed_index = (compressed.last_compressed_index || 0) + compressCount;
    compressed.schema_version = 2;
    compressed.history_mode = 'canonical_full';
    compressed.active_start_index = activeStart + compressCount;
    if (!Array.isArray(compressed.nodes)) compressed.nodes = [];
    compressed.nodes.push({
      id: `c${Date.now()}`,
      compressed_at: new Date().toISOString(),
      start_index: activeStart,
      end_index: activeStart + compressCount - 1,
      message_count: compressCount,
      first_time: toCompress[0]?.time || '',
      last_time: toCompress[toCompress.length - 1]?.time || '',
      archive_ids: archivedRecords.map(record => record?.id).filter(Boolean),
    });
    if (compressed.nodes.length > 100) compressed.nodes = compressed.nodes.slice(-100);
    writeCompressed(characterId, compressed);

    console.log(`[HistoryService] 压缩完成: ${compressCount}条消息进入摘要节点，完整原文仍保留；节点后保留${keepRecent.length}条`);

    if (memoryService) {
      // 摘要与结构化长期记忆来自同一次 API 响应，不再额外发起“记忆提取”请求。
      if (parsedResult.memoryUpdates && memoryService.applyExtractedMemoryUpdates) {
        const userEvidenceText = toCompress
          .filter(message => message?.role === 'user')
          .map(message => message.content)
          .join('\n');
        memoryService.applyExtractedMemoryUpdates(characterId, parsedResult.memoryUpdates, userEvidenceText);
      }

      if (memoryService.addCharacterEvent) {
        extractCharacterEvents(toCompress, characterId, memoryService);
        for (const candidate of findDurableMemoryCandidates(toCompress)) {
          memoryService.addCharacterEvent(characterId, candidate.text, candidate.type, candidate.confidence);
        }
      }
      if (memoryService.pruneTransientMemories) {
        memoryService.pruneTransientMemories(
          characterId,
          toCompress.filter(message => message?.role === 'user').map(message => message.content).join('\n'),
        );
      }
    }
    return true;
  } catch (error) {
    console.error('[HistoryService] AI压缩失败，使用本地简单压缩:', error.message);

    const simpleSummary = normalizeCompressedSummary(generateSimpleSummary(toCompress, compressed.summary));
    compressed.summary = simpleSummary;
    compressed.last_compressed_index = (compressed.last_compressed_index || 0) + compressCount;
    compressed.schema_version = 2;
    compressed.history_mode = 'canonical_full';
    compressed.active_start_index = activeStart + compressCount;
    if (!Array.isArray(compressed.nodes)) compressed.nodes = [];
    compressed.nodes.push({
      id: `c${Date.now()}`,
      compressed_at: new Date().toISOString(),
      start_index: activeStart,
      end_index: activeStart + compressCount - 1,
      message_count: compressCount,
      first_time: toCompress[0]?.time || '',
      last_time: toCompress[toCompress.length - 1]?.time || '',
      archive_ids: archivedRecords.map(record => record?.id).filter(Boolean),
      local_fallback: true,
    });
    writeCompressed(characterId, compressed);

    if (memoryService?.addCharacterEvent) {
      extractCharacterEvents(toCompress, characterId, memoryService);
      for (const candidate of findDurableMemoryCandidates(toCompress)) {
        memoryService.addCharacterEvent(characterId, candidate.text, candidate.type, candidate.confidence);
      }
    }
    if (memoryService?.pruneTransientMemories) {
      memoryService.pruneTransientMemories(
        characterId,
        toCompress.filter(message => message?.role === 'user').map(message => message.content).join('\n'),
      );
    }

    console.log(`[HistoryService] 本地压缩完成: ${compressCount}条消息进入摘要节点，完整原文仍保留`);
    return true;
  }
}

function parseCompressionResult(rawResult) {
  const raw = String(rawResult || '').trim();
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(fenced);
    if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
      return {
        summary: parsed.summary,
        memoryUpdates: parsed.memory_updates && typeof parsed.memory_updates === 'object'
          ? parsed.memory_updates
          : null,
      };
    }
  } catch (e) {}

  const jsonMatch = fenced.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed && typeof parsed.summary === 'string') {
        return { summary: parsed.summary, memoryUpdates: parsed.memory_updates || null };
      }
    } catch (e) {}
  }
  // 兼容旧模型/旧提示词直接返回纯文本摘要。
  return { summary: fenced, memoryUpdates: null };
}

function extractTopics(messages) {
  const userMsgs = messages.filter(m => m.role === 'user');
  const topics = new Set();
  for (const msg of userMsgs) {
    const content = msg.content;
    if (content.length > 4 && content.length <= 30) {
      topics.add(content);
    } else if (content.length > 30) {
      topics.add(content.substring(0, 20) + '...');
    }
    if (topics.size >= 8) break;
  }
  return Array.from(topics);
}

function detectEmotion(messages) {
  const text = messages.map(m => m.content).join(' ');
  const emotions = [
    { keywords: ['开心', '高兴', '快乐', '棒', '太好了', '哈哈'], emotion: '开心' },
    { keywords: ['难过', '伤心', '悲伤', '难受', '哭'], emotion: '难过' },
    { keywords: ['焦虑', '紧张', '不安', '压力', '担心'], emotion: '焦虑' },
    { keywords: ['累', '疲惫', '困', '没精神'], emotion: '疲惫' },
    { keywords: ['生气', '愤怒', '气死', '烦死'], emotion: '生气' },
  ];
  for (const e of emotions) {
    if (e.keywords.some(kw => text.includes(kw))) return e.emotion;
  }
  return '平静';
}

function extractCharacterEvents(messages, characterId, memoryService) {
  const eventPatterns = [
    { pattern: /(?:约定|说好|答应|承诺)([^。！？\n]{2,30})/, type: 'promise', importance: 0.9 },
    { pattern: /(?:以后|以后要|记得)([^。！？\n]{2,30})/, type: 'promise', importance: 0.8 },
    { pattern: /(?:害怕|恐惧|不敢)([^。！？\n]{2,20})/, type: 'vulnerability', importance: 0.8 },
    { pattern: /(?:第一次|初次)([^。！？\n]{2,30})/, type: 'milestone', importance: 0.7 },
    { pattern: /(?:谢谢|感谢|多亏)([^。！？\n]{2,30})/, type: 'gratitude', importance: 0.6 },
  ];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    for (const { pattern, type, importance } of eventPatterns) {
      const match = msg.content.match(pattern);
      if (match) {
        const event = match[0].trim();
        memoryService.addCharacterEvent(characterId, event, type, importance);
      }
    }
  }
}

function generateSimpleSummary(messages, existingSummary) {
  const userMessages = messages.filter(m => m.role === 'user');
  const topics = new Set();

  for (const msg of userMessages) {
    const content = msg.content;
    if (content.length > 50) {
      topics.add(content.substring(0, 50) + '...');
    } else {
      topics.add(content);
    }
    if (topics.size >= 10) break;
  }

  let summary = existingSummary ? existingSummary + '\n' : '';
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  summary += `[${dateStr}] 用户讨论了: ${Array.from(topics).join('；')}`;

  return summary;
}

module.exports = {
  readHistory,
  readActiveHistory,
  writeHistory,
  clearHistory,
  onHistoryMessageDeleted,
  addMessage,
  readCompressed,
  writeCompressed,
  needsCompression,
  compressHistory,
  parseCompressionResult,
  getCompressionPolicy,
  normalizeCompressedSummary,
  COMPRESSION_TRIGGER_CHARS,
  COMPRESSION_KEEP_RECENT_CHARS,
};
