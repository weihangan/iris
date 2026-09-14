const crypto = require('crypto');

function hashKey(payload, voiceName) {
  const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return `${hash}_${voiceName || 'default'}`;
}

function compatibleModelVersions(flavor, modelVersion) {
  const versions = new Set([modelVersion]);
  const normalizedFlavor = String(flavor || 'universal');
  for (const prefix of ['chatx2', 'chat5']) {
    versions.add(`${prefix}-${normalizedFlavor}-gpu-v1`);
    versions.add(`${prefix}-${normalizedFlavor}-cpu-v1`);
  }
  if (modelVersion) {
    versions.add(String(modelVersion).replace('-gpu-', '-cpu-'));
    versions.add(String(modelVersion).replace('-cpu-', '-gpu-'));
  }
  return [...versions].filter(Boolean);
}

function buildVoiceCacheKeys(input, allowCompatibleVersions = false) {
  const text = String(input.text || '');
  const voiceName = input.voiceName || 'default';
  const variant = input.variant || 'default';
  const flavor = input.flavor || 'universal';
  const modelVersion = input.modelVersion || 'unknown';
  const keys = [];
  const versions = allowCompatibleVersions
    ? compatibleModelVersions(flavor, modelVersion)
    : [modelVersion];

  for (const version of versions) {
    keys.push(hashKey(`${text}|${voiceName}|${variant}|${flavor}|${version}`, voiceName));
  }
  if (allowCompatibleVersions) {
    keys.push(hashKey(text, voiceName));
    keys.push(hashKey(`${text}|${voiceName}`, voiceName));
    keys.push(hashKey(`${text}|${voiceName}|${variant}`, voiceName));
  }
  return [...new Set(keys)];
}

module.exports = { buildVoiceCacheKeys };

