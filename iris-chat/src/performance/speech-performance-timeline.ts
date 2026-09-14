import { derivePerformanceSemantic, type PerformanceSemantic } from './semantic-performance';
import type { VmdEmotionEntry } from './performance-planner';

export interface SpeechPerformanceCue extends PerformanceSemantic {
  readonly facialEmotion: string;
  readonly index: number;
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly gestureEligible: boolean;
  readonly isOpening: boolean;
  readonly isClosing: boolean;
  /** True when emotion or intent changes from the preceding semantic segment. */
  readonly emotionTurn: boolean;
}

const SIDE_DOWN_FACIAL_EMOTIONS = new Set([
  'thinking', 'shy', 'concerned', 'sad', 'heartbroken', 'skeptical', 'embarrassed'
]);

/** One phrase-level semantic for eye/head gaze after personality refinement. */
export function resolveSpeechGazeSemantic(
  cue: Pick<SpeechPerformanceCue, 'facialEmotion' | 'emotion' | 'intent' | 'gaze'>
): string {
  const facialEmotion = String(cue.facialEmotion || cue.emotion).toLowerCase();
  if (cue.gaze === 'side-down'
    || cue.intent === 'thinking'
    || SIDE_DOWN_FACIAL_EMOTIONS.has(facialEmotion)) {
    return cue.intent === 'thinking' ? 'thinking' : facialEmotion;
  }
  return facialEmotion;
}

export interface CoordinatedSpeechMotionSemantic {
  readonly emotion: string;
  readonly intent: string;
  readonly gestureFamily: string | undefined;
}

export interface SpeechPerformanceBudget {
  readonly semanticBeatSeconds?: number;
  readonly gestureGapSeconds?: number;
  readonly maxMajorEmotionTransitions?: number;
}

const RESTRAINED_FACIAL_EMOTIONS = new Set(['neutral', 'gentle', 'loving']);
const CALM_CONCERN_INTENTS = new Set(['concern', 'concerned', 'worry', 'worried']);
const FACIAL_TO_MOTION_EMOTION: Readonly<Record<string, string>> = {
  delighted: 'happy',
  shocked: 'surprised',
  furious: 'angry',
  heartbroken: 'sad',
  skeptical: 'thinking',
  embarrassed: 'shy'
};

/**
 * Keep the body consistent with the personality-refined face. Calm faces use
 * the standing family only when there is no explicit intent. Explicit user
 * voice-pool intent is authoritative even when the face is calm; otherwise
 * every ordinary explanation collapses to the starred neutral standing clip.
 */
export function coordinateSpeechMotionSemantic(
  cue: Pick<SpeechPerformanceCue, 'emotion' | 'intent' | 'intensity'>,
  facialEmotion: string
): CoordinatedSpeechMotionSemantic {
  const face = String(facialEmotion || cue.emotion).toLowerCase();
  const intent = String(cue.intent ?? '').toLowerCase();
  const restrainedIntensity = (cue.intensity ?? 1) <= 0.62;
  // Concern belongs primarily to the face and gaze in an ordinary comforting
  // reply. Routing that calm base intent directly into the body pool selected
  // legacy clips such as "烦恼/尴尬/垂头丧气" several times in one sentence.
  // Keep the body on the user's daily explaining family while the expression
  // remains concerned/gentle/loving.
  if (restrainedIntensity
    && (face === 'concerned' || RESTRAINED_FACIAL_EMOTIONS.has(face))
    && (CALM_CONCERN_INTENTS.has(intent) || (face === 'concerned' && intent === 'explaining'))) {
    return { emotion: 'neutral', intent: 'explaining', gestureFamily: 'explaining' };
  }
  if (RESTRAINED_FACIAL_EMOTIONS.has(face)
    && intent === ''
    && restrainedIntensity) {
    return { emotion: 'neutral', intent: '', gestureFamily: 'neutral' };
  }
  return {
    emotion: FACIAL_TO_MOTION_EMOTION[face] ?? face,
    intent,
    gestureFamily: undefined
  };
}

export class SpeechCueDispatchState {
  private cueIndex = -1;
  private readonly lastMotionStarts = new Map<string, number>();
  private lastMotionStartSeconds = Number.NEGATIVE_INFINITY;

  enter(cue: SpeechPerformanceCue): boolean {
    if (cue.index === this.cueIndex) return false;
    this.cueIndex = cue.index;
    return true;
  }

