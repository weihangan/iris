// ActorRuntime（Phase 3 Task 3.1 + Bug 4 修复）
// 职责：管理 PMX 模型生命周期、情绪/口型/视线状态，通过 MorphController 暴露 morph 权重
//
// 设计原则：
// - fail-closed：未 load 时所有状态变更抛错；SHA-256 不匹配拒绝加载
// - 只读模型：load 不修改原文件
// - 纯逻辑：不依赖 Three.js / DOM，可在主进程和测试中使用
// - mesh 绑定：通过 bindMorphSink 将权重变更推送到屏幕 mesh（Bug 4 修复）
//
// 状态机：unloaded → loaded → (reset 可回到 loaded，重新 load 需先 reset)
// 注：speak 的口型同步是简化版（固定切换到 "あ"），真实口型同步在 Phase 4 ConversationJob 实现。
//
// Bug 4 修复：原设计"渲染器读取 MorphController 权重"从未实现，ActorRuntime 与屏幕 mesh 完全脱节。
// 修复方案：添加 bindMorphSink(sink) 方法，将 MorphController 的 sink 绑定到渲染器的 mesh 写入器。
// 渲染器调用 markLoaded() 跳过文件 SHA-256 检查（IPC 已验证），然后通过 bindMorphSink 建立绑定。
// Node.js 依赖（node:fs/node:crypto）改为动态 import，避免污染 renderer bundle。

import { parsePmx, type PmxModelInfo } from './pmx-parser';
import { MorphController, type MorphSafeRange, type MorphSink } from './morph-controller';
import type { VisemeWeights } from '../performance/lip-timeline';
import type { ExpressionSample } from '../performance/expression-timeline';
import { ExpressionCurveTimeline, type ExpressionCurveTimelineDefinition } from '../performance/expression-curve-timeline';
import { emptyVisemeWeights } from '../performance/lip-timeline';
import { createExpressionChannelPose, createExpressionPose } from '../performance/expression-recipes';
import {
  blendFacialPoses,
  blendFacialPosesForIdleReturn,
  createEmptyFacialPose,
  type FacialChannel,
  type FacialPose
} from '../performance/facial-pose';
import type { AvatarPerformanceProfile } from './avatar-performance-profile';
import { MorphLayerMixer } from './morph-layer-mixer';

export type Emotion = 'neutral' | 'serious' | 'happy' | 'smile' | 'excited' | 'surprised' | 'angry' | 'concerned' | 'sad' | 'shy' | 'thinking' | 'curious' | 'gentle' | 'grateful' | 'loving' | 'delighted' | 'shocked' | 'furious' | 'heartbroken' | 'skeptical' | 'embarrassed' | 'explaining' | 'greeting' | 'apologetic' | 'confident' | 'playful';

export interface SpeakOptions {
  readonly duration?: number; // 毫秒，0 表示持续到 stopSpeak
}

export interface StopSpeakOptions {
  /** Keep the last speech face so the idle face can crossfade from it. */
  readonly preserveExpression?: boolean;
}

export interface ActorState {
  readonly loaded: boolean;
  readonly emotion: Emotion;
  readonly speaking: boolean;
  readonly gaze: { readonly x: number; readonly y: number; readonly z: number };
}

export interface LoadOptions {
  readonly expectedSha256: string;
}

