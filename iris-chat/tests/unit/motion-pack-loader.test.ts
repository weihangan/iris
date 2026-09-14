import { describe, it, expect } from 'vitest';
import {
  loadVmd,
  computeSha256,
  retargetBones,
  applyAmplitudeLimits,
  DEFAULT_AMPLITUDE_LIMITS,
  SPEECH_AMPLITUDE_LIMITS,
  extractBoneNames,
  extractMorphNames,
  hasBlinkTrack,
  filterAnimationTracks,
  hasCompatibleBoneTracks,
  getVmdParseCacheStats,
  resetVmdParseCacheStats,
  type LoadedVmd
} from '../../src/motion/motion-pack-loader';

describe('hasCompatibleBoneTracks', () => {
  it('returns true only when a parsed VMD track exists in the model skeleton', () => {
    const loaded = { boneTracks: { Head: {}, Missing: {} } } as any;
    expect(hasCompatibleBoneTracks(loaded, new Set(['Head']))).toBe(true);
    expect(hasCompatibleBoneTracks(loaded, new Set(['全ての親']))).toBe(false);
  });
});

// 构造最小合法 VMD 字节序列用于测试
// VMD 格式：30 字节 magic "Vocaloid Motion Data 0002" + 20 字节 model name (shift-jis) +
// 4 字节 bone frame count + (15 字节 shift-jis 骨骼名 + 4 字节 frame + 12 字节 translation + 16 字节 rotation + 64 字节 interpolation) * frame_count +
// 4 字节 morph frame count + (15 字节 shift-jis morph 名 + 4 字节 frame + 4 字节 weight) * morph_frame_count +
// 4 字节 camera count + 4 字节 light count + 4 字节 shadow count + 4 字节 property count
//
// 注意：VMD 骨骼名和 morph 名都是 shift-jis 编码。Node.js 的 TextEncoder 只支持 utf-8，
// 但 Buffer.iconv 或 node:buffer 的 Buffer.from(str, 'shift-jis') 在 Node 24 可用。
// 日文字符（頭/上半身/左肩/右肩/まばたき）在 shift-jis 中是 2 字节，utf-8 中是 3 字节。
// 为了避免编码问题，测试中优先使用 ASCII 名称（Head, UpperBody, FaceRed）；
// 日文名称的测试单独处理（如果 Node shift-jis 编码可用则用，否则跳过）。

function encodeShiftJis(text: string, fixedLength: number): Uint8Array {
  // Node.js Buffer 支持 shift-jis 编码（通过 ICU）
  // 注意：TypeScript DOM lib 中 BufferEncoding 不含 shift-jis，需要强制断言
  try {
    const buf = Buffer.from(text, 'shift-jis' as BufferEncoding);
    const result = new Uint8Array(fixedLength);
    result.set(buf.subarray(0, fixedLength));
    return result;
  } catch {
    // 如果 shift-jis 不可用，用 utf-8 fallback（仅 ASCII 名称测试）
    const encoded = new TextEncoder().encode(text);
    const result = new Uint8Array(fixedLength);
    result.set(encoded.slice(0, fixedLength));
    return result;
  }
}

