const policy = require('../tts_engine/voice_identity_policy.json');

const POLICY_VERSION = policy.version;

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, range, fallback) {
  const parsed = finiteNumber(value, fallback);
  return Math.min(range[1], Math.max(range[0], parsed));
}

function getEmotionProsody(emotion) {
  const fallback = policy.emotionProsody.gentle;
  const selected = policy.emotionProsody[String(emotion || '')] || fallback;
  return { ...selected };
}

function sanitizeEngineParams(input = {}) {
  const result = { ...input };
  const prosody = getEmotionProsody(result.emotion);

  // Sampling controls voice identity in zero-shot mode. Keep it identical for
  // every emotion; emotion is expressed by restrained prosody instead.
  result.temperature = policy.sampling.temperature;
  result.top_p = policy.sampling.topP;
  if (result.speed !== undefined) {
    result.speed = clamp(result.speed, policy.limits.speed, prosody.speed);
  } else if (result.emotion && result.emotion !== 'auto') {
    result.speed = prosody.speed;
  }

  if (result.speed_offset !== undefined) {
    result.speed_offset = clamp(result.speed_offset, policy.limits.speedOffset, 0);
  }
  if (result.pitch_offset !== undefined) {
    result.pitch_offset = clamp(result.pitch_offset, policy.limits.pitchOffset, 0);
  }
  if (result.temp_offset !== undefined) {
    result.temp_offset = clamp(result.temp_offset, policy.limits.temperatureOffset, 0);
  }
  if (result.soft_offset !== undefined) {
    result.soft_offset = clamp(result.soft_offset, policy.limits.softOffset, 0);
  }
  if (result.volume_offset !== undefined) {
    result.volume_offset = clamp(result.volume_offset, policy.limits.volumeOffset, 0);
  }
  result.voice_identity_policy = POLICY_VERSION;
  return result;
}

function sanitizeTuningConfig(input = {}) {
  const result = { ...input };
  result.globalSpeedOffset = clamp(result.globalSpeedOffset, policy.limits.speedOffset, 0);
  result.globalPitchOffset = clamp(result.globalPitchOffset, policy.limits.pitchOffset, 0);
  result.globalTempOffset = clamp(result.globalTempOffset, policy.limits.temperatureOffset, 0);
  result.globalSoftOffset = clamp(result.globalSoftOffset, policy.limits.softOffset, 0);
  result.globalVolumeOffset = clamp(result.globalVolumeOffset, policy.limits.volumeOffset, 0);

  const sourceProfiles = result.emotion_profiles || result.emotions || {};
  const profiles = {};
  for (const [emotion, source] of Object.entries(sourceProfiles)) {
    const profile = { ...(source || {}) };
    const prosody = getEmotionProsody(emotion);
    profile.temperature = policy.sampling.temperature;
    profile.top_p = policy.sampling.topP;
    profile.speed = clamp(profile.speed, policy.limits.speed, prosody.speed);
    profiles[emotion] = profile;
  }
  result.emotion_profiles = profiles;
  if (Object.prototype.hasOwnProperty.call(result, 'emotions')) {
    result.emotions = profiles;
  }
  result.voiceIdentityPolicy = POLICY_VERSION;
  return result;
}

module.exports = {
  POLICY_VERSION,
  getEmotionProsody,
  sanitizeEngineParams,
  sanitizeTuningConfig
};
