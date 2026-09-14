import type { Emotion } from '../actor/actor-runtime';

export interface PerformanceSemantic {
  readonly emotion: Emotion;
  readonly intent: string;
  readonly intensity: number;
  readonly gaze: 'user' | 'side-down';
  /** Validated root signal selected by the chat model for the same reply. */
  readonly voiceEmotion?: VoiceEmotion;
  readonly confidence?: number;
  readonly evidence?: string;
  readonly emphasis?: readonly ReplyEmphasis[];
  readonly segments?: readonly PerformanceSegment[];
  readonly source?: 'model' | 'fallback';
}

export type VoiceEmotion =
  | 'gentle' | 'comfort' | 'sad' | 'sad_question'
  | 'question' | 'strong' | 'excited' | 'shy_happy';

export interface ReplyEmphasis {
  readonly text: string;
  readonly tone: '温柔' | '坚定' | '兴奋' | '开心' | '害羞' | '疑惑' | '俏皮' | '悲伤' | '生气';
  readonly strength: number;
}

export interface PerformanceSegment {
  readonly text: string;
  readonly voiceEmotion: VoiceEmotion;
  readonly emotion: Emotion;
  readonly intent: string;
  readonly intensity: number;
  readonly gaze: 'user' | 'side-down';
  readonly confidence: number;
}

interface TtsEmotionProfile {
  readonly emotion: Emotion;
  readonly intensity: number;
  readonly gaze: PerformanceSemantic['gaze'];
}

const TTS_EMOTION_PROFILES: Readonly<Record<string, TtsEmotionProfile>> = {
  gentle: { emotion: 'serious', intensity: 0.4, gaze: 'user' },
  comfort: { emotion: 'concerned', intensity: 0.45, gaze: 'user' },
  sad: { emotion: 'concerned', intensity: 0.5, gaze: 'side-down' },
  sad_question: { emotion: 'concerned', intensity: 0.5, gaze: 'side-down' },
  question: { emotion: 'serious', intensity: 0.5, gaze: 'user' },
  happy: { emotion: 'happy', intensity: 0.65, gaze: 'user' },
  excited: { emotion: 'happy', intensity: 0.75, gaze: 'user' },
  angry: { emotion: 'angry', intensity: 0.65, gaze: 'user' },
  surprised: { emotion: 'surprised', intensity: 0.7, gaze: 'user' },
  strong: { emotion: 'confident', intensity: 0.62, gaze: 'user' },
  shy: { emotion: 'shy', intensity: 0.55, gaze: 'side-down' },
  shy_happy: { emotion: 'shy', intensity: 0.55, gaze: 'side-down' },
  serious: { emotion: 'serious', intensity: 0.6, gaze: 'user' }
};

const KNOWN_EMOTIONS = new Set<Emotion>([
  'neutral', 'serious', 'happy', 'smile', 'excited', 'surprised', 'angry',
  'concerned', 'sad', 'shy', 'thinking', 'curious', 'gentle', 'grateful',
  'loving', 'delighted', 'shocked', 'furious', 'heartbroken', 'skeptical',
  'embarrassed', 'explaining', 'greeting', 'apologetic', 'confident', 'playful'
]);

const KNOWN_VOICE_EMOTIONS = new Set<VoiceEmotion>([
  'gentle', 'comfort', 'sad', 'sad_question', 'question', 'strong', 'excited', 'shy_happy'
]);

const KNOWN_EMPHASIS_TONES = new Set<ReplyEmphasis['tone']>([
  '温柔', '坚定', '兴奋', '开心', '害羞', '疑惑', '俏皮', '悲伤', '生气'
]);

const SIDE_DOWN_EMOTIONS = new Set<Emotion>([
  'shy', 'thinking', 'concerned', 'sad', 'embarrassed', 'heartbroken', 'skeptical'
]);

