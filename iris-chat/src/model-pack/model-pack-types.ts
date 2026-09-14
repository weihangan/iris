// 模型包类型定义
// 一个模型包 = 一个角色：PMX + 材质 + morph 映射 + 骨骼映射 + 动作配置
// 设计基于 chat6.0 的 avatar-manifest.json 扩展，支持多模型切换

export interface ModelPackGeometry {
  vertices: number;
  triangles: number;
  materials: number;
  bones: number;
  morphs: number;
  textures: number;
}

export interface ModelPackModelInfo {
  pmxFile: string;          // 相对于模型包根目录，如 'model.pmx'
  sha256: string;           // 大写十六进制 64 字符
  pmxVersion: number;
  geometry: ModelPackGeometry;
  credit: string;
  licenseStatus: string;
}

export interface VisemeMap {
  a: string;
  i: string;
  u: string;
  e: string;
  o: string;
}

export interface EmotionMorphMap {
  neutral: string;
  serious: string;
  happy: string;
  smile: string;
  surprised: string;
  angry: string;
  concerned: string;
  [key: string]: string;    // 允许扩展情绪
}

export interface BlushConfig {
  name: string;
  safeRange: { min: number; max: number };
}

export interface ModelPackMorphs {
  visemes: VisemeMap;
  blink: string;
  emotions: EmotionMorphMap;
  blush: BlushConfig;
  shy: string;
  tears: string;
}

export interface ModelPackBones {
  root: string;
  center: string;
  head: string;
  neck: string;
  bothEyes: string;
  leftEye: string;
  rightEye: string;
  upperBody: string;
  lowerBody: string;
  waist: string;
  leftShoulder: string;
  rightShoulder: string;
  leftArm: string;
  rightArm: string;
  leftElbow: string;
  rightElbow: string;
  leftHand: string;
  rightHand: string;
  leftLeg: string;
  rightLeg: string;
  leftKnee: string;
  rightKnee: string;
  leftFoot: string;
  rightFoot: string;
  leftFootIK: string;
  rightFootIK: string;
  leftToeIK: string;
  rightToeIK: string;
}

export interface MaterialCompatRule {
  materialIndex: number;
  materialName: string;
  action: string;
  reason: string;
}

export interface MaterialCompatibility {
  rules: MaterialCompatRule[];
}

export interface VmdEmotionEntry {
  vmdPath: string;
  displayName: string;
  type: 'idle' | 'gesture' | 'voice';
  gestureFamily: string;
  intent: string;
  emotions: string[];
  description: string;
  dialogueSafe?: boolean;
  /** 用户收藏的高频语音动作；自动匹配时优先于同类未收藏动作。 */
  starred?: boolean;
  motionScope?: 'head-overlay';
  headOverlayId?: 'curious-left-tilt' | 'concerned-down' | 'remember-inward-up';
  /** Runtime-provided built-in voice action. Protected entries cannot be removed or re-identified. */
  protected?: boolean;
  /** User-adjustable, bounded amplitude for protected head overlays. */
  headTuning?: { rotationScale: number };
}

export interface ModelPackMotions {
  idlePacks: string[];      // 启用的内置 idle pack id（来自 idle-packs.ts）
  gesturePacks: string[];  // 启用的内置 gesture pack id（来自 gesture-packs.ts）
  defaultIdle: string;      // 默认待机 pack id
  customVmd: string[];      // 用户导入的 VMD 相对路径（相对于模型包 motions/ 目录）
  /** 长时间动作（舞蹈/场景动作），区别于自定义短动作 */
  longActionVmd: string[];  // 长时间 VMD 动作（舞蹈/场景），相对路径
  vmdEmotionMap?: VmdEmotionEntry[];  // VMD 情绪/意图映射表（Phase 6）
  /**
   * 待机轮换池：参与自动轮换的 customVmd 路径列表。
   * 非空时，桌宠待机会在池中的多个 VMD 之间随机切换（每 12-20 秒）；
   * 为空时，回退到 defaultIdle 单循环模式。
   * 池中的 VMD 必须同时存在于 customVmd 列表中。
   */
  idleVmdPool?: string[];
}