function buildMinimalVmd(opts: {
  boneTracks?: Array<{ name: string; frames: number[] }>;
  morphTracks?: Array<{ name: string; frames: number[] }>;
}): ArrayBuffer {
  // VMD magic: "Vocaloid Motion Data 0002" (30 bytes, ascii)
  const magic = new Uint8Array(30);
  magic.set(new TextEncoder().encode('Vocaloid Motion Data 0002'));
  // Model name: 20 bytes (shift-jis, 0-padded)
  const modelName = new Uint8Array(20);

  // VMD 格式：bone frame count 是所有骨骼帧的总数
  const boneTracks = opts.boneTracks ?? [];
  const totalBoneFrames = boneTracks.reduce((s, t) => s + t.frames.length, 0);
  const boneCountBuf = new Uint32Array([totalBoneFrames]);

  const boneTrackBytes: Uint8Array[] = [];
  for (const track of boneTracks) {
    const nameBytes = encodeShiftJis(track.name, 15);
    for (const frameNum of track.frames) {
      boneTrackBytes.push(nameBytes);
      const frame = new Uint8Array(4 + 12 + 16 + 64); // 96 bytes per bone frame
      new Uint32Array(frame.buffer, 0, 1)[0] = frameNum;
      // rotation (16 bytes, 4 floats at offset 16): identity quaternion (0,0,0,1)
      new Float32Array(frame.buffer, 16, 4)[3] = 1.0;
      // interpolation (64 bytes): default linear (20, 20, 80, 80) per 4-byte group
      for (let i = 32; i < 96; i += 4) {
        frame[i] = 20; frame[i + 1] = 20; frame[i + 2] = 80; frame[i + 3] = 80;
      }
      boneTrackBytes.push(frame);
    }
  }

  const morphTracks = opts.morphTracks ?? [];
  const totalMorphFrames = morphTracks.reduce((s, t) => s + t.frames.length, 0);
  const morphCountBuf = new Uint32Array([totalMorphFrames]);
  const morphTrackBytes: Uint8Array[] = [];
  for (const track of morphTracks) {
    const nameBytes = encodeShiftJis(track.name, 15);
    for (const frameNum of track.frames) {
      morphTrackBytes.push(nameBytes);
      const frame = new Uint8Array(4 + 4); // 8 bytes per morph frame: frame(4) + weight(4)
      new Uint32Array(frame.buffer, 0, 1)[0] = frameNum;
      new Float32Array(frame.buffer, 4, 1)[0] = 0.5; // default weight
      morphTrackBytes.push(frame);
    }
  }

  // Camera/Light/Shadow/Property counts: 0
  const zeroCounts = new Uint32Array(4);

  const total = magic.length + modelName.length + boneCountBuf.byteLength +
    boneTrackBytes.reduce((s, b) => s + b.length, 0) +
    morphCountBuf.byteLength +
    morphTrackBytes.reduce((s, b) => s + b.length, 0) +
    zeroCounts.byteLength;
  const buf = new Uint8Array(total);
  let offset = 0;
  buf.set(magic, offset); offset += magic.length;
  buf.set(modelName, offset); offset += modelName.length;
  buf.set(new Uint8Array(boneCountBuf.buffer), offset); offset += boneCountBuf.byteLength;
  for (const b of boneTrackBytes) { buf.set(b, offset); offset += b.length; }
  buf.set(new Uint8Array(morphCountBuf.buffer), offset); offset += morphCountBuf.byteLength;
  for (const b of morphTrackBytes) { buf.set(b, offset); offset += b.length; }
  buf.set(new Uint8Array(zeroCounts.buffer), offset); offset += zeroCounts.byteLength;
  return buf.buffer;
}

