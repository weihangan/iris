// owner-trace: wha1999/core/chat-memory-policy

const EXPLICIT_EMOTION_FRESH_MS = 12 * 60 * 60 * 1000;
// 对话主体按字符预算而不是按“几十条消息”裁剪。聊天消息通常很短，条数上限只作
// 异常保护；真正的压缩边界由估算后的 prompt 字符数决定。
const RECENT_CONTEXT_MESSAGE_LIMIT = 10000;
const RECENT_CONTEXT_CHAR_LIMIT = 50000;
const MAX_PROACTIVE_ASSISTANTS_IN_CONTEXT = 2;
// 5 万字符作为压缩节点：在保留完整本地历史的前提下，减少日常请求携带的
// 未压缩后缀，同时避免把压缩调用推迟到接近模型上下文上限才发生。
const COMPRESSION_TRIGGER_CHARS = 50000;
const COMPRESSION_KEEP_RECENT_CHARS = 6000;
const COMPRESSION_MIN_RECENT_MESSAGES = 24;
const MESSAGE_PROMPT_OVERHEAD_CHARS = 24;

function partitionHistoryForCompression(history, keepRecentCount) {
  const messages = Array.isArray(history) ? history : [];
  const keep = Math.max(0, Math.min(messages.length, Number(keepRecentCount) || 0));
  const splitAt = messages.length - keep;
  return {
    toCompress: messages.slice(0, splitAt),
    keepRecent: messages.slice(splitAt),
  };
}

function estimateMessagePromptChars(message) {
  if (!message || !['user', 'assistant'].includes(message.role)) return 0;
  return String(message.content || '').length + MESSAGE_PROMPT_OVERHEAD_CHARS;
}

function estimateHistoryPromptChars(history) {
  return (Array.isArray(history) ? history : [])
    .reduce((total, message) => total + estimateMessagePromptChars(message), 0);
}

function partitionHistoryForCompressionByBudget(history, options = {}) {
  const messages = Array.isArray(history) ? history : [];
  const keepRecentChars = Math.max(
    1000,
    Number(options.keepRecentChars) || COMPRESSION_KEEP_RECENT_CHARS,
  );
  const minRecentMessages = Math.max(
    2,
    Number(options.minRecentMessages) || COMPRESSION_MIN_RECENT_MESSAGES,
  );
  let splitAt = messages.length;
  let keptChars = 0;
  let keptMessages = 0;

  while (splitAt > 0 && (keptChars < keepRecentChars || keptMessages < minRecentMessages)) {
    splitAt--;
    keptChars += estimateMessagePromptChars(messages[splitAt]);
    keptMessages++;
  }

  // 不把一轮 user/assistant 对话从中间切断；若保留区从 assistant 开始，连同它前面的
  // 用户原话一起保留。
  if (splitAt > 0 && messages[splitAt]?.role === 'assistant' && messages[splitAt - 1]?.role === 'user') {
    splitAt--;
  }

  return {
    toCompress: messages.slice(0, splitAt),
    keepRecent: messages.slice(splitAt),
    keepRecentChars: estimateHistoryPromptChars(messages.slice(splitAt)),
  };
}

