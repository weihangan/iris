import type {
  AcceptedExpressionRecord,
  DailyCandidateEmotion
} from './daily-candidate-types';
import { ExpressionCurveTimeline } from './expression-curve-timeline';
import {
  FACIAL_CHANNELS,
  clampFacialWeight,
  type FacialChannel,
  type FacialPose
} from './facial-pose';
import type { SpeechPerformanceCue } from './speech-performance-timeline';

export interface AutomaticSpeechExpressionRun {
  readonly expressionId: string;
  readonly category: DailyCandidateEmotion;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly activeChannels: readonly FacialChannel[];
  readonly timeline: ExpressionCurveTimeline;
}

interface CatalogItem {
  readonly entry: AcceptedExpressionRecord;
  readonly activeChannels: readonly FacialChannel[];
}

const DAILY_CATEGORIES = new Set<DailyCandidateEmotion>([
  'gentle', 'happy', 'explaining', 'curious', 'thinking', 'grateful', 'apologetic'
]);

const EMOTION_ALIASES: Readonly<Record<string, DailyCandidateEmotion | undefined>> = {
  gentle: 'gentle',
  loving: 'gentle',
  happy: 'happy',
  smile: 'happy',
  excited: 'happy',
  delighted: 'happy',
  playful: 'happy',
  explaining: 'explaining',
  neutral: 'explaining',
  serious: 'explaining',
  confident: 'explaining',
  curious: 'curious',
  skeptical: 'curious',
  thinking: 'thinking',
  grateful: 'grateful',
  greeting: 'grateful',
  apologetic: 'apologetic'
};

const INTENT_ALIASES: Readonly<Record<string, DailyCandidateEmotion | undefined>> = {
  reassuring: 'gentle',
  explaining: 'explaining',
  questioning: 'curious',
  thinking: 'thinking',
  gratitude: 'grateful',
  apologizing: 'apologetic',
  greeting: 'grateful',
  inviting: 'gentle'
};

const OPPOSING_CHANNELS: Readonly<Partial<Record<FacialChannel, readonly FacialChannel[]>>> = {
  browInnerUp: ['browDownLeft', 'browDownRight'],
  browOuterUpLeft: ['browDownLeft'],
  browOuterUpRight: ['browDownRight'],
  browDownLeft: ['browInnerUp', 'browOuterUpLeft'],
  browDownRight: ['browInnerUp', 'browOuterUpRight'],
  eyeWideLeft: ['eyeSquintLeft', 'eyeSmile', 'eyeLidClose'],
  eyeWideRight: ['eyeSquintRight', 'eyeSmile', 'eyeLidClose'],
  eyeSquintLeft: ['eyeWideLeft'],
  eyeSquintRight: ['eyeWideRight'],
  eyeSmile: ['eyeWideLeft', 'eyeWideRight'],
  eyeLidClose: ['eyeWideLeft', 'eyeWideRight'],
  mouthSmileLeft: ['mouthFrownLeft'],
  mouthSmileRight: ['mouthFrownRight'],
  mouthFrownLeft: ['mouthSmileLeft'],
  mouthFrownRight: ['mouthSmileRight']
};

function resolveCategory(cue: Pick<SpeechPerformanceCue, 'facialEmotion' | 'emotion' | 'intent'>): DailyCandidateEmotion | null {
  const face = String(cue.facialEmotion || '').trim().toLowerCase();
  const rawEmotion = String(cue.emotion || '').trim().toLowerCase();
  const intent = String(cue.intent || '').trim().toLowerCase();
  if (DAILY_CATEGORIES.has(face as DailyCandidateEmotion)) return face as DailyCandidateEmotion;
  // A sad/concerned face remains authoritative. It must not receive a smile
  // merely because the only installed candidate happens to be gentle.
  if (['sad', 'heartbroken'].includes(face)) {
    return intent === 'apologizing' ? 'apologetic' : null;
  }
  if (face === 'concerned') {
    return intent === 'reassuring' ? 'gentle' : null;
  }
  return INTENT_ALIASES[intent]
    ?? EMOTION_ALIASES[face]
    ?? EMOTION_ALIASES[rawEmotion]
    ?? null;
}

function usableChannels(
  entry: AcceptedExpressionRecord,
  supportedChannels: ReadonlySet<FacialChannel>
): FacialChannel[] {
  return FACIAL_CHANNELS.filter(channel =>
    supportedChannels.has(channel) && Boolean(entry.channelCurves[channel]?.length));
}

