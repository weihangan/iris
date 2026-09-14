// owner-trace: wha1999/core/reply-policy
/**
 * 回复策略模块（零 token 成本，纯本地后处理）
 *
 * 作用：在 AI 回复生成后、写入历史前，做最后一道硬规则修正。
 *      prompt 约束 + 历史剥离 + 后端硬规则 = 三层防护。
 *
 * 不调用 LLM，不消耗 token。所有操作都是本地字符串正则处理。
 */

const stickerService = require('./stickerService');

// ============================================================
// 清洗函数
// ============================================================

/** Remove chat-template control tokens that must never reach history or UI. */
function stripModelControlTokens(text) {
  return String(text || '')
    .replace(/<\|\s*(?:assistant|user|system|end|im_start|im_end)\s*\|>/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 剥离 [表情包:xxx] 标记
 */
function stripStickers(text) {
  return String(text || '').replace(/\s*\[表情包:[^\]]*\]/g, '').trim();
}

/**
 * 剥离 [语气:xxx][/语气] 标记
 */
function stripTone(text) {
  return String(text || '')
    .replace(/\[语气:[^\]]*\]/g, '')
    .replace(/\[\/语气\]/g, '')
    .trim();
}

/**
 * 删除模型偶发附加在回复开头的日期/时间标签。
 * 只处理“开头标签/时间戳”，不删除正文中用户明确询问时间时的正常回答。
 */
function stripLeadingTimestamps(text) {
  let s = String(text || '');
  const wrapped = /^\s*[\[【(（]\s*(?:\d{4}\s*[年\/-]\s*\d{1,2}(?:\s*[月\/-]\s*\d{1,2}\s*日?)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?)\s*[\]】)）]\s*[:：\-—]?\s*/;
  const bare = /^\s*\d{4}\s*[年\/-]\s*\d{1,2}(?:\s*[月\/-]\s*\d{1,2}\s*日?)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*[:：\-—]?\s*/;
  let previous;
  do {
    previous = s;
    s = s.replace(wrapped, '').replace(bare, '');
  } while (s !== previous);
  return s.trim();
}

/**
 * 剥离 emoji 和颜文字
 * 颜文字常见模式：(≧▽≦) (╥_╥) (♡ω♡) (*^▽^*) (｡•́︿•̀｡) 等
 */
function stripEmoji(text) {
  let s = String(text || '');
  // emoji（基本多文种平面中的常用 emoji 范围 + 补充平面）
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '');
  // 颜文字：括号内含日文假名/特殊符号的 () （） 模式
  s = s.replace(/[\(（][^\)（）]*[\u3040-\u309F\u30A0-\u30FF▽♡♥＾▽≦╥ω✿☆※＊∧∨∃∀∇∂][^\)（）]*[\)）]/g, '');
  return s.trim();
}

/**
 * 剥离动作括号（（）内的动作描写）
 * 注意：只剥离纯动作括号，保留对话内容中的括号
 */
function stripActionParens(text) {
  // 只剥离以"(" 或 "（" 开头、整段是动作描写的（含动词/方位词）
  // 简化策略：剥离行首或独立一行的 (...)
  return String(text || '')
    .replace(/(^|\n)\s*[（(][^)）]*[)）]\s*(\n|$)/g, '\n')
    .trim();
}

/**
 * 标准化用于相似度比对：去掉所有装饰性内容，只保留核心文字
 */
function normalizeForCompare(text) {
  let s = String(text || '');
  s = stripStickers(s);
  s = stripTone(s);
  s = stripEmoji(s);
  // 去标点、空白
  s = s.replace(/[\s\u3000。，！？!?,.、~～…\-—「」『』""''()（）【】\[\]""'':：;；]/g, '');
  return s.toLowerCase();
}

/** Remove quoted fragments for duplicate detection without changing visible text. */
function stripQuotedSegments(text) {
  return String(text || '')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/g, ' ');
}

function quotedSegments(text) {
  return [...String(text || '').matchAll(/“([^”]*)”|「([^」]*)」|『([^』]*)』|"([^"]*)"|'([^']*)'/g)]
    .map(match => match.slice(1).find(Boolean) || '')
    .map(value => value.trim())
    .filter(Boolean);
}

