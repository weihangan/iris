// 语音文本切句器（从 server.js 抽离，保持默认行为完全一致）。
//
// 新增能力（可选，默认关闭）：
//   splitSentences(text, { maxLen, firstMaxLen, minFirstLen })
// - firstMaxLen > 0 时，把首段压到 firstMaxLen 字以内，用于流式 TTS 的
//   "首段优先"：首段每少 1 字，首字延迟约少 180ms（见 docs/OPTIMIZE-ASSESSMENT-vmd-and-ttfa.md 模型 B）。
// - 切断优先选 ≤firstMaxLen 的最晚句读边界（，、；,;。！？!?），且不得早于 minFirstLen
//   （避免造出 "嗯，" 这类孤立语气段——历史上孤立超短段直送 GPT-SoVITS 会产生杂音/全静音）。
// - 无合法边界时硬切在 firstMaxLen。
// - [语气:xx]...[/语气] 标记视为原子，切断点会被吸附到标记边界，避免把标记切成两半。

function stripStageDirections(text) {
  return String(text || '')
    // Some providers leak chat-template markers into streamed TTS text. They
    // are transport tokens, never character dialogue, and must not reach the
    // UI, history, semantic cue splitter, or synthesized audio.
    // 模板标记通配剥离：不同模型的 chat template 会泄漏各种 <|xxx|> token
    //（endofthought/tool_calls/think…），固定名单追不完。凡 <|...|> 形态
    // 都是传输标记，绝不该被朗读。修复"部分失败 1/2 + <|endofthought|>"
    // 弹窗（2026-09-13）。
    .replace(/<\|[^|>]{0,60}\|>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')                  // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')         // Markdown 图片
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')       // Markdown 链接只保留文字
    .replace(/\[表情包:[^\]]*\]/g, ' ')
    .replace(/\[图片\s*:[^\]]*\]/g, ' ')
    .replace(/^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s+\d{1,2}:\d{2})\s*/gm, '')
    .replace(/（[^）]*）/g, '')   // 中文全角括号
    .replace(/\([^)]*\)/g, '')    // 英文半角括号
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/([。！？!?，,;；～~])\1{2,}/g, '$1$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')         // 合并多余空格
    .trim();
}

// 与 server.js 原 splitSentences 完全一致的基线实现。
function splitSentencesBase(text, maxLen = 25) {
  let clean = stripStageDirections(text);
  if (!clean) return [];
  // 去掉引号字符（引号残留产生孤立段→GPT-SoVITS 杂音/卡顿）
  // 只去引号符号本身，保留引号内的文字
  clean = clean.replace(/[""「」『』]/g, '');
  // 半角~替换为全角～（GPT-SoVITS 对半角~处理不佳→杂音）
  clean = clean.replace(/~/g, '～');
  // 保护 [语气:xx]...[/语气] 标记：整段替换为占位符，切句后再还原（避免标记内标点切断标记）
  const toneMarkers = [];
  clean = clean.replace(/\[语气:[^\]]*\][\s\S]*?\[\/语气\]/g, (m) => {
    toneMarkers.push(m);
    return `\u0002${toneMarkers.length - 1}\u0002`;
  });
  const parts = clean
    .replace(/([。！？!?\n]+)/g, '$1\u0000')
    // 省略号/破折号也是自然停顿边界（2026-09-13 实测：含 ……/—— 的
    // 53 字段因不参与切分直通引擎，超长段内部软切分静音失败 →
    // "部分失败 1/2"。按边界保留标点的同样模式切分）。
    .replace(/(……|——)/g, '$1\u0000')
    .split('\u0000').map(s => s.trim()).filter(Boolean);
  const raw = [];
  for (const p of parts) {
    // 还原 tone 标记
    let restored = p.replace(/\u0002(\d+)\u0002/g, (mm, idx) => toneMarkers[parseInt(idx)] || '');
    if (restored.length <= maxLen) { raw.push(restored); continue; }
    let b = '';
    for (const seg of restored.split(/([，、；,;])/)) {
      if ((b + seg).length > maxLen && b) { raw.push(b); b = seg; }
      else b += seg;
    }
    if (b.trim()) raw.push(b);
  }
  // 短段合并：<10字的段合并到相邻段（优先合并到前段，首段合并到后段）
  // 避免极短段/拟声词（如"诶？""菲比丘比，诶？"）被单独发给 TTS 导致杂音或全静音
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i].trim();
    if (s.length < 10) {
      if (out.length > 0) {
        // 合并到前一段
        out[out.length - 1] += s;
      } else if (i + 1 < raw.length) {
        // 首段：合并到后一段
        raw[i + 1] = s + raw[i + 1];
      } else {
        out.push(s);
      }
    } else {
      out.push(s);
    }
  }
  return out;
}