export interface AvatarManifest {
  readonly schemaVersion: number;
  readonly model: {
    readonly internalName: string;
    readonly displayName: string;
    readonly sha256: string;
    readonly pmxVersion: number;
    readonly geometry: {
      readonly vertices: number;
      readonly triangles: number;
      readonly materials: number;
      readonly bones: number;
      readonly morphs: number;
      readonly textures: number;
    };
    readonly textures: readonly string[];
    readonly credit: string;
    readonly licenseStatus: string;
  };
  readonly morphs: {
    readonly visemes: { readonly a: string; readonly i: string; readonly u: string; readonly e: string; readonly o: string };
    readonly blink: string;
    // Phase 3 收口修复 Step 4：neutral 为空字符串（reset 后自然态），serious = 真面目
    readonly emotions: { readonly neutral: string; readonly serious: string; readonly happy: string; readonly smile: string; readonly surprised: string; readonly angry: string; readonly concerned: string };
    // Gate6: blush 和 tears 都是可选的，模型无对应 morph 时不声明
    readonly blush?: { readonly name: string; readonly safeRange: MorphSafeRange };
    readonly shy: string;
    readonly tears?: string;
  };
  readonly bones: Record<string, string>;
  readonly clothing: { readonly white: string; readonly blue: string; readonly note: string };
  readonly capabilities: readonly string[];
  // 按模型 SHA-256 绑定的材质兼容规则（如鼻部覆盖层 suppress-color）。
  // 由当前模型 pack manifest 提供；导入模型通常为空数组。
  readonly materialCompatibility?: {
    readonly rules: ReadonlyArray<{
      readonly materialIndex: number;
      readonly materialName?: string;
      readonly action: 'suppress-color';
      readonly reason: string;
    }>;
  };
  readonly audit: { readonly createdAt: string; readonly createdBy: string; readonly contractRef: string; readonly notes: string };
}

const EMOTION_KEYS: ReadonlyArray<Emotion> = ['neutral', 'serious', 'happy', 'smile', 'excited', 'surprised', 'angry', 'concerned', 'sad', 'shy', 'thinking', 'curious', 'gentle', 'grateful', 'loving', 'delighted', 'shocked', 'furious', 'heartbroken', 'skeptical', 'embarrassed', 'explaining', 'greeting', 'apologetic', 'confident', 'playful'];

/**
 * ActorRuntime 管理 PMX 模型的状态和 morph 权重。
 *
 * Bug 4 修复：通过 bindMorphSink 与屏幕 mesh 建立绑定。
 * 渲染器在加载模型后调用 markLoaded() + bindMorphSink(sink)，
 * 之后 setEmotion/speak/stopSpeak/reset 的权重变更会自动推送到 mesh。
 */
export class ActorRuntime {
  private readonly morphController: MorphController;
  private readonly manifest: AvatarManifest;
  private readonly morphLayerMixer?: MorphLayerMixer;
  private readonly emotionMorphNames: readonly string[];
  private loaded = false;
  private emotion: Emotion = 'neutral';
  private speaking = false;
  private gaze: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private previewPose: FacialPose = createEmptyFacialPose();
  private previewFromPose: FacialPose = createEmptyFacialPose();
  private previewTargetPose: FacialPose = createEmptyFacialPose();
  private previewElapsed = 0;
  private previewDuration = 0;
  private previewKey: string | null = null;
  private previewBlendMode: 'standard' | 'idle-return' = 'standard';
  private candidateExpressionTimeline: ExpressionCurveTimeline | null = null;
  private candidateExpressionElapsed = 0;
  private candidateExpressionDuration = 0;

  constructor(
    manifest: AvatarManifest,
    availableMorphs: readonly string[] = [],
    performanceProfile?: AvatarPerformanceProfile
  ) {
    this.manifest = manifest;
    // 从 manifest 提取所有语义 morph 名称（Phase 3 收口修复 Step 4：过滤空字符串，添加 serious）
    const morphs = manifest.morphs;
    const semanticMorphs = [
      morphs.visemes.a, morphs.visemes.i, morphs.visemes.u, morphs.visemes.e, morphs.visemes.o,
      morphs.blink,
      morphs.emotions.neutral, morphs.emotions.serious, morphs.emotions.happy, morphs.emotions.smile,
      morphs.emotions.surprised, morphs.emotions.angry, morphs.emotions.concerned,
      morphs.blush?.name ?? '', morphs.shy, morphs.tears ?? '',
    ].filter((name): name is string => Boolean(name));

    // Task 2: knownMorphs 合并 manifest 语义 morph 和真实 mesh 提供的 morph
    const known = new Set<string>([...availableMorphs, ...semanticMorphs]);

    // Task 2 + Step 4: 互斥情绪组包含 serious, shy 和 blush，切换情绪时全部清零
    // 过滤空字符串（neutral 可能为空，不参与 emotionMorphNames）
    // Gate6: blush 可选，模型无 blush 时不加入
    this.emotionMorphNames = [
      morphs.emotions.neutral, morphs.emotions.serious,
      morphs.emotions.happy, morphs.emotions.smile,
      morphs.emotions.surprised, morphs.emotions.angry, morphs.emotions.concerned,
      morphs.shy, morphs.blush?.name ?? '',
    ].filter((name): name is string => Boolean(name));
    const safeRanges: Record<string, MorphSafeRange> = {};
    if (morphs.blush) {
      safeRanges[morphs.blush.name] = morphs.blush.safeRange;
    }
    this.morphController = new MorphController(Array.from(known), safeRanges);
    if (performanceProfile?.profileVersion === 2) {
      this.morphLayerMixer = new MorphLayerMixer(performanceProfile, this.morphController);
    }
  }