// Long user text can be echoed without quotation marks. Keep this guard
// conservative: only reject a clearly long contiguous normalized fragment.
function hasLongVerbatimUserFragment(reply, userInput) {
  const replyNorm = normalizeForCompare(reply);
  const userNorm = normalizeForCompare(userInput);
  const fragmentLength = 18;
  if (replyNorm.length < fragmentLength || userNorm.length < fragmentLength) return false;
  for (let index = 0; index <= userNorm.length - fragmentLength; index += 1) {
    if (replyNorm.includes(userNorm.slice(index, index + fragmentLength))) return true;
  }
  return false;
}

/**
 * Reject only clearly excessive or repeated user quoting at the candidate gate.
 * The visible reply is never rewritten here.
 */
function isQuoteUsageAcceptable(reply, userInput, recentAssistants = []) {
  const quotes = quotedSegments(reply);
  if (hasLongVerbatimUserFragment(reply, userInput)) return false;
  if (quotes.length === 0) return true;

  const userNorm = normalizeForCompare(userInput);
  for (const quote of quotes) {
    const quoteNorm = normalizeForCompare(quote);
    if (!quoteNorm) continue;
    if (quoteNorm.length > 12) return false;
    if (userNorm && quoteNorm.length >= 8 && userNorm.includes(quoteNorm)) return false;
  }

  const recentQuotes = (Array.isArray(recentAssistants) ? recentAssistants : [])
    .slice(-3)
    .flatMap(message => quotedSegments(message && (message.content || message)));
  // 引用本身保持低频：最近三条已有引用时，本轮默认改用自己的理解转述。
  return recentQuotes.length === 0;
}

// ============================================================
// 相似度比对
// ============================================================

/**
 * 最长公共子串相似度
 * @returns {number} 0-1
 */
function longestCommonRatio(a, b) {
  if (!a || !b) return 0;
  if (a === b && a.length >= 3) return 1;
  if (a.length < 8 || b.length < 8) return 0;
  const minLen = Math.min(a.length, b.length);
  let maxMatch = 0;
  // 优化：滑动窗口，避免 O(n²) 完整比对（对 200 字以内的回复够用）
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > maxMatch) maxMatch = k;
    }
  }
  return maxMatch / minLen;
}

// 文字可能完全不同，但仍反复落在同一个暧昧诱导模板上。只识别少数高风险
// 重复意图，并要求近期确实出现过同类意图，避免限制正常的害羞或亲密表达。
const CORE_INTENT_PROFILES = Object.freeze([
  {
    id: 'shy_tease',
    pattern: /(?:想|好想|真想|有点想).{0,12}(?:看|看看|见识|知道).{0,12}(?:害羞|脸红|不好意思|难为情|样子|反应|表情)|(?:害羞|脸红|不好意思|难为情).{0,12}(?:样子|反应|表情)/,
  },
  {
    id: 'appearance_tease',
    pattern: /(?:想|好想|真想|有点想).{0,12}(?:看|看看|欣赏).{0,12}(?:可爱|漂亮|好看|打扮|穿搭).{0,8}(?:样子|反应|表情)?/,
  },
  // 通用对话动作：不同角色也必须共享这层去重，避免只换同义词仍回到
  // “我在听→你最在意哪一点”“记得这件事→后来有进展吗”等低信息模板。
  {
    id: 'listening_clarification',
    pattern: /(?:我(?:在|会|愿意)?听|接住|慢慢说|继续说|说给我听|告诉我(?:一点|一些)?).{0,24}(?:哪(?:一|个)?点|哪部分|最在意|从哪里|继续|回应|告诉我|再说说)/,
  },
  {
    id: 'generic_reassurance',
    pattern: /(?:不用|不必|别|无需).{0,10}(?:着急|勉强|担心|马上|急着|逼自己).{0,22}(?:慢慢|按(?:你|自己的)节奏|等你|准备好|方便时|有空|回应|开口|继续)/,
  },
  {
    id: 'remembered_followup',
    pattern: /(?:之前|刚才|上次|这件事|这个话题).{0,14}(?:提到|说过|记得|记着|想起|留着|挂念|惦记).{0,18}(?:后来|进展|变化|有空|方便|告诉我|说说|回我)/,
  },
  {
    id: 'generic_presence_offer',
    pattern: /(?:我会|我在|我愿意|我可以).{0,12}(?:陪着你|陪你|等你|在这里|听你|接着聊).{0,12}(?:愿意|准备好|想说|继续|方便)/,
  },
  {
    id: 'generic_meta_choice',
    pattern: /(?:你更想|你想先|你希望我|是想).{0,18}(?:被理解|理解|倾听|回应|听你说|听听|建议|具体建议|说说|从哪|哪一点|哪部分)/,
  },
  {
    id: 'generic_listening_only',
    // 只有“我在听/你慢慢说”这类低信息承接，连续出现也视为重复；
    // 含有事实、判断或具体建议的完整回复不会命中此规则。
    pattern: /^(?:我在听|我会听着|我愿意听|你慢慢说|慢慢告诉我|我先听你说|我会接住你)(?:[。！!，,、…]|$).{0,24}(?:你(?:可以|愿意)?(?:慢慢)?(?:说|告诉我)|我(?:会|在)(?:这里|听着)?)[。！!，,、…]?$/,
  },
]);

