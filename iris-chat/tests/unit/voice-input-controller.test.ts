import { describe, expect, it, vi } from 'vitest';
import {
  VoiceInputController,
  type VoiceInputRecorder,
  type VoiceInputStream,
} from '../../src/voice-input-controller';

class FakeRecorder implements VoiceInputRecorder {
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onstop: (() => void) | null = null;

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function createStream(): { stream: VoiceInputStream; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }] }, stop };
}

describe('VoiceInputController', () => {
  it('records, transcribes, and releases the microphone before returning idle', async () => {
    const { stream, stop } = createStream();
    const recorder = new FakeRecorder();
    const transcript = vi.fn();
    const transcribe = vi.fn().mockResolvedValue({ success: true, text: '语音识别结果' });
    const controller = new VoiceInputController({
      requestStream: vi.fn().mockResolvedValue(stream),
      createRecorder: () => recorder,
      transcribe,
      onTranscript: transcript,
    });

    await expect(controller.start()).resolves.toBe(true);
    expect(controller.getState()).toBe('recording');
    expect(controller.stop()).toBe(true);
    await vi.waitFor(() => expect(transcript).toHaveBeenCalledWith('语音识别结果'));

    expect(transcribe).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'audio/webm');
    expect(stop).toHaveBeenCalledOnce();
    expect(controller.getState()).toBe('idle');
  });

  it('does not transcribe a cancelled recording and always releases its track', async () => {
    const { stream, stop } = createStream();
    const recorder = new FakeRecorder();
    const transcribe = vi.fn();
    const controller = new VoiceInputController({
      requestStream: vi.fn().mockResolvedValue(stream),
      createRecorder: () => recorder,
      transcribe,
    });

    await controller.start();
    controller.cancel();
    await Promise.resolve();

    expect(transcribe).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(controller.getState()).toBe('idle');
  });

  it('reports an unavailable microphone without leaving the control busy', async () => {
    const onError = vi.fn();
    const controller = new VoiceInputController({
      requestStream: vi.fn().mockRejectedValue(new Error('Permission denied')),
      createRecorder: () => new FakeRecorder(),
      transcribe: vi.fn(),
      onError,
    });

    await expect(controller.start()).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith('无法使用麦克风：Permission denied');
    expect(controller.getState()).toBe('idle');
  });

  it('hard-stops recording at 30 seconds even when a longer duration is requested', async () => {
    vi.useFakeTimers();
    try {
      const { stream } = createStream();
      const recorder = new FakeRecorder();
      const stop = vi.spyOn(recorder, 'stop');
      const controller = new VoiceInputController({
        requestStream: vi.fn().mockResolvedValue(stream),
        createRecorder: () => recorder,
        transcribe: vi.fn().mockResolvedValue({ success: true, text: '完成' }),
        maxDurationMs: 60_000,
      });

      await controller.start();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
