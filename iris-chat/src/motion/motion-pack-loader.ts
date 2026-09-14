// Phase 5.2 Task 5.2.2: VMD 加载/哈希/重定向/限幅
//
// 职责：
// - loadVmd(bytes): 解析 VMD 字节，返回 LoadedVmd 对象
// - computeSha256(bytes): 计算 SHA-256 哈希
// - retargetBones(loaded, mapping): VMD 日文骨骼名 → 模型骨骼名映射
// - applyAmplitudeLimits(loaded, limits): 关节角度限幅 + FaceRed morph 上限
//
// 使用 @yohawing/three-mmd-loader 0.6.0 的 parseVmd API（不是 animation.getTrackNames()）
// 真实 API：
//   parseVmd(bytes: Uint8Array | ArrayBuffer): MmdAnimation
//   MmdAnimation.boneTracks: Record<string, VmdBoneTrack>
//   MmdAnimation.morphTracks: Record<string, VmdMorphTrack>
// 通过 Object.keys() 提取骨骼/morph 名，不假设 getTrackNames() 存在

import { parseVmd } from '@yohawing/three-mmd-loader/parser';
import type { MmdAnimation, VmdBoneTrack, VmdMorphTrack } from '@yohawing/three-mmd-loader/parser';
import type { BoneMapping, AmplitudeLimits } from './motion-pack-types';

/**
 * 加载后的 VMD 数据。保留原始字节用于哈希校验和持久化。
 */
export interface LoadedVmd {
  /** 原始字节（Uint8Array 视图，不可修改） */
  readonly bytes: Uint8Array;
  /** 解析后的 MmdAnimation */
  readonly animation: MmdAnimation;
  /** 骨骼轨道（boneTracks 的引用，重定向后键会被替换） */
  boneTracks: Record<string, VmdBoneTrack>;
  /** morph 轨道 */
  morphTracks: Record<string, VmdMorphTrack>;
}

interface CachedParsedVmd {
  readonly bytes: Uint8Array;
  readonly animation: MmdAnimation;
}

const parsedVmdCache = new WeakMap<object, CachedParsedVmd>();
const parsedVmdCacheStats = {
  hits: 0,
  misses: 0,
  parses: 0,
  totalParseMilliseconds: 0,
  lastParseMilliseconds: 0,
  totalCacheHitMilliseconds: 0,
  lastCacheHitMilliseconds: 0
};

function monotonicNowMilliseconds(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export function getVmdParseCacheStats(): Readonly<typeof parsedVmdCacheStats> {
  return { ...parsedVmdCacheStats };
}

export function resetVmdParseCacheStats(): void {
  parsedVmdCacheStats.hits = 0;
  parsedVmdCacheStats.misses = 0;
  parsedVmdCacheStats.parses = 0;
  parsedVmdCacheStats.totalParseMilliseconds = 0;
  parsedVmdCacheStats.lastParseMilliseconds = 0;
  parsedVmdCacheStats.totalCacheHitMilliseconds = 0;
  parsedVmdCacheStats.lastCacheHitMilliseconds = 0;
}

/**
 * 计算 SHA-256 哈希（64 字符十六进制）。
 * 使用 Web Crypto API（Node.js 和浏览器都支持）。
 */
export async function computeSha256(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  // 确保传入的是 ArrayBuffer（不是 SharedArrayBuffer），Web Crypto 需要 BufferSource<ArrayBuffer>
  const arrayBuffer: ArrayBuffer = buffer instanceof ArrayBuffer
    ? buffer
    : (buffer.buffer instanceof ArrayBuffer ? buffer.buffer : buffer.slice().buffer);
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 加载 VMD 字节并返回 LoadedVmd 对象。
 * 非法字节或 magic 错误会抛错（fail-closed）。
 */
export async function loadVmd(buffer: ArrayBuffer | Uint8Array): Promise<LoadedVmd> {
  const loadStartedAt = monotonicNowMilliseconds();
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 30) {
    throw new Error(`[motion] VMD bytes too short: ${bytes.length} (minimum 30 for magic)`);
  }
  // 检查 magic "Vocaloid Motion Data 0002"
  const magicText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 30));
  if (!magicText.startsWith('Vocaloid Motion Data')) {
    throw new Error(`[motion] Invalid VMD magic: expected "Vocaloid Motion Data 0002"`);
  }
  const cacheKey = buffer as object;
  let cached = parsedVmdCache.get(cacheKey);
  const cacheHit = cached !== undefined;
  if (cached) {
    parsedVmdCacheStats.hits += 1;
  } else {
    parsedVmdCacheStats.misses += 1;
    const immutableBytes = bytes.slice();
    const parseStartedAt = monotonicNowMilliseconds();
    const animation = parseVmd(immutableBytes);
    const parseMilliseconds = monotonicNowMilliseconds() - parseStartedAt;
    parsedVmdCacheStats.parses += 1;
    parsedVmdCacheStats.lastParseMilliseconds = parseMilliseconds;
    parsedVmdCacheStats.totalParseMilliseconds += parseMilliseconds;
    cached = { bytes: immutableBytes, animation };
    parsedVmdCache.set(cacheKey, cached);
  }
  const boneTracks = { ...cached.animation.boneTracks };
  const morphTracks = { ...cached.animation.morphTracks };
  if (cacheHit) {
    const cacheHitMilliseconds = monotonicNowMilliseconds() - loadStartedAt;
    parsedVmdCacheStats.lastCacheHitMilliseconds = cacheHitMilliseconds;
    parsedVmdCacheStats.totalCacheHitMilliseconds += cacheHitMilliseconds;
  }
  return {
    bytes: cached.bytes,
    animation: { ...cached.animation, boneTracks, morphTracks },
    boneTracks,
    morphTracks
  };
}