function parseTimestamp(value) {
  const parsed = new Date(String(value || '').replace(' ', 'T')).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeEmotionObservation(current, incoming, options = {}) {
  if (!incoming || !incoming.mood) return { current: current || null, acceptedAsCurrent: false };
  if (!current || !current.mood) return { current: { ...incoming }, acceptedAsCurrent: true };

  const currentConfidence = Number(current.confidence) || 0;
  const incomingConfidence = Number(incoming.confidence) || 0;
  const currentTime = parseTimestamp(current.timestamp);
  const incomingTime = parseTimestamp(incoming.timestamp);
  const explicitFreshMs = Number(options.explicitFreshMs) || EXPLICIT_EMOTION_FRESH_MS;
  const recentExplicit = current.source === 'explicit_user'
    && incoming.source !== 'explicit_user'
    && incomingTime >= currentTime
    && incomingTime - currentTime < explicitFreshMs;

  if (recentExplicit || (incomingTime < currentTime && incoming.source !== 'explicit_user')) {
    return { current: { ...current }, acceptedAsCurrent: false };
  }
  if (incoming.source !== 'explicit_user' && incomingConfidence < currentConfidence && incomingTime <= currentTime) {
    return { current: { ...current }, acceptedAsCurrent: false };
  }
  return { current: { ...incoming }, acceptedAsCurrent: true };
}

function normalizeCandidate(text, type, confidence) {
  return {
    type,
    text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    confidence,
    sourceRole: 'user',
  };
}

function findDurableMemoryCandidates(messages) {
  const candidates = [];
  const seen = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== 'user') continue;
    const text = String(message.content || '').trim();
    if (text.length < 3) continue;
    const matches = [];
    if (/(?:答应|承诺|约定|说好|一定会|记得要)/.test(text)) matches.push(normalizeCandidate(text, 'commitment', 1));
    if (/(?:是我(?:的)?(?:父亲|母亲|爸爸|妈妈|哥哥|姐姐|弟弟|妹妹|伴侣|妻子|丈夫|朋友|同事)|我和.+(?:关系|分手|结婚|和好))/.test(text)) {
      matches.push(normalizeCandidate(text, 'relationship', 1));
    }
    if (/(?:还没解决|没有解决|仍然|一直).*(?:失眠|焦虑|问题|困扰|烦恼)|(?:失眠|焦虑|问题|困扰|烦恼).*(?:还没解决|没有解决|仍然|一直)/.test(text)) {
      matches.push(normalizeCandidate(text, 'unresolved_concern', 0.95));
    }
    if (/(?:考试|面试|手术|搬家|旅行|入职|离职|结婚|生日|纪念日)/.test(text)) {
      matches.push(normalizeCandidate(text, 'key_event', 0.9));
    }
    for (const item of matches) {
      const key = `${item.type}\u0000${item.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(item);
      }
    }
  }
  return candidates;
}

function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\[图片:[^\]]*\]/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function selectRecentConversationContext(history, options = {}) {
  const messages = Array.isArray(history) ? history : [];
  const maxMessages = Math.max(1, Number(options.maxMessages) || RECENT_CONTEXT_MESSAGE_LIMIT);
  const maxChars = Math.max(1000, Number(options.maxChars) || RECENT_CONTEXT_CHAR_LIMIT);
  const maxProactiveAssistants = Math.max(
    0,
    Number.isFinite(Number(options.maxProactiveAssistants))
      ? Number(options.maxProactiveAssistants)
      : MAX_PROACTIVE_ASSISTANTS_IN_CONTEXT,
  );
  const selected = [];
  let totalChars = 0;
  let proactiveAssistants = 0;

  for (let index = messages.length - 1; index >= 0 && selected.length < maxMessages; index--) {
    const message = messages[index];
    if (!message || !['user', 'assistant'].includes(message.role)) continue;
    const content = String(message.content || '').trim();
    if (!content) continue;
    const isProactiveAssistant = message.role === 'assistant' && message.proactive === true;
    if (isProactiveAssistant && proactiveAssistants >= maxProactiveAssistants) continue;
    const messageChars = estimateMessagePromptChars(message);
    if (selected.length > 0 && totalChars + messageChars > maxChars) break;
    selected.push(message);
    totalChars += messageChars;
    if (isProactiveAssistant) proactiveAssistants++;
  }

  return selected.reverse();
}

function selectRelevantUserArchiveResults(results, limit = 3, options = {}) {
  const excluded = new Set((Array.isArray(options.excludeTexts) ? options.excludeTexts : [])
    .map(normalizeComparableText)
    .filter(Boolean));
  const unique = new Set();
  const selected = [];
  const sorted = (Array.isArray(results) ? results : [])
    .filter(result => result && result.role === 'user' && String(result.snippet || result.content || '').trim())
    .sort((a, b) => Number(b.finalScore ?? b.score ?? b.importance ?? 0)
      - Number(a.finalScore ?? a.score ?? a.importance ?? 0));

  for (const result of sorted) {
    const text = String(result.snippet || result.content || '').trim();
    const key = normalizeComparableText(text);
    if (!key || excluded.has(key) || unique.has(key)) continue;
    unique.add(key);
    selected.push({ ...result, snippet: text });
    if (selected.length >= Math.max(0, limit)) break;
  }
  return selected;
}

module.exports = {
  EXPLICIT_EMOTION_FRESH_MS,
  RECENT_CONTEXT_MESSAGE_LIMIT,
  RECENT_CONTEXT_CHAR_LIMIT,
  MAX_PROACTIVE_ASSISTANTS_IN_CONTEXT,
  COMPRESSION_TRIGGER_CHARS,
  COMPRESSION_KEEP_RECENT_CHARS,
  COMPRESSION_MIN_RECENT_MESSAGES,
  MESSAGE_PROMPT_OVERHEAD_CHARS,
  partitionHistoryForCompression,
  partitionHistoryForCompressionByBudget,
  estimateMessagePromptChars,
  estimateHistoryPromptChars,
  mergeEmotionObservation,
  findDurableMemoryCandidates,
  normalizeComparableText,
  selectRecentConversationContext,
  selectRelevantUserArchiveResults,
};
