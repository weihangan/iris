export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

export interface VoiceInputTrack {
  stop(): void;
}

export interface VoiceInputStream {
  getTracks(): readonly VoiceInputTrack[];
}

export interface VoiceInputRecorder {
  readonly state: string;
  readonly mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onerror: ((error: unknown) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface VoiceTranscriptionResult {
  readonly success: boolean;
  readonly text?: string;
  readonly error?: string;
}

export interface VoiceInputControllerOptions {
  readonly requestStream: () => Promise<VoiceInputStream>;
  readonly createRecorder: (stream: VoiceInputStream) => VoiceInputRecorder;
  readonly transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<VoiceTranscriptionResult>;
  readonly onStateChange?: (state: VoiceInputState) => void;
  readonly onTranscript?: (text: string) => void;
  readonly onError?: (message: string) => void;
  readonly maxDurationMs?: number;
}

export interface VoiceInputBindingOptions {
  readonly button: HTMLButtonElement;
  readonly input: HTMLInputElement;
  readonly transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<VoiceTranscriptionResult>;
  readonly onError: (message: string) => void;
  readonly maxDurationMs?: number;
}

/** Browser-independent recording lifecycle; renderers supply the platform and UI bindings. */
export class VoiceInputController {
  private readonly maxDurationMs: number;
  private state: VoiceInputState = 'idle';
  private stream: VoiceInputStream | null = null;
  private recorder: VoiceInputRecorder | null = null;
  private chunks: Blob[] = [];
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(private readonly options: VoiceInputControllerOptions) {
    this.maxDurationMs = Math.min(30_000, Math.max(5_000, options.maxDurationMs ?? 30_000));
  }

  getState(): VoiceInputState {
    return this.state;
  }

  async start(): Promise<boolean> {
    if (this.state !== 'idle') return false;

    const generation = ++this.generation;
    try {
      const stream = await this.options.requestStream();
      if (generation !== this.generation) {
        this.stopTracks(stream);
        return false;
      }

      const recorder = this.options.createRecorder(stream);
      this.stream = stream;
      this.recorder = recorder;
      this.chunks = [];
      recorder.ondataavailable = event => {
        if (generation === this.generation && event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.onerror = error => this.fail(generation, this.formatError(error, '录音失败'));
      recorder.onstop = () => { void this.finishRecording(generation, recorder.mimeType || 'audio/webm'); };
      recorder.start();
      this.setState('recording');
      this.stopTimer = setTimeout(() => this.stop(), this.maxDurationMs);
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.release();
        this.setState('idle');
        this.options.onError?.(`无法使用麦克风：${this.formatError(error, '请检查权限')}`);
      }
      return false;
    }
  }

  stop(): boolean {
    if (this.state !== 'recording' || !this.recorder) return false;
    this.clearStopTimer();
    this.setState('transcribing');
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      else void this.finishRecording(this.generation, this.recorder.mimeType || 'audio/webm');
      return true;
    } catch (error) {
      this.fail(this.generation, this.formatError(error, '停止录音失败'));
      return false;
    }
  }

  cancel(): void {
    if (this.state === 'idle') return;
    ++this.generation;
    this.clearStopTimer();
    const recorder = this.recorder;
    this.release();
    this.setState('idle');
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* Recording has already stopped. */ }
    }
  }

  dispose(): void {
    this.cancel();
  }

  private async finishRecording(generation: number, mimeType: string): Promise<void> {
    if (generation !== this.generation || this.state === 'idle') return;
    this.clearStopTimer();
    const chunks = this.chunks;
    this.release();
    if (chunks.length === 0) {
      this.fail(generation, '没有录到可识别的语音，请重试。');
      return;
    }

    try {
      const audio = await new Blob(chunks, { type: mimeType }).arrayBuffer();
      if (generation !== this.generation) return;
      const result = await this.options.transcribe(audio, mimeType);
      if (generation !== this.generation) return;
      const text = String(result.text || '').trim();
      if (!result.success || !text) {
        this.fail(generation, result.error || '没有识别到清晰的语音，请重试。');
        return;
      }
      this.options.onTranscript?.(text);
      this.setState('idle');
    } catch (error) {
      this.fail(generation, this.formatError(error, '语音识别失败'));
    }
  }

  private fail(generation: number, message: string): void {
    if (generation !== this.generation) return;
    this.clearStopTimer();
    this.release();
    this.setState('idle');
    this.options.onError?.(message);
  }

  private release(): void {
    if (this.stream) this.stopTracks(this.stream);
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }

  private stopTracks(stream: VoiceInputStream): void {
    for (const track of stream.getTracks()) track.stop();
  }

  private clearStopTimer(): void {
    if (this.stopTimer !== null) clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }

  private setState(state: VoiceInputState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private formatError(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }
}

/** Wires the shared controller to one renderer's microphone button and text input. */
export function bindVoiceInput(options: VoiceInputBindingOptions): { dispose(): void } {
  const { button, input } = options;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    button.disabled = true;
    button.title = '当前环境不支持语音输入';
    return { dispose: () => undefined };
  }

  const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const mimeType = preferredTypes.find(type => MediaRecorder.isTypeSupported(type));
  const renderState = (state: VoiceInputState): void => {
    button.dataset.voiceState = state;
    button.classList.toggle('listening', state === 'recording');
    button.classList.toggle('transcribing', state === 'transcribing');
    button.setAttribute('aria-pressed', String(state === 'recording'));
    if (state === 'recording') {
      button.disabled = false;
      button.title = '停止录音并本地识别（最长30秒）';
      button.textContent = '■';
    } else if (state === 'transcribing') {
      button.disabled = true;
      button.title = '正在本地识别语音';
      button.textContent = '…';
    } else {
      button.disabled = false;
      button.title = '开始本地语音输入（最长30秒）';
      button.textContent = '🎙';
    }
    button.setAttribute('aria-label', button.title);
  };

  const controller = new VoiceInputController({
    requestStream: async () => navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }),
    createRecorder: stream => mimeType
      ? new MediaRecorder(stream as MediaStream, { mimeType }) as unknown as VoiceInputRecorder
      : new MediaRecorder(stream as MediaStream) as unknown as VoiceInputRecorder,
    transcribe: options.transcribe,
    maxDurationMs: options.maxDurationMs,
    onStateChange: renderState,
    onTranscript: text => {
      input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    },
    onError: options.onError,
  });

  const onClick = (): void => {
    if (controller.getState() === 'recording') controller.stop();
    else if (controller.getState() === 'idle') void controller.start();
  };
  button.addEventListener('click', onClick);
  renderState('idle');

  return {
    dispose: () => {
      button.removeEventListener('click', onClick);
      controller.dispose();
    }
  };
}
