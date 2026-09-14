import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEECH_MOTION_RATE,
  canStartSpeechMotion,
  minimumRemainingSpeechSeconds
} from '../../src/performance/speech-motion-pacing';

describe('speech motion pacing', () => {
  it('uses a restrained 80 percent authored motion rate', () => {
    expect(DEFAULT_SPEECH_MOTION_RATE).toBe(0.8);
    expect(4 / DEFAULT_SPEECH_MOTION_RATE).toBeCloseTo(5, 3);
  });

  it('reserves entry, readable motion, exit and physics settle time', () => {
    expect(minimumRemainingSpeechSeconds(4, 1, 0.9, 0.8)).toBeCloseTo(4.7, 6);
    expect(canStartSpeechMotion({
      remainingSpeechSeconds: 4.69,
      authoredActionSeconds: 4,
      playbackRate: 0.84
    })).toBe(false);
    expect(canStartSpeechMotion({
      remainingSpeechSeconds: 4.7,
      authoredActionSeconds: 4,
      playbackRate: 0.84
    })).toBe(true);
  });
});