/**
 * 提取 VMD 中所有骨骼名。
 * 使用 Object.keys() 而不是假设 getTrackNames() 存在。
 */
export function extractBoneNames(loaded: LoadedVmd): string[] {
  return Object.keys(loaded.boneTracks);
}

/**
 * 提取 VMD 中所有 morph 名。
 */
export function extractMorphNames(loaded: LoadedVmd): string[] {
  return Object.keys(loaded.morphTracks);
}

/**
 * 检查 VMD 是否包含眨眼轨道（まばたき）。
 * 用于决定 ProceduralLifeController 是否让出眨眼控制。
 */
export function hasBlinkTrack(loaded: LoadedVmd): boolean {
  return 'まばたき' in loaded.morphTracks;
}

/**
 * 骨骼重定向：VMD 日文骨骼名 → 模型骨骼名映射。
 * 未在 mapping 中的骨骼保留原名。
 * 返回新的 LoadedVmd 对象，不修改原对象。
 */
export function retargetBones(loaded: LoadedVmd, mapping: BoneMapping): LoadedVmd {
  const newBoneTracks: Record<string, VmdBoneTrack> = {};
  for (const [vmdName, track] of Object.entries(loaded.boneTracks)) {
    const modelName = mapping[vmdName] ?? vmdName;
    newBoneTracks[modelName] = track;
  }
  return {
    bytes: loaded.bytes,
    animation: {
      ...loaded.animation,
      boneTracks: newBoneTracks,
      morphTracks: { ...loaded.morphTracks }
    },
    boneTracks: newBoneTracks,
    morphTracks: { ...loaded.morphTracks }
  };
}

/**
 * Resolve the small set of conventional MMD body bones used by the shared
 * action pool when an imported PMX only exposes English bone names (or a
 * spelling variant).  This is deliberately limited to the stable body chain;
 * hair/clothing bones are never guessed or retargeted.
 */
function canonicalBodyBone(name: string): string | null {
  const key = String(name ?? '').normalize('NFKC').replace(/[\s_\-]/g, '').toLowerCase();
  const aliases: Record<string, string> = {
    '全ての親': 'root', 'allparent': 'root', 'root': 'root',
    'センター': 'center', 'center': 'center', 'センター2': 'center2', 'center2': 'center2',
    '上半身': 'upperbody', 'upperbody': 'upperbody', 'upperbody1': 'upperbody1', '上半身1': 'upperbody1',
    '上半身2': 'upperbody2', 'upperbody2': 'upperbody2',
    '下半身': 'lowerbody', 'lowerbody': 'lowerbody', '腰': 'waist', 'waist': 'waist',
    '首': 'neck', 'neck': 'neck', '頭': 'head', 'head': 'head',
    '左肩': 'leftshoulder', 'leftshoulder': 'leftshoulder', 'rightshoulder': 'rightshoulder', '右肩': 'rightshoulder',
    '左腕': 'leftarm', 'leftarm': 'leftarm', '右腕': 'rightarm', 'rightarm': 'rightarm',
    '左ひじ': 'leftelbow', '左肘': 'leftelbow', 'leftelbow': 'leftelbow', 'leftforearm': 'leftelbow',
    '右ひじ': 'rightelbow', '右肘': 'rightelbow', 'rightelbow': 'rightelbow', 'rightforearm': 'rightelbow',
    '左手首': 'lefthand', 'lefthand': 'lefthand', 'lefthandp': 'lefthand', '左手': 'lefthand',
    '右手首': 'righthand', 'righthand': 'righthand', 'righthandp': 'righthand', '右手': 'righthand',
    '左足': 'leftleg', 'leftleg': 'leftleg', 'leftthigh': 'leftleg',
    '右足': 'rightleg', 'rightleg': 'rightleg', 'rightthigh': 'rightleg',
    '左ひざ': 'leftknee', '左膝': 'leftknee', 'leftknee': 'leftknee', 'leftcalf': 'leftknee',
    '右ひざ': 'rightknee', '右膝': 'rightknee', 'rightknee': 'rightknee', 'rightcalf': 'rightknee',
    '左足首': 'leftfoot', 'leftfoot': 'leftfoot', 'leftankle': 'leftfoot',
    '右足首': 'rightfoot', 'rightfoot': 'rightfoot', 'rightankle': 'rightfoot'
  };
  return aliases[key] ?? null;
}