  /**
   * 加载 PMX 文件，校验 SHA-256。只读，不修改原文件。
   * Node.js 依赖（node:fs/node:crypto）使用动态 import，避免污染 renderer bundle。
   */
  async load(modelPath: string, options: LoadOptions): Promise<PmxModelInfo> {
    const { readFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const buffer = readFileSync(modelPath);
    const hash = createHash('sha256').update(buffer).digest('hex').toUpperCase();
    if (hash !== options.expectedSha256.toUpperCase()) {
      throw new Error(`SHA-256 mismatch: expected ${options.expectedSha256}, got ${hash}`);
    }
    const info = parsePmx(buffer);
    // 额外校验模型内部名
    if (info.modelNameJp !== this.manifest.model.internalName) {
      throw new Error(`Internal name mismatch: expected ${this.manifest.model.internalName}, got ${info.modelNameJp}`);
    }
    this.loaded = true;
    this.emotion = 'neutral';
    this.speaking = false;
    this.gaze = { x: 0, y: 0, z: 0 };
    this.morphController.reset();
    return info;
  }

  /**
   * 标记为已加载（供 renderer 使用）。跳过文件 SHA-256 检查，因为 IPC 层已验证。
   * 主进程的 chatx2:load-pmx-model IPC handler 在返回 ArrayBuffer 前已校验 SHA-256。
   * Bug 4 修复：让 renderer 构造的 ActorRuntime 也能进入 loaded 状态，启用 setEmotion/speak 等。
   */
  markLoaded(): void {
    this.loaded = true;
    this.emotion = 'neutral';
    this.speaking = false;
    this.gaze = { x: 0, y: 0, z: 0 };
    this.morphController.reset();
  }

  /**
   * 绑定 MorphSink。之后所有 morph 权重变更会推送到 sink（通常是屏幕 mesh 写入器）。
   * 传入 undefined 解除绑定（Task 6 Step 4：cleanup 时调用，避免渲染器销毁后仍写入 mesh）。
   * Bug 4 修复：建立 ActorRuntime 与屏幕 mesh 的绑定。
   * 绑定时不推送当前状态；调用方如需同步现有状态应手动设置。
   */
  bindMorphSink(sink?: MorphSink): void {
    this.morphController.bindSink(sink);
  }

  /**
   * 设置情绪。会重置所有 emotion morph，再激活对应 emotion 的 morph。
   *
   * Phase 3 收口修复 Step 4：
   * - "neutral" = reset 后的自然表情，不激活任何 emotion morph
   * - "serious" = 真面目（原本被错误映射到 neutral）
   * - "shy" 同时激活照れ morph 和轻微 FaceRed（在安全范围内）
   */
  setEmotion(emotion: Emotion): void {
    this.requireLoaded('setEmotion');
    if (!EMOTION_KEYS.includes(emotion)) {
      throw new Error(`Unknown emotion: ${emotion}`);
    }
    if (this.morphLayerMixer) {
      this.resetPreviewTween();
      this.morphLayerMixer.setExpressionPose(createExpressionPose(emotion, 1, 1));
      this.morphLayerMixer.commit();
      this.emotion = emotion;
      return;
    }
    // 先重置所有 emotion morph（包括 serious 真面目、shy 照れ、FaceRed）
    for (const name of this.emotionMorphNames) {
      this.morphController.setWeight(name, 0);
    }
    // shy 特殊处理：激活照れ + 轻微 blush（Gate6: blush 可选）
    if (emotion === 'shy' || emotion === 'embarrassed') {
      this.morphController.setWeight(this.manifest.morphs.shy, 1);
      if (this.manifest.morphs.blush) {
        this.morphController.setWeight(this.manifest.morphs.blush.name, 0.15);
      }
    } else if (emotion !== 'neutral') {
      // serious/happy/smile/surprised/angry/concerned 激活对应 morph
      // 新情绪回退到已有 morph：thinking→serious, curious→surprised, grateful/loving→smile
      const fallbackMap: Record<string, string> = {
        thinking: 'serious',
        curious: 'surprised',
        excited: 'happy',
        sad: 'concerned',
        gentle: 'smile',
        grateful: 'smile',
        loving: 'smile',
        delighted: 'happy',
        shocked: 'surprised',
        furious: 'angry',
        heartbroken: 'concerned',
        skeptical: 'serious',
        embarrassed: 'shy',
        explaining: 'serious',
        greeting: 'smile',
        apologetic: 'concerned',
        confident: 'serious',
        playful: 'smile'
      };
      const lookupKey = fallbackMap[emotion] ?? emotion;
      const morphName = lookupKey === 'shy'
        ? this.manifest.morphs.shy
        : this.manifest.morphs.emotions[lookupKey as keyof typeof this.manifest.morphs.emotions];
      if (morphName) {
        this.morphController.setWeight(morphName, 1);
      }
    }
    // neutral 不激活任何 morph
    this.emotion = emotion;
  }

  /**
   * 设置视线方向（单位向量，范围 [-1,1]）。
   * 仅记录意图，实际骨骼旋转由渲染器读取 gaze 状态完成。
   */
  setGaze(x: number, y: number, z: number): void {
    this.requireLoaded('setGaze');
    this.gaze = { x, y, z };
  }

  /** Mark speaking active. Visible mouth weights come from PerformanceClock. */
  speak(text: string, _options?: SpeakOptions): void {
    this.requireLoaded('speak');
    if (!text || text.length === 0) {
      throw new Error('speak requires non-empty text');
    }
    this.speaking = true;
    this.resetPreviewTween();
  }

  /** Apply normalized A/I/U/E/O weights to the model's audited PMX morphs. */
  applyVisemeWeights(weights: VisemeWeights): void {
    this.requireLoaded('applyVisemeWeights');
    const values = [weights.A, weights.I, weights.U, weights.E, weights.O];
    if (values.some(value => !Number.isFinite(value) || value < 0)) {
      throw new TypeError('viseme weights must be finite and non-negative');
    }
    if (this.morphLayerMixer) {
      this.morphLayerMixer.setVisemes(weights);
      this.morphLayerMixer.commit();
      return;
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    const scale = total > 1 ? 1 / total : 1;
    const v = this.manifest.morphs.visemes;
    this.morphController.applyBatch({
      [v.a]: weights.A * scale,
      [v.i]: weights.I * scale,
      [v.u]: weights.U * scale,
      [v.e]: weights.E * scale,
      [v.o]: weights.O * scale
    });
  }

  /** Apply a continuous expression sample without changing lip channels. */
  applyExpressionSample(sample: ExpressionSample): void {
    this.requireLoaded('applyExpressionSample');
    if (!this.speaking) return;
    if (this.morphLayerMixer) {
      this.morphLayerMixer.setExpressionPose(sample.pose);
      this.morphLayerMixer.commit();
      // Preserve the rendered speech pose as the source of the natural
      // speech-to-idle crossfade. Body/VMD switches must not reset this state.
      this.previewPose = sample.pose;
      this.previewFromPose = sample.pose;
      this.previewTargetPose = sample.pose;
      this.previewElapsed = 0;
      this.previewDuration = 0;
      this.previewKey = null;
      this.emotion = sample.emotion;
      return;
    }
    for (const name of this.emotionMorphNames) {
      this.morphController.setWeight(name, 0);
    }
    // Mandatory Worktree Correction Gate #5：
    // 移除 EmotionMouthOverlay 直接写入。嘴角偏移应由 Task 5 的统一 MorphLayerMixer
    // 统一管理（mouth-style 层），该层会考虑 lip 层的当前张嘴程度自动衰减，
    // 避免嘴角 morph 和五口型 morph 同时修改相同嘴部顶点导致表情拉坏。
    if (sample.emotion === 'shy' || sample.emotion === 'embarrassed') {
      this.morphController.setWeight(this.manifest.morphs.shy, sample.weight);
      // Gate6: blush 可选，模型无 blush 能力时不写入
      // 修复：检查 blush.name 非空而非 blush 对象存在（blush={name:""}会导致 setWeight("") 崩溃渲染循环）
      if (this.manifest.morphs.blush?.name) {
        this.morphController.setWeight(this.manifest.morphs.blush.name, sample.blush);
      }
    } else if (sample.emotion === 'neutral') {
      // neutral 微表情：设置轻微的 serious(真面目) 避免模型面无表情
      const seriousName = this.manifest.morphs.emotions.serious;
      if (seriousName && sample.weight > 0) {
        this.morphController.setWeight(seriousName, sample.weight);
      }
    } else {
      const fallbackMap: Record<string, string> = {
        thinking: 'serious',
        curious: 'surprised',
        excited: 'happy',
        sad: 'concerned',
        gentle: 'smile',
        grateful: 'smile',
        loving: 'smile',
        delighted: 'happy',
        shocked: 'surprised',
        furious: 'angry',
        heartbroken: 'concerned',
        skeptical: 'serious',
        embarrassed: 'shy'
      };
      const lookupKey = fallbackMap[sample.emotion] ?? sample.emotion;
      const name = lookupKey === 'shy'
        ? this.manifest.morphs.shy
        : this.manifest.morphs.emotions[lookupKey as keyof typeof this.manifest.morphs.emotions];
      if (name) this.morphController.setWeight(name, sample.weight);
    }
    this.emotion = sample.emotion;
  }

  /** Apply the audio-clock face and lip sample with one mixer commit per frame. */
  applyPerformanceSample(sample: ExpressionSample, weights: VisemeWeights): void {
    this.requireLoaded('applyPerformanceSample');
    if (!this.speaking) return;
    const values = [weights.A, weights.I, weights.U, weights.E, weights.O];
    if (values.some(value => !Number.isFinite(value) || value < 0)) {
      throw new TypeError('viseme weights must be finite and non-negative');
    }
    if (!this.morphLayerMixer) {
      this.applyExpressionSample(sample);
      this.applyVisemeWeights(weights);
      return;
    }
    this.morphLayerMixer.setExpressionPose(sample.pose);
    this.morphLayerMixer.setVisemes(weights);
    this.morphLayerMixer.commit();
    this.previewPose = sample.pose;
    this.previewFromPose = sample.pose;
    this.previewTargetPose = sample.pose;
    this.previewElapsed = 0;
    this.previewDuration = 0;
    this.previewKey = null;
    this.emotion = sample.emotion;
  }

  /** Apply a short management-panel preview without enabling speech state. */
  previewExpression(expressionId: string, intensity = 1): void {
    this.requireLoaded('previewExpression');
    if (this.speaking) return;
    if (this.morphLayerMixer) {
      this.startPreviewTween(
        `expression:${expressionId}:${intensity}`,
        createExpressionPose(expressionId, intensity, 1),
        0.4
      );
    }
  }

  /** Preview an isolated candidate or accepted curve without enabling speech. */
  previewCandidateExpression(record: ExpressionCurveTimelineDefinition): void {
    this.requireLoaded('previewCandidateExpression');
    if (this.speaking || !this.morphLayerMixer) return;
    this.resetPreviewTween();
    this.candidateExpressionTimeline = new ExpressionCurveTimeline(record);
    this.candidateExpressionElapsed = 0;
    this.candidateExpressionDuration = record.durationSeconds;
    this.previewPose = this.candidateExpressionTimeline.sample(0);
    this.morphLayerMixer.setExpressionPose(this.previewPose);
    this.morphLayerMixer.commit();
  }

  /**
   * Smoothly hand the final speech face to the shared default idle expression.
   * The default is the tender, affectionate smile ('loving'). Can be overridden
   * (e.g. by the right-click "默认表情" setting) with another recipe such as
   * 'serious' (cool), 'sad' (sad), 'shy' (shy) or 'angry'.
   */
  transitionToIdleSmile(durationSeconds = 0.9, intensity = 0.62, idleExpression: Emotion = 'loving'): void {
    this.requireLoaded('transitionToIdleSmile');
    if (this.speaking) return;
    if (!this.morphLayerMixer) {
      this.setEmotion(idleExpression === 'loving' ? 'smile' : idleExpression);
      return;
    }
    const duration = Math.min(2, Math.max(0.6, Number.isFinite(durationSeconds) ? durationSeconds : 0.9));
    const safeIntensity = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0.62));
    this.startPreviewTween(
      `idle-return:${idleExpression}:${safeIntensity}:${duration}`,
      createExpressionPose(idleExpression, safeIntensity, 1),
      duration,
      'idle-return'
    );
    // The state and rendered target must agree immediately. The visible pose
    // still moves continuously from the final speech sample over `duration`.
    // Emotion state stays 'smile' for the loving default; for other recipes the
    // chosen emotion feeds the next speech-emotion derivation as the base.
    this.emotion = idleExpression === 'loving' ? 'smile' : idleExpression;
  }