export interface ModelPackPhysics {
  disabledDynamicBones?: string[];
}

/**
 * 模型专属动作手感微调（存储在每个模型包文件夹的 manifest.json 中）。
 * 只影响该模型自身的自定义 VMD 播放淡入淡出；共享动作库与语音衔接配置不受影响。
 * fade 时长同时决定过渡惯性能量的衰减窗口，值越大衔接越柔和。
 */
export interface ModelPackMotionTuning {
  /** 自定义 VMD 待机/待机轮换（循环）淡入秒数，默认 1.0 */
  idleFadeInSeconds?: number;
  /** 自定义 VMD 待机/待机轮换（循环）淡出秒数，默认 1.0 */
  idleFadeOutSeconds?: number;
  /** 一次性动作（手动播放/长 VMD）淡入秒数，默认 0.35 */
  actionFadeInSeconds?: number;
  /** 一次性动作（手动播放/长 VMD）淡出秒数，默认 0.55 */
  actionFadeOutSeconds?: number;
}

/** 解析后的模型动作手感参数（全部有安全默认值，可直接用于 play 选项）。 */
export interface ResolvedModelMotionTuning {
  idleFadeInSeconds: number;
  idleFadeOutSeconds: number;
  actionFadeInSeconds: number;
  actionFadeOutSeconds: number;
}

const MOTION_TUNING_FADE_RANGE: readonly [number, number] = [0.2, 3.0];

function clampFadeSeconds(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const [min, max] = MOTION_TUNING_FADE_RANGE;
  return Math.min(max, Math.max(min, value));
}

/** 合并模型 manifest 中的 motionTuning 与全局默认值，输出可直接使用的 fade 参数。 */
export function resolveModelMotionTuning(tuning?: ModelPackMotionTuning | null): ResolvedModelMotionTuning {
  return {
    idleFadeInSeconds: clampFadeSeconds(tuning?.idleFadeInSeconds, 1.0),
    idleFadeOutSeconds: clampFadeSeconds(tuning?.idleFadeOutSeconds, 1.0),
    actionFadeInSeconds: clampFadeSeconds(tuning?.actionFadeInSeconds, 0.35),
    actionFadeOutSeconds: clampFadeSeconds(tuning?.actionFadeOutSeconds, 0.55)
  };
}

export interface ModelPackManifest {
  schemaVersion: 1;
  packId: string;           // 如 'selena-xisheng-v1'
  displayName: string;      // 如 '赛琳娜 希声'
  internalName: string;     // 如 '赛琳娜希声'
  createdAt: string;        // ISO 8601

  model: ModelPackModelInfo;
  textures: string[];       // 相对路径列表
  morphs: ModelPackMorphs;
  bones: ModelPackBones;
  materialCompatibility: MaterialCompatibility;
  motions: ModelPackMotions;
  physics?: ModelPackPhysics;
  motionTuning?: ModelPackMotionTuning;
  capabilities: string[];   // 如 ['visemes','blink','emotions','gaze','blush','shy','tears']
}

// 运行时加载后的模型包（含绝对路径）
export interface LoadedModelPack {
  manifest: ModelPackManifest;
  packDir: string;          // 模型包根目录绝对路径
  pmxAbsolutePath: string;  // PMX 绝对路径
  textureRoot: string;      // 纹理根目录（= packDir）
}

// 模型包列举项（UI 用，不含敏感路径）
export interface ModelPackListItem {
  packId: string;
  displayName: string;
  internalName: string;
  capabilities: string[];
  motionCount: number;
  isBuiltIn: boolean;
}

// 切换模型结果
export interface SwitchModelResult {
  success: boolean;
  packId?: string;
  displayName?: string;
  sha256?: string;
  reason?: string;
}