// [语气:xx]...[/语气] 标记在段内的原子区间（切断点不得落在区间内部）。
function toneMarkerSpans(segment) {
  const spans = [];
  const re = /\[语气:[^\]]*\][\s\S]*?\[\/语气\]/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

// 句读标点（句末/句中停顿）。以这些字符开头的段是引擎跑飞形态，
// cutFirstSegment 的残句哨兵保证流式后段永不以它们开头。
const SENTENCE_PUNCT_CHARS = '。！？!?，、；,;';

function snapCutOutsideSpans(cut, segment, firstMaxLen, minFirstLen) {
  for (const [start, end] of toneMarkerSpans(segment)) {
    if (cut > start && cut < end) {
      if (end <= firstMaxLen) return end;
      if (start >= minFirstLen) return start;
      return cut; // 实在无处可去，保留原切点（标记可能被切开，兜底）
    }
  }
  return cut;
}

// 把过长首段切成 [head, tail]。head ≤ firstMaxLen，且尽量 ≥ minFirstLen。
function cutFirstSegment(segment, firstMaxLen, minFirstLen) {
  let best = 0;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if ('，、；,;。！？!?'.includes(ch)) {
      const boundary = i + 1;
      if (boundary >= minFirstLen && boundary <= firstMaxLen && boundary < segment.length) {
        best = boundary; // 取 ≤firstMaxLen 的最晚边界（首段尽量短，但不过碎）
      }
    }
  }
  if (best === 0) best = Math.min(firstMaxLen, segment.length);
  best = snapCutOutsideSpans(best, segment, firstMaxLen, minFirstLen);
  // 残句哨兵：切点后若紧跟"≤2字残句尾巴+句读"（如"呢。""事呢。"），
  // 引擎内部按句号再切分会产出 1~2 字孤句→确定性 AR 跑飞（实测
  // "呢。清晨…"100% 生成长度异常）。3 字起引擎可正常合成，不吸收，
  // 保持既有切分行为。把残句尾巴并回首段（首段至多 +3 字），
  // 保证后段永不以致命残句开头。
  const tailAfterCut = segment.slice(best);
  const orphanMatch = tailAfterCut.match(/^([^，、；,;。！？!?]{1,2})([。！？!?])/);
  if (orphanMatch) {
    best += orphanMatch[0].length;
  }
  return [segment.slice(0, best), segment.slice(best)];
}

/**
 * 句级切分。
 * @param {string} text
 * @param {number|{maxLen?:number, firstMaxLen?:number, minFirstLen?:number, groupTarget?:number, groupMax?:number}} [options]
 *   数字 = maxLen（向后兼容 server.js 原调用方式）。
 *   firstMaxLen > 0 时首段额外压缩；缺省/为 0 时行为与原实现完全一致。
 *   groupMax > 0 时启用长度均衡分组（2026-09-13 用户需求）：把相邻短段
 *   合并到接近 groupTarget 字（上限 groupMax），段长均匀、首段足够长以
 *   覆盖后续段合成时间，消除段间静音间隔。启用后不再做 firstMaxLen 截短
 *   （两者冲突：均衡分组本身就保证首段足够长）。
 */