function classifyCoreIntents(text) {
  const normalized = String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？!?、…~～“”「」『』（）()]/g, '');
  if (!normalized) return [];
  return CORE_INTENT_PROFILES
    .filter(profile => profile.pattern.test(normalized))
    .map(profile => profile.id);
}

function hasRepeatedCoreIntent(reply, recentAssistants) {
  const current = classifyCoreIntents(reply);
  if (current.length === 0) return false;
  const recent = (Array.isArray(recentAssistants) ? recentAssistants : [])
    .slice(-12)
    .flatMap(message => classifyCoreIntents(message && (message.content || message)));
  return current.some(intent => recent.includes(intent));
}

/**
 * 识别“换词不换对话动作”的低信息回复。
 * 这不是主题分类：只有同一通用动作再次出现才拦截，角色具体内容仍由
 * 当前消息和 Skill 决定。这样新角色无需各自维护一份重复词黑名单。
 */
function hasRepeatedConversationalMove(reply, recentAssistants) {
  const current = classifyCoreIntents(reply);
  if (current.length === 0) return false;
  const recent = Array.isArray(recentAssistants) ? recentAssistants : [];
  return recent.slice(-12).some(message => {
    const previous = classifyCoreIntents(message && (message.content || message));
    return current.some(intent => previous.includes(intent));
  });
}

/**
 * 判断回复是否与最近 N 条 assistant 回复高度相似
 * @param {string} reply 当前回复
 * @param {Array} recentAssistants 最近 assistant 消息数组 [{content: '...'}, ...]
 * @param {number} threshold 相似度阈值，默认 0.5
 * @returns {boolean}
 */
function isSimilarToRecent(reply, recentAssistants, threshold = 0.5) {
  const replyNorm = normalizeForCompare(reply);
  const replyBodyNorm = normalizeForCompare(stripQuotedSegments(reply));
  if (replyNorm.length < 3) return false;
  if (hasRepeatedCoreIntent(reply, recentAssistants)) return true;
  if (hasRepeatedConversationalMove(reply, recentAssistants)) return true;
  // 调用方已经按场景裁剪历史（普通对话 8 条、主动消息 12 条）；这里不能再
  // 截成 8 条，否则主动兜底在第 9 条时会重新选回第 1 条旧话术。
  return (Array.isArray(recentAssistants) ? recentAssistants : []).slice(-12).some(m => {
    const mNorm = normalizeForCompare(m.content || m);
    const mBodyNorm = normalizeForCompare(stripQuotedSegments(m.content || m));
    return longestCommonRatio(replyNorm, mNorm) > threshold
      || (replyBodyNorm.length >= 3 && mBodyNorm.length >= 3
        && longestCommonRatio(replyBodyNorm, mBodyNorm) > threshold);
  });
}

function maxSimilarityToRecent(reply, recentAssistants) {
  const replyNorm = normalizeForCompare(reply);
  if (replyNorm.length < 3) return 0;
  let max = 0;
  for (const m of (Array.isArray(recentAssistants) ? recentAssistants : []).slice(-12)) {
    const score = longestCommonRatio(replyNorm, normalizeForCompare(m.content || m));
    if (score > max) max = score;
  }
  return max;
}

