import { validateWav } from '../conversation/wav-validator';

export interface DecodedAudioLike {
  readonly duration: number;
}

export interface PreparedAudio<TDecoded extends DecodedAudioLike = AudioBuffer> {
  readonly taskId: string;
  readonly durationSeconds: number;
  readonly decodedAt: number;
  readonly wavBytes: ArrayBuffer;
  readonly decodedAudio: TDecoded;
}

export interface AudioPreloaderOptions<TDecoded extends DecodedAudioLike> {
  readonly decode: (wavBytes: ArrayBuffer) => Promise<TDecoded>;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

interface CacheEntry<TDecoded extends DecodedAudioLike> {
  readonly prepared: PreparedAudio<TDecoded>;
  readonly expiresAt: number;
  readonly sequence: number;
}

export class AudioPreparationCancelledError extends Error {
  constructor(taskId: string) {
    super(`Audio preparation cancelled: ${taskId}`);
    this.name = 'AudioPreparationCancelledError';
  }
}

/**
 * Validates and decodes audio inside the Avatar-owned audio boundary.
 * This class deliberately has no AudioContext constructor or playback API.
 */
export class AudioPreloader<TDecoded extends DecodedAudioLike = AudioBuffer> {
  private readonly decode: (wavBytes: ArrayBuffer) => Promise<TDecoded>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, CacheEntry<TDecoded>>();
  private readonly generations = new Map<string, number>();
  private readonly pendingCounts = new Map<string, number>();
  private sequence = 0;

  constructor(options: AudioPreloaderOptions<TDecoded>) {
    if (typeof options.decode !== 'function') throw new Error('AudioPreloader requires a decode function');
    this.decode = options.decode;
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(1, options.ttlMs ?? 5 * 60 * 1000);
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 4));
  }

  get size(): number {
    this.cleanupExpired();
    return this.cache.size;
  }

  async prepare(taskId: string, wavBytes: ArrayBuffer): Promise<PreparedAudio<TDecoded>> {
    const normalizedTaskId = taskId.trim();
    if (!normalizedTaskId) throw new Error('taskId must be non-empty');

    const validation = validateWav(wavBytes);
    if (!validation.valid) throw new Error(`Invalid WAV: ${validation.reason}`);

    this.cleanupExpired();
    const generation = (this.generations.get(normalizedTaskId) ?? 0) + 1;
    this.generations.set(normalizedTaskId, generation);
    this.pendingCounts.set(normalizedTaskId, (this.pendingCounts.get(normalizedTaskId) ?? 0) + 1);
    this.cache.delete(normalizedTaskId);
    try {
      // Keep one intact copy for lip/phrase analysis. decodeAudioData may detach its input.
      const retainedWav = wavBytes.slice(0);
      const decoded = await this.decode(wavBytes.slice(0));
      if (this.generations.get(normalizedTaskId) !== generation) {
        throw new AudioPreparationCancelledError(normalizedTaskId);
      }
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
        throw new Error(`Decoded audio has invalid duration: ${decoded.duration}`);
      }

      const decodedAt = this.now();
      const prepared: PreparedAudio<TDecoded> = Object.freeze({
        taskId: normalizedTaskId,
        durationSeconds: decoded.duration,
        decodedAt,
        wavBytes: retainedWav,
        decodedAudio: decoded
      });
      this.cache.set(normalizedTaskId, {
        prepared,
        expiresAt: decodedAt + this.ttlMs,
        sequence: ++this.sequence
      });
      this.evictOverflow();
      return prepared;
    } finally {
      const remaining = (this.pendingCounts.get(normalizedTaskId) ?? 1) - 1;
      if (remaining > 0) {
        this.pendingCounts.set(normalizedTaskId, remaining);
      } else {
        this.pendingCounts.delete(normalizedTaskId);
        this.generations.delete(normalizedTaskId);
      }
    }
  }

  get(taskId: string): PreparedAudio<TDecoded> | null {
    this.cleanupExpired();
    return this.cache.get(taskId)?.prepared ?? null;
  }

  take(taskId: string): PreparedAudio<TDecoded> | null {
    this.cleanupExpired();
    const entry = this.cache.get(taskId);
    if (!entry) return null;
    this.cache.delete(taskId);
    return entry.prepared;
  }

  cancel(taskId: string): void {
    if ((this.pendingCounts.get(taskId) ?? 0) > 0) {
      const nextGeneration = (this.generations.get(taskId) ?? 0) + 1;
      this.generations.set(taskId, nextGeneration);
    } else {
      this.generations.delete(taskId);
    }
    this.cache.delete(taskId);
  }

  cleanupExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [taskId, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(taskId);
        removed++;
      }
    }
    return removed;
  }

  releaseAll(): number {
    const released = this.cache.size;
    this.cache.clear();
    for (const taskId of this.pendingCounts.keys()) this.cancel(taskId);
    return released;
  }

  private evictOverflow(): void {
    while (this.cache.size > this.maxEntries) {
      let oldestTaskId: string | null = null;
      let oldestSequence = Number.POSITIVE_INFINITY;
      for (const [taskId, entry] of this.cache) {
        if (entry.sequence < oldestSequence) {
          oldestSequence = entry.sequence;
          oldestTaskId = taskId;
        }
      }
      if (oldestTaskId === null) return;
      this.cache.delete(oldestTaskId);
    }
  }
}