// These emotions have recognizable textual or stage-direction evidence. They
// may safely override a weak generic/question label supplied by a model.
const STRONG_TEXT_EMOTIONS = new Set<Emotion>([
  'shy', 'surprised', 'angry', 'sad', 'concerned',
  'grateful', 'loving', 'playful', 'happy', 'delighted', 'shocked',
  'furious', 'heartbroken', 'skeptical', 'embarrassed', 'apologetic',
  'confident', 'excited'
]);

const EMOTION_ALIASES: Readonly<Record<string, Emotion>> = {
  smiley: 'smile', smiling: 'smile', cheerful: 'happy', joyful: 'happy',
  delighted: 'delighted', delight: 'delighted',
  shocked: 'shocked', astonished: 'shocked', stunned: 'shocked',
  furious: 'furious', enraged: 'furious', angry: 'angry', mad: 'angry',
  heartbroken: 'heartbroken', devastated: 'heartbroken',
  worried: 'concerned', worry: 'concerned', anxious: 'concerned',
  embarrassed: 'embarrassed', embarrassing: 'embarrassed', awkward: 'embarrassed',
  skeptical: 'skeptical', doubtful: 'skeptical', suspicious: 'skeptical',
  apologetic: 'apologetic', apology: 'apologetic', sorry: 'apologetic',
  determined: 'confident', resolute: 'confident', firm: 'confident',
  affectionate: 'loving', affection: 'loving', fond: 'loving',
  playful: 'playful', teasing: 'playful', mischievous: 'playful'
};

const INTENT_ALIASES: Readonly<Record<string, string>> = {
  explain: 'explaining', explanation: 'explaining',
  think: 'thinking', reflect: 'thinking', consider: 'thinking',
  worry: 'concerned', worried: 'concerned', concern: 'concerned',
  ask: 'questioning', question: 'questioning', inquiry: 'questioning',
  invite: 'inviting', invitation: 'inviting', welcome: 'greeting', welcoming: 'greeting',
  thank: 'gratitude', thanks: 'gratitude', appreciate: 'gratitude',
  apologize: 'apologizing', apology: 'apologizing', sorry: 'apologizing',
  reassure: 'reassuring', comforting: 'reassuring', comfort: 'reassuring',
  encourage: 'encouraging', cheer: 'encouraging', motivate: 'encouraging',
  agree: 'affirmative', agreement: 'affirmative', affirm: 'affirmative',
  reject: 'rejecting', disagree: 'rejecting', assert: 'rejecting', warn: 'rejecting',
  play: 'playful', tease: 'playful', teasing: 'playful',
  shy: 'shy', embarrassed: 'shy',
  listen: 'listening', listening: 'listening'
};

const VOICE_EMOTION_ALIASES: Readonly<Record<string, VoiceEmotion>> = {
  gentle: 'gentle', warm: 'gentle', calm: 'gentle', soft: 'gentle',
  comfort: 'comfort', comforting: 'comfort', reassuring: 'comfort',
  sad: 'sad', sorrow: 'sad', melancholy: 'sad',
  sad_question: 'sad_question', 'sad-question': 'sad_question',
  question: 'question', questioning: 'question', curious: 'question',
  strong: 'strong', firm: 'strong', assertive: 'strong',
  excited: 'excited', enthusiastic: 'excited',
  shy_happy: 'shy_happy', 'shy-happy': 'shy_happy', shy: 'shy_happy'
};

