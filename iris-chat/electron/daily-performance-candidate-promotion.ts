import type { AcceptedSpeechExpressionStore } from './accepted-speech-expression-store';
import type { DailyPerformanceCandidateStore } from './daily-performance-candidate-store';
import type {
  ExpressionCandidateRecord,
  MotionCandidateRecord
} from '../src/performance/daily-candidate-types';
import type { VmdEmotionEntry } from '../src/model-pack/model-pack-types';

export interface DailyPerformanceCandidatePromotionOptions {
  readonly candidates: DailyPerformanceCandidateStore;
  readonly expressions: AcceptedSpeechExpressionStore;
  readonly installMotionSource: (record: MotionCandidateRecord) => string;
  readonly addVoiceAction: (entry: VmdEmotionEntry) => boolean;
  readonly removeVoiceActionReference: (vmdPath: string) => boolean;
}

const INTENTS = {
  gentle: 'comforting',
  happy: 'celebrating',
  explaining: 'explaining',
  curious: 'questioning',
  thinking: 'thinking',
  grateful: 'gratitude',
  apologetic: 'apologizing'
} as const;

export class DailyPerformanceCandidatePromotionService {
  constructor(private readonly options: DailyPerformanceCandidatePromotionOptions) {}

  async acceptMotion(id: string): Promise<void> {
    const record = this.requireMotion(id);
    this.options.candidates.verifySource(record.id);
    const vmdPath = this.options.installMotionSource(record);
    const entry: VmdEmotionEntry = {
      vmdPath,
      displayName: record.displayName,
      type: 'voice',
      gestureFamily: `daily-${record.emotion}`,
      intent: INTENTS[record.emotion],
      emotions: [record.emotion],
      description: `${record.displayName}；来源：${record.source.author}；${record.source.sourceUrl}`,
      dialogueSafe: true
    };
    if (!this.options.addVoiceAction(entry)) {
      throw new Error(`failed to write formal voice action: ${record.id}`);
    }
    try {
      this.options.candidates.setStatus(record.id, 'accepted');
    } catch (error) {
      this.options.removeVoiceActionReference(vmdPath);
      throw error;
    }
  }

  async acceptExpression(id: string, acceptedAt = new Date().toISOString()): Promise<void> {
    const record = this.requireExpression(id);
    this.options.candidates.verifySource(record.id);
    if (!Number.isFinite(Date.parse(acceptedAt))) throw new Error('acceptedAt must be a valid timestamp');
    this.options.expressions.upsert({
      ...record,
      status: 'accepted',
      automatic: true,
      acceptedAt
    });
    try {
      this.options.candidates.setStatus(record.id, 'accepted');
    } catch (error) {
      this.options.expressions.remove(record.id);
      throw error;
    }
  }

  private requireMotion(id: string): MotionCandidateRecord {
    const record = this.options.candidates.get(id);
    if (!record) throw new Error(`candidate not found: ${id}`);
    if (record.kind !== 'motion') throw new Error('candidate kind mismatch: expected motion');
    if (record.status !== 'candidate') throw new Error(`candidate is not pending: ${id}`);
    return record;
  }

  private requireExpression(id: string): ExpressionCandidateRecord {
    const record = this.options.candidates.get(id);
    if (!record) throw new Error(`candidate not found: ${id}`);
    if (record.kind !== 'expression') throw new Error('candidate kind mismatch: expected expression');
    if (record.status !== 'candidate') throw new Error(`candidate is not pending: ${id}`);
    return record;
  }
}