  previewExpressionChannel(expressionId: string, channel: FacialChannel, intensity = 1): void {
    this.requireLoaded('previewExpressionChannel');
    if (this.speaking) return;
    if (this.morphLayerMixer) {
      this.startPreviewTween(
        `channel:${expressionId}:${channel}:${intensity}`,
        createExpressionChannelPose(expressionId, channel, intensity),
        channel === 'eyeLidClose' ? 0.07 : 0.38
      );
    }
  }

  clearExpressionPreview(): void {
    this.requireLoaded('clearExpressionPreview');
    if (this.speaking) return;
    if (this.morphLayerMixer) {
      this.candidateExpressionTimeline = null;
      this.candidateExpressionElapsed = 0;
      this.candidateExpressionDuration = 0;
      this.startPreviewTween(
        'clear',
        createEmptyFacialPose(),
        this.previewKey?.includes(':eyeLidClose:') ? 0.12 : 0.46
      );
    }
    this.emotion = 'neutral';
  }

  /** Route blink/pupil lanes through the existing Mixer instead of writing the mesh directly. */
  setAuxiliaryMorphWeight(lane: string, name: string, weight: number): void {
    this.requireLoaded('setAuxiliaryMorphWeight');
    if (this.morphLayerMixer) {
      this.morphLayerMixer.setAuxiliaryMorphWeight(lane, name, weight);
      this.morphLayerMixer.commit();
      return;
    }
    this.morphController.setWeight(name, weight);
  }