/** 两次模型生成仍重复时的低频本地兜底，保证不会把重复原文继续发给用户。 */
function pickNonRepeatingFallback(userInput, recentAssistants) {
  const input = String(userInput || '');
  const candidates = [];
  if (/[难过伤心焦虑害怕累困烦生气哭]/.test(input)) {
    candidates.push('我先不替你下结论。你想继续说时，我会从刚才那句接着听。');
  }
  if (/[？?为什么怎么如何吗呢]$/.test(input.trim())) {
    candidates.push('这个问题可以拆开看。你想先厘清事实，还是先说说你的判断？');
  }
  candidates.push(
    '我先把回应放在这里。你愿意继续时，直接告诉我最想让我接住的一点就好。',
    '这次我换个落点：你刚才的话里，哪一部分最需要我先回应？',
    '我不急着替你归纳。你想从哪个细节继续，我就跟着那个细节说。',
    '先给你留出一点空间。等你开口时，我会认真接住新的内容。'
  );

  const recent = Array.isArray(recentAssistants) ? recentAssistants : [];
  const unused = candidates.find(candidate => !isSimilarToRecent(candidate, recent, 0.5));
  if (unused) return unused;

  // 所有短兜底都已用过时，不能把用户原文再次拼进回复；否则会绕过引用门禁，
  // 在连续失败时反复回放同一段原话。使用不带原文的中性落点，并继续经过去重检查。
  const dynamic = [
    '这件事先放在这里。我不替你作结，等你准备好时再从新的细节继续。',
    '我先留出一点空间。你愿意继续时，直接说此刻最想谈的部分就好。',
    '收到。我会按你接下来提供的新信息回应，不沿用刚才的说法。',
  ];
  return dynamic.find(candidate => !isSimilarToRecent(candidate, recent, 0.5))
    || '我先停在这里，等你带来新的进展再继续。';
}

