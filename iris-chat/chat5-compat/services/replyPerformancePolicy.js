// Reply performance metadata is the single semantic source for TTS, motion and face.
// The model may suggest metadata, but every field is normalized locally before use.

const VOICE_EMOTIONS = new Set([
  'gentle', 'comfort', 'sad', 'sad_question', 'question', 'strong', 'excited', 'shy_happy',
]);

const PERFORMANCE_EMOTIONS = new Set([
  'neutral', 'serious', 'happy', 'smile', 'excited', 'surprised', 'angry',
  'concerned', 'sad', 'shy', 'thinking', 'curious', 'gentle', 'grateful',
  'loving', 'delighted', 'shocked', 'furious', 'heartbroken', 'skeptical',
  'embarrassed', 'explaining', 'greeting', 'apologetic', 'confident', 'playful',
  'cute', 'exhausted', 'helpless', 'guilty', 'determined', 'pretend_angry',
]);

const INTENTS = new Set([
  'general', 'explaining', 'greeting', 'inviting', 'thinking', 'shy', 'concerned',
  'surprised', 'rejecting', 'gratitude', 'affirmative', 'questioning', 'reassuring',
  'apologizing', 'encouraging', 'playful', 'listening',
]);

const EMOTION_ALIASES = Object.freeze({
  smiley: 'smile', smiling: 'smile', cheerful: 'happy', joyful: 'happy',
  delight: 'delighted', astonished: 'shocked', stunned: 'shocked',
  enraged: 'furious', mad: 'angry', devastated: 'heartbroken',
  worried: 'concerned', worry: 'concerned', anxious: 'concerned',
  embarrassing: 'embarrassed', awkward: 'embarrassed',
  doubtful: 'skeptical', suspicious: 'skeptical',
  apology: 'apologetic', sorry: 'apologetic',
  determined: 'confident', resolute: 'confident', firm: 'confident',
  affectionate: 'loving', affection: 'loving', fond: 'loving',
  teasing: 'playful', mischievous: 'playful',
});

const INTENT_ALIASES = Object.freeze({
  explain: 'explaining', explanation: 'explaining',
  think: 'thinking', reflect: 'thinking', consider: 'thinking',
  worry: 'concerned', worried: 'concerned', concern: 'concerned',
  reassure: 'reassuring', comforting: 'reassuring', comfort: 'reassuring',
  ask: 'questioning', question: 'questioning', inquiry: 'questioning',
  invite: 'inviting', invitation: 'inviting', welcome: 'greeting', welcoming: 'greeting',
  thank: 'gratitude', thanks: 'gratitude', appreciate: 'gratitude',
  apologize: 'apologizing', apology: 'apologizing', sorry: 'apologizing',
  encourage: 'encouraging', cheer: 'encouraging', motivate: 'encouraging',
  agree: 'affirmative', agreement: 'affirmative', affirm: 'affirmative',
  reject: 'rejecting', disagree: 'rejecting', assert: 'rejecting', warn: 'rejecting',
  play: 'playful', tease: 'playful', teasing: 'playful',
  shy: 'shy', embarrassed: 'shy', listen: 'listening',
});

const VOICE_EMOTION_ALIASES = Object.freeze({
  warm: 'gentle', calm: 'gentle', soft: 'gentle',
  comforting: 'comfort', reassuring: 'comfort',
  sorrow: 'sad', melancholy: 'sad',
  'sad-question': 'sad_question', questioning: 'question', curious: 'question',
  firm: 'strong', assertive: 'strong',
  enthusiastic: 'excited', 'shy-happy': 'shy_happy', shy: 'shy_happy',
});

const EMPHASIS_TONES = new Set([
  '温柔', '坚定', '兴奋', '开心', '害羞', '疑惑', '俏皮', '悲伤', '生气',
]);

const VOICE_TO_PERFORMANCE = Object.freeze({
  gentle: { emotion: 'gentle', intent: 'general', gaze: 'user', intensity: 0.42 },
  comfort: { emotion: 'concerned', intent: 'reassuring', gaze: 'user', intensity: 0.48 },
  sad: { emotion: 'sad', intent: 'concerned', gaze: 'side-down', intensity: 0.5 },
  sad_question: { emotion: 'concerned', intent: 'questioning', gaze: 'side-down', intensity: 0.48 },
  question: { emotion: 'curious', intent: 'questioning', gaze: 'user', intensity: 0.46 },
  strong: { emotion: 'confident', intent: 'encouraging', gaze: 'user', intensity: 0.58 },
  excited: { emotion: 'excited', intent: 'affirmative', gaze: 'user', intensity: 0.66 },
  shy_happy: { emotion: 'shy', intent: 'shy', gaze: 'side-down', intensity: 0.52 },
});

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function trimText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeEmotion(value) {
  const normalized = normalizeLabel(value);
  return EMOTION_ALIASES[normalized] || (PERFORMANCE_EMOTIONS.has(normalized) ? normalized : '');
}

