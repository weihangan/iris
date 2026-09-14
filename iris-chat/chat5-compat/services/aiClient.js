// owner-trace: wha1999/core/ai-client
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./appPaths');

const REGISTRY_PATH = path.join(DATA_DIR, 'provider_registry.json');

// 当前角色的运行时 API 配置。为 null 时兼容旧的环境变量；一旦设置，
// 即使 apiKey 为空也不再回退到其他角色残留的环境变量。
let activeSettings = null;

function normalizeRuntimeSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return {
    provider: String(source.provider || 'custom').trim().toLowerCase(),
    apiKey: source.apiKey === undefined || source.apiKey === null ? '' : String(source.apiKey),
    baseUrl: source.baseUrl === undefined || source.baseUrl === null ? '' : String(source.baseUrl),
    model: source.model === undefined || source.model === null ? '' : String(source.model),
    capability: ['flash', 'fast'].includes(String(source.capability || '').toLowerCase())
      ? String(source.capability).toLowerCase() : '',
    reasoning: ['low', 'medium', 'high'].includes(String(source.reasoning || '').toLowerCase())
      ? String(source.reasoning).toLowerCase() : '',
  };
}

const DEFAULT_REGISTRY = {
  deepseek: {
    name: 'DeepSeek',
    website: '',
    defaultBaseUrl: '',
    defaultModel: '',
    models: [],
    flashModels: [],
    reasoningLevels: ['low', 'medium', 'high'],
    supportsModelSync: true,
  },
  glm: {
    name: 'GLM / 智谱',
    website: '',
    defaultBaseUrl: '', defaultModel: '', models: [], flashModels: [], reasoningLevels: ['low', 'medium', 'high'],
    supportsModelSync: true,
  },
  doubao: {
    name: 'Doubao / 火山方舟',
    website: '',
    defaultBaseUrl: '',
    defaultModel: '',
    models: [],
    supportsModelSync: true,
  },
  kimi: {
    name: 'Kimi / Moonshot',
    website: '',
    defaultBaseUrl: '', defaultModel: '', models: [], flashModels: [], reasoningLevels: ['low', 'medium', 'high'],
    supportsModelSync: true,
  },
  openai: {
    name: 'OpenAI',
    website: '',
    defaultBaseUrl: '', defaultModel: '', models: [], flashModels: [], reasoningLevels: ['low', 'medium', 'high'],
    supportsModelSync: true,
  },
  qwen: {
    name: 'Qwen / 通义千问',
    website: '',
    defaultBaseUrl: '', defaultModel: '', models: [], flashModels: [], reasoningLevels: ['low', 'medium', 'high'],
    supportsModelSync: true,
  },
  siliconflow: {
    name: 'SiliconFlow / 硅基流动',
    website: '',
    defaultBaseUrl: '',
    defaultModel: '',
    models: [],
    supportsModelSync: true,
  },
  claude: {
    name: 'Claude / Anthropic',
    website: '',
    defaultBaseUrl: '', defaultModel: '', models: [], flashModels: [], reasoningLevels: ['low', 'medium', 'high'],
    supportsModelSync: false,
  },
  agnes: {
    name: 'Agnes AI',
    website: '',
    defaultBaseUrl: '',
    defaultModel: '',
    models: [],
    supportsModelSync: true,
  },
  custom: {
    name: '自定义 API',
    website: '',
    defaultBaseUrl: '',
    defaultModel: '',
    models: [],
    supportsModelSync: false,
  },
};

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const data = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      const saved = JSON.parse(data);
      const merged = JSON.parse(JSON.stringify(DEFAULT_REGISTRY));
      for (const [key, val] of Object.entries(saved)) {
        if (merged[key]) {
          merged[key] = { ...merged[key], ...val };
        } else {
          merged[key] = val;
        }
      }
      return merged;
    }
  } catch (e) {
    console.error('[AI Client] 读取provider_registry.json失败:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_REGISTRY));
}

function saveRegistry(registry) {
  try {
    const dir = path.dirname(REGISTRY_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[AI Client] 保存provider_registry.json失败:', e.message);
    return false;
  }
}

function initRegistryFile() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    saveRegistry(DEFAULT_REGISTRY);
    console.log('[Init] 创建 provider_registry.json');
  }
}

initRegistryFile();

function setActiveSettings(settings) {
  activeSettings = normalizeRuntimeSettings(settings);
  return { ...activeSettings };
}

function clearActiveSettings() {
  activeSettings = null;
}