function pickProactiveFallback(options = {}) {
  const detail = String(options.recentUserDetail || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const elapsedMinutes = Math.max(0, Number(options.elapsedMinutes) || 0);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const lateNight = now.getHours() >= 22 || now.getHours() < 6;
  const longAbsent = elapsedMinutes >= 2880;
  // 主动消息只保留很短、确有必要的专名/关键词；长原文一律概括，避免整句回声。
  const shortDetail = detail.length > 0 && detail.length <= 12 ? detail : '';
  const subject = shortDetail ? `你之前提到的“${shortDetail}”` : '你最近的近况';
  // 兜底与 API 提示词使用同一套沉默梯度；仅提供倾向，不覆盖角色 Skill 的表达方式。
  let concern = '我刚刚又想到了这件事';
  if (elapsedMinutes >= 2880) concern = '隔了这么久，我确实有些挂念';
  else if (elapsedMinutes >= 2160) concern = '一天多没收到你的消息，我有些担心';
  else if (elapsedMinutes >= 1440) concern = '这么久没见到你，我开始有些担心';
  else if (elapsedMinutes >= 720) concern = '隔了大半天，我有一点挂念';
  else if (elapsedMinutes >= 360) concern = '过了好几个小时，我有点想知道你是否顺利';
  else if (elapsedMinutes >= 180) concern = '有一阵子没听到你了';
  else if (elapsedMinutes >= 30 && lateNight) concern = '你可能已经休息了，晚安，也请照顾好身体';
  else if (elapsedMinutes >= 30) concern = '我轻轻问候一句';
  const candidates = [
    `${subject}，我还记着。${concern}；你方便时告诉我后来怎样了就好。`,
    `刚才想起${subject}。${concern}，等你有空再和我说说进展吧。`,
    `${subject}后来顺利吗？${longAbsent ? '许久没听到你的消息，我有些担心' : '不用急着回答'}，你得闲时回我一句就好。`,
    `我没有忘记${subject}。${concern}，但你按自己的节奏来，我会等你。`,
    `想到${subject}，我想问问后来有没有新进展。${longAbsent ? '这么久没有消息，我难免有些牵挂' : '忙完再告诉我也可以'}。`,
    `${subject}还在我心上。${longAbsent ? '你安静了许久，我有一点担心' : '我只是来轻轻问一句'}；等方便时说说近况吧。`,
    `不知${subject}现在进行到哪一步了。${concern}，不必赶着回复。`,
    `我在想${subject}有没有让你轻松一点。${longAbsent ? '久未收到消息，我有些挂念你的近况' : '有空再聊就好'}。`,
    `${subject}，我想认真接着听下去。${longAbsent ? '隔了好一阵，我有些担心你' : '你准备好时再继续'}，不用勉强自己马上回应。`,
    `今天又记起${subject}。${longAbsent ? '这么久没有你的消息，我会挂念' : '只是想知道你是否还好'}；方便的时候告诉我一声吧。`,
    `关于${subject}，我一直留着一点惦念。${longAbsent ? '许久未见，我确实有些担心' : '不着急'}，等你想说时我就在。`,
    `${subject}有没有新的变化？${longAbsent ? '你离开得有些久，我挂念你的近况' : '我来接一下上次的话题'}，晚些回复也没关系。`,
  ];
  const recent = Array.isArray(options.recentAssistants) ? options.recentAssistants : [];
  const unused = candidates.find(candidate => !isSimilarToRecent(candidate, recent, 0.5));
  if (unused) return unused;

  // 兜底候选也必须经过同一套相似度门禁；不要因为候选池耗尽而回放旧话术。
  const detailSuffix = shortDetail ? `关于${subject}，` : '';
  const dynamic = [
    `${detailSuffix}这次我只想知道有没有新的进展；没有也没关系，等你方便再说。`,
    `${detailSuffix}我会记住这件事。你有新的变化时，直接告诉我那一点就好。`,
    `${detailSuffix}这件事先放在这里，不急着回答；等你想说时，我会听新的部分。`,
  ];
  return dynamic.find(candidate => !isSimilarToRecent(candidate, recent, 0.5))
    || '我先不重复追问，等你有新消息时再接着聊。';
}

// ============================================================
// 表情包硬冷却规则
// ============================================================

/**
 * 表情包硬冷却
 * 规则：
 *   1. 一条回复最多保留 1 个 [表情包:xxx]
 *   2. 上一条 assistant 有表情包 → 本条删除所有表情包
 *   3. 距离上次表情包不足 8 条 assistant 回复 → 本条删除
 *   4. 表情包名不存在于 character/<id>/表情包/ → 删除
 *   5. 文字太短（< 8 字）或只有表情包 → 删除表情包
 *
 * @param {string} reply 当前回复
 * @param {Array} recentAssistants 最近 assistant 消息
 * @param {string} characterId 角色ID
 * @param {string} appRoot 应用根目录（用于查找表情包目录）
 * @returns {string} 修正后的回复
 */
function enforceStickerCooldown(reply, recentAssistants, characterId, appRoot) {
  const stickerRe = /\[表情包:([^\]]+)\]/g;
  const matches = [...String(reply || '').matchAll(stickerRe)];
  if (matches.length === 0) return reply;

  let reason = null;

  // 规则 2：上一条有表情包 → 删除
  const lastAssistant = recentAssistants[recentAssistants.length - 1];
  if (lastAssistant && /\[表情包:/.test(lastAssistant.content || '')) {
    reason = '上一条已有表情包';
  }

  // 规则 3：最近 8 条内有过表情包 → 删除
  if (!reason) {
    const recent8 = recentAssistants.slice(-8);
    const lastStickerIdx = recent8.findIndex(m => /\[表情包:/.test(m.content || ''));
    // findIndex 返回第一个匹配，我们要的是最后一个匹配距离末尾的距离
    let lastIdx = -1;
    for (let i = recent8.length - 1; i >= 0; i--) {
      if (/\[表情包:/.test(recent8[i].content || '')) {
        lastIdx = i;
        break;
      }
    }
    if (lastIdx >= 0 && (recent8.length - lastIdx) < 8) {
      reason = `最近 ${recent8.length - lastIdx} 条内已有表情包`;
    }
  }

  // 规则 5：文字太短 → 删除
  if (!reason) {
    const textOnly = stripStickers(reply).trim();
    if (textOnly.length < 8) {
      reason = '文字过短';
    }
  }

  // 规则 4：校验表情包是否存在
  if (!reason) {
    const validStickers = new Set(stickerService.listStickers(characterId).map(sticker => sticker.name));
    // 当前角色没有表情包，或模型引用了其他角色/不存在的名字，都直接删除。
    for (const m of matches) {
      const name = m[1].trim();
      if (!validStickers.has(name)) {
        reason = validStickers.size === 0
          ? `角色 ${characterId} 没有可用表情包`
          : `表情包 "${name}" 不属于角色 ${characterId}`;
        break;
      }
    }
  }

  if (reason) {
    console.log(`[ReplyPolicy] 表情包冷却触发: ${reason}，删除所有表情包`);
    return stripStickers(reply);
  }

  // 规则 1：保留第一个，删除其余
  if (matches.length > 1) {
    console.log(`[ReplyPolicy] 一条回复有 ${matches.length} 个表情包，只保留第一个`);
    let kept = false;
    return String(reply).replace(stickerRe, (full) => {
      if (kept) return '';
      kept = true;
      return full;
    }).replace(/\s{2,}/g, ' ').trim();
  }

  return reply;
}

const STICKER_MOOD_PROFILES = Object.freeze({
  sleep: {
    reply: /晚安|睡觉|休息|入睡|好梦/,
    sticker: /晚安|晚上|睡觉|好梦|休息|困|哈欠/,
  },
  shy: {
    reply: /害羞|脸红|不好意思|难为情/,
    sticker: /害羞|脸红|难为情|扭捏|偷偷看/,
  },
  affection: {
    reply: /喜欢|爱你|想你|心动|在意你|陪着你|表白/,
    sticker: /喜欢|爱心|比心|表白|心动|撒娇|亲亲|拥抱|想你/,
    conflict: /不喜欢|拒绝|生气|伤心|病娇/,
  },
  happy: {
    reply: /太好了|开心|高兴|好消息|真棒|顺利解决|笑起来|值得庆祝|成功了|完成了/,
    sticker: /开心|高兴|庆祝|欢喜|兴奋|笑|胜利|成功|撒花|鼓掌|比耶|小骄傲/,
    conflict: /不高兴|伤心|难过|害怕|生气|无语|无奈/,
  },
  comfort: {
    reply: /难过|伤心|委屈|焦虑|害怕|担心|不安|辛苦|疲惫|累了/,
    sticker: /安慰|温柔|担心|害怕|伤心|难过|流泪|抱抱|鼓励|加油/,
  },
  encourage: {
    reply: /加油|祝你|做得到|会顺利|有进展|再试试/,
    sticker: /鼓励|加油|打气|拍手|支持|努力/,
  },
  surprise: {
    reply: /惊讶|没想到|居然|竟然|原来如此/,
    sticker: /惊讶|吃惊|震惊|意外|灵光一闪|抱头/,
  },
  angry: {
    reply: /生气|愤怒|气人|过分|讨厌/,
    sticker: /生气|愤怒|不高兴|不喜欢|拒绝|气鼓鼓/,
  },
  annoyed: {
    reply: /无奈|没办法|真拿你没办法|哭笑不得|无语|无聊/,
    sticker: /无奈|无语|不嘻嘻|没救了|死机|无聊|躺平|摸鱼/,
  },
  food: {
    reply: /吃饭|早餐|午餐|晚餐|饿了|零食|点心|喝茶|奶茶/,
    sticker: /吃|饭|面|薯片|零食|喝|茶|奶茶|点心|吃瓜/,
  },
  appearance: {
    reply: /照片|自拍|好看|漂亮|可爱|打扮|裙子/,
    sticker: /美照|自拍|漂亮|好看|臭美|起舞|装酷|可爱/,
  },
  playful: {
    reply: /开玩笑|逗你|有趣|好玩|调皮|搞怪/,
    sticker: /搞怪|调皮|玩笑|装可爱|装帅|耍杂技|跳舞|吃瓜/,
  },
  question: {
    reply: /[？?]/,
    sticker: /疑问|不对啊|凝望|思考|为什么/,
  },
  approval: {
    reply: /没错|确实|同意|做得好|很好|真不错|明白了|收到/,
    sticker: /赞同|肯定|点赞|对的|敬礼|鼓掌/,
  },
});

const AUTO_STICKER_EXCLUDED = /菲比丘比|有点变态|进监狱|不要走|求收养|处罚你|你没救了|病娇/;
const STICKER_MOOD_PRIORITY = Object.freeze([
  'sleep', 'comfort', 'angry', 'shy', 'happy', 'encourage', 'surprise',
  'annoyed', 'food', 'appearance', 'playful', 'affection', 'approval', 'question',
]);

function classifyStickerMood(reply) {
  const value = String(reply || '');
  for (const mood of STICKER_MOOD_PRIORITY) {
    const profile = STICKER_MOOD_PROFILES[mood];
    if (profile.reply.test(value)) return mood;
  }
  return null;
}

function stableStickerIndex(text, size) {
  let hash = 0;
  for (const char of String(text || '')) hash = ((hash * 31) + char.codePointAt(0)) >>> 0;
  return size > 0 ? hash % size : 0;
}

/**
 * 从运行时扫描到的当前角色清单中按语义选图。新文件无需登记；类别或细分命名
 * 能表达语义（例如“庆祝-撒花”）即可参与评分，没有匹配则返回 null。
 */
function selectStickerForReply(reply, stickers) {
  const value = String(reply || '');
  const mood = classifyStickerMood(value);
  const profile = mood && STICKER_MOOD_PROFILES[mood];
  if (!profile || !Array.isArray(stickers) || stickers.length === 0) return null;

  const unique = new Map();
  for (const sticker of stickers) {
    if (!sticker || typeof sticker !== 'object') continue;
    const category = String(sticker.category || '').trim();
    const detail = String(sticker.detail || '').trim();
    const name = String(sticker.name || `${category}-${detail}`).trim();
    if (!name || AUTO_STICKER_EXCLUDED.test(name) || (profile.conflict && profile.conflict.test(name)) || unique.has(name)) continue;

    // 类别比细分拥有更高权重，避免“吃瓜-小高兴”压过真正的“开心/高兴”类别。
    let score = profile.sticker.test(category) ? 8 : 0;
    if (profile.sticker.test(detail)) score += 4;
    if (category.length >= 2 && value.includes(category)) score += 9;
    if (detail.length >= 2 && value.includes(detail)) score += 7;
    if (score > 0) unique.set(name, { name, score });
  }

  const ranked = [...unique.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'));
  if (ranked.length === 0) return null;
  const topScore = ranked[0].score;
  const top = ranked.filter(candidate => candidate.score === topScore);
  return top[stableStickerIndex(`${mood}:${value}`, top.length)].name;
}

/**
 * 模型长期不主动输出表情包时的低频本地调度。
 * 只有最近 minInterval 条助手回复都没有表情包时才会添加，并从角色真实存在的文件中选择。
 */
function maybeAddSticker(reply, recentAssistants, characterId, appRoot, minInterval = 8) {
  const value = String(reply || '').trim();
  if (!value || /\[表情包:[^\]]+\]/.test(value) || stripStickers(value).length < 8) return value;

  const recent = Array.isArray(recentAssistants) ? recentAssistants : [];
  const interval = Math.max(1, Number(minInterval) || 8);
  if (recent.length < interval) return value;
  if (recent.slice(-interval).some(message => /\[表情包:/.test(String(message && (message.content || message) || '')))) {
    return value;
  }

  // 严肃安全话题不自动加表情包，避免把危险、疾病或丧失类对话轻佻化。
  if (/自杀|轻生|死亡|去世|抢救|报警|危险|事故|重病|医院急诊/.test(value)) return value;

  // 只从当前角色 ID 的实时清单里选择；没有语义对应项时不跨角色、不跨类别兜底。
  const sticker = selectStickerForReply(value, stickerService.listStickers(characterId));
  if (!sticker) return value;
  const mood = classifyStickerMood(value);
  console.log(`[ReplyPolicy] 表情包低频调度: mood=${mood}, sticker=${sticker}`);
  return `${value}\n[表情包:${sticker}]`;
}

// ============================================================
// emoji/颜文字硬冷却
// ============================================================

/**
 * emoji/颜文字硬冷却
 * 规则：
 *   1. 上一条 assistant 有 emoji/颜文字 → 本条删除
 *   2. 最近 8 条内有过 → 本条删除
 *
 * @returns {string} 修正后的回复
 */
function enforceEmojiCooldown(reply, recentAssistants) {
  // 检测当前回复是否有 emoji/颜文字
  const hasEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u.test(reply) ||
                   /[\(（][^\)（）]*[\u3040-\u309F\u30A0-\u30FF▽♡♥＾▽≦╥ω✿☆※＊∧∨∃∀∇∂][^\)（）]*[\)）]/.test(reply);
  if (!hasEmoji) return reply;

  // 检查最近 8 条
  const recent8 = recentAssistants.slice(-8);
  for (const m of recent8) {
    const c = m.content || '';
    const hadEmoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u.test(c) ||
                     /[\(（][^\)（）]*[\u3040-\u309F\u30A0-\u30FF▽♡♥＾▽≦╥ω✿☆※＊∧∨∃∀∇∂][^\)（）]*[\)）]/.test(c);
    if (hadEmoji) {
      console.log('[ReplyPolicy] emoji/颜文字冷却触发，删除');
      return stripEmoji(reply);
    }
  }

  return reply;
}

