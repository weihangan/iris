import type { AmplitudeLimits } from '../motion/motion-pack-types';

export interface SpeechMotionStyle {
  readonly playbackRate: number;
  readonly amplitudeLimits: AmplitudeLimits;
}

interface SpeechMotionEnvelope {
  readonly playbackRate: number;
  readonly head: number;
  readonly upperBody: number;
  readonly shoulder: number;
}

// 2026-08: 全部 playbackRate 下调 0.04（原 0.8~0.85）。用户反馈语音动作
// 本身偏快；采样速度放缓约 5% 后动作幅度节奏更稳，配合更长的过渡桥。
const DEFAULT_ENVELOPE: SpeechMotionEnvelope = {
  playbackRate: 0.8,
  head: 10,
  upperBody: 7,
  shoulder: 7
};

const ENVELOPES: Readonly<Record<string, SpeechMotionEnvelope>> = {
  gentle: { playbackRate: 0.76, head: 7, upperBody: 5, shoulder: 5 },
  concerned: { playbackRate: 0.76, head: 7, upperBody: 5, shoulder: 5 },
  sad: { playbackRate: 0.76, head: 7, upperBody: 5, shoulder: 5 },
  heartbroken: { playbackRate: 0.76, head: 6, upperBody: 4.5, shoulder: 4.5 },
  apologetic: { playbackRate: 0.76, head: 6.5, upperBody: 4.5, shoulder: 4.5 },
  thinking: { playbackRate: 0.77, head: 8, upperBody: 5.5, shoulder: 5 },
  skeptical: { playbackRate: 0.77, head: 8, upperBody: 5.5, shoulder: 5 },
  grateful: { playbackRate: 0.77, head: 7, upperBody: 5, shoulder: 5 },
  shy: { playbackRate: 0.77, head: 7, upperBody: 5, shoulder: 5 },
  embarrassed: { playbackRate: 0.77, head: 7, upperBody: 5, shoulder: 5 },
  curious: { playbackRate: 0.78, head: 9, upperBody: 6, shoulder: 6 },
  surprised: { playbackRate: 0.79, head: 10, upperBody: 7, shoulder: 7 },
  shocked: { playbackRate: 0.79, head: 10, upperBody: 7, shoulder: 7 },
  explaining: { playbackRate: 0.8, head: 10, upperBody: 8, shoulder: 8 },
  serious: { playbackRate: 0.8, head: 9, upperBody: 7, shoulder: 7 },
  confident: { playbackRate: 0.8, head: 10, upperBody: 8, shoulder: 8 },
  happy: { playbackRate: 0.81, head: 11, upperBody: 9, shoulder: 9 },
  smile: { playbackRate: 0.81, head: 10, upperBody: 8, shoulder: 8 },
  excited: { playbackRate: 0.81, head: 11, upperBody: 9, shoulder: 9 },
  delighted: { playbackRate: 0.81, head: 11, upperBody: 9, shoulder: 9 },
  playful: { playbackRate: 0.81, head: 11, upperBody: 9, shoulder: 9 }
};

function scaledAxes(maximum: number, scale: number): { x: number; y: number; z: number } {
  return {
    x: maximum * scale,
    y: maximum * scale,
    z: maximum * scale
  };
}

export function resolveSpeechMotionStyle(emotion: string, intensity: number): SpeechMotionStyle {
  const envelope = ENVELOPES[String(emotion ?? '').trim().toLowerCase()] ?? DEFAULT_ENVELOPE;
  const safeIntensity = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0.5;
  const scale = 0.75 + safeIntensity * 0.25;

  return {
    playbackRate: envelope.playbackRate,
    amplitudeLimits: {
      head: scaledAxes(envelope.head, scale),
      upperBody: scaledAxes(envelope.upperBody, scale),
      shoulder: scaledAxes(envelope.shoulder, scale),
      faceRedMax: 0.35
    }
  };
}
