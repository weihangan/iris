import policy from '../../scripts/daily-candidate-audit-policy.json';
import type { ExpressionCurveKey } from './daily-candidate-types';
import type { FacialChannel } from './facial-pose';

export type DailyCandidateAuditReason =
  | 'no-active-bone-motion'
  | 'duration'
  | 'root-translation'
  | 'center-translation'
  | 'fast-turn'
  | 'large-leg-lift'
  | 'deep-crouch'
  | 'static-leg-helper'
  | 'head-entry'
  | 'shoulder-entry'
  | 'bone-step'
  | 'unmapped-morph'
  | 'no-mapped-expression'
  | 'blush-overflow'
  | 'mouth-viseme-conflict'
  | 'eyelid-residual'
  | 'entry-residual'
  | 'exit-residual'
  | 'channel-step'
  | 'non-finite';

export interface DailyCandidateAuditResult {
  readonly accepted: boolean;
  readonly primaryReason?: DailyCandidateAuditReason;
  readonly reasons: readonly DailyCandidateAuditReason[];
}

export interface DailyMotionCandidateMetrics {
  readonly durationSeconds: number;
  readonly activeBoneTrackCount: number;
  readonly rootTranslationMax: number;
  readonly centerTranslationMax: number;
  readonly maximumTurnDegrees: number;
  readonly maximumLegLift: number;
  readonly maximumKneeBendDegrees: number;
  readonly hasStaticLegHelper: boolean;
  readonly headEntryDegrees: number;
  readonly shoulderEntryDegrees: number;
  readonly maximumBoneStep: number;
}

export interface DailyExpressionCandidateAuditInput {
  readonly durationSeconds: number;
  readonly channelCurves: Readonly<Partial<Record<FacialChannel, readonly ExpressionCurveKey[]>>>;
  readonly unmappedMorphNames: readonly string[];
}

function result(reasons: readonly DailyCandidateAuditReason[]): DailyCandidateAuditResult {
  return reasons.length === 0
    ? { accepted: true, reasons: [] }
    : { accepted: false, primaryReason: reasons[0], reasons };
}

export function auditMotionCandidateMetrics(
  metrics: DailyMotionCandidateMetrics
): DailyCandidateAuditResult {
  const reasons: DailyCandidateAuditReason[] = [];
  const values = Object.entries(metrics).filter(([, value]) => typeof value === 'number');
  if (values.some(([, value]) => !Number.isFinite(value))) return result(['non-finite']);
  const limits = policy.motion;
  if (metrics.activeBoneTrackCount < 1) reasons.push('no-active-bone-motion');
  if (metrics.durationSeconds < limits.minimumDurationSeconds
    || metrics.durationSeconds > limits.maximumDurationSeconds) reasons.push('duration');
  if (metrics.rootTranslationMax > limits.maximumRootTranslation) reasons.push('root-translation');
  if (metrics.centerTranslationMax > limits.maximumCenterTranslation) reasons.push('center-translation');
  if (metrics.maximumTurnDegrees > limits.maximumTurnDegrees) reasons.push('fast-turn');
  if (metrics.maximumLegLift > limits.maximumLegLift) reasons.push('large-leg-lift');
  if (metrics.maximumKneeBendDegrees > limits.maximumKneeBendDegrees) reasons.push('deep-crouch');
  if (metrics.hasStaticLegHelper) reasons.push('static-leg-helper');
  if (metrics.headEntryDegrees > limits.maximumHeadEntryDegrees) reasons.push('head-entry');
  if (metrics.shoulderEntryDegrees > limits.maximumShoulderEntryDegrees) reasons.push('shoulder-entry');
  if (metrics.maximumBoneStep > limits.maximumBoneStep) reasons.push('bone-step');
  return result(reasons);
}

export function auditExpressionCandidate(
  input: DailyExpressionCandidateAuditInput
): DailyCandidateAuditResult {
  const reasons: DailyCandidateAuditReason[] = [];
  const limits = policy.expression;
  if (!Number.isFinite(input.durationSeconds)) return result(['non-finite']);
  if (input.durationSeconds < limits.minimumDurationSeconds
    || input.durationSeconds > limits.maximumDurationSeconds) reasons.push('duration');
  if (input.unmappedMorphNames.length > 0) reasons.push('unmapped-morph');
  const populated = Object.entries(input.channelCurves)
    .filter(([, keys]) => Boolean(keys?.length)) as Array<[FacialChannel, readonly ExpressionCurveKey[]]>;
  if (populated.length === 0) reasons.push('no-mapped-expression');

  const blush = input.channelCurves.blush ?? [];
  if (blush.some(key => key.value > limits.maximumBlush)) reasons.push('blush-overflow');
  for (const channel of ['jawOpen', 'mouthClose'] as const) {
    if ((input.channelCurves[channel] ?? []).some(key => key.value > limits.maximumEndpointResidual)) {
      reasons.push('mouth-viseme-conflict');
      break;
    }
  }
  const eyelid = input.channelCurves.eyeLidClose ?? [];
  if (eyelid.length > 0 && eyelid[eyelid.length - 1].value > limits.maximumEndpointResidual) {
    reasons.push('eyelid-residual');
  }

  for (const [, keys] of populated) {
    if (keys.some(key => !Number.isFinite(key.timeSeconds) || !Number.isFinite(key.value))) {
      reasons.push('non-finite');
      continue;
    }
    if (keys[0].value > limits.maximumEndpointResidual) reasons.push('entry-residual');
    if (keys[keys.length - 1].value > limits.maximumEndpointResidual) reasons.push('exit-residual');
    for (let index = 1; index < keys.length; index += 1) {
      if (Math.abs(keys[index].value - keys[index - 1].value) > limits.maximumChannelStep) {
        reasons.push('channel-step');
        break;
      }
    }
  }
  return result([...new Set(reasons)]);
}
