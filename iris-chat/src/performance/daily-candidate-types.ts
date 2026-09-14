import type { FacialChannel } from './facial-pose';

export type DailyCandidateEmotion =
  | 'gentle'
  | 'happy'
  | 'explaining'
  | 'curious'
  | 'thinking'
  | 'grateful'
  | 'apologetic';

export type CandidateStatus = 'candidate' | 'accepted' | 'rejected';
export type CandidateKind = 'motion' | 'expression';
export type CandidateSourceType = 'online' | 'generated' | 'existing';
export const DAILY_CANDIDATE_AUDIT_POLICY_VERSION = 'daily-performance-candidate-audit-v1';

export interface DailyCandidateAuditRecord {
  readonly policyVersion: string;
  readonly sourceSha256: string;
  readonly accepted: boolean;
  readonly reasons: readonly string[];
  readonly auditedAt: string;
  readonly metrics: Readonly<Record<string, number | boolean | string | null>>;
}

export interface CandidateSource {
  readonly sourceType: CandidateSourceType;
  readonly sourceUrl: string;
  readonly author: string;
  readonly statedTerms: string;
  readonly downloadedAt: string;
  readonly sha256: string;
  readonly sourceRelativePath: string;
}

interface CandidateRecordBase {
  readonly id: string;
  readonly pairId?: string;
  readonly displayName: string;
  readonly emotion: DailyCandidateEmotion;
  readonly durationSeconds: number;
  readonly source: CandidateSource;
  readonly audit?: DailyCandidateAuditRecord;
  readonly status: CandidateStatus;
}

export interface MotionCandidateRecord extends CandidateRecordBase {
  readonly kind: 'motion';
  readonly dialogueSafe: false;
}

export interface ExpressionCurveKey {
  readonly timeSeconds: number;
  readonly value: number;
}

export interface ExpressionCandidateRecord extends CandidateRecordBase {
  readonly kind: 'expression';
  readonly automatic: false;
  readonly channelCurves: Readonly<Partial<Record<FacialChannel, readonly ExpressionCurveKey[]>>>;
}

export type DailyPerformanceCandidate = MotionCandidateRecord | ExpressionCandidateRecord;

export interface AcceptedExpressionRecord
  extends Omit<ExpressionCandidateRecord, 'status' | 'automatic'> {
  readonly status: 'accepted';
  readonly automatic: true;
  readonly acceptedAt: string;
}

export interface DailyPerformanceCandidateFile {
  readonly schemaVersion: 1;
  readonly entries: readonly DailyPerformanceCandidate[];
}
