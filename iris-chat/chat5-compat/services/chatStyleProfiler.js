// 自定义人物蒸馏的素材定量分析器。
// LLM 单遍阅读容易把低频词当口头禅、漏掉真实高频表达；
// 这里用纯 JS 统计说话习惯（句长/高频短语/标点/语气词），
// 以真实数字支撑 SKILL.md 的“说话方式”章节。

// 语气词表：口语习惯的强信号
const TONE_PARTICLES = ['呢', '啊', '吧', '嘛', '哦', '呀', '哈', '嗯', '唉', '诶', '啦', '咯'];

// 高频短语候选：2~4 字 n-gram。仅统计跨句内重复出现的片段。
const PHRASE_MIN_LEN = 2;
const PHRASE_MAX_LEN = 4;
const PHRASE_MIN_COUNT = 3;
const MAX_PHRASES = 8;

// 无效 n-gram 过滤：纯标点/空白/数字或常见功能词组合
const PHRASE_JUNK = /^[\s\d\p{P}]+$/u;

function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function splitSentences(line) {
  return line
    .split(/(?<=[。！？!?…；;])/)
    .map(s => s.trim())
    .filter(Boolean);
}

// 行首“发言人：”前缀（如“我：”“小明:”）不属于说话习惯，统计前剥离，
// 避免 n-gram 把前缀和正文拼成伪短语。
const SPEAKER_PREFIX = /^[^：:，。！？\n]{1,12}[：:]\s*/;

function stripSpeakerPrefixes(lines) {
  return lines.map(line => line.replace(SPEAKER_PREFIX, ''));
}

