// owner-trace: wha1999/core/server（防伪与版本追踪，请勿删除）
// provenance: wha9917/private-optimizations (inert; no runtime decision)
const APP_RELEASE_SIG = 'd2hhMTk5OS1XSU5ET1dTLVVOSVZFUlNBTC12NS4yLTIwMjYwNzE0';
const APP_BUILD_HASH = 'c4c0f84c59fe1b95';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');

require('dotenv').config();

const {
  APP_DATA_ROOT,
  DATA_DIR,
  CHARACTER_DIR,
  UPLOADS_DIR,
  CACHE_DIR,
  TRAINING_DIR,
  USER_VOICES_DIR,
} = require('./services/appPaths');

const aiClient = require('./services/aiClient');
const characterApiSettings = require('./services/characterApiSettings');
const memoryService = require('./services/memoryService');
const historyService = require('./services/historyService');
const promptBuilder = require('./services/promptBuilder');
const archiveService = require('./services/archiveService');
const distillService = require('./services/distillService');
const stickerService = require('./services/stickerService');
const replyPolicy = require('./services/replyPolicy');
const replyPerformancePolicy = require('./services/replyPerformancePolicy');
const proactiveContextPolicy = require('./services/proactiveContextPolicy');
const worldKnowledgeSearch = require('./services/worldKnowledgeSearch');
const { getRuntimeFlavor } = require('./services/runtimeFlavor');
const runtimeFlavor = getRuntimeFlavor();
const { createLocalAsrService } = require('./services/localAsrService');
const localAsrService = createLocalAsrService({ appRoot: __dirname, runtimeFlavor });
process.once('exit', () => localAsrService.dispose());
const {
  POLICY_VERSION: VOICE_IDENTITY_POLICY_VERSION,
  sanitizeEngineParams,
  sanitizeTuningConfig,
} = require('./services/voiceIdentityPolicy');
const {
  getSystemMemoryStatus,
  probeNvidiaGpu,
  buildResourceStatus,
  formatResourceSummary,
} = require('./services/ttsPreflight');
const {
  classifyTtsService,
  matchesOwnedService,
  readOwnershipRecord,
  writeOwnershipRecord,
  clearOwnershipRecord,
} = require('./services/ttsRuntimeState');
const { buildVoiceCacheKeys } = require('./services/voiceCacheIdentity');
const { writeUtf8Atomic, writeJsonAtomic } = require('./services/atomic-persistence');
const { createTtsWarmupController } = require('./services/ttsWarmup');
const {
  appendTrainLog,
  readTrainLogsSince,
  resetTrainLogs,
} = require('./services/boundedTrainLog');
const {
  createCompletedDistillTask,
  toPublicDistillTask,
} = require('./services/distillTaskState');
const {
  selectTrainingRuntime,
  inspectVoiceClonePreflight,
  detectInputMode,
} = require('./services/voiceClonePreflight');

console.log(`[RuntimeFlavor] flavor=${runtimeFlavor.flavor}, device=${runtimeFlavor.expectedDevice}, isHalf=${runtimeFlavor.isHalf}`);

const app = express();
const PORT = process.env.PORT || 3013;

// 文件上传配置（用于自定义蒸馏的图片/语音上传）
const uploadDir = path.join(UPLOADS_DIR, 'distill');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB（语音文件可能较大）
  fileFilter: (req, file, cb) => {
    const allowedImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    const allowedAudio = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.aac', '.flac'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedImage.includes(ext) || allowedAudio.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件类型，仅支持图片和语音文件'));
    }
  },
});
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const UPLOAD_DIR = UPLOADS_DIR;
const CURRENT_CHAR_PATH = path.join(DATA_DIR, 'current_character.txt');

app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { index: false, fallthrough: true }));
app.use('/character', express.static(CHARACTER_DIR, { index: false, fallthrough: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function getCurrentCharacterId() {
  try {
    return fs.readFileSync(CURRENT_CHAR_PATH, 'utf-8').trim() || '1';
  } catch (e) {
    return '1';
  }
}

function setCurrentCharacterId(id) {
  writeUtf8Atomic(CURRENT_CHAR_PATH, id);
}

// ============================================================
// 语音库管理 — 语音独立于角色，存储在 GPT-SoVITS/voices/<name>/
// 兼容旧架构：character/<id>/voice/ 也作为语音源
// ============================================================
// 用户克隆声音优先，包内声音作为只读基础；同名时 userData 覆盖 bundled。
const BUNDLED_VOICES_DIR = runtimeFlavor.voicesDir;
const VOICE_DIRS = [
  { dir: USER_VOICES_DIR, source: 'user' },
  { dir: BUNDLED_VOICES_DIR, source: 'bundled' },
].filter((item, index, all) =>
  all.findIndex(x => path.resolve(x.dir).toLowerCase() === path.resolve(item.dir).toLowerCase()) === index
);
const CHARACTER_VOICE_MAP_PATH = path.join(DATA_DIR, 'character_voices.json');

function characterVoiceSettingsPath(charId) {
  const id = String(charId ?? '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  return path.join(CHARACTER_DIR, id, 'voice_settings.json');
}

function readCharacterVoiceSettings(charId) {
  const target = characterVoiceSettingsPath(charId);
  if (!target || !fs.existsSync(target)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    return value && typeof value.voiceName === 'string' ? value : null;
  } catch (e) {
    console.warn('[Voices] 角色语音设置读取失败:', e.message);
    return null;
  }
}

function writeCharacterVoiceSettings(charId, voiceName) {
  const target = characterVoiceSettingsPath(charId);
  if (!target) throw new Error('角色 ID 无效');
  writeJsonAtomic(target, { schemaVersion: 1, voiceName: String(voiceName).trim() });
}

function forEachCharacterVoiceSetting(callback) {
  if (!fs.existsSync(CHARACTER_DIR) || !fs.statSync(CHARACTER_DIR).isDirectory()) return;
  for (const entry of fs.readdirSync(CHARACTER_DIR)) {
    const dir = path.join(CHARACTER_DIR, entry);
    if (!fs.statSync(dir).isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry)) continue;
    const settingsPath = characterVoiceSettingsPath(entry);
    if (!settingsPath || !fs.existsSync(settingsPath)) continue;
    const settings = readCharacterVoiceSettings(entry);
    if (settings) callback(entry, settings, settingsPath);
  }
}

/** 读取角色→语音映射 */
function readCharacterVoiceMap() {
  try {
    return JSON.parse(fs.readFileSync(CHARACTER_VOICE_MAP_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
}

/** 写入角色→语音映射 */
function writeCharacterVoiceMap(map) {
  writeJsonAtomic(CHARACTER_VOICE_MAP_PATH, map);
}

/** 扫描所有可用语音（新架构 voices/ + 旧架构 character/<id>/voice/） */
function scanVoices() {
  const voices = [];
  // 1. 新架构：userData/voices 优先，包内 voices 只读回退。
  try {
    for (const { dir, source } of VOICE_DIRS) {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        if (voices.find(v => v.name === name)) continue;
        const vdir = path.join(dir, name);
        if (!fs.statSync(vdir).isDirectory()) continue;
        const gpt = path.join(vdir, 'gpt.ckpt');
        const sovits = path.join(vdir, 'sovits.pth');
        if (!fs.existsSync(gpt) || !fs.existsSync(sovits)) continue;
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(path.join(vdir, 'config.json'), 'utf-8')); } catch (e) {}
        voices.push({
          name,
          source,
          protected: source !== 'user',
          readOnly: source !== 'user',
          canRename: source === 'user',
          canDelete: source === 'user',
          voice_dir: vdir,
          has_config: fs.existsSync(path.join(vdir, 'config.json')),
          emotion_count: cfg.emotion_profiles ? Object.keys(cfg.emotion_profiles).length : 0,
        });
      }
    }
  } catch (e) { console.error('[Voices] 扫描新架构失败:', e.message); }
  // 2. 兼容旧架构：character/<id>/voice/（名称取自 config.json 的 character_name）
  try {
    const charDir = CHARACTER_DIR;
    if (fs.existsSync(charDir)) {
      for (const cid of fs.readdirSync(charDir)) {
        const vdir = path.join(charDir, cid, 'voice');
        if (!fs.existsSync(vdir) || !fs.statSync(vdir).isDirectory()) continue;
        const gpt = path.join(vdir, 'gpt.ckpt');
        const sovits = path.join(vdir, 'sovits.pth');
        if (!fs.existsSync(gpt) || !fs.existsSync(sovits)) continue;
        let vname = cid;
        let cfg = {};
        try {
          cfg = JSON.parse(fs.readFileSync(path.join(vdir, 'config.json'), 'utf-8'));
          vname = cfg.character_name || cfg.voice_name || cid;
        } catch (e) {}
        // 不覆盖新架构的同名语音
        if (voices.find(v => v.name === vname)) continue;
        voices.push({
          name: vname,
          source: 'legacy',
          protected: true,
          readOnly: true,
          canRename: false,
          canDelete: false,
          voice_dir: vdir,
          char_id: cid,
          has_config: fs.existsSync(path.join(vdir, 'config.json')),
          emotion_count: cfg.emotion_profiles ? Object.keys(cfg.emotion_profiles).length : 0,
        });
      }
    }
  } catch (e) { console.error('[Voices] 扫描旧架构失败:', e.message); }
  return voices;
}

/** 获取角色当前分配的语音名称 */
function getCharacterVoiceName(charId) {
  const characterSettings = readCharacterVoiceSettings(charId);
  const map = readCharacterVoiceMap();
  const voices = scanVoices();
  if (characterSettings?.voiceName && voices.some(v => v.name === characterSettings.voiceName)) {
    return characterSettings.voiceName;
  }
  if (map[charId] && voices.some(v => v.name === map[charId])) {
    // 懒迁移旧共享映射，之后该角色由自己的文件作为权威来源。
    if (!characterSettings) {
      try { writeCharacterVoiceSettings(charId, map[charId]); } catch (e) { /* 兼容只读旧数据 */ }
    }
    return map[charId];
  }
  // 未显式分配时，尝试用旧架构 character/<id>/voice/ 的名称
  const legacy = voices.find(v => v.source === 'legacy' && v.char_id === String(charId));
  if (legacy) return legacy.name;
  // 回退到第一个可用语音
  if (voices.length > 0) return voices[0].name;
  return null;
}

function ensureDataFiles() {
  const dataDir = DATA_DIR;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const files = {
    'settings.json': JSON.stringify({ provider: 'custom', apiKey: '', baseUrl: '', model: '', capability: '', reasoning: '' }, null, 2),
    'knowledge_urls.json': '[]',
  };

  for (const [filename, defaultContent] of Object.entries(files)) {
    const filePath = path.join(dataDir, filename);
    if (!fs.existsSync(filePath)) {
      writeUtf8Atomic(filePath, defaultContent);
      console.log(`[Init] 创建数据文件: ${filename}`);
    }
  }
}

function ensureDefaultCharacter() {
  // 不再自动创建default角色，使用已有的角色1/2/3
  const charDir = path.join(CHARACTER_DIR, 'default');
  if (!fs.existsSync(charDir)) {
    return; // 不创建default
  }
}

function readSettings() {
  try {
    const data = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return { provider: 'deepseek', apiKey: '', baseUrl: '', model: '' };
  }
}

// 角色 API 配置只保存在 character/<id>/api_settings.json。data/settings.json
// 中仍保留 conversationMode 等全局 UI 设置，并仅作为旧版本 API 配置的一次性
// 迁移来源。
function readCurrentCharacterApiSettings(characterId = getCurrentCharacterId()) {
  return characterApiSettings.readCharacterApiSettings(characterId, {
    legacySettings: readSettings(),
  });
}

function activateCharacterApiSettings(characterId = getCurrentCharacterId()) {
  const settings = readCurrentCharacterApiSettings(characterId);
  aiClient.setActiveSettings(settings);
  return settings;
}

// 后台蒸馏/压缩任务可能跨越角色切换，给它们一个固定角色配置的
// AI 客户端视图，避免异步任务在切换后误用新角色的 API key。
function createCharacterAiClient(characterId, settings = readCurrentCharacterApiSettings(characterId)) {
  return {
    ...aiClient,
    chatWithAI: (messages, options = {}) => aiClient.chatWithAI(messages, {
      ...options,
      settings,
    }),
    recognizeImage: (imageBase64, prompt) => aiClient.recognizeImage(imageBase64, prompt, settings),
    transcribeAudio: (audioBuffer, filename, mimeType) => (
      aiClient.transcribeAudio(audioBuffer, filename, mimeType, settings)
    ),
  };
}

function buildCurrentSettingsResponse(characterId = getCurrentCharacterId()) {
  const globalSettings = readSettings();
  const apiSettings = readCurrentCharacterApiSettings(characterId);
  return { ...globalSettings, ...apiSettings };
}

function writeSettings(settings) {
  writeJsonAtomic(SETTINGS_PATH, settings);
}

function applySettingsToEnv(settings) {
  // 保留环境变量兼容性（外部脚本可能读取它们），但真正的请求配置由
  // aiClient 的 activeSettings 提供，避免不同角色之间串 key。
  aiClient.setActiveSettings(settings);
  process.env.AI_PROVIDER = settings.provider || 'deepseek';

  const keyMap = {
    deepseek: { key: 'DEEPSEEK_API_KEY', url: 'DEEPSEEK_BASE_URL', model: 'DEEPSEEK_MODEL' },
    doubao: { key: 'DOUBAO_API_KEY', url: 'DOUBAO_BASE_URL', model: 'DOUBAO_MODEL' },
    glm: { key: 'GLM_API_KEY', url: 'GLM_BASE_URL', model: 'GLM_MODEL' },
    kimi: { key: 'KIMI_API_KEY', url: 'KIMI_BASE_URL', model: 'KIMI_MODEL' },
    openai: { key: 'OPENAI_API_KEY', url: 'OPENAI_BASE_URL', model: 'OPENAI_MODEL' },
    qwen: { key: 'QWEN_API_KEY', url: 'QWEN_BASE_URL', model: 'QWEN_MODEL' },
    siliconflow: { key: 'SILICONFLOW_API_KEY', url: 'SILICONFLOW_BASE_URL', model: 'SILICONFLOW_MODEL' },
    claude: { key: 'CLAUDE_API_KEY', url: 'CLAUDE_BASE_URL', model: 'CLAUDE_MODEL' },
    agnes: { key: 'AGNES_API_KEY', url: 'AGNES_BASE_URL', model: 'AGNES_MODEL' },
    custom: { key: 'CUSTOM_API_KEY', url: 'CUSTOM_BASE_URL', model: 'CUSTOM_MODEL' },
  };

  const provider = (settings.provider || 'deepseek').toLowerCase();
  const envKeys = keyMap[provider] || keyMap.deepseek;

  if (settings.apiKey) {
    process.env[envKeys.key] = settings.apiKey;
  }
  if (settings.baseUrl) {
    process.env[envKeys.url] = settings.baseUrl;
  }
  if (settings.model) {
    process.env[envKeys.model] = settings.model;
  }
}

function loadSettingsOnStartup() {
  const characterId = getCurrentCharacterId();
  const legacySettings = readSettings();
  const settings = readCurrentCharacterApiSettings(characterId);
  if (characterApiSettings.hasLegacyApiSettings(legacySettings)) {
    // 迁移完成后擦除旧的全局 API 字段，防止以后误把它当成共享配置。
    writeSettings({
      ...legacySettings,
      provider: 'deepseek',
      apiKey: '',
      baseUrl: '',
      model: '',
    });
    console.log(`[Init] 已清理旧 data/settings.json 中的全局 API 字段（角色 ${characterId} 已保留）`);
  }
  applySettingsToEnv(settings);
  console.log(`[Init] 从角色 ${characterId} 加载 API 配置: ${settings.provider}${settings.apiKey ? '' : '（未配置 Key）'}`);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/current-character', (req, res) => {
  const id = getCurrentCharacterId();
  const profile = promptBuilder.readCharacterProfile(id);
  const apiSettings = readCurrentCharacterApiSettings(id);
  res.json({
    success: true,
    characterId: id,
    name: profile.name || id,
    modelPackId: profile.modelPackId || null,
    apiConfigured: Boolean(apiSettings.apiKey),
    provider: apiSettings.provider,
  });
});

app.post('/api/current-character', (req, res) => {
  const { characterId } = req.body;
  if (!characterId) return res.json({ success: false, error: '缺少角色ID' });
  let normalizedCharacterId;
  try {
    normalizedCharacterId = characterApiSettings.normalizeCharacterId(characterId);
  } catch (error) {
    return res.json({ success: false, error: '角色ID无效' });
  }
  const characterDir = path.join(CHARACTER_DIR, normalizedCharacterId);
  if (!fs.existsSync(characterDir) || !fs.statSync(characterDir).isDirectory()) {
    return res.json({ success: false, error: '角色不存在' });
  }
  // 切换角色时清除情感缓存，不同角色应重新检测语气
  clearCachedEmotion();
  setCurrentCharacterId(normalizedCharacterId);
  const apiSettings = activateCharacterApiSettings(normalizedCharacterId);
  res.json({
    success: true,
    characterId: normalizedCharacterId,
    apiConfigured: Boolean(apiSettings.apiKey),
    provider: apiSettings.provider,
  });
});

// 设置角色的模型包（每个角色可绑定不同的3D模型）
app.post('/api/characters/:id/model-pack', (req, res) => {
  const { id } = req.params;
  const { modelPackId } = req.body;
  if (!modelPackId) return res.json({ success: false, error: '缺少modelPackId' });
  try {
    const profile = promptBuilder.readCharacterProfile(id);
    profile.modelPackId = modelPackId;
    const ok = promptBuilder.writeCharacterProfile(id, profile);
    // Avatar runtime owns model/lighting preferences in the character-scoped
    // avatar_settings.json. Keep the legacy profile field for compatibility,
    // but persist the live selection to the same file used by Electron.
    const avatarPath = path.join(CHARACTER_DIR, String(id), 'avatar_settings.json');
    let avatar = {};
    try {
      if (fs.existsSync(avatarPath)) avatar = JSON.parse(fs.readFileSync(avatarPath, 'utf8')) || {};
    } catch { avatar = {}; }
    fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
    fs.writeFileSync(avatarPath, JSON.stringify({ ...avatar, schemaVersion: 1, modelPackId: String(modelPackId) }, null, 2), 'utf8');
    res.json({ success: ok, modelPackId: String(modelPackId), avatarSettingsPath: avatarPath });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/api/characters', (req, res) => {
  const characters = promptBuilder.listCharacters();
  res.json({ success: true, characters });
});

app.post('/api/characters', (req, res) => {
  try {
    const { id, name, role, user_title, user_cognition, style, background, personality, speaking_style, likes, story, supplementary } = req.body;
    if (!id) return res.json({ success: false, error: '缺少角色ID' });
    let normalizedId;
    try {
      normalizedId = characterApiSettings.normalizeCharacterId(id);
    } catch (error) {
      return res.json({ success: false, error: '角色ID无效' });
    }

    const charDir = path.join(CHARACTER_DIR, normalizedId);
    if (fs.existsSync(charDir)) {
      return res.json({ success: false, error: '角色ID已存在' });
    }

    const character = promptBuilder.createCharacter(normalizedId, {
      name: name || normalizedId,
      role: role || '',
      user_title: user_title || '',
      user_cognition: user_cognition || '',
      style: style || '',
      background: background || '',
      personality: personality || '',
      speaking_style: speaking_style || '',
      likes: likes || '',
      story: story || '',
      supplementary: supplementary || '',
    });
    // 创建角色即建立独立 API 配置文件；不会复制其他角色的 key。
    characterApiSettings.ensureCharacterApiSettings(normalizedId);

    // 新架构：语音独立于角色，存储在 GPT-SoVITS/voices/<name>/
    // 新角色不自动复制语音，用户可在「语音切换」里从 voices/ 选择分配
    // （旧架构 character/<id>/voice/ 已废弃，不再自动创建）
    console.log(`[Voice] 新角色 ${normalizedId} 创建完成，请在语音管理中手动分配 voices/ 下的语音`);

    res.json({ success: true, character });
  } catch (error) {
    console.error('[API] 创建角色失败:', error.message);
    res.json({ success: false, error: '创建角色失败' });
  }
});

app.delete('/api/characters/:id', (req, res) => {
  try {
    const { id } = req.params;
    const removed = promptBuilder.deleteCharacter(id);
    if (removed) {
      // 删除后切换到第一个可用角色
      const characters = promptBuilder.listCharacters();
      let nextId = getCurrentCharacterId();
      if (nextId === id) {
        nextId = characters.length > 0 ? characters[0].id : '1';
        setCurrentCharacterId(nextId);
      }
      res.json({ success: true, currentCharacterId: nextId });
    } else {
      res.json({ success: false, error: '删除失败' });
    }
  } catch (error) {
    console.error('[API] 删除角色失败:', error.message);
    res.json({ success: false, error: '删除角色失败' });
  }
});

app.get('/api/character-image/:id/:type', (req, res) => {
  const { id, type } = req.params;
  const allowedPrefixes = ['character', 'user', 'context'];
  if (!allowedPrefixes.includes(type)) {
    return res.status(404).send('Not found');
  }

  const charDir = path.join(CHARACTER_DIR, id);
  const exts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

  // 在角色目录中查找匹配的文件
  if (fs.existsSync(charDir)) {
    for (const ext of exts) {
      const filePath = path.join(charDir, type + ext);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }
  }

  // context 类型不回退到默认图，返回404让前端显示动态默认背景
  if (type === 'context') {
    return res.status(404).send('Not found');
  }

  // character/user 类型回退到默认图片
  const defaultImgPath = path.join(__dirname, 'public', type + '.png');
  if (fs.existsSync(defaultImgPath)) {
    res.sendFile(defaultImgPath);
  } else {
    res.status(404).send('Not found');
  }
});

app.post('/api/upload-character-image/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { type, data } = req.body;
    const allowedPrefixes = ['character', 'user', 'context'];
    if (!allowedPrefixes.includes(type)) {
      return res.json({ success: false, error: '不支持的图片类型' });
    }

    const base64Match = data.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
    if (!base64Match) {
      return res.json({ success: false, error: '图片格式无效' });
    }

    const format = base64Match[1] === 'jpeg' ? 'jpg' : base64Match[1];
    const charDir = path.join(CHARACTER_DIR, id);
    if (!fs.existsSync(charDir)) {
      fs.mkdirSync(charDir, { recursive: true });
    }

    // 删除同类型旧文件（不同扩展名）
    const allExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    for (const ext of allExts) {
      const oldPath = path.join(charDir, type + ext);
      if (ext !== '.' + format && fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    const buffer = Buffer.from(base64Match[2], 'base64');
    const filePath = path.join(charDir, type + '.' + format);
    fs.writeFileSync(filePath, buffer);

    res.json({ success: true, message: `${type} 已更新` });
  } catch (error) {
    res.json({ success: false, error: '图片上传失败' });
  }
});

app.get('/api/history', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const history = historyService.readHistory(characterId);
    res.json({ success: true, history });
  } catch (error) {
    console.error('[API] 获取历史失败:', error.message);
    res.json({ success: true, history: [] });
  }
});

// 短语音输入转写：复用 GPT-SoVITS/FunASR 本地能力，不调用在线模型 API。
// 音频仅经内存管道送入本地工作进程，不落盘、不写入聊天历史。
const VOICE_INPUT_MAX_BYTES = 5 * 1024 * 1024;
const VOICE_INPUT_MIME_TYPES = Object.freeze({
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
});

app.post('/api/voice-input/transcribe', async (req, res) => {
  try {
    const audioBase64 = typeof req.body?.audioBase64 === 'string' ? req.body.audioBase64 : '';
    const mimeType = typeof req.body?.mimeType === 'string'
      ? req.body.mimeType.split(';', 1)[0].trim().toLowerCase()
      : '';
    const extension = VOICE_INPUT_MIME_TYPES[mimeType];
    if (!extension || !audioBase64 || !/^[a-z0-9+/]+={0,2}$/i.test(audioBase64)) {
      return res.status(400).json({ success: false, error: '录音格式无效，请重新录制。' });
    }

    const audio = Buffer.from(audioBase64, 'base64');
    if (audio.length === 0 || audio.length > VOICE_INPUT_MAX_BYTES) {
      return res.status(413).json({ success: false, error: '录音为空或超过 5MB 限制，请缩短后重试。' });
    }

    const text = String(await localAsrService.transcribe(audio, mimeType) || '').trim();
    if (!text) {
      return res.json({ success: false, error: text || '没有识别到清晰的语音，请重试。' });
    }
    return res.json({ success: true, text });
  } catch (error) {
    const message = error && error.message ? error.message : '语音识别失败，请稍后重试。';
    console.error('[VoiceInput] transcription failed:', message);
    return res.json({ success: false, error: message });
  }
});

app.get('/api/voice-input/status', (_req, res) => {
  res.json({
    success: true,
    engine: 'local-funasr',
    onlineApi: false,
    maxDurationSeconds: 30,
  });
});

app.post('/api/upload-chat-image', (req, res) => {
  try {
    const { data } = req.body;
    if (!data) {
      return res.json({ success: false, error: '图片数据为空' });
    }

    const base64Match = data.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
    if (!base64Match) {
      return res.json({ success: false, error: '图片格式无效' });
    }

    const characterId = getCurrentCharacterId();
    const ext = base64Match[1] === 'jpeg' ? 'jpg' : base64Match[1];
    // 文件名带角色ID前缀，便于按角色清理
    const filename = `char${characterId}_img_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
    const buffer = Buffer.from(base64Match[2], 'base64');
    const filePath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filePath, buffer);

    res.json({ success: true, url: `uploads/${filename}`, filename });
  } catch (error) {
    console.error('[API] 图片上传失败:', error.message);
    res.json({ success: false, error: '图片上传失败' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, imageBase64 } = req.body;
    const characterId = getCurrentCharacterId();
    // 在请求开始时固定角色 API 配置。即使用户在后台切换角色，本轮和
    // 之后的压缩仍然不会改用另一角色的 key。
    const characterApiConfig = readCurrentCharacterApiSettings(characterId);
    if (message !== undefined && message !== null && typeof message !== 'string') {
      return res.json({ success: false, error: '消息格式无效' });
    }
    if (imageBase64 !== undefined && imageBase64 !== null && typeof imageBase64 !== 'string') {
      return res.json({ success: false, error: '图片格式无效' });
    }
    const displayText = typeof message === 'string' ? message.trim() : '';
    if (displayText.length > 20000) {
      return res.json({ success: false, error: '单条消息过长，请分段发送（每段不超过20000字）' });
    }

    if (!displayText && !imageBase64) {
      return res.json({ success: false, error: '消息不能为空' });
    }

    const providerInfo = aiClient.getProviderInfo(characterApiConfig);
    if (!providerInfo.configured) {
      return res.json({
        success: false,
        error: '还没有配置API Key，请在设置页面填写对应模型的API Key。',
      });
    }

    let imageUrl = null;
    if (imageBase64) {
      const base64Match = imageBase64.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
      if (base64Match) {
        const ext = base64Match[1] === 'jpeg' ? 'jpg' : base64Match[1];
        // 文件名带角色ID前缀，便于按角色清理
        const filename = `char${characterId}_img_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
        const buffer = Buffer.from(base64Match[2], 'base64');
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
        imageUrl = `uploads/${filename}`;
      }
    }

    // 只用于本轮回复去重/表情冷却的历史快照。必须在写入当前用户消息前读取，
    // 否则既会把当前轮混入比较，也会在后处理处引用未定义的 history。
    const historyBeforeTurn = historyService.readHistory(characterId);

    const historyContent = imageUrl
      ? (displayText ? `${displayText}\n[图片: ${imageUrl}]` : `[图片: ${imageUrl}]`)
      : displayText;

    historyService.addMessage(characterId, 'user', historyContent);

    if (displayText) {
      const { memory, updated } = memoryService.updateMemoryFromMessage(characterId, displayText);
      console.log(`[Memory] 规则更新: ${updated ? '有更新' : '无更新'}`);
    }

    // 当前用户消息若刚好跨过压缩节点，先完成这次极低频批处理，再构造聊天请求。
    // 这样不会出现“最旧一小段已被上下文上限裁掉、但尚未进入摘要/RAG”的空档。
    if (historyService.needsCompression(characterId)) {
      console.log('[History] 当前消息跨过压缩节点，先完成批量压缩...');
      await compressHistoryAsync(characterId);
    }

    const characterProfile = promptBuilder.readCharacterProfile(characterId);
    // 普通聊天不联网；只有用户明确询问最新剧情、活动或官方更新时，
    // 才取一次临时网页资料。结果只进入本轮请求，不写入历史或长期记忆。
    const worldContext = await worldKnowledgeSearch.fetchLatestWorldContext(
      characterProfile.name || characterId,
      displayText,
    );
    const messages = promptBuilder.buildMessages(characterId, displayText, imageBase64 || null, {
      externalContext: worldContext,
    });

    let reply;
    let performance;
    try {
      // 普通对话的提示词只展示较小窗口以控制 token；本地去重使用最近12条，
      // 防止旧的通用话术在第9条后立即重新出现。历史原文不额外发送给 API。
      const recentAssistForPolicy = historyBeforeTurn.filter(m => m.role === 'assistant').slice(-12);
      const prepareCandidate = (rawReply) => {
        const parsed = memoryService.parseReplyPerformance(rawReply, displayText);
        const cleanReply = replyPolicy.sanitize(parsed.cleanReply, recentAssistForPolicy, {
          characterId,
          appRoot: __dirname,
        });
        if (!replyPolicy.isQuoteUsageAcceptable(cleanReply, displayText, recentAssistForPolicy)) return null;
        // 某些上游模型偶发只返回隐藏元数据、空字符串或 null。
        // 这类内容不能写入历史，也不能继续进入语音/动作链路。
        if (!String(cleanReply || '').trim()) return null;
        return {
          reply: cleanReply,
          performance: replyPerformancePolicy.normalizeReplyPerformance(
            parsed.rawPerformance,
            cleanReply,
          ),
        };
      };

      const firstCandidate = prepareCandidate(await aiClient.chatWithAI(messages, { settings: characterApiConfig }));
      // 空回复只在异常时补发一次。动态说明追加到最后一条 user 消息，
      // 不改变稳定 system/历史前缀，仍可复用 API 缓存；若上游连续返回空，
      // 使用本地非重复兜底，绝不把空 assistant 写入历史。
      if (!firstCandidate) {
        console.warn('[Chat] 上游返回空回复，执行一次最小重试');
        const emptyRetryInstruction = '【空回复修正】请直接用角色口吻回答用户当前消息，至少给出一句完整可见的文字；不要只输出情绪 JSON、控制标记或空白。';
        const retryMessages = messages.map((message, index) => {
          if (index !== messages.length - 1 || message.role !== 'user') return message;
          if (typeof message.content === 'string') {
            return { ...message, content: `${message.content}\n\n${emptyRetryInstruction}` };
          }
          if (!Array.isArray(message.content)) return message;
          const content = message.content.map(item => ({ ...item }));
          const textIndex = content.findIndex(item => item && item.type === 'text');
          if (textIndex >= 0) {
            content[textIndex].text = `${String(content[textIndex].text || '')}\n\n${emptyRetryInstruction}`;
          } else {
            content.unshift({ type: 'text', text: emptyRetryInstruction });
          }
          return { ...message, content };
        });
        const retryCandidate = prepareCandidate(
          await aiClient.chatWithAI(retryMessages, { temperature: 0.85, settings: characterApiConfig }),
        );
        if (retryCandidate) {
          reply = retryCandidate.reply;
          performance = retryCandidate.performance;
        } else {
          reply = replyPolicy.pickNonRepeatingFallback(displayText, recentAssistForPolicy);
          performance = replyPerformancePolicy.normalizeReplyPerformance(null, reply);
          console.warn('[Chat] 重试仍为空，使用本地非重复兜底');
        }
      } else {
        reply = firstCandidate.reply;
        performance = firstCandidate.performance;
      }

      // ★ 轻量事后去重：与最近12条 assistant 回复比对，相似度>50%或同一通用
      // 对话动作重复则重试一次（temperature 拉高）。
      // 使用 replyPolicy 的清洗函数，去掉表情包/emoji/语气标记后再比对，更准确
      if (reply && replyPolicy.isSimilarToRecent(reply, recentAssistForPolicy, 0.5)) {
        console.log('[Chat] 检测到与历史回复重复，重试一次');
        const avoidText = recentAssistForPolicy.slice(-5)
          .map((m, i) => `${i + 1}. ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 80)}`)
          .join('\n');
        const retryInstruction = `【本轮去重修正】上一版回复与近期内容相似。请直接回答用户当前消息，但必须更换开头、核心措辞、动作和关心角度；不要复述下列近期回复：\n${avoidText}`;
        // 重试约束属于本轮动态资料，必须放在最后一条 user 消息中。这样稳定
        // system、低频记忆和近期历史的前缀仍可命中缓存；图片消息则只扩展
        // 它的 text part，不触碰 image_url。
        const retryMessages = messages.map((message, index) => {
          if (index !== messages.length - 1 || message.role !== 'user') return message;
          if (typeof message.content === 'string') {
            return { ...message, content: `${message.content}\n\n${retryInstruction}` };
          }
          if (!Array.isArray(message.content)) return message;
          const content = message.content.map(item => ({ ...item }));
          const textIndex = content.findIndex(item => item && item.type === 'text');
          if (textIndex >= 0) {
            content[textIndex].text = `${String(content[textIndex].text || '')}\n\n${retryInstruction}`;
          } else {
            content.unshift({ type: 'text', text: retryInstruction });
          }
          return { ...message, content };
        });
        const retryCandidate = prepareCandidate(
          await aiClient.chatWithAI(retryMessages, { temperature: 0.95, settings: characterApiConfig }),
        );
        const retryReply = retryCandidate ? retryCandidate.reply : '';
        // 只在重试结果不重复时采用；两次都重复则使用本地非重复兜底，
        // 绝不把已经判定重复的原文继续发送给用户。
        if (retryCandidate && !replyPolicy.isSimilarToRecent(retryReply, recentAssistForPolicy, 0.5)) {
          reply = retryReply;
          performance = retryCandidate.performance;
        } else {
          console.log('[Chat] 重试仍重复，使用本地非重复兜底');
          reply = replyPolicy.pickNonRepeatingFallback(displayText, recentAssistForPolicy);
          performance = replyPerformancePolicy.normalizeReplyPerformance(null, reply);
        }
      }
    } catch (aiError) {
      console.error('[Chat] AI请求失败:', aiError.message);
      if (aiError.message === 'API_KEY_NOT_CONFIGURED') {
        return res.json({
          success: false,
          error: '还没有配置API Key，请在设置页面填写对应模型的API Key。',
        });
      }
      return res.json({
        success: false,
        error: '我这边刚刚有点连接不上，可以稍后再试一下。',
      });
    }

    // 只把最终采用的模型元数据写入情绪连续性；被去重淘汰的候选不会污染记忆。
    if (displayText) memoryService.applyReplyPerformance(characterId, performance);

    historyService.addMessage(characterId, 'assistant', reply, { performance });

    // 每轮只做零额外 API 成本的明确事实/情绪更新。结构化长期记忆与累计摘要
    // 在达到历史压缩节点时由同一次批处理请求生成，避免每分钟重复付费提取。

    if (historyService.needsCompression(characterId)) {
      console.log('[History] 开始压缩历史记录...');
      compressHistoryAsync(characterId);
    }

    res.json({ success: true, reply, performance });
  } catch (error) {
    console.error('[Chat] 处理消息失败:', error);
    res.json({
      success: false,
      error: '我这边刚刚有点连接不上，可以稍后再试一下。',
    });
  }
});

