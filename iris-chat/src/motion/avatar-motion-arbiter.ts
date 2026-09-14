export type AvatarMotionMode = 'idle' | 'manual-preview' | 'speech';

export type PreviewRequestDecision =
  | { accepted: true; requestId: number }
  | { accepted: false; reason: 'speech-active' | 'pose-locked' };

/**
 * Owns only high-level playback priority. Bone and morph ownership remain in
 * their dedicated registries.
 */
export class AvatarMotionArbiter {
  private mode: AvatarMotionMode = 'idle';
  private previewGeneration = 0;
  private speechGeneration = 0;
  private _idlePaused = false;
  private _poseLocked = false;

  getMode(): AvatarMotionMode {
    return this.mode;
  }

  canRunIdle(): boolean {
    return this.mode === 'idle' && !this._idlePaused && !this._poseLocked;
  }

  /**
   * The selected default VMD is the desktop base, not an episodic idle
   * action. It remains available while the user pauses the idle pool.
   */
  canRunDefaultIdle(): boolean {
    return this.mode === 'idle' && !this._poseLocked;
  }

  canRunSpeechMotion(): boolean {
    return !this._poseLocked;
  }

  isPoseLocked(): boolean {
    return this._poseLocked;
  }

  setPoseLocked(value: boolean): boolean {
    // Lock/unlock is a deliberate idle-only command. A running preview or
    // spoken reply must not change its body ownership because of a UI click.
    if (value !== this._poseLocked && this.mode !== 'idle') return this._poseLocked;
    this._poseLocked = value;
    if (value) this.previewGeneration += 1;
    return this._poseLocked;
  }

  isIdlePaused(): boolean {
    return this._idlePaused;
  }

  toggleIdlePaused(): boolean {
    this._idlePaused = !this._idlePaused;
    return this._idlePaused;
  }

  setIdlePaused(value: boolean): boolean {
    this._idlePaused = value;
    return this._idlePaused;
  }

  requestPreview(): PreviewRequestDecision {
    if (this._poseLocked) {
      return { accepted: false, reason: 'pose-locked' };
    }
    if (this.mode === 'speech') {
      return { accepted: false, reason: 'speech-active' };
    }
    this.mode = 'manual-preview';
    this.previewGeneration += 1;
    return { accepted: true, requestId: this.previewGeneration };
  }

  isCurrentPreview(requestId: number): boolean {
    return this.mode === 'manual-preview' && requestId === this.previewGeneration;
  }

  finishPreview(requestId: number): boolean {
    if (!this.isCurrentPreview(requestId)) return false;
    this.mode = 'idle';
    return true;
  }

  beginSpeech(): number {
    this.previewGeneration += 1;
    this.speechGeneration += 1;
    this.mode = 'speech';
    return this.speechGeneration;
  }

  isCurrentSpeech(generation: number): boolean {
    return this.mode === 'speech' && generation === this.speechGeneration;
  }

  endSpeech(generation: number): boolean {
    if (!this.isCurrentSpeech(generation)) return false;
    this.mode = 'idle';
    return true;
  }

  reset(): void {
    this.previewGeneration += 1;
    this.speechGeneration += 1;
    this.mode = 'idle';
    this._poseLocked = false;
  }
}