// ============================================================
// 重复句检测（同一条回复内部）
// ============================================================

/**
 * 删除同一条回复内的重复句子
 * 规则：按句号/问号/感叹号切分，完全相同的句子只保留第一次出现
 */
function dedupSentences(reply) {
  const text = String(reply || '');
  // 保留分隔符的切分
  const sentences = text.split(/(?<=[。！？!?\n])/);
  const seen = new Set();
  const result = [];
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) {
      result.push(s);
      continue;
    }
    // 标准化比对（去标点空白）
    const norm = trimmed.replace(/[\s\u3000。，！？!?,.、~～…\-—「」『』""''()（）【】\[\]""'':：;；]/g, '').toLowerCase();
    if (norm.length >= 3 && seen.has(norm)) {
      console.log(`[ReplyPolicy] 删除重复句: "${trimmed.substring(0, 30)}..."`);
      continue;
    }
    if (norm.length >= 3) seen.add(norm);
    result.push(s);
  }
  return result.join('').replace(/\s{2,}/g, ' ').trim();
}

// ============================================================
// 主入口：sanitize
// ============================================================

/**
 * 后端硬规则修正（零 token 成本）
 *
 * 流程：
 *   1. 表情包冷却
 *   2. emoji/颜文字冷却
 *   3. 删除同一条回复内的重复句
 *   4. 满足间隔时低频补充一个情绪匹配的角色表情包
 *
 * @param {string} reply AI 原始回复
 * @param {Array} recentAssistants 最近 assistant 消息 [{content, role, time}, ...]
 * @param {object} options { characterId, appRoot }
 * @returns {string} 修正后的回复
 */