  /** Allow a deferred cue to be attempted again on the next audio frame. */
  release(cue: Pick<SpeechPerformanceCue, 'index'>): void {
    if (cue.index === this.cueIndex) this.cueIndex = -1;
  }

  claimMotion(vmdPath: string, atSeconds: number, cooldownSeconds: number): boolean {
    const now = Number.isFinite(atSeconds) ? Math.max(0, atSeconds) : 0;
    const cooldown = Number.isFinite(cooldownSeconds) ? Math.max(0, cooldownSeconds) : 0;
    if (now - this.lastMotionStartSeconds < MIN_SPEECH_CUE_HANDOFF_SECONDS) return false;
    const lastStart = this.lastMotionStarts.get(vmdPath);
    if (lastStart !== undefined && now - lastStart < cooldown) return false;
    this.lastMotionStarts.set(vmdPath, now);
    this.lastMotionStartSeconds = now;
    return true;
  }

  canClaimMotion(vmdPath: string, atSeconds: number, cooldownSeconds: number): boolean {
    const now = Number.isFinite(atSeconds) ? Math.max(0, atSeconds) : 0;
    const cooldown = Number.isFinite(cooldownSeconds) ? Math.max(0, cooldownSeconds) : 0;
    if (now - this.lastMotionStartSeconds < MIN_SPEECH_CUE_HANDOFF_SECONDS) return false;
    const lastStart = this.lastMotionStarts.get(vmdPath);
    return lastStart === undefined || now - lastStart >= cooldown;
  }

  reset(): void {
    this.cueIndex = -1;
    this.lastMotionStarts.clear();
    this.lastMotionStartSeconds = Number.NEGATIVE_INFINITY;
  }
}

const SPEECH_BACKGROUND_FILENAMES = ['preview-stand2.vmd', 'preview-stand.vmd'] as const;
// Leave a small breathing window between cues so the outgoing bridge can
// settle before another speech VMD claims the same shoulders/arms.
export const MIN_SPEECH_CUE_HANDOFF_SECONDS = 0.32;
/** Maximum quiet interval for a continuous spoken reply's body accent. */
export const MAX_SPEECH_ACTION_CADENCE_SECONDS = 8;
const PERIODIC_SPEECH_ACTION_THRESHOLD_SECONDS = 7;

export function selectSpeechBackgroundVmd(
  enabledVmdPaths: readonly string[],
  variantSeed = 0,
  vmdMap: readonly VmdEmotionEntry[] = [],
  defaultIdleVmd?: string
): string | undefined {
  const enabled = new Set(enabledVmdPaths.map(path => path.replace(/\\/g, '/').toLowerCase()));
  // The user's explicit default idle is the authoritative speech background.
  // This avoids silently switching to legacy neutral actions such as turns or
  // arm swings when speech begins.
  if (defaultIdleVmd) return defaultIdleVmd;
  const starred = vmdMap
    .filter(entry => entry.starred === true
      && entry.dialogueSafe === true
      && entry.type === 'gesture'
      && entry.gestureFamily.toLowerCase() === 'neutral'
      && entry.emotions.some(emotion => ['neutral', 'gentle', 'serious', 'loving'].includes(emotion.toLowerCase()))
      && enabled.has(entry.vmdPath.replace(/\\/g, '/').toLowerCase()))
    .map(entry => entry.vmdPath);
  if (starred.length > 0) {
    const index = Math.abs(Math.trunc(Number.isFinite(variantSeed) ? variantSeed : 0)) % starred.length;
    return starred[index];
  }
  const candidates = SPEECH_BACKGROUND_FILENAMES.flatMap(filename =>
    enabledVmdPaths.filter(path =>
      path.replace(/\\/g, '/').toLowerCase().endsWith(`/${filename}`)));
  if (candidates.length === 0) return undefined;
  const index = Math.abs(Math.trunc(Number.isFinite(variantSeed) ? variantSeed : 0)) % candidates.length;
  return candidates[index];
}

export function shouldRestoreSpeechBackground(input: {
  readonly speechActive: boolean;
  readonly motionPlaying: boolean;
  readonly currentPackId: string | null;
  readonly requestInFlight: boolean;
}): boolean {
  const speechMotionPlaying = input.motionPlaying
    && String(input.currentPackId ?? '').startsWith('speech-');
  return input.speechActive && !speechMotionPlaying && !input.requestInFlight;
}

/**
 * The visible speech background is excluded for this Planner decision only.
 * It is deliberately not written into SpeechMotionDirector accent history.
 */