const compressionJobs = new Map();
function compressHistoryAsync(characterId) {
  if (compressionJobs.has(characterId)) return compressionJobs.get(characterId);
  const job = (async () => {
    try {
      const characterApiConfig = readCurrentCharacterApiSettings(characterId);
      const chatWithCharacterAI = createCharacterAiClient(characterId, characterApiConfig).chatWithAI;
      await historyService.compressHistory(characterId, chatWithCharacterAI, memoryService, archiveService);
    } catch (error) {
      console.error('[Compress] 压缩失败:', error.message);
    } finally {
      compressionJobs.delete(characterId);
    }
  })();
  compressionJobs.set(characterId, job);
  return job;
}

app.get('/api/memory', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const memory = memoryService.readMemory(characterId);
    res.json({ success: true, memory });
  } catch (error) {
    console.error('[API] 获取记忆失败:', error.message);
    res.json({ success: true, memory: memoryService.getDefaultMemory() });
  }
});

app.post('/api/delete-message', (req, res) => {
  try {
    const { index } = req.body;
    const characterId = getCurrentCharacterId();
    if (index === undefined || index === null) {
      return res.json({ success: false, error: '缺少消息索引' });
    }

    const history = historyService.readHistory(characterId);
    if (index < 0 || index >= history.length) {
      return res.json({ success: false, error: '消息索引无效' });
    }

    // 先取出消息内容+时间，用于同步清理归档（messages.jsonl + search_index.json）
    const deletedMsg = history[index];

    history.splice(index, 1);
    historyService.writeHistory(characterId, history);
    historyService.onHistoryMessageDeleted(characterId, index);

    // 同步清理归档，避免 RAG 索引保留已删除内容污染数据
    try {
      archiveService.deleteArchiveMessage(characterId, deletedMsg.time, deletedMsg.content);
    } catch (e) {
      console.error('[API] 同步清理归档失败:', e.message);
    }

    res.json({ success: true, message: '消息已删除' });
  } catch (error) {
    console.error('[API] 删除消息失败:', error.message);
    res.json({ success: false, error: '删除消息失败' });
  }
});

app.post('/api/clear-history', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    historyService.clearHistory(characterId);
    // 同步清空归档（messages.jsonl + search_index.json），避免 RAG 索引残留污染数据
    archiveService.clearAllArchive(characterId);
    // 清空聊天时重置对话情感缓存，让新对话从首次检测重新开始
    clearCachedEmotion(characterId);
    res.json({ success: true, message: '聊天历史已清空' });
  } catch (error) {
    console.error('[API] 清空历史失败:', error.message);
    res.json({ success: false, error: '清空历史失败' });
  }
});

// 重建历史索引：从 messages.jsonl 重建 search_index.json
// 用于手动清理 RAG 索引污染数据（兜底机制）
app.post('/api/rebuild-search-index', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const result = archiveService.rebuildIndexFromArchive(characterId);
    res.json(result);
  } catch (error) {
    console.error('[API] 重建索引失败:', error.message);
    res.json({ success: false, error: '重建索引失败' });
  }
});

app.post('/api/clear-memory', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    memoryService.clearMemory(characterId);
    res.json({ success: true, message: '记忆已清空' });
  } catch (error) {
    console.error('[API] 清空记忆失败:', error.message);
    res.json({ success: false, error: '清空记忆失败' });
  }
});

// 清空聊天框中已发送的图片缓存（public/uploads/ 下的 char<id>_img_* 文件）
// 仅清理当前角色的聊天上传图片，保留 distill/（蒸馏训练素材）子目录和其他角色图片
app.post('/api/clear-image-cache', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const prefix = `char${characterId}_img_`;
    let count = 0;
    if (fs.existsSync(UPLOAD_DIR)) {
      for (const f of fs.readdirSync(UPLOAD_DIR)) {
        const fp = path.join(UPLOAD_DIR, f);
        try {
          if (fs.statSync(fp).isFile() && f.startsWith(prefix)) {
            fs.unlinkSync(fp);
            count++;
          }
        } catch (e) { /* 跳过单个文件失败 */ }
      }
    }
    console.log(`[API] 图片缓存已清空(角色${characterId}): ${count} 个文件`);
    res.json({ success: true, message: `已清空当前角色的 ${count} 个图片缓存` });
  } catch (error) {
    console.error('[API] 清空图片缓存失败:', error.message);
    res.json({ success: false, error: '清空图片缓存失败' });
  }
});

// 清空语音合成临时输出缓存（voice_engine/output/ 下的 char<id>_*.wav 文件）
// 仅清理当前角色的语音缓存，不影响其他角色
app.post('/api/clear-voice-cache', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const prefix = `char${characterId}_`;
    let count = 0;
    for (const file of listCharacterVoiceFiles(characterId)) {
      try { fs.unlinkSync(file.path); count++; } catch (e) { /* 跳过单个文件失败 */ }
    }
    // 同步清理 L3 缓存中指向已删文件的映射
    let cleanedEntries = 0;
    for (const [key, filename] of _voiceCache) {
      if (filename && isCharacterVoiceFile(filename, characterId)) {
        _voiceCache.delete(key);
        cleanedEntries++;
      }
    }
    for (const [key, entry] of _voiceCacheManifest) {
      if (entry?.charId === String(characterId)) _voiceCacheManifest.delete(key);
    }
    if (cleanedEntries > 0) _saveVoiceCacheToDisk();
    _saveVoiceCacheManifest();
    console.log(`[API] 语音缓存已清空(角色${characterId}): ${count} 个文件，清理 ${cleanedEntries} 条缓存映射`);
    res.json({ success: true, message: `已清空当前角色的 ${count} 个语音缓存` });
  } catch (error) {
    console.error('[API] 清空语音缓存失败:', error.message);
    res.json({ success: false, error: '清空语音缓存失败' });
  }
});

app.get('/api/provider-info', (req, res) => {
  const info = aiClient.getProviderInfo();
  res.json({ success: true, ...info });
});

app.get('/api/provider-registry', (req, res) => {
  const registry = aiClient.getProviderRegistry();
  const result = {};
  for (const [key, val] of Object.entries(registry)) {
    result[key] = {
      name: val.name,
      website: val.website,
      defaultBaseUrl: val.defaultBaseUrl,
      defaultModel: val.defaultModel,
      models: val.models,
      supportsModelSync: val.supportsModelSync !== false,
    };
  }
  res.json({ success: true, registry: result });
});

app.post('/api/provider-registry', (req, res) => {
  try {
    const { key, updates } = req.body;
    if (!key || !updates) {
      return res.json({ success: false, error: '缺少参数' });
    }
    const registry = aiClient.updateProviderRegistry(key, updates);
    res.json({ success: true, registry });
  } catch (error) {
    console.error('[ProviderRegistry] 更新失败:', error.message);
    res.json({ success: false, error: '更新失败' });
  }
});

app.post('/api/provider-registry/reset', (req, res) => {
  try {
    const registry = aiClient.resetProviderRegistry();
    res.json({ success: true, registry });
  } catch (error) {
    console.error('[ProviderRegistry] 重置失败:', error.message);
    res.json({ success: false, error: '重置失败' });
  }
});

app.post('/api/sync-models', async (req, res) => {
  try {
    const { provider, apiKey, baseUrl } = req.body;
    if (!provider) {
      return res.json({ success: false, error: '缺少Provider参数' });
    }

    const currentApiSettings = readCurrentCharacterApiSettings();
    // 只允许使用当前角色的 key 作为回退，不再从全局 process.env 取另一角色的 key。
    const effectiveApiKey = apiKey || (currentApiSettings.provider === String(provider).toLowerCase()
      ? currentApiSettings.apiKey
      : '');
    const effectiveBaseUrl = baseUrl || (currentApiSettings.provider === String(provider).toLowerCase()
      ? currentApiSettings.baseUrl
      : '');

    const result = await aiClient.syncModels(provider, effectiveApiKey, effectiveBaseUrl);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[SyncModels] 同步失败:', error.message);
    res.json({ success: false, error: error.message || '同步模型列表失败' });
  }
});

app.get('/api/settings', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const settings = buildCurrentSettingsResponse(characterId);
    res.json({ success: true, characterId, settings });
  } catch (error) {
    res.json({ success: true, settings: { provider: 'custom', apiKey: '', baseUrl: '', model: '', capability: '', reasoning: '' } });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const { provider, apiKey, baseUrl, model, capability, reasoning } = req.body;

    const characterId = getCurrentCharacterId();
    const globalSettings = readSettings();
    // conversationMode 等非 API 字段仍属于全局设置；API 字段写入当前角色目录。
    const globalPatch = {};
    if (req.body.conversationMode !== undefined) {
      globalPatch.conversationMode = req.body.conversationMode === 'remote_chat' ? 'remote_chat' : 'immersive';
    }
    if (Object.keys(globalPatch).length > 0) {
      writeSettings({ ...globalSettings, ...globalPatch });
    }

    const hasApiPatch = [provider, apiKey, baseUrl, model, capability, reasoning].some(value => value !== undefined);
    const existingApi = readCurrentCharacterApiSettings(characterId);
    const settings = hasApiPatch
      ? characterApiSettings.writeCharacterApiSettings(characterId, {
        provider: provider !== undefined ? provider : existingApi.provider,
        apiKey: apiKey !== undefined ? apiKey : existingApi.apiKey,
        baseUrl: baseUrl !== undefined ? baseUrl : existingApi.baseUrl,
        model: model !== undefined ? model : existingApi.model,
        capability: capability !== undefined ? capability : existingApi.capability,
        reasoning: reasoning !== undefined ? reasoning : existingApi.reasoning,
      })
      : existingApi;
    activateCharacterApiSettings(characterId);

    console.log(`[Settings] 角色 ${characterId} API配置已更新: ${settings.provider}, Key: ${settings.apiKey ? '***' + settings.apiKey.slice(-4) : '未配置'}`);

    res.json({ success: true, message: '配置已保存', characterId, settings: { ...settings, conversationMode: (globalPatch.conversationMode || globalSettings.conversationMode || 'immersive') } });
  } catch (error) {
    console.error('[API] 保存设置失败:', error.message);
    res.json({ success: false, error: '保存设置失败' });
  }
});

// 明确的角色级 API 接口。前端使用当前角色的 /api/settings 兼容入口，
// 其他客户端可直接指定角色 ID；两者最终都读写同一个角色目录文件。
app.get('/api/characters/:id/api-settings', (req, res) => {
  try {
    const id = characterApiSettings.normalizeCharacterId(req.params.id);
    const settings = characterApiSettings.readCharacterApiSettings(id);
    res.json({ success: true, characterId: id, settings });
  } catch (error) {
    res.json({ success: false, error: error.message === 'INVALID_CHARACTER_ID' ? '角色ID无效' : '获取角色 API 配置失败' });
  }
});

app.post('/api/characters/:id/api-settings', (req, res) => {
  try {
    const id = characterApiSettings.normalizeCharacterId(req.params.id);
    const charDir = path.join(CHARACTER_DIR, id);
    if (!fs.existsSync(charDir) || !fs.statSync(charDir).isDirectory()) {
      return res.json({ success: false, error: '角色不存在' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const current = characterApiSettings.readCharacterApiSettings(id);
    const settings = characterApiSettings.writeCharacterApiSettings(id, {
      provider: body.provider !== undefined ? body.provider : current.provider,
      apiKey: body.apiKey !== undefined ? body.apiKey : current.apiKey,
      baseUrl: body.baseUrl !== undefined ? body.baseUrl : current.baseUrl,
      model: body.model !== undefined ? body.model : current.model,
    });
    if (id === getCurrentCharacterId()) activateCharacterApiSettings(id);
    res.json({ success: true, characterId: id, settings });
  } catch (error) {
    res.json({ success: false, error: error.message === 'INVALID_CHARACTER_ID' ? '角色ID无效' : '保存角色 API 配置失败' });
  }
});

// 当前角色的短别名，便于设置面板以外的调用方使用。
app.get('/api/character-api-settings', (req, res) => {
  const id = getCurrentCharacterId();
  const settings = readCurrentCharacterApiSettings(id);
  res.json({ success: true, characterId: id, settings });
});

app.post('/api/character-api-settings', (req, res) => {
  req.params.id = getCurrentCharacterId();
  // 复用角色级逻辑时直接执行同样的安全合并，避免内部伪造 req/res。
  try {
    const id = characterApiSettings.normalizeCharacterId(req.params.id);
    const current = readCurrentCharacterApiSettings(id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const settings = characterApiSettings.writeCharacterApiSettings(id, {
      provider: body.provider !== undefined ? body.provider : current.provider,
      apiKey: body.apiKey !== undefined ? body.apiKey : current.apiKey,
      baseUrl: body.baseUrl !== undefined ? body.baseUrl : current.baseUrl,
      model: body.model !== undefined ? body.model : current.model,
    });
    activateCharacterApiSettings(id);
    res.json({ success: true, characterId: id, settings });
  } catch (error) {
    res.json({ success: false, error: '保存角色 API 配置失败' });
  }
});

app.get('/api/character-profile', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const profile = promptBuilder.readCharacterProfile(characterId);
    const charMd = promptBuilder.readCharacterMd(characterId);
    const supplementary = promptBuilder.readSupplementary(characterId);
    const lore = promptBuilder.readLore(characterId);

    res.json({
      success: true,
      characterId,
      profile,
      background: charMd.background,
      personality: charMd.personality,
      speakingStyle: charMd.speaking_style,
      likes: charMd.likes,
      story: charMd.story,
      supplementary,
      lore,
    });
  } catch (error) {
    console.error('[API] 获取角色信息失败:', error.message);
    res.json({ success: false, error: '获取角色信息失败' });
  }
});

app.post('/api/character-profile', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { profile, background, personality, speakingStyle, likes, story } = req.body;

    if (profile) {
      promptBuilder.writeCharacterProfile(characterId, profile);
    }

    // 将角色信息字段写入 character.md
    const charFields = {};
    if (background !== undefined) charFields.background = background;
    if (personality !== undefined) charFields.personality = personality;
    if (speakingStyle !== undefined) charFields.speaking_style = speakingStyle;
    if (likes !== undefined) charFields.likes = likes;
    if (story !== undefined) charFields.story = story;
    if (Object.keys(charFields).length > 0) {
      promptBuilder.writeCharacterMd(characterId, charFields);
    }

    res.json({ success: true, message: '角色信息已更新' });
  } catch (error) {
    console.error('[API] 更新角色信息失败:', error.message);
    res.json({ success: false, error: '更新角色信息失败' });
  }
});

app.get('/api/supplementary', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const content = promptBuilder.readSupplementary(characterId);
    res.json({ success: true, content });
  } catch (error) {
    res.json({ success: true, content: '' });
  }
});

app.post('/api/supplementary', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { content } = req.body;
    promptBuilder.writeSupplementary(characterId, content || '');
    res.json({ success: true, message: '补充设定已保存' });
  } catch (error) {
    console.error('[API] 保存补充设定失败:', error.message);
    res.json({ success: false, error: '保存补充设定失败' });
  }
});

app.post('/api/conversation-skills', (req, res) => {
  try {
    const { content } = req.body;
    const filePath = path.join(DATA_DIR, 'conversation_skills.txt');
    writeUtf8Atomic(filePath, content || '');
    res.json({ success: true, message: '对话技能已保存' });
  } catch (error) {
    console.error('[API] 保存对话技能失败:', error.message);
    res.json({ success: false, error: '保存对话技能失败' });
  }
});

app.get('/api/skill', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const skill = promptBuilder.readSkill(characterId);
    res.json({ success: true, skill });
  } catch (error) {
    res.json({ success: true, skill: '' });
  }
});

app.post('/api/save-skill', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { content } = req.body;
    promptBuilder.writeSkill(characterId, content || '');
    res.json({ success: true, message: 'Skill已保存' });
  } catch (error) {
    console.error('[API] 保存Skill失败:', error.message);
    res.json({ success: false, error: '保存Skill失败' });
  }
});

app.post('/api/rollback-skill', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const content = promptBuilder.rollbackSkill(characterId);
    if (content === null) {
      return res.json({ success: false, error: '没有可回退的备份' });
    }
    res.json({ success: true, message: '已回退到上一个备份', skill: content });
  } catch (error) {
    console.error('[API] 回退Skill失败:', error.message);
    res.json({ success: false, error: '回退失败' });
  }
});

app.post('/api/generate-skill', async (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const characterApiConfig = readCurrentCharacterApiSettings(characterId);
    const providerInfo = aiClient.getProviderInfo(characterApiConfig);
    if (!providerInfo.configured) {
      return res.json({ success: false, error: '请先配置 API Key' });
    }

    const profile = promptBuilder.readCharacterProfile(characterId);
    const charMd = promptBuilder.readCharacterMd(characterId);
    const existingSkill = promptBuilder.readSkill(characterId);

    const charName = profile.name || characterId;
    const searchHints = profile.skill_search_hints || [];
    const hintText = searchHints.length > 0 ? ' ' + searchHints.join(' ') : '';
    const searchQuery = `${charName}${hintText} 角色 设定 资料`;

    console.log(`[SkillGen] 开始为 ${charName} 生成Skill，搜索: ${searchQuery}`);

    let searchResults = [];
    try {
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
      const ddgRes = await axios.get(ddgUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      const html = ddgRes.data;
      const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = resultRegex.exec(html)) !== null && searchResults.length < 8) {
        const url = match[1];
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        if (url && title && !url.includes('duckduckgo')) {
          searchResults.push({ url, title });
        }
      }
      console.log(`[SkillGen] DuckDuckGo搜索到 ${searchResults.length} 条结果`);
    } catch (searchErr) {
      console.error('[SkillGen] 搜索失败:', searchErr.message);
    }

    let bwikiContent = '';
    const knowledgeUrls = promptBuilder.readKnowledgeUrls(characterId);
    for (const urlEntry of knowledgeUrls) {
      if (urlEntry.type === 'bwiki' && urlEntry.title) {
        try {
          const wikiPrefix = urlEntry.wiki || 'zspms';
          const apiUrl = `https://wiki.biligame.com/${wikiPrefix}/api.php?action=parse&page=${encodeURIComponent(urlEntry.title)}&prop=wikitext&format=json`;
          const response = await axios.get(apiUrl, {
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          });
          const data = response.data;
          if (data && data.parse && data.parse.wikitext && data.parse.wikitext['*']) {
            let wikitext = data.parse.wikitext['*'];
            const extractedLines = [];
            for (let pass = 0; pass < 10; pass++) {
              const templateRegex = /\{\{([\s\S]*?)\}\}/g;
              let found = false;
              let templateMatch;
              const tempText = pass === 0 ? wikitext : wikitext;
              while ((templateMatch = templateRegex.exec(tempText)) !== null) {
                found = true;
                const lines = templateMatch[1].split('\n');
                for (const line of lines) {
                  const kvMatch = line.match(/^\s*\|([^=]+)=(.*)$/);
                  if (kvMatch) {
                    const key = kvMatch[1].trim();
                    const value = kvMatch[2].trim();
                    if (value && value.length > 1 && value !== '<!--请勿删除-->') {
                      extractedLines.push(`${key}：${value}`);
                    }
                  }
                }
              }
              wikitext = wikitext.replace(/\{\{[\s\S]*?\}\}/g, '');
              if (!found) break;
            }
            bwikiContent += extractedLines.join('\n') + '\n';
            console.log(`[SkillGen] BWIKI提取 ${extractedLines.length} 条键值对`);
          }
        } catch (bwikiErr) {
          console.error(`[SkillGen] BWIKI获取失败:`, bwikiErr.message);
        }
      }
    }

    let webContent = '';
    for (const result of searchResults.slice(0, 3)) {
      try {
        const webRes = await axios.get(result.url, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html',
          },
          responseType: 'text',
          maxRedirects: 3,
        });
        let html = typeof webRes.data === 'string' ? webRes.data : '';
        if (html.length > 100) {
          html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
          html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
          html = html.replace(/<[^>]+>/g, ' ');
          html = html.replace(/\s+/g, ' ');
          if (html.length > 3000) html = html.substring(0, 3000);
          webContent += `【${result.title}】\n${html}\n\n`;
        }
      } catch (e) {}
    }

    let customWebContent = '';
    const skillUrls = promptBuilder.readSkillUrls(characterId);
    for (const urlEntry of skillUrls) {
      if (urlEntry.url) {
        try {
          if (urlEntry.type === 'api') {
            const apiRes = await axios.get(urlEntry.url, {
              timeout: 15000,
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            });
            let apiText = typeof apiRes.data === 'string' ? apiRes.data : JSON.stringify(apiRes.data, null, 2);
            if (apiText.length > 4000) apiText = apiText.substring(0, 4000);
            customWebContent += `【${urlEntry.title || urlEntry.url}】\n${apiText}\n\n`;
            console.log(`[SkillGen] 自定义API获取成功: ${urlEntry.title || urlEntry.url}`);
          } else {
            const webRes = await axios.get(urlEntry.url, {
              timeout: 10000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html',
              },
              responseType: 'text',
              maxRedirects: 3,
            });
            let html = typeof webRes.data === 'string' ? webRes.data : '';
            if (html.length > 100) {
              html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
              html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
              html = html.replace(/<[^>]+>/g, ' ');
              html = html.replace(/\s+/g, ' ');
              if (html.length > 4000) html = html.substring(0, 4000);
              customWebContent += `【${urlEntry.title || urlEntry.url}】\n${html}\n\n`;
              console.log(`[SkillGen] 自定义网页获取成功: ${urlEntry.title || urlEntry.url}`);
            }
          }
        } catch (e) {
          console.error(`[SkillGen] 自定义网址获取失败: ${urlEntry.url}`, e.message);
        }
      }
    }

    const refDir = path.join(CHARACTER_DIR, characterId, 'references');
    if (!fs.existsSync(refDir)) fs.mkdirSync(refDir, { recursive: true });
    const refContent = `# ${charName} 调研资料\n\n## BWIKI数据\n${bwikiContent || '无'}\n\n## 网页搜索结果\n${webContent || '无'}\n\n## 自定义网址\n${customWebContent || '无'}`;
    fs.writeFileSync(path.join(refDir, 'research.md'), refContent, 'utf-8');

    const charInfo = `角色名: ${charName}
身份: ${profile.role || '未知'}
称呼用户: ${profile.user_title || '用户'}
风格: ${profile.style || ''}
背景: ${charMd.background || ''}
性格: ${charMd.personality || ''}
说话方式: ${charMd.speaking_style || ''}
喜好: ${charMd.likes || ''}
故事: ${charMd.story || ''}`;

    const researchData = `## BWIKI数据\n${bwikiContent.substring(0, 4000)}\n\n## 网页搜索结果\n${webContent.substring(0, 4000)}\n\n## 自定义网址内容\n${customWebContent.substring(0, 4000)}`;

    const skillPrompt = `你是一个角色Skill生成器，参照"女娲·Skill造人术"的框架，为游戏/动漫角色生成专属Skill。

角色信息：
${charInfo}

调研资料：
${researchData}

${existingSkill ? `已有Skill（在此基础上更新补充）：\n${existingSkill}\n` : ''}

请生成该角色的SKILL.md，严格按以下格式输出（不要输出其他内容）：

---
name: ${charName}-skill
description: |
  ${charName}的角色Skill。基于调研资料提炼核心心智模型、决策启发式和表达DNA。
  用途：作为角色扮演的深度参考，让AI更精准地模拟该角色的思维方式、表达习惯和行为模式。
---

# ${charName} · 角色操作系统

> [一句最能代表此角色思维方式的原话或标志性台词]

## 身份卡

**我是谁**：[50字第一人称自我介绍，用角色语气]
**我的起点**：[关键背景]
**我现在在做什么**：[当前状态]

## 核心心智模型

### 模型1: [名称]
**一句话**：[最简描述]
**证据**：[至少2个不同场景的引用]
**应用**：[遇到什么类型的问题时用这个镜片]
**局限**：[这个模型在什么情况下会失效]

（3-5个模型）

## 决策启发式

1. **[规则名]**：[具体描述]
   - 应用场景：[什么时候用]

（5-8条）

## 表达DNA

角色扮演时必须遵循的风格规则：
- 句式：[偏好]
- 词汇：[高频词、专属术语、禁忌词]
- 节奏：[先结论还是先铺垫]
- 幽默：[方式]
- 确定性：[类型]
- 引用习惯：[爱引什么]

## 价值观与反模式

**我追求的**：[排序的价值观]
**我拒绝的**：[明确的反模式]
**我自己也没想清楚的**：[内在矛盾]

## 诚实边界

此Skill基于公开信息提炼，存在以下局限：
- [具体局限1]
- [具体局限2]

## 附录：角色详细设定

[将调研资料中的关键信息整理为结构化的角色设定，包括技能、装备、关系等]`;

    const messages = [
      { role: 'system', content: '你是角色Skill生成器，只输出SKILL.md格式的markdown内容，不要输出其他解释。' },
      { role: 'user', content: skillPrompt },
    ];

    const skillContent = await aiClient.chatWithAI(messages, {
      maxTokens: 4096,
      settings: characterApiConfig,
    });

    promptBuilder.writeSkill(characterId, skillContent);

    res.json({
      success: true,
      message: 'Skill生成完成',
      skill: skillContent,
      sources: searchResults.length + (bwikiContent ? 1 : 0) + skillUrls.length,
    });
  } catch (error) {
    console.error('[API] 生成Skill失败:', error.message);
    res.json({ success: false, error: '生成Skill失败: ' + error.message });
  }
});

// ============================================================
// 人物蒸馏 API（网络搜索蒸馏 + 自定义导入蒸馏）
// ============================================================

