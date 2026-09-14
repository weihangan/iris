import type { VoiceAdapter, VoiceSynthesisOptions, VoiceSynthesisResult } from './conversation-types';
import type { PerformanceSemantic } from '../performance/semantic-performance';
import { readFile } from 'node:fs/promises';

export interface Chat5VoiceAdapterOptions {
  baseUrl?: string;
  characterId?: string;
  fetchImpl?: typeof fetch;
}

export interface Chat5VoiceResult extends VoiceSynthesisResult {}

/**
 * Adapter for Chat5.2's local voice facade.
 * Chat5 owns GPT-SoVITS startup/retry/cache policy; ChatX2 only receives a
 * completed WAV and the emotion selected by Chat5's voice pipeline.
 */
export class Chat5VoiceAdapter implements VoiceAdapter {
  readonly isMock = false;
  readonly baseUrl: string;
  readonly characterId: string;
  private readonly fetchImpl: typeof fetch;
  private requestCounter = 0;

  constructor(options: Chat5VoiceAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:3002').replace(/\/$/, '');
    this.characterId = options.characterId ?? '2';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesizeDetailed(
    assistantText: string,
    _voiceId?: string,
    options?: VoiceSynthesisOptions,
  ): Promise<Chat5VoiceResult> {
    const text = String(assistantText ?? '').trim();
    if (!text) {
      throw new Error('assistantText must be non-empty');
    }

    const response = await this.fetchImpl(`${this.baseUrl}/api/voice/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        emotion: options?.performance?.voiceEmotion ?? 'auto',
        intensity: options?.performance?.intensity,
        performanceEmotion: options?.performance?.emotion,
        intent: options?.performance?.intent,
        confidence: options?.performance?.confidence,
        emphasis: options?.performance?.emphasis ?? [],
        segments: options?.performance?.segments ?? [],
        userMessage: options?.userMessage,
        includeLocalPath: true,
        charId: this.characterId,
        requestId: this.nextRequestId()
      })
    });
    const data = await response.json() as {
      success?: boolean;
      audioUrl?: string;
      /** Same-machine absolute WAV path. The HTTP URL remains the fallback. */
      localPath?: string;
      emotion?: string;
      duration?: number;
      errorCode?: string;
      error?: string;
      performance?: Partial<PerformanceSemantic>;
    };

    if (!response.ok || !data.success || typeof data.audioUrl !== 'string' || data.audioUrl.length === 0) {
      const code = data.errorCode ? ` ${data.errorCode}` : '';
      throw new Error(`Chat5 TTS failed${code}: ${data.error ?? `HTTP ${response.status}`}`);
    }

    // The Chat5 facade already materializes a validated WAV on the same
    // machine. Reading that file avoids a second HTTP round-trip and keeps
    // the synthesis path unchanged. If the path is unavailable (older
    // server/release, permissions, or a remote adapter), retain the URL
    // fallback so playback behavior does not regress.
    if (typeof data.localPath === 'string' && data.localPath.trim()) {
      try {
        const bytes = await readFile(data.localPath);
        if (bytes.byteLength >= 44) {
          return {
            wavBytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            emotion: typeof data.emotion === 'string' ? data.emotion : undefined,
            duration: typeof data.duration === 'number' ? data.duration : undefined,
            performance: data.performance && typeof data.performance === 'object'
              ? data.performance
              : undefined
          };
        }
      } catch {
        // Fall through to HTTP for compatibility with older/remote facades.
      }
    }

    const audioUrl = new URL(data.audioUrl, `${this.baseUrl}/`).toString();
    const audioResponse = await this.fetchImpl(audioUrl);
    if (!audioResponse.ok) {
      throw new Error(`Chat5 audio download failed: HTTP ${audioResponse.status}`);
    }

    return {
      wavBytes: await audioResponse.arrayBuffer(),
      emotion: typeof data.emotion === 'string' ? data.emotion : undefined,
      duration: typeof data.duration === 'number' ? data.duration : undefined,
      performance: data.performance && typeof data.performance === 'object'
        ? data.performance
        : undefined
    };
  }

  async synthesize(assistantText: string, voiceId?: string, options?: VoiceSynthesisOptions): Promise<ArrayBuffer> {
    const result = await this.synthesizeDetailed(assistantText, voiceId, options);
    return result.wavBytes;
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `chat6_${Date.now()}_${this.requestCounter}`;
  }
}