export function buildSpeechPlannerExclusions(
  unavailableAccentIds: readonly string[],
  currentBackgroundVmdPath: string | null | undefined
): string[] {
  const exclusions = new Set(unavailableAccentIds);
  if (currentBackgroundVmdPath) exclusions.add(currentBackgroundVmdPath);
  return Array.from(exclusions);
}

export function shouldDispatchSpeechGesture(
  cue: Pick<SpeechPerformanceCue, 'index' | 'intent' | 'gestureEligible'>
    & Partial<Pick<SpeechPerformanceCue, 'emotion' | 'intensity' | 'isOpening' | 'isClosing' | 'emotionTurn'>>,
  _speechGeneration: number,
  allowClosingFallback = false
): boolean {
  if (!cue.gestureEligible) return false;
  // A one-cue reply is both opening and closing; it must still use the user's
  // selected voice-action pool. A plain multi-cue closing returns to the
  // selected background, but a validated emotion turn is a real handoff and
  // may select a new pool action before the final idle return.
  if (cue.isClosing && !cue.isOpening && !cue.emotionTurn) return allowClosingFallback;
  return true;
}

/**
 * Reserve a plain closing beat for the user's default idle. A closing cue
 * carrying a validated semantic turn remains eligible for a new action so a
 * two-sentence reply can visibly hand off before returning to idle.
 */
export function shouldUseSpeechBackgroundForCue(
  cue: Pick<SpeechPerformanceCue, 'isOpening' | 'isClosing' | 'emotionTurn'>
): boolean {
  return cue.isClosing && !cue.isOpening && !cue.emotionTurn;
}

export interface SpeechGestureDeferralInput {
  readonly motionPlaying: boolean;
  readonly currentPackId: string | null;
  readonly state: string;
  readonly currentAnimationTime: number;
  readonly animationDuration: number;
  /** A validated phrase-level semantic turn may hand off after the first pose has settled. */
  readonly emotionTurn?: boolean;
}

/** Do not replace a one-shot voice action before its authored final frame. */
export function shouldDeferSpeechGestureForCurrentClip(input: SpeechGestureDeferralInput): boolean {
  if (!input.motionPlaying || !String(input.currentPackId ?? '').startsWith('speech-cue:')) return false;
  const duration = Number.isFinite(input.animationDuration) ? Math.max(0, input.animationDuration) : 0;
  if (duration <= 0) return true;
  const current = Number.isFinite(input.currentAnimationTime) ? Math.max(0, input.currentAnimationTime) : 0;
  // A native bridge/fade can legitimately hold the clip near its final bridge
  // frame while the renderer is converging. A validated emotion turn may
  // still hand off once that opening pose has been visible for ~0.65 s; the
  // next MotionPlayer play() captures the current pose and creates a fresh
  // inertial bridge. Without this exception, a bridge that is held by the
  // performance clock consumes the entire reply and permanently suppresses
  // the second action.
  if ((input.state === 'fading-in' || input.state === 'bridging')
    && !(input.emotionTurn && current >= Math.min(1.2, Math.max(0.65, duration * 0.35)))) {
    return true;
  }
  // A real semantic turn can replace the previous one-shot after it has shown
  // a readable opening pose. MotionPlayer still applies the authored 0.72 s
  // bridge, so this changes emotion without snapping limbs or resetting pose.
  if (input.emotionTurn && current >= Math.min(1.2, Math.max(0.65, duration * 0.35))) {
    return false;
  }
  return current < Math.max(0, duration - 0.06);
}

/** A new reply may replace an old reply's cue; only the current reply defers. */
export function shouldDeferSpeechGestureForCurrentOwner(
  input: SpeechGestureDeferralInput & {
    readonly ownerGeneration: number | null;
    readonly requestedGeneration: number;
  }
): boolean {
  return input.ownerGeneration === input.requestedGeneration
    && shouldDeferSpeechGestureForCurrentClip(input);
}

export function isCalmSpeechCue(
  cue: Pick<SpeechPerformanceCue, 'intent'> & Partial<Pick<SpeechPerformanceCue, 'emotion' | 'intensity'>>
): boolean {
  const emotion = String(cue.emotion ?? '').toLowerCase();
  const restrainedEmotion = ['neutral', 'serious', 'gentle', 'loving', 'concerned'].includes(emotion);
  const restrainedIntent = ['explaining', 'concerned', 'affirmative'].includes(String(cue.intent ?? '').toLowerCase());
  return restrainedEmotion && restrainedIntent && (cue.intensity ?? 1) <= 0.62;
}

