import { describe, expect, it, vi } from 'vitest';
import { generateMockWav } from '../../src/conversation/mock-wav-generator';
import {
  AudioPreparationCancelledError,
  AudioPreloader
} from '../../src/performance/audio-preloader';

interface FakeDecodedAudio {
  readonly duration: number;
  readonly marker: string;
}

describe('AudioPreloader', () => {
  it('validates and decodes a complete WAV without playback authority', async () => {
    const wav = generateMockWav({ taskId: 'preload-valid', userText: '完整语音' });
    const decode = vi.fn(async (): Promise<FakeDecodedAudio> => ({ duration: 1.25, marker: 'decoded' }));
    const preloader = new AudioPreloader<FakeDecodedAudio>({ decode });

    const prepared = await preloader.prepare('task-1', wav);

    expect(decode).toHaveBeenCalledTimes(1);
    expect(prepared.taskId).toBe('task-1');
    expect(prepared.durationSeconds).toBe(1.25);
    expect(prepared.decodedAudio.marker).toBe('decoded');
    expect(prepared.wavBytes).not.toBe(wav);
    expect(prepared.wavBytes.byteLength).toBe(wav.byteLength);
    expect(preloader.get('task-1')).toBe(prepared);
    expect('start' in preloader).toBe(false);
  });

  it('rejects an invalid WAV before decode', async () => {
    const decode = vi.fn(async (): Promise<FakeDecodedAudio> => ({ duration: 1, marker: 'unused' }));
    const preloader = new AudioPreloader<FakeDecodedAudio>({ decode });

    await expect(preloader.prepare('bad', new ArrayBuffer(12))).rejects.toThrow('Invalid WAV');
    expect(decode).not.toHaveBeenCalled();
    expect(preloader.size).toBe(0);
  });

  it('cancellation during decode prevents stale prepared state', async () => {
    let resolveDecode!: (audio: FakeDecodedAudio) => void;
    const decode = () => new Promise<FakeDecodedAudio>((resolve) => { resolveDecode = resolve; });
    const preloader = new AudioPreloader<FakeDecodedAudio>({ decode });
    const wav = generateMockWav({ taskId: 'preload-cancel', userText: '取消' });

    const pending = preloader.prepare('task-cancel', wav);
    preloader.cancel('task-cancel');
    resolveDecode({ duration: 1, marker: 'late' });

    await expect(pending).rejects.toBeInstanceOf(AudioPreparationCancelledError);
    expect(preloader.get('task-cancel')).toBeNull();
  });

  it('an older decode cannot overwrite a replacement for the same task', async () => {
    const resolvers: Array<(audio: FakeDecodedAudio) => void> = [];
    const decode = () => new Promise<FakeDecodedAudio>((resolve) => { resolvers.push(resolve); });
    const preloader = new AudioPreloader<FakeDecodedAudio>({ decode });
    const wav = generateMockWav({ taskId: 'preload-replace', userText: '替换' });

    const oldPending = preloader.prepare('same-task', wav);
    const newPending = preloader.prepare('same-task', wav);
    resolvers[1]({ duration: 2, marker: 'new' });
    const newest = await newPending;
    resolvers[0]({ duration: 1, marker: 'old' });

    await expect(oldPending).rejects.toBeInstanceOf(AudioPreparationCancelledError);
    expect(preloader.get('same-task')).toBe(newest);
    expect(preloader.get('same-task')?.decodedAudio.marker).toBe('new');
  });

  it('expires prepared audio by TTL and releases memory', async () => {
    let now = 1_000;
    const preloader = new AudioPreloader<FakeDecodedAudio>({
      decode: async () => ({ duration: 1, marker: 'ttl' }),
      now: () => now,
      ttlMs: 500
    });
    const wav = generateMockWav({ taskId: 'preload-ttl', userText: '过期' });
    await preloader.prepare('ttl-task', wav);

    now = 1_499;
    expect(preloader.get('ttl-task')).not.toBeNull();
    now = 1_500;
    expect(preloader.cleanupExpired()).toBe(1);
    expect(preloader.get('ttl-task')).toBeNull();
  });

  it('bounds cached entries and evicts the oldest prepared audio', async () => {
    let now = 0;
    const preloader = new AudioPreloader<FakeDecodedAudio>({
      decode: async () => ({ duration: 1, marker: String(now) }),
      now: () => ++now,
      maxEntries: 2
    });
    const wav = generateMockWav({ taskId: 'preload-bound', userText: '容量' });

    await preloader.prepare('one', wav);
    await preloader.prepare('two', wav);
    await preloader.prepare('three', wav);

    expect(preloader.size).toBe(2);
    expect(preloader.get('one')).toBeNull();
    expect(preloader.get('two')).not.toBeNull();
    expect(preloader.get('three')).not.toBeNull();
  });

  it('take transfers one prepared entry and releaseAll clears the rest', async () => {
    const preloader = new AudioPreloader<FakeDecodedAudio>({
      decode: async () => ({ duration: 1, marker: 'ready' })
    });
    const wav = generateMockWav({ taskId: 'preload-release', userText: '释放' });
    await preloader.prepare('one', wav);
    await preloader.prepare('two', wav);

    expect(preloader.take('one')?.taskId).toBe('one');
    expect(preloader.get('one')).toBeNull();
    expect(preloader.releaseAll()).toBe(1);
    expect(preloader.size).toBe(0);
  });

  it('does not retain completed or cancelled task generations indefinitely', async () => {
    const preloader = new AudioPreloader<FakeDecodedAudio>({
      decode: async () => ({ duration: 1, marker: 'ready' })
    });
    const wav = generateMockWav({ taskId: 'preload-generation-cleanup', userText: '清理' });

    for (let i = 0; i < 20; i++) {
      await preloader.prepare(`finished-${i}`, wav);
      preloader.take(`finished-${i}`);
    }

    let resolveCancelled!: (audio: FakeDecodedAudio) => void;
    const cancelledPreloader = new AudioPreloader<FakeDecodedAudio>({
      decode: () => new Promise<FakeDecodedAudio>((resolve) => { resolveCancelled = resolve; })
    });
    const pending = cancelledPreloader.prepare('cancelled', wav);
    cancelledPreloader.cancel('cancelled');
    resolveCancelled({ duration: 1, marker: 'cancelled' });
    await expect(pending).rejects.toBeInstanceOf(AudioPreparationCancelledError);

    expect((preloader as any).generations.size).toBe(0);
    expect((preloader as any).pendingCounts.size).toBe(0);
    expect((cancelledPreloader as any).generations.size).toBe(0);
    expect((cancelledPreloader as any).pendingCounts.size).toBe(0);
  });
});
