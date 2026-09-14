import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GaplessVoicePlayer } = require('../../chat5-compat/public/gapless-player.js') as {
  GaplessVoicePlayer: new (options?: Record<string, unknown>) => any;
};

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startTimes: number[];

  constructor(private readonly context: FakeAudioContext) {
    this.startTimes = context.startTimes;
  }

  connect(): void {}

  start(at: number): void {
    this.startTimes.push(at);
  }

  stop(): void {}
}

class FakeAudioContext {
  currentTime = 10;
  state = 'running';
  startTimes: number[] = [];

  resume(): Promise<void> {
    return Promise.resolve();
  }

  decodeAudioData(): Promise<{ duration: number }> {
    return Promise.resolve({ duration: 1 });
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource(this);
    return source;
  }

  createBuffer(_channels: number, length: number, sampleRate: number): { duration: number } {
    return { duration: length / sampleRate };
  }
}

describe('GaplessVoicePlayer segment pacing', () => {
  const previousWindow = (globalThis as any).window;

  afterEach(() => {
    (globalThis as any).window = previousWindow;
  });

  it('adds 400ms between adjacent segments in the same reply', async () => {
    (globalThis as any).window = { AudioContext: FakeAudioContext };
    const player = new GaplessVoicePlayer({
      prebuffer: 1,
      autoStart: false,
      segmentGapSeconds: 0.4,
    });
    player.setTotal(2);
    player.start();

    await player.addSegment(0, new ArrayBuffer(1));
    await player.addSegment(1, new ArrayBuffer(1));

    expect(player.ctx.startTimes[1] - player.ctx.startTimes[0]).toBeCloseTo(1.4, 6);
    expect(player.nextStartTime - player.ctx.startTimes[1]).toBeCloseTo(1, 6);
  });
});