function buildRun(
  startSeconds: number,
  endSeconds: number,
  category: DailyCandidateEmotion,
  entry: AcceptedExpressionRecord,
  activeChannels: readonly FacialChannel[]
): AutomaticSpeechExpressionRun {
  const allowed = new Set(activeChannels);
  return {
    expressionId: entry.id,
    category,
    startSeconds,
    endSeconds,
    activeChannels: [...activeChannels],
    timeline: new ExpressionCurveTimeline({
      durationSeconds: entry.durationSeconds,
      channelCurves: Object.fromEntries(
        Object.entries(entry.channelCurves).filter(([channel]) => allowed.has(channel as FacialChannel))
      )
    })
  };
}

/**
 * Convert accepted automatic expressions into semantic runs. Consecutive
 * timing beats with the same meaning share one curve instead of restarting it
 * at every internal beat. A real emotion turn starts a new independently
 * selected expression, and richer same-category pools rotate within a reply.
 */
export function buildAutomaticSpeechExpressionRuns(
  cues: readonly SpeechPerformanceCue[],
  entries: readonly AcceptedExpressionRecord[],
  supportedChannels: readonly FacialChannel[] = FACIAL_CHANNELS,
  rotationOffsets: Map<DailyCandidateEmotion, number> = new Map()
): AutomaticSpeechExpressionRun[] {
  const supported = new Set(supportedChannels);
  const catalog: CatalogItem[] = entries
    .filter(entry => entry.status === 'accepted'
      && entry.automatic === true
      && Number.isFinite(entry.durationSeconds)
      && entry.durationSeconds > 0)
    .map(entry => ({ entry, activeChannels: usableChannels(entry, supported) }))
    .filter(item => item.activeChannels.length > 0)
    .sort((left, right) => left.entry.acceptedAt.localeCompare(right.entry.acceptedAt)
      || left.entry.id.localeCompare(right.entry.id));
  const usedIds = new Set<string>();
  const runs: AutomaticSpeechExpressionRun[] = [];
  let draft: {
    startSeconds: number;
    endSeconds: number;
    category: DailyCandidateEmotion;
    entry: AcceptedExpressionRecord;
    activeChannels: readonly FacialChannel[];
  } | null = null;

  const flush = () => {
    if (!draft) return;
    runs.push(buildRun(
      draft.startSeconds,
      draft.endSeconds,
      draft.category,
      draft.entry,
      draft.activeChannels
    ));
    draft = null;
  };

  for (const cue of cues) {
    const category = resolveCategory(cue);
    if (!category) {
      flush();
      continue;
    }
    if (draft
      && draft.category === category
      && !cue.emotionTurn
      && Math.abs(draft.endSeconds - cue.startSeconds) < 0.01) {
      draft.endSeconds = cue.endSeconds;
      continue;
    }
    flush();
    const matches: CatalogItem[] = catalog.filter((item: CatalogItem) => item.entry.emotion === category);
    if (matches.length === 0) continue;
    const fresh: CatalogItem[] = matches.filter((item: CatalogItem) => !usedIds.has(item.entry.id));
    const candidates: CatalogItem[] = fresh.length > 0 ? fresh : matches;
    const offset: number = rotationOffsets.get(category) ?? 0;
    const selected: CatalogItem = candidates[offset % candidates.length];
    rotationOffsets.set(category, offset + 1);
    usedIds.add(selected.entry.id);
    draft = {
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
      category,
      entry: selected.entry,
      activeChannels: selected.activeChannels
    };
  }
  flush();
  return runs;
}

/** Sample one authored curve against the same absolute speech clock. */
export function sampleAutomaticSpeechExpression(
  run: AutomaticSpeechExpressionRun,
  speechTimeSeconds: number
): FacialPose {
  const runDuration = Math.max(0.001, run.endSeconds - run.startSeconds);
  const progress = clampFacialWeight((speechTimeSeconds - run.startSeconds) / runDuration);
  // ExpressionCurveTimeline owns the authored duration and clamps every
  // channel. Mapping by normalized progress lets one accepted expression work
  // for short and long semantic phrases without changing its source data.
  return run.timeline.sample(run.timeline.getDurationSeconds() * progress);
}

/** Enhance only channels authored by the accepted expression. */
export function overlayAutomaticSpeechExpression(
  base: FacialPose,
  automatic: FacialPose,
  activeChannels: readonly FacialChannel[],
  intensity: number
): FacialPose {
  const result = { ...base } as Record<FacialChannel, number>;
  const strength = Math.max(0.72, clampFacialWeight(intensity));
  for (const channel of activeChannels) {
    const value = clampFacialWeight(automatic[channel] * strength);
    result[channel] = Math.max(result[channel], value);
    const conflictRelease = clampFacialWeight(value / 0.5) * 0.75;
    for (const opposite of OPPOSING_CHANNELS[channel] ?? []) {
      result[opposite] = clampFacialWeight(result[opposite] * (1 - conflictRelease));
    }
  }
  return Object.fromEntries(FACIAL_CHANNELS.map(channel => [channel, result[channel]])) as unknown as FacialPose;
}