  /** Restore the current layered face after VMD sampling clears mesh morphs. */
  reapplyPerformanceMorphs(): void {
    this.requireLoaded('reapplyPerformanceMorphs');
    this.morphLayerMixer?.reapply();
  }

  /**
   * 停止说话。重置所有 viseme 权重。
   */
  stopSpeak(options: StopSpeakOptions = {}): void {
    this.requireLoaded('stopSpeak');
    if (this.morphLayerMixer) {
      if (options.preserveExpression) {
        this.morphLayerMixer.clearVisemes();
      } else {
        this.morphLayerMixer.clearSpeechLayers();
        this.resetPreviewTween();
        this.emotion = 'neutral';
      }
      this.speaking = false;
      return;
    }
    const v = this.manifest.morphs.visemes;
    this.morphController.setWeight(v.a, 0);
    this.morphController.setWeight(v.i, 0);
    this.morphController.setWeight(v.u, 0);
    this.morphController.setWeight(v.e, 0);
    this.morphController.setWeight(v.o, 0);
    for (const name of this.emotionMorphNames) {
      this.morphController.setWeight(name, 0);
    }
    this.emotion = 'neutral';
    this.speaking = false;
  }

  /**
   * 每帧更新。Phase 3 仅做状态保持，实际动画在渲染器中。
   */
  update(dt: number): void {
    this.requireLoaded('update');
    if (!this.morphLayerMixer || this.speaking) return;
    const safeDt = Math.min(0.5, Math.max(0, Number.isFinite(dt) ? dt : 0));
    if (this.candidateExpressionTimeline) {
      this.candidateExpressionElapsed = Math.min(
        this.candidateExpressionDuration,
        this.candidateExpressionElapsed + safeDt
      );
      this.previewPose = this.candidateExpressionTimeline.sample(this.candidateExpressionElapsed);
      this.previewFromPose = this.previewPose;
      this.previewTargetPose = this.previewPose;
      this.morphLayerMixer.setExpressionPose(this.previewPose);
      this.morphLayerMixer.commit();
      if (this.candidateExpressionElapsed >= this.candidateExpressionDuration) {
        this.candidateExpressionTimeline = null;
        this.candidateExpressionDuration = 0;
      }
      return;
    }
    if (this.previewDuration <= 0) return;
    this.previewElapsed = Math.min(this.previewDuration, this.previewElapsed + safeDt);
    const progress = this.previewElapsed / this.previewDuration;
    const eased = this.previewKey === 'clear'
      ? 1 - Math.pow(1 - progress, 3)
      : progress * progress * (3 - 2 * progress);
    this.previewPose = this.previewBlendMode === 'idle-return'
      ? blendFacialPosesForIdleReturn(this.previewFromPose, this.previewTargetPose, progress)
      : blendFacialPoses(this.previewFromPose, this.previewTargetPose, eased);
    this.morphLayerMixer.setExpressionPose(this.previewPose);
    this.morphLayerMixer.commit();
    if (this.previewElapsed >= this.previewDuration) this.previewDuration = 0;
  }

