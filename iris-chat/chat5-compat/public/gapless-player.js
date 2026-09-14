/**
 * 分段语音播放器 — 基于 Web Audio API
 * 用精确时间线调度替代 new Audio() 链，并保留可控的段间停顿
 */
class GaplessVoicePlayer {
  constructor({ prebuffer = 2, leadTime = 0.15, autoStart = true, segmentGapSeconds = 0.4 } = {}) {
    this.ctx = null;
    this.pending = new Map();   // seq -> AudioBuffer
    this.expectSeq = 0;         // 下一个应播放的序号
    this.nextStartTime = 0;    // 时间线游标
    this.started = false;
    this.prebuffer = prebuffer; // 起播前至少缓冲的连续段数
    this.leadTime = leadTime;
    this.autoStart = autoStart;
    this.segmentGapSeconds = Number.isFinite(segmentGapSeconds)
      ? Math.max(0, Number(segmentGapSeconds))
      : 0.4;
    this.startRequested = autoStart;
    this.sources = [];
    this.scheduledCount = 0;
    this.totalSegs = Infinity;
    this.totalDuration = 0;  // 累计总时长
    this.onSegmentPlay = null;
    this.onSegmentStart = null;
    this.onEnded = null;
    this.onAllScheduled = null;
    this.endedNotified = false;
    this.endTimer = null;
    this.startTimers = new Map();
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setTotal(n) { this.totalSegs = n; }

  start() {
    this.startRequested = true;
    this._drain();
  }

  async addSegment(seq, arrayBuffer) {
    this._ensureCtx();
    try {
      const buf = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
      this.pending.set(seq, buf);
    } catch (e) {
      // 解码失败，用静音占位
      const silent = this.ctx.createBuffer(
        1, Math.floor(this.ctx.sampleRate * 0.12), this.ctx.sampleRate);
      this.pending.set(seq, silent);
    }
    this._drain();
  }

  markFailed(seq) {
    this._ensureCtx();
    const silent = this.ctx.createBuffer(
      1, Math.floor(this.ctx.sampleRate * 0.12), this.ctx.sampleRate);
    this.pending.set(seq, silent);
    this._drain();
  }

  _readyToStart() {
    if (!this.startRequested) return false;
    if (this.started) return true;
    let n = 0;
    for (let s = this.expectSeq; this.pending.has(s); s++) n++;
    return n >= this.prebuffer || n >= this.totalSegs;
  }

  _drain() {
    this._ensureCtx();
    if (!this._readyToStart()) return;
    if (!this.started) {
      this.started = true;
      this.nextStartTime = this.ctx.currentTime + this.leadTime;
    }
    while (this.pending.has(this.expectSeq)) {
      const seq = this.expectSeq;
      const buf = this.pending.get(this.expectSeq);
      this.pending.delete(this.expectSeq);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      const startAt = Math.max(this.nextStartTime, this.ctx.currentTime + 0.02);
      src.start(startAt);
      // Notify at the actual timeline position, not when the source is merely
      // scheduled. This keeps Avatar lip-sync/motion aligned with audible data.
      if (this.onSegmentStart) {
        const delayMs = Math.max(0, (startAt - this.ctx.currentTime) * 1000);
        const timer = setTimeout(() => {
          this.startTimers.delete(seq);
          if (this.started && this.onSegmentStart) this.onSegmentStart(seq, startAt);
        }, delayMs);
        this.startTimers.set(seq, timer);
      }
      src.onended = () => { if (this.onSegmentPlay) this.onSegmentPlay(seq); };
      this.sources.push(src);
      // Add the requested pacing only between segments. The final segment
      // ends at its natural duration, so completion is not delayed by a
      // trailing silent gap.
      this.nextStartTime = startAt + buf.duration
        + (seq + 1 < this.totalSegs ? this.segmentGapSeconds : 0);
      this.scheduledCount++;
      this.totalDuration += buf.duration;
      this.expectSeq++;
    }
    if (this.scheduledCount >= this.totalSegs && this.onAllScheduled) {
      this.onAllScheduled();
      this.onAllScheduled = null;
    }
    if (this.scheduledCount >= this.totalSegs && this.onEnded) {
      const remainMs = Math.max(0, (this.nextStartTime - this.ctx.currentTime) * 1000);
      if (!this.endedNotified) {
        this.endedNotified = true;
        if (this.endTimer !== null) clearTimeout(this.endTimer);
        this.endTimer = setTimeout(() => {
          this.endTimer = null;
          if (this.onEnded) this.onEnded();
        }, remainMs);
      }
    }
  }

  stop() {
    if (this.endTimer !== null) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    for (const timer of this.startTimers.values()) clearTimeout(timer);
    this.startTimers.clear();
    this.sources.forEach(s => { try { s.stop(); } catch (e) {} });
    this.sources = [];
    this.pending.clear();
    this.started = false;
    this.expectSeq = 0;
    this.scheduledCount = 0;
    this.totalDuration = 0;
    this.nextStartTime = 0;
    this.totalSegs = Infinity;
    this.endedNotified = false;
    this.startRequested = this.autoStart;
  }

  getDuration() {
    return this.totalDuration;
  }
}

if (typeof globalThis !== 'undefined') globalThis.GaplessVoicePlayer = GaplessVoicePlayer;
if (typeof module === 'object' && module.exports) module.exports = { GaplessVoicePlayer };
