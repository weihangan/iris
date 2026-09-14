import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  POLICY_VERSION,
  getEmotionProsody,
  sanitizeEngineParams,
  sanitizeTuningConfig
} = require('../../chat5-compat/services/voiceIdentityPolicy.js');

describe('voice identity policy', () => {
  it('keeps sampling identity identical across emotions', () => {
    const emotions = ['gentle', 'comfort', 'sad', 'question', 'strong', 'excited', 'shy_happy'];
    const samples = emotions.map((emotion) => sanitizeEngineParams({
      emotion,
      temperature: emotion === 'excited' ? 0.95 : 0.3,
      top_p: emotion === 'sad' ? 0.4 : 1
    }));

    expect(new Set(samples.map((sample: { temperature: number }) => sample.temperature)).size).toBe(1);
    expect(new Set(samples.map((sample: { top_p: number }) => sample.top_p)).size).toBe(1);
  });

  it('limits user tuning to timbre-preserving ranges', () => {
    const params = sanitizeEngineParams({
      emotion: 'excited',
      speed: 2,
      speed_offset: 0.8,
      pitch_offset: -8,
      soft_offset: 2,
      volume_offset: 0.9
    });

    expect(params.speed).toBeLessThanOrEqual(1.08);
    expect(params.speed_offset).toBeLessThanOrEqual(0.06);
    expect(params.pitch_offset).toBe(-1);
    expect(params.soft_offset).toBeLessThanOrEqual(0.35);
    expect(params.volume_offset).toBeLessThanOrEqual(0.25);
  });

  it('uses speed and energy for emotional prosody without automatic pitch shifting', () => {
    const gentle = getEmotionProsody('gentle');
    const sad = getEmotionProsody('sad');
    const excited = getEmotionProsody('excited');

    expect(sad.speed).toBeLessThan(gentle.speed);
    expect(excited.speed).toBeGreaterThan(gentle.speed);
    expect(gentle.pitchSemitones).toBe(0);
    expect(sad.pitchSemitones).toBe(0);
    expect(excited.pitchSemitones).toBe(0);
    expect(sad.energy).toBeLessThan(excited.energy);
  });

  it('normalizes every emotion profile without changing emotion metadata', () => {
    const tuning = sanitizeTuningConfig({
      defaultEmotion: 'auto',
      globalPitchOffset: -3.5,
      globalSoftOffset: 0.8,
      emotion_profiles: {
        gentle: { desc: 'gentle', temperature: 0.2, top_p: 0.2, speed: 0.4 },
        angry: { desc: 'angry', temperature: 1, top_p: 1, speed: 2 }
      }
    });

    expect(tuning.defaultEmotion).toBe('auto');
    expect(tuning.emotion_profiles.gentle.desc).toBe('gentle');
    expect(tuning.emotion_profiles.angry.desc).toBe('angry');
    expect(tuning.emotion_profiles.gentle.temperature).toBe(tuning.emotion_profiles.angry.temperature);
    expect(tuning.emotion_profiles.gentle.top_p).toBe(tuning.emotion_profiles.angry.top_p);
    expect(tuning.globalPitchOffset).toBe(-1);
    expect(tuning.globalSoftOffset).toBe(0.35);
    expect(POLICY_VERSION).toBe('voice-identity-lock-v2');
  });
});