function normalizeIntent(value) {
  const normalized = normalizeLabel(value);
  return INTENTS.has(normalized) ? normalized : (INTENT_ALIASES[normalized] || normalized);
}

function normalizeVoiceEmotion(value) {
  const normalized = normalizeLabel(value);
  return VOICE_EMOTIONS.has(normalized) ? normalized : (VOICE_EMOTION_ALIASES[normalized] || '');
}

function fallbackFromText(replyText) {
  const text = String(replyText || '');
  // 角色的害羞经常只通过括号动作表达：耳尖/脸颊泛红、慌乱回避
  // 视线、局促地摩挲或绞手指。这些证据应优先于句末问号的 questioning。
  if (/(害羞|脸红|脸颊泛红|耳尖(?:微|泛)?红|红着脸|不好意思|难为情|羞涩|羞怯|局促|慌乱|不敢(?:直视|看)|移开视线|别开视线|视线飘开|手指[^。！？\n]{0,12}(?:摩挲|绞|捏|揉)|夸(?:我|我吗)|被夸|心跳)/.test(text)) {
    return { voiceEmotion: 'shy_happy', emotion: 'shy', intent: 'shy', gaze: 'side-down', intensity: 0.52 };
  }
  if (/(太震惊|完全不敢相信|难以置信|惊呆了|吓了一跳|目瞪口呆)/.test(text)) {
    return { voiceEmotion: 'excited', emotion: 'shocked', intent: 'surprised', gaze: 'user', intensity: 0.86 };
  }
  if (/(气死我了|绝对不能原谅|不可原谅|怒不可遏|火冒三丈|暴怒)/.test(text)) {
    return { voiceEmotion: 'strong', emotion: 'furious', intent: 'rejecting', gaze: 'user', intensity: 0.86 };
  }
  if (/(好委屈|心都要碎|心碎|委屈极了|痛彻心扉|忍不住想哭)/.test(text)) {
    return { voiceEmotion: 'sad', emotion: 'heartbroken', intent: 'concerned', gaze: 'side-down', intensity: 0.68 };
  }
  if (/(太尴尬|尴尬死了|说错话|窘迫|无地自容|社死)/.test(text)) {
    return { voiceEmotion: 'shy_happy', emotion: 'embarrassed', intent: 'shy', gaze: 'side-down', intensity: 0.58 };
  }
  if (/(表示怀疑|我很怀疑|不太可信|你确定|靠谱吗|可疑|难道真的是)/.test(text)) {
    return { voiceEmotion: 'question', emotion: 'skeptical', intent: 'questioning', gaze: 'side-down', intensity: 0.56 };
  }
  if (/(对不起|抱歉|请原谅|是我的错|我很惭愧)/.test(text)) {
    return { voiceEmotion: 'comfort', emotion: 'apologetic', intent: 'apologizing', gaze: 'side-down', intensity: 0.48 };
  }
  if (/(交给我|我能做到|我确定|一定可以|我会做到|不会放弃|由我来|放心交给我)/.test(text)) {
    return { voiceEmotion: 'strong', emotion: 'confident', intent: 'encouraging', gaze: 'user', intensity: 0.66 };
  }
  if (/(太兴奋|很兴奋|激动|雀跃|迫不及待)/.test(text)) {
    return { voiceEmotion: 'excited', emotion: 'excited', intent: 'affirmative', gaze: 'user', intensity: 0.78 };
  }
  if (/(太棒了|开心得不得了|高兴得不得了|笑死我了|乐坏了|欣喜若狂|开怀大笑|喜出望外)/.test(text)) {
    return { voiceEmotion: 'excited', emotion: 'delighted', intent: 'affirmative', gaze: 'user', intensity: 0.82 };
  }
  if (/(居然|竟然|没想到|惊讶|震惊|天啊|一怔|怔住|愣住|睁大眼|瞪大眼|倒吸一口气|诧异)/.test(text)) {
    return { voiceEmotion: 'question', emotion: 'surprised', intent: 'surprised', gaze: 'user', intensity: 0.65 };
  }
  if (/(生气|愤怒|不能接受|太过分|咬牙|攥紧|握紧拳|怒视|冷声|不悦|恼火|眉头紧皱)/.test(text)) {
    return { voiceEmotion: 'strong', emotion: 'angry', intent: 'rejecting', gaze: 'user', intensity: 0.58 };
  }
  if (/(失落|低落|难过|伤心|悲伤|哀伤|痛苦|孤独|寂寞|眼神黯淡|声音低落|泪光|眼眶泛红|沉默了|轻声叹气)/.test(text)) {
    const question = /[？?]/.test(text);
    return {
      voiceEmotion: question ? 'sad_question' : 'sad',
      emotion: 'sad',
      intent: 'concerned',
      gaze: 'side-down',
      intensity: 0.48,
    };
  }
  if (/(担心|忧虑|不安|抱歉|对不起|遗憾|担忧|不忍|眉头微蹙|轻轻蹙眉|小心翼翼)/.test(text)) {
    return { voiceEmotion: 'comfort', emotion: 'concerned', intent: 'concerned', gaze: 'side-down', intensity: 0.48 };
  }
  if (/(别怕|别担心|放心|安心|我在|陪着你|慢慢来|交给我)/.test(text)) {
    return { voiceEmotion: 'comfort', emotion: 'concerned', intent: 'reassuring', gaze: 'user', intensity: 0.48 };
  }
  if (/(谢谢|感谢|多谢|感激|感恩|辛苦|麻烦)/.test(text)) {
    return { voiceEmotion: 'gentle', emotion: 'grateful', intent: 'gratitude', gaze: 'user', intensity: 0.55 };
  }
  if (/(坏笑|狡黠|调皮|打趣|逗你|逗我|故意捉弄|吐舌|眨眨眼|俏皮)/.test(text)) {
    return { voiceEmotion: 'gentle', emotion: 'playful', intent: 'playful', gaze: 'user', intensity: 0.62 };
  }
  if (/(好奇|疑惑|困惑|不解|歪着头|歪头|眨眼|怎么会|为何|为什么)/.test(text)) {
    return { voiceEmotion: 'question', emotion: 'curious', intent: 'questioning', gaze: 'user', intensity: 0.5 };
  }
  if (/(喜欢|爱你|爱着|想你|思念|心动|眷恋|温暖|幸福|美好|柔声)/.test(text)) {
    return { voiceEmotion: 'gentle', emotion: 'loving', intent: /[？?]/.test(text) ? 'questioning' : 'explaining', gaze: 'user', intensity: 0.55 };
  }
  if (/(开心|快乐|高兴|笑意|嘴角上扬|眉眼弯弯|灿烂地笑)/.test(text)) {
    return { voiceEmotion: 'shy_happy', emotion: 'happy', intent: 'affirmative', gaze: 'user', intensity: 0.56 };
  }
  if (/(一定|必须|请相信|不会放弃|我会做到|守护|承诺)/.test(text)) {
    return { voiceEmotion: 'strong', emotion: 'confident', intent: 'encouraging', gaze: 'user', intensity: 0.56 };
  }
  if (/(太棒|成功了|终于|惊喜)/.test(text)) {
    return { voiceEmotion: 'excited', emotion: 'delighted', intent: 'affirmative', gaze: 'user', intensity: 0.68 };
  }
  if (/[？?]/.test(text)) {
    return { voiceEmotion: 'question', emotion: 'curious', intent: 'questioning', gaze: 'user', intensity: 0.46 };
  }
  return { ...VOICE_TO_PERFORMANCE.gentle, voiceEmotion: 'gentle' };
}

