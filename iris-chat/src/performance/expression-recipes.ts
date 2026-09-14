import {
  FACIAL_CHANNELS,
  clampFacialWeight,
  createEmptyFacialPose,
  type FacialChannel,
  type FacialPose
} from './facial-pose';
import sharedExpressionLibrary from '../../models/shared/facial-performance/shared-expression-library.json';

export type FacialEmotion =
  | 'neutral' | 'serious' | 'happy' | 'smile' | 'excited'
  | 'surprised' | 'angry' | 'concerned' | 'sad' | 'shy'
  | 'thinking' | 'curious' | 'gentle' | 'grateful' | 'loving'
  | 'explaining' | 'greeting' | 'apologetic' | 'confident' | 'playful'
  | 'delighted' | 'shocked' | 'furious' | 'heartbroken'
  | 'skeptical' | 'embarrassed';

type Recipe = Readonly<Partial<Record<FacialChannel, number>>>;

export interface ExpressionRecipeDefinition {
  readonly id: FacialEmotion;
  readonly name: string;
  readonly recipe: Recipe;
}

export interface MicroExpressionAccentDefinition {
  readonly id: string;
  readonly channels: Readonly<Partial<Record<FacialChannel, number>>>;
  readonly enterSeconds: number;
  readonly holdSeconds: number;
  readonly exitSeconds: number;
}

export interface FacialPersonalityBias {
  readonly warmth?: number;
  readonly calmness?: number;
  readonly affection?: number;
  readonly concern?: number;
}

const SHARED_RECIPES = sharedExpressionLibrary.recipes as Readonly<Record<FacialEmotion, {
  readonly label: string;
  readonly base: Readonly<Record<string, number>>;
  readonly microAccents?: readonly string[];
}>>;
const SHARED_MICRO_ACCENTS = sharedExpressionLibrary.microAccents as Readonly<Record<string, {
  readonly channels?: Readonly<Record<string, number>>;
  readonly enterMs?: number;
  readonly holdMs?: number;
  readonly exitMs?: number;
}>>;
const MICRO_TIMING_DEFAULTS = sharedExpressionLibrary.timingDefaults;

const RECIPES: Readonly<Record<FacialEmotion, Recipe>> = Object.fromEntries(
  Object.entries(SHARED_RECIPES).map(([id, entry]) => [id, {
    ...entry.base,
    ...(id === 'surprised' ? { jawOpen: 0.08 } : {})
  }])
) as Readonly<Record<FacialEmotion, Recipe>>;

export function getExpressionRecipeDefinitions(): readonly ExpressionRecipeDefinition[] {
  return Object.entries(SHARED_RECIPES).map(([id, entry]) => ({
    id: id as FacialEmotion,
    name: entry.label,
    recipe: RECIPES[id as FacialEmotion]
  }));
}

export function getExpressionMicroAccents(emotion: string): readonly MicroExpressionAccentDefinition[] {
  const canonical = canonicalEmotion(String(emotion).toLowerCase()) ?? 'neutral';
  const accentIds = SHARED_RECIPES[canonical].microAccents ?? [];
  return accentIds.flatMap(id => {
    const source = SHARED_MICRO_ACCENTS[id];
    if (!source) return [];
    const channels: Partial<Record<FacialChannel, number>> = {};
    for (const [rawChannel, weight] of Object.entries(source.channels ?? {})) {
      const channel = rawChannel === 'blink' ? 'eyeLidClose' : rawChannel;
      if (FACIAL_CHANNELS.includes(channel as FacialChannel) && Number(weight) > 0) {
        channels[channel as FacialChannel] = clampFacialWeight(Number(weight));
      }
    }
    // Gaze-only accents are handled by the gaze timeline. The facial sampler
    // exposes only accents that create measurable morph changes.
    if (Object.keys(channels).length === 0) return [];
    return [{
      id,
      channels,
      enterSeconds: Math.max(0.05, Number(source.enterMs ?? MICRO_TIMING_DEFAULTS.microEnterMs) / 1000),
      holdSeconds: Math.max(0.05, Number(source.holdMs ?? MICRO_TIMING_DEFAULTS.microHoldMs) / 1000),
      exitSeconds: Math.max(0.05, Number(source.exitMs ?? MICRO_TIMING_DEFAULTS.microExitMs) / 1000)
    }];
  });
}