/** Build a conservative VMD(source) -> PMX(target) mapping for imported models. */
export function buildCompatibleBoneMapping(
  loaded: LoadedVmd,
  modelBoneNames: ReadonlySet<string>
): BoneMapping {
  const byCanonical = new Map<string, string>();
  for (const modelName of modelBoneNames) {
    const canonical = canonicalBodyBone(modelName);
    if (canonical && !byCanonical.has(canonical)) byCanonical.set(canonical, modelName);
  }
  const mapping: BoneMapping = {};
  for (const sourceName of Object.keys(loaded.boneTracks)) {
    if (modelBoneNames.has(sourceName)) continue;
    const canonical = canonicalBodyBone(sourceName);
    const target = canonical ? byCanonical.get(canonical) : undefined;
    if (target && target !== sourceName) mapping[sourceName] = target;
  }
  return mapping;
}

/**
 * 默认幅度限制（度数）。
 * 头 ±30 度 / 上半身 ±20 度 / 肩 ±15 度 / FaceRed ≤ 0.35
 * FaceRed 0.35 上限是 avatar-manifest.json 中的硬规则。
 */
export const DEFAULT_AMPLITUDE_LIMITS: AmplitudeLimits = {
  head: { x: 30, y: 30, z: 30 },
  upperBody: { x: 20, y: 20, z: 20 },
  shoulder: { x: 15, y: 15, z: 15 },
  faceRedMax: 0.35
};

/** Dialogue-only limits. Head and neck each receive this limit, so keep the
 * per-bone values low enough that their combined rotation remains natural. */
export const SPEECH_AMPLITUDE_LIMITS: AmplitudeLimits = {
  head: { x: 8, y: 10, z: 6 },
  upperBody: { x: 6, y: 6, z: 5 },
  shoulder: { x: 6, y: 6, z: 6 },
  arm: { x: 32, y: 32, z: 32 },
  elbow: { x: 50, y: 50, z: 50 },
  wrist: { x: 32, y: 32, z: 32 },
  faceRedMax: 0.35
};

/**
 * 弧度转角度。
 */
function radToDeg(rad: number): number {
  return rad * 180 / Math.PI;
}

/**
 * 角度转弧度。
 */
function degToRad(deg: number): number {
  return deg * Math.PI / 180;
}

/**
 * 钳制四元数旋转，使对应欧拉角分量不超过限制。
 * 通过将四元数转换为欧拉角，钳制后再转回四元数实现。
 * 注意：四元数到欧拉角的转换可能有歧义，这里只做近似钳制。
 */
function clampQuaternion(
  rotation: [number, number, number, number],
  limitsDeg: { x: number; y: number; z: number }
): [number, number, number, number] {
  // 四元数 (x, y, z, w) → 欧拉角 XYZ
  const x = rotation[0], y = rotation[1], z = rotation[2], w = rotation[3];
  // Three.js Euler XYZ from quaternion
  const sinX = 2 * (w * x + y * z);
  const cosX = 1 - 2 * (x * x + y * y);
  const eulerX = Math.atan2(sinX, cosX);

  const sinY = Math.sqrt(1 + 2 * (w * y - x * z));
  const cosY = Math.sqrt(1 - 2 * (w * y - x * z));
  const eulerY = 2 * Math.atan2(sinY, cosY) - Math.PI / 2;

  const sinZ = 2 * (w * z + x * y);
  const cosZ = 1 - 2 * (y * y + z * z);
  const eulerZ = Math.atan2(sinZ, cosZ);

  // 钳制（弧度）
  const limitX = degToRad(limitsDeg.x);
  const limitY = degToRad(limitsDeg.y);
  const limitZ = degToRad(limitsDeg.z);
  const clampedX = Math.max(-limitX, Math.min(limitX, eulerX));
  const clampedY = Math.max(-limitY, Math.min(limitY, eulerY));
  const clampedZ = Math.max(-limitZ, Math.min(limitZ, eulerZ));

  // 欧拉角 XYZ → 四元数
  const cx = Math.cos(clampedX / 2);
  const sx = Math.sin(clampedX / 2);
  const cy = Math.cos(clampedY / 2);
  const sy = Math.sin(clampedY / 2);
  const cz = Math.cos(clampedZ / 2);
  const sz = Math.sin(clampedZ / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz
  ];
}