function splitSentences(text, options) {
  let maxLen = 25;
  let firstMaxLen = 0;
  let minFirstLen = 6;
  let groupTarget = 0;
  let groupMax = 0;
  if (typeof options === 'number') {
    maxLen = options;
  } else if (options && typeof options === 'object') {
    if (Number.isFinite(options.maxLen)) maxLen = options.maxLen;
    if (Number.isFinite(options.firstMaxLen)) firstMaxLen = options.firstMaxLen;
    if (Number.isFinite(options.minFirstLen)) minFirstLen = options.minFirstLen;
    if (Number.isFinite(options.groupTarget)) groupTarget = options.groupTarget;
    if (Number.isFinite(options.groupMax)) groupMax = options.groupMax;
  }
  const out = splitSentencesBase(text, maxLen);
  if (groupMax > 0) {
    // 长度均衡分组：累积相邻段，达到 groupTarget 即封段；吸收下一段会
    // 超过 groupMax 时提前封段。切点仍落在既有段边界（句读/省略号）上，
    // 只是"逢标点必切"改为"算过长度的均衡切分"。
    const grouped = [];
    let buf = '';
    for (const seg of out) {
      if (!buf) { buf = seg; continue; }
      if (buf.length < groupTarget && buf.length + seg.length <= groupMax) {
        buf += seg;
      } else {
        grouped.push(buf);
        buf = seg;
      }
    }
    if (buf) grouped.push(buf);
    return grouped;
  }
  if (firstMaxLen > 0 && out.length > 0 && out[0].length > firstMaxLen) {
    const head = cutFirstSegment(out[0], firstMaxLen, minFirstLen)[0];
    // tail 与后续段重新走完整基线流水线，保证与默认语义一致且不丢字。
    const tailText = out.join('').slice(head.length);
    const rest = tailText ? splitSentencesBase(tailText, maxLen) : [];
    return rest.length > 0 ? [head, ...rest] : [head];
  }
  return out;
}

/**
 * 按句子完整性分段（2026-09-16 用户规则）：
 * - 以标点（！。，……等）切出句子，逐句攒入当前段；切点永远落在句子边界上；
 * - 句子没结束就完整包含到句子结束（允许略超 target，上限 max）；
 * - 包含后会超过 max 的，不硬凑（在上一边界封段——避免段长失衡）；
 * - 单句超过 max 且内部无边界时，按 target 硬切兜底（防止无限长段）。
 * 展示文本不变；仅用于合成/播放分段。
 */
function splitBalanced(text, options = {}) {
  const target = Number.isFinite(options.target) ? options.target : 11;
  const max = Number.isFinite(options.max) ? options.max : 22;
  // 只按"句末标点"（。！？…）切出完整句子：逗号、顿号、破折号、波浪号等
  // 句内标点不切断句子——段必须在句子完整结束处封口，不按字数硬凑首段。
  const parts = String(text || '')
    .replace(/([。！？!?…]+)/g, '$1\u0000')
    .split('\u0000')
    .map(s => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    const only = parts[0] ? [...parts[0]] : [];
    if (only.length <= max) return parts[0] ? [parts[0]] : [];
    // 超长且无内部边界：按 max 硬切兜底（尽量保持段长，防段太碎/无限长段）
    const out = [];
    for (let i = 0; i < only.length; i += max) out.push(only.slice(i, i + max).join(''));
    return out;
  }
  const segments = [];
  let buf = '';
  let bufLen = 0;
  for (const part of parts) {
    const partLen = [...part].length;
    if (!buf) { buf = part; bufLen = partLen; continue; }
    if (bufLen < target && bufLen + partLen <= max) {
      // 还没到 target，且包含下一句不会超上限 → 把下一个句子也包括进去
      buf += part;
      bufLen += partLen;
    } else {
      segments.push(buf);
      buf = part;
      bufLen = partLen;
    }
  }
  if (buf) segments.push(buf);
  // 单段超上限（超长无边界句）：按 max 硬切兜底（尽量保持段长，防段太碎/无限长段）
  const out = [];
  for (const seg of segments) {
    const chars = [...seg];
    if (chars.length <= max) { out.push(seg); continue; }
    for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(''));
  }
  return out;
}

module.exports = { splitSentences, splitBalanced, stripStageDirections };