const EXPLICIT_SEMANTIC_SIGNAL = /(你好|hello|hi|嗨|早上好|晚上好|下午好|欢迎|welcome|请进|来吧|进来|这边|过来|邀请|让我想想|让我想一想|思考|想一想|想一下|考虑|害羞|不好意思|脸红|羞|担心|忧虑|不安|难过|抱歉|遗憾|对不起|请原谅|是我的错|委屈|心碎|尴尬|窘迫|怀疑|可疑|你确定|居然|竟然|没想到|惊讶|震惊|难以置信|惊呆了|天啊|生气|愤怒|不能接受|太过分|咬牙|攥拳|怒视|暴怒|完全不敢相信|交给我|我会做到|一定可以|认真|必须|说明|重要|注意|是的|对的|嗯|好的|没问题|可以|谢谢|感谢|多谢|感激|感恩|辛苦|麻烦|陪你|陪着你|陪伴你|放心|别害怕|不用怕|慢慢来|没关系|会在|喜欢|爱|可爱|温柔|温暖|美好|幸福|开心|快乐|激动|雀跃|[？?])/i;
const CALM_EMOTIONS = new Set(['neutral', 'serious', 'gentle', 'loving', 'grateful', 'concerned']);
const MAJOR_EMOTIONS = new Set([
  'happy', 'angry', 'surprised', 'sad', 'shy', 'thinking', 'concerned', 'curious',
  'delighted', 'shocked', 'furious', 'heartbroken', 'skeptical', 'embarrassed',
  'apologetic', 'confident', 'excited'
]);
const EXPLICIT_CURIOSITY_WORDS = /(好奇|究竟|到底|为什么|怎么回事|是否真的|真的吗)/;
const MAX_MAJOR_EMOTION_TRANSITIONS = 3;