/**
 * 应用幅度限制到 VMD。
 * - 骨骼旋转：頭/上半身/左肩/右肩 的旋转角度被钳制
 * - morph 权重：FaceRed 超过 faceRedMax 被钳制
 *
 * 返回新的 LoadedVmd 对象，不修改原对象。
 */
export function applyAmplitudeLimits(loaded: LoadedVmd, limits: AmplitudeLimits): LoadedVmd {
  const newBoneTracks: Record<string, VmdBoneTrack> = {};
  for (const [name, track] of Object.entries(loaded.boneTracks)) {
    let limitDeg: { x: number; y: number; z: number } | null = null;
    if (name === '頭' || name === '首') limitDeg = limits.head;
    else if (name === '上半身') limitDeg = limits.upperBody;
    else if (name === '左肩' || name === '右肩') limitDeg = limits.shoulder;
    else if ((name === '左腕' || name === '右腕') && limits.arm) limitDeg = limits.arm;
    else if ((name === '左ひじ' || name === '右ひじ' || name === '左肘' || name === '右肘') && limits.elbow) limitDeg = limits.elbow;
    else if ((name === '左手首' || name === '右手首') && limits.wrist) limitDeg = limits.wrist;

    if (limitDeg && track.rotations) {
      // 旋转数据布局：每 4 个 float 一个四元数 (x, y, z, w)
      const newRotations = new Float32Array(track.rotations);
      const frameCount = newRotations.length / 4;
      for (let i = 0; i < frameCount; i++) {
        const offset = i * 4;
        const q: [number, number, number, number] = [
          newRotations[offset],
          newRotations[offset + 1],
          newRotations[offset + 2],
          newRotations[offset + 3]
        ];
        const clamped = clampQuaternion(q, limitDeg);
        newRotations[offset] = clamped[0];
        newRotations[offset + 1] = clamped[1];
        newRotations[offset + 2] = clamped[2];
        newRotations[offset + 3] = clamped[3];
      }
      newBoneTracks[name] = {
        ...track,
        rotations: newRotations
      };
    } else {
      newBoneTracks[name] = track;
    }
  }

  // 钳制 FaceRed morph 权重
  const newMorphTracks: Record<string, VmdMorphTrack> = {};
  for (const [name, track] of Object.entries(loaded.morphTracks)) {
    if (name === 'FaceRed' && track.weights) {
      const newWeights = new Float32Array(track.weights);
      for (let i = 0; i < newWeights.length; i++) {
        newWeights[i] = Math.min(Math.max(0, newWeights[i]), limits.faceRedMax);
      }
      newMorphTracks[name] = {
        ...track,
        weights: newWeights
      };
    } else {
      newMorphTracks[name] = track;
    }
  }

  return {
    bytes: loaded.bytes,
    animation: {
      ...loaded.animation,
      boneTracks: newBoneTracks,
      morphTracks: newMorphTracks
    },
    boneTracks: newBoneTracks,
    morphTracks: newMorphTracks
  };
}

/** Remove source-model-only tracks before ownership claims and playback. */
export function filterAnimationTracks(
  loaded: LoadedVmd,
  allowedBoneNames: ReadonlySet<string>,
  allowedMorphNames: ReadonlySet<string>,
  enforceParsedTrackPlayback = false
): LoadedVmd {
  const boneTracks = Object.fromEntries(
    Object.entries(loaded.boneTracks).filter(([name]) => allowedBoneNames.has(name))
  ) as Record<string, VmdBoneTrack>;
  const morphTracks = Object.fromEntries(
    Object.entries(loaded.morphTracks).filter(([name]) => allowedMorphNames.has(name))
  ) as Record<string, VmdMorphTrack>;
  return {
    bytes: loaded.bytes,
    animation: {
      ...loaded.animation,
      // A declared safety policy must be enforced by parsed-track playback:
      // MmdAnimRuntime otherwise recompiles the original bytes and silently
      // restores removed tracks. Unrestricted/manual VMDs retain their WASM path.
      bytes: enforceParsedTrackPlayback ? new Uint8Array() : loaded.animation.bytes,
      boneTracks,
      morphTracks
    },
    boneTracks,
    morphTracks
  };
}

/** True when a parsed VMD can affect at least one bone in the current model. */
export function hasCompatibleBoneTracks(
  loaded: LoadedVmd,
  modelBoneNames: ReadonlySet<string>
): boolean {
  if (Object.keys(loaded.boneTracks).some(name => modelBoneNames.has(name))) return true;
  return Object.keys(buildCompatibleBoneMapping(loaded, modelBoneNames)).length > 0;
}