function getConfig(settingsOverride = null) {
  const runtime = settingsOverride && typeof settingsOverride === 'object'
    ? normalizeRuntimeSettings(settingsOverride)
    : activeSettings;
  const provider = (runtime ? runtime.provider : process.env.AI_PROVIDER || 'custom').toLowerCase();
  const registry = loadRegistry();
  const info = registry[provider] || registry.deepseek;

  const envKeyMap = {
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

  const envKeys = envKeyMap[provider] || envKeyMap.deepseek;

  const config = {
    apiKey: runtime ? runtime.apiKey : process.env[envKeys.key] || '',
    baseUrl: runtime ? (runtime.baseUrl || info.defaultBaseUrl) : process.env[envKeys.url] || info.defaultBaseUrl,
    model: runtime ? (runtime.model || info.defaultModel) : process.env[envKeys.model] || info.defaultModel,
    capability: runtime ? runtime.capability : '',
    reasoning: runtime ? runtime.reasoning : '',
  };

  return { provider, config, registry: info };
}

async function chatWithAI(messages, options = {}) {
  const { provider, config, registry } = getConfig(options.settings);

  if (!config.apiKey) {
    throw new Error('API_KEY_NOT_CONFIGURED');
  }

  // Claude / Anthropic 使用不同的 API 格式
  if (provider === 'claude') {
    return chatWithClaude(messages, config, options);
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const payload = {
    model: options.model || config.model,
    messages: messages,
    temperature: options.temperature !== undefined ? options.temperature : 0.7,
    max_tokens: options.maxTokens || 1024,
    // 重复惩罚：frequency_penalty 惩罚高频 token，presence_penalty 鼓励新话题
    // top_p 核采样收窄分布，降低重复概率（OpenAI 兼容 API 通用值）
    top_p: options.topP !== undefined ? options.topP : 0.9,
    frequency_penalty: options.frequencyPenalty !== undefined ? options.frequencyPenalty : 0.5,
    presence_penalty: options.presencePenalty !== undefined ? options.presencePenalty : 0.4,
  };
  // Optional capability hints are sent only when selected. Providers that do
  // not understand them can safely ignore the OpenAI-compatible extensions.
  const capability = options.capability || config.capability;
  const reasoning = options.reasoning || config.reasoning;
  if (capability === 'flash') payload.service_tier = 'flex';
  if (capability === 'fast') payload.speed = 'fast';
  if (['low', 'medium', 'high'].includes(reasoning)) {
    payload.reasoning_effort = reasoning;
  }

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      timeout: options.timeout || 60000,
    });

    if (response.data && response.data.choices && response.data.choices.length > 0) {
      return response.data.choices[0].message.content;
    }

    throw new Error('API返回数据格式异常');
  } catch (error) {
    handleApiError(error, provider);
  }
}