function sanitize(reply, recentAssistants = [], options = {}) {
  let result = stripModelControlTokens(reply);

  try {
    // 1. 时间戳硬清洗
    result = stripLeadingTimestamps(result);

    // 2. 表情包硬冷却
    if (options.characterId && options.appRoot) {
      result = enforceStickerCooldown(result, recentAssistants, options.characterId, options.appRoot);
    }

    // 3. emoji/颜文字硬冷却
    result = enforceEmojiCooldown(result, recentAssistants);

    // 4. 同条回复内重复句删除
    result = dedupSentences(result);

    // 5. 模型长期不主动使用时，按真实历史间隔低频补充角色表情包。
    if (options.characterId && options.appRoot && options.autoSticker !== false) {
      result = maybeAddSticker(result, recentAssistants, options.characterId, options.appRoot, options.stickerInterval || 8);
    }

    // 6. 清理多余空白
    result = result.replace(/\s{3,}/g, '\n').trim();
  } catch (e) {
    console.error('[ReplyPolicy] sanitize 异常:', e.message);
    return result;
  }

  return result;
}

module.exports = {
  sanitize,
  stripModelControlTokens,
  stripStickers,
  stripTone,
  stripLeadingTimestamps,
  stripEmoji,
  stripActionParens,
  normalizeForCompare,
  longestCommonRatio,
  classifyCoreIntents,
  hasRepeatedCoreIntent,
  hasRepeatedConversationalMove,
  isSimilarToRecent,
  isQuoteUsageAcceptable,
  maxSimilarityToRecent,
  pickNonRepeatingFallback,
  pickProactiveFallback,
  enforceStickerCooldown,
  maybeAddSticker,
  selectStickerForReply,
  enforceEmojiCooldown,
  dedupSentences,
};