function normalizeEmphasis(value, replyText) {
  if (!Array.isArray(value)) return [];
  const source = String(replyText || '');
  const accepted = [];
  const occupied = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const text = trimText(item.text, 18);
    const tone = trimText(item.tone, 8);
    const strength = clamp(item.strength, 0, 1, 0.45);
    if (text.length < 2 || !EMPHASIS_TONES.has(tone) || strength < 0.3) continue;
    const start = source.indexOf(text);
    if (start < 0) continue;
    const end = start + text.length;
    if (occupied.some(range => start < range.end && end > range.start)) continue;
    occupied.push({ start, end });
    accepted.push({ text, tone, strength: Math.round(strength * 100) / 100 });
    if (accepted.length >= 2) break;
  }
  return accepted;
}

function normalizePerformanceSegments(value, replyText, parent = {}) {
  if (!Array.isArray(value)) return [];
  const sourceText = String(replyText || '');
  const accepted = [];
  let searchFrom = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const text = String(item.text || '').trim().slice(0, 160);
    if (text.length < 2) continue;
    const start = sourceText.indexOf(text, searchFrom);
    if (start < 0) continue;
    const normalized = normalizeReplyPerformance({
      ...item,
      segments: undefined,
      evidence: item.evidence || parent.evidence || `回复在“${text.slice(0, 24)}”处发生语气转折`,
      inference: item.inference || parent.inference || 'implicit',
      confidence: Math.min(
        clamp(item.confidence, 0, 1, clamp(parent.confidence, 0, 1, 0.55)),
        clamp(parent.confidence, 0, 1, 0.72),
      ),
    }, text);
    accepted.push({
      text,
      voiceEmotion: normalized.voiceEmotion,
      emotion: normalized.emotion,
      intent: normalized.intent,
      intensity: normalized.intensity,
      gaze: normalized.gaze,
      confidence: normalized.confidence,
    });
    searchFrom = start + text.length;
    if (accepted.length >= 3) break;
  }
  if (accepted.length < 2) return [];
  const hasTurn = accepted.some((segment, index) => index > 0 && (
    segment.voiceEmotion !== accepted[index - 1].voiceEmotion
      || segment.emotion !== accepted[index - 1].emotion
      || segment.intent !== accepted[index - 1].intent
  ));
  return hasTurn ? accepted : [];
}

