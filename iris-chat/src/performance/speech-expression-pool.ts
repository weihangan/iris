import type { AvatarPerformanceProfile } from '../actor/avatar-performance-profile';
import { FACIAL_CHANNELS, type FacialChannel } from './facial-pose';
import type { AcceptedExpressionRecord } from './daily-candidate-types';
import {
  getExpressionChannelPreviewWeight,
  getExpressionMicroAccents,
  getExpressionRecipeDefinitions
} from './expression-recipes';

export interface SpeechExpressionPoolEntry {
  readonly id: string;
  readonly name: string;
  readonly previewOnly: false;
  readonly automatic: true;
  readonly microAccents: readonly string[];
  readonly supported: boolean;
  readonly supportedChannels: readonly FacialChannel[];
  readonly missingChannels: readonly FacialChannel[];
  readonly channels: readonly SpeechExpressionPoolChannel[];
}

export interface SpeechExpressionPoolChannel {
  readonly id: FacialChannel;
  readonly name: string;
  readonly weight: number;
  readonly supported: boolean;
}

const CHANNEL_NAMES: Readonly<Record<FacialChannel, string>> = {
  browInnerUp: '双眉内侧轻抬',
  browOuterUpLeft: '双眉尾轻抬',
  browOuterUpRight: '右眉尾轻抬',
  browDownLeft: '双眉轻压',
  browDownRight: '右眉轻压',
  eyeWideLeft: '双眼微睁',
  eyeWideRight: '右眼微睁',
  eyeSquintLeft: '双眼柔和',
  eyeSquintRight: '右眼柔和',
  eyeSmile: '双眼笑意',
  eyeLidClose: '眨眼（瞬时）',
  cheekRaiseLeft: '双脸颊轻抬',
  cheekRaiseRight: '右脸颊轻抬',
  mouthSmileLeft: '双嘴角微扬',
  mouthSmileRight: '右嘴角微扬',
  mouthFrownLeft: '双嘴角轻落',
  mouthFrownRight: '右嘴角轻落',
  mouthStretchLeft: '双嘴角舒展',
  mouthStretchRight: '右嘴角舒展',
  mouthPucker: '嘴唇轻收',
  mouthClose: '轻闭嘴唇',
  jawOpen: '下颌微开',
  blush: '脸颊微红',
  tears: '眼泪'
};

const PAIRED_CHANNELS: Readonly<Partial<Record<FacialChannel, FacialChannel>>> = {
  browOuterUpLeft: 'browOuterUpRight',
  browDownLeft: 'browDownRight',
  eyeWideLeft: 'eyeWideRight',
  eyeSquintLeft: 'eyeSquintRight',
  cheekRaiseLeft: 'cheekRaiseRight',
  mouthSmileLeft: 'mouthSmileRight',
  mouthFrownLeft: 'mouthFrownRight',
  mouthStretchLeft: 'mouthStretchRight'
};
const HIDDEN_RIGHT_CHANNELS = new Set<FacialChannel>(Object.values(PAIRED_CHANNELS));

export function isSpeechExpressionChannelSupported(
  profile: AvatarPerformanceProfile,
  channel: FacialChannel
): boolean {
  if (channel === 'blush') return Boolean(profile.blushMorph);
  if (channel === 'tears') return Boolean(profile.tearsMorph);
  const ownSupported = Boolean(profile.facialChannels?.[channel]?.morphs.length);
  const pair = PAIRED_CHANNELS[channel];
  return ownSupported && (!pair || Boolean(profile.facialChannels?.[pair]?.morphs.length));
}

export function getSupportedSpeechExpressionChannels(
  profile: AvatarPerformanceProfile
): readonly FacialChannel[] {
  return FACIAL_CHANNELS.filter(channel => isSpeechExpressionChannelSupported(profile, channel));
}

export function buildSpeechExpressionPool(
  profile: AvatarPerformanceProfile,
  acceptedExpressions: readonly AcceptedExpressionRecord[] = []
): readonly SpeechExpressionPoolEntry[] {
  const isSupported = (channel: FacialChannel): boolean => isSpeechExpressionChannelSupported(profile, channel);
  const recipes = getExpressionRecipeDefinitions().map(definition => {
    const recipeChannels = Object.entries(definition.recipe)
      .filter(([, weight]) => Number(weight) > 0)
      .map(([channel]) => channel as FacialChannel);
    const channels = recipeChannels.filter(channel => !HIDDEN_RIGHT_CHANNELS.has(channel));
    const supportedChannels = channels.filter(isSupported);
    const supportedSet = new Set<FacialChannel>(supportedChannels);
    return {
      id: definition.id,
      name: definition.name,
      previewOnly: false as const,
      automatic: true as const,
      microAccents: getExpressionMicroAccents(definition.id).map(accent => accent.id),
      supported: supportedChannels.length > 0,
      supportedChannels,
      missingChannels: channels.filter(channel => !supportedSet.has(channel)),
      channels: channels.map(channel => ({
        id: channel,
        name: CHANNEL_NAMES[channel],
        // The button applies a calibrated single-channel preview, so report
        // that effective weight instead of the much smaller authored base.
        weight: getExpressionChannelPreviewWeight(definition.id, channel),
        supported: supportedSet.has(channel)
      }))
    };
  });
  const dynamic = acceptedExpressions.map(entry => {
    const channels = Object.entries(entry.channelCurves)
      .filter(([, keys]) => Boolean(keys?.length))
      .map(([channel]) => channel as FacialChannel)
      .filter(channel => !HIDDEN_RIGHT_CHANNELS.has(channel));
    const supportedChannels = channels.filter(isSupported);
    const supportedSet = new Set<FacialChannel>(supportedChannels);
    return {
      id: entry.id,
      name: entry.displayName,
      previewOnly: false as const,
      automatic: true as const,
      microAccents: [],
      supported: supportedChannels.length > 0,
      supportedChannels,
      missingChannels: channels.filter(channel => !supportedSet.has(channel)),
      channels: channels.map(channel => ({
        id: channel,
        name: CHANNEL_NAMES[channel],
        weight: Math.max(0, ...(entry.channelCurves[channel] ?? []).map(key => key.value)),
        supported: supportedSet.has(channel)
      }))
    };
  });
  return [...recipes, ...dynamic];
}