// 获取蒸馏 manifest（元数据）
app.get('/api/distill/manifest', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const manifest = distillService.readManifest(characterId);
    res.json({ success: true, manifest });
  } catch (error) {
    console.error('[API] 获取manifest失败:', error.message);
    res.json({ success: true, manifest: null });
  }
});

// 方法1：网络搜索蒸馏（异步任务模式，防止超时断开）
const distillTasks = new Map(); // taskId -> { status, progress, result, error }

app.post('/api/distill/web', async (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const characterApiConfig = readCurrentCharacterApiSettings(characterId);
    const providerInfo = aiClient.getProviderInfo(characterApiConfig);
    if (!providerInfo.configured) {
      return res.json({ success: false, error: '请先配置 API Key' });
    }

    const {
      characterName,
      characterType,
      searchHints = [],
      wikiPrefix = '',
      forceUpdate = false,
    } = req.body;

    const profile = promptBuilder.readCharacterProfile(characterId);
    const name = characterName || profile.name || characterId;
    const knowledgeUrls = promptBuilder.readKnowledgeUrls(characterId);
    const skillUrls = promptBuilder.readSkillUrls(characterId);
    const existingSkill = promptBuilder.readSkill(characterId);

    // 自动检测角色类型
    let detectedType = characterType;
    if (!detectedType || detectedType === 'auto') {
      detectedType = distillService.detectCharacterType(name, searchHints);
      if (detectedType === 'unknown') detectedType = 'anime';
    }

    // 创建异步任务
    const taskId = `web_${Date.now()}`;
    distillTasks.set(taskId, { status: 'running', characterId, progress: '正在联网搜索并蒸馏...', result: null, error: null });

    // 立即返回taskId
    res.json({ success: true, taskId, message: '蒸馏任务已启动' });

    // 后台执行蒸馏
    console.log(`[API] 网络蒸馏开始(异步): ${name} (类型: ${detectedType})`);
    distillFromWebAsync(taskId, characterId, {
      characterName: name,
      characterType: detectedType,
      searchHints,
      knowledgeUrls,
      skillUrls,
      wikiPrefix,
      forceUpdate,
      existingSkill,
      apiSettings: characterApiConfig,
    });
  } catch (error) {
    console.error('[API] 网络蒸馏启动失败:', error.message);
    res.json({ success: false, error: '网络蒸馏失败: ' + error.message });
  }
});

async function distillFromWebAsync(taskId, characterId, options) {
  try {
    const scopedAiClient = createCharacterAiClient(characterId, options.apiSettings);
    const result = await distillService.distillFromWeb(characterId, options, scopedAiClient, promptBuilder);
    const partial = Boolean(result.manifest?.partial_result);
    distillTasks.set(taskId, createCompletedDistillTask(
      characterId,
      `${partial ? '网络搜索蒸馏部分完成（有覆盖警告）' : '网络搜索蒸馏完成'}（${result.sources.filter(s => s.status === 'success').length}/${result.sources.length}个资料源成功），已自动补充背景/性格/说话风格/喜好/故事`,
      {
        sources: result.sources,
        sourceCount: result.sources.length,
        successCount: result.sources.filter(s => s.status === 'success').length,
        partialResult: partial,
        warnings: result.manifest?.warnings || [],
        coverageBySection: result.manifest?.coverage_by_section || {},
      },
    ));
    console.log(`[API] 网络蒸馏完成(异步): ${options.characterName}`);
  } catch (error) {
    console.error('[API] 网络蒸馏失败(异步):', error.message);
    distillTasks.set(taskId, {
      status: 'failed',
      progress: '蒸馏失败: ' + error.message,
      result: null,
      error: error.message,
    });
  }
  // 10分钟后清理任务
  setTimeout(() => distillTasks.delete(taskId), 10 * 60 * 1000);
}

// 方法2：自定义导入蒸馏（异步任务模式）
app.post('/api/distill/custom', upload.fields([
  { name: 'images', maxCount: 10 },
  { name: 'audios', maxCount: 10 },
]), async (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const characterApiConfig = readCurrentCharacterApiSettings(characterId);
    const providerInfo = aiClient.getProviderInfo(characterApiConfig);
    if (!providerInfo.configured) {
      return res.json({ success: false, error: '请先配置 API Key' });
    }

    const {
      characterName,
      personalityDesc = '',
      chatRecords = '',
      momentsPosts = '',
      otherNotes = '',
      relationship = '',
      purpose = 'memorial',
      txtContents,
      txtNames,
    } = req.body;

    const profile = promptBuilder.readCharacterProfile(characterId);
    const name = characterName || profile.name || characterId;
    const existingSkill = promptBuilder.readSkill(characterId);

    const imagePaths = (req.files && req.files.images) ? req.files.images.map(f => f.path) : [];
    const audioPaths = (req.files && req.files.audios) ? req.files.audios.map(f => f.path) : [];

    let mergedChatRecords = chatRecords;
    if (txtContents) {
      const txtArr = Array.isArray(txtContents) ? txtContents : [txtContents];
      const nameArr = txtNames ? (Array.isArray(txtNames) ? txtNames : [txtNames]) : [];
      for (let i = 0; i < txtArr.length; i++) {
        mergedChatRecords += `\n\n【TXT文件 - ${nameArr[i] || '未命名'}】\n${txtArr[i]}`;
      }
    }

    if (!personalityDesc.trim() && !mergedChatRecords.trim() && !momentsPosts.trim() && !otherNotes.trim()
        && imagePaths.length === 0 && audioPaths.length === 0) {
      return res.json({ success: false, error: '请至少提供一项素材（文字/图片/语音/TXT）' });
    }

    // 创建异步任务
    const taskId = `custom_${Date.now()}`;
    distillTasks.set(taskId, { status: 'running', characterId, progress: '正在分析素材并蒸馏人物特征...', result: null, error: null });

    // 立即返回taskId
    res.json({ success: true, taskId, message: '蒸馏任务已启动' });

    // 后台执行蒸馏
    console.log(`[API] 自定义蒸馏开始(异步): ${name} (目的: ${purpose}, 图片: ${imagePaths.length}, 语音: ${audioPaths.length})`);
    distillFromCustomAsync(taskId, characterId, {
      characterName: name,
      personalityDesc,
      chatRecords: mergedChatRecords,
      momentsPosts,
      otherNotes,
      relationship,
      purpose,
      existingSkill,
      imagePaths,
      audioPaths,
      apiSettings: characterApiConfig,
    });
  } catch (error) {
    console.error('[API] 自定义蒸馏启动失败:', error.message);
    res.json({ success: false, error: '自定义蒸馏失败: ' + error.message });
  }
});

async function distillFromCustomAsync(taskId, characterId, options) {
  try {
    const scopedAiClient = createCharacterAiClient(characterId, options.apiSettings);
    const result = await distillService.distillFromCustom(characterId, options, scopedAiClient, promptBuilder);
    distillTasks.set(taskId, createCompletedDistillTask(
      characterId,
      '自定义导入蒸馏完成，人物特征已生成',
      {
        sources: result.sources,
        partialResult: Boolean(result.manifest?.partial_result),
        warnings: result.manifest?.warnings || [],
        coverageBySection: result.manifest?.coverage_by_section || {},
      },
    ));
    console.log(`[API] 自定义蒸馏完成(异步): ${options.characterName}`);
  } catch (error) {
    console.error('[API] 自定义蒸馏失败(异步):', error.message);
    distillTasks.set(taskId, {
      status: 'failed',
      progress: '蒸馏失败: ' + error.message,
      result: null,
      error: error.message,
    });
  }
  setTimeout(() => distillTasks.delete(taskId), 10 * 60 * 1000);
}

// 蒸馏任务状态查询
app.get('/api/distill/status/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = distillTasks.get(taskId);
  if (!task) {
    return res.json({ success: false, error: '任务不存在或已过期' });
  }
  res.json({ success: true, ...toPublicDistillTask(task, promptBuilder.readSkill) });
});

// ============================================================
// 库洛Wiki登录与数据获取
// ============================================================
const KURO_API_BASE = 'https://api.kurobbs.com';
const kuroTokenPath = path.join(DATA_DIR, 'kuro_token.json');

function getKuroToken() {
  try {
    if (fs.existsSync(kuroTokenPath)) {
      const data = JSON.parse(fs.readFileSync(kuroTokenPath, 'utf-8'));
      return data.token || '';
    }
  } catch (e) {}
  return '';
}

function saveKuroToken(token, userInfo = {}) {
  const dir = path.dirname(kuroTokenPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 保留已有的enabled和gameType设置
  let existing = {};
  try { if (fs.existsSync(kuroTokenPath)) existing = JSON.parse(fs.readFileSync(kuroTokenPath, 'utf-8')); } catch (e) {}
  fs.writeFileSync(kuroTokenPath, JSON.stringify({ token, userInfo, savedAt: new Date().toISOString(), enabled: existing.enabled !== undefined ? existing.enabled : true, gameType: existing.gameType || 'pns' }, null, 2), 'utf-8');
}

function clearKuroToken() {
  try { if (fs.existsSync(kuroTokenPath)) fs.unlinkSync(kuroTokenPath); } catch (e) {}
}

function getKuroHeaders(token) {
  const crypto = require('crypto');
  const devcode = crypto.randomBytes(16).toString('hex');
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/json',
    'Origin': 'https://wiki.kurobbs.com',
    'Referer': 'https://wiki.kurobbs.com/',
    'source': 'h5',
    'devcode': devcode,
    ...(token ? { 'token': token } : {}),
  };
}

// 发送短信验证码
app.post('/api/kuro/send-sms', async (req, res) => {
  try {
    const { mobile, geeTestData } = req.body;
    if (!mobile || !/^\d{11}$/.test(mobile)) {
      return res.json({ success: false, error: '请输入正确的11位手机号' });
    }
    const headers = getKuroHeaders();
    const result = await axios.post(`${KURO_API_BASE}/user/getSmsCodeForH5`, {
      mobile,
      geeTestData: geeTestData || '',
    }, { timeout: 15000, headers });

    if (result.data && result.data.code === 200) {
      res.json({ success: true, message: '验证码已发送', needGeeTest: false });
    } else if (result.data && result.data.data && result.data.data.geeTest) {
      // 需要极验验证
      res.json({ success: false, needGeeTest: true, geeTestConfig: {
        captchaId: 'ec4aa4174277d822d73f2442a165a2cd',
        product: 'bind',
        riskType: 'slide',
      }});
    } else {
      res.json({ success: false, error: result.data.msg || '发送验证码失败' });
    }
  } catch (error) {
    console.error('[Kuro] 发送验证码失败:', error.message);
    res.json({ success: false, error: '发送验证码失败: ' + error.message });
  }
});

// 登录
app.post('/api/kuro/login', async (req, res) => {
  try {
    const { mobile, code } = req.body;
    if (!mobile || !code) {
      return res.json({ success: false, error: '手机号和验证码不能为空' });
    }
    const headers = getKuroHeaders();
    const result = await axios.post(`${KURO_API_BASE}/user/sdkLoginForH5`, {
      mobile,
      code,
    }, { timeout: 15000, headers });

    if (result.data && result.data.code === 200 && result.data.data) {
      const token = result.data.data.token || result.data.data.accessToken || '';
      const userInfo = result.data.data;
      if (token) {
        saveKuroToken(token, userInfo);
        console.log('[Kuro] 登录成功，token已保存');
        res.json({ success: true, message: '登录成功', userInfo: { userId: userInfo.userId, userName: userInfo.userName } });
      } else {
        res.json({ success: false, error: '登录返回数据异常，未获取到token' });
      }
    } else {
      res.json({ success: false, error: result.data.msg || '登录失败' });
    }
  } catch (error) {
    console.error('[Kuro] 登录失败:', error.message);
    res.json({ success: false, error: '登录失败: ' + error.message });
  }
});

// 手动设置token（用户从浏览器开发者工具复制）
app.post('/api/kuro/set-token', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.json({ success: false, error: 'token不能为空' });
    }
    saveKuroToken(token);
    console.log('[Kuro] token已手动设置');
    res.json({ success: true, message: 'token已保存' });
  } catch (error) {
    res.json({ success: false, error: '保存token失败' });
  }
});

// 检查登录状态
app.get('/api/kuro/status', (req, res) => {
  const token = getKuroToken();
  let enabled = true;
  let gameType = 'pns';
  try {
    if (fs.existsSync(kuroTokenPath)) {
      const data = JSON.parse(fs.readFileSync(kuroTokenPath, 'utf-8'));
      enabled = data.enabled !== undefined ? data.enabled : true;
      gameType = data.gameType || 'pns';
    }
  } catch (e) {}
  res.json({ success: true, loggedIn: !!token, tokenPreview: token ? token.substring(0, 8) + '...' : '', enabled, gameType });
});

// 保存库洛Wiki设置（开关+游戏类型）
app.post('/api/kuro/settings', (req, res) => {
  try {
    const { enabled, gameType } = req.body;
    const dir = path.dirname(kuroTokenPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing = {};
    try { if (fs.existsSync(kuroTokenPath)) existing = JSON.parse(fs.readFileSync(kuroTokenPath, 'utf-8')); } catch (e) {}
    const updated = { ...existing };
    if (enabled !== undefined) updated.enabled = enabled;
    if (gameType !== undefined) updated.gameType = gameType;
    fs.writeFileSync(kuroTokenPath, JSON.stringify(updated, null, 2), 'utf-8');
    res.json({ success: true, message: '设置已保存' });
  } catch (error) {
    res.json({ success: false, error: '保存设置失败' });
  }
});

// 登出
app.post('/api/kuro/logout', (req, res) => {
  clearKuroToken();
  res.json({ success: true, message: '已登出' });
});

// 测试库洛wiki API（用已保存的token获取数据）
app.post('/api/kuro/test-api', async (req, res) => {
  try {
    const token = getKuroToken();
    if (!token) {
      return res.json({ success: false, error: '未登录，请先登录库洛wiki' });
    }
    const headers = getKuroHeaders(token);
    headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    headers['wiki_type'] = '2';
    // 测试搜索词条（使用实际的搜索API）
    const params = `keyword=${encodeURIComponent('露西亚')}&page=1&limit=100`;
    const result = await axios.post(`${KURO_API_BASE}/wiki/core/catalogue/item/search`, params, {
      timeout: 15000,
      headers,
    });

    if (result.data && result.data.code === 200) {
      const records = result.data.data?.results?.records || [];
      res.json({ success: true, message: 'API可用', data: { list: records } });
    } else {
      res.json({ success: false, error: result.data.msg || 'API调用失败', code: result.data.code });
    }
  } catch (error) {
    console.error('[Kuro] API测试失败:', error.message);
    res.json({ success: false, error: 'API测试失败: ' + error.message });
  }
});

app.get('/api/knowledge-urls', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const urls = promptBuilder.readKnowledgeUrls(characterId);
    res.json({ success: true, urls });
  } catch (error) {
    res.json({ success: true, urls: [] });
  }
});

app.post('/api/knowledge-urls', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { urls } = req.body;
    if (!Array.isArray(urls)) {
      return res.json({ success: false, error: '参数格式错误' });
    }
    promptBuilder.writeKnowledgeUrls(characterId, urls);
    res.json({ success: true, message: '知识网址已保存' });
  } catch (error) {
    console.error('[API] 保存知识网址失败:', error.message);
    res.json({ success: false, error: '保存知识网址失败' });
  }
});

// 对话技能API（默认+角色专属）
app.get('/api/conversation-skills', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const charSkills = promptBuilder.readConversationSkills(characterId);
    // 读取默认和角色专属分别
    const defaultPath = path.join(DATA_DIR, 'conversation_skills.txt');
    let defaultSkills = '';
    try { defaultSkills = fs.readFileSync(defaultPath, 'utf-8').trim(); } catch (e) {}
    const charPath = path.join(CHARACTER_DIR, characterId, 'conversation_skills.txt');
    let hasCharSkills = false;
    try { hasCharSkills = fs.existsSync(charPath); } catch (e) {}
    res.json({
      success: true,
      defaultSkills,
      charSkills: hasCharSkills ? charSkills : '',
      hasCharSkills,
      activeSkills: charSkills || defaultSkills,
    });
  } catch (error) {
    res.json({ success: true, defaultSkills: '', charSkills: '', hasCharSkills: false, activeSkills: '' });
  }
});

app.post('/api/conversation-skills/default', (req, res) => {
  try {
    const { content } = req.body;
    promptBuilder.writeDefaultConversationSkills(content || '');
    res.json({ success: true, message: '默认对话技能已保存' });
  } catch (error) {
    res.json({ success: false, error: '保存失败' });
  }
});

app.post('/api/conversation-skills/character', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { content } = req.body;
    promptBuilder.writeConversationSkills(characterId, content || '');
    res.json({ success: true, message: '角色专属对话技能已保存' });
  } catch (error) {
    res.json({ success: false, error: '保存失败' });
  }
});

app.delete('/api/conversation-skills/character', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const charPath = path.join(CHARACTER_DIR, characterId, 'conversation_skills.txt');
    if (fs.existsSync(charPath)) fs.unlinkSync(charPath);
    res.json({ success: true, message: '已删除角色专属对话技能' });
  } catch (error) {
    res.json({ success: false, error: '删除失败' });
  }
});

app.get('/api/skill-urls', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const urls = promptBuilder.readSkillUrls(characterId);
    res.json({ success: true, urls });
  } catch (error) {
    res.json({ success: true, urls: [] });
  }
});

app.post('/api/skill-urls', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { urls } = req.body;
    if (!Array.isArray(urls)) {
      return res.json({ success: false, error: '参数格式错误' });
    }
    promptBuilder.writeSkillUrls(characterId, urls);
    res.json({ success: true, message: 'Skill网址已保存' });
  } catch (error) {
    console.error('[API] 保存Skill网址失败:', error.message);
    res.json({ success: false, error: '保存Skill网址失败' });
  }
});

app.get('/api/lore', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const lore = promptBuilder.readLore(characterId);
    res.json({ success: true, lore });
  } catch (error) {
    res.json({ success: true, lore: { entries: [] } });
  }
});

app.post('/api/save-lore', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { content } = req.body;
    if (!content) return res.json({ success: false, error: '内容为空' });

    const lore = promptBuilder.readLore(characterId);
    lore.entries.push({
      content: content,
      date: new Date().toLocaleDateString('sv-SE').substring(0, 10),
    });
    promptBuilder.writeLore(characterId, lore);

    res.json({ success: true, message: '设定已保存' });
  } catch (error) {
    console.error('[API] 保存设定失败:', error.message);
    res.json({ success: false, error: '保存设定失败' });
  }
});

app.post('/api/delete-lore', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { index } = req.body;
    const lore = promptBuilder.readLore(characterId);
    if (index >= 0 && index < lore.entries.length) {
      lore.entries.splice(index, 1);
      promptBuilder.writeLore(characterId, lore);
      res.json({ success: true });
    } else {
      res.json({ success: false, error: '索引无效' });
    }
  } catch (error) {
    res.json({ success: false, error: '删除失败' });
  }
});

app.post('/api/permanent-fact', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { fact } = req.body;
    if (!fact) return res.json({ success: false, error: '内容为空' });
    const added = memoryService.addPermanentFact(characterId, fact);
    if (added) {
      res.json({ success: true, message: '永久记忆已添加' });
    } else {
      res.json({ success: false, error: '该记忆已存在' });
    }
  } catch (error) {
    console.error('[API] 添加永久记忆失败:', error.message);
    res.json({ success: false, error: '添加永久记忆失败' });
  }
});

app.post('/api/delete-permanent-fact', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { index } = req.body;
    const removed = memoryService.removePermanentFact(characterId, index);
    if (removed) {
      res.json({ success: true, message: '永久记忆已删除' });
    } else {
      res.json({ success: false, error: '索引无效' });
    }
  } catch (error) {
    console.error('[API] 删除永久记忆失败:', error.message);
    res.json({ success: false, error: '删除永久记忆失败' });
  }
});

app.post('/api/toggle-permanent-fact-important', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { index, important } = req.body || {};
    const updated = memoryService.setPermanentFactImportant(
      characterId,
      Number(index),
      important === true,
    );
    if (updated) {
      res.json({ success: true, message: important === true ? '已标记为重要事件' : '已取消重要标记' });
    } else {
      res.json({ success: false, error: '索引无效' });
    }
  } catch (error) {
    console.error('[API] 设置重要记忆失败:', error.message);
    res.json({ success: false, error: '设置重要记忆失败' });
  }
});

app.post('/api/toggle-important-event', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const { index, important } = req.body || {};
    const updated = memoryService.setImportantEventImportant(characterId, Number(index), important === true);
    res.json(updated
      ? { success: true, message: important === true ? '已标记为重要事件' : '已取消重要标记' }
      : { success: false, error: '索引无效' });
  } catch (error) {
    console.error('[API] 设置事件星标失败:', error.message);
    res.json({ success: false, error: '设置事件星标失败' });
  }
});

app.post('/api/delete-important-event', (req, res) => {
  try {
    const characterId = getCurrentCharacterId();
    const removed = memoryService.removeImportantEvent(characterId, Number(req.body?.index));
    res.json(removed
      ? { success: true, message: '重要事件已删除' }
      : { success: false, error: '索引无效' });
  } catch (error) {
    console.error('[API] 删除重要事件失败:', error.message);
    res.json({ success: false, error: '删除重要事件失败' });
  }
});

// ============================================================
// 登录问候状态管理（每日首次登录问候 + 凌晨深夜关心，每类每天仅一次）
// ============================================================
const GREETING_STATE_PATH = path.join(DATA_DIR, 'greeting_state.json');
const GREETING_RESERVATION_TTL_MS = 15 * 60 * 1000;

function readGreetingState() {
  try {
    return JSON.parse(fs.readFileSync(GREETING_STATE_PATH, 'utf-8'));
  } catch (e) {
    return {
      daily_greeting_sent_date: null,
      daily_greeting_reservation: null,
      midnight_care_sent_date: null,
      midnight_care_reservation: null,
      last_login_time: null,
      last_active_time: null
    };
  }
}