async function chatWithClaude(messages, config, options = {}) {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/messages`;

  // Claude API: system 消息需要单独提取为顶层字段
  const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const chatMessages = messages.filter(m => m.role !== 'system');

  const payload = {
    model: options.model || config.model,
    max_tokens: options.maxTokens || 1024,
    messages: chatMessages,
  };
  if (systemMessages) {
    payload.system = systemMessages;
  }

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: options.timeout || 60000,
    });

    if (response.data && response.data.content && response.data.content.length > 0) {
      return response.data.content[0].text;
    }

    throw new Error('API返回数据格式异常');
  } catch (error) {
    handleApiError(error, 'claude');
  }
}

function handleApiError(error, provider) {
  if (error.response) {
    const status = error.response.status;
    const data = error.response.data;
    console.error(`[AI Client] API请求失败 (${provider}):`, status, JSON.stringify(data));
    if (status === 401) {
      throw new Error('API Key无效或已过期');
    } else if (status === 429) {
      throw new Error('API请求频率超限，请稍后再试');
    } else if (status === 500) {
      throw new Error('API服务端错误，请稍后再试');
    }
    throw new Error(`API请求失败: ${status}`);
  } else if (error.code === 'ECONNABORTED') {
    throw new Error('API请求超时，请稍后再试');
  } else if (error.code === 'ECONNREFUSED') {
    throw new Error('无法连接到API服务，请检查网络');
  }
  throw error;
}

function getProviderInfo(settingsOverride = null) {
  const { provider, config, registry } = getConfig(settingsOverride);
  const visionModel = VISION_MODELS[provider];
  const audioSupported = ['openai', 'glm', 'qwen'].includes(provider);
  return {
    provider,
    model: config.model,
    configured: !!config.apiKey,
    providerName: registry.name,
    website: registry.website,
    supportsImage: !!visionModel,
    supportsAudio: audioSupported,
    multimodal: !!visionModel || audioSupported,
  };
}

function getProviderRegistry() {
  return loadRegistry();
}

function updateProviderRegistry(key, updates) {
  const registry = loadRegistry();
  if (!registry[key]) {
    registry[key] = updates;
  } else {
    registry[key] = { ...registry[key], ...updates };
  }
  saveRegistry(registry);
  return registry;
}

function resetProviderRegistry() {
  saveRegistry(DEFAULT_REGISTRY);
  return JSON.parse(JSON.stringify(DEFAULT_REGISTRY));
}

async function syncModels(provider, apiKey, baseUrl) {
  const registry = loadRegistry();
  const info = registry[provider];

  if (!info) {
    throw new Error(`未知的Provider: ${provider}`);
  }

  if (!info.supportsModelSync) {
    throw new Error(`${info.name} 不支持自动同步模型列表，请手动编辑`);
  }

  if (!apiKey) {
    throw new Error('请先配置API Key');
  }

  const effectiveBaseUrl = baseUrl || info.defaultBaseUrl;
  if (!effectiveBaseUrl) {
    throw new Error('请先配置Base URL');
  }

  const url = `${effectiveBaseUrl.replace(/\/+$/, '')}/models`;

  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 15000,
    });

    if (response.data && response.data.data && Array.isArray(response.data.data)) {
      const modelIds = response.data.data
        .map(m => m.id)
        .filter(id => id && typeof id === 'string')
        .sort();

      if (modelIds.length === 0) {
        throw new Error('API返回的模型列表为空');
      }

      registry[provider].models = modelIds;

      if (!registry[provider].defaultModel && modelIds.length > 0) {
        registry[provider].defaultModel = modelIds[0];
      }

      saveRegistry(registry);

      console.log(`[AI Client] 同步${info.name}模型列表成功: ${modelIds.length}个模型`);
      return { provider, models: modelIds, count: modelIds.length };
    }

    throw new Error('API返回数据格式异常');
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      if (status === 401) {
        throw new Error('API Key无效或已过期');
      } else if (status === 404) {
        throw new Error('该Provider不支持模型列表查询');
      }
      throw new Error(`同步失败: HTTP ${status}`);
    }
    if (error.code === 'ECONNABORTED') {
      throw new Error('连接超时，请检查网络');
    }
    if (error.code === 'ECONNREFUSED') {
      throw new Error('无法连接到API服务');
    }
    throw error;
  }
}

// ============================================================
// 多模态识别：图片识别 + 语音转文字（用于自定义蒸馏）
// ============================================================

// 各provider的多模态视觉模型映射
const VISION_MODELS = {
  openai: 'gpt-4o-mini',
  glm: 'glm-4v-flash',
  qwen: 'qwen-vl-plus',
  doubao: 'doubao-vision-pro-32k',
  kimi: 'moonshot-v1-8k-vision-preview',
  siliconflow: 'Qwen/Qwen2-VL-72B-Instruct',
  deepseek: null, // deepseek-chat 不支持视觉，降级为文字描述
};

// 识别图片内容（聊天截图、手写信、朋友圈截图等）
async function recognizeImage(imageBase64, prompt, settingsOverride = null) {
  const { provider, config } = getConfig(settingsOverride);

  if (!config.apiKey) {
    throw new Error('API_KEY_NOT_CONFIGURED');
  }

  const visionModel = VISION_MODELS[provider];
  if (!visionModel) {
    // 不支持视觉的provider，返回提示
    return `[当前provider ${provider} 不支持图片识别，请切换到 OpenAI/GLM/Qwen 等支持视觉的provider。图片已保存但未识别。]`;
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const defaultPrompt = '请识别并提取这张图片中的所有文字内容。如果是聊天记录，请按对话格式输出（发送者：内容）。如果是手写信件、朋友圈截图、日记等，请完整提取文字内容。只输出识别到的文字，不要添加解释。';

  const payload = {
    model: visionModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt || defaultPrompt },
          { type: 'image_url', image_url: { url: imageBase64 } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 2000,
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      timeout: 60000,
    });

    if (response.data && response.data.choices && response.data.choices.length > 0) {
      return response.data.choices[0].message.content;
    }
    throw new Error('图片识别返回数据格式异常');
  } catch (error) {
    handleApiError(error, provider);
  }
}

// 语音转文字（使用OpenAI Whisper兼容接口，支持GLM/Qwen等）
async function transcribeAudio(audioBuffer, filename, mimeType, settingsOverride = null) {
  const { provider, config } = getConfig(settingsOverride);

  if (!config.apiKey) {
    throw new Error('API_KEY_NOT_CONFIGURED');
  }

  // 优先使用OpenAI兼容的 /audio/transcriptions 接口
  // 支持的provider: openai, glm(智谱), qwen(通义)
  const supportedProviders = ['openai', 'glm', 'qwen'];
  if (!supportedProviders.includes(provider)) {
    return `[当前provider ${provider} 不支持语音转文字，请切换到 OpenAI/GLM/Qwen。语音文件已保存但未转写。]`;
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;

  try {
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename, contentType: mimeType });
    formData.append('model', 'whisper-1');

    const response = await axios.post(url, formData, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        ...formData.getHeaders(),
      },
      timeout: 120000,
    });

    if (response.data && response.data.text) {
      return response.data.text;
    }
    throw new Error('语音转文字返回数据格式异常');
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return `[当前provider ${provider} 的API不支持语音转文字接口(/audio/transcriptions)。语音文件已保存但未转写。建议使用OpenAI。]`;
    }
    handleApiError(error, provider);
  }
}

module.exports = {
  chatWithAI,
  setActiveSettings,
  clearActiveSettings,
  getProviderInfo,
  getProviderRegistry,
  updateProviderRegistry,
  resetProviderRegistry,
  syncModels,
  recognizeImage,
  transcribeAudio,
};