function normalizeLabel(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeEmotion(value: unknown): Emotion | undefined {
  const normalized = normalizeLabel(value);
  if (KNOWN_EMOTIONS.has(normalized as Emotion)) return normalized as Emotion;
  return EMOTION_ALIASES[normalized];
}

function normalizeIntent(value: unknown): string {
  const normalized = normalizeLabel(value);
  return INTENT_ALIASES[normalized] ?? normalized;
}

function normalizeVoiceEmotion(value: unknown): VoiceEmotion | undefined {
  const normalized = normalizeLabel(value);
  if (KNOWN_VOICE_EMOTIONS.has(normalized as VoiceEmotion)) return normalized as VoiceEmotion;
  return VOICE_EMOTION_ALIASES[normalized];
}

function deriveFromText(rawText: string): PerformanceSemantic {
  const text = String(rawText ?? '').toLowerCase();
  if (/(你好|hello|hi|嗨|早上好|晚上好|下午好)/.test(text)) {
    return { emotion: 'happy', intent: 'greeting', intensity: 0.65, gaze: 'user' };
  }
  if (/(欢迎|welcome|请进|来吧|进来|这边|过来|邀请)/.test(text)) {
    return { emotion: 'happy', intent: 'inviting', intensity: 0.65, gaze: 'user' };
  }
  // 先识别可驱动动作的语义意图，再识别“害羞/担心”等表情词。
  // 同一句可能同时包含两者，例如“让我想一想……这样说有点害羞”；
  // 情绪由 TTS profile 决定，动作应保留 thinking intent。
  if (/(让我想想|让我想一想|思考|想一想|想一下|考虑)/.test(text)) {
    return {
      emotion: /(认真|必须|重要|注意)/.test(text) ? 'serious' : 'thinking',
      intent: 'thinking', intensity: 0.55, gaze: 'side-down'
    };
  }
  if (/(太震惊|完全不敢相信|难以置信|惊呆了|吓了一跳|目瞪口呆)/.test(text)) {
    return { emotion: 'shocked', intent: 'surprised', intensity: 0.86, gaze: 'user' };
  }
  if (/(气死我了|绝对不能原谅|不可原谅|怒不可遏|火冒三丈|暴怒)/.test(text)) {
    return { emotion: 'furious', intent: 'rejecting', intensity: 0.86, gaze: 'user' };
  }
  if (/(好委屈|心都要碎|心碎|委屈极了|痛彻心扉|忍不住想哭)/.test(text)) {
    return { emotion: 'heartbroken', intent: 'concerned', intensity: 0.68, gaze: 'side-down' };
  }
  if (/(太尴尬|尴尬死了|说错话|窘迫|无地自容|社死)/.test(text)) {
    return { emotion: 'embarrassed', intent: 'shy', intensity: 0.58, gaze: 'side-down' };
  }
  if (/(表示怀疑|我很怀疑|不太可信|你确定|靠谱吗|可疑|难道真的是)/.test(text)) {
    return { emotion: 'skeptical', intent: 'questioning', intensity: 0.56, gaze: 'side-down' };
  }
  if (/(对不起|抱歉|请原谅|是我的错|我很惭愧)/.test(text)) {
    return { emotion: 'apologetic', intent: 'apologizing', intensity: 0.48, gaze: 'side-down' };
  }
  if (/(交给我|我能做到|我确定|一定可以|我会做到|不会放弃|由我来|放心交给我)/.test(text)) {
    return { emotion: 'confident', intent: 'encouraging', intensity: 0.66, gaze: 'user' };
  }
  if (/(太兴奋|很兴奋|激动|雀跃|迫不及待)/.test(text)) {
    return { emotion: 'excited', intent: 'affirmative', intensity: 0.78, gaze: 'user' };
  }
  if (/(太棒了|开心得不得了|高兴得不得了|笑死我了|乐坏了|欣喜若狂|开怀大笑|喜出望外)/.test(text)) {
    return { emotion: 'delighted', intent: 'affirmative', intensity: 0.82, gaze: 'user' };
  }
  // 角色台词经常用括号里的舞台动作表达害羞，而不是直接写“害羞”。
  // 这些是比问号更强的角色情绪证据：耳尖/脸颊泛红、局促慌乱、
  // 回避视线，以及不自觉摩挲/绞手指等小动作都应进入 shy 通道。
  if (/(害羞|不好意思|脸红|脸颊泛红|耳尖(?:微|泛)?红|红着脸|羞涩|羞怯|难为情|局促|慌乱|不敢(?:直视|看)|移开视线|别开视线|视线飘开|手指[^。！？\n]{0,12}(?:摩挲|绞|捏|揉)|夸(?:我|我吗)|被夸)/.test(text)) {
    return { emotion: 'shy', intent: 'shy', intensity: 0.55, gaze: 'side-down' };
  }
  if (/(居然|竟然|没想到|惊讶|震惊|天啊|一怔|怔住|愣住|睁大眼|瞪大眼|倒吸一口气|诧异)/.test(text)) {
    return { emotion: 'surprised', intent: 'surprised', intensity: 0.7, gaze: 'user' };
  }
  if (/(生气|愤怒|不能接受|太过分|咬牙|攥紧|握紧拳|怒视|冷声|不悦|恼火|眉头紧皱)/.test(text)) {
    return { emotion: 'angry', intent: 'rejecting', intensity: 0.65, gaze: 'user' };
  }
  if (/(失落|低落|难过|伤心|孤独|寂寞|眼神黯淡|声音低落|泪光|眼眶泛红|沉默了|轻声叹气)/.test(text)) {
    return { emotion: 'sad', intent: 'concerned', intensity: 0.5, gaze: 'side-down' };
  }
  if (/(担心|忧虑|不安|抱歉|对不起|遗憾|担忧|不忍|眉头微蹙|轻轻蹙眉|小心翼翼)/.test(text)) {
    return { emotion: 'concerned', intent: 'concerned', intensity: 0.6, gaze: 'side-down' };
  }
  if (/(谢谢|感谢|多谢|感激|感恩|辛苦|麻烦)/.test(text)) {
    return { emotion: 'grateful', intent: 'gratitude', intensity: 0.55, gaze: 'user' };
  }
  if (/(坏笑|狡黠|调皮|打趣|逗你|逗我|故意捉弄|吐舌|眨眨眼|俏皮)/.test(text)) {
    return { emotion: 'playful', intent: 'playful', intensity: 0.65, gaze: 'user' };
  }
  if (/(好奇|疑惑|困惑|不解|歪着头|歪头|眨眼|怎么会|为何|为什么)/.test(text)) {
    return { emotion: 'curious', intent: 'questioning', intensity: 0.55, gaze: 'user' };
  }
  if (/(喜欢|爱你|爱着|想你|思念|心动|眷恋|温暖|幸福|美好|柔声)/.test(text)) {
    return { emotion: 'loving', intent: /[？?]/.test(text) ? 'questioning' : 'explaining', intensity: 0.6, gaze: 'user' };
  }
  if (/(开心|快乐|高兴|笑意|嘴角上扬|眉眼弯弯|灿烂地笑|太棒|成功了|终于)/.test(text)) {
    return { emotion: 'happy', intent: 'affirmative', intensity: 0.65, gaze: 'user' };
  }
  // A caring invitation remains gentle even when it contains a question.
  // The question changes local gaze/prosody, not the whole reply's body family.
  if (/(不妨|轻柔|舒缓|安眠|休息|疲惫|陪你|陪着你|陪伴你|放心|别害怕|不用怕|慢慢来|没关系|会在|愿.{0,8}(?:你|为你)|为你.{0,8}(?:弹奏|奏|唱))/.test(text)) {
    return { emotion: 'gentle', intent: 'explaining', intensity: 0.45, gaze: 'user' };
  }
  if (/(认真|必须|说明|重要|注意)/.test(text)) {
    return { emotion: 'serious', intent: 'explaining', intensity: 0.6, gaze: 'user' };
  }
  if (/(是的|对的|嗯|好的|没问题|可以)/.test(text)) {
    return { emotion: 'happy', intent: 'affirmative', intensity: 0.5, gaze: 'user' };
  }
  if (/[？?]/.test(text)) {
    return { emotion: 'curious', intent: 'questioning', intensity: 0.5, gaze: 'user' };
  }
  // 喜欢/温暖
  if (/(喜欢|爱|可爱|温柔|温暖|美好|幸福|开心|快乐)/.test(text)) {
    return { emotion: 'loving', intent: 'explaining', intensity: 0.6, gaze: 'user' };
  }
  return { emotion: 'serious', intent: 'explaining', intensity: 0.5, gaze: 'user' };
}

/**
 * TTS 情绪权重分配策略：
 *
 * 情绪分配时机：文本分析（deriveFromText）在 TTS 之前完成，TTS 情绪在合成后返回。
 * 两者结合确定最终语义：
 *
 * - TTS 返回明确的非默认情绪（sad/excited/shy/angry/comfort）→ 以 TTS 为准，
 *   因为这些是关键词匹配到的强信号，代表语音语气确实变了。
 * - TTS 返回 "gentle"（默认值，大多数回复）→ 保留文本分析的 emotion，
 *   因为 "gentle" 只是"没匹配到任何关键词"的兜底，不代表真的只有一种情绪。
 *   这样可以避免 80% 回复都收敛到同一个 gestureFamily="serious"。
 * - TTS 返回 "question" → 结合文本意图，如果文本已有明确意图则保留文本 emotion。
 *
 * 权重分配方式：不是返回加权分布，而是通过保留文本多样性 + intent 驱动 VMD 选择，
 * 让不同文本内容自然匹配到不同动作，避免重复。
 */
export function derivePerformanceSemantic(rawText: string, ttsEmotion?: string): PerformanceSemantic {
  const textSemantic = deriveFromText(rawText);
  const ttsKey = String(ttsEmotion ?? '').trim().toLowerCase();
  const ttsProfile = TTS_EMOTION_PROFILES[ttsKey];
  if (!ttsProfile) {
    return textSemantic;
  }

  // TTS 默认情绪 "gentle" 和 "question" 不覆盖文本多样性
  // 因为 "gentle" 是兜底值（70%+ 回复），"question" 只是问号检测
  const isWeakTtsEmotion = ttsKey === 'gentle' || ttsKey === 'question';
  // "comfort" 也偏弱（关键词"陪/没事"等容易误匹配），但保留作为中等信号
  const isMediumTtsEmotion = ttsKey === 'comfort';

  if (isWeakTtsEmotion) {
    // 弱 TTS 信号：保留文本分析的 emotion，只用 TTS 调整 intensity 和 gaze
    return {
      emotion: textSemantic.emotion,
      intent: textSemantic.intent,
      intensity: ttsProfile.intensity,
      gaze: textSemantic.gaze
    };
  }

  void isMediumTtsEmotion;

  // 强 TTS 信号（sad/sad_question/excited/angry/shy/happy/surprised）：以 TTS 为准
  return {
    emotion: ttsProfile.emotion,
    intent: textSemantic.intent,
    intensity: ttsProfile.intensity,
    gaze: textSemantic.intent === 'explaining' ? ttsProfile.gaze : textSemantic.gaze
  };
}

/**
 * Normalize semantic metadata already authorized for the same task/WAV.
 * Valid provided fields are authoritative; only missing or invalid fields are
 * filled from the canonical text classifier.
 */
export function resolvePlaybackSemantic(
  rawText: string,
  provided?: Partial<PerformanceSemantic>
): PerformanceSemantic {
  const fallback = deriveFromText(rawText);
  const providedEmotion = normalizeEmotion(provided?.emotion);
  const providedIntent = normalizeIntent(provided?.intent);
  // A weak model label such as “curious/questioning” must not erase strong
  // implicit emotion evidence already found in the actual reply text. This
  // is especially important for stage directions like “耳尖微红、慌乱地移开视线”.
  const providedVoiceEmotion = normalizeVoiceEmotion(provided?.voiceEmotion);
  const weakProvidedLabel = !providedEmotion
    || ['curious', 'serious', 'gentle', 'explaining'].includes(providedEmotion)
    || (providedVoiceEmotion === 'gentle'
      || providedVoiceEmotion === 'question'
      || providedVoiceEmotion === 'comfort')
    || !providedIntent
    || ['general', 'explaining', 'questioning', 'listening'].includes(providedIntent);
  const preferTextCue = STRONG_TEXT_EMOTIONS.has(fallback.emotion) && weakProvidedLabel;
  const emotion = preferTextCue ? fallback.emotion : (providedEmotion ?? fallback.emotion);
  const intent = preferTextCue ? fallback.intent : (providedIntent || fallback.intent);
  const rawIntensity = typeof provided?.intensity === 'number' && Number.isFinite(provided.intensity)
    ? provided.intensity
    : fallback.intensity;
  const intensity = Math.min(1, Math.max(0, rawIntensity));
  const providedGaze = provided?.gaze === 'user' || provided?.gaze === 'side-down'
    ? provided.gaze
    : undefined;
  const gaze = preferTextCue
    ? fallback.gaze
    : (providedGaze
      ?? (SIDE_DOWN_EMOTIONS.has(emotion) || intent === 'thinking' || intent === 'concerned'
        ? 'side-down'
        : fallback.gaze));

  const voiceEmotion = providedVoiceEmotion;
  const rawConfidence = typeof provided?.confidence === 'number' && Number.isFinite(provided.confidence)
    ? provided.confidence
    : undefined;
  const confidence = rawConfidence === undefined ? undefined : Math.min(1, Math.max(0, rawConfidence));
  const evidence = typeof provided?.evidence === 'string'
    ? provided.evidence.replace(/\s+/g, ' ').trim().slice(0, 160)
    : undefined;
  const emphasis = Array.isArray(provided?.emphasis)
    ? provided!.emphasis.filter((item): item is ReplyEmphasis => {
      if (!item || typeof item !== 'object') return false;
      const phrase = String(item.text || '').trim();
      return phrase.length >= 2
        && phrase.length <= 18
        && rawText.includes(phrase)
        && KNOWN_EMPHASIS_TONES.has(item.tone)
        && Number.isFinite(item.strength)
        && item.strength >= 0.3
        && item.strength <= 1;
    }).slice(0, 2)
    : undefined;
  const segments = Array.isArray(provided?.segments)
    ? provided!.segments.flatMap((segment): PerformanceSegment[] => {
      if (!segment || typeof segment !== 'object') return [];
      const phrase = String(segment.text || '').trim();
      const segmentVoice = normalizeVoiceEmotion(segment.voiceEmotion);
      const segmentEmotion = normalizeEmotion(segment.emotion);
      const segmentIntent = normalizeIntent(segment.intent);
      if (phrase.length < 2 || phrase.length > 160 || !rawText.includes(phrase)
        || !segmentVoice || !segmentEmotion || !segmentIntent
        || (segment.gaze !== 'user' && segment.gaze !== 'side-down')
        || !Number.isFinite(segment.intensity) || segment.intensity < 0 || segment.intensity > 1
        || !Number.isFinite(segment.confidence) || segment.confidence < 0 || segment.confidence > 1) {
        return [];
      }
      return [{
        text: phrase,
        voiceEmotion: segmentVoice,
        emotion: segmentEmotion,
        intent: segmentIntent,
        intensity: segment.intensity,
        gaze: segment.gaze,
        confidence: segment.confidence
      }];
    }).slice(0, 3)
    : undefined;
  const source = provided?.source === 'model' || provided?.source === 'fallback'
    ? provided.source
    : undefined;

  return {
    emotion,
    intent,
    intensity,
    gaze,
    ...(voiceEmotion ? { voiceEmotion } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(evidence ? { evidence } : {}),
    ...(emphasis && emphasis.length > 0 ? { emphasis } : {}),
    ...(segments && segments.length >= 2 ? { segments } : {}),
    ...(source ? { source } : {})
  };
}