function writeGreetingState(state) {
  fs.writeFileSync(GREETING_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

function isGreetingReservationActive(reservation, today, now = Date.now()) {
  if (!reservation || reservation.date !== today || !reservation.createdAt) return false;
  const createdAt = new Date(reservation.createdAt).getTime();
  return Number.isFinite(createdAt) && now - createdAt < GREETING_RESERVATION_TTL_MS;
}

function commitGreetingReservation(reservationId) {
  const state = readGreetingState();
  const reservation = state.daily_greeting_reservation;
  if (!reservation || reservation.id !== reservationId || reservation.date !== getTodayStr()) {
    return false;
  }
  state.daily_greeting_sent_date = reservation.date;
  state.last_login_time = new Date().toISOString();
  state.daily_greeting_reservation = null;
  writeGreetingState(state);
  return true;
}

function commitMidnightCareReservation(reservationId) {
  const state = readGreetingState();
  const reservation = state.midnight_care_reservation;
  if (!reservation || reservation.id !== reservationId || reservation.date !== getTodayStr()) {
    return false;
  }
  state.midnight_care_sent_date = reservation.date;
  state.midnight_care_reservation = null;
  writeGreetingState(state);
  return true;
}

function getGreetingTypeByHour(hour) {
  return proactiveContextPolicy.getGreetingTypeByHour(hour);
}

function formatNowStr() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function getTodayStr() {
  return proactiveContextPolicy.localDateKey(new Date());
}

// Incremental intervals sum to the shared ~0.5h/6h/12h/24h/36h/48h
// silence milestones while preventing catch-up bursts after a restart.
const PROACTIVE_WAIT_MINUTES = [30, 330, 360, 720, 720, 720];
const PROACTIVE_REPEAT_MINUTES = 1440;

function getProactiveScheduleState(history, now = Date.now()) {
  const lastUserIndex = history.map(m => m.role).lastIndexOf('user');
  if (lastUserIndex < 0) return { due: false, reason: 'no_user_message', used: 0 };

  const afterLastUser = history.slice(lastUserIndex + 1);
  const directReply = afterLastUser.find(m => m.role === 'assistant' && !m.proactive);
  if (!directReply?.time) return { due: false, reason: 'no_direct_reply', used: 0 };

  const sent = afterLastUser.filter(m => m.role === 'assistant' && m.proactive);
  const anchor = sent.length > 0 ? sent[sent.length - 1] : directReply;
  const anchorTime = new Date(String(anchor.time || '').replace(' ', 'T')).getTime();
  if (!Number.isFinite(anchorTime)) return { due: false, reason: 'invalid_anchor_time', used: sent.length };

  const waitMin = PROACTIVE_WAIT_MINUTES[sent.length] || PROACTIVE_REPEAT_MINUTES;
  const elapsedMin = Math.max(0, (now - anchorTime) / (1000 * 60));
  return {
    due: elapsedMin >= waitMin,
    type: sent.length < 2 ? 'idle' : 'long-absence',
    used: sent.length,
    waitMin,
    elapsedMin,
    remainingMin: Math.max(0, waitMin - elapsedMin),
  };
}

// 主动消息核心处理函数（API端点与前端调度共用，服务端再次核对阶梯间隔）
let _proactiveLock = false; // 内存锁：防止并发请求同时通过频率检查
async function proactiveChatHandler(type) {
  // 内存锁：防止多标签页/visibilitychange并发导致重复
  if (_proactiveLock) {
    return { success: false, error: '主动消息正在生成中' };
  }
  _proactiveLock = true;
  try {
    return await _proactiveChatHandlerInner(type);
  } finally {
    _proactiveLock = false;
  }
}

async function _proactiveChatHandlerInner(type) {
  const characterId = getCurrentCharacterId();
  const characterApiConfig = readCurrentCharacterApiSettings(characterId);
  const providerInfo = aiClient.getProviderInfo(characterApiConfig);
  if (!providerInfo.configured) {
    return { success: false, error: 'API未配置' };
  }

  const history = historyService.readHistory(characterId);

  if (type === 'idle' || type === 'long-absence') {
    const schedule = getProactiveScheduleState(history);
    if (!schedule.due) {
      return { success: false, error: '主动消息阶梯间隔尚未到达', schedule };
    }
    type = schedule.type;
  }

  // === 服务端强制频率限制 ===
  // 1小时内最多7条主动消息，作为异常调用的最终保险。
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  let recentProactiveCount = 0;
  for (const msg of [...history].reverse()) {
    if (!msg.time) continue;
    const msgTime = new Date(msg.time.replace(' ', 'T')).getTime();
    if (msgTime < oneHourAgo) break;
    if (msg.proactive) recentProactiveCount++;
  }
  if (recentProactiveCount >= 7) {
    return { success: false, error: '1小时内主动消息已达上限' };
  }

  // 两次主动消息至少间隔5分钟（避免短时间内多条重复）
  const lastProactive = [...history].reverse().find(m => m.proactive);
  if (lastProactive && lastProactive.time) {
    const minsSince = (Date.now() - new Date(lastProactive.time.replace(' ', 'T')).getTime()) / (1000 * 60);
    if (minsSince < 5) {
      return { success: false, error: '主动消息间隔不足5分钟' };
    }
  }

  const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
  const hoursSinceLastUser = lastUserMsg && lastUserMsg.time
    ? (Date.now() - new Date(lastUserMsg.time.replace(' ', 'T')).getTime()) / (1000 * 60 * 60)
    : Infinity;
  const elapsedMinutes = Number.isFinite(hoursSinceLastUser)
    ? Math.max(0, Math.round(hoursSinceLastUser * 60))
    : 0;

  // 主动消息时不传 userInput：用户没说话，不需要 RAG 检索历史对话/知识库
  // 否则会把"夜深了"等污染内容注入 prompt 导致 AI 模仿
  // 主动消息没有本轮用户输入；只使用稳定规则，相关用户细节由下方受控上下文提供。
  const systemPrompt = promptBuilder.buildStableSystemPrompt(characterId);
  const now = new Date();
  const memory = memoryService.readMemory(characterId);
  const isFirstEntryType = ['morning', 'afternoon', 'evening', 'late_night'].includes(type);
  const festival = isFirstEntryType
    ? proactiveContextPolicy.getFestivalForDate(now, memory.festival_notes)
    : null;
  const proactiveInstruction = proactiveContextPolicy.buildProactiveInstruction({
    type,
    now,
    festival,
    elapsedMinutes,
  });
  const recentUserContext = proactiveContextPolicy.buildProactiveUserContext(history, 4);
  const recentUserDetail = proactiveContextPolicy.getRecentUserDetail(history);

  // 保留最近12条完整回复用于措辞、意象、场景和开场结构去重；不把旧助手原文注入提示词。
  const recentAssistantMsgs = history
    .filter(m => m.role === 'assistant')
    .slice(-12)
    .map(m => String(m.content || '').replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 5);
  // Keep prompt context small, but inspect a wider local window for topic
  // freshness so an old repeated personal subject cannot reappear merely
  // because it fell outside the twelve-message prompt window.
  const allRecentProactive = history.filter(message => message && message.proactive);
  const recentProactive = allRecentProactive.slice(-12);
  const proactiveForCooldown = allRecentProactive.slice(-48);
  // A user re-opening a remembered subject is a meaningful freshness reset.
  // Compare timestamps so an old user mention does not accidentally unlock a
  // topic that was followed up more recently by the assistant.
  const latestProactiveTopicTimes = new Map();
  for (const message of proactiveForCooldown) {
    const category = proactiveContextPolicy.getMessageCategory(message);
    if (!category.topicKey) continue;
    const timestamp = proactiveContextPolicy.parseMessageTime(message.time);
    const previous = latestProactiveTopicTimes.get(category.topicKey) || 0;
    latestProactiveTopicTimes.set(category.topicKey, Math.max(previous, timestamp));
  }
  const reopenedTopicKeys = [...new Set(history
    .filter(message => message && message.role === 'user')
    .map(message => ({ key: proactiveContextPolicy.classifyPersonalTopic(message.content || ''), time: proactiveContextPolicy.parseMessageTime(message.time) }))
    .filter(item => item.key && item.time > (latestProactiveTopicTimes.get(item.key) || 0))
    .map(item => item.key))];
  const recentCategoryIds = recentProactive
    .map(message => message.proactiveCategory)
    .filter(Boolean)
    .map(category => [
      category.topicCategory || 'general_checkin',
      category.sceneCategory || 'none',
      ...(Array.isArray(category.motifCategories) ? category.motifCategories : []),
      category.openingPattern || 'other',
    ].join('/'));
  const categoryContext = recentCategoryIds.length > 0
    ? `\n最近主动消息类别（只用于去重，不复述旧内容）：${recentCategoryIds.join('、')}`
    : '';
  const userContextBlock = recentUserContext
    ? `\n\n【最近用户原话】\n${recentUserContext}`
    : '';
  const finalSystemPrompt = `${systemPrompt}\n\n【主动消息规则】\n${proactiveInstruction}${categoryContext}${userContextBlock}\n\n不要输出时间戳，不要虚构用户未说过的经历、情绪或离开原因。`;

  const messages = [
    { role: 'system', content: finalSystemPrompt },
    { role: 'user', content: '（用户当前没有说话，请主动发起问候）' },
  ];

  const recentAssistForPolicy = history.filter(m => m.role === 'assistant').slice(-8);
  const prepareProactiveCandidate = (rawReply) => {
    const parsed = memoryService.parseReplyPerformance(rawReply, '');
    const cleanReply = replyPolicy.sanitize(parsed.cleanReply, recentAssistForPolicy, {
      characterId,
      appRoot: __dirname,
    });
    // 与普通聊天链的 prepareCandidate 一致：上游偶发只返回隐藏元数据、
    // 空字符串或 null 时，候选必须判为无效，绝不写入空气泡到历史。
    if (!String(cleanReply || '').trim()) return null;
    if (!replyPolicy.isQuoteUsageAcceptable(cleanReply, recentUserDetail, recentAssistForPolicy)) return null;
    return {
      reply: cleanReply,
      performance: replyPerformancePolicy.normalizeReplyPerformance(
        parsed.rawPerformance,
        cleanReply,
      ),
    };
  };
  let preparedCandidate = prepareProactiveCandidate(await aiClient.chatWithAI(messages, {
    settings: characterApiConfig,
  }));
  let reply = preparedCandidate ? preparedCandidate.reply : '';
  let performance = preparedCandidate
    ? preparedCandidate.performance
    : replyPerformancePolicy.normalizeReplyPerformance(null, reply);

  const evaluateProactiveCandidate = (candidate) => {
    // 空候选直接判无效，确保走重写与动态兜底路径，而不是落库为空气泡。
    if (!String(candidate || '').trim()) {
      return {
        valid: false,
        category: proactiveContextPolicy.classifyProactiveContent(''),
        reasons: ['empty_reply'],
      };
    }
    const category = proactiveContextPolicy.classifyProactiveContent(candidate);
    const temporal = proactiveContextPolicy.validateTemporalConsistency(candidate, now, recentUserContext);
    const grounding = proactiveContextPolicy.validateProactiveGrounding(candidate, recentUserContext);
    const repeatedText = replyPolicy.isSimilarToRecent(candidate, recentAssistantMsgs, 0.5);
    const repeatedFeatures = !proactiveContextPolicy.passesCooldown(
      category,
      proactiveForCooldown,
      48,
      {
        now,
        topicFreshnessDays: proactiveContextPolicy.PROACTIVE_TOPIC_FRESHNESS_DAYS,
        reopenedTopicKeys,
      },
    );
    return {
      valid: temporal.valid && grounding.valid && !repeatedText && !repeatedFeatures,
      category,
      reasons: [
        ...temporal.reasons,
        ...grounding.reasons,
        ...(repeatedText ? ['repeated_text'] : []),
        ...(repeatedFeatures ? ['repeated_features'] : []),
      ],
    };
  };

  let proactiveCategory = proactiveContextPolicy.classifyProactiveContent(reply);
  let evaluation = evaluateProactiveCandidate(reply);
  if (!evaluation.valid) {
    console.log(`[Proactive] 候选未通过本地校验: ${evaluation.reasons.join(', ')}，触发重写`);
    const rewritePrompt = `${finalSystemPrompt}\n\n刚才的候选未通过本地校验：${evaluation.reasons.join('、')}。彻底换一个关心角度、场景、意象和开场结构；仍然只能依据最近用户原话，不得复述任何旧助手回复。`;
    const rewriteMessages = [
      { role: 'system', content: rewritePrompt },
      { role: 'user', content: '（用户当前没有说话，请主动发起一个与之前完全不同的问候）' },
    ];
    preparedCandidate = prepareProactiveCandidate(await aiClient.chatWithAI(rewriteMessages, {
      settings: characterApiConfig,
    }));
    reply = preparedCandidate ? preparedCandidate.reply : '';
    performance = preparedCandidate
      ? preparedCandidate.performance
      : replyPerformancePolicy.normalizeReplyPerformance(null, reply);
    evaluation = evaluateProactiveCandidate(reply);
    proactiveCategory = evaluation.category;
    if (!evaluation.valid) {
      console.log(`[Proactive] 重写后仍未通过: ${evaluation.reasons.join(', ')}，使用基于近期用户细节的动态兜底`);
      reply = replyPolicy.pickProactiveFallback({
        now,
        elapsedMinutes,
        recentUserDetail,
        recentAssistants: recentAssistantMsgs.map(content => ({ content })),
      });
      performance = replyPerformancePolicy.normalizeReplyPerformance(null, reply);
      proactiveCategory = proactiveContextPolicy.classifyProactiveContent(reply);
    }
  } else {
    proactiveCategory = evaluation.category;
  }

  // 最终保险：兜底后仍为空（极端情况）则跳过本轮主动消息，
  // 绝不把空 assistant 气泡写入历史。
  if (!String(reply || '').trim()) {
    console.warn('[Proactive] 兜底后仍为空，跳过本轮主动消息写入');
    return { success: false, error: 'PROACTIVE_EMPTY_REPLY' };
  }

  // 只提交最终采用的隐藏表现元数据；被本地校验淘汰的候选不进入情绪记忆。
  memoryService.applyReplyPerformance(characterId, performance);

  historyService.addMessage(characterId, 'assistant', reply, {
    proactive: true,
    proactiveCategory,
    performance,
  });
  return { success: true, reply, performance };
}

// 登录问候检查：前端登录后调用，返回是否需要问候 + 类型
app.get('/api/greeting/check', async (req, res) => {
  try {
    const state = readGreetingState();
    const now = new Date();
    const decision = proactiveContextPolicy.getGreetingDecision(state, now);
    const today = decision.date;

    // 更新最后活跃时间
    state.last_active_time = now.toISOString();
    writeGreetingState(state);

    // 1. 检查当天是否已成功送达首次登录问候
    if (!decision.shouldGreet) {
      return res.json({ shouldGreet: false, type: null, reason: decision.reason });
    }

    // 2. 已有未过期预留时，不让多个窗口重复生成；过期预留允许重新尝试。
    if (isGreetingReservationActive(state.daily_greeting_reservation, today)) {
      return res.json({ shouldGreet: false, type: null, reason: 'pending_delivery' });
    }

    // 3. 预留本次问候。只有主动消息真实写入历史后才会提交为 sent。
    const reservationId = require('crypto').randomBytes(18).toString('hex');
    state.daily_greeting_reservation = {
      id: reservationId,
      date: today,
      createdAt: now.toISOString(),
    };
    writeGreetingState(state);

    return res.json({
      shouldGreet: true,
      type: decision.type,  // morning / afternoon / evening / late_night
      reservationId,
      reason: 'first_login_today'
    });
  } catch (error) {
    console.error('[Greeting] check error:', error.message);
    res.json({ shouldGreet: false, type: null, error: error.message });
  }
});

// 凌晨深夜关心检查（前端 0 点后调用，每天最多一次）
app.get('/api/greeting/midnight-check', async (req, res) => {
  try {
    const state = readGreetingState();
    const today = getTodayStr();
    const now = new Date();
    const hour = now.getHours();

    // 只有 0:00-5:59 才检查深夜关心
    if (hour >= 6) {
      return res.json({ shouldSend: false, reason: 'not_late_night' });
    }

    // 当天已发过深夜关心
    if (state.midnight_care_sent_date === today) {
      return res.json({ shouldSend: false, reason: 'already_sent' });
    }

    if (isGreetingReservationActive(state.midnight_care_reservation, today)) {
      return res.json({ shouldSend: false, reason: 'reserved' });
    }

    // 先预留，只有主动消息真正写入历史后才提交为 sent。
    const reservationId = `midnight-${today}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.midnight_care_reservation = {
      id: reservationId,
      date: today,
      createdAt: new Date().toISOString(),
    };
    writeGreetingState(state);

    return res.json({ shouldSend: true, type: 'late_night_care', reservationId });
  } catch (error) {
    res.json({ shouldSend: false, error: error.message });
  }
});

app.post('/api/proactive-chat', async (req, res) => {
  try {
    const { type, greetingReservationId, midnightCareReservationId } = req.body;
    const result = await proactiveChatHandler(type);
    if (result.success && greetingReservationId) {
      result.greetingCommitted = commitGreetingReservation(greetingReservationId);
      if (type === 'late_night' && greetingReservationId && result.greetingCommitted) {
        const state = readGreetingState();
        state.midnight_care_sent_date = getTodayStr();
        state.midnight_care_reservation = null;
        writeGreetingState(state);
      }
    }
    if (result.success && midnightCareReservationId) {
      result.midnightCareCommitted = commitMidnightCareReservation(midnightCareReservationId);
    } else if (!result.success && midnightCareReservationId) {
      const state = readGreetingState();
      if (state.midnight_care_reservation?.id === midnightCareReservationId) {
        state.midnight_care_reservation = null;
        writeGreetingState(state);
      }
    }
    res.json(result);
  } catch (error) {
    console.error('[API] 主动消息失败:', error.message);
    res.json({ success: false, error: '主动消息失败' });
  }
});

app.post('/api/greeting/release', (req, res) => {
  try {
    const { reservationId, midnightCareReservationId } = req.body || {};
    const state = readGreetingState();
    if (reservationId && state.daily_greeting_reservation?.id === reservationId) {
      state.daily_greeting_reservation = null;
    }
    if (midnightCareReservationId && state.midnight_care_reservation?.id === midnightCareReservationId) {
      state.midnight_care_reservation = null;
    }
    writeGreetingState(state);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 主动消息定时检查端点（前端周期性调用）
app.get('/api/proactive-check', (req, res) => {
  const characterId = getCurrentCharacterId();
  const history = historyService.readHistory(characterId);
  const schedule = getProactiveScheduleState(history);
  res.json({
    shouldTrigger: schedule.due,
    triggerType: schedule.type || null,
    used: schedule.used || 0,
    waitMinutes: schedule.waitMin || null,
    elapsedMinutes: Number.isFinite(schedule.elapsedMin) ? Math.round(schedule.elapsedMin) : null,
    remainingMinutes: Number.isFinite(schedule.remainingMin) ? Math.ceil(schedule.remainingMin) : null,
    reason: schedule.reason || null,
  });
});

// 后端定时器已禁用：前端 proactiveTick 统一按 5m/15m/30m/1h/3h/6h/12h/每12h 调度
// 保留此函数仅为兼容旧调用，实际不启动定时器
let proactiveCheckInterval = null;
function startProactiveTimer() {
  // 不启动后端定时器，避免与前端 proactiveTick 重复触发主动消息
  // 前端每分钟检查一次 shouldSendProactive，覆盖所有时间档位
  console.log('[ProactiveTimer] 后端定时器已禁用，由前端 proactiveTick 统一调度');
}

function migrateOldData() {
  const charDir = CHARACTER_DIR;
  const dataDir = DATA_DIR;

  const defaultCharDir = path.join(charDir, 'default');
  if (!fs.existsSync(defaultCharDir) && fs.existsSync(charDir)) {
    const charFiles = ['profile.json', 'character.md', 'supplementary.txt', 'lore.json'];
    const hasOldFiles = charFiles.some(f => fs.existsSync(path.join(charDir, f)));

    if (hasOldFiles) {
      fs.mkdirSync(defaultCharDir, { recursive: true });
      for (const f of charFiles) {
        const oldPath = path.join(charDir, f);
        if (fs.existsSync(oldPath)) {
          const content = fs.readFileSync(oldPath, 'utf-8');
          writeUtf8Atomic(path.join(defaultCharDir, f), content);
          fs.unlinkSync(oldPath);
          console.log(`[Migrate] 迁移角色文件: ${f} -> default/${f}`);
        }
      }
      const oldPngs = ['character.png', 'user.png', 'context.png'];
      for (const f of oldPngs) {
        const oldPath = path.join(charDir, f);
        if (fs.existsSync(oldPath)) {
          const content = fs.readFileSync(oldPath);
          fs.writeFileSync(path.join(defaultCharDir, f), content);
          fs.unlinkSync(oldPath);
          console.log(`[Migrate] 迁移角色图片: ${f} -> default/${f}`);
        }
      }
      console.log('[Migrate] 旧角色文件已迁移到 character/default/');
    }
  }

  if (fs.existsSync(dataDir)) {
    const dataMigrations = [
      { old: 'memory.json', new: 'default_memory.json' },
      { old: 'chat_history.json', new: 'default_chat_history.json' },
      { old: 'compressed_history.json', new: 'default_compressed_history.json' },
    ];
    for (const m of dataMigrations) {
      const oldPath = path.join(dataDir, m.old);
      const newPath = path.join(dataDir, m.new);
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        const content = fs.readFileSync(oldPath, 'utf-8');
        writeUtf8Atomic(newPath, content);
        fs.unlinkSync(oldPath);
        console.log(`[Migrate] 重命名数据文件: ${m.old} -> ${m.new}`);
      }
    }
  }
}

// ========== 图库系统 ==========
const GALLERY_DIR = path.join(DATA_DIR, 'gallery');
if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true });

const galleryStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, GALLERY_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.png';
    cb(null, uniqueSuffix + ext);
  },
});
const galleryUpload = multer({
  storage: galleryStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('仅支持图片文件'));
  },
});

app.post('/api/gallery/upload', galleryUpload.array('images', 30), (req, res) => {
  try {
    const files = req.files || [];
    const results = files.map(f => ({
      id: f.filename,
      name: f.originalname,
      url: `/api/gallery/image/${f.filename}`,
    }));
    res.json({ success: true, count: results.length, images: results });
  } catch (error) {
    res.json({ success: false, error: '上传失败' });
  }
});

app.get('/api/gallery/list', (req, res) => {
  try {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const files = fs.readdirSync(GALLERY_DIR)
      .filter(f => allowed.includes(path.extname(f).toLowerCase()))
      .map(f => ({
        id: f,
        name: f,
        url: `/api/gallery/image/${f}`,
        time: fs.statSync(path.join(GALLERY_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.time - a.time);
    res.json({ success: true, images: files });
  } catch (error) {
    res.json({ success: true, images: [] });
  }
});

app.get('/api/gallery/image/:filename', (req, res) => {
  const filePath = path.join(GALLERY_DIR, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Not found');
  }
});

app.post('/api/gallery/delete', (req, res) => {
  try {
    const { id } = req.body;
    const filePath = path.join(GALLERY_DIR, id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.json({ success: false, error: '图片不存在' });
    }
  } catch (error) {
    res.json({ success: false, error: '删除失败' });
  }
});

app.post('/api/gallery/apply', (req, res) => {
  try {
    const { imageId, targetType } = req.body; // targetType: 'character' | 'user' | 'context'
    const allowedPrefixes = ['character', 'user', 'context'];
    if (!allowedPrefixes.includes(targetType)) {
      return res.json({ success: false, error: '不支持的目标类型' });
    }
    const srcPath = path.join(GALLERY_DIR, imageId);
    if (!fs.existsSync(srcPath)) {
      return res.json({ success: false, error: '图库中无此图片' });
    }
    const characterId = getCurrentCharacterId();
    const charDir = path.join(CHARACTER_DIR, characterId);
    if (!fs.existsSync(charDir)) fs.mkdirSync(charDir, { recursive: true });

    // 保留源文件扩展名
    const srcExt = path.extname(imageId).toLowerCase();
    const destPath = path.join(charDir, targetType + srcExt);

    // 删除同类型旧文件（不同扩展名）
    const allExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    for (const ext of allExts) {
      if (ext !== srcExt) {
        const oldPath = path.join(charDir, targetType + ext);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
    }

    fs.copyFileSync(srcPath, destPath);
    res.json({ success: true, message: `${targetType} 已从图库更新` });
  } catch (error) {
    res.json({ success: false, error: '应用失败' });
  }
});

// ============================================================
// 语音 API — 按角色隔离声音资产
// character\{id}\voice\config.json 存在 → 该角色有语音
// ============================================================

// [CHAT6-COMPAT] TTS 端口改为 9882（Chat6 预留，非 Chat5 的 9882）
// 注意：chat5-compat 当前为静态源码，依赖未安装，不可运行（见 chat5-compat/README.md）
const TTS_API_URL = 'http://127.0.0.1:9882';
const TTS_OWNERSHIP_FILE = path.join(DATA_DIR, 'tts_process.json');
// TTS API 连接复用：使用 keep-alive Agent 减少 TCP 握手开销，提升连续合成速度
const http = require('http');
const ttsAgent = new http.Agent({ keepAlive: true, maxSockets: 5, keepAliveMsecs: 30000 });
const ttsWarmup = createTtsWarmupController({
  // 预热也经过同一 FIFO，不能和真实回复同时占用 TTS worker。
  synthesize: async (body) => _enqueueVoiceSynthesis(async () => {
    const response = await axios.post(`${TTS_API_URL}/tts/json`, body, {
      timeout: 390000,
      httpAgent: ttsAgent,
    });
    return response.data || {};
  }),
  cleanup: async (localPath) => {
    if (localPath && fs.existsSync(localPath)) fs.rmSync(localPath, { force: true });
  },
});
const VOICE_OUTPUT_DIR = path.join(CACHE_DIR, 'voice');
if (!fs.existsSync(VOICE_OUTPUT_DIR)) fs.mkdirSync(VOICE_OUTPUT_DIR, { recursive: true });

function getCharacterVoiceOutputDir(charId) {
  const id = String(charId || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('角色 ID 无效');
  const dir = path.join(CHARACTER_DIR, id, 'voice_cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveVoiceAudioPath(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName) return null;
  const charId = safeName.match(/^char([^_]+)_/)?.[1];
  if (charId) {
    try {
      const characterPath = path.join(getCharacterVoiceOutputDir(charId), safeName);
      if (fs.existsSync(characterPath)) return characterPath;
    } catch (_) { /* fall through to legacy shared cache */ }
  }
  const legacyPath = path.join(VOICE_OUTPUT_DIR, safeName);
  return fs.existsSync(legacyPath) ? legacyPath : null;
}

// 新版聊天缓存统一使用 char<id>_*.wav；旧版 selina_*.wav 已停止使用并清理。
function isCharacterVoiceFile(name, charId) {
  if (typeof name !== 'string' || !name.endsWith('.wav')) return false;
  const id = String(charId || '').trim();
  return name.startsWith(`char${id}_`);
}

function listCharacterVoiceFiles(charId) {
  const roots = [getCharacterVoiceOutputDir(charId), VOICE_OUTPUT_DIR];
  const seen = new Set();
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!isCharacterVoiceFile(name, charId)) continue;
      const filePath = path.join(root, name);
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      files.push({ name, path: filePath, mtime: fs.statSync(filePath).mtimeMs });
    }
  }
  return files;
}

// ========== 语音缓存自动清理（按角色独立上限，默认满30条删最旧15条，节约内存） ==========
// 上限可通过数据管理界面自定义：30 / 60 / 100 / 0(关闭自动删除)
// 每个角色独立配置：data/voice_cache_limit_<charId>.json
function getVoiceCacheLimitFile(charId) {
  return path.join(DATA_DIR, `voice_cache_limit_${charId}.json`);
}
function getVoiceCacheLimit(charId) {
  try {
    const file = getVoiceCacheLimitFile(charId);
    if (fs.existsSync(file)) {
      const v = JSON.parse(fs.readFileSync(file, 'utf-8')).limit;
      if (typeof v === 'number' && v >= 0) return v;
    }
  } catch (e) {}
  return 30; // 默认满30条删除
}
function cleanupVoiceCache(charId) {
  try {
    if (!fs.existsSync(VOICE_OUTPUT_DIR)) return;
    const limit = getVoiceCacheLimit(charId);
    if (limit === 0) return; // 关闭自动删除
    const files = listCharacterVoiceFiles(charId)
      .sort((a, b) => b.mtime - a.mtime); // 新→旧
    // ★ 达到上限时删除最旧的一半（30删15/60删30/100删50），保留最新一半
    if (files.length >= limit) {
      const keepCount = Math.floor(limit / 2); // 保留最新的一半
      const toDelete = files.slice(keepCount); // 删除其余
      const deletedNames = new Set();
      for (const f of toDelete) {
        try { fs.unlinkSync(f.path); deletedNames.add(f.name); } catch (e) {}
      }
      // 同步清理 L3 缓存中指向已删文件的条目
      let cleanedEntries = 0;
      for (const [key, filename] of _voiceCache) {
        if (deletedNames.has(filename)) {
          _voiceCache.delete(key);
          cleanedEntries++;
        }
      }
      for (const [key, entry] of _voiceCacheManifest) {
        if (deletedNames.has(entry?.filename)) _voiceCacheManifest.delete(key);
      }
      if (cleanedEntries > 0) _saveVoiceCacheToDisk();
      _saveVoiceCacheManifest();
      console.log(`[Voice] 缓存清理(角色${charId}): ${files.length} 条（上限${limit}）→ 保留最新 ${keepCount} 条，删除 ${toDelete.length} 条最旧文件，清理 ${cleanedEntries} 条缓存映射`);
    }
  } catch (e) {
    console.error('[Voice] 缓存清理失败:', e.message);
  }
}

// 设置页试听是临时资源：不进入角色聊天语音索引，按当前角色最多保留3条。
// 文件仍放在用户数据 cache/voice 下，character/<id>/voice_cache 只保存聊天 WAV；
// 设置页试听不进入角色目录。
function cleanupVoicePreviewCache(charId, keep = 3) {
  try {
    if (!fs.existsSync(VOICE_OUTPUT_DIR)) return;
    const prefix = `preview_char${charId}_`;
    const files = fs.readdirSync(VOICE_OUTPUT_DIR)
      .filter(name => name.startsWith(prefix) && name.endsWith('.wav'))
      .map(name => {
        const filePath = path.join(VOICE_OUTPUT_DIR, name);
        return { name, filePath, mtime: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(Math.max(0, keep))) {
      try { fs.unlinkSync(file.filePath); } catch (_) { /* best effort */ }
    }
  } catch (e) {
    console.warn('[Voice] 清理试听语音失败:', e.message);
  }
}

// ========== 智能情感缓存（事件驱动 + 多层检测 + 人设稳定） ============
// 替换原 30 分钟硬过期方案：
//   ① 强情感关键词命中 → 立即刷新
//   ② 句式模式命中（!!!/???/哈哈/呜呜/省略号） → 立即刷新
//   ③ 时间段切换（早/午/晚/深夜） → 刷新
//   ④ 沉默梯度（10min/1h/6h） → 刷新
//   ⑤ 连续对话 < 10min 且无情感词 → 保持缓存（连续性保护）
//   ⑥ 12 轮保护性刷新，避免锁死
// 同时通过角色 Skill 的 emotion_mapping 字段实现人设稳定性：
//   不同角色面对同一情感（如 sad）可以反应为不同的 TTS 标签
//   例如：温柔角色 sad → comfort；傲娇角色 sad → shy_happy
const conversationEmotionCache = new Map();

// 强情感关键词词表（经过语料验证的高准确率词汇）
const EMOTION_KEYWORDS = {
  sad: ['哭', '难过', '伤心', '痛苦', '想哭', '委屈', '失望', '难受', '心疼', '难熬', '煎熬', '痛心', '心碎'],
  angry: ['生气', '气死', '烦死', '讨厌', '恨', '滚', '闭嘴', '烦人', '受够了', '忍无可忍', '气炸'],
  tired: ['累', '困', '疲惫', '撑不住', '不行了', '睡不着', '失眠', '筋疲力尽', '累瘫', '累死'],
  anxious: ['焦虑', '紧张', '害怕', '担心', '恐惧', '不安', '慌', '崩溃', '压力大', '抑郁', '迷茫'],
  happy: ['开心', '高兴', '哈哈', '嘿嘿', '笑死', '快乐', '幸福', '开森', '爽', '舒服', '满足'],
  excited: ['太棒', '好耶', '爱你', '喜欢', '激动', '兴奋', '期待', '赞', '牛', '厉害', '棒'],
  question: ['为什么', '怎么办', '如何', '什么意思', '不懂', '疑惑', '纳闷'],
  surprised: ['什么', '真的', '不会吧', '天啊', '我去', '卧槽', '震惊', '没想到']
};

// 默认情感类型 → TTS 标签映射（可被角色 Skill 的 emotion_mapping 覆盖）
const DEFAULT_EMOTION_TO_TTS = {
  sad: 'sad',
  angry: 'strong',
  tired: 'gentle',      // 疲惫用温柔语气
  anxious: 'comfort',   // 焦虑用安慰语气
  happy: 'shy_happy',
  excited: 'excited',
  question: 'question',
  surprised: 'question' // TTS 无 surprise 标签，归并到 question
};

// 第一层：强情感关键词检测
function detectEmotionByKeywords(message) {
  if (!message) return null;
  for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
    if (keywords.some(kw => message.includes(kw))) {
      return emotion;
    }
  }
  return null;
}

// 第二层：句式模式检测
function detectEmotionByPattern(message) {
  if (!message) return null;
  // 多个感叹号 → 激动/生气
  if (/[!！]{2,}/.test(message)) {
    return /不|没|别/.test(message) ? 'angry' : 'excited';
  }
  // 多个问号 → 疑惑/震惊
  if (/[?？]{2,}/.test(message)) {
    return 'surprised';
  }
  // 重复词（哈哈哈、呜呜呜） → 开心/难过
  if (/哈{3,}/.test(message)) return 'happy';
  if (/呜{2,}|555|T[_\.]?T/i.test(message)) return 'sad';
  // 省略号 → 犹豫/疲惫
  if (/[。\.]{3,}/.test(message)) return 'tired';
  return null;
}

// 第三层：时间场景检测
function getTimeZone(hour) {
  if (hour >= 6 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night'; // 22-6 深夜
}

function shouldAdjustForTime(hour, currentEmotion) {
  // 深夜（23-6点）且当前不是温柔/安慰 → 应该更温柔
  if ((hour >= 23 || hour < 6) && !['gentle', 'comfort'].includes(currentEmotion)) {
    return 'gentle';
  }
  return null;
}

// 沉默时长梯度
function getSilenceLevel(timeSince) {
  if (timeSince < 10 * 60 * 1000) return 0;           // <10min 无变化
  if (timeSince < 60 * 60 * 1000) return 1;           // 10-60min 轻关心
  if (timeSince < 6 * 60 * 60 * 1000) return 2;       // 1-6h 想念
  return 3;                                            // >6h 担心
}

// 读取角色 Skill 中定义的 emotion_mapping（人设稳定性）
// 返回 null 表示用默认映射
// Skill 文件路径：character/<id>/skill.json 的 emotion_mapping 字段
function getCharacterEmotionMapping(charId) {
  try {
    const skillPath = path.join(CHARACTER_DIR, String(charId), 'skill.json');
    if (fs.existsSync(skillPath)) {
      const skill = JSON.parse(fs.readFileSync(skillPath, 'utf-8'));
      if (skill && skill.emotion_mapping && typeof skill.emotion_mapping === 'object') {
        return skill.emotion_mapping;
      }
    }
  } catch (e) {
    console.error('[EmotionMapping] 读取角色情感映射失败:', e.message);
  }
  return null;
}

// 将情感类型转换为 TTS 标签，应用角色专属映射
function resolveEmotionLabel(charId, emotionType) {
  if (!emotionType) return null;
  const mapping = getCharacterEmotionMapping(charId) || DEFAULT_EMOTION_TO_TTS;
  return mapping[emotionType] || DEFAULT_EMOTION_TO_TTS[emotionType] || 'gentle';
}

// 核心：判断是否需要刷新情感
function shouldRefreshEmotion(charId, userMessage) {
  const cache = conversationEmotionCache.get(String(charId));
  if (!cache) return true; // 首次对话必检测

  const now = Date.now();
  const timeSince = now - cache.lastMsgTime;
  const hour = new Date().getHours();

  // ① 强情感关键词（最高优先级）
  const keywordEmotion = detectEmotionByKeywords(userMessage);
  if (keywordEmotion && keywordEmotion !== cache.emotionType) {
    console.log(`[情感切换] char${charId}: ${cache.emotionType} → ${keywordEmotion} (关键词)`);
    return true;
  }

  // ② 句式模式检测
  const patternEmotion = detectEmotionByPattern(userMessage);
  if (patternEmotion && patternEmotion !== cache.emotionType) {
    console.log(`[情感切换] char${charId}: ${cache.emotionType} → ${patternEmotion} (句式)`);
    return true;
  }

  // ③ 时间段切换
  const timeZone = getTimeZone(hour);
  if (cache.timeZone !== timeZone) {
    console.log(`[时间场景] char${charId}: ${cache.timeZone} → ${timeZone}`);
    return true;
  }

  // ④ 深夜特殊处理
  const timeAdjust = shouldAdjustForTime(hour, cache.emotion);
  if (timeAdjust && timeAdjust !== cache.emotion) {
    console.log(`[深夜调整] char${charId}: ${cache.emotion} → ${timeAdjust}`);
    return true;
  }

  // ⑤ 沉默间隔（梯度处理）
  if (timeSince > 10 * 60 * 1000) {
    const silenceLevel = getSilenceLevel(timeSince);
    if (silenceLevel !== cache.silenceLevel) {
      console.log(`[沉默 ${Math.floor(timeSince / 60000)}min] char${charId}: 关心级别 ${silenceLevel}`);
      return true;
    }
  }

  // ⑥ 对话轮次保护
  if (cache.msgCount >= 12) {
    console.log(`[对话轮次 ${cache.msgCount}] char${charId}: 保护性刷新`);
    return true;
  }

  return false;
}

// 获取缓存的情感（事件驱动版）
function getCachedEmotion(charId, userMessage) {
  if (shouldRefreshEmotion(charId, userMessage)) {
    return null; // 需要重新检测
  }
  const cache = conversationEmotionCache.get(String(charId));
  return cache ? cache.emotion : null;
}

// 设置缓存（同时记录情感类型与上下文）
function setCachedEmotion(charId, emotion, userMessage) {
  if (!emotion || emotion === 'auto') return;
  const cache = conversationEmotionCache.get(String(charId)) || { msgCount: 0, lastMsgTime: Date.now() };
  const hour = new Date().getHours();
  const now = Date.now();

  // 检测情感类型（用于下次对比）
  const emotionType = detectEmotionByKeywords(userMessage)
                   || detectEmotionByPattern(userMessage)
                   || 'neutral';

  conversationEmotionCache.set(String(charId), {
    emotion,              // TTS 标签（如 'gentle'）
    emotionType,          // 情感类型（如 'tired'）
    timeZone: getTimeZone(hour),
    silenceLevel: getSilenceLevel(now - (cache.lastMsgTime || now)),
    lastMsgTime: now,
    msgCount: cache.msgCount + 1
  });
}

// 清除缓存
function clearCachedEmotion(charId) {
  if (charId) {
    conversationEmotionCache.delete(String(charId));
  } else {
    conversationEmotionCache.clear();
  }
}

// 获取角色在新架构 voices/ 下的 config.json 路径
// 新架构：包内 voices/<voiceName>/config.json 与 userData/voices 共同使用。
// 通过 data/character_voices.json 映射角色→语音名
function getVoiceConfigPath(charId) {
  const voiceName = getCharacterVoiceName(charId);
  if (!voiceName) return null;
  const voice = scanVoices().find(v => v.name === voiceName);
  if (!voice) return null;
  const cfgPath = path.join(voice.voice_dir, 'config.json');
  return fs.existsSync(cfgPath) ? cfgPath : null;
}

// 检查角色是否有语音（新架构：voices/<name>/config.json 存在）
function hasVoice(charId) {
  return !!getVoiceConfigPath(charId);
}

// 读取角色voice配置（新架构）
function readVoiceConfig(charId) {
  const cfgPath = getVoiceConfigPath(charId);
  if (!cfgPath) return null;
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ============================================================
// 角色专属语音微调覆盖 — 按角色ID隔离，不影响其他角色
// 基础配置来自 voices/<voiceName>/config.json（语音模型本身参数）
// 角色覆盖存储在 character/<id>/voice_tuning.json
// 合成时合并两者：角色覆盖 > 基础配置
// ============================================================
function getCharacterTuningPath(charId) {
  const charDir = path.join(CHARACTER_DIR, String(charId));
  return path.join(charDir, 'voice_tuning.json');
}

function readCharacterTuning(charId) {
  const tuningPath = getCharacterTuningPath(charId);
  try {
    if (fs.existsSync(tuningPath)) {
      return JSON.parse(fs.readFileSync(tuningPath, 'utf-8'));
    }
  } catch (e) { console.error('[VoiceTuning] 读取角色覆盖失败:', e.message); }
  return null;
}

function writeCharacterTuning(charId, tuning) {
  const tuningPath = getCharacterTuningPath(charId);
  const charDir = path.dirname(tuningPath);
  if (!fs.existsSync(charDir)) {
    fs.mkdirSync(charDir, { recursive: true });
  }
  writeJsonAtomic(tuningPath, tuning);
}

// 合并语音库基础配置 + 角色专属覆盖
function readMergedVoiceConfig(charId) {
  const baseCfg = readVoiceConfig(charId);
  if (!baseCfg) return null;
  const charTuning = readCharacterTuning(charId);
  if (!charTuning) return sanitizeTuningConfig(baseCfg);

  // 深拷贝基础配置
  const merged = JSON.parse(JSON.stringify(baseCfg));

  // 全局覆盖字段
  const globalKeys = [
    'globalSpeedOffset', 'globalPitchOffset', 'globalTempOffset',
    'globalPauseOffset', 'globalEndingOffset', 'globalSoftOffset',
    'globalVolumeOffset', 'globalFadeIn', 'defaultEmotion',
  ];
  for (const key of globalKeys) {
    if (charTuning[key] !== undefined) {
      merged[key] = charTuning[key];
    }
  }

  // emotion_profiles 按字段覆盖（不整体替换，保留基础配置的desc等元数据）
  if (charTuning.emotion_profiles && merged.emotion_profiles) {
    for (const [emoId, overrides] of Object.entries(charTuning.emotion_profiles)) {
      if (!merged.emotion_profiles[emoId]) continue;
      if (overrides.temperature !== undefined) merged.emotion_profiles[emoId].temperature = overrides.temperature;
      if (overrides.top_p !== undefined) merged.emotion_profiles[emoId].top_p = overrides.top_p;
      if (overrides.speed !== undefined) merged.emotion_profiles[emoId].speed = overrides.speed;
      if (overrides.intensity !== undefined) merged.emotion_profiles[emoId].intensity = overrides.intensity;
      if (overrides.pause_style !== undefined) merged.emotion_profiles[emoId].pause_style = overrides.pause_style;
    }
  }

  return sanitizeTuningConfig(merged);
}

// 检查TTS服务是否可用（30秒缓存，避免每次合成都多3秒延迟）
let _ttsStatusCache = { ok: false, ts: 0 };

// 语音合成结果缓存：文本+语音名 → 本地音频URL
// F5 刷新后同文本不复合成，直接返回已有文件
// 持久化到磁盘：服务器重启后也能恢复 text→filename 映射
const _voiceCache = new Map();          // key: `${sha256(text)}_${voiceName}`, val: filename
// Keep enough lightweight text→file mappings to cover the largest supported
// per-character audio retention setting (100). The WAV files remain governed
// by the character-specific cache limit; this map only prevents a restart from
// losing the lookup needed to show the green playable microphone.
const MAX_VOICE_CACHE = 200;
const VOICE_CACHE_FILE = path.join(DATA_DIR, 'voice_cache.json');
// 与调音参数解耦的持久化索引。旧的 voice_cache.json 只保存哈希键，
// 调整 voice_tuning.json 后哈希会变化，导致磁盘里的 WAV 仍在但页面无法恢复。
// manifest 保存“角色 + 语音 + 清理后的文本 → 文件”，调音参数改变不会使已有 WAV 失效。
const VOICE_CACHE_MANIFEST_FILE = path.join(DATA_DIR, 'voice_cache_manifest.json');
const _voiceCacheManifest = new Map();

function _voiceManifestText(text) {
  return stripStageDirections(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function _voiceManifestKey(charId, voiceName, text) {
  return `${String(charId || '')}|${String(voiceName || 'default')}|${_voiceManifestText(text)}`;
}

function _loadVoiceCacheManifest() {
  try {
    if (!fs.existsSync(VOICE_CACHE_MANIFEST_FILE)) return;
    const data = JSON.parse(fs.readFileSync(VOICE_CACHE_MANIFEST_FILE, 'utf8'));
    const entries = Array.isArray(data) ? data : Object.values(data || {});
    for (const entry of entries) {
      if (!entry || !entry.filename || !entry.text) continue;
      const localPath = resolveVoiceAudioPath(path.basename(entry.filename));
      if (!localPath) continue;
      const key = _voiceManifestKey(entry.charId || '1', entry.voiceName, entry.text);
      _voiceCacheManifest.set(key, {
        charId: String(entry.charId || '1'),
        voiceName: String(entry.voiceName || 'default'),
        text: _voiceManifestText(entry.text),
        filename: path.basename(entry.filename),
        emotion: entry.emotion || '',
        createdAt: Number(entry.createdAt) || 0,
      });
    }
    console.log(`[Voice] 从持久化索引恢复 ${_voiceCacheManifest.size} 条文本语音映射`);
  } catch (e) {
    console.error('[Voice] 加载语音文本索引失败:', e.message);
  }
}

function _saveVoiceCacheManifest() {
  try {
    const entries = [..._voiceCacheManifest.values()]
      .filter(entry => entry && entry.filename && resolveVoiceAudioPath(entry.filename))
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      .slice(0, 500);
    writeJsonAtomic(VOICE_CACHE_MANIFEST_FILE, entries);
  } catch (e) {
    console.error('[Voice] 保存语音文本索引失败:', e.message);
  }
}

function _setVoiceManifest(text, voiceName, filename, metadata = {}) {
  const cleanText = _voiceManifestText(text);
  if (!cleanText || !filename) return;
  const inferredCharId = metadata.charId
    || String(filename).match(/^char([^_]+)_/)?.[1]
    || getCurrentCharacterId();
  const entry = {
    charId: String(inferredCharId || '1'),
    voiceName: String(voiceName || 'default'),
    text: cleanText,
    filename: path.basename(filename),
    emotion: String(metadata.emotion || '').trim(),
    createdAt: Number(metadata.createdAt) || Date.now(),
  };
  _voiceCacheManifest.set(_voiceManifestKey(entry.charId, entry.voiceName, cleanText), entry);
  _saveVoiceCacheManifest();
}

function _getManifestCachedAudio(text, voiceName, charId) {
  const key = _voiceManifestKey(charId, voiceName, text);
  const entry = _voiceCacheManifest.get(key);
  if (!entry) return null;
  const filename = path.basename(entry.filename || '');
  const localPath = resolveVoiceAudioPath(filename);
  if (!filename || !localPath) {
    _voiceCacheManifest.delete(key);
    _saveVoiceCacheManifest();
    return null;
  }
  return {
    success: true,
    audioUrl: `/api/voice/audio/${filename}`,
    emotion: entry.emotion || undefined,
    duration: null,
    cached: true,
  };
}

_loadVoiceCacheManifest();

// 一次性兼容旧版本：旧索引只有哈希，无法从键反推出文本；但旧 TTS 日志仍
// 保存 raw_text，且最终 WAV 的修改时间与日志时间接近。仅在 manifest 为空、
// 且能在当前历史中找到“唯一最近文件”时迁移，无法确认归属的文件绝不乱绑定。
function _migrateLegacyVoiceManifest() {
  if (_voiceCacheManifest.size > 0) return;
  try {
    const charId = getCurrentCharacterId();
    const historyFile = path.join(DATA_DIR, `${charId}_chat_history.json`);
    const logFile = path.join(APP_DATA_ROOT, 'logs', 'tts_generation.log');
    if (!fs.existsSync(historyFile) || !fs.existsSync(logFile)) return;
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    const assistantTexts = [...new Set((Array.isArray(history) ? history : [])
      .filter(item => item?.role === 'assistant' && item.content)
      .map(item => _voiceManifestText(item.content))
      .filter(Boolean))];
    if (!assistantTexts.length) return;
    const logs = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).map(line => {
      try {
        const item = JSON.parse(line);
        if (!item?.raw_text || !item?.timestamp) return null;
        return {
          text: _voiceManifestText(item.raw_text),
          emotion: String(item.emotion || ''),
          ms: Date.parse(String(item.timestamp).replace(' ', 'T') + '+08:00'),
        };
      } catch (_) { return null; }
    }).filter(item => item && Number.isFinite(item.ms) && assistantTexts.includes(item.text));
    if (!logs.length || !fs.existsSync(VOICE_OUTPUT_DIR)) return;
    const files = fs.readdirSync(VOICE_OUTPUT_DIR)
      .filter(name => name.startsWith(`char${charId}_`) && name.endsWith('.wav'))
      .map(name => {
        const stat = fs.statSync(path.join(VOICE_OUTPUT_DIR, name));
        const emotion = String(name.match(new RegExp(`^char${charId}_([^_]+)_`))?.[1] || '');
        return { name, emotion, ms: stat.mtimeMs, used: false };
      });
    let migrated = 0;
    for (const text of assistantTexts) {
      const candidates = logs.filter(item => item.text === text)
        .flatMap(item => files
          .filter(file => !file.used && (!item.emotion || file.emotion === item.emotion))
          .map(file => ({ item, file, delta: Math.abs(file.ms - item.ms) })))
        .sort((a, b) => a.delta - b.delta);
      const best = candidates[0];
      // 日志只有秒精度，允许少量复制/落盘延迟；不确定的文件跳过。
      if (!best || best.delta > 15000) continue;
      best.file.used = true;
      _setVoiceManifest(text, getCharacterVoiceName(charId) || 'default', best.file.name, {
        charId,
        emotion: best.item.emotion || best.file.emotion,
        createdAt: best.file.ms,
      });
      migrated++;
    }
    if (migrated > 0) console.log(`[Voice] 兼容迁移 ${migrated} 条旧语音文本索引（仅关联仍存在的 WAV）`);
  } catch (e) {
    console.warn('[Voice] 旧语音索引迁移跳过:', e.message);
  }
}

_migrateLegacyVoiceManifest();

function _getVoiceCacheKey(text, voiceName, variant = 'default') {
  return buildVoiceCacheKeys({
    text,
    voiceName,
    variant,
    flavor: runtimeFlavor.flavor,
    modelVersion: runtimeFlavor.modelVersion,
  }, false)[0];
}

// 从磁盘加载缓存（服务器启动时调用）
function _loadVoiceCacheFromDisk() {
  try {
    if (fs.existsSync(VOICE_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(VOICE_CACHE_FILE, 'utf-8'));
      let restored = 0;
      for (const [key, filename] of Object.entries(data)) {
        // 仅恢复文件仍存在的条目
        const localPath = path.join(VOICE_OUTPUT_DIR, filename);
        if (fs.existsSync(localPath)) {
          _voiceCache.set(key, filename);
          restored++;
        }
      }
      let trimmed = 0;
      while (_voiceCache.size > MAX_VOICE_CACHE) {
        const oldest = _voiceCache.keys().next().value;
        if (!oldest) break;
        _voiceCache.delete(oldest);
        trimmed++;
      }
      if (trimmed > 0) _saveVoiceCacheToDisk();
      console.log(`[Voice] 从磁盘恢复 ${restored} 条语音缓存`);
    }
  } catch (e) {
    console.error('[Voice] 加载磁盘缓存失败:', e.message);
  }
}

// 保存缓存到磁盘
function _saveVoiceCacheToDisk() {
  try {
    const obj = Object.fromEntries(_voiceCache);
    fs.writeFileSync(VOICE_CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[Voice] 保存磁盘缓存失败:', e.message);
  }
}

// 启动时加载磁盘缓存
_loadVoiceCacheFromDisk();
// 启动时也检查一次当前角色的缓存上限。
cleanupVoiceCache(getCurrentCharacterId());

function _getCachedAudioUrl(text, voiceName, variant = 'default', options = {}) {
  const keys = options.allowCompatibleVersions
    ? buildVoiceCacheKeys({
      text,
      voiceName,
      variant,
      flavor: runtimeFlavor.flavor,
      modelVersion: runtimeFlavor.modelVersion,
    }, true)
    : [_getVoiceCacheKey(text, voiceName, variant)];
  let dirty = false;
  for (const key of keys) {
    const filename = _voiceCache.get(key);
    if (!filename) continue;
    const localPath = resolveVoiceAudioPath(filename);
    if (localPath) return `/api/voice/audio/${filename}`;
    _voiceCache.delete(key);
    dirty = true;
  }
  if (dirty) _saveVoiceCacheToDisk();
  return null;
}

function _setVoiceCache(text, voiceName, filename, variant = 'default', metadata = {}) {
  const key = _getVoiceCacheKey(text, voiceName, variant);
  _voiceCache.set(key, filename);
  // 限制缓存大小
  if (_voiceCache.size > MAX_VOICE_CACHE) {
    const first = _voiceCache.keys().next().value;
    _voiceCache.delete(first);
  }
  _saveVoiceCacheToDisk();
  _setVoiceManifest(text, voiceName, filename, metadata);
}

function _buildVoiceCacheVariant(charId, emotion, tuningCfg, requestBody = {}) {
  const directKeys = [
    'speed_offset', 'pitch_offset', 'temp_offset', 'pause_offset',
    'ending_offset', 'soft_offset', 'volume_offset', 'fadein', 'intensity',
  ];
  const direct = {};
  for (const key of directKeys) {
    if (requestBody[key] !== undefined) direct[key] = requestBody[key];
  }
  const global = {};
  for (const key of [
    'globalSpeedOffset', 'globalPitchOffset', 'globalTempOffset', 'globalPauseOffset',
    'globalEndingOffset', 'globalSoftOffset', 'globalVolumeOffset', 'globalFadeIn',
  ]) {
    if (tuningCfg?.[key] !== undefined) global[key] = tuningCfg[key];
  }
  const safeConfig = tuningCfg ? sanitizeTuningConfig(tuningCfg) : null;
  const safeDirect = sanitizeEngineParams({ emotion: emotion || 'auto', ...direct });
  const profile = safeConfig?.emotion_profiles?.[emotion] || safeConfig?.emotions?.[emotion] || null;
  const emphasis = replyPerformancePolicy.normalizeEmphasis(
    requestBody.emphasis,
    requestBody.text || '',
  );
  const segments = replyPerformancePolicy.normalizePerformanceSegments(
    requestBody.segments,
    requestBody.text || '',
    { confidence: 1, evidence: 'validated API performance segment', inference: 'explicit' },
  );
  return JSON.stringify({
    v: 4,
    voiceIdentityPolicy: VOICE_IDENTITY_POLICY_VERSION,
    charId: String(charId),
    emotion: emotion || 'auto',
    global: safeConfig ? {
      globalSpeedOffset: safeConfig.globalSpeedOffset,
      globalPitchOffset: safeConfig.globalPitchOffset,
      globalTempOffset: safeConfig.globalTempOffset,
      globalPauseOffset: safeConfig.globalPauseOffset,
      globalEndingOffset: safeConfig.globalEndingOffset,
      globalSoftOffset: safeConfig.globalSoftOffset,
      globalVolumeOffset: safeConfig.globalVolumeOffset,
      globalFadeIn: safeConfig.globalFadeIn,
    } : global,
    profile,
    emphasis,
    segments,
    direct: safeDirect,
  });
}

// Build the semantic plan that belongs to the exact WAV returned by this
// endpoint.  The request may contain a richer chat performance object, while
// the TTS engine can resolve `auto` to a concrete voice emotion.  Returning
// this normalized plan lets the chat window and Avatar use the same emotion,
// intent, emphasis and phrase turns after both cache hits and fresh synthesis.
function _buildPlaybackPerformancePlan(text, requestBody = {}, actualVoiceEmotion, emphasis = [], segments = []) {
  const normalizeVoice = value => {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (replyPerformancePolicy.VOICE_EMOTIONS.has(normalized)) return normalized;
    return ({
      warm: 'gentle', calm: 'gentle', soft: 'gentle',
      comforting: 'comfort', reassuring: 'comfort',
      sorrow: 'sad', melancholy: 'sad',
      questioning: 'question', curious: 'question',
      firm: 'strong', assertive: 'strong',
      enthusiastic: 'excited', 'shy-happy': 'shy_happy', shy: 'shy_happy',
    })[normalized] || '';
  };
  const resolvedVoice = normalizeVoice(actualVoiceEmotion)
    || normalizeVoice(requestBody.voiceEmotion || requestBody.voice_emotion)
    || normalizeVoice(requestBody.emotion);
  const raw = {
    voice_emotion: resolvedVoice || undefined,
    performance_emotion: requestBody.performanceEmotion || requestBody.performance_emotion,
    intent: requestBody.intent,
    gaze: requestBody.gaze,
    intensity: requestBody.intensity,
    confidence: requestBody.confidence,
    emphasis,
    segments,
    // This is an explicit, already-authorized plan from the same request/WAV.
    inference: 'explicit',
    evidence: '同一语音请求的统一表现计划',
  };
  return replyPerformancePolicy.normalizeReplyPerformance(raw, text);
}

const _voiceRequestResults = new Map();
const VOICE_REQUEST_RESULT_TTL_MS = 10 * 60 * 1000;
const MAX_VOICE_REQUEST_RESULTS = 64;
// 同一回复可能同时从聊天页和桌宠同步链路请求语音。Python worker 虽然有
// 推理锁，但仅串行会让第二个请求再完整跑一遍模型。按“实际合成参数”
// 合并在途请求：第一个请求完成后，其他请求复用同一份上游音频结果。
const _voiceSynthesisInflight = new Map();

// TTS 推理按“回复组”调度：不同回复严格 FIFO；同一回复的句段可以
// 同时提交，让首段完成后先播放，后段继续准备。底层 Python worker
// 仍自行保护模型线程安全；这里不改变模型、音色或情感参数。
const _voiceSynthesisQueue = [];
let _voiceSynthesisActiveGroup = null;
let _voiceSynthesisActiveCount = 0;
let _voiceSynthesisGroupCounter = 0;

function _startVoiceSynthesisItem(item) {
  _voiceSynthesisActiveCount++;
  Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
    _voiceSynthesisActiveCount--;
    if (_voiceSynthesisActiveCount === 0) _voiceSynthesisActiveGroup = null;
    _drainVoiceSynthesisQueue();
  });
}

function _drainVoiceSynthesisQueue() {
  if (_voiceSynthesisActiveGroup === null) {
    const first = _voiceSynthesisQueue.shift();
    if (!first) return;
    _voiceSynthesisActiveGroup = first.groupKey;
    _startVoiceSynthesisItem(first);
  }
  // Drain every currently queued item from the same reply group. A later
  // reply remains queued until all active segments of this group finish.
  for (let i = _voiceSynthesisQueue.length - 1; i >= 0; i--) {
    if (_voiceSynthesisQueue[i].groupKey !== _voiceSynthesisActiveGroup) continue;
    const item = _voiceSynthesisQueue.splice(i, 1)[0];
    _startVoiceSynthesisItem(item);
  }
}

function _enqueueVoiceSynthesis(task, groupId = null) {
  const groupKey = groupId || `__single_${++_voiceSynthesisGroupCounter}`;
  return new Promise((resolve, reject) => {
    _voiceSynthesisQueue.push({ task, resolve, reject, groupKey });
    _drainVoiceSynthesisQueue();
  });
}

function _pruneVoiceRequestResults(now = Date.now()) {
  for (const [requestId, entry] of _voiceRequestResults) {
    if (!entry || now - entry.ts > VOICE_REQUEST_RESULT_TTL_MS) {
      _voiceRequestResults.delete(requestId);
    }
  }
}

function _getVoiceRequestResult(requestId) {
  if (!requestId) return null;
  const entry = _voiceRequestResults.get(String(requestId));
  if (!entry || Date.now() - entry.ts > VOICE_REQUEST_RESULT_TTL_MS) {
    _voiceRequestResults.delete(String(requestId));
    return null;
  }
  const filename = entry.result?.audioUrl ? path.basename(entry.result.audioUrl) : '';
  if (!filename || !resolveVoiceAudioPath(filename)) {
    _voiceRequestResults.delete(String(requestId));
    return null;
  }
  return entry.result;
}

function _setVoiceRequestResult(requestId, result) {
  if (!requestId || !result?.success) return;
  _pruneVoiceRequestResults();
  _voiceRequestResults.set(String(requestId), { ts: Date.now(), result });
  if (_voiceRequestResults.size > MAX_VOICE_REQUEST_RESULTS) {
    const oldest = _voiceRequestResults.keys().next().value;
    _voiceRequestResults.delete(oldest);
  }
}

function validateWavFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 512) return { ok: false, reason: `文件过小(${stat.size}B)` };
    const readSize = Math.min(stat.size, 1024 * 1024);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buffer, 0, readSize, 0); } finally { fs.closeSync(fd); }
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false, reason: '缺少RIFF/WAVE文件头' };
    }
    let offset = 12;
    let format = null;
    let dataStart = -1;
    let declaredDataSize = 0;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'fmt ' && size >= 16 && offset + 24 <= buffer.length) {
        format = { codec: buffer.readUInt16LE(offset + 8), bits: buffer.readUInt16LE(offset + 22) };
      }
      if (id === 'data') {
        dataStart = offset + 8;
        declaredDataSize = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (dataStart < 0 || declaredDataSize < 256) return { ok: false, reason: 'WAV缺少有效data区' };
    if (format?.codec === 1 && format.bits === 16) {
      const available = Math.min(declaredDataSize, buffer.length - dataStart);
      const samples = Math.floor(available / 2);
      if (samples < 128) return { ok: false, reason: 'PCM采样点不足' };
      let sumSq = 0;
      let clipped = 0;
      for (let i = 0; i < samples; i++) {
        const sample = buffer.readInt16LE(dataStart + i * 2);
        sumSq += sample * sample;
        if (Math.abs(sample) >= 32760) clipped++;
      }
      const rms = Math.sqrt(sumSq / samples) / 32768;
      const clipRatio = clipped / samples;
      if (rms < 0.001) return { ok: false, reason: `疑似全静音(RMS=${rms.toFixed(5)})` };
      if (clipRatio > 0.08) return { ok: false, reason: `严重削波(${(clipRatio * 100).toFixed(1)}%)` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}
async function readTtsServiceSnapshot(force = false) {
  if (!force && Date.now() - _ttsStatusCache.ts < 30000 && _ttsStatusCache.snapshot) {
    return _ttsStatusCache.snapshot;
  }
  try {
    const [r, deviceResponse] = await Promise.all([
      axios.get(`${TTS_API_URL}/status`, { timeout: 3000, httpAgent: ttsAgent }),
      axios.get(`${TTS_API_URL}/device`, { timeout: 3000, httpAgent: ttsAgent }).catch(() => null),
    ]);
    const liveStatus = {
      ...(r.data || {}),
      device: deviceResponse?.data?.device || r.data?.device,
    };
    const snapshot = classifyTtsService({
      status: liveStatus,
      expectedDevice: _ttsDevice || runtimeFlavor.expectedDevice,
      flavor: runtimeFlavor.flavor,
      ownership: readOwnershipRecord(TTS_OWNERSHIP_FILE),
    });
    snapshot.status = liveStatus;
    _ttsStatusCache = { ok: snapshot.ttsAvailable, ts: Date.now(), snapshot };
    return snapshot;
  } catch {
    const snapshot = classifyTtsService({
      status: null,
      expectedDevice: _ttsDevice || runtimeFlavor.expectedDevice,
      flavor: runtimeFlavor.flavor,
      ownership: readOwnershipRecord(TTS_OWNERSHIP_FILE),
    });
    _ttsStatusCache = { ok: false, ts: Date.now(), snapshot };
    return snapshot;
  }
}

async function checkTTSAvailable(force = false) {
  return (await readTtsServiceSnapshot(force)).ttsAvailable;
}

// 语音状态接口
app.get('/api/voice/status', async (req, res) => {
  try {
    const charId = req.query.charId ? String(req.query.charId) : getCurrentCharacterId();
    const has = hasVoice(charId);
    const service = await readTtsServiceSnapshot();
    const ttsAvailable = service.ttsAvailable;

    // Auto-started GPU services warm on the first status poll as well as the
    // explicit start path. The controller de-duplicates by service instance.
    if (ttsAvailable && service.actualDevice === 'gpu') {
      void ttsWarmup.warm({
        device: service.actualDevice,
        instanceId: String(service.status?.instance_id || service.status?.pid || ''),
        voiceName: getCharacterVoiceName(charId),
        serviceStatus: service.status,
      });
    }

    const result = {
      success: true,
      hasVoice: has,
      ttsAvailable: ttsAvailable,
      canSpeak: has && ttsAvailable,
      device: service.actualDevice || _ttsDevice || runtimeFlavor.expectedDevice,
      desiredDevice: _ttsDevice || runtimeFlavor.expectedDevice,
      serviceReachable: service.serviceReachable,
      deviceMismatch: service.deviceMismatch,
      flavorMismatch: service.flavorMismatch,
      owned: service.owned,
      errorCode: service.deviceMismatch ? 'DEVICE_MISMATCH' : (service.flavorMismatch ? 'FLAVOR_MISMATCH' : null),
      flavor: runtimeFlavor.flavor,
      expectedDevice: runtimeFlavor.expectedDevice,
      allowDeviceSwitch: runtimeFlavor.allowDeviceSwitch,
      availableDevices: runtimeFlavor.availableDevices,
    };

    if (has) {
      const cfg = readMergedVoiceConfig(charId);
      result.characterName = cfg?.characterName || '';
      result.defaultEmotion = cfg?.defaultEmotion || 'auto';
      // 兼容 emotion_profiles（标准）和 emotions（旧版）两种字段名
      const profiles = cfg?.emotion_profiles || cfg?.emotions || {};
      result.emotions = Object.entries(profiles).map(([id, v]) => ({
        id,
        desc: v.desc,
        characterNote: v.characterNote,
      }));
    }

    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 轻量运行时身份端点：不导入 Torch，供 Electron 判断 3003（ChatX2）端口上的服务
// 是否属于当前 CPU/GPU 版本，避免两套发布包互相误连。
// [CHAT6-COMPAT] 此端点为 Chat5Adapter.healthCheck() 调用的端点。
app.get('/api/runtime', (req, res) => {
  res.json({
    success: true,
    owner: 'wha1999',
    flavor: runtimeFlavor.flavor,
    expectedDevice: runtimeFlavor.expectedDevice,
    modelVersion: runtimeFlavor.modelVersion,
  });
});

// ★ 设备自检端点：使用 runtimeFlavor.pythonExe 检查包内 Python 环境
app.get('/api/voice/device-check', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    let torchInfo = { torch: 'unknown', cudaAvailable: false, gpuName: null };
    try {
      const raw = execSync(`"${runtimeFlavor.pythonExe}" -c "import torch,json; print(json.dumps({'torch':torch.__version__,'cudaAvailable':torch.cuda.is_available(),'gpuName':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))"`, { encoding: 'utf-8', timeout: 15000 });
      torchInfo = JSON.parse(raw.trim());
    } catch (e) {
      torchInfo.torch = 'import failed: ' + e.message;
    }
    res.json({
      success: true,
      flavor: runtimeFlavor.flavor,
      expectedDevice: runtimeFlavor.expectedDevice,
      allowDeviceSwitch: runtimeFlavor.allowDeviceSwitch,
      torch: torchInfo.torch,
      cudaAvailable: torchInfo.cudaAvailable,
      gpuName: torchInfo.gpuName,
      pythonExe: runtimeFlavor.pythonExe,
      ttsScript: runtimeFlavor.ttsScript,
      voicesDir: runtimeFlavor.voicesDir,
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 启动TTS语音服务（从网页端触发）
let _ttsProcess = null;
// TTS 合成设备：'gpu' / 'cpu' / null（未知，默认按 inference_webui.py 的 is_half=True→GPU）
let _ttsDevice = null;
// ★ 使用 runtimeFlavor 指定的路径（发布包内 tts_engine_cpu/gpu/selina_tts_api.py）
const TTS_ENGINE_PATH = runtimeFlavor.ttsScript;
const TTS_ENGINE_FALLBACK_PATH = null; // 不再使用 fallback，路径由 runtimeFlavor 决定
let _ttsStartInProgress = false;

async function terminateTrackedTTSProcess(reason = 'cleanup') {
  const child = _ttsProcess;
  if (!child || child.killed || !child.pid) {
    _ttsProcess = null;
    return false;
  }
  try {
    require('child_process').execFileSync('taskkill', ['/F', '/PID', String(child.pid), '/T'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (e) {
    try { child.kill(); } catch (ignore) {}
  }
  if (_ttsProcess === child) _ttsProcess = null;
  const ownership = readOwnershipRecord(TTS_OWNERSHIP_FILE);
  clearOwnershipRecord(TTS_OWNERSHIP_FILE, ownership?.instanceId || null);
  _ttsStatusCache = { ok: false, ts: 0, snapshot: null };
  console.warn(`[TTS] 已停止本应用跟踪的异常进程 pid=${child.pid} reason=${reason}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  return true;
}

app.post('/api/voice/start', async (req, res) => {
  if (_ttsStartInProgress) {
    return res.json({
      success: false,
      errorCode: 'TTS_START_IN_PROGRESS',
      error: '语音服务正在由另一个请求启动，请稍候',
      retryable: true,
    });
  }
  _ttsStartInProgress = true;
  try {
    // 使用用户选择的设备（如果已切换），否则使用默认设备
    const effectiveDevice = _ttsDevice || runtimeFlavor.expectedDevice;
    _ttsDevice = effectiveDevice;

    // 根据所选设备获取正确的 pythonExe 路径
    const effectivePythonExe = effectiveDevice === 'gpu' ? runtimeFlavor.gpuPythonExe : runtimeFlavor.cpuPythonExe;
    const effectiveIsHalf = effectiveDevice === 'gpu';

    // 只复用由当前 ChatX2 实例启动、设备和 flavor 均匹配的服务。
    const existingService = await readTtsServiceSnapshot(true);
    if (existingService.serviceReachable) {
      if (existingService.reusable) {
        _ttsDevice = existingService.actualDevice;
        _ttsStatusCache = { ok: true, ts: Date.now(), snapshot: existingService };
        console.log('[TTS] 复用当前应用拥有的健康实例');
        void ttsWarmup.warm({
          device: _ttsDevice,
          instanceId: String(existingService.status?.instance_id || existingService.status?.pid || 'reused-gpu'),
          voiceName: getCharacterVoiceName(getCurrentCharacterId()),
          serviceStatus: existingService.status,
        });
        return res.json({
          success: true,
          message: 'TTS服务已在运行',
          ttsAvailable: true,
          device: _ttsDevice,
          reused: true,
          killedBefore: 0,
        });
      }
      return res.json({
        success: false,
        errorCode: existingService.deviceMismatch
          ? 'DEVICE_MISMATCH'
          : (existingService.flavorMismatch ? 'FLAVOR_MISMATCH' : 'UNOWNED_TTS_PROCESS'),
        error: existingService.deviceMismatch
          ? `端口9882已有${String(existingService.actualDevice || '未知').toUpperCase()}语音服务，与当前${effectiveDevice.toUpperCase()}版本不一致`
          : '端口9882上的语音服务不属于当前 ChatX2 实例，已拒绝复用',
      });
    }

    // 只清理由本应用启动且仍被跟踪的异常进程，绝不结束未知端口进程。
    if (_ttsProcess && !_ttsProcess.killed) {
      await terminateTrackedTTSProcess('unhealthy-before-restart');
    }

    if (!fs.existsSync(effectivePythonExe)) {
      return res.json({ success: false, errorCode: 'PYTHON_MISSING', error: '发布包内置 Python 运行时缺失' });
    }

    const memoryStatus = getSystemMemoryStatus(effectiveDevice);
    let nvidiaProbe = null;
    let resourceStatus = buildResourceStatus(memoryStatus);

    if (effectiveDevice === 'gpu') {
      nvidiaProbe = probeNvidiaGpu();
      resourceStatus = buildResourceStatus(memoryStatus, nvidiaProbe.gpu);
      if (!nvidiaProbe.ok) {
        // Resource probes are diagnostics only.  nvidia-smi can be missing or
        // blocked by a security tool even when the CUDA runtime can load; let
        // the TTS process make the authoritative GPU check after launch.
        console.warn(`[TTS] GPU探针未通过，仍尝试启动：${nvidiaProbe.error || nvidiaProbe.errorCode}`);
      }
    }

    // RAM is also diagnostic-only.  Windows' os.freemem() excludes reclaimable
    // cache and may briefly report a low value during Electron/model startup.
    // Do not prevent the user from opening voice; the child process and its
    // readiness endpoint remain the source of truth.
    if (memoryStatus.freeMB < memoryStatus.recommendedMB) {
      console.warn(`[TTS] RAM探针低于建议值，仍尝试启动：free=${memoryStatus.freeMB}MB recommended=${memoryStatus.recommendedMB}MB`);
    }

    // 不结束未知进程。健康检查失败但端口仍被占用时，明确报告冲突。
    const portOccupied = await new Promise((resolve) => {
      const socket = require('net').createConnection({ host: '127.0.0.1', port: 9882 });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    if (portOccupied) {
      return res.json({ success: false, errorCode: 'PORT_IN_USE', error: '端口 9882 已被其他程序占用' });
    }
    const killedBefore = 0;
    _ttsProcess = null;

    // 如果已有进程但已退出，清理
    if (_ttsProcess && _ttsProcess.killed) {
      _ttsProcess = null;
    }

    // ★ 查找TTS引擎脚本（路径由 runtimeFlavor 决定，不再使用外部 fallback）
    const { spawn } = require('child_process');
    let scriptPath = null;
    let cwd = null;

    if (fs.existsSync(TTS_ENGINE_PATH)) {
      scriptPath = TTS_ENGINE_PATH;
      cwd = path.dirname(TTS_ENGINE_PATH);
    } else {
      return res.json({
        success: false,
        errorCode: 'TTS_SCRIPT_MISSING',
        error: '未找到 TTS 引擎脚本',
        detail: `路径: ${TTS_ENGINE_PATH}（由 runtimeFlavor.ttsScript 指定）`
      });
    }

    // 启动TTS服务并保留父子进程关系，避免 Express 重启后遗留失控进程。
    // 必须通过 run_patched.py 启动：注入假 librosa 模块避免 numba/torch 死锁
    const runPatchedPath = path.join(cwd, 'run_patched.py');
    const useRunPatched = fs.existsSync(runPatchedPath);
    const args = useRunPatched ? [runPatchedPath, scriptPath] : [scriptPath];
    if (useRunPatched) {
      console.log('[TTS] 使用 run_patched.py 启动（假 librosa 注入）');
    }
    // ★ GPU 版：根据 runtimeFlavor.isHalf 决定 fp16/fp32
    // ★ PYTHONNOUSERSITE=1：禁止搜索用户目录，避免用户目录下不完整的 boto3（缺 jmespath）
    //   导致 accelerate 导入链断裂 → TTS 500 错误
    const instanceId = require('crypto').randomUUID();
    const childEnv = {
      ...process.env,
      is_half: effectiveIsHalf ? 'True' : 'False',
      TTS_DEVICE: effectiveDevice === 'gpu' ? 'cuda' : 'cpu',
      CHAT5_FLAVOR: runtimeFlavor.flavor,
      CHAT5_EXPECTED_DEVICE: effectiveDevice,
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      APP_ROOT: __dirname,
      APP_DATA_DIR: APP_DATA_ROOT,
      GPT_SOVITS_ROOT: runtimeFlavor.gptSoVitsRoot,
      BUNDLED_VOICES_DIR: runtimeFlavor.voicesDir,
      USER_VOICES_DIR,
      CHARACTER_DIR,
      TTS_OUTPUT_DIR: VOICE_OUTPUT_DIR,
      TTS_LOG_DIR: path.join(APP_DATA_ROOT, 'logs'),
      TTS_HOST: '127.0.0.1',
      TTS_PORT: '9882',
      TTS_INSTANCE_ID: instanceId,
      // fast_langdetect 大模型缓存目录：指向包内自带的 lid.176.bin，
      // 避免 %TEMP% 被清理后每次合成都重新下载 125MB 模型。
      FTLANG_CACHE: path.join(runtimeFlavor.gptSoVitsRoot, 'GPT_SoVITS', 'pretrained_models', 'fast_langdetect'),
      // 让 Python 启动预热直接使用当前角色声音，避免先加载排序第一的声音
      // 再由 Node 为当前角色重复合成一次。
      TTS_DEFAULT_VOICE_NAME: getCharacterVoiceName(getCurrentCharacterId()) || '',
    };
    console.log(`[TTS] 启动设备: ${effectiveIsHalf ? 'gpu' : 'cpu'} (is_half=${effectiveIsHalf}, python=${effectivePythonExe})`);
    const ttsLogDir = path.join(APP_DATA_ROOT, 'logs');
    fs.mkdirSync(ttsLogDir, { recursive: true });
    const ttsLogPath = path.join(ttsLogDir, 'tts-service.log');
    try {
      if (fs.existsSync(ttsLogPath) && fs.statSync(ttsLogPath).size > 5 * 1024 * 1024) {
        const rotated = `${ttsLogPath}.1`;
        if (fs.existsSync(rotated)) fs.rmSync(rotated, { force: true });
        fs.renameSync(ttsLogPath, rotated);
      }
    } catch (e) { console.warn('[TTS] 日志轮转失败:', e.message); }
    const ttsLogFd = fs.openSync(ttsLogPath, 'a');
    const child = spawn(effectivePythonExe, args, {
      cwd,
      detached: false,
      stdio: ['ignore', ttsLogFd, ttsLogFd],
      windowsHide: true,
      env: childEnv,
    });
    fs.closeSync(ttsLogFd);

    _ttsProcess = child;
    writeOwnershipRecord(TTS_OWNERSHIP_FILE, {
      schemaVersion: 1,
      instanceId,
      pid: child.pid,
      expectedDevice: effectiveDevice,
      flavor: runtimeFlavor.flavor,
      executablePath: effectivePythonExe,
      scriptPath,
      startedAt: new Date().toISOString(),
    });
    let childExit = null;
    child.once('error', (error) => {
      childExit = { code: 'SPAWN_ERROR', signal: null, message: error.message };
      if (_ttsProcess === child) _ttsProcess = null;
      clearOwnershipRecord(TTS_OWNERSHIP_FILE, instanceId);
      console.error(`[TTS] 子进程启动失败: ${error.message}，日志: ${ttsLogPath}`);
    });
    child.once('exit', (code, signal) => {
      childExit = { code, signal };
      if (_ttsProcess === child) _ttsProcess = null;
      clearOwnershipRecord(TTS_OWNERSHIP_FILE, instanceId);
      console.error(`[TTS] 子进程退出 code=${code} signal=${signal || ''}，日志: ${ttsLogPath}`);
    });
    // 等待服务启动（最多180秒，首次加载 torch + 模型权重较慢）
    let waited = 0;
    const maxWait = 180000;
    const interval = 2000;
    while (waited < maxWait) {
      await new Promise(r => setTimeout(r, interval));
      waited += interval;
      if (childExit) {
        return res.json({
          success: false,
          errorCode: 'TTS_PROCESS_EXITED',
          error: `TTS 子进程提前退出（code=${childExit.code}${childExit.message ? `, ${childExit.message}` : ''}），请查看日志`,
          logPath: ttsLogPath,
        });
      }
      const ok = await checkTTSAvailable(true);
      if (ok) {
        // ★ 校验 /status 和 /device，确认是本进程启动的实例（避免连到旧实例）
        let startupStatus = null;
        try {
          const statusResp = await axios.get(`${TTS_API_URL}/status`, { timeout: 3000, httpAgent: ttsAgent });
          const deviceResp = await axios.get(`${TTS_API_URL}/device`, { timeout: 3000, httpAgent: ttsAgent });
          startupStatus = statusResp.data || null;
          const realDevice = deviceResp.data.device === 'cpu' ? 'cpu' : 'gpu';
          console.log(`[TTS] 启动校验: device=${realDevice}, is_half=${deviceResp.data.is_half}, output_dir=${statusResp.data.output_dir}`);
          if (realDevice !== effectiveDevice) {
            try {
              require('child_process').execFileSync('taskkill', ['/F', '/PID', String(child.pid), '/T'], { windowsHide: true, stdio: 'ignore' });
            } catch (e) { try { child.kill(); } catch (e2) {} }
            _ttsProcess = null;
            return res.json({
              success: false,
              errorCode: 'DEVICE_MISMATCH',
              error: `语音服务实际启动为${realDevice.toUpperCase()}，要求${effectiveDevice.toUpperCase()}，已停止错误实例`,
            });
          }
          _ttsDevice = realDevice;
        } catch (e) {
          console.warn('[TTS] /status 或 /device 校验失败，继续使用预期设备:', e.message);
        }
        void ttsWarmup.warm({
          device: _ttsDevice,
          instanceId,
          voiceName: getCharacterVoiceName(getCurrentCharacterId()),
          serviceStatus: startupStatus,
        });
        return res.json({
          success: true,
          message: 'TTS服务已启动',
          ttsAvailable: true,
          device: _ttsDevice,
          waitedMs: waited,
          killedBefore
        });
      }
    }

    await terminateTrackedTTSProcess('startup-timeout');
    return res.json({
      success: false,
      errorCode: 'TTS_START_TIMEOUT',
      error: 'TTS服务启动超时',
      detail: '已执行启动命令但180秒内未就绪，可能是模型加载中或Python环境异常',
      logPath: ttsLogPath,
      ttsAvailable: false
    });
  } catch (error) {
    console.error('[API] 启动TTS服务失败:', error.message);
    res.json({ success: false, errorCode: 'TTS_START_INTERNAL_ERROR', error: '启动TTS服务失败: ' + error.message, retryable: true });
  } finally {
    _ttsStartInProgress = false;
  }
});

// 停止TTS语音服务（释放GPU资源）
app.post('/api/voice/stop', async (req, res) => {
  try {
    let stopped = false;

    // 1. 优先停止当前服务器明确跟踪的子进程。
    if (_ttsProcess) {
      stopped = await terminateTrackedTTSProcess('user-stop') || stopped;
    }

    // 2. 服务器重启后可能丢失ChildProcess引用；仅在/status身份完全匹配时按PID停止。
    if (!stopped) {
      let status = null;
      try {
        const statusResp = await axios.get(`${TTS_API_URL}/status`, { timeout: 2000, httpAgent: ttsAgent });
        status = statusResp.data || {};
      } catch (error) {
        // 无服务或端口未占用，按“未运行”处理。
      }
      if (status) {
        const ownership = readOwnershipRecord(TTS_OWNERSHIP_FILE);
        const owned = matchesOwnedService(ownership, status);
        if (!owned) {
          return res.json({
            success: false,
            errorCode: 'UNOWNED_TTS_PROCESS',
            error: '端口9882上的语音服务不属于当前应用，已拒绝结束该进程',
          });
        }
        try {
          require('child_process').execFileSync('taskkill', ['/F', '/PID', String(status.pid), '/T'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          stopped = true;
          clearOwnershipRecord(TTS_OWNERSHIP_FILE, ownership.instanceId);
        } catch (error) {
          return res.json({ success: false, errorCode: 'TTS_STOP_FAILED', error: '语音服务属于当前应用，但进程停止失败' });
        }
      }
    }
    _ttsStatusCache = { ok: false, ts: 0, snapshot: null };

    if (stopped) {
      // 等待端口释放
      await new Promise(r => setTimeout(r, 1500));
      _ttsDevice = null;
      res.json({ success: true, message: 'TTS服务已停止，语音推理资源已释放', ttsAvailable: false });
    } else {
      res.json({ success: true, message: 'TTS服务未在运行', ttsAvailable: false });
    }
  } catch (error) {
    console.error('[API] 停止TTS服务失败:', error.message);
    res.json({ success: false, error: '停止TTS服务失败: ' + error.message });
  }
});

// 切换TTS合成设备（仅TTS未运行时可用）
app.post('/api/voice/switch-device', async (req, res) => {
  try {
    const { device } = req.body;
    const targetDevice = String(device || '').toLowerCase() === 'gpu' ? 'gpu' : 'cpu';

    // 检查是否允许切换
    if (!runtimeFlavor.allowDeviceSwitch) {
      return res.json({ success: false, error: '当前环境不支持运行时切换设备' });
    }

    // 检查目标设备是否可用
    if (!runtimeFlavor.availableDevices.includes(targetDevice)) {
      return res.json({ success: false, error: `设备 ${targetDevice.toUpperCase()} 不可用` });
    }

    // 检查TTS是否在运行（运行中不允许切换）
    if (_ttsProcess && _ttsStatusCache.ok) {
      return res.json({ success: false, error: '请先停止语音服务再切换设备' });
    }

    // 更新设备和期望设备
    _ttsDevice = targetDevice;
    // 更新 runtimeFlavor 的 expectedDevice（通过修改环境变量方式）
    // 注意：runtimeFlavor 是通过 require 缓存的，需要清除缓存重新加载
    // 但为了简单，我们直接更新 _ttsDevice 并在下次启动时使用

    console.log(`[TTS] 设备已切换为: ${targetDevice.toUpperCase()}`);
    res.json({ success: true, device: targetDevice, message: `已切换至 ${targetDevice.toUpperCase()} 设备` });
  } catch (error) {
    console.error('[API] 切换设备失败:', error.message);
    res.json({ success: false, error: '切换设备失败: ' + error.message });
  }
});

// 合成语音
app.post('/api/voice/speak', async (req, res) => {
  try {
    const {
      text,
      emotion,
      emphasis: requestedEmphasis,
      charId: reqCharId,
      force,
      userMessage,
      includeLocalPath,
      preview,
      requestId: rawRequestId,
      replyGroupId: rawReplyGroupId,
    } = req.body;
    const isPreview = preview === true;
    const charId = reqCharId ? String(reqCharId) : getCurrentCharacterId();
    const requestId = /^[A-Za-z0-9_-]{8,120}$/.test(String(rawRequestId || '')) ? String(rawRequestId) : '';
    const replyGroupId = /^[A-Za-z0-9_-]{1,120}$/.test(String(rawReplyGroupId || ''))
      ? String(rawReplyGroupId)
      : null;
    const previousResult = _getVoiceRequestResult(requestId);
    if (previousResult) return res.json({ ...previousResult, idempotentReplay: true });

    if (!text || !text.trim()) {
      return res.json({ success: false, errorCode: 'INVALID_TEXT', error: '文本不能为空', retryable: false });
    }

    // 去除舞台指示，避免TTS朗读括号内的动作描写
    const cleanText = stripStageDirections(text);
    const emphasis = replyPerformancePolicy.normalizeEmphasis(requestedEmphasis, cleanText);
    const segments = replyPerformancePolicy.normalizePerformanceSegments(
      req.body.segments,
      cleanText,
      { confidence: 1, evidence: 'validated API performance segment', inference: 'explicit' },
    );
    const prosodyText = segments.length >= 2
      ? replyPerformancePolicy.applyPerformanceSegmentTags(cleanText, segments)
      : replyPerformancePolicy.applyEmphasisTags(cleanText, emphasis);
    const speakableLength = cleanText.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '').length;
    if (!cleanText || speakableLength < 2) {
      return res.json({ success: false, errorCode: 'TEXT_TOO_SHORT', error: '清理后可朗读文本不足2个字符', retryable: false });
    }
    if (cleanText.length > 600) {
      return res.json({ success: false, errorCode: 'TEXT_TOO_LONG', error: '单次语音文本不能超过600字符，请分段合成', retryable: false });
    }

    // 查找角色分配的语音名称（新架构）
    const voiceName = getCharacterVoiceName(charId);
    if (!hasVoice(charId) && !voiceName) {
      return res.json({ success: false, errorCode: 'VOICE_NOT_CONFIGURED', error: '该角色没有语音', retryable: false });
    }

    const tuningCfg = readMergedVoiceConfig(charId);
    let effectiveEmotion = replyPerformancePolicy.VOICE_EMOTIONS.has(String(emotion || '').trim())
      ? String(emotion).trim()
      : emotion;
    if (!effectiveEmotion || effectiveEmotion === 'auto') {
      const cachedEmotion = getCachedEmotion(charId, userMessage || '');
      if (cachedEmotion) effectiveEmotion = cachedEmotion;
    }
    // Keep the performance plan in the same request scope as the voice
    // decision.  It is returned on every path so a cached WAV cannot leave
    // the face/motion layer using stale metadata from the original message.
    const requestedPerformance = () => _buildPlaybackPerformancePlan(
      cleanText,
      req.body,
      effectiveEmotion,
      emphasis,
      segments,
    );
    const cacheRequest = { ...req.body, text: cleanText, emphasis, segments };
    const cacheVariant = _buildVoiceCacheVariant(charId, effectiveEmotion || 'auto', tuningCfg, cacheRequest);

    // 只有情感已确定时才命中缓存；auto需要重新判断当前上下文，防止旧情绪串到新回复。
    // ★ force=true 时跳过缓存（用户点↻刷新时强制重新合成，应用最新VOICE CONTROL参数）
    if (!force && effectiveEmotion && effectiveEmotion !== 'auto') {
      const cachedUrl = _getCachedAudioUrl(cleanText, voiceName, cacheVariant);
      if (cachedUrl) {
        const cachedResult = {
          success: true,
          audioUrl: cachedUrl,
          emotion: effectiveEmotion,
          desc: null,
          duration: null,
          text: text,
          performance: requestedPerformance(),
          cached: true,
        };
        _setVoiceRequestResult(requestId, cachedResult);
        return res.json(cachedResult);
      }
    }
    // 调音参数变化会使精确哈希未命中，但旧 WAV 仍可安全复用。
    // 仅按当前角色、当前语音和完整清理文本匹配，不会跨角色串音。
    if (!force) {
      const manifestHit = _getManifestCachedAudio(cleanText, voiceName, charId);
      if (manifestHit) {
        const cachedResult = {
          ...manifestHit,
          text,
          performance: requestedPerformance(),
          cached: true,
        };
        _setVoiceRequestResult(requestId, cachedResult);
        return res.json(cachedResult);
      }
    }

    const ttsAvailable = await checkTTSAvailable();
    if (!ttsAvailable) {
      return res.json({ success: false, errorCode: 'TTS_NOT_RUNNING', error: '语音服务未启动', retryable: true });
    }

    // 调用TTS API（带上用户微调参数）
    // 智能情感缓存：事件驱动（关键词/句式/时间/沉默梯度）
    // 如果请求未指定情感（auto），优先使用缓存的对话情感
    const ttsBody = {
      text: prosodyText,
      emotion: effectiveEmotion || 'auto',
      char_id: charId,
    };
    if (req.body.intensity !== undefined) {
      const numericIntensity = Number(req.body.intensity);
      ttsBody.intensity = Number.isFinite(numericIntensity)
        ? (numericIntensity >= 0.72 ? 'high' : numericIntensity >= 0.42 ? 'medium' : 'low')
        : req.body.intensity;
    }
    // 新架构：传递语音名称（优先于 char_id 用于权重切换）
    if (voiceName) ttsBody.voice_name = voiceName;

    // 如果有用户微调参数，传递给 TTS
    // 优先级：请求体直接传的参数（试听用）> config 文件的 tuningCfg（正常对话用）
    if (tuningCfg) {
      if (tuningCfg.globalSpeedOffset) ttsBody.speed_offset = tuningCfg.globalSpeedOffset;
      if (tuningCfg.globalPitchOffset) ttsBody.pitch_offset = tuningCfg.globalPitchOffset;
      if (tuningCfg.globalTempOffset) ttsBody.temp_offset = tuningCfg.globalTempOffset;
      if (tuningCfg.globalPauseOffset) ttsBody.pause_offset = tuningCfg.globalPauseOffset;
      if (tuningCfg.globalEndingOffset !== undefined && tuningCfg.globalEndingOffset !== 0) ttsBody.ending_offset = tuningCfg.globalEndingOffset;
      if (tuningCfg.globalSoftOffset !== undefined && tuningCfg.globalSoftOffset !== 0) ttsBody.soft_offset = tuningCfg.globalSoftOffset;
      if (tuningCfg.globalVolumeOffset !== undefined && tuningCfg.globalVolumeOffset !== 0) ttsBody.volume_offset = tuningCfg.globalVolumeOffset;
      if (tuningCfg.globalFadeIn !== undefined && tuningCfg.globalFadeIn !== 0.015) ttsBody.fadein = tuningCfg.globalFadeIn;
      // 传递当前情感的覆盖参数
      if (tuningCfg.emotion_profiles && ttsBody.emotion !== 'auto') {
        const profile = tuningCfg.emotion_profiles[ttsBody.emotion];
        if (profile) {
          if (profile.temperature !== undefined) ttsBody.temperature = profile.temperature;
          if (profile.top_p !== undefined) ttsBody.top_p = profile.top_p;
          if (profile.speed !== undefined) ttsBody.speed = profile.speed;
          if (profile.intensity !== undefined) ttsBody.intensity = profile.intensity;
          if (profile.pause_style !== undefined) ttsBody.pause_style = profile.pause_style;
        }
      }
    }
    // 请求体直接传的参数覆盖 config（试听实时调参用）
    if (req.body.speed_offset !== undefined) ttsBody.speed_offset = req.body.speed_offset;
    if (req.body.pitch_offset !== undefined) ttsBody.pitch_offset = req.body.pitch_offset;
    if (req.body.temp_offset !== undefined) ttsBody.temp_offset = req.body.temp_offset;
    if (req.body.pause_offset !== undefined) ttsBody.pause_offset = req.body.pause_offset;
    if (req.body.ending_offset !== undefined) ttsBody.ending_offset = req.body.ending_offset;
    if (req.body.soft_offset !== undefined) ttsBody.soft_offset = req.body.soft_offset;
    if (req.body.volume_offset !== undefined) ttsBody.volume_offset = req.body.volume_offset;
    if (req.body.fadein !== undefined) ttsBody.fadein = req.body.fadein;
    Object.assign(ttsBody, sanitizeEngineParams(ttsBody));

    // TTS API内部已经按音频质量最多尝试3次；这里给足总时间，避免Node在第一次120秒处提前断开。
    // 同文本/同语音/同参数的并发请求共享一次上游推理，后续请求只复制同一
    // 个已生成 WAV，不再把 GPU worker 排成多轮重复推理。
    const synthesisKey = JSON.stringify({
      charId: String(charId),
      voiceName: String(voiceName || ''),
      preview: isPreview,
      text: cleanText,
      prosodyText,
      body: ttsBody,
    });
    let synthesisPromise = _voiceSynthesisInflight.get(synthesisKey);
    if (!synthesisPromise) {
      synthesisPromise = _enqueueVoiceSynthesis(() => axios.post(`${TTS_API_URL}/tts/json`, ttsBody, {
        timeout: 390000,
        httpAgent: ttsAgent,
      }), replyGroupId);
      _voiceSynthesisInflight.set(synthesisKey, synthesisPromise);
    }
    let ttsResp;
    try {
      ttsResp = await synthesisPromise;
    } finally {
      if (_voiceSynthesisInflight.get(synthesisKey) === synthesisPromise) {
        _voiceSynthesisInflight.delete(synthesisKey);
      }
    }

    if (ttsResp.status !== 200 || !ttsResp.data.audio_url) {
      return res.json({ success: false, errorCode: 'TTS_GENERATION_FAILED', error: 'TTS已完成3次尝试但未生成有效音频', retryable: false, engineAttempts: 3 });
    }

    // 首次自动检测后，缓存情感用于后续消息（保持语气一致）
    if (ttsResp.data.emotion && (!effectiveEmotion || effectiveEmotion === 'auto')) {
      setCachedEmotion(charId, ttsResp.data.emotion, userMessage || '');
    }

    // 下载音频到本地（优先用 TTS 返回的 local_path 直接复制，省一次 HTTP 下载）
    const audioUrl = ttsResp.data.audio_url;
    const filename = isPreview
      ? `preview_char${charId}_${ttsResp.data.emotion}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.wav`
      : `char${charId}_${ttsResp.data.emotion}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.wav`;
    const localPath = isPreview
      ? path.join(VOICE_OUTPUT_DIR, filename)
      : path.join(getCharacterVoiceOutputDir(charId), filename);

    try {
      if (ttsResp.data.local_path && fs.existsSync(ttsResp.data.local_path)) {
        // ★ 路径直传模式：TTS API 与 chat server 同机，直接 fs.copyFileSync（省 0.3-1s HTTP 下载）
        fs.copyFileSync(ttsResp.data.local_path, localPath);
      } else {
        // 回退：HTTP 下载（TTS API 未返回 local_path 或文件不存在）
        const audioResp = await axios.get(`${TTS_API_URL}${audioUrl}`, {
          responseType: 'arraybuffer',
          timeout: 30000,
          httpAgent: ttsAgent,
        });
        fs.writeFileSync(localPath, audioResp.data);
      }
      const validation = validateWavFile(localPath);
      if (!validation.ok) {
        try { fs.rmSync(localPath, { force: true }); } catch (ignore) {}
        console.error('[Voice] WAV校验失败:', validation.reason);
        return res.json({ success: false, errorCode: 'INVALID_AUDIO', error: `生成的音频未通过完整性检查：${validation.reason}`, retryable: true });
      }
      if (isPreview) {
        // 设置页试听不参与聊天历史缓存；只保留本角色最近3个临时文件。
        cleanupVoicePreviewCache(charId, 3);
      } else {
        // 自动清理：按当前角色上限清理（30删15/60删30/100删50）
        cleanupVoiceCache(charId);
        // 写入 text+voice 缓存：F5 后同文本秒返
        const resolvedCacheVariant = _buildVoiceCacheVariant(
          charId,
          ttsResp.data.emotion || effectiveEmotion || 'auto',
          tuningCfg,
          cacheRequest,
        );
        _setVoiceCache(cleanText, voiceName, filename, resolvedCacheVariant, {
          charId,
          emotion: ttsResp.data.emotion,
        });
      }
    } catch (e) {
      console.error('[Voice] 下载音频失败:', e.message);
      try { fs.rmSync(localPath, { force: true }); } catch (ignore) {}
      return res.json({ success: false, errorCode: 'AUDIO_DOWNLOAD_FAILED', error: '音频保存失败', retryable: true });
    }

    const responseData = {
      success: true,
      audioUrl: `/api/voice/audio/${filename}`,
      emotion: ttsResp.data.emotion,
      desc: ttsResp.data.desc,
      characterNote: ttsResp.data.characterNote,
      temperature: ttsResp.data.temperature,
      topP: ttsResp.data.top_p,
      pauseStyle: ttsResp.data.pause_style,
      duration: ttsResp.data.duration,
      // The engine's resolved emotion is authoritative for this WAV; use it
      // to complete the exact plan consumed by Avatar facial/motion cues.
      performance: _buildPlaybackPerformancePlan(
        cleanText,
        req.body,
        ttsResp.data.emotion || effectiveEmotion,
        emphasis,
        segments,
      ),
      emphasis,
      segments,
      engineAttempts: ttsResp.data.attempts || 1,
      timingMs: ttsResp.data.timing_ms || null,
      text: text,
    };
    // Same-machine callers (Electron main process) may consume the already
    // materialized WAV directly. Keep the absolute path out of ordinary
    // browser responses unless explicitly requested by the trusted adapter.
    if (includeLocalPath === true) responseData.localPath = localPath;
    _setVoiceRequestResult(requestId, responseData);
    res.json(responseData);
  } catch (error) {
    console.error('[Voice] 合成失败:', error.message);
    const upstreamStatus = error.response?.status;
    const upstreamMessage = error.response?.data?.error || error.response?.data?.message || error.message;
    if (upstreamStatus) {
      return res.json({
        success: false,
        errorCode: upstreamStatus >= 500 ? 'TTS_GENERATION_FAILED' : 'TTS_REQUEST_REJECTED',
        error: upstreamStatus >= 500 ? `TTS已完成3次尝试但仍失败：${upstreamMessage}` : `TTS拒绝了请求：${upstreamMessage}`,
        retryable: false,
        engineAttempts: upstreamStatus >= 500 ? 3 : 0,
      });
    }
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      await terminateTrackedTTSProcess('synthesis-timeout');
    }
    res.json({ success: false, errorCode: 'TTS_CONNECTION_FAILED', error: '语音服务连接中断或超时，将尝试重启后重试', retryable: true });
  }
});

// 音频文件服务
app.get('/api/voice/audio/:filename', (req, res) => {
  const filePath = resolveVoiceAudioPath(req.params.filename);
  if (filePath) {
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', fs.statSync(filePath).size);
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.status(404).json({ error: '音频文件不存在' });
  }
});

// ★ 删除单个音频文件（前端 oldVoices/previewHistory 超出限制时调用，避免孤儿文件留存磁盘）
app.delete('/api/voice/audio/:filename', (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = resolveVoiceAudioPath(filename);
    if (filePath) {
      fs.unlinkSync(filePath);
      // 同步清理 L3 缓存中指向该文件的映射
      let cleaned = 0;
      for (const [key, fn] of _voiceCache) {
        if (fn === filename) { _voiceCache.delete(key); cleaned++; }
      }
      for (const [key, entry] of _voiceCacheManifest) {
        if (entry?.filename === filename) _voiceCacheManifest.delete(key);
      }
      if (cleaned > 0) _saveVoiceCacheToDisk();
      _saveVoiceCacheManifest();
      console.log(`[Voice] 删除音频文件: ${filename}（清理 ${cleaned} 条缓存映射）`);
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 获取最近的语音文件列表（前端预加载用）
app.get('/api/voice/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const charId = getCurrentCharacterId();
    const files = [
      ...listCharacterVoiceFiles(charId),
      ...(fs.existsSync(VOICE_OUTPUT_DIR) ? fs.readdirSync(VOICE_OUTPUT_DIR)
        .filter(f => f.startsWith(`preview_char${charId}_`) && f.endsWith('.wav'))
        .map(f => ({ name: f, path: path.join(VOICE_OUTPUT_DIR, f), mtime: fs.statSync(path.join(VOICE_OUTPUT_DIR, f)).mtimeMs })) : []),
    ]
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(file => ({ name: file.name, url: `/api/voice/audio/${file.name}`, mtime: file.mtime, size: fs.statSync(file.path).size }));
    res.json({ success: true, audios: files });
  } catch (e) {
    res.json({ success: false, error: e.message, audios: [] });
  }
});

// 批量检查文本的缓存状态（F5刷新后恢复所有已缓存语音，不调用TTS，不自动播放）
// 前端发送多条文本，服务端仅查 L3 缓存（text+voiceName → 文件），命中则返回 URL
app.post('/api/voice/batch-cache-check', async (req, res) => {
  try {
    const { texts, charId: reqCharId } = req.body;
    const charId = reqCharId ? String(reqCharId) : getCurrentCharacterId();
    const voiceName = getCharacterVoiceName(charId);
    const items = Array.isArray(texts) ? texts : [];
    const tuningCfg = readMergedVoiceConfig(charId);
    const currentEmotion = getCachedEmotion(charId, '') || tuningCfg?.defaultEmotion;
    const profileIds = Object.keys(tuningCfg?.emotion_profiles || tuningCfg?.emotions || {});
    const results = items.map(item => {
      // New callers send { text, performance } so the cache variant includes
      // the same emphasis/segment metadata used during synthesis. Keep plain
      // strings supported for older clients.
      const isObject = item && typeof item === 'object';
      const rawText = isObject ? item.text : item;
      const performance = isObject && item.performance && typeof item.performance === 'object'
        ? item.performance
        : {};
      if (!rawText || !rawText.trim()) return null;
      const cleanText = stripStageDirections(rawText);
      if (!cleanText) return null;
      const requestedEmotion = String(performance.voiceEmotion || '').trim();
      const candidateEmotions = [...new Set([
        requestedEmotion,
        currentEmotion,
        ...profileIds,
      ].filter(Boolean))];
      let url = null;
      for (const candidateEmotion of candidateEmotions) {
        const variant = _buildVoiceCacheVariant(charId, candidateEmotion, tuningCfg, {
          text: cleanText,
          emphasis: Array.isArray(performance.emphasis) ? performance.emphasis : [],
          segments: Array.isArray(performance.segments) ? performance.segments : [],
          intensity: performance.intensity,
        });
        url = _getCachedAudioUrl(cleanText, voiceName, variant, { allowCompatibleVersions: true });
        if (url) break;
      }
      // 当前调音配置变化后哈希键可能失配，但未被清理的 WAV 仍然有效。
      // 文本索引作为哈希未命中时的回退，不触发新的 TTS 推理。
      if (!url) {
        const manifestHit = _getManifestCachedAudio(cleanText, voiceName, charId);
        if (manifestHit) return manifestHit;
      }
      return url ? { audioUrl: url, duration: null, cached: true } : null;
    });
    res.json({ success: true, results });
  } catch (e) {
    res.json({ success: false, error: e.message, results: [] });
  }
});

// 语音缓存上限设置（按角色独立：30/60/100/0关闭）
app.get('/api/voice/cache-limit', (req, res) => {
  try {
    const charId = req.query.charId ? String(req.query.charId) : getCurrentCharacterId();
    res.json({ success: true, limit: getVoiceCacheLimit(charId), charId });
  } catch (e) {
    res.json({ success: false, error: e.message, limit: 30 });
  }
});
app.post('/api/voice/cache-limit', (req, res) => {
  try {
    const { limit, charId: reqCharId } = req.body;
    const charId = reqCharId ? String(reqCharId) : getCurrentCharacterId();
    const n = Number(limit);
    if (![0, 30, 60, 100].includes(n)) {
      return res.json({ success: false, error: 'limit 必须是 0/30/60/100' });
    }
    fs.writeFileSync(getVoiceCacheLimitFile(charId), JSON.stringify({ limit: n }, null, 2));
    // 保存设置后立即按新上限清理，不必等下一次合成才生效。
    cleanupVoiceCache(charId);
    console.log(`[Voice] 缓存上限已更新(角色${charId}): ${n === 0 ? '关闭自动删除' : n + '条'}`);
    res.json({ success: true, limit: n, charId, message: n === 0 ? '已关闭自动删除' : `已设置为满${n}条删除（仅当前角色）` });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// 流式代理：直接转发TTS API的音频，不落盘
app.get('/api/voice/proxy', async (req, res) => {
  const u = req.query.u;
  if (!u || !/^\/audio\/[\w.-]+$/.test(u)) return res.status(400).end();
  try {
    const up = await axios.get(`${TTS_API_URL}${u}`, { responseType: 'stream', timeout: 30000, httpAgent: ttsAgent });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-cache');
    up.data.pipe(res);
  } catch {
    res.status(502).end();
  }
});

// 句级切分
// 去除舞台指示（括号内的动作/场景描写），避免TTS朗读
function stripStageDirections(text) {
  return String(text || '')
    // Some providers leak chat-template markers into streamed TTS text. They
    // are transport tokens, never character dialogue, and must not reach the
    // UI, history, semantic cue splitter, or synthesized audio.
    .replace(/<\|\s*(?:assistant|user|system|end|im_start|im_end)\s*\|>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')                  // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')         // Markdown 图片
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')       // Markdown 链接只保留文字
    .replace(/\[表情包:[^\]]*\]/g, ' ')
    .replace(/\[图片\s*:[^\]]*\]/g, ' ')
    .replace(/^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s+\d{1,2}:\d{2})\s*/gm, '')
    .replace(/（[^）]*）/g, '')   // 中文全角括号
    .replace(/\([^)]*\)/g, '')    // 英文半角括号
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/([。！？!?，,；;～~])\1{2,}/g, '$1$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')         // 合并多余空格
    .trim();
}

function splitSentences(text, maxLen = 25) {
  let clean = stripStageDirections(text);
  if (!clean) return [];
  // 去掉引号字符（引号残留产生孤立段→GPT-SoVITS 杂音/卡顿）
  // 只去引号符号本身，保留引号内的文字
  clean = clean.replace(/["""「」『』]/g, '');
  // 半角~替换为全角～（GPT-SoVITS 对半角~处理不佳→杂音）
  clean = clean.replace(/~/g, '～');
  // 保护 [语气:xx]...[/语气] 标记：整段替换为占位符，切句后再还原（避免标记内标点切断标记）
  const toneMarkers = [];
  clean = clean.replace(/\[语气:[^\]]*\][\s\S]*?\[\/语气\]/g, (m) => {
    toneMarkers.push(m);
    return `\u0002${toneMarkers.length - 1}\u0002`;
  });
  const parts = clean
    .replace(/([。！？!?\n]+)/g, '$1\u0000')
    .split('\u0000').map(s => s.trim()).filter(Boolean);
  const raw = [];
  for (const p of parts) {
    // 还原 tone 标记
    let restored = p.replace(/\u0002(\d+)\u0002/g, (mm, idx) => toneMarkers[parseInt(idx)] || '');
    if (restored.length <= maxLen) { raw.push(restored); continue; }
    let b = '';
    for (const seg of restored.split(/([，、；,;])/)) {
      if ((b + seg).length > maxLen && b) { raw.push(b); b = seg; }
      else b += seg;
    }
    if (b.trim()) raw.push(b);
  }
  // 短段合并：<10字的段合并到相邻段（优先合并到前段，首段合并到后段）
  // 避免极短段/拟声词（如"诶？""菲比丘比，诶？"）被单独发给 TTS 导致杂音或全静音
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i].trim();
    if (s.length < 10) {
      if (out.length > 0) {
        // 合并到前一段
        out[out.length - 1] += s;
      } else if (i + 1 < raw.length) {
        // 首段：合并到后一段
        raw[i + 1] = s + raw[i + 1];
      } else {
        out.push(s);
      }
    } else {
      out.push(s);
    }
  }
  return out;
}

// 流式语音合成：句级切分 → 逐句合成 → NDJSON流式返回
app.post('/api/voice/speak/stream', async (req, res) => {
  try {
    let {
      text,
      emotion = 'auto',
      emphasis: requestedEmphasis,
      segments: requestedSegments,
      intensity: requestedIntensity,
      performanceEmotion: requestedPerformanceEmotion,
      intent: requestedIntent,
      gaze: requestedGaze,
      confidence: requestedConfidence,
      charId: reqCharId,
      userMessage,
    } = req.body;
    const charId = reqCharId ? String(reqCharId) : getCurrentCharacterId();

    if (!text || !text.trim()) {
      return res.json({ success: false, error: '文本不能为空' });
    }
    // 剥离表情包标记 [表情包:...]，避免 TTS 朗读
    text = String(text).replace(/\[表情包:[^\]]*\]/g, '').trim();
    if (!text) {
      return res.json({ success: false, error: '文本不能为空' });
    }
    const streamEmphasis = replyPerformancePolicy.normalizeEmphasis(requestedEmphasis, text);
    const streamSegments = replyPerformancePolicy.normalizePerformanceSegments(
      requestedSegments,
      text,
      { confidence: 1, evidence: 'validated API performance segment', inference: 'explicit' },
    );
    text = streamSegments.length >= 2
      ? replyPerformancePolicy.applyPerformanceSegmentTags(text, streamSegments)
      : replyPerformancePolicy.applyEmphasisTags(text, streamEmphasis);
    // 查找角色分配的语音名称（新架构）
    const streamVoiceName = getCharacterVoiceName(charId);
    if (!hasVoice(charId) && !streamVoiceName) {
      return res.json({ success: false, error: '该角色没有语音' });
    }

    const ttsAvailable = await checkTTSAvailable();
    if (!ttsAvailable) {
      return res.json({ success: false, error: '语音服务未启动' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    const write = o => res.write(JSON.stringify(o) + '\n');

    const sentences = splitSentences(text);
    write({ type: 'meta', total: sentences.length });

    const tuningCfg = readMergedVoiceConfig(charId);
    const total = sentences.length;

    // 智能情感缓存：事件驱动（关键词/句式/时间/沉默梯度）
    // 如果请求未指定情感（auto），优先使用缓存的对话情感
    let streamEmotion = emotion;
    if (!streamEmotion || streamEmotion === 'auto') {
      const cached = getCachedEmotion(charId, userMessage || '');
      if (cached) streamEmotion = cached;
    }

    for (let i = 0; i < total; i++) {
      try {
        // ★ 查 L3 缓存：同文本+语音名命中则秒返，不调 TTS（避免重复合成）
        const sentClean = stripStageDirections(sentences[i]) || sentences[i];
        const streamCacheVariant = _buildVoiceCacheVariant(charId, streamEmotion || 'auto', tuningCfg, {
          text: sentClean,
        });
        const cachedUrl = streamEmotion && streamEmotion !== 'auto'
          ? _getCachedAudioUrl(sentClean, streamVoiceName, streamCacheVariant)
          : null;
        if (cachedUrl) {
          write({
            type: 'segment',
            seq: i,
            duration: null,
            audioUrl: cachedUrl,
            emotion: streamEmotion || 'auto',
            desc: '(缓存命中)',
            performance: _buildPlaybackPerformancePlan(sentClean, {
              performanceEmotion: requestedPerformanceEmotion,
              intent: requestedIntent,
              gaze: requestedGaze,
              intensity: requestedIntensity,
              confidence: requestedConfidence,
            }, streamEmotion),
            cached: true,
          });
          continue;
        }

        const ttsBody = {
          text: sentences[i],
          emotion: streamEmotion || 'auto',
          char_id: charId,
          is_first: (i === 0),
        };
        if (requestedIntensity !== undefined) {
          const numericIntensity = Number(requestedIntensity);
          ttsBody.intensity = Number.isFinite(numericIntensity)
            ? (numericIntensity >= 0.72 ? 'high' : numericIntensity >= 0.42 ? 'medium' : 'low')
            : requestedIntensity;
        }
        if (streamVoiceName) ttsBody.voice_name = streamVoiceName;
        if (tuningCfg) {
          if (tuningCfg.globalSpeedOffset) ttsBody.speed_offset = tuningCfg.globalSpeedOffset;
          if (tuningCfg.globalPitchOffset) ttsBody.pitch_offset = tuningCfg.globalPitchOffset;
          if (tuningCfg.globalTempOffset) ttsBody.temp_offset = tuningCfg.globalTempOffset;
          if (tuningCfg.globalPauseOffset) ttsBody.pause_offset = tuningCfg.globalPauseOffset;
          if (tuningCfg.globalEndingOffset !== undefined && tuningCfg.globalEndingOffset !== 0) ttsBody.ending_offset = tuningCfg.globalEndingOffset;
          if (tuningCfg.globalSoftOffset !== undefined && tuningCfg.globalSoftOffset !== 0) ttsBody.soft_offset = tuningCfg.globalSoftOffset;
          if (tuningCfg.globalVolumeOffset !== undefined && tuningCfg.globalVolumeOffset !== 0) ttsBody.volume_offset = tuningCfg.globalVolumeOffset;
          if (tuningCfg.globalFadeIn !== undefined && tuningCfg.globalFadeIn !== 0.015) ttsBody.fadein = tuningCfg.globalFadeIn;
          if (tuningCfg.emotion_profiles && ttsBody.emotion !== 'auto') {
            const profile = tuningCfg.emotion_profiles[ttsBody.emotion];
            if (profile) {
              if (profile.temperature !== undefined) ttsBody.temperature = profile.temperature;
              if (profile.top_p !== undefined) ttsBody.top_p = profile.top_p;
              if (profile.speed !== undefined) ttsBody.speed = profile.speed;
            }
          }
        }
        Object.assign(ttsBody, sanitizeEngineParams(ttsBody));

        const ttsResp = await _enqueueVoiceSynthesis(() => axios.post(
          `${TTS_API_URL}/tts/json`,
          ttsBody,
          { timeout: 390000, httpAgent: ttsAgent },
        ));
        if (ttsResp.status === 200 && ttsResp.data.audio_url) {
          // 首次自动检测后，缓存情感并用于后续句子（保持整段语气一致）
          if (ttsResp.data.emotion && (!streamEmotion || streamEmotion === 'auto')) {
            streamEmotion = ttsResp.data.emotion;
            setCachedEmotion(charId, streamEmotion, userMessage || '');
          }
          // ★ 落盘到 voice_engine/output/ 并写 L3 缓存（按句子索引），后续同句子命中秒返
          let localAudioUrl = `/api/voice/proxy?u=${encodeURIComponent(ttsResp.data.audio_url)}`;
          try {
            const segFilename = `char${charId}_${ttsResp.data.emotion}_${Date.now()}_st.wav`;
            const segLocalPath = path.join(getCharacterVoiceOutputDir(charId), segFilename);
            if (ttsResp.data.local_path && fs.existsSync(ttsResp.data.local_path)) {
              fs.copyFileSync(ttsResp.data.local_path, segLocalPath);
            } else {
              const audioResp = await axios.get(`${TTS_API_URL}${ttsResp.data.audio_url}`, {
                responseType: 'arraybuffer',
                timeout: 30000,
                httpAgent: ttsAgent,
              });
              fs.writeFileSync(segLocalPath, audioResp.data);
            }
            localAudioUrl = `/api/voice/audio/${segFilename}`;
            const validation = validateWavFile(segLocalPath);
            if (!validation.ok) throw new Error(`WAV校验失败: ${validation.reason}`);
            const resolvedVariant = _buildVoiceCacheVariant(
              charId,
              ttsResp.data.emotion || streamEmotion || 'auto',
              tuningCfg,
              { text: sentClean },
            );
            _setVoiceCache(sentClean, streamVoiceName, segFilename, resolvedVariant, {
              charId,
              emotion: ttsResp.data.emotion,
            });
          } catch (dlErr) {
            if (String(dlErr.message || '').startsWith('WAV校验失败')) {
              try { if (typeof segLocalPath !== 'undefined') fs.rmSync(segLocalPath, { force: true }); } catch (ignore) {}
              write({ type: 'error', seq: i, error: dlErr.message });
              continue;
            }
            console.error('[Voice Stream] 落盘失败，回退 proxy:', dlErr.message);
          }
          write({
            type: 'segment',
            seq: i,
            duration: ttsResp.data.duration,
            audioUrl: localAudioUrl,
            emotion: ttsResp.data.emotion,
            desc: ttsResp.data.desc,
            performance: _buildPlaybackPerformancePlan(sentClean, {
              performanceEmotion: requestedPerformanceEmotion,
              intent: requestedIntent,
              gaze: requestedGaze,
              intensity: requestedIntensity,
              confidence: requestedConfidence,
            }, ttsResp.data.emotion || streamEmotion),
          });
        } else {
          write({ type: 'error', seq: i, error: '合成失败' });
        }
      } catch (e) {
        write({ type: 'error', seq: i, error: e.code || String(e.message || e) });
      }
    }
    // 流式落盘后清理缓存（保持上限）
    cleanupVoiceCache(charId);
    write({ type: 'done' });
    res.end();
  } catch (error) {
    console.error('[Voice] 流式合成失败:', error.message);
    if (!res.headersSent) {
      res.json({ success: false, error: '语音合成失败: ' + error.message });
    }
  }
});

// 列出所有情感类型
app.get('/api/voice/emotions', async (req, res) => {
  try {
    const charId = req.query.charId ? String(req.query.charId) : getCurrentCharacterId();
    const cfg = readMergedVoiceConfig(charId);
    if (!cfg) {
      return res.json({ success: false, emotions: [] });
    }
    const emotions = Object.entries(cfg.emotion_profiles || cfg.emotions || {}).map(([id, v]) => ({
      id,
      desc: v.desc,
      characterNote: v.characterNote,
      temperature: v.temperature,
      topP: v.top_p,
      speed: v.speed || 1.0,
      intensity: v.intensity || 'medium',
      pauseStyle: v.pause_style,
    }));
    res.json({ success: true, emotions, defaultEmotion: cfg.defaultEmotion || 'auto' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 语音微调配置 — 读取（合并基础配置 + 角色专属覆盖）
app.get('/api/voice/tuning', (req, res) => {
  try {
    const charId = req.query.charId ? String(req.query.charId) : getCurrentCharacterId();
    const cfg = readMergedVoiceConfig(charId);
    if (!cfg) return res.json({ success: false, error: '无语音配置' });

    // 返回 emotion_profiles（含默认值）和全局覆盖
    const profiles = cfg.emotion_profiles || {};
    const tuning = {
      defaultEmotion: cfg.defaultEmotion || 'auto',
      globalSpeedOffset: cfg.globalSpeedOffset || 0,
      globalPitchOffset: cfg.globalPitchOffset || 0,
      globalTempOffset: cfg.globalTempOffset || 0,
      globalPauseOffset: cfg.globalPauseOffset || 0,
      globalEndingOffset: cfg.globalEndingOffset !== undefined ? cfg.globalEndingOffset : 0,
      globalSoftOffset: cfg.globalSoftOffset !== undefined ? cfg.globalSoftOffset : 0,
      globalVolumeOffset: cfg.globalVolumeOffset !== undefined ? cfg.globalVolumeOffset : 0,
      globalFadeIn: cfg.globalFadeIn !== undefined ? cfg.globalFadeIn : 0.015,
      voiceIdentityPolicy: VOICE_IDENTITY_POLICY_VERSION,
      identityLocked: true,
      profiles: {},
    };

    // 填充每个情感的参数
    for (const [id, p] of Object.entries(profiles)) {
      tuning.profiles[id] = {
        desc: p.desc,
        characterNote: p.characterNote,
        temperature: p.temperature,
        topP: p.top_p,
        speed: p.speed || 1.0,
        intensity: p.intensity || 'medium',
        pauseStyle: p.pause_style,
        refCandidates: p.ref_candidates || [],
      };
    }

    res.json({ success: true, tuning });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 语音微调配置 — 保存（只更新角色专属覆盖，不影响语音库基础配置）
app.post('/api/voice/tuning', (req, res) => {
  try {
    const charId = req.body.charId ? String(req.body.charId) : getCurrentCharacterId();
    if (!getVoiceConfigPath(charId)) return res.json({ success: false, error: '无语音配置' });

    // 读取现有角色覆盖（不存在则创建空对象）
    const charTuning = readCharacterTuning(charId) || {};
    const requestedProfiles = {};
    for (const [id, profile] of Object.entries(req.body.profiles || {})) {
      requestedProfiles[id] = {
        ...profile,
        top_p: profile.topP,
      };
    }
    const safeRequest = sanitizeTuningConfig({
      ...req.body,
      emotion_profiles: requestedProfiles,
    });

    // 更新全局覆盖
    if (req.body.globalSpeedOffset !== undefined) charTuning.globalSpeedOffset = safeRequest.globalSpeedOffset;
    if (req.body.globalPitchOffset !== undefined) charTuning.globalPitchOffset = safeRequest.globalPitchOffset;
    if (req.body.globalTempOffset !== undefined) charTuning.globalTempOffset = safeRequest.globalTempOffset;
    if (req.body.globalPauseOffset !== undefined) charTuning.globalPauseOffset = req.body.globalPauseOffset;
    if (req.body.globalEndingOffset !== undefined) charTuning.globalEndingOffset = req.body.globalEndingOffset;
    if (req.body.globalSoftOffset !== undefined) charTuning.globalSoftOffset = safeRequest.globalSoftOffset;
    if (req.body.globalVolumeOffset !== undefined) charTuning.globalVolumeOffset = safeRequest.globalVolumeOffset;
    if (req.body.globalFadeIn !== undefined) charTuning.globalFadeIn = req.body.globalFadeIn;
    if (req.body.defaultEmotion !== undefined) charTuning.defaultEmotion = req.body.defaultEmotion;

    // 更新每个情感的覆盖参数
    if (req.body.profiles) {
      if (!charTuning.emotion_profiles) charTuning.emotion_profiles = {};
      for (const [id, p] of Object.entries(req.body.profiles)) {
        if (!charTuning.emotion_profiles[id]) charTuning.emotion_profiles[id] = {};
        const safeProfile = safeRequest.emotion_profiles[id];
        if (p.temperature !== undefined) charTuning.emotion_profiles[id].temperature = safeProfile.temperature;
        if (p.topP !== undefined) charTuning.emotion_profiles[id].top_p = safeProfile.top_p;
        if (p.speed !== undefined) charTuning.emotion_profiles[id].speed = safeProfile.speed;
        if (p.intensity !== undefined) charTuning.emotion_profiles[id].intensity = p.intensity;
        if (p.pauseStyle !== undefined) charTuning.emotion_profiles[id].pause_style = p.pauseStyle;
      }
    }

    writeCharacterTuning(charId, charTuning);
    res.json({ success: true, voiceIdentityPolicy: VOICE_IDENTITY_POLICY_VERSION });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// 语音微调配置 — 重置为默认（删除角色专属覆盖，回到语音库基础配置）
app.post('/api/voice/tuning/reset', (req, res) => {
  try {
    const charId = req.body.charId ? String(req.body.charId) : getCurrentCharacterId();
    if (!getVoiceConfigPath(charId)) return res.json({ success: false, error: '无语音配置' });

    // 删除角色专属覆盖文件，自动回到基础配置
    const tuningPath = getCharacterTuningPath(charId);
    if (fs.existsSync(tuningPath)) {
      fs.unlinkSync(tuningPath);
    }
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

ensureDataFiles();
migrateOldData();
ensureDefaultCharacter();
loadSettingsOnStartup();

// 凌晨关心由前端可见会话每分钟检查，并通过 reservation → 成功提交保证最多一次。
// 不再使用后端独立定时器，避免与前端并发生成两条主动消息。

// ============================================================
// 语音克隆训练工具（桌面端专用，封装APK时排除）
// ============================================================

// 训练任务状态（内存）
const _trainJobs = new Map(); // jobId → {status, progress, logs, process, startTime, workDir, voiceName, input}

// 训练工作目录根路径（voice_engine/output/）
const TRAIN_WORKROOT = TRAINING_DIR;

/** 语音训练页面 */
app.get('/voice-train', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'voice-train.html'));
});

// 兼容别名 /setvoice → /voice-train
app.get('/setvoice', (req, res) => {
  res.redirect('/voice-train');
});

/** 列出所有可用语音 */
app.get('/api/voices', (req, res) => {
  try {
    const voices = scanVoices();
    const charId = getCurrentCharacterId();
    const currentVoice = getCharacterVoiceName(charId);
    res.json({ success: true, voices, currentVoice, characterId: charId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 检查语音名称是否可用（不重名） */
app.post('/api/voice-train/check-name', (req, res) => {
  try {
    const { voiceName } = req.body;
    if (!voiceName || !voiceName.trim()) {
      return res.json({ success: false, error: '请输入语音名称' });
    }
    const name = voiceName.trim();
    const voices = scanVoices();
    const exists = voices.find(v => v.name === name);
    res.json({ success: true, available: !exists, exists: !!exists });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 分配语音给角色 */
app.post('/api/characters/:id/voice', (req, res) => {
  try {
    const charId = req.params.id;
    const { voiceName } = req.body;
    if (!voiceName) return res.json({ success: false, error: '缺少 voiceName' });
    const voices = scanVoices();
    const exists = voices.find(v => v.name === voiceName);
    if (!exists) return res.json({ success: false, error: '语音不存在: ' + voiceName });
    const map = readCharacterVoiceMap();
    map[charId] = voiceName;
    writeCharacterVoiceMap(map);
    // 角色绑定优先保存到角色目录；共享 map 作为旧版本兼容镜像。
    writeCharacterVoiceSettings(charId, voiceName);
    res.json({ success: true, charId, voiceName });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 获取角色当前语音 */
app.get('/api/characters/:id/voice', (req, res) => {
  try {
    const charId = req.params.id;
    const voiceName = getCharacterVoiceName(charId);
    res.json({ success: true, charId, voiceName });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 重命名语音（同时更新目录名 + config.json + 角色映射） */
app.post('/api/voices/:oldName/rename', (req, res) => {
  try {
    const oldName = req.params.oldName;
    const { newName } = req.body;
    if (!newName || !newName.trim()) {
      return res.json({ success: false, error: '请输入新名称' });
    }
    const newNameSafe = newName.trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!newNameSafe || newNameSafe === '.' || newNameSafe === '..') {
      return res.json({ success: false, error: '名称包含无效字符' });
    }
    if (newNameSafe === oldName) {
      return res.json({ success: false, error: '新名称与原名称相同' });
    }
    const voices = scanVoices();
    const target = voices.find(v => v.name === oldName);
    if (!target) {
      return res.json({ success: false, error: `语音 "${oldName}" 不存在` });
    }
    if (target.source !== 'user') {
      return res.json({ success: false, error: '包内基础声音和旧架构声音不可重命名；只能重命名用户新克隆的声音' });
    }
    // 检查新名称是否冲突
    if (voices.find(v => v.name === newNameSafe)) {
      return res.json({ success: false, error: `名称 "${newNameSafe}" 已被占用` });
    }
    const oldDir = target.voice_dir;
    const parentDir = path.dirname(oldDir);
    const newDir = path.join(parentDir, newNameSafe);
    // 重命名目录
    fs.renameSync(oldDir, newDir);
    // 更新 config.json 中的 voice_name / character_name
    const cfgPath = path.join(newDir, 'config.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        cfg.voice_name = newNameSafe;
        if (cfg.character_name) cfg.character_name = newNameSafe;
        writeJsonAtomic(cfgPath, cfg);
      } catch (e) { /* config 更新失败不阻塞 */ }
    }
    // 更新角色→语音映射
    const map = readCharacterVoiceMap();
    let mapChanged = false;
    for (const k of Object.keys(map)) {
      if (map[k] === oldName) { map[k] = newNameSafe; mapChanged = true; }
    }
    if (mapChanged) writeCharacterVoiceMap(map);
    // Character-local settings are authoritative in the new architecture;
    // keep them in sync with the shared compatibility map.
    forEachCharacterVoiceSetting((charId, settings) => {
      if (settings.voiceName === oldName) writeCharacterVoiceSettings(charId, newNameSafe);
    });
    res.json({ success: true, oldName, newName: newNameSafe });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 删除语音（移到回收站，仅 userData 中 source='user' 的用户克隆声音可删）
 * 改进：删除前先切换走当前语音 + 重启 TTS 引擎释放文件锁 + 重试机制
 */
app.delete('/api/voices/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const voices = scanVoices();
    const target = voices.find(v => v.name === name);
    if (!target) {
      return res.json({ success: false, error: `语音 "${name}" 不存在` });
    }
    if (target.source !== 'user') {
      return res.json({ success: false, error: '包内基础声音和旧架构声音不可删除；只能删除用户新克隆的声音' });
    }
    const targetDir = target.voice_dir;
    if (!fs.existsSync(targetDir)) {
      return res.json({ success: false, error: '语音目录不存在' });
    }
    // 安全检查：可删除目标必须精确位于 userData/voices/<name>。
    if (path.resolve(targetDir).toLowerCase() !== path.resolve(path.join(USER_VOICES_DIR, name)).toLowerCase()) {
      return res.json({ success: false, error: '路径校验失败，拒绝删除' });
    }

    // 1) 如果要删的是当前正在使用的语音，先切换走（避免 TTS 引擎占用文件）
    const charId = getCurrentCharacterId();
    const currentVoice = getCharacterVoiceName(charId);
    if (currentVoice === name) {
      // 切换到第一个可用的其他语音
      const fallback = voices.find(v => v.name !== name && v.source === 'user')
                    || voices.find(v => v.name !== name && v.source === 'bundled')
                    || voices.find(v => v.name !== name);
      if (fallback) {
        const map = readCharacterVoiceMap();
        map[charId] = fallback.name;
        writeCharacterVoiceMap(map);
        writeCharacterVoiceSettings(charId, fallback.name);
        console.log(`[Voices] 删除前切换语音: ${name} → ${fallback.name}`);
      }
    }

    // 2) 重启 TTS 引擎释放文件锁（kill 旧进程，下次合成时自动重启）
    try {
      if (_ttsProcess && !_ttsProcess.killed) {
        console.log('[Voices] 重启 TTS 引擎以释放文件锁');
        await terminateTrackedTTSProcess('voice-delete-file-lock');
      }
    } catch (e) {
      console.log('[Voices] TTS 引擎重启失败（不影响删除）:', e.message);
    }

    // 3) 带重试的删除（文件锁可能需要几秒才释放）
    const { execFile } = require('child_process');
    const escapedTargetDir = targetDir.replace(/'/g, "''");
    const psScript = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${escapedTargetDir}', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)`;

    const tryDelete = () => new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: 30000 }, (err) => {
          // Some shell/recycle-bin providers report success before the
          // directory is fully moved. Treat a remaining directory as failure
          // so the retry/fallback path can finish deterministically.
          resolve(err || (fs.existsSync(targetDir) ? new Error('语音目录仍存在') : null));
        });
    });

    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      lastErr = await tryDelete();
      if (!lastErr) break;
      console.log(`[Voices] 删除尝试 ${attempt}/3 失败: ${lastErr.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }

    if (lastErr) {
      // 回收站不可用时按用户要求退回到彻底删除；目标路径此前已做
      // 精确 userData/voices/<name> 校验，不允许删除其他目录。
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
        if (fs.existsSync(targetDir)) throw new Error('目录仍存在');
        console.warn('[Voices] 回收站不可用，已彻底删除语音目录:', targetDir);
      } catch (fallbackError) {
        console.error('[Voices] 删除最终失败:', lastErr.message, fallbackError.message);
        return res.json({
          success: false,
          error: `删除失败（文件可能被占用）：${lastErr.message}。请先切换到其他语音，等待几秒后再试。`
        });
      }
    }

    // 4) 清理角色→语音映射中被删除的项
    const map = readCharacterVoiceMap();
    let mapChanged = false;
    for (const k of Object.keys(map)) {
      if (map[k] === name) { delete map[k]; mapChanged = true; }
    }
    if (mapChanged) writeCharacterVoiceMap(map);
    // Do not leave stale character-local pointers to a deleted directory.
    const replacement = voices.find(v => v.name !== name && v.source === 'user')
      || voices.find(v => v.name !== name && v.source === 'bundled')
      || voices.find(v => v.name !== name);
    forEachCharacterVoiceSetting((characterId, settings, settingsPath) => {
      if (settings.voiceName !== name) return;
      if (replacement) writeCharacterVoiceSettings(characterId, replacement.name);
      else fs.rmSync(settingsPath, { force: true });
    });
    res.json({ success: true, deleted: name });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 列出某角色的表情包（character/<id>/表情包/） */
app.get('/api/character-stickers/:id', (req, res) => {
  try {
    const charId = req.params.id;
    const stickers = stickerService.listStickers(charId);
    res.json({ success: true, characterId: charId, stickers });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 取单个表情包图片 */
app.get('/api/character-sticker/:id/:filename', (req, res) => {
  try {
    const { id, filename } = req.params;
    const filePath = stickerService.getStickerPath(id, filename);
    if (!filePath) return res.status(404).send('Not found');
    res.sendFile(filePath);
  } catch (e) {
    res.status(404).send('Not found');
  }
});

/** 按 name（大范围-细分，无扩展名）查找表情包图片，前端用此构造 URL */
app.get('/api/character-sticker-by-name/:id/:name', (req, res) => {
  try {
    const { id, name } = req.params;
    const stickers = stickerService.listStickers(id);
    const target = stickers.find(s => s.name === name);
    if (!target) return res.status(404).send('Not found');
    const filePath = stickerService.getStickerPath(id, target.filename);
    if (!filePath) return res.status(404).send('Not found');
    res.sendFile(filePath);
  } catch (e) {
    res.status(404).send('Not found');
  }
});

/** 列出可选角色（兼容旧接口） */
app.get('/api/voice-train/characters', (req, res) => {
  try {
    const charDir = CHARACTER_DIR;
    if (!fs.existsSync(charDir)) return res.json({ success: true, characters: [] });
    const ids = fs.readdirSync(charDir).filter(d =>
      fs.statSync(path.join(charDir, d)).isDirectory() &&
      fs.existsSync(path.join(charDir, d, 'character.md'))
    );
    const characters = ids.map(id => {
      let name = id;
      let avatar = 'character.png';
      try {
        const profilePath = path.join(charDir, id, 'profile.json');
        if (fs.existsSync(profilePath)) {
          const p = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
          if (p.name) name = p.name;
          if (p.avatar) avatar = p.avatar;
        }
      } catch {}
      if (fs.existsSync(path.join(charDir, id, 'character.png'))) {
        avatar = `/character/${id}/character.png`;
      }
      const hasVoiceFlag = hasVoice(id);
      return { id, name, avatar, hasVoice: hasVoiceFlag };
    });
    res.json({ success: true, characters });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 自动检测 GPT-SoVITS 和 voice-cloning 路径 */
app.get('/api/voice-train/detect-paths', async (req, res) => {
  const result = { success: true, gptSoVitsRoot: '', voiceCloningDir: '' };
  const requestedGptRoot = req.query.gptSoVitsRoot ? path.resolve(String(req.query.gptSoVitsRoot)) : '';
  // GPT-SoVITS: 优先使用 runtimeFlavor.gptSoVitsRoot（发布包内 GPT-SoVITS-lite）
  const flavorGptRoot = runtimeFlavor.gptSoVitsRoot;
  if (requestedGptRoot && fs.existsSync(requestedGptRoot)) {
    result.gptSoVitsRoot = requestedGptRoot;
  } else if (flavorGptRoot && fs.existsSync(flavorGptRoot)) {
    result.gptSoVitsRoot = flavorGptRoot;
  }
  // 回退：从 .env / 环境变量 / 常见位置（开发模式）
  if (!result.gptSoVitsRoot) {
    result.gptSoVitsRoot = process.env.GPT_SOVITS_ROOT || '';
    if (!result.gptSoVitsRoot || !fs.existsSync(result.gptSoVitsRoot)) {
      for (const c of [path.join(__dirname, 'GPT-SoVITS-lite')]) {
        if (fs.existsSync(c)) { result.gptSoVitsRoot = c; break; }
      }
    }
  }
  // 克隆工具链是 voice_engine/train_pipeline_v2.py，不是推理用的 tts_engine。
  const voiceCloningDir = path.join(__dirname, 'voice_engine');
  if (fs.existsSync(path.join(voiceCloningDir, 'train_pipeline_v2.py'))) {
    result.voiceCloningDir = voiceCloningDir;
  }
  result.flavor = runtimeFlavor.flavor;
  result.preflight = await inspectVoiceClonePreflight({
    runtimeFlavor,
    requestedDevice: req.query.device || 'auto',
    appRoot: __dirname,
    gptSoVitsRoot: result.gptSoVitsRoot || runtimeFlavor.gptSoVitsRoot,
    inputMode: detectInputMode(req.query.inputPath || ''),
  });
  res.json(result);
});

/** 上传 MP3 文件 */
const vtUploadDir = path.join(TRAINING_DIR, '_uploads');
if (!fs.existsSync(vtUploadDir)) fs.mkdirSync(vtUploadDir, { recursive: true });
const vtUpload = multer({
  storage: multer.diskStorage({
    // 关键：一次上传的所有文件必须落到同一个目录
    // multer 对每个文件单独调用 destination，若每次都新建目录会导致
    // 多个文件被拆到多个 job_<ts> 目录，req._jobDir 被最后一个覆盖，
    // 前面的文件变成孤儿，无法参与训练。
    // 修复：用 req._jobDir 缓存目录路径，同一次请求的所有文件复用同一个目录。
    destination: (req, file, cb) => {
      if (!req._jobDir) {
        req._jobDir = path.join(vtUploadDir, 'job_' + Date.now());
        fs.mkdirSync(req._jobDir, { recursive: true });
      }
      cb(null, req._jobDir);
    },
    filename: (req, file, cb) => {
      // 保留原始文件名，安全处理
      const safeName = file.originalname.replace(/[^\w.\u4e00-\u9fa5\-]/g, '_');
      cb(null, safeName);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 * 1024 }, // 3GB（支持大视频上传）
});

// 查找 ffmpeg 可执行文件路径（缓存）
let _ffmpegPath = null;
function getFFmpegPath() {
  if (_ffmpegPath) return _ffmpegPath;
  // 只读取 ChatX2 已打包的 GPT-SoVITS 运行时。避免开发机 PATH 或系统
  // Python 的 imageio_ffmpeg 被意外使用，导致发布包在另一台机器上失效。
  // CHATX2_FFMPEG_PATH 仅供用户显式指定自定义运行时，不是隐式宿主机回退。
  const candidates = [
    process.env.CHATX2_FFMPEG_PATH,
    path.join(runtimeFlavor.gptSoVitsRoot, 'ffmpeg.exe'),
    path.join(runtimeFlavor.gptSoVitsRoot, 'tools', 'ffmpeg.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) { _ffmpegPath = c; return _ffmpegPath; }
  }
  return null;
}

// 视频扩展名检测
const VIDEO_EXTS = ['.mp4', '.avi', '.mkv', '.mov', '.webm'];
function isVideoFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return VIDEO_EXTS.includes(ext);
}

// multer 错误处理中间件：文件超限或上传出错时返回 JSON，避免返回 HTML 导致前端 JSON.parse 报 Unexpected token
app.use('/api/voice-train/upload', (err, req, res, next) => {
  if (err) {
    const isLimit = err.code === 'LIMIT_FILE_SIZE';
    return res.json({
      success: false,
      error: isLimit
        ? `文件超过大小限制（3GB）。大文件请改用"指定本地目录"方式。`
        : `上传失败: ${err.message || err.code || '未知错误'}`,
    });
  }
  next();
});

app.post('/api/voice-train/upload', vtUpload.array('audio', 200), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.json({ success: false, error: '未收到文件' });
    }

    // 视频转音频：检测视频文件，用 ffmpeg 转为 16kHz mono wav（训练标准格式）
    // 转换成功后删除原视频文件（节省空间）；转换失败时保留原视频，
    // 让 train_pipeline 自己处理（其 step0/step1 也支持视频输入，作为兜底）
    const { spawnSync } = require('child_process');
    const ffmpeg = getFFmpegPath();
    const converted = [];
    const failed = [];

    for (const f of req.files) {
      if (!isVideoFile(f.originalname)) continue;
      const ffmpegExe = ffmpeg;
      if (!ffmpegExe) {
        failed.push({ file: f.originalname, error: '未找到 ffmpeg，保留原视频由训练脚本处理' });
        // 不删除视频文件，让 train_pipeline 处理
        continue;
      }
      const baseName = path.basename(f.originalname, path.extname(f.originalname));
      // 输出 wav：PCM 16-bit, 16kHz, 单声道 —— 语音训练标准格式
      const outWav = path.join(f.destination, baseName + '.wav');
      try {
        const r = spawnSync(ffmpegExe, [
          '-y',              // 覆盖输出
          '-i', f.path,       // 输入
          '-vn',              // 丢弃视频流
          '-acodec', 'pcm_s16le',  // PCM 16-bit
          '-ar', '16000',     // 16kHz 采样率
          '-ac', '1',         // 单声道
          '-loglevel', 'error', // 只输出错误，减少噪音
          outWav,
        ], { stdio: 'pipe', encoding: 'utf-8' });
        if (r.status !== 0) {
          const err = (r.stderr || '').trim().split('\n').slice(-3).join(' ');
          failed.push({ file: f.originalname, error: err || '转换失败，保留原视频由训练脚本处理' });
          try { fs.unlinkSync(outWav); } catch {} // 清理可能的部分输出
          // 不删除视频文件，让 train_pipeline 兜底处理
          continue;
        }
        // 转换成功后删除原视频文件，只保留转换后的 wav
        try { fs.unlinkSync(f.path); } catch {}
        converted.push({ from: f.originalname, to: baseName + '.wav' });
      } catch (e) {
        failed.push({ file: f.originalname, error: e.message });
      }
    }

    res.json({
      success: true,
      mp3Dir: req._jobDir,
      count: req.files.length,
      converted,
      failed,
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 启动训练任务 */
app.post('/api/voice-train/start', async (req, res) => {
  try {
    const { voiceName, mp3Dir, gptSoVitsRoot, localDir, device } = req.body;
    // 支持直接指定本地目录（跳过上传）
    const inputDir = localDir || mp3Dir;
    if (!voiceName || !voiceName.trim() || !inputDir) {
      return res.json({ success: false, error: '缺少参数（voiceName 和输入目录必填）' });
    }
    // 校验目录存在
    if (!fs.existsSync(inputDir)) {
      return res.json({ success: false, error: '输入目录不存在: ' + inputDir });
    }
    // 语音名称安全处理（去掉路径分隔符等非法字符）
    const safeName = voiceName.trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!safeName) {
      return res.json({ success: false, error: '语音名称无效' });
    }

    const { spawn } = require('child_process');
    const scriptPath = path.join(__dirname, 'voice_engine', 'train_pipeline_v2.py');
    const selectedGptRoot = gptSoVitsRoot && fs.existsSync(gptSoVitsRoot)
      ? path.resolve(gptSoVitsRoot)
      : runtimeFlavor.gptSoVitsRoot;
    const inputMode = detectInputMode(inputDir);
    const preflight = await inspectVoiceClonePreflight({
      runtimeFlavor,
      requestedDevice: device || 'auto',
      appRoot: __dirname,
      gptSoVitsRoot: selectedGptRoot,
      inputMode,
    });
    if (!preflight.ready) {
      return res.json({
        success: false,
        errorCode: 'VOICE_CLONE_PREFLIGHT_FAILED',
        error: '语音克隆环境未就绪，请先解决预检中列出的缺失项',
        preflight,
      });
    }
    const trainingRuntime = selectTrainingRuntime(device || 'auto', runtimeFlavor);

    // 预检通过后才清理旧任务并创建新工作目录。
    cleanupUnfinishedTrainJobs();
    const jobId = 'job_' + Date.now();

    // 生成工作目录（传给 Python，用于 state.json 持久化）
    const workDir = path.join(TRAIN_WORKROOT, `train_${safeName}_${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    const args = [
      scriptPath,
      '--voice-name', safeName,
      '--input', inputDir,
      '--project-root', __dirname,
      '--work-dir', workDir,
    ];
    args.push('--gpt-sovits-root', selectedGptRoot);
    const finalDevice = trainingRuntime.device;
    args.push('--device', finalDevice);

    const child = spawn(trainingRuntime.pythonExe, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        APP_ROOT: __dirname,
        APP_DATA_DIR: APP_DATA_ROOT,
        CHARACTER_DIR,
        GPT_SOVITS_ROOT: selectedGptRoot,
        USER_VOICES_DIR,
        TTS_OUTPUT_DIR: VOICE_OUTPUT_DIR,
        CHATX2_TTS_PORT: process.env.CHATX2_TTS_PORT || '9882',
      },
    });
    const job = { status: 'running', progress: 0, logs: [], startTime: Date.now(), process: child, workDir, voiceName: safeName, input: inputDir, device: finalDevice, pythonExe: trainingRuntime.pythonExe, gptSoVitsRoot: selectedGptRoot };
    _trainJobs.set(jobId, job);

    // 捕获 stdout（JSON 进度行）
    let buf = '';
    child.stdout.on('data', (data) => {
      buf += data.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          appendTrainLog(job, evt);
          if (evt.progress !== undefined) job.progress = evt.progress;
          if (evt.status === 'done' && evt.stage === 'all') job.status = 'done';
          if (evt.status === 'error') { job.status = 'error'; job.errorMsg = evt.msg; }
        } catch {}
      }
    });
    child.stderr.on('data', (data) => {
      // stderr 不一定是错误（jieba/torch/tqdm 都会输出到 stderr），用 status='running' 避免误触发前端错误处理
      appendTrainLog(job, { stage: 'stderr', status: 'running', msg: data.toString().trim() });
    });
    child.on('close', (code) => {
      if (job.status === 'running') job.status = code === 0 ? 'done' : 'error';
      // 兜底：子进程非零退出但未捕获 errorMsg（如 OS OOM 杀掉、segfault、
      // 模块级 import 崩溃等），从 stderr 日志收集最后几行作为错误信息，
      // 避免前端显示空错误，方便定位问题
      if (job.status === 'error' && !job.errorMsg) {
        const stderrLines = job.logs
          .filter(l => l.stage === 'stderr' && l.msg)
          .slice(-5)
          .map(l => l.msg)
          .join('\n');
        job.errorMsg = stderrLines || `子进程退出码 ${code}（无 stderr 输出，可能是 OS 强制终止或崩溃）`;
      }
      // 训练成功后清理上传的临时文件目录（_train_uploads/job_<ts>/）
      // 失败时保留 30 分钟供调试，之后清理避免磁盘累积
      const uploadDir = inputDir && inputDir.startsWith(vtUploadDir) ? inputDir : null;
      const delay = job.status === 'done' ? 30 * 1000 : 30 * 60 * 1000;
      if (uploadDir) {
        setTimeout(() => {
          try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}
        }, delay);
      }
      // 训练结束后延迟清理 job（参考 distillTasks 的 10 分钟清理模式），避免 _trainJobs Map 无限增长导致内存泄漏
      // 注意：paused 状态不自动清理（用户可能稍后继续），由 /resume 或 /delete 端点处理
      if (job.status !== 'paused') {
        setTimeout(() => _trainJobs.delete(jobId), 10 * 60 * 1000);
      }
    });

    res.json({ success: true, jobId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** SSE 进度流 */
app.get('/api/voice-train/progress/:jobId', (req, res) => {
  const job = _trainJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '任务不存在' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let sentCursor = Math.max(0, Number(job.logBaseIndex) || 0);
  const sendUpdate = () => {
    const replay = readTrainLogsSince(job, sentCursor);
    for (const entry of replay.entries) {
      res.write('data: ' + JSON.stringify(entry) + '\n\n');
    }
    sentCursor = replay.nextCursor;
    if (job.status !== 'running') {
      res.write('data: ' + JSON.stringify({ stage: 'final', status: job.status, progress: job.progress, msg: job.errorMsg || '' }) + '\n\n');
      res.end();
      return true;
    }
    return false;
  };
  // 先发送已有日志
  if (sendUpdate()) return;
  // 轮询新日志
  const timer = setInterval(() => {
    if (sendUpdate()) clearInterval(timer);
  }, 500);
  req.on('close', () => clearInterval(timer));
});

/** 清理旧的未完成训练进程（启动新训练前自动调用） */
function cleanupUnfinishedTrainJobs() {
  try {
    // 1. 清理内存中 status !== 'done' 且非当前运行的 job
    for (const [jid, j] of _trainJobs) {
      if (j.status === 'paused' || j.status === 'interrupted') {
        try { if (j.workDir && fs.existsSync(j.workDir)) fs.rmSync(j.workDir, { recursive: true, force: true }); } catch {}
        _trainJobs.delete(jid);
      }
    }
    // 2. 扫描 TRAIN_WORKROOT 下的 state.json，删除未完成的 work_dir
    if (fs.existsSync(TRAIN_WORKROOT)) {
      for (const entry of fs.readdirSync(TRAIN_WORKROOT)) {
        const workDir = path.join(TRAIN_WORKROOT, entry);
        const stateFile = path.join(workDir, 'state.json');
        if (!fs.existsSync(stateFile)) continue;
        try {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          // 只清理未完成的（status !== 'done'）
          if (state.status !== 'done' && state.stage !== 'all') {
            fs.rmSync(workDir, { recursive: true, force: true });
          }
        } catch {}
      }
    }
  } catch (e) {
    console.warn('[train] cleanupUnfinishedTrainJobs error:', e.message);
  }
}

/** 暂停训练任务（kill 进程，保留 work_dir + state.json） */
app.post('/api/voice-train/pause/:jobId', (req, res) => {
  const job = _trainJobs.get(req.params.jobId);
  if (!job) return res.json({ success: false, error: '任务不存在' });
  if (job.status !== 'running') return res.json({ success: false, error: `任务状态为 ${job.status}，无法暂停` });
  try {
    if (job.process && !job.process.killed) {
      // Windows 下 taskkill /T 杀进程树
      try { require('child_process').execSync(`taskkill /F /PID ${job.process.pid} /T`, { stdio: 'ignore' }); } catch {}
    }
    job.status = 'paused';
    res.json({ success: true, message: '已暂停，可点击继续恢复训练', workDir: job.workDir });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 继续训练任务（用 --resume 重启 Python 脚本） */
app.post('/api/voice-train/resume/:jobId', async (req, res) => {
  const jobId = req.params.jobId;
  let job = _trainJobs.get(jobId);
  // 磁盘任务（页面被关/服务重启后从 state.json 恢复）
  // 支持两种 jobId 格式：disk_<entry> 和直接 entry（内存 job 被清理后的兜底）
  if (!job) {
    const entry = jobId.startsWith('disk_') ? jobId.slice(5) : jobId;
    const workDir = path.join(TRAIN_WORKROOT, entry);
    const stateFile = path.join(workDir, 'state.json');
    if (!fs.existsSync(stateFile)) return res.json({ success: false, error: '任务不存在（state.json 已丢失）' });
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      job = {
        status: 'interrupted',
        progress: state.progress || 0,
        logs: [],
        startTime: state.timestamp ? state.timestamp * 1000 : Date.now(),
        process: null,
        workDir,
        voiceName: state.voice_name || state.voiceName || entry,
        input: state.input || '',
        device: state.device || 'auto',
        gptSoVitsRoot: state.gpt_root || state.gptSoVitsRoot || runtimeFlavor.gptSoVitsRoot || '',
      };
      // 注册到内存，后续 SSE 可用
      _trainJobs.set(jobId, job);
    } catch (e) {
      return res.json({ success: false, error: '读取 state.json 失败: ' + e.message });
    }
  }
  if (!job) return res.json({ success: false, error: '任务不存在' });
  // 允许从 paused/interrupted/error 状态继续（error 表示崩溃后重试，--resume 会跳过已完成阶段）
  if (job.status !== 'paused' && job.status !== 'interrupted' && job.status !== 'error') {
    return res.json({ success: false, error: `任务状态为 ${job.status}，无法继续` });
  }
  try {
    const { spawn } = require('child_process');
    const scriptPath = path.join(__dirname, 'voice_engine', 'train_pipeline_v2.py');
    const selectedGptRoot = job.gptSoVitsRoot || runtimeFlavor.gptSoVitsRoot;
    const preflight = await inspectVoiceClonePreflight({
      runtimeFlavor,
      requestedDevice: job.device || 'auto',
      appRoot: __dirname,
      gptSoVitsRoot: selectedGptRoot,
      inputMode: detectInputMode(job.input),
    });
    if (!preflight.ready) {
      return res.json({
        success: false,
        errorCode: 'VOICE_CLONE_PREFLIGHT_FAILED',
        error: '语音克隆环境未就绪，无法恢复训练',
        preflight,
      });
    }
    const trainingRuntime = selectTrainingRuntime(job.device || 'auto', runtimeFlavor);
    const args = [
      scriptPath,
      '--voice-name', job.voiceName,
      '--input', job.input,
      '--project-root', __dirname,
      '--work-dir', job.workDir,
      '--resume',
    ];
    args.push('--gpt-sovits-root', selectedGptRoot);
    args.push('--device', trainingRuntime.device);
    const child = spawn(trainingRuntime.pythonExe, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        APP_ROOT: __dirname,
        APP_DATA_DIR: APP_DATA_ROOT,
        CHARACTER_DIR,
        GPT_SOVITS_ROOT: selectedGptRoot,
        USER_VOICES_DIR,
        TTS_OUTPUT_DIR: VOICE_OUTPUT_DIR,
        CHATX2_TTS_PORT: process.env.CHATX2_TTS_PORT || '9882',
      },
    });
    job.process = child;
    job.device = trainingRuntime.device;
    job.pythonExe = trainingRuntime.pythonExe;
    job.status = 'running';
    resetTrainLogs(job); // 清空旧日志，前端重新订阅 SSE

    // 重新绑定 stdout/stderr
    let buf = '';
    child.stdout.on('data', (data) => {
      buf += data.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          appendTrainLog(job, evt);
          if (evt.progress !== undefined) job.progress = evt.progress;
          if (evt.status === 'done' && evt.stage === 'all') job.status = 'done';
          if (evt.status === 'error') { job.status = 'error'; job.errorMsg = evt.msg; }
        } catch {}
      }
    });
    child.stderr.on('data', (data) => {
      appendTrainLog(job, { stage: 'stderr', status: 'running', msg: data.toString().trim() });
    });
    child.on('close', (code) => {
      if (job.status === 'running') job.status = code === 0 ? 'done' : 'error';
      if (job.status !== 'paused') {
        setTimeout(() => _trainJobs.delete(jobId), 10 * 60 * 1000);
      }
    });

    res.json({ success: true, message: '已从断点继续训练' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 删除未完成训练任务（杀进程 + 删 work_dir + 删 state.json） */
app.post('/api/voice-train/delete/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = _trainJobs.get(jobId);
  try {
    // 杀进程（内存任务才有 process）
    if (job && job.process && !job.process.killed) {
      try { require('child_process').execSync(`taskkill /F /PID ${job.process.pid} /T`, { stdio: 'ignore' }); } catch {}
    }
    // 删除工作目录（含 state.json）
    const workDir = job ? job.workDir : (jobId.startsWith('disk_') ? path.join(TRAIN_WORKROOT, jobId.slice(5)) : null);
    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    if (job) _trainJobs.delete(jobId);
    res.json({ success: true, message: '已删除未完成进程' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/** 获取所有训练任务（用于页面加载时恢复未完成进程列表） */
app.get('/api/voice-train/jobs', (req, res) => {
  const jobs = [];
  // 1. 内存中的任务
  for (const [jid, j] of _trainJobs) {
    if (j.status !== 'done') {
      jobs.push({
        jobId: jid,
        status: j.status,
        voiceName: j.voiceName,
        input: j.input || '',
        device: j.device || 'auto',
        progress: j.progress,
        startTime: j.startTime,
        workDir: j.workDir,
      });
    }
  }
  // 2. 扫描磁盘上的 state.json（页面被关/服务重启后恢复）
  if (fs.existsSync(TRAIN_WORKROOT)) {
    for (const entry of fs.readdirSync(TRAIN_WORKROOT)) {
      const workDir = path.join(TRAIN_WORKROOT, entry);
      const stateFile = path.join(workDir, 'state.json');
      if (!fs.existsSync(stateFile)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        if (state.status === 'done') continue; // 跳过已完成的
        // 避免与内存中的重复
        if (jobs.find(j => j.workDir === workDir)) continue;
        jobs.push({
          jobId: 'disk_' + entry,
          status: 'interrupted',
          voiceName: state.voice_name || state.voiceName || entry,
          input: state.input || '',
          device: state.device || 'auto',
          progress: state.progress || 0,
          startTime: state.timestamp ? state.timestamp * 1000 : 0,
          workDir,
          stage: state.stage,
          completedStages: state.completed_stages || [],
        });
      } catch {}
    }
  }
  console.log(`[train] /jobs: ${jobs.length} unfinished jobs found (memory: ${[..._trainJobs.values()].filter(j => j.status !== 'done').length}, disk: ${jobs.length - [..._trainJobs.values()].filter(j => j.status !== 'done').length})`);
  res.json({ success: true, jobs });
});

// [CHAT6-COMPAT] 监听地址限定为 127.0.0.1（B5 决策：不绑定 0.0.0.0）
// 注意：chat5-compat 当前为静态源码，依赖未安装，不可运行
app.listen(PORT, '127.0.0.1', () => {
  const info = aiClient.getProviderInfo();
  const charId = getCurrentCharacterId();
  const profile = promptBuilder.readCharacterProfile(charId);

  // 新对话只在进入压缩节点时写入旧原文归档。启动时不再把尚未压缩的活动历史
  // 全量复制进 RAG，以免普通近期聊天被当作“长期旧记忆”重复注入。

  console.log('========================================');
  console.log('  AI 聊天应用已启动（多角色版·记忆RAG）');
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  当前角色: ${profile.name || charId}`);
  console.log(`  模型: ${info.provider} / ${info.model}`);
  console.log(`  API Key: ${info.configured ? '已配置' : '未配置'}`);
  if (!info.configured) {
    console.log('');
    console.log('  ⚠先配置 API Key:');
    console.log('  打开页面后点击左上角 ← 进入设置页面');
  }
  console.log('========================================');

  // 主动消息由前端统一调度；保留兼容函数但不会启动后端定时器。
  startProactiveTimer();
  console.log('[ProactiveTimer] 前端统一按阶梯计划调度主动消息');
});