function extractReplyPerformance(reply) {
  let cleanReply = String(reply || '');
  let raw = null;
  const htmlPattern = /<!--\s*(?:emotion|performance)\s*:\s*([\s\S]*?)-->/ig;
  let match;
  while ((match = htmlPattern.exec(cleanReply)) !== null) {
    if (!raw) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
      } catch (error) {}
    }
  }
  cleanReply = cleanReply.replace(htmlPattern, ' ');

  const legacyPattern = /\[EMOTION\]([\s\S]*?)\[\/EMOTION\]/ig;
  if (!raw) {
    const legacyMatch = legacyPattern.exec(cleanReply);
    if (legacyMatch) {
      try {
        const parsed = JSON.parse(legacyMatch[1].trim());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
      } catch (error) {}
    }
  }
  cleanReply = cleanReply.replace(legacyPattern, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  return { cleanReply, raw };
}

function normalizeReplyPerformance(raw, replyText) {
  const fallback = fallbackFromText(replyText);
  const source = raw && typeof raw === 'object' ? raw : {};
  const inference = ['explicit', 'implicit', 'none'].includes(source.inference)
    ? source.inference
    : (trimText(source.evidence, 160) ? 'implicit' : 'none');
  const evidence = trimText(source.evidence || source.trigger, 160);
  let confidence = clamp(source.confidence, 0, 1, inference === 'none' ? 0.3 : 0.55);
  if (inference === 'implicit') confidence = Math.min(confidence, 0.72);
  if (inference === 'none' || !evidence) confidence = Math.min(confidence, 0.4);

  const requestedVoice = normalizeVoiceEmotion(trimText(source.voice_emotion || source.voiceEmotion, 24));
  const requestedEmotion = normalizeEmotion(trimText(source.performance_emotion || source.performanceEmotion || source.emotion, 24));
  const requestedIntent = normalizeIntent(trimText(source.intent, 24));
  const requestedGaze = trimText(source.gaze, 24).toLowerCase();
  const useModelSignal = confidence >= 0.45;
  // A model may label a line containing a shy stage direction as a normal
  // question because it notices the question mark first. Treat that signal
  // as weak when the text contains strong shy evidence, while preserving an
  // explicit non-weak emotion such as anger or sadness.
  const strongTextEmotions = new Set([
    'shy', 'surprised', 'angry', 'sad', 'concerned',
    'grateful', 'loving', 'playful', 'happy', 'delighted', 'shocked',
    'furious', 'heartbroken', 'skeptical', 'embarrassed', 'apologetic',
    'confident', 'excited'
  ]);
  const weakModelLabel = !requestedVoice
    || ['gentle', 'question', 'comfort'].includes(requestedVoice)
    || !requestedEmotion
    || ['curious', 'serious', 'gentle', 'explaining'].includes(requestedEmotion)
    || !requestedIntent
    || ['general', 'explaining', 'questioning', 'listening'].includes(requestedIntent);
  const preferTextCue = strongTextEmotions.has(fallback.emotion) && weakModelLabel;
  const voiceEmotion = preferTextCue
    ? fallback.voiceEmotion
    : (useModelSignal && VOICE_EMOTIONS.has(requestedVoice)
    ? requestedVoice
    : fallback.voiceEmotion);
  const voiceProfile = VOICE_TO_PERFORMANCE[voiceEmotion] || fallback;
  const emotion = preferTextCue
    ? fallback.emotion
    : (useModelSignal && PERFORMANCE_EMOTIONS.has(requestedEmotion)
    ? requestedEmotion
    : (useModelSignal ? voiceProfile.emotion : fallback.emotion));
  const intent = preferTextCue
    ? fallback.intent
    : (useModelSignal && INTENTS.has(requestedIntent)
    ? requestedIntent
    : (useModelSignal ? voiceProfile.intent : fallback.intent));
  const gaze = preferTextCue
    ? fallback.gaze
    : (useModelSignal && (requestedGaze === 'user' || requestedGaze === 'side-down')
      ? requestedGaze
      : (['sad', 'shy', 'thinking', 'concerned', 'embarrassed', 'heartbroken'].includes(emotion)
        ? 'side-down'
        : voiceProfile.gaze || fallback.gaze));
  const characterIntensity = clamp(
    source.character_intensity ?? source.characterIntensity,
    1,
    5,
    Math.round((voiceProfile.intensity || fallback.intensity) * 5),
  );
  const intensity = useModelSignal
    ? clamp(source.intensity, 0, 1, Math.min(0.82, Math.max(0.25, characterIntensity / 5)))
    : fallback.intensity;

  const normalized = {
    userEmotion: trimText(source.user_emotion || source.userEmotion || (inference === 'none' ? '平静' : ''), 24),
    userIntensity: clamp(source.user_intensity ?? source.userIntensity, 1, 5, 1),
    userConfidence: clamp(source.user_confidence ?? source.userConfidence, 0, 1, confidence),
    characterEmotion: trimText(source.character_emotion || source.characterEmotion, 40),
    characterIntensity,
    voiceEmotion,
    emotion,
    intent,
    intensity: Math.round(intensity * 100) / 100,
    gaze,
    confidence: Math.round(confidence * 100) / 100,
    inference,
    evidence,
    emphasis: useModelSignal ? normalizeEmphasis(source.emphasis, replyText) : [],
    source: raw ? 'model' : 'fallback',
  };
  const segments = useModelSignal
    ? normalizePerformanceSegments(source.segments, replyText, {
      confidence,
      evidence,
      inference,
    })
    : [];
  return segments.length > 0 ? { ...normalized, segments } : normalized;
}

