/** Audio-clock lip timeline for the PMX A/I/U/E/O morph set. */

export type CanonicalViseme = 'A' | 'I' | 'U' | 'E' | 'O' | 'CLOSED';
export type MouthViseme = Exclude<CanonicalViseme, 'CLOSED'>;
export type VisemeWeights = Record<MouthViseme, number>;

export interface VisemeKeyframe {
  readonly time: number;
  readonly viseme: CanonicalViseme;
  readonly weights: VisemeWeights;
  /** Compatibility fields retained for existing diagnostics. */
  readonly morph: string;
  readonly weight: number;
}

const FRAME_SECONDS = 0.025;
const SILENCE_RMS = 0.012;
const MORPH_BY_VISEME: Record<MouthViseme, string> = {
  A: 'あ', I: 'い', U: 'う', E: 'え', O: 'お'
};

export interface LipTimelineOptions {
  readonly frameSeconds?: number;
}

export function emptyVisemeWeights(): VisemeWeights {
  return { A: 0, I: 0, U: 0, E: 0, O: 0 };
}

interface ParsedPcm {
  readonly sampleRate: number;
  readonly samples: Float32Array;
  readonly duration: number;
}

function readId(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3)
  );
}

function parsePcmWav(wav: ArrayBuffer): ParsedPcm | null {
  if (!wav || wav.byteLength < 44) return null;
  try {
    const view = new DataView(wav);
    if (readId(view, 0) !== 'RIFF' || readId(view, 8) !== 'WAVE') return null;
    let channels = 0;
    let sampleRate = 0;
    let format = 0;
    let bits = 0;
    let dataOffset = -1;
    let dataSize = 0;
    for (let offset = 12; offset + 8 <= wav.byteLength;) {
      const id = readId(view, offset);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (body + size > wav.byteLength) return null;
      if (id === 'fmt ' && size >= 16) {
        format = view.getUint16(body, true);
        channels = view.getUint16(body + 2, true);
        sampleRate = view.getUint32(body + 4, true);
        bits = view.getUint16(body + 14, true);
      } else if (id === 'data') {
        dataOffset = body;
        dataSize = size;
        break;
      }
      offset = body + size + (size % 2);
    }
    if (format !== 1 || channels < 1 || sampleRate < 1 || bits !== 16 || dataOffset < 0) return null;
    const frameCount = Math.floor(dataSize / 2 / channels);
    if (frameCount < 1) return null;
    const samples = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame++) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel++) {
        sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 32768;
      }
      samples[frame] = sum / channels;
    }
    return { sampleRate, samples, duration: frameCount / sampleRate };
  } catch {
    return null;
  }
}

function rmsAt(pcm: ParsedPcm, time: number): number {
  const halfWindow = Math.max(1, Math.floor(pcm.sampleRate * 0.0125));
  const center = Math.floor(time * pcm.sampleRate);
  const start = Math.max(0, center - halfWindow);
  const end = Math.min(pcm.samples.length, center + halfWindow);
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += pcm.samples[i] * pcm.samples[i];
  return Math.sqrt(sum / (end - start));
}

// A replaceable pronunciation-hint mapper. Timed phonemes from a real TTS
// adapter can enter through fromAdapter without changing the renderer.
const DIRECT_HINTS: Record<string, MouthViseme> = {
  '啊': 'A', '阿': 'A', '呀': 'A', '啦': 'A', '吗': 'A', '吧': 'A',
  '一': 'I', '你': 'I', '里': 'I', '意': 'I', '已': 'I', '咿': 'I',
  '不': 'U', '无': 'U', '呜': 'U', '我': 'O', '哦': 'O', '喔': 'O',
  '诶': 'E', '欸': 'E', '也': 'E', '的': 'E', '了': 'E',
  a: 'A', i: 'I', u: 'U', e: 'E', o: 'O', y: 'U', v: 'U'
};