  /**
   * 重置所有状态：emotion=neutral, speaking=false, gaze=0,0,0, 所有 morph=0。
   * 模型仍保持 loaded。
   */
  reset(): void {
    this.requireLoaded('reset');
    this.emotion = 'neutral';
    this.speaking = false;
    this.gaze = { x: 0, y: 0, z: 0 };
    this.resetPreviewTween();
    this.morphLayerMixer?.reset();
    this.morphController.reset();
  }

  getState(): ActorState {
    return {
      loaded: this.loaded,
      emotion: this.emotion,
      speaking: this.speaking,
      gaze: { x: this.gaze.x, y: this.gaze.y, z: this.gaze.z },
    };
  }

  /** 获取当前情绪 */
  getEmotion(): string {
    return this.emotion;
  }

  getMorphController(): MorphController {
    return this.morphController;
  }

  getManifest(): AvatarManifest {
    return this.manifest;
  }

  private requireLoaded(op: string): void {
    if (!this.loaded) {
      throw new Error(`ActorRuntime.${op}: not loaded`);
    }
  }

  private startPreviewTween(
    key: string,
    target: FacialPose,
    duration: number,
    blendMode: 'standard' | 'idle-return' = 'standard'
  ): void {
    if (this.previewKey === key) return;
    this.previewKey = key;
    this.previewBlendMode = blendMode;
    this.previewFromPose = this.previewPose;
    this.previewTargetPose = target;
    this.previewElapsed = 0;
    this.previewDuration = duration;
  }

  private resetPreviewTween(): void {
    this.previewPose = createEmptyFacialPose();
    this.previewFromPose = createEmptyFacialPose();
    this.previewTargetPose = createEmptyFacialPose();
    this.previewElapsed = 0;
    this.previewDuration = 0;
    this.previewKey = null;
    this.previewBlendMode = 'standard';
    this.candidateExpressionTimeline = null;
    this.candidateExpressionElapsed = 0;
    this.candidateExpressionDuration = 0;
  }
}
