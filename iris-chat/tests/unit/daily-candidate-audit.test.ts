import { describe, expect, it } from 'vitest';
import {
  auditExpressionCandidate,
  auditMotionCandidateMetrics
} from '../../src/performance/daily-candidate-audit';

const shortStationary = {
  durationSeconds: 2.4,
  activeBoneTrackCount: 2,
  rootTranslationMax: 0,
  centerTranslationMax: 0.04,
  maximumTurnDegrees: 7,
  maximumLegLift: 0.03,
  maximumKneeBendDegrees: 12,
  hasStaticLegHelper: false,
  headEntryDegrees: 3,
  shoulderEntryDegrees: 2,
  maximumBoneStep: 0.08
};

describe('daily candidate quality audit', () => {
  it('accepts a short stationary low-amplitude motion', () => {
    expect(auditMotionCandidateMetrics(shortStationary)).toMatchObject({ accepted: true, reasons: [] });
  });

  it('rejects jump translation, large leg motion, and static helper calibration', () => {
    expect(auditMotionCandidateMetrics({ ...shortStationary, activeBoneTrackCount: 0 }))
      .toMatchObject({ accepted: false, primaryReason: 'no-active-bone-motion' });
    expect(auditMotionCandidateMetrics({ ...shortStationary, rootTranslationMax: 0.4 }))
      .toMatchObject({ accepted: false, primaryReason: 'root-translation' });
    expect(auditMotionCandidateMetrics({ ...shortStationary, maximumLegLift: 0.4 }))
      .toMatchObject({ accepted: false, primaryReason: 'large-leg-lift' });
    expect(auditMotionCandidateMetrics({ ...shortStationary, hasStaticLegHelper: true }))
      .toMatchObject({ accepted: false, primaryReason: 'static-leg-helper' });
  });

  it('accepts a continuous restrained expression with released eyelids and mouth', () => {
    expect(auditExpressionCandidate({
      durationSeconds: 2,
      unmappedMorphNames: [],
      channelCurves: {
        eyeSmile: [
          { timeSeconds: 0, value: 0 },
          { timeSeconds: 0.4, value: 0.25 },
          { timeSeconds: 2, value: 0 }
        ],
        mouthSmileLeft: [
          { timeSeconds: 0, value: 0 },
          { timeSeconds: 0.4, value: 0.2 },
          { timeSeconds: 2, value: 0 }
        ]
      }
    })).toMatchObject({ accepted: true, reasons: [] });
  });

  it('rejects blush overflow, viseme-like mouth ownership, and eyelid residual', () => {
    expect(auditExpressionCandidate({
      durationSeconds: 2,
      unmappedMorphNames: [],
      channelCurves: { blush: [{ timeSeconds: 0, value: 0 }, { timeSeconds: 1, value: 0.5 }, { timeSeconds: 2, value: 0 }] }
    })).toMatchObject({ accepted: false, primaryReason: 'blush-overflow' });
    expect(auditExpressionCandidate({
      durationSeconds: 2,
      unmappedMorphNames: [],
      channelCurves: { jawOpen: [{ timeSeconds: 0, value: 0 }, { timeSeconds: 1, value: 0.2 }, { timeSeconds: 2, value: 0 }] }
    })).toMatchObject({ accepted: false, primaryReason: 'mouth-viseme-conflict' });
    expect(auditExpressionCandidate({
      durationSeconds: 2,
      unmappedMorphNames: [],
      channelCurves: { eyeLidClose: [{ timeSeconds: 0, value: 0 }, { timeSeconds: 1, value: 0.3 }, { timeSeconds: 2, value: 0.2 }] }
    })).toMatchObject({ accepted: false, primaryReason: 'eyelid-residual' });
  });
});
