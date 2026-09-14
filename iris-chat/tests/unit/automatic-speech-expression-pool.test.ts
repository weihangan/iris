import { describe, expect, it } from 'vitest';
import type { AcceptedExpressionRecord } from '../../src/performance/daily-candidate-types';
import type { FacialChannel } from '../../src/performance/facial-pose';
import {
  buildAutomaticSpeechExpressionRuns,
  sampleAutomaticSpeechExpression
} from '../../src/performance/automatic-speech-expression-pool';
import type { SpeechPerformanceCue } from '../../src/performance/speech-performance-timeline';

function accepted(
  id: string,
  emotion: AcceptedExpressionRecord['emotion'],
  channel: FacialChannel,
  peak: number,
  acceptedAt: string
): AcceptedExpressionRecord {
  return {
    kind: 'expression',
    id,
    displayName: id,
    emotion,
    durationSeconds: 2,
    source: {
      sourceType: 'generated',
      sourceUrl: `generated://${id}`,
      author: 'ChatX2',
      statedTerms: 'local test',
      downloadedAt: '2026-08-15T00:00:00.000Z',
      sha256: 'A'.repeat(64),
      sourceRelativePath: `${id}.json`
    },
    status: 'accepted',
    automatic: true,
    acceptedAt,
    channelCurves: {
      [channel]: [
        { timeSeconds: 0, value: 0 },
        { timeSeconds: 1, value: peak },
        { timeSeconds: 2, value: 0 }
      ]
    }
  };
}

function cue(
  index: number,
  startSeconds: number,
  endSeconds: number,
  emotion: SpeechPerformanceCue['emotion'],
  intent: string,
  emotionTurn: boolean
): SpeechPerformanceCue {
  return {
    index,
    text: `cue-${index}`,
    startSeconds,
    endSeconds,
    emotion,
    facialEmotion: emotion,
    intent,
    intensity: 0.65,
    gaze: 'user',
    gestureEligible: true,
    isOpening: index === 0,
    isClosing: false,
    emotionTurn
  };
}

describe('automatic speech expression pool', () => {
  it('selects accepted automatic expressions per semantic run and changes at a turn', () => {
    const gentle = accepted('gentle-accepted', 'gentle', 'eyeSmile', 0.5, '2026-08-15T01:00:00.000Z');
    const thinking = accepted('thinking-accepted', 'thinking', 'mouthPucker', 0.7, '2026-08-15T02:00:00.000Z');
    const runs = buildAutomaticSpeechExpressionRuns([
      cue(0, 0, 2, 'gentle', 'reassuring', false),
      cue(1, 2, 4, 'gentle', 'reassuring', false),
      cue(2, 4, 6, 'thinking', 'thinking', true)
    ], [gentle, thinking], ['eyeSmile', 'mouthPucker']);

    expect(runs.map(run => ({ id: run.expressionId, start: run.startSeconds, end: run.endSeconds })))
      .toEqual([
        { id: gentle.id, start: 0, end: 4 },
        { id: thinking.id, start: 4, end: 6 }
      ]);
    expect(sampleAutomaticSpeechExpression(runs[0], 2).eyeSmile).toBeCloseTo(0.5, 6);
    expect(sampleAutomaticSpeechExpression(runs[1], 5).mouthPucker).toBeCloseTo(0.7, 6);
  });

  it('rotates richer entries of the same emotion and filters unsupported channels', () => {
    const first = accepted('happy-a', 'happy', 'eyeSmile', 0.4, '2026-08-15T01:00:00.000Z');
    const second = accepted('happy-b', 'happy', 'mouthSmileLeft', 0.5, '2026-08-15T02:00:00.000Z');
    const turns = [
      cue(0, 0, 2, 'happy', 'affirmative', false),
      cue(1, 2, 4, 'thinking', 'thinking', true),
      cue(2, 4, 6, 'happy', 'affirmative', true)
    ];

    const supported = buildAutomaticSpeechExpressionRuns(
      turns,
      [first, second],
      ['eyeSmile', 'mouthSmileLeft', 'mouthPucker']
    );
    expect(supported.filter(run => run.category === 'happy').map(run => run.expressionId))
      .toEqual(['happy-a', 'happy-b']);

    const unsupported = buildAutomaticSpeechExpressionRuns(
      [cue(0, 0, 2, 'happy', 'affirmative', false)],
      [second],
      ['eyeSmile']
    );
    expect(unsupported).toEqual([]);
  });

  it('does not apply a gentle candidate to unmatched sad speech', () => {
    const gentle = accepted('gentle-only', 'gentle', 'eyeSmile', 0.5, '2026-08-15T01:00:00.000Z');
    expect(buildAutomaticSpeechExpressionRuns(
      [cue(0, 0, 2, 'sad', 'concerned', false)],
      [gentle],
      ['eyeSmile']
    )).toEqual([]);
  });
});
