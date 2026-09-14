// owner-trace: wha1999/core/paths
const fs = require('fs');
const path = require('path');
const { runCharacterDataMigrations } = require('./characterDataMigration');

const APP_ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const BUNDLED_DATA_DIR = path.join(APP_ROOT, 'data');
const BUNDLED_CHARACTER_DIR = path.join(APP_ROOT, 'character');
const HAS_EXTERNAL_USER_DATA = Boolean(process.env.APP_DATA_DIR);
const APP_DATA_ROOT = HAS_EXTERNAL_USER_DATA
  ? path.resolve(process.env.APP_DATA_DIR)
  : APP_ROOT;
const DATA_DIR = HAS_EXTERNAL_USER_DATA ? path.join(APP_DATA_ROOT, 'data') : BUNDLED_DATA_DIR;
const CHARACTER_DIR = HAS_EXTERNAL_USER_DATA ? path.join(APP_DATA_ROOT, 'characters') : BUNDLED_CHARACTER_DIR;
const UPLOADS_DIR = HAS_EXTERNAL_USER_DATA ? path.join(APP_DATA_ROOT, 'uploads') : path.join(APP_ROOT, 'public', 'uploads');
const CACHE_DIR = HAS_EXTERNAL_USER_DATA ? path.join(APP_DATA_ROOT, 'cache') : path.join(APP_ROOT, 'cache');
const TRAINING_DIR = HAS_EXTERNAL_USER_DATA ? path.join(APP_DATA_ROOT, 'training') : path.join(APP_ROOT, 'voice_engine', 'output');
const USER_VOICES_DIR = HAS_EXTERNAL_USER_DATA ? path.join(APP_DATA_ROOT, 'voices') : path.join(APP_ROOT, 'voices');

const RUNTIME_DATA_FILES = new Set([
  'greeting_state.json',
  'voice_cache.json',
  'voice_cache_manifest.json',
]);

const PRIVATE_OR_USER_DATA_FILES = new Set([
  'settings.json',
  'provider_registry.json',
  'kuro_token.json',
  'knowledge_urls.json',
  'current_character.txt',
]);

function shouldSkipBundledData(name) {
  if (RUNTIME_DATA_FILES.has(name) || PRIVATE_OR_USER_DATA_FILES.has(name) || name === 'release.json') {
    return true;
  }
  return /(?:chat_history|compressed_history|memory|messages|search_index|knowledge_index|greeting_state|voice_cache)/i.test(name)
    || /\.bak(?:_|$)/i.test(name);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyBundledDefaults() {
  if (!HAS_EXTERNAL_USER_DATA) return;
  ensureDir(DATA_DIR);
  if (fs.existsSync(BUNDLED_DATA_DIR)) {
    for (const entry of fs.readdirSync(BUNDLED_DATA_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || shouldSkipBundledData(entry.name)) continue;
      const source = path.join(BUNDLED_DATA_DIR, entry.name);
      const target = path.join(DATA_DIR, entry.name);
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    }
  }

  // Merge newly bundled character folders into an existing userData layout.
  // Existing character folders remain authoritative and are never overwritten.
  ensureDir(CHARACTER_DIR);
  if (fs.existsSync(BUNDLED_CHARACTER_DIR)) {
    for (const entry of fs.readdirSync(BUNDLED_CHARACTER_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = path.join(BUNDLED_CHARACTER_DIR, entry.name);
      const target = path.join(CHARACTER_DIR, entry.name);
      if (!fs.existsSync(target)) fs.cpSync(source, target, { recursive: true, errorOnExist: false });
    }
  }
}

function ensureUserDataLayout() {
  ensureDir(APP_DATA_ROOT);
  ensureDir(DATA_DIR);
  ensureDir(UPLOADS_DIR);
  ensureDir(CACHE_DIR);
  ensureDir(TRAINING_DIR);
  ensureDir(USER_VOICES_DIR);
  ensureDir(path.join(DATA_DIR, 'gallery'));
  ensureDir(path.join(DATA_DIR, 'backgrounds'));
  copyBundledDefaults();
}

ensureUserDataLayout();
if (HAS_EXTERNAL_USER_DATA) {
  runCharacterDataMigrations({
    bundledCharacterDir: BUNDLED_CHARACTER_DIR,
    characterDir: CHARACTER_DIR,
    dataDir: DATA_DIR,
  });
}

module.exports = {
  APP_ROOT,
  APP_DATA_ROOT,
  DATA_DIR,
  CHARACTER_DIR,
  UPLOADS_DIR,
  CACHE_DIR,
  TRAINING_DIR,
  USER_VOICES_DIR,
  BUNDLED_DATA_DIR,
  BUNDLED_CHARACTER_DIR,
  HAS_EXTERNAL_USER_DATA,
  ensureUserDataLayout,
};