function canonicalEmotion(value: string): FacialEmotion | undefined {
  return Object.prototype.hasOwnProperty.call(RECIPES, value) ? value as FacialEmotion : undefined;
}

export function deriveFacialEmotion(
  text: string,
  baseEmotion: string,
  personality?: FacialPersonalityBias,
  cueIndex = 0,
  intent = ''
): FacialEmotion {
  const content = String(text ?? '').toLowerCase();
  const normalizedIntent = String(intent ?? '').trim().toLowerCase();
  // High-signal phrases select the exaggerated family before the broader
  // everyday rules below. This keeps ordinary dialogue restrained while
  // giving emphatic wording a visibly different face.
  if (/(一怔|怔住|愣住|睁大眼|瞪大眼|倒吸一口气|诧异)/.test(content)) return 'surprised';
  if (/(咬牙|攥紧拳|握紧拳|怒视|冷声|眉头紧皱|不悦|恼火)/.test(content)) return 'angry';
  if (/(眼神黯淡|轻声叹气|沉默了|泪光|眼眶泛红|低落)/.test(content)) return 'sad';
  if (/(眉头微蹙|轻轻蹙眉|小心翼翼|不安|担忧)/.test(content)) return 'concerned';
  if (/(歪着头|歪头|困惑|不解|疑惑)/.test(content)) return 'curious';
  if (/(嘴角上扬|眉眼弯弯|笑意|轻笑|终于成功)/.test(content)) return 'happy';
  if (/(狡黠|调皮|打趣|眨眨眼|俏皮|故意捉弄)/.test(content)) return 'playful';
  if (/(眷恋|思念|心动|想你|喜欢你|爱你)/.test(content)) return 'loving';
  if (/(太尴尬|尴尬死了|说错话|窘迫|无地自容|社死)/.test(content)) return 'embarrassed';
  if (/(耳尖(?:微|泛)?红|脸颊泛红|红着脸|不好意思|难为情|局促|慌乱|移开视线|别开视线)/.test(content)) return 'shy';
  if (/(对不起|抱歉|请原谅|是我的错|我很惭愧)/.test(content)) return 'apologetic';
  if (/(你确定|靠谱吗|可疑|表示怀疑|我很怀疑|不太可信)/.test(content)) return 'skeptical';
  if (/(交给我|我能做到|我确定|一定可以|我会做到|不会放弃|由我来)/.test(content)) return 'confident';
  if (/(太棒了|开心得不得了|高兴得不得了|笑死我了|乐坏了|欣喜若狂|开怀大笑|喜出望外)/.test(content)) return 'delighted';
  if (/(太震惊|完全不敢相信|难以置信|惊呆了|吓了一跳|目瞪口呆)/.test(content)) return 'shocked';
  if (/(气死我了|绝对不能原谅|不可原谅|怒不可遏|火冒三丈|暴怒)/.test(content)) return 'furious';
  if (/(好委屈|心都要碎|心碎|委屈极了|痛彻心扉|忍不住想哭)/.test(content)) return 'heartbroken';
  if (/(表示怀疑|我很怀疑|不太可信|真的[吗么]|你确定|靠谱吗|可疑)/.test(content)) return 'skeptical';
  if (/(太尴尬|尴尬死了|说错话|窘迫|无地自容|社死)/.test(content)) return 'embarrassed';
  if (/(太兴奋|很兴奋|激动|雀跃|迫不及待)/.test(content)) return 'excited';
  if (/(难过|伤心|悲伤|失落|想哭|心痛)/.test(content)) return 'sad';
  if (/(温柔|陪着你|陪伴你|放心|别害怕|不用怕)/.test(content)) return 'gentle';
  const base = canonicalEmotion(String(baseEmotion).toLowerCase()) ?? 'neutral';
  const warmth = clampFacialWeight(personality?.warmth ?? 0);
  const calmness = clampFacialWeight(personality?.calmness ?? 0);
  const affection = clampFacialWeight(personality?.affection ?? 0);
  const concern = clampFacialWeight(personality?.concern ?? 0);
  if (normalizedIntent === 'greeting' || normalizedIntent === 'inviting') return 'greeting';
  if (normalizedIntent === 'gratitude') return 'grateful';
  if (normalizedIntent === 'apologizing' || /(对不起|抱歉|请原谅)/.test(content)) return 'apologetic';
  if (normalizedIntent === 'playful' || /(开玩笑|逗你|调皮)/.test(content)) return 'playful';
  if ((normalizedIntent === 'confident' || normalizedIntent === 'determined'
      || /(交给我|我能做到|我确定|一定可以)/.test(content))
    && !['angry', 'sad', 'concerned', 'shy'].includes(base)) return 'confident';
  if (normalizedIntent === 'explaining'
    && ['neutral', 'serious'].includes(base)
    && warmth < 0.5 && affection < 0.5 && concern < 0.5) return 'explaining';

  if (warmth < 0.5 && calmness < 0.5 && affection < 0.5 && concern < 0.5) return base;

  // Strong emotions stay authoritative. Personality only refines calm or caring speech.
  if (['angry', 'surprised', 'excited', 'sad', 'shy', 'thinking'].includes(base)) return base;
  if (affection >= 0.5 && /(愿为你|陪你|伴你|守着你|与你一起|为你奏|喜欢你|爱你)/.test(content)) {
    return 'loving';
  }
  if (concern >= 0.5 && /(担心|忧虑|不安|孤单|孤独|难以入眠|睡不着|还没休息|疲惫|累了)/.test(content)) {
    return 'concerned';
  }
  if (warmth >= 0.5 && /(安慰|歌声|安眠|休息|放松|慢慢来|我会在|没关系|不妨)/.test(content)) {
    return 'gentle';
  }
  if (base === 'concerned') {
    if (affection >= 0.7 && Math.abs(cueIndex) % 3 === 2) return 'loving';
    if (warmth >= 0.6 && Math.abs(cueIndex) % 2 === 1) return 'gentle';
    return 'concerned';
  }
  if (warmth >= 0.7 && ['neutral', 'serious', 'curious', 'explaining'].includes(base)) {
    return affection >= 0.7 && Math.abs(cueIndex) % 3 === 2 ? 'loving' : 'gentle';
  }
  return base;
}

