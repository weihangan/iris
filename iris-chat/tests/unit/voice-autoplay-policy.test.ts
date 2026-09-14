import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const policy = require('../../chat5-compat/public/voice-autoplay-policy.js') as {
  shouldAutoPlayLatest(options: Record<string, unknown>): boolean;
  shouldAutoPlaySynthesisResult(options: Record<string, unknown>): boolean;
  getPreSynthesisCount(autoPlayEnabled: boolean, defaultCount: number): number;
  createVoiceMessageKey(characterId: string, messageIndex: number, text: string): string;
  parseHandledMessageKeys(raw: string | null, limit?: number): string[];
  addHandledMessageKey(keys: readonly string[], key: string, limit?: number): string[];
  createBoundedAudioPreloadCache(options: {
    limit: number;
    createAudio: (url: string) => FakeAudio;
  }): {
    readonly size: number;
    has(url: string): boolean;
    preload(url: string): FakeAudio | null;
    reconcile(urls: Iterable<string>): number;
    clear(): number;
  };
};

class FakeAudio {
  preload = '';
  src: string;
  pauseCalls = 0;
  loadCalls = 0;

  constructor(url: string) {
    this.src = url;
  }

  pause(): void {
    this.pauseCalls++;
  }

  load(): void {
    this.loadCalls++;
  }
}

describe('voice autoplay policy', () => {
  const allowed = {
    enabled: true,
    isLatest: true,
    hasAudio: true,
    voiceEnabled: true,
    stopped: false,
    playing: false,
    alreadyHandled: false
  };

  it('plays an unseen latest assistant voice once', () => {
    expect(policy.shouldAutoPlayLatest(allowed)).toBe(true);
    expect(policy.shouldAutoPlayLatest({ ...allowed, alreadyHandled: true })).toBe(false);
  });

  it('keeps message identity stable across page reloads', () => {
    const first = policy.createVoiceMessageKey('1', 18, '晚安，我会陪着你。');
    const reopened = policy.createVoiceMessageKey('1', 18, '晚安，我会陪着你。');
    const newReply = policy.createVoiceMessageKey('1', 19, '晚安，我会陪着你。');

    expect(reopened).toBe(first);
    expect(newReply).not.toBe(first);
  });

  it('persists a bounded de-duplicated handled ledger', () => {
    expect(policy.parseHandledMessageKeys('not-json')).toEqual([]);
    const keys = policy.addHandledMessageKey(['a', 'b', 'a'], 'c', 3);
    expect(keys).toEqual(['a', 'b', 'c']);
    expect(policy.addHandledMessageKey(keys, 'd', 3)).toEqual(['b', 'c', 'd']);
    expect(policy.addHandledMessageKey(['a', 'b'], 'a', 3)).toEqual(['b', 'a']);
  });

  it('never autoplays when disabled, unavailable, stopped, or already pending', () => {
    expect(policy.shouldAutoPlayLatest({ ...allowed, enabled: false })).toBe(false);
    expect(policy.shouldAutoPlayLatest({ ...allowed, hasAudio: false })).toBe(false);
    expect(policy.shouldAutoPlayLatest({ ...allowed, voiceEnabled: false })).toBe(false);
    expect(policy.shouldAutoPlayLatest({ ...allowed, stopped: true })).toBe(false);
    expect(policy.shouldAutoPlayLatest({ ...allowed, playing: true })).toBe(false);
  });

  it('plays a newly synthesized history reply once but never replays a cached history reply', () => {
    expect(policy.shouldAutoPlaySynthesisResult({
      isRealtime: false,
      cached: false,
      alreadyHandled: false
    })).toBe(true);
    expect(policy.shouldAutoPlaySynthesisResult({
      isRealtime: false,
      cached: true,
      alreadyHandled: false
    })).toBe(false);
  });

  it('still plays a new realtime reply when its audio came from cache', () => {
    expect(policy.shouldAutoPlaySynthesisResult({
      isRealtime: true,
      cached: true,
      alreadyHandled: false
    })).toBe(true);
    expect(policy.shouldAutoPlaySynthesisResult({
      isRealtime: true,
      cached: true,
      alreadyHandled: true
    })).toBe(false);
  });

  it('checks exactly the latest reply when autoplay is enabled on a low-performance device', () => {
    expect(policy.getPreSynthesisCount(true, 0)).toBe(1);
    expect(policy.getPreSynthesisCount(false, 0)).toBe(0);
    expect(policy.getPreSynthesisCount(false, 3)).toBe(3);
  });

  it('bounds and disposes browser audio preloads without touching playback flow', () => {
    const created: FakeAudio[] = [];
    const cache = policy.createBoundedAudioPreloadCache({
      limit: 2,
      createAudio: (url) => {
        const audio = new FakeAudio(url);
        created.push(audio);
        return audio;
      }
    });

    expect(cache.preload('/one.wav')?.preload).toBe('auto');
    cache.preload('/two.wav');
    cache.preload('/three.wav');

    expect(cache.size).toBe(2);
    expect(cache.has('/one.wav')).toBe(false);
    expect(created[0].pauseCalls).toBe(1);
    expect(created[0].src).toBe('');
    expect(created[0].loadCalls).toBe(1);
  });

  it('releases stale and cross-character audio preloads explicitly', () => {
    const created: FakeAudio[] = [];
    const cache = policy.createBoundedAudioPreloadCache({
      limit: 3,
      createAudio: (url) => {
        const audio = new FakeAudio(url);
        created.push(audio);
        return audio;
      }
    });
    cache.preload('/old-role.wav');
    cache.preload('/keep.wav');

    expect(cache.reconcile(['/keep.wav'])).toBe(1);
    expect(cache.has('/old-role.wav')).toBe(false);
    expect(cache.clear()).toBe(1);
    expect(cache.size).toBe(0);
    expect(created.every(audio => audio.pauseCalls === 1 && audio.loadCalls === 1)).toBe(true);
  });
});
