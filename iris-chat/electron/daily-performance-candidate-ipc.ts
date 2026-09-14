import type {
  DailyPerformanceCandidate,
  ExpressionCandidateRecord,
  MotionCandidateRecord
} from '../src/performance/daily-candidate-types';

export type PerformanceCandidateCommandName =
  | 'preview-motion'
  | 'preview-expression'
  | 'preview-combined'
  | 'accept-motion'
  | 'accept-expression'
  | 'delete';

export interface PerformanceCandidateCommand {
  readonly command: PerformanceCandidateCommandName;
  readonly id: string;
}

const COMMANDS = new Set<PerformanceCandidateCommandName>([
  'preview-motion',
  'preview-expression',
  'preview-combined',
  'accept-motion',
  'accept-expression',
  'delete'
]);
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validatePerformanceCandidateSender(senderIsTrustedChat: boolean): void {
  if (!senderIsTrustedChat) {
    throw new Error('performance candidates require the trusted Chat sender');
  }
}

export function validateCandidateCommand(
  input: unknown,
  resolveCandidate: (id: string) => DailyPerformanceCandidate | undefined
): PerformanceCandidateCommand {
  if (!input || typeof input !== 'object') throw new Error('candidate command is required');
  const command = (input as { command?: unknown }).command;
  const id = (input as { id?: unknown }).id;
  if (typeof command !== 'string' || !COMMANDS.has(command as PerformanceCandidateCommandName)) {
    throw new Error('unknown candidate command');
  }
  if (typeof id !== 'string' || !CANDIDATE_ID_PATTERN.test(id)) {
    throw new Error('invalid candidate ID');
  }
  const candidate = resolveCandidate(id);
  if (!candidate) throw new Error(`candidate not found: ${id}`);
  const expectedKind = command.endsWith('-motion')
    ? 'motion'
    : command.endsWith('-expression')
      ? 'expression'
      : undefined;
  if (expectedKind && candidate.kind !== expectedKind) {
    throw new Error(`candidate kind mismatch: expected ${expectedKind}`);
  }
  return { command: command as PerformanceCandidateCommandName, id };
}

export interface DailyPerformanceCandidateControllerOptions {
  readonly listCandidates: () => readonly DailyPerformanceCandidate[];
  readonly getCandidate: (id: string) => DailyPerformanceCandidate | undefined;
  readonly getPair: (id: string) => DailyPerformanceCandidate | undefined;
  readonly verifySource: (id: string) => void;
  readonly isSpeechActive: () => boolean;
  readonly previewMotion: (record: MotionCandidateRecord) => void | Promise<void>;
  readonly previewExpression: (record: ExpressionCandidateRecord) => void | Promise<void>;
  readonly acceptMotion: (record: MotionCandidateRecord) => void | Promise<void>;
  readonly acceptExpression: (record: ExpressionCandidateRecord) => void | Promise<void>;
  readonly removeCandidate: (record: DailyPerformanceCandidate) => void | Promise<void>;
}

export class DailyPerformanceCandidateController {
  constructor(private readonly options: DailyPerformanceCandidateControllerOptions) {}

  list(): readonly DailyPerformanceCandidate[] {
    return structuredClone(this.options.listCandidates());
  }

  async previewMotion(id: string): Promise<void> {
    const record = this.requireCandidate('preview-motion', id) as MotionCandidateRecord;
    this.requirePreviewIdle();
    this.options.verifySource(record.id);
    await this.options.previewMotion(structuredClone(record));
  }

  async previewExpression(id: string): Promise<void> {
    const record = this.requireCandidate('preview-expression', id) as ExpressionCandidateRecord;
    this.requirePreviewIdle();
    this.options.verifySource(record.id);
    await this.options.previewExpression(structuredClone(record));
  }

  async previewCombined(id: string): Promise<void> {
    const record = this.requireCandidate('preview-combined', id);
    const pair = this.options.getPair(record.id);
    if (!pair || pair.kind === record.kind) throw new Error('combined preview requires a valid pair');
    this.requirePreviewIdle();
    const motion = record.kind === 'motion' ? record : pair as MotionCandidateRecord;
    const expression = record.kind === 'expression' ? record : pair as ExpressionCandidateRecord;
    this.options.verifySource(motion.id);
    this.options.verifySource(expression.id);
    await this.options.previewMotion(structuredClone(motion));
    await this.options.previewExpression(structuredClone(expression));
  }

  async acceptMotion(id: string): Promise<void> {
    const record = this.requireCandidate('accept-motion', id) as MotionCandidateRecord;
    this.options.verifySource(record.id);
    await this.options.acceptMotion(structuredClone(record));
  }

  async acceptExpression(id: string): Promise<void> {
    const record = this.requireCandidate('accept-expression', id) as ExpressionCandidateRecord;
    this.options.verifySource(record.id);
    await this.options.acceptExpression(structuredClone(record));
  }

  async delete(id: string): Promise<void> {
    const record = this.requireCandidate('delete', id);
    await this.options.removeCandidate(structuredClone(record));
  }

  private requireCandidate(command: PerformanceCandidateCommandName, id: string): DailyPerformanceCandidate {
    const validated = validateCandidateCommand({ command, id }, this.options.getCandidate);
    return this.options.getCandidate(validated.id)!;
  }

  private requirePreviewIdle(): void {
    if (this.options.isSpeechActive()) {
      throw new Error('candidate preview is unavailable during active speech');
    }
  }
}