export function createExpressionPose(emotion: string, intensity = 1, phase = 1): FacialPose {
  const recipe = RECIPES[canonicalEmotion(String(emotion).toLowerCase()) ?? 'neutral'];
  const scale = clampFacialWeight(intensity) * clampFacialWeight(phase);
  const empty = createEmptyFacialPose();
  return Object.fromEntries(FACIAL_CHANNELS.map(channel => [
    channel,
    clampFacialWeight((recipe[channel] ?? empty[channel]) * scale)
  ])) as unknown as FacialPose;
}

export function createExpressionChannelPose(
  emotion: string,
  channel: FacialChannel,
  intensity = 1
): FacialPose {
  const empty = createEmptyFacialPose();
  const previewWeight = getExpressionChannelPreviewWeight(emotion, channel, intensity);
  return {
    ...empty,
    [channel]: previewWeight
  };
}

export function getExpressionChannelPreviewWeight(
  emotion: string,
  channel: FacialChannel,
  intensity = 1
): number {
  const authoredWeight = createExpressionPose(emotion, intensity, 1)[channel];
  const previewMinimum = channel === 'tears'
    ? 0.16
    : channel === 'blush'
      ? 0.24
      : channel === 'eyeLidClose'
        ? 0.82
      : channel === 'jawOpen' || channel === 'mouthClose'
        ? 0.3
        : 0.38;
  return authoredWeight > 0 ? Math.max(authoredWeight, previewMinimum) : 0;
}