function splitSpeechText(rawText: string): string[] {
  const normalized = String(rawText ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const matches = normalized.match(/[^。！？!?；;，,\n]+[。！？!?；;，,\n]*/g) ?? [];
  const fragments = matches.map(value => value.trim()).filter(Boolean);
  const merged: string[] = [];
  let shortLead = '';
  for (const fragment of fragments) {
    const contentLength = fragment.replace(/[\s。！？!?；;，,]/g, '').length;
    const commaEnded = /[，,]$/.test(fragment);
    // A vocative/short lead such as "指挥，夜深了，" has no independent
    // body meaning. Merge it into the following substantive clause, while
    // retaining longer comma clauses that contain a real semantic change.
    if (commaEnded && contentLength <= 3) {
      shortLead += fragment;
      continue;
    }
    merged.push(`${shortLead}${fragment}`);
    shortLead = '';
  }
  if (shortLead) {
    if (merged.length > 0) merged[merged.length - 1] += shortLead;
    else merged.push(shortLead);
  }
  return merged;
}

function cueWeight(text: string): number {
  const contentLength = Math.max(1, text.replace(/[\s。！？!?；;，,]/g, '').length);
  const pause = /[。！？!?]$/.test(text) ? 3 : /[；;]$/.test(text) ? 2 : /[，,]$/.test(text) ? 1 : 0;
  return contentLength + pause;
}

function semanticForSegment(text: string, base: PerformanceSemantic): PerformanceSemantic {
  const authorizedSegment = base.segments?.find(segment => {
    const segmentText = segment.text.trim();
    const cueText = text.trim();
    return segmentText === cueText
      || segmentText.includes(cueText)
      || cueText.includes(segmentText);
  });
  if (authorizedSegment) {
    return {
      emotion: authorizedSegment.emotion,
      intent: authorizedSegment.intent,
      intensity: authorizedSegment.intensity,
      gaze: authorizedSegment.gaze,
      voiceEmotion: authorizedSegment.voiceEmotion,
      confidence: authorizedSegment.confidence,
      source: base.source
    };
  }
  if (!EXPLICIT_SEMANTIC_SIGNAL.test(text)) return base;
  const candidate = derivePerformanceSemantic(text);
  if (CALM_EMOTIONS.has(base.emotion)
    && candidate.emotion === 'curious'
    && !EXPLICIT_CURIOSITY_WORDS.test(text)) {
    return { ...base, gaze: 'user' };
  }
  // Keep the motion-facing body family restrained when a caring reply uses a
  // stronger sadness word. The facial expression pipeline may still refine
  // the same phrase to `sad`; changing the cue emotion here would replace a
  // concerned gesture with a heavier sad action and cause an avoidable jump.
  if (base.emotion === 'concerned' && candidate.emotion === 'sad') {
    return { ...base, gaze: 'side-down' };
  }
  return candidate;
}

export function buildSpeechPerformanceTimeline(
  speechText: string | undefined,
  durationSeconds: number,
  baseSemantic: PerformanceSemantic,
  budget: SpeechPerformanceBudget = {}
): SpeechPerformanceCue[] {
  const duration = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0);
  const semanticBeatSeconds = Number.isFinite(budget.semanticBeatSeconds)
    ? Math.max(2.5, budget.semanticBeatSeconds!)
    : 4.5;
  const gestureGapSeconds = Number.isFinite(budget.gestureGapSeconds)
    ? Math.max(2.5, budget.gestureGapSeconds!)
    : 4;
  // The renderer always passes the active compute profile's gesture gap.
  // Treating an explicit budget as "disable periodic cues" made production
  // long replies receive only an opening/turn action and then go motionless.
  // Periodic body beats are deliberately limited to genuinely long replies;
  // 18s calm clauses still keep the restrained single-opening behavior.
  const periodicCadenceEnabled = duration >= 20;
  const maxMajorEmotionTransitions = Number.isFinite(budget.maxMajorEmotionTransitions)
    ? Math.max(0, Math.min(6, Math.trunc(budget.maxMajorEmotionTransitions!)))
    : MAX_MAJOR_EMOTION_TRANSITIONS;
  const segments = splitSpeechText(speechText ?? '');
  const effectiveSegments = segments.length > 0 ? segments : [''];
  const weights = effectiveSegments.map(cueWeight);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let previousSemantic = baseSemantic;
  let majorEmotionTransitions = 0;
  const preliminary = effectiveSegments.map((text, index) => {
    let semantic = semanticForSegment(text, baseSemantic);
    const changesEmotion = semantic.emotion !== previousSemantic.emotion;
    const majorChange = changesEmotion
      && (MAJOR_EMOTIONS.has(semantic.emotion) || MAJOR_EMOTIONS.has(previousSemantic.emotion));
    if (majorChange && majorEmotionTransitions >= maxMajorEmotionTransitions) {
      semantic = { ...semantic, emotion: previousSemantic.emotion };
    } else if (majorChange) {
      majorEmotionTransitions += 1;
    }
    semantic = {
      ...semantic,
      intensity: Math.max(previousSemantic.intensity - 0.18, Math.min(previousSemantic.intensity + 0.18, semantic.intensity))
    };
    previousSemantic = semantic;
    return { text, semantic, fraction: weights[index] / totalWeight };
  });

  let cursor = 0;
  const timedSegments = preliminary.flatMap((entry, semanticIndex) => {
    const segmentStart = cursor;
    const segmentEnd = cursor + duration * entry.fraction;
    cursor = segmentEnd;
    const segmentDuration = segmentEnd - segmentStart;
    // Punctuation alone is too sparse for long spoken replies. Add regular
    // semantic beats so a 20-30 second clause does not become motionless after
    // its first one-shot gesture.
    const isFinalSemanticSegment = semanticIndex === preliminary.length - 1 && preliminary.length > 1;
    // The final cue alone is reserved for the selected idle. Give only a
    // genuinely long final explanation one preceding beat: that permits one
    // late, buffered action without turning the closing sentence into a run
    // of back-to-back motions.
    const longFinalSegmentThreshold = Math.max(
      semanticBeatSeconds * 2,
      MAX_SPEECH_ACTION_CADENCE_SECONDS + gestureGapSeconds
    );
    const beatCount = isFinalSemanticSegment
      ? segmentDuration >= longFinalSegmentThreshold ? 3 : 1
      : Math.max(1, Math.ceil(segmentDuration / semanticBeatSeconds));
    return Array.from({ length: beatCount }, (_, beatIndex) => ({
      ...entry,
      semanticIndex,
      startSeconds: segmentStart + segmentDuration * beatIndex / beatCount,
      endSeconds: segmentStart + segmentDuration * (beatIndex + 1) / beatCount
    }));
  });

  // Supply enough beats for the Director's one-short/two-long accent budget,
  // even when punctuation produced only one or two long clauses. The first
  // beat can use the voice-action pool. Keep the final semantic segment intact
  // whenever there is an earlier segment: that lets a genuine turn in the
  // closing sentence remain visible as the second voice-action handoff instead
  // of being split into a non-turn beat that immediately falls back to idle.
  // Keep enough interior boundaries for the director's cumulative long-reply
  // slots. Six beats gives a 20-23s reply useful opportunities around 0/7/13s,
  // while the final beat remains reserved for returning to idle. Longer
  // replies already receive enough natural semantic beats from their text.
  const minimumCueCount = duration >= 20 && duration < 24
    ? 6
    : duration >= 12 ? 5 : duration >= 3.5 ? 3 : 1;
  while (timedSegments.length < minimumCueCount) {
    const finalSemanticIndex = timedSegments.at(-1)?.semanticIndex;
    const splitCandidates = timedSegments.length > 1 && finalSemanticIndex !== undefined
      ? timedSegments
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.semanticIndex !== finalSemanticIndex)
        .map(({ index }) => index)
      : timedSegments.map((_, index) => index);
    let longestIndex = splitCandidates[0] ?? 0;
    for (const index of splitCandidates.slice(1)) {
      const currentDuration = timedSegments[index].endSeconds - timedSegments[index].startSeconds;
      const longestDuration = timedSegments[longestIndex].endSeconds - timedSegments[longestIndex].startSeconds;
      if (currentDuration > longestDuration) longestIndex = index;
    }
    const longest = timedSegments[longestIndex];
    const midpoint = (longest.startSeconds + longest.endSeconds) / 2;
    timedSegments.splice(longestIndex, 1,
      { ...longest, endSeconds: midpoint },
      { ...longest, startSeconds: midpoint });
  }

  cursor = 0;
  let lastGestureStart = Number.NEGATIVE_INFINITY;
  let finalSegmentGestureClaimed = false;
  return timedSegments.map((entry, index) => {
    const startSeconds = entry.startSeconds;
    const endSeconds = index === timedSegments.length - 1 ? duration : entry.endSeconds;
    const cueDuration = endSeconds - startSeconds;
    const isOpening = index === 0;
    const isClosing = index === timedSegments.length - 1;
    const contentLength = entry.text.replace(/[\s。！？!?；;，,]/g, '').length;
    const hasEnoughContent = contentLength >= (duration < 1 ? 1 : duration < 3.5 || isOpening ? 2 : 4);
    const previousEntry = index > 0 ? timedSegments[index - 1] : undefined;
    const emotionTurn = previousEntry !== undefined
      && entry.semanticIndex !== previousEntry.semanticIndex
      && (entry.semantic.emotion !== previousEntry.semantic.emotion
        || entry.semantic.intent !== previousEntry.semantic.intent);
    // A validated phrase-level turn needs its own handoff sooner than a
    // same-emotion accent. Most two-sentence replies reach the turn around
    // 2.5-3.8 s; applying the normal 4 s cadence here silently suppresses the
    // second action even though face, gaze and voice already changed.
    const requiredGestureGap = emotionTurn
      ? Math.min(gestureGapSeconds, 2.5)
      : gestureGapSeconds;
    const periodicThresholdSeconds = duration >= 18
      ? Math.max(gestureGapSeconds, 6)
      : Math.max(gestureGapSeconds, PERIODIC_SPEECH_ACTION_THRESHOLD_SECONDS);
    const periodicGesture = periodicCadenceEnabled
      && !isOpening
      && !isClosing
      && !emotionTurn
      && !(preliminary.length > 1
        && entry.semanticIndex === preliminary.length - 1
        && finalSegmentGestureClaimed)
      && startSeconds - lastGestureStart >= periodicThresholdSeconds;
    let gestureEligible = duration >= 0.45
      && (isOpening || cueDuration >= 0.8)
      && hasEnoughContent
      && (isOpening || emotionTurn || periodicGesture)
      && startSeconds - lastGestureStart >= requiredGestureGap;
    // Only the closing cue of a multi-cue reply is reserved for the selected
    // background. A single short cue is both opening and closing and remains
    // eligible, otherwise short replies would never play a user action.
    if (isClosing && !isOpening && !emotionTurn) gestureEligible = false;
    if (gestureEligible) {
      lastGestureStart = startSeconds;
      if (preliminary.length > 1 && entry.semanticIndex === preliminary.length - 1) {
        finalSegmentGestureClaimed = true;
      }
    }

    return {
      index,
      text: entry.text,
      startSeconds,
      endSeconds,
      gestureEligible,
      isOpening,
      isClosing,
      emotionTurn,
      facialEmotion: entry.semantic.emotion,
      ...entry.semantic
    };
  });
}