describe('motion-pack-loader', () => {
  describe('computeSha256', () => {
    it('空字节数组的 SHA-256', async () => {
      const hash = await computeSha256(new ArrayBuffer(0));
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('abc 的 SHA-256', async () => {
      const hash = await computeSha256(new TextEncoder().encode('abc').buffer);
      expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('返回 64 字符十六进制', async () => {
      const hash = await computeSha256(new ArrayBuffer(10));
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('loadVmd', () => {
    it('parses the same byte object once and returns independent working track maps', async () => {
      resetVmdParseCacheStats();
      const bytes = new Uint8Array(buildMinimalVmd({
        boneTracks: [{ name: 'Head', frames: [0] }]
      }));

      const first = await loadVmd(bytes);
      delete first.boneTracks.Head;
      const second = await loadVmd(bytes);

      expect(getVmdParseCacheStats()).toMatchObject({ hits: 1, misses: 1, parses: 1 });
      expect(second.boneTracks).toHaveProperty('Head');
      expect(second.boneTracks).not.toBe(first.boneTracks);
      expect(second.animation).not.toBe(first.animation);
    });

    it('reports real parse and cache-hit timings for runtime diagnostics', async () => {
      resetVmdParseCacheStats();
      const bytes = new Uint8Array(buildMinimalVmd({
        boneTracks: [{ name: 'Head', frames: [0, 15, 30] }]
      }));

      await loadVmd(bytes);
      const afterParse = getVmdParseCacheStats();
      await loadVmd(bytes);
      const afterHit = getVmdParseCacheStats();

      expect(afterParse.lastParseMilliseconds).toBeGreaterThanOrEqual(0);
      expect(afterParse.totalParseMilliseconds).toBeGreaterThanOrEqual(afterParse.lastParseMilliseconds);
      expect(afterHit.lastCacheHitMilliseconds).toBeGreaterThanOrEqual(0);
      expect(afterHit.totalCacheHitMilliseconds).toBeGreaterThanOrEqual(afterHit.lastCacheHitMilliseconds);
      expect(afterHit.hits).toBe(1);
      expect(afterHit.parses).toBe(1);
    });

    it('does not collide different VMD byte objects', async () => {
      resetVmdParseCacheStats();
      const firstBytes = new Uint8Array(buildMinimalVmd({ boneTracks: [{ name: 'Head', frames: [0] }] }));
      const secondBytes = new Uint8Array(buildMinimalVmd({ boneTracks: [{ name: 'Arm', frames: [0] }] }));

      await loadVmd(firstBytes);
      await loadVmd(secondBytes);

      expect(getVmdParseCacheStats()).toMatchObject({ hits: 0, misses: 2, parses: 2 });
    });

    it('合法 VMD 字节（ASCII 骨骼名）→ 返回 LoadedVmd 对象', async () => {
      const bytes = buildMinimalVmd({
        boneTracks: [{ name: 'Head', frames: [0] }]
      });
      const result = await loadVmd(bytes);
      expect(result).toBeDefined();
      expect(result.bytes).toBeInstanceOf(Uint8Array);
      expect(result.boneTracks).toHaveProperty('Head');
    });

    it('合法 VMD 字节（日文骨骼名，shift-jis 可用时）→ 返回 LoadedVmd 对象', async () => {
      // 检查 Node.js 是否支持 shift-jis 编码
      let shiftJisAvailable = false;
      try {
        const testBuf = Buffer.from('頭', 'shift-jis' as BufferEncoding);
        shiftJisAvailable = testBuf.length === 2 && testBuf[0] === 0x93 && testBuf[1] === 0xaa;
      } catch { /* not available */ }

      if (!shiftJisAvailable) {
        console.log('shift-jis encoding not available, skipping Japanese bone name test');
        return;
      }

      const bytes = buildMinimalVmd({
        boneTracks: [{ name: '頭', frames: [0] }]
      });
      const result = await loadVmd(bytes);
      expect(result.boneTracks).toHaveProperty('頭');
    });

    it('非法字节（magic 错误）→ 抛错 fail-closed', async () => {
      const badBytes = new ArrayBuffer(50);
      await expect(loadVmd(badBytes)).rejects.toThrow();
    });

    it('空字节 → 抛错', async () => {
      await expect(loadVmd(new ArrayBuffer(0))).rejects.toThrow();
    });

    it('多骨骼轨道', async () => {
      const bytes = buildMinimalVmd({
        boneTracks: [
          { name: 'Head', frames: [0, 10] },
          { name: 'UpperBody', frames: [0] },
          { name: 'LeftShoulder', frames: [0] }
        ]
      });
      const result = await loadVmd(bytes);
      expect(Object.keys(result.boneTracks)).toHaveLength(3);
    });

    it('包含 morph 轨道（Blink）', async () => {
      const bytes = buildMinimalVmd({
        morphTracks: [{ name: 'Blink', frames: [0, 30] }]
      });
      const result = await loadVmd(bytes);
      expect(result.morphTracks).toHaveProperty('Blink');
    });
  });

  describe('extractBoneNames', () => {
    it('返回 VMD 中所有骨骼名', async () => {
      const bytes = buildMinimalVmd({
        boneTracks: [
          { name: 'Head', frames: [0] },
          { name: 'UpperBody', frames: [0] }
        ]
      });
      const loaded = await loadVmd(bytes);
      const names = extractBoneNames(loaded);
      expect(names).toContain('Head');
      expect(names).toContain('UpperBody');
      expect(names).toHaveLength(2);
    });
  });

  describe('extractMorphNames', () => {
    it('返回 VMD 中所有 morph 名', async () => {
      const bytes = buildMinimalVmd({
        morphTracks: [
          { name: 'Blink', frames: [0] },
          { name: 'MouthA', frames: [0] }
        ]
      });
      const loaded = await loadVmd(bytes);
      const names = extractMorphNames(loaded);
      expect(names).toContain('Blink');
      expect(names).toContain('MouthA');
    });
  });

  describe('hasBlinkTrack', () => {
    it('包含 まばたき（shift-jis 可用时）→ true', async () => {
      let shiftJisAvailable = false;
      try {
        const testBuf = Buffer.from('まばたき', 'shift-jis' as BufferEncoding);
        shiftJisAvailable = testBuf.length > 0;
      } catch { /* not available */ }
      if (!shiftJisAvailable) return;

      const bytes = buildMinimalVmd({
        morphTracks: [{ name: 'まばたき', frames: [0] }]
      });
      const loaded = await loadVmd(bytes);
      expect(hasBlinkTrack(loaded)).toBe(true);
    });

    it('不包含 まばたき → false', async () => {
      const bytes = buildMinimalVmd({});
      const loaded = await loadVmd(bytes);
      expect(hasBlinkTrack(loaded)).toBe(false);
    });
  });

  describe('retargetBones', () => {
    it('VMD 骨骼名 → 模型骨骼名映射（同名）', async () => {
      const bytes = buildMinimalVmd({
        boneTracks: [{ name: 'Head', frames: [0] }]
      });
      const loaded = await loadVmd(bytes);
      const retargeted = retargetBones(loaded, { 'Head': 'Head' });
      expect(retargeted.boneTracks).toHaveProperty('Head');
    });

    it('VMD 使用别名时映射到模型骨骼名', async () => {
      const bytes = buildMinimalVmd({
        boneTracks: [{ name: 'Head', frames: [0] }]
      });
      const loaded = await loadVmd(bytes);
      const retargeted = retargetBones(loaded, { 'Head': '頭' });
      expect(retargeted.boneTracks).toHaveProperty('頭');
      expect(retargeted.boneTracks).not.toHaveProperty('Head');
      expect(retargeted.animation.boneTracks).toHaveProperty('頭');
      expect(retargeted.animation.boneTracks).not.toHaveProperty('Head');
    });

    it('未在 mapping 中的骨骼保留原名', async () => {
      const bytes = buildMinimalVmd({
        boneTracks: [
          { name: 'Head', frames: [0] },
          { name: 'Unknown', frames: [0] }
        ]
      });
      const loaded = await loadVmd(bytes);
      const retargeted = retargetBones(loaded, { 'Head': '頭' });
      expect(retargeted.boneTracks).toHaveProperty('頭');
      expect(retargeted.boneTracks).toHaveProperty('Unknown');
    });
  });

  describe('DEFAULT_AMPLITUDE_LIMITS', () => {
    it('头 ±30 度 / 上半身 ±20 度 / 肩 ±15 度 / FaceRed ≤ 0.35', () => {
      expect(DEFAULT_AMPLITUDE_LIMITS.head.x).toBe(30);
      expect(DEFAULT_AMPLITUDE_LIMITS.head.y).toBe(30);
      expect(DEFAULT_AMPLITUDE_LIMITS.head.z).toBe(30);
      expect(DEFAULT_AMPLITUDE_LIMITS.upperBody.x).toBe(20);
      expect(DEFAULT_AMPLITUDE_LIMITS.upperBody.y).toBe(20);
      expect(DEFAULT_AMPLITUDE_LIMITS.upperBody.z).toBe(20);
      expect(DEFAULT_AMPLITUDE_LIMITS.shoulder.x).toBe(15);
      expect(DEFAULT_AMPLITUDE_LIMITS.shoulder.y).toBe(15);
      expect(DEFAULT_AMPLITUDE_LIMITS.shoulder.z).toBe(15);
      expect(DEFAULT_AMPLITUDE_LIMITS.faceRedMax).toBe(0.35);
    });
  });

  describe('SPEECH_AMPLITUDE_LIMITS', () => {
    it('keeps cumulative upper-body and head motion restrained during dialogue', () => {
      expect(SPEECH_AMPLITUDE_LIMITS.head.x).toBeLessThanOrEqual(12);
      expect(SPEECH_AMPLITUDE_LIMITS.head.y).toBeLessThanOrEqual(18);
      expect(SPEECH_AMPLITUDE_LIMITS.head.z).toBeLessThanOrEqual(12);
      expect(SPEECH_AMPLITUDE_LIMITS.upperBody.x).toBeLessThanOrEqual(12);
      expect(SPEECH_AMPLITUDE_LIMITS.shoulder.x).toBeLessThanOrEqual(12);
      expect(SPEECH_AMPLITUDE_LIMITS.head.y).toBeLessThanOrEqual(14);
      expect(SPEECH_AMPLITUDE_LIMITS.upperBody.y).toBeLessThanOrEqual(10);
      expect(SPEECH_AMPLITUDE_LIMITS.shoulder.x).toBeLessThanOrEqual(8);
      expect(SPEECH_AMPLITUDE_LIMITS.shoulder.y).toBeLessThanOrEqual(8);
      expect(SPEECH_AMPLITUDE_LIMITS.shoulder.z).toBeLessThanOrEqual(8);
      expect(SPEECH_AMPLITUDE_LIMITS.arm).toEqual({ x: 32, y: 32, z: 32 });
      expect(SPEECH_AMPLITUDE_LIMITS.elbow).toEqual({ x: 50, y: 50, z: 50 });
      expect(SPEECH_AMPLITUDE_LIMITS.wrist).toEqual({ x: 32, y: 32, z: 32 });
      expect(SPEECH_AMPLITUDE_LIMITS.head).toEqual({ x: 8, y: 10, z: 6 });
      expect(SPEECH_AMPLITUDE_LIMITS.upperBody).toEqual({ x: 6, y: 6, z: 5 });
      expect(DEFAULT_AMPLITUDE_LIMITS.arm).toBeUndefined();
    });
  });

  describe('applyAmplitudeLimits', () => {
    it('返回新的 LoadedVmd，不修改原对象', async () => {
      const bytes = buildMinimalVcd_safe();
      const loaded = await loadVmd(bytes);
      const limited = applyAmplitudeLimits(loaded, DEFAULT_AMPLITUDE_LIMITS);
      expect(limited).not.toBe(loaded);
    });

    it('FaceRed 超过 0.35 被钳制', async () => {
      const bytes = buildMinimalVmd({
        morphTracks: [{ name: 'FaceRed', frames: [0] }]
      });
      const loaded = await loadVmd(bytes);
      // 模拟 weight 超过 0.35
      const morphTrack = loaded.morphTracks['FaceRed'];
      if (morphTrack && 'weights' in morphTrack) {
        (morphTrack as any).weights[0] = 0.8;
      }
      const limited = applyAmplitudeLimits(loaded, DEFAULT_AMPLITUDE_LIMITS);
      const limitedTrack = limited.morphTracks['FaceRed'];
      expect(limitedTrack).toBeDefined();
      expect(limitedTrack.weights[0]).toBeCloseTo(0.35, 5);
      expect(limited.animation.morphTracks['FaceRed'].weights[0]).toBeCloseTo(0.35, 5);
    });

    it('limits arms, elbows and wrists only when optional speech limits are supplied', async () => {
      const loaded = await loadVmd(buildMinimalVmd({ boneTracks: [{ name: 'Head', frames: [0] }] }));
      const template = loaded.boneTracks.Head;
      const namedTracks = {
        '左腕': { ...template, rotations: template.rotations.slice() },
        '右ひじ': { ...template, rotations: template.rotations.slice() },
        '左手首': { ...template, rotations: template.rotations.slice() }
      };
      const namedLoaded = {
        ...loaded,
        boneTracks: namedTracks,
        animation: { ...loaded.animation, boneTracks: namedTracks }
      };
      const radians = 40 * Math.PI / 180;
      for (const track of Object.values(namedLoaded.boneTracks)) {
        track.rotations.set([Math.sin(radians / 2), 0, 0, Math.cos(radians / 2)]);
      }

      const ordinary = applyAmplitudeLimits(namedLoaded, DEFAULT_AMPLITUDE_LIMITS);
      const speech = applyAmplitudeLimits(namedLoaded, SPEECH_AMPLITUDE_LIMITS);
      expect(ordinary.boneTracks['左腕'].rotations[0]).toBeCloseTo(Math.sin(radians / 2), 5);
      expect(speech.boneTracks['左腕'].rotations[0]).toBeCloseTo(Math.sin(32 * Math.PI / 360), 4);
      expect(speech.boneTracks['右ひじ'].rotations[0]).toBeCloseTo(Math.sin(radians / 2), 4);
      expect(speech.boneTracks['左手首'].rotations[0]).toBeCloseTo(Math.sin(32 * Math.PI / 360), 4);
    });
  });

  describe('filterAnimationTracks', () => {
    it('从包装字段和实际 animation 同时移除模型不存在的轨道', async () => {
      const loaded = await loadVmd(buildMinimalVmd({
        boneTracks: [
          { name: 'Head', frames: [0] },
          { name: 'SourceOnlyBone', frames: [0] }
        ],
        morphTracks: [
          { name: 'Blink', frames: [0] },
          { name: 'SourceOnlyMorph', frames: [0] }
        ]
      }));
      const filtered = filterAnimationTracks(loaded, new Set(['Head']), new Set(['Blink']));
      expect(Object.keys(filtered.boneTracks)).toEqual(['Head']);
      expect(Object.keys(filtered.animation.boneTracks)).toEqual(['Head']);
      expect(Object.keys(filtered.morphTracks)).toEqual(['Blink']);
      expect(Object.keys(filtered.animation.morphTracks)).toEqual(['Blink']);
    });

    it('过滤后保留审计原字节，但播放对象不再携带可让 WASM 恢复已删除轨道的原始 VMD', async () => {
      const loaded = await loadVmd(buildMinimalVmd({
        boneTracks: [
          { name: 'UpperBody', frames: [0] },
          { name: 'LeftLeg', frames: [0, 30] }
        ]
      }));

      const filtered = filterAnimationTracks(loaded, new Set(['UpperBody']), new Set(), true);

      expect(filtered.bytes.byteLength).toBeGreaterThan(0);
      expect(filtered.bytes).toEqual(loaded.bytes);
      expect(filtered.animation.bytes).toBeInstanceOf(Uint8Array);
      expect(filtered.animation.bytes.byteLength).toBe(0);
      expect(Object.keys(filtered.animation.boneTracks)).toEqual(['UpperBody']);
    });
  });
});

// 辅助：构建安全的空 VMD 用于不涉及轨道内容的测试
function buildMinimalVcd_safe(): ArrayBuffer {
  return buildMinimalVmd({
    boneTracks: [{ name: '頭', frames: [0] }]
  });
}
