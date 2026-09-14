import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { splitVoiceText, createGroupedTaskQueue, getContiguousReadyCount, getSegmentProgressState, getSpeakableLength } = require('../../chat5-compat/public/voice-segment-queue.js') as {
  splitVoiceText: (text: string, options?: Record<string, number>) => string[];
  createGroupedTaskQueue: (options?: { maxPending?: number }) => {
    enqueue: (run: () => Promise<unknown>, options?: { groupId?: string; token?: { cancelled?: boolean; started?: boolean } }) => Promise<any>;
    readonly busy: boolean;
  };
  getContiguousReadyCount: (states: readonly string[]) => number;
  getSegmentProgressState: (states: readonly string[]) => 'idle' | 'partial' | 'complete' | 'failed';
  getSpeakableLength: (text: string) => number;
};

describe('voice segment queue', () => {
  it('splits a long reply at sentence boundaries and keeps short replies intact', () => {
    const text = '午后的阳光透过窗纱静静洒在琴键上泛起一层柔和金边，琴声沿着窗边缓缓流淌，像一条安静的河陪你度过忙碌的午后时光。此刻若你感到些许疲惫就先放下工作听我弹一段舒缓旋律，我会把节奏放慢，让心绪一点点恢复平静。';
    expect(splitVoiceText('你好，今天辛苦了。')).toEqual(['你好，今天辛苦了。']);
    expect(splitVoiceText('指挥，这午后的阳光透过窗纱洒在琴键上，泛起一层柔和的金边。若你此刻感到疲惫，就先停下工作听我弹一段旋律。')).toHaveLength(2);
    const longParts = splitVoiceText(text);
    expect(longParts).toHaveLength(3);
    expect(getSpeakableLength(longParts[0])).toBeLessThanOrEqual(30);
    expect(longParts[0]).toMatch(/[，。]$/u);
  });

  it('limits segment count by speakable characters, ignoring punctuation and stage directions', () => {
    const decoratedShort = `${'语'.repeat(18)}。${'语'.repeat(18)}。（${'动作描述'.repeat(20)}）`;
    expect(splitVoiceText(decoratedShort)).toHaveLength(1);
    expect(splitVoiceText(`${'语'.repeat(20)}。${'语'.repeat(20)}。`)).toHaveLength(2);
    expect(splitVoiceText(`${'语'.repeat(25)}。${'语'.repeat(25)}。`)).toHaveLength(2);
    expect(splitVoiceText(`${'语'.repeat(24)}。${'语'.repeat(24)}。${'语'.repeat(24)}。`)).toHaveLength(3);
    expect(splitVoiceText(`${'语'.repeat(34)}。${'语'.repeat(34)}。${'语'.repeat(34)}。`)).toHaveLength(3);
    expect(splitVoiceText(`${'语'.repeat(38)}。${'语'.repeat(38)}。${'语'.repeat(38)}。${'语'.repeat(38)}。`)).toHaveLength(4);
  });

  it('keeps a two-segment split near half, with the first side allowed slightly longer', () => {
    const parts = splitVoiceText(`${'语'.repeat(30)}。${'语'.repeat(25)}。`);
    expect(parts).toHaveLength(2);
    expect(getSpeakableLength(parts[0])).toBeGreaterThanOrEqual(getSpeakableLength(parts[1]));
  });

  it('targets 35%-50% for the first two-part segment and prefers at least 25 spoken characters when possible', () => {
    const text = `${'语'.repeat(12)}，${'语'.repeat(15)}。${'语'.repeat(20)}，${'语'.repeat(13)}。`;
    const parts = splitVoiceText(text, { maxSegments: 2 });
    expect(parts).toHaveLength(2);
    const total = getSpeakableLength(text);
    const first = getSpeakableLength(parts[0]);
    expect(first).toBeGreaterThanOrEqual(25);
    expect(first / total).toBeGreaterThanOrEqual(0.35);
    expect(first / total).toBeLessThanOrEqual(0.5);
    expect(parts[0]).toContain('。');
  });

  it('does not let the first segment exceed half when an earlier natural boundary is in range', () => {
    const text = `${'语'.repeat(30)}。${'语'.repeat(10)}。${'语'.repeat(30)}。`;
    const parts = splitVoiceText(text, { maxSegments: 2 });
    expect(parts).toHaveLength(2);
    const first = getSpeakableLength(parts[0]);
    const total = getSpeakableLength(text);
    expect(first).toBe(30);
    expect(first / total).toBeLessThanOrEqual(0.5);
  });

  it('expands a too-short first sentence to a natural comma boundary for 40+ character replies', () => {
    const text = '指挥，窗外的风停了，琴房里很安静。你可以先放下手里的工作，慢慢呼吸几次，再告诉我现在最需要什么。';
    const parts = splitVoiceText(text);
    expect(parts).toHaveLength(2);
    expect(getSpeakableLength(parts[0])).toBeGreaterThanOrEqual(25);
    expect(parts[0]).toMatch(/[，。]$/u);
  });

  it('caps the first segment near 25 characters for longer replies when punctuation allows', () => {
    const text = '指挥，窗外的风停了，琴房里很安静。你可以先放下手里的工作，慢慢呼吸几次，再告诉我现在最需要什么。如果愿意，我会陪你把今天剩下的事情一点点整理好。';
    const parts = splitVoiceText(text);
    expect(getSpeakableLength(parts[0])).toBeLessThanOrEqual(28);
    expect(getSpeakableLength(parts[0])).toBeGreaterThanOrEqual(18);
    expect(parts[0]).toMatch(/[，。]$/u);
  });

  it('uses an ellipsis as a split anchor but cuts at a later natural pause', () => {
    const text = '指挥，窗外的风似乎停了，空气里只剩下琴弦微颤的余音。(轻抚琴盖) 这静谧的时刻，你此刻……是在忙些什么呢？若得闲，不妨来听听这首新谱的曲子。愿旋律能如晚风般轻柔，拂去你一日的疲惫。';
    const parts = splitVoiceText(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('是在忙些什么呢？');
    expect(parts[0]).not.toMatch(/……\s*$/u);
  });

  it('runs segments in one group together but keeps different replies FIFO', async () => {
    const queue = createGroupedTaskQueue({ maxPending: 8 });
    const started: string[] = [];
    let releaseA1!: () => void;
    let releaseA2!: () => void;
    const a1 = new Promise<void>(resolve => { releaseA1 = resolve; });
    const a2 = new Promise<void>(resolve => { releaseA2 = resolve; });

    const pA1 = queue.enqueue(async () => { started.push('a1'); await a1; }, { groupId: 'reply-a' });
    const pA2 = queue.enqueue(async () => { started.push('a2'); await a2; }, { groupId: 'reply-a' });
    const pB = queue.enqueue(async () => { started.push('b'); }, { groupId: 'reply-b' });

    await Promise.resolve();
    expect(started.sort()).toEqual(['a1', 'a2']);
    expect(started).not.toContain('b');
    releaseA1();
    await Promise.resolve();
    expect(started).not.toContain('b');
    releaseA2();
    await Promise.all([pA1, pA2, pB]);
    expect(started).toEqual(['a1', 'a2', 'b']);
    expect(queue.busy).toBe(false);
  });

  it('only exposes playback when the first contiguous segment is ready', () => {
    expect(getContiguousReadyCount(['pending', 'ready'])).toBe(0);
    expect(getContiguousReadyCount(['ready', 'pending', 'ready'])).toBe(1);
    expect(getContiguousReadyCount(['ready', 'ready'])).toBe(2);
    expect(getSegmentProgressState(['pending', 'pending'])).toBe('idle');
    expect(getSegmentProgressState(['ready', 'pending'])).toBe('partial');
    expect(getSegmentProgressState(['ready', 'ready'])).toBe('complete');
    expect(getSegmentProgressState(['failed', 'ready'])).toBe('failed');
  });
});
