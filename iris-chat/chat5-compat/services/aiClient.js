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
    provider: String(source.provider || 'deepseek').trim().toLowerCase(),
    apiKey: source.apiKey === undefined || source.apiKey === null ? '' : String(source.apiKey),
    baseUrl: source.baseUrl === undefined || source.baseUrl === null ? '' : String(source.baseUrl),
    model: source.model === undefined || source.model === null ? '' : String(source.model),
  };
}

const DEFAULT_REGISTRY = {
  deepseek: {
    name: 'DeepSeek',
    website: 'https://platform.deepseek.com',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    supportsModelSync: true,
  },
  glm: {
    name: 'GLM / 智谱',
    website: 'https://open.bigmodel.cn',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4', 'glm-4-plus', 'glm-4-long', 'glm-4-flashx', 'glm-4-air', 'glm-4-airx', 'glm-4v', 'glm-4v-plus'],
    supportsModelSync: true,
  },
  doubao: {
    name: 'Doubao / 火山方舟',
    website: 'https://console.volcengine.com/ark',
    defaultBaseUrl: '',
    defaultModel: '',
    models: [],
    supportsModelSync: true,
  },
  kimi: {
    name: 'Kimi / Moonshot',
    website: 'https://platform.moonshot.cn',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    supportsModelSync: true,
  },
  openai: {
    name: 'OpenAI',
    website: 'https://platform.openai.com',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1-mini', 'o3-mini'],
    supportsModelSync: true,
  },
  qwen: {
    name: 'Qwen / 通义千问',
    website: 'https://dashscope.console.aliyun.com',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-turbo',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-long', 'qwen-max-latest', 'qwen-plus-latest', 'qwen-turbo-latest', 'qwen-vl-max', 'qwen-vl-plus'],
    supportsModelSync: true,
  },
  siliconflow: {
    name: 'SiliconFlow / 硅基流动',
    website: 'https://cloud.siliconflow.cn',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: '',
    models: [],
    supportsModelSync: true,
  },
  claude: {
    name: 'Claude / Anthropic',
    website: 'https://console.anthropic.com',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
    supportsModelSync: false,
  },
  agnes: {
    name: 'Agnes AI',
    website: 'https://platform.agnes-ai.com',
    defaultBaseUrl: 'https://apihub.agnes-ai.com/v1',
    defaultModel: 'agnes-2.0-flash',
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
  const provider = (runtime ? runtime.provider : process.env.AI_PROVIDER || 'deepseek').toLowerCase();
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

/**
 * 流式聊天：LLM 边生成边回调增量文本，返回完整回复。
 * onDelta(textChunk)：每收到一段文本增量立即回调（用于抢先 TTS 合成）。
 * 支持 OpenAI 兼容（deepseek/glm/doubao/kimi/openai/qwen...）与 Claude 流式。
 */
async function chatWithAIStream(messages, options = {}, onDelta = null) {
  const { provider, config, registry } = getConfig(options.settings);
  if (!config.apiKey) {
    throw new Error('API_KEY_NOT_CONFIGURED');
  }
  if (provider === 'claude') {
    return chatWithClaudeStream(messages, config, options, onDelta);
  }
  return chatWithOpenAIStream(messages, config, options, onDelta);
}

/** 解析 SSE 帧（data: {...}），逐帧回调解析后的 JSON */
function consumeSSE(stream, onData) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            onData(JSON.parse(data));
          } catch (e) { /* 忽略无法解析的帧 */ }
        }
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
}

async function chatWithOpenAIStream(messages, config, options, onDelta) {
  const provider = 'openai-compat';
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payload = {
    model: options.model || config.model,
    messages: messages,
    temperature: options.temperature !== undefined ? options.temperature : 0.7,
    max_tokens: options.maxTokens || 1024,
    top_p: options.topP !== undefined ? options.topP : 0.9,
    frequency_penalty: options.frequencyPenalty !== undefined ? options.frequencyPenalty : 0.5,
    presence_penalty: options.presencePenalty !== undefined ? options.presencePenalty : 0.4,
    stream: true,
  };
  let full = '';
  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      responseType: 'stream',
      timeout: options.timeout || 120000,
    });
    await consumeSSE(response.data, (json) => {
      const delta = json && json.choices && json.choices[0] && json.choices[0].delta
        ? json.choices[0].delta.content
        : undefined;
      if (typeof delta === 'string' && delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
    });
    return full;
  } catch (error) {
    handleApiError(error, provider);
  }
}

async function chatWithClaudeStream(messages, config, options, onDelta) {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/messages`;
  const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const chatMessages = messages.filter(m => m.role !== 'system');
  const payload = {
    model: options.model || config.model,
    max_tokens: options.maxTokens || 1024,
    messages: chatMessages,
    stream: true,
  };
  if (systemMessages) payload.system = systemMessages;
  let full = '';
  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      responseType: 'stream',
      timeout: options.timeout || 120000,
    });
    await consumeSSE(response.data, (json) => {
      if (json && json.type === 'content_block_delta'
        && json.delta && typeof json.delta.text === 'string') {
        const text = json.delta.text;
        full += text;
        if (onDelta) onDelta(text);
      }
    });
    return full;
  } catch (error) {
    handleApiError(error, 'claude');
  }
}

module.exports = {
  chatWithAI,
  chatWithAIStream,
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
