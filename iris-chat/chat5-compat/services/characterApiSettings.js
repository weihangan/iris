// 角色级 API 配置。
//
// API key、provider、base URL 和 model 都属于角色的运行时设定，不能再
// 使用 data/settings.json 作为唯一来源。这个服务只负责角色目录中的
// api_settings.json；provider_registry.json 仍然是全局的供应商目录。
const fs = require('fs');
const path = require('path');
const { CHARACTER_DIR } = require('./appPaths');
const { writeJsonAtomic } = require('./atomic-persistence');

const SETTINGS_FILENAME = 'api_settings.json';
const DEFAULT_SETTINGS = Object.freeze({
  provider: 'custom',
  apiKey: '',
  baseUrl: '',
  model: '',
  capability: '',
  reasoning: '',
});

function normalizeCharacterId(characterId) {
  const id = String(characterId == null ? '' : characterId).trim();
  // 角色 ID 来自 URL 路径，拒绝路径分隔符和 dot segments，避免配置文件
  // 被写到 character 目录之外。现有数字/英文/下划线/连字符 ID 均兼容。
  if (!id || id === '.' || id === '..' || /[<>:"|?*\\/\0]/.test(id)) {
    throw new Error('INVALID_CHARACTER_ID');
  }
  return id;
}

function getCharacterSettingsPath(characterId) {
  const id = normalizeCharacterId(characterId);
  const root = path.resolve(CHARACTER_DIR);
  const filePath = path.resolve(root, id, SETTINGS_FILENAME);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!filePath.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error('INVALID_CHARACTER_ID');
  }
  return filePath;
}

function cleanString(value, maxLength) {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().slice(0, maxLength);
}

function normalizeSettings(value = {}, fallback = DEFAULT_SETTINGS) {
  const source = value && typeof value === 'object' ? value : {};
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_SETTINGS;
  const provider = cleanString(source.provider, 64);
  const apiKey = cleanString(source.apiKey, 4096);
  const baseUrl = cleanString(source.baseUrl, 2048);
  const model = cleanString(source.model, 256);
  const capability = cleanString(source.capability, 64);
  const reasoning = cleanString(source.reasoning, 32);
  return {
    provider: (provider || base.provider || DEFAULT_SETTINGS.provider).toLowerCase(),
    apiKey: apiKey !== undefined ? apiKey : String(base.apiKey || ''),
    baseUrl: baseUrl !== undefined ? baseUrl : String(base.baseUrl || ''),
    model: model !== undefined ? model : String(base.model || ''),
    capability: capability !== undefined ? capability : String(base.capability || ''),
    reasoning: reasoning !== undefined ? reasoning : String(base.reasoning || ''),
  };
}

function hasLegacyApiSettings(value) {
  if (!value || typeof value !== 'object') return false;
  return Boolean(
    String(value.apiKey || '').trim()
    || String(value.baseUrl || '').trim()
    || String(value.model || '').trim()
    || (value.provider && String(value.provider).toLowerCase() !== DEFAULT_SETTINGS.provider),
  );
}

function readCharacterApiSettings(characterId, options = {}) {
  const filePath = getCharacterSettingsPath(characterId);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return normalizeSettings(parsed);
    }
  } catch (error) {
    console.error(`[CharacterApiSettings] 读取 ${characterId}/${SETTINGS_FILENAME} 失败:`, error.message);
  }

  // 兼容升级前的 data/settings.json：只在当前角色没有自己的配置时迁移
  // 一份，后续角色不会共享这份文件，也不会覆盖已存在的角色配置。
  if (hasLegacyApiSettings(options.legacySettings)) {
    const migrated = normalizeSettings(options.legacySettings);
    try {
      writeCharacterApiSettings(characterId, migrated);
      console.log(`[CharacterApiSettings] 已将旧全局 API 配置迁移到角色 ${characterId}`);
    } catch (error) {
      console.error(`[CharacterApiSettings] 迁移角色 ${characterId} API 配置失败:`, error.message);
    }
    return migrated;
  }
  return normalizeSettings(DEFAULT_SETTINGS);
}

function writeCharacterApiSettings(characterId, updates = {}) {
  const filePath = getCharacterSettingsPath(characterId);
  const existing = readCharacterApiSettingsWithoutMigration(characterId);
  const merged = normalizeSettings(updates, existing);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonAtomic(filePath, merged);
  return merged;
}

function readCharacterApiSettingsWithoutMigration(characterId) {
  const filePath = getCharacterSettingsPath(characterId);
  try {
    if (fs.existsSync(filePath)) {
      return normalizeSettings(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    }
  } catch (error) {
    console.error(`[CharacterApiSettings] 读取 ${characterId}/${SETTINGS_FILENAME} 失败:`, error.message);
  }
  return normalizeSettings(DEFAULT_SETTINGS);
}

function ensureCharacterApiSettings(characterId) {
  const filePath = getCharacterSettingsPath(characterId);
  if (fs.existsSync(filePath)) return readCharacterApiSettingsWithoutMigration(characterId);
  return writeCharacterApiSettings(characterId, DEFAULT_SETTINGS);
}

module.exports = {
  SETTINGS_FILENAME,
  DEFAULT_SETTINGS,
  normalizeCharacterId,
  getCharacterSettingsPath,
  normalizeSettings,
  hasLegacyApiSettings,
  readCharacterApiSettings,
  writeCharacterApiSettings,
  ensureCharacterApiSettings,
};