function applyEmphasisTags(text, emphasis) {
  const source = String(text || '');
  const accepted = normalizeEmphasis(emphasis, source)
    .map(item => ({ ...item, start: source.indexOf(item.text) }))
    .filter(item => item.start >= 0)
    .sort((a, b) => b.start - a.start);
  let result = source;
  for (const item of accepted) {
    const end = item.start + item.text.length;
    result = `${result.slice(0, item.start)}[语气:${item.tone}]${result.slice(item.start, end)}[/语气]${result.slice(end)}`;
  }
  return result;
}

const VOICE_TO_TONE = Object.freeze({
  gentle: '温柔',
  comfort: '温柔',
  sad: '悲伤',
  sad_question: '悲伤',
  question: '疑惑',
  strong: '坚定',
  excited: '兴奋',
  shy_happy: '害羞',
});

function applyPerformanceSegmentTags(text, segments) {
  const source = String(text || '');
  const accepted = normalizePerformanceSegments(segments, source, {
    confidence: 1,
    evidence: 'validated reply segment',
    inference: 'explicit',
  }).map(item => ({ ...item, start: source.indexOf(item.text) }))
    .filter(item => item.start >= 0)
    .sort((a, b) => b.start - a.start);
  // 转折连接词本身不承载完整情绪。除非模型明确给出高置信度的表演
  // 指令，否则只使用温和过渡，避免“但是/不过/只是”突然变得过度用力。
  const transitionLead = /^(?:但是|不过|只是|然而|可是|却|其实|原来|所以|因此|反而|话虽如此|即便如此)/;
  let result = source;
  for (const item of accepted) {
    const isTransition = transitionLead.test(item.text.trim());
    const tone = isTransition && Number(item.confidence || 0) < 0.85
      ? '温柔'
      : (VOICE_TO_TONE[item.voiceEmotion] || '温柔');
    const end = item.start + item.text.length;
    result = `${result.slice(0, item.start)}[语气:${tone}]${result.slice(item.start, end)}[/语气]${result.slice(end)}`;
  }
  return result;
}

module.exports = {
  VOICE_EMOTIONS,
  PERFORMANCE_EMOTIONS,
  INTENTS,
  EMPHASIS_TONES,
  extractReplyPerformance,
  normalizeReplyPerformance,
  normalizeEmphasis,
  normalizePerformanceSegments,
  applyEmphasisTags,
  applyPerformanceSegmentTags,
};