function textVisemes(text?: string): MouthViseme[] {
  if (!text) return ['A'];
  const result: MouthViseme[] = [];
  for (const raw of text.toLowerCase()) {
    if (/\s|[，。！？、,.!?;；:：]/u.test(raw)) continue;
    const direct = DIRECT_HINTS[raw];
    if (direct) result.push(direct);
  }
  return result.length > 0 ? result : ['A'];
}

function normalize(weights: VisemeWeights): VisemeWeights {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (total <= 1) return weights;
  return {
    A: weights.A / total, I: weights.I / total, U: weights.U / total,
    E: weights.E / total, O: weights.O / total
  };
}

function dominant(weights: VisemeWeights): { viseme: CanonicalViseme; weight: number } {
  let viseme: CanonicalViseme = 'CLOSED';
  let weight = 0;
  for (const name of ['A', 'I', 'U', 'E', 'O'] as const) {
    if (weights[name] > weight) {
      viseme = name;
      weight = weights[name];
    }
  }
  return { viseme, weight };
}

export class LipTimeline {
  fromWav(wavBytes: ArrayBuffer, speechText?: string, options: LipTimelineOptions = {}): VisemeKeyframe[] {
    const pcm = parsePcmWav(wavBytes);
    if (!pcm || pcm.duration < 0.05) return [];
    const frameSeconds = Number.isFinite(options.frameSeconds)
      ? Math.max(1 / 120, Math.min(0.1, options.frameSeconds!))
      : FRAME_SECONDS;
    const hints = textVisemes(speechText);
    const frameCount = Math.ceil(pcm.duration / frameSeconds);
    const frames: VisemeKeyframe[] = [];
    for (let index = 0; index <= frameCount; index++) {
      const time = Math.min(pcm.duration, index * frameSeconds);
      const rms = rmsAt(pcm, time);
      let weights = emptyVisemeWeights();
      if (index > 0 && index < frameCount && rms >= SILENCE_RMS) {
        const position = (time / Math.max(pcm.duration, frameSeconds)) * hints.length;
        const currentIndex = Math.min(hints.length - 1, Math.floor(position));
        const nextIndex = Math.min(hints.length - 1, currentIndex + 1);
        const blend = position - Math.floor(position);
        const envelope = Math.min(0.98, Math.max(0.28, rms * 6.2));
        weights[hints[currentIndex]] += envelope * (1 - blend);
        weights[hints[nextIndex]] += envelope * blend;
        weights = normalize(weights);
      }
      const peak = dominant(weights);
      frames.push({
        time: Math.round(time * 1000) / 1000,
        viseme: peak.viseme,
        weights,
        morph: peak.viseme === 'CLOSED' ? 'あ' : MORPH_BY_VISEME[peak.viseme],
        weight: peak.weight
      });
    }
    return frames;
  }

  fromAdapter(visemes: VisemeKeyframe[]): VisemeKeyframe[] {
    return visemes.map(frame => ({ ...frame, weights: { ...frame.weights } }));
  }

  sampleAt(frames: readonly VisemeKeyframe[], time: number): VisemeWeights {
    if (frames.length === 0) return emptyVisemeWeights();
    if (time <= frames[0].time) return { ...frames[0].weights };
    const last = frames[frames.length - 1];
    if (time >= last.time) return { ...last.weights };
    let low = 1;
    let high = frames.length - 1;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (frames[middle].time < time) low = middle + 1;
      else high = middle;
    }
    const right = low;
    const before = frames[right - 1];
    const after = frames[right];
    const mix = (time - before.time) / Math.max(0.000001, after.time - before.time);
    return normalize({
      A: before.weights.A + (after.weights.A - before.weights.A) * mix,
      I: before.weights.I + (after.weights.I - before.weights.I) * mix,
      U: before.weights.U + (after.weights.U - before.weights.U) * mix,
      E: before.weights.E + (after.weights.E - before.weights.E) * mix,
      O: before.weights.O + (after.weights.O - before.weights.O) * mix
    });
  }
}