function countToneParticles(sentences) {
  const counts = new Map();
  for (const sentence of sentences) {
    for (const particle of TONE_PARTICLES) {
      let idx = sentence.indexOf(particle);
      while (idx !== -1) {
        counts.set(particle, (counts.get(particle) || 0) + 1);
        idx = sentence.indexOf(particle, idx + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([particle, count]) => ({ particle, count }));
}

// 两短语存在 ≥2 字连续重叠即视为同源片段（同一模板句切出的偏移 n-gram）
function hasOverlap(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  for (let i = 0; i + 2 <= short.length; i++) {
    if (long.includes(short.slice(i, i + 2))) return true;
  }
  return false;
}

function extractFrequentPhrases(sentences) {
  const counts = new Map();
  for (const sentence of sentences) {
    // 去掉发言人前缀后按标点切分，只在片段内做 n-gram
    const segments = sentence.split(/[\s,，。！？!?…；;、·~\-—]+/).filter(Boolean);
    for (const segment of segments) {
      for (let len = PHRASE_MIN_LEN; len <= PHRASE_MAX_LEN; len++) {
        for (let i = 0; i + len <= segment.length; i++) {
          const phrase = segment.slice(i, i + len);
          if (PHRASE_JUNK.test(phrase)) continue;
          counts.set(phrase, (counts.get(phrase) || 0) + 1);
        }
      }
    }
  }
  // 只保留达到阈值的短语；同源噪声（同模板句切出的重叠 n-gram，如“感觉还行”与“觉还行吧”）
  // 与已保留短语重叠即跳过，保留更靠前（次数更高/更长）的那一个。
  const qualified = [...counts.entries()]
    .filter(([, count]) => count >= PHRASE_MIN_COUNT)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  const kept = [];
  for (const [phrase, count] of qualified) {
    if (kept.some(([keptPhrase]) => hasOverlap(keptPhrase, phrase))) continue;
    kept.push([phrase, count]);
    if (kept.length >= MAX_PHRASES) break;
  }
  return kept.map(([phrase, count]) => ({ phrase, count }));
}

/**
 * Quantify speech habits from raw custom material.
 * @param {string} text 用户提供的素材全文（不截断，统计需要完整样本）
 */
function analyzeChatStyle(text) {
  const raw = String(text || '');
  const lines = splitLines(raw);
  const strippedLines = stripSpeakerPrefixes(lines);
  const strippedRaw = strippedLines.join('\n');
  const sentences = strippedLines.flatMap(splitSentences);
  const contentChars = sentences.join('').replace(/[\s\p{P}]/gu, '').length;

  const punctuationCounts = new Map();
  for (const mark of ['……', '？', '！', '。', '~']) {
    let idx = strippedRaw.indexOf(mark);
    let count = 0;
    while (idx !== -1) {
      count += 1;
      idx = strippedRaw.indexOf(mark, idx + mark.length);
    }
    if (count > 0) punctuationCounts.set(mark, count);
  }

  return {
    totalChars: raw.length,
    lineCount: lines.length,
    sentenceCount: sentences.length,
    avgSentenceLength: sentences.length ? Math.round(contentChars / sentences.length) : 0,
    frequentPhrases: extractFrequentPhrases(sentences),
    toneParticles: countToneParticles(sentences),
    punctuation: [...punctuationCounts.entries()].map(([mark, count]) => ({ mark, count })),
  };
}

/**
 * Render stats as a compact markdown block for prompt injection.
 * @param {ReturnType<analyzeChatStyle>} stats
 */
function buildStyleStatsBlock(stats) {
  if (!stats || !stats.lineCount) return '';
  const parts = [`- 总行数/句数：${stats.lineCount} 行 / ${stats.sentenceCount} 句`];
  parts.push(`- 平均句长：${stats.avgSentenceLength} 字（去掉标点后）`);
  if (stats.frequentPhrases.length) {
    const phraseText = stats.frequentPhrases.map(p => `“${p.phrase}”×${p.count}`).join('，');
    parts.push(`- 高频表达（真实出现次数）：${phraseText}`);
  }
  if (stats.toneParticles.length) {
    const particleText = stats.toneParticles.map(p => `“${p.particle}”×${p.count}`).join('，');
    parts.push(`- 高频语气词：${particleText}`);
  }
  if (stats.punctuation.length) {
    const punctText = stats.punctuation.map(p => `${p.mark}×${p.count}`).join('，');
    parts.push(`- 标点习惯：${punctText}`);
  }
  return ['【素材统计分析】（服务端统计的真实数字，说话方式章节必须以此为据，不要凭印象编频率）', ...parts].join('\n');
}

/**
 * Head/middle/tail sampling for long material instead of hard truncation.
 * Keeps paragraph boundaries so chat turns stay intact.
 * @param {string} text
 * @param {number} budget 目标字符数上限
 */
function smartSampleMaterial(text, budget) {
  const raw = String(text || '');
  if (raw.length <= budget) return raw;

  // 优先按空行分段；单换行的聊天记录（无空行）退化为按行分段，
  // 否则整段超长会导致抽样结果为空。
  let paragraphs = raw.split(/\n{2,}/);
  if (paragraphs.length < 3) paragraphs = raw.split(/\r?\n/).filter(Boolean);

  const markerHead = '[开头部分]';
  const markerMid = '[中段抽样]';
  const markerTail = '[结尾部分]';
  // 头/中/尾 38%/28%/28%，剩余 6% 留给标记行与 join('\n\n') 连接符开销
  const budgets = {
    head: Math.floor(budget * 0.38),
    mid: Math.floor(budget * 0.28),
    tail: Math.floor(budget * 0.28),
  };

  const takeFrom = (startIdx, endIdx, charBudget, reverse = false) => {
    const picked = [];
    let used = 0;
    const order = [];
    if (reverse) {
      for (let i = endIdx - 1; i >= startIdx; i--) order.push(i);
    } else {
      for (let i = startIdx; i < endIdx; i++) order.push(i);
    }
    for (const i of order) {
      const p = paragraphs[i];
      // 成本含 join('\n\n') 连接符，否则大量短行会悄悄超预算
      const cost = p.length + (picked.length ? 2 : 0);
      if (used + cost > charBudget) {
        // 一段就超预算且尚未取到内容：截取该段（头部取前半，尾部取后半）
        if (!picked.length && p.length > charBudget) {
          picked.push({ index: i, text: reverse ? p.slice(-charBudget) : p.slice(0, charBudget) });
        }
        continue;
      }
      picked.push({ index: i, text: p });
      used += cost;
      if (used >= charBudget) break;
    }
    return reverse ? picked.reverse() : picked;
  };

  const head = takeFrom(0, paragraphs.length, budgets.head);
  const tail = takeFrom(0, paragraphs.length, budgets.tail, true);
  const headIdx = new Set(head.map(p => p.index));
  const tailIdx = new Set(tail.map(p => p.index));

  // 中段从数组中部向两侧扩展
  const midStart = Math.floor(paragraphs.length / 4);
  const midEnd = Math.floor((paragraphs.length * 3) / 4);
  const mid = takeFrom(midStart, midEnd, budgets.mid)
    .filter(p => !headIdx.has(p.index) && !tailIdx.has(p.index));

  const sections = [];
  if (head.length) sections.push(`${markerHead}\n${head.map(p => p.text).join('\n\n')}`);
  if (mid.length) sections.push(`${markerMid}\n${mid.map(p => p.text).join('\n\n')}`);
  if (tail.length) sections.push(`${markerTail}\n${tail.map(p => p.text).join('\n\n')}`);
  const sampled = sections.join('\n\n');
  // 极端情况兜底：退化为头尾截断
  if (!sampled.trim() || sampled.length > budget * 1.05) {
    return `${raw.slice(0, Math.floor(budget * 0.7))}\n...[中段已压缩]...\n${raw.slice(-Math.floor(budget * 0.3))}`;
  }
  return sampled;
}

module.exports = {
  analyzeChatStyle,
  buildStyleStatsBlock,
  smartSampleMaterial,
};
