// owner-trace: wha1999/core/memory
const fs = require('fs');
const path = require('path');

const { DATA_DIR, CHARACTER_DIR } = require('./appPaths');
const { mergeEmotionObservation, selectRecentConversationContext } = require('./chatMemoryPolicy');
const { writeJsonAtomic } = require('./atomic-persistence');
const replyPerformancePolicy = require('./replyPerformancePolicy');

function nowDateStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

function nowDateTimeStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
}

function getCharacterDir(characterId) {
  return path.join(CHARACTER_DIR, characterId);
}

function getDataPath(characterId, filename) {
  return path.join(DATA_DIR, `${characterId}_${filename}`);
}

function readMemory(characterId) {
  const filePath = getDataPath(characterId, 'memory.json');
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('[MemoryService] 读取记忆失败:', error.message);
    return getDefaultMemory();
  }
}

function writeMemory(characterId, memory) {
  const filePath = getDataPath(characterId, 'memory.json');
  try {
    writeJsonAtomic(filePath, memory);
  } catch (error) {
    console.error('[MemoryService] 写入记忆失败:', error.message);
  }
}

function getDefaultMemory() {
  return {
    user_profile: {
      name: '',
      nickname: '',
      birthday: '',
      location: '',
      occupation: '',
    },
    preferences: {
      likes: [],
      dislikes: [],
      topics: [],
      communication_style: '',
    },
    emotional_state: {
      recent_mood: '',
      recent_mood_intensity: 0,
      recent_mood_trigger: '',
      recent_mood_source: '',
      recent_mood_confidence: 0,
      recent_stress: '',
      recent_troubles: [],
      last_updated: '',
      mood_trajectory: [], // 每项: { mood, intensity(1-5), trigger, timestamp }
    },
    // 角色自身情感状态（区别于用户情绪）：角色在与用户对话过程中展现/产生的情感
    character_emotional_state: {
      current_emotion: '',
      emotion_intensity: 0,
      emotion_trigger: '',
      emotion_trajectory: [], // 每项: { emotion, intensity, trigger, timestamp }
      last_updated: '',
    },
    important_events: [],
    character_events: [],
    session_summaries: [],
    relationship_notes: [],
    festival_notes: [],
    permanent_facts: [], // 每项: { fact, category, confidence(0-1), date, source, superseded_by? }
    summary: '',
  };
}

function clearMemory(characterId) {
  writeMemory(characterId, getDefaultMemory());
}

function applyEmotionObservation(memory, observation) {
  if (!memory.emotional_state) memory.emotional_state = getDefaultMemory().emotional_state;
  const state = memory.emotional_state;
  const normalized = {
    mood: String(observation.mood || '').trim(),
    intensity: Math.max(0, Math.min(5, Number(observation.intensity) || 0)),
    trigger: String(observation.trigger || '').trim().slice(0, 160),
    source: observation.source === 'explicit_user' ? 'explicit_user' : 'assistant_inference',
    confidence: Math.max(0, Math.min(1, Number(observation.confidence) || 0)),
    timestamp: observation.timestamp || nowDateTimeStr(),
  };
  if (!normalized.mood) return { acceptedAsCurrent: false };

  const current = state.recent_mood ? {
    mood: state.recent_mood,
    intensity: state.recent_mood_intensity || 0,
    trigger: state.recent_mood_trigger || '',
    source: state.recent_mood_source || 'assistant_inference',
    confidence: Number(state.recent_mood_confidence) || 0.5,
    timestamp: state.last_updated || '',
  } : null;
  const merged = mergeEmotionObservation(current, normalized);
  if (merged.acceptedAsCurrent) {
    state.recent_mood = normalized.mood;
    state.recent_mood_intensity = normalized.intensity;
    state.recent_mood_trigger = normalized.trigger;
    state.recent_mood_source = normalized.source;
    state.recent_mood_confidence = normalized.confidence;
    state.last_updated = normalized.timestamp;
  }

  if (!Array.isArray(state.mood_trajectory)) state.mood_trajectory = [];
  const last = state.mood_trajectory[state.mood_trajectory.length - 1];
  if (!last || last.mood !== normalized.mood || last.trigger !== normalized.trigger || last.source !== normalized.source) {
    state.mood_trajectory.push(normalized);
    if (state.mood_trajectory.length > 20) state.mood_trajectory = state.mood_trajectory.slice(-20);
  }
  return merged;
}

function updateMemoryFromMessage(characterId, userMessage) {
  const memory = readMemory(characterId);
  const msg = userMessage.toLowerCase();
  let updated = false;

  const namePatterns = [
    /(?:我叫|我的名字(?:是|叫)?)([^\s,，。！？]{1,10})/,
    /(?:以后|请|可以)?叫(?:我|作)([^\s,，。！？]{1,10})/,
  ];
  for (const pattern of namePatterns) {
    const match = msg.match(pattern);
    if (match) {
      const name = match[1].trim();
      if (name && name.length > 0 && name.length <= 10) {
        if (msg.includes('叫我') || msg.includes('叫作')) {
          memory.user_profile.nickname = name;
        } else {
          memory.user_profile.name = name;
        }
        updated = true;
      }
      break;
    }
  }

  const birthdayPatterns = [
    /(?:我(?:的)?生日(?:是|在)?|我(?:是|出生(?:在|于)?))(\d{1,2})月(\d{1,2})[日号]?/,
    /生日(?:是|在)?(\d{1,2})[\/\-](\d{1,2})/,
  ];
  for (const pattern of birthdayPatterns) {
    const match = msg.match(pattern);
    if (match) {
      memory.user_profile.birthday = `${match[1]}月${match[2]}日`;
      updated = true;
      break;
    }
  }

  const locationPatterns = [
    /(?:我(?:在|住|来自|是))([^\s,，。！？]{2,10}(?:市|省|区|县|镇|城))/,
    /(?:我(?:在|住|来自))([^\s,，。！？]{2,8})/,
  ];
  for (const pattern of locationPatterns) {
    const match = msg.match(pattern);
    if (match) {
      const loc = match[1].trim();
      if (loc.length >= 2) {
        memory.user_profile.location = loc;
        updated = true;
      }
      break;
    }
  }

  const occupationPatterns = [
    /(?:我(?:是|做|从事|干))([^\s,，。！？]{2,10}(?:工作|职业|工程师|设计师|老师|医生|学生|程序员|经理|总监|主管|员工|老板|自由))/,
    /(?:我的(?:工作|职业|职业是))([^\s,，。！？]{2,10})/,
  ];
  for (const pattern of occupationPatterns) {
    const match = msg.match(pattern);
    if (match) {
      memory.user_profile.occupation = match[1].trim();
      updated = true;
      break;
    }
  }

  const likePatterns = [
    /(?:我(?:很)?喜欢|我爱|我(?:最)?爱|我(?:挺)?偏好)([^\s,，。！？]{2,20})/g,
  ];
  for (const pattern of likePatterns) {
    let match;
    while ((match = pattern.exec(msg)) !== null) {
      const like = match[1].trim();
      if (like) {
        const conflictIdx = memory.preferences.dislikes.indexOf(like);
        if (conflictIdx !== -1) {
          memory.preferences.dislikes.splice(conflictIdx, 1);
        }
        if (!memory.preferences.likes.includes(like)) {
          memory.preferences.likes.push(like);
        }
        updated = true;
      }
    }
  }

  const dislikePatterns = [
    /(?:我(?:很)?讨厌|我不喜欢|我恨|我(?:最)?烦|我(?:挺)?反感)([^\s,，。！？]{2,20})/g,
  ];
  for (const pattern of dislikePatterns) {
    let match;
    while ((match = pattern.exec(msg)) !== null) {
      const dislike = match[1].trim();
      if (dislike) {
        const conflictIdx = memory.preferences.likes.indexOf(dislike);
        if (conflictIdx !== -1) {
          memory.preferences.likes.splice(conflictIdx, 1);
        }
        if (!memory.preferences.dislikes.includes(dislike)) {
          memory.preferences.dislikes.push(dislike);
        }
        updated = true;
      }
    }
  }

  const moodPatterns = [
    { pattern: /(?:我(?:很|超|特别)?开心|我(?:很|超|特别)?高兴|我(?:很|超|特别)?快乐|心情(?:很|超)?好|今天(?:很|超)?棒|太好了|好开心|嘿嘿|哈哈)/, mood: '开心', intensity: 4 },
    { pattern: /(?:我(?:很|特别)?难过|我(?:很|特别)?伤心|我(?:很|特别)?悲伤|心情(?:很|特别)?差|好难受|好痛苦|想哭|哭了)/, mood: '难过', intensity: 4 },
    { pattern: /(?:我(?:很|特别)?焦虑|我(?:很|特别)?紧张|我(?:很|特别)?不安|好焦虑|压力(?:很|特别)?大|心慌|坐立不安)/, mood: '焦虑', intensity: 4 },
    { pattern: /(?:我(?:很|特别)?累|我(?:很|特别)?疲惫|好累|好困|没精神|精疲力竭|撑不住)/, mood: '疲惫', intensity: 3 },
    { pattern: /(?:我(?:很|特别)?生气|我(?:很|特别)?愤怒|好气|气死|烦死|受不了)/, mood: '生气', intensity: 4 },
    { pattern: /(?:我(?:很|特别)?孤独|我(?:很|特别)?寂寞|好孤单|没人陪|一个人(?:都)?(?:没有|不在))/, mood: '孤独', intensity: 3 },
    { pattern: /(?:我(?:很|特别)?害怕|我(?:很|特别)?恐惧|好怕|好慌|吓死|不敢)/, mood: '害怕', intensity: 4 },
    { pattern: /(?:我(?:很|特别)?无聊|好无聊|没意思|闲得慌|打发时间)/, mood: '无聊', intensity: 2 },
    { pattern: /(?:我(?:很|特别)?迷茫|不知道该怎么办|好迷茫|找不到方向|没有目标)/, mood: '迷茫', intensity: 3 },
  ];
  for (const { pattern, mood, intensity } of moodPatterns) {
    if (pattern.test(msg)) {
      // 触发原因：尝试从原消息提取（取情绪关键词前后的内容，简化为整句的前60字）
      const triggerSource = userMessage.length > 60 ? userMessage.substring(0, 60) + '...' : userMessage;
      applyEmotionObservation(memory, {
        mood,
        intensity,
        trigger: triggerSource,
        source: 'explicit_user',
        confidence: 1,
        timestamp: nowDateTimeStr(),
      });

      updated = true;
      break;
    }
  }

  const troublePatterns = [
    /(?:我(?:最近)?(?:很)?困扰|我(?:最近)?遇到了?问题|我(?:最近)?有?烦恼|我(?:最近)?(?:很)?烦|我(?:最近)?不?顺利)/,
    /(?:分手|离婚|吵架|打架|被(?:开除|辞退|裁员)|失业|挂科|考试(?:没)?过|面试(?:没)?过)/,
    /(?:睡不着|失眠|做噩梦|焦虑|抑郁|压力)/,
  ];
  for (const pattern of troublePatterns) {
    const match = msg.match(pattern);
    if (match) {
      const trouble = match[0].trim();
      if (trouble && !memory.emotional_state.recent_troubles.includes(trouble)) {
        if (memory.emotional_state.recent_troubles.length >= 5) {
          memory.emotional_state.recent_troubles.shift();
        }
        memory.emotional_state.recent_troubles.push(trouble);
        memory.emotional_state.last_updated = new Date().toISOString().replace('T', ' ').substring(0, 19);
        updated = true;
      }
      break;
    }
  }

  const eventPatterns = [
    /(?:我要|我将|我准备|我打算)([^。！？\n]{2,30})/,
    /(?:明天|后天|下周|下个月|今年)([^。！？\n]{2,30})(?:考试|面试|比赛|旅行|出差|结婚|生日)/,
  ];
  for (const pattern of eventPatterns) {
    const match = msg.match(pattern);
    if (match) {
      const event = match[0].trim();
      if (event && event.length > 2) {
        const existing = memory.important_events.find(e => e.event === event);
        if (!existing) {
          if (memory.important_events.length >= 20) {
            memory.important_events.shift();
          }
          memory.important_events.push({
            event: event,
            date: new Date().toISOString().replace('T', ' ').substring(0, 10),
            important: true,
          });
          updated = true;
        }
      }
      break;
    }
  }

  if (updated) {
    writeMemory(characterId, memory);
  }

  return { memory, updated };
}

function buildCompactMemoryState(memory) {
  return {
    user_profile: memory.user_profile || {},
    preferences: memory.preferences || {},
    important_events: (memory.important_events || []).slice(-10),
    permanent_facts: (memory.permanent_facts || []).slice(-100).map(f =>
      typeof f === 'string' ? f : {
        fact: f.fact,
        category: f.category,
        confidence: f.confidence,
        superseded_by: f.superseded_by,
      }
    ),
    relationship_notes: (memory.relationship_notes || []).slice(-10),
    emotional_state: memory.emotional_state ? {
      recent_mood: memory.emotional_state.recent_mood,
      recent_mood_intensity: memory.emotional_state.recent_mood_intensity,
      recent_troubles: (memory.emotional_state.recent_troubles || []).slice(-5),
    } : {},
    character_emotional_state: memory.character_emotional_state ? {
      current_emotion: memory.character_emotional_state.current_emotion,
      emotion_intensity: memory.character_emotional_state.emotion_intensity,
    } : {},
  };
}

function getCompactMemoryState(characterId) {
  return buildCompactMemoryState(readMemory(characterId));
}

function applyExtractedMemoryUpdates(characterId, updates, userEvidenceText) {
  if (!updates || typeof updates !== 'object') {
    return { memory: readMemory(characterId), updated: false };
  }
  const memory = readMemory(characterId);
  mergeMemoryUpdates(memory, updates, {
    requireUserEvidence: true,
    userEvidenceText: String(userEvidenceText || ''),
  });
  writeMemory(characterId, memory);
  return { memory, updated: true };
}

// 压缩节点完成后清理低价值、一次性的记忆，避免永久上下文不断膨胀。
// 完整原文仍保留在 chat_history/RAG；这里只决定下次常驻注入哪些记忆。
function pruneTransientMemories(characterId, userEvidenceText = '') {
  const memory = readMemory(characterId);
  const evidence = normalizeMemoryText(userEvidenceText);
  const majorPattern = /(生日|纪念日|结婚|订婚|分手|离婚|住院|手术|重大|去世|葬礼|怀孕|生子|毕业|考试|搬家|迁居|入职|离职|失业|创业|疾病|确诊|家人|父母|子女|伴侣)/;
  let changed = false;

  if (Array.isArray(memory.important_events)) {
    const kept = memory.important_events.filter(item => {
      const text = typeof item === 'string' ? item : String(item?.event || '');
      if (!text) return false;
      // 重大事件永久保留；普通事件只有在本批用户原话再次出现时才保留。
      const normalized = normalizeMemoryText(text);
      if (typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'important')) {
        return item.important === true || normalized && evidence.includes(normalized);
      }
      return majorPattern.test(text) || normalized && evidence.includes(normalized);
    });
    if (kept.length !== memory.important_events.length) {
      memory.important_events = kept.slice(-20);
      changed = true;
    }
  }

  if (Array.isArray(memory.permanent_facts)) {
    const coreCategories = new Set(['personal_info', 'family', 'career', 'health', 'relationship', 'major_event']);
    const kept = memory.permanent_facts.filter(item => {
      const text = typeof item === 'string' ? item : String(item?.fact || '');
      if (!text) return false;
      if (typeof item === 'object' && item.superseded_by) return false;
      const category = typeof item === 'object' ? item.category : '';
      // 核心事实/明确重大关键词永久保留；other 类一次性事实按本批次观察窗口淘汰。
      if ((typeof item === 'object' && item.important === true)
          || coreCategories.has(category) || majorPattern.test(text)) return true;
      const normalized = normalizeMemoryText(text);
      return normalized && evidence.includes(normalized);
    });
    if (kept.length !== memory.permanent_facts.length) {
      memory.permanent_facts = kept.slice(-100);
      changed = true;
    }
  }

  if (changed) writeMemory(characterId, memory);
  return { memory, changed };
}

async function updateMemoryWithAI(characterId, userMessage, recentMessages, chatWithAI, assistantReply = null) {
  try {
    const memory = readMemory(characterId);
    const promptPath = path.join(__dirname, '..', 'prompts', 'memory_prompt.txt');
    let promptTemplate = fs.readFileSync(promptPath, 'utf-8');

    promptTemplate = promptTemplate.replace('{{CURRENT_MEMORY}}', JSON.stringify(buildCompactMemoryState(memory)));
    // 保留更多真实对话，但限制主动消息与字符预算；当前轮单独列出，避免重复占 token。
    const recentContext = selectRecentConversationContext(recentMessages, {
      maxMessages: 12,
      maxChars: 6000,
      maxProactiveAssistants: 2,
    });
    if (assistantReply && recentContext.at(-1)?.role === 'assistant'
        && String(recentContext.at(-1)?.content || '').trim() === String(assistantReply).trim()) {
      recentContext.pop();
    }
    if (userMessage && recentContext.at(-1)?.role === 'user'
        && String(recentContext.at(-1)?.content || '').trim() === String(userMessage).trim()) {
      recentContext.pop();
    }
    const recent = recentContext.map(m => `${m.role}: ${m.content}`).join('\n');
    const currentTurn = assistantReply
      ? `本轮对话：\nuser: ${userMessage}\nassistant: ${assistantReply}\n\n最近对话：\n${recent}`
      : recent;
    promptTemplate = promptTemplate.replace('{{RECENT_MESSAGES}}', currentTurn);

    const messages = [
      { role: 'system', content: '你是一个信息提取助手，只输出JSON格式的更新内容，不要输出其他任何文字。' },
      { role: 'user', content: promptTemplate },
    ];

    const response = await chatWithAI(messages);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const updates = JSON.parse(jsonMatch[0]);
      const userEvidenceText = [
        ...recentMessages.filter(message => message?.role === 'user').map(message => message.content),
        userMessage,
      ].filter(Boolean).join('\n');
      mergeMemoryUpdates(memory, updates, { requireUserEvidence: true, userEvidenceText });
      writeMemory(characterId, memory);
      return { memory, updated: true };
    }
  } catch (error) {
    console.error('[MemoryService] AI记忆更新失败:', error.message);
  }

  return { memory: readMemory(characterId), updated: false };
}

// 节流缓存：避免每条消息都触发 AI 提取（同一角色 60 秒内只触发一次）
const _aiUpdateLastRun = {}; // { [characterId]: timestamp_ms }

/**
 * 节流版 AI 记忆更新：每 60 秒最多触发一次（按角色）
 * 在 /api/chat 主循环中调用，传入本轮 user 消息 + assistant 回复
 */
async function updateMemoryWithAIThrottled(characterId, userMessage, recentMessages, chatWithAI, assistantReply) {
  const now = Date.now();
  const THROTTLE_MS = 60 * 1000; // 60秒
  const last = _aiUpdateLastRun[characterId] || 0;
  if (now - last < THROTTLE_MS) {
    return { skipped: true, reason: 'throttled' };
  }
  _aiUpdateLastRun[characterId] = now;
  try {
    const result = await updateMemoryWithAI(characterId, userMessage, recentMessages, chatWithAI, assistantReply);
    console.log(`[Memory] AI记忆更新: ${result.updated ? '有更新' : '无更新'}`);
    return result;
  } catch (e) {
    console.error('[Memory] AI记忆更新失败:', e.message);
    return { updated: false, error: e.message };
  }
}

function applyReplyPerformance(characterId, performance) {
  if (!performance || performance.source !== 'model') return false;
  try {
    const memory = readMemory(characterId);
    const ts = nowDateTimeStr();

    if (performance.userEmotion) {
      applyEmotionObservation(memory, {
        mood: performance.userEmotion,
        intensity: Number(performance.userIntensity) || 0,
        trigger: performance.evidence || '',
        source: 'assistant_inference',
        confidence: Math.min(0.6, Math.max(0.25, Number(performance.userConfidence) || Number(performance.confidence) || 0.5)),
        timestamp: ts,
      });
    }
    if (performance.characterEmotion) {
      if (!memory.character_emotional_state) memory.character_emotional_state = {
        current_emotion: '', emotion_intensity: 0, emotion_trigger: '',
        emotion_trajectory: [], last_updated: '',
      };
      memory.character_emotional_state.current_emotion = performance.characterEmotion;
      memory.character_emotional_state.emotion_intensity = Number(performance.characterIntensity) || 0;
      memory.character_emotional_state.emotion_trigger = performance.evidence || '';
      memory.character_emotional_state.last_updated = ts;
      if (!memory.character_emotional_state.emotion_trajectory) memory.character_emotional_state.emotion_trajectory = [];
      memory.character_emotional_state.emotion_trajectory.push({
        emotion: performance.characterEmotion,
        intensity: Number(performance.characterIntensity) || 0,
        trigger: performance.evidence || '',
        timestamp: ts,
      });
      if (memory.character_emotional_state.emotion_trajectory.length > 20) {
        memory.character_emotional_state.emotion_trajectory = memory.character_emotional_state.emotion_trajectory.slice(-20);
      }
    }

    writeMemory(characterId, memory);
    return true;
  } catch (e) {
    console.error('[Memory] 解析emotion失败:', e.message);
    return false;
  }
}

/**
 * Parse the hidden reply envelope without exposing it to history or UI.
 * Nested emphasis objects are supported; the old <!--emotion:...--> and
 * [EMOTION]...[/EMOTION] formats remain compatible.
 */
function parseReplyPerformance(reply, userInput = '') {
  const extracted = replyPerformancePolicy.extractReplyPerformance(reply);
  return {
    cleanReply: extracted.cleanReply,
    rawPerformance: extracted.raw,
    performance: replyPerformancePolicy.normalizeReplyPerformance(
      extracted.raw,
      extracted.cleanReply,
      userInput,
    ),
  };
}

function parseAndApplyEmotionFromReply(characterId, reply, userInput = '') {
  if (!reply) return reply;
  const parsed = parseReplyPerformance(reply, userInput);
  applyReplyPerformance(characterId, parsed.performance);
  return parsed.cleanReply;
}

function extractImportantFacts(characterId, messages, chatWithAI) {
  const memory = readMemory(characterId);

  // 已去除关键词预过滤：让 AI 看到所有 user 消息，避免漏掉隐含事实
  // 仅过滤极短/无意义消息（"嗯"、"哦"等）
  const candidateMsgs = messages.filter(m => {
    if (m.role !== 'user') return false;
    const c = (m.content || '').trim();
    if (c.length < 3) return false; // 太短，不可能有事实
    return true;
  });

  if (candidateMsgs.length === 0) {
    return Promise.resolve({ memory, updated: false });
  }

  // 限制最多 12 条最近消息，避免 prompt 过长
  const msgsToAnalyze = candidateMsgs.slice(-12);

  const prompt = `以下是一些对话片段，请从中提取重要的事实信息（姓名、生日、喜好、厌恶、重要事件、家庭关系、职业、健康等），以JSON格式输出。

当前记忆状态（精简）：
${JSON.stringify(buildCompactMemoryState(memory))}

对话片段：
${msgsToAnalyze.map(m => `[${m.time || ''}] ${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n')}

请输出需要更新的JSON，格式如下：
{
  "user_profile": { "name": "", "birthday": "", "location": "", "occupation": "" },
  "preferences": { "likes": [], "dislikes": [], "topics": [] },
  "important_events": [{ "event": "", "date": "" }],
  "permanent_facts": [{ "fact": "", "category": "personal_info|family|career|health|relationship|major_event|other", "confidence": 0.0-1.0, "date": "YYYY-MM-DD", "source": "对话中明确提及/对话中推断" }],
  "superseded_facts": ["被新事实纠正的旧事实文本"]
}

要求：
1. 只输出有更新的字段，空字段不要输出
2. permanent_facts 中，用户明确陈述的事实 confidence=1.0，推断的事实 confidence=0.5-0.7
3. 如果新对话否定/修正了已有事实（如以前说住北京，现在说搬到上海），把旧事实文本放入 superseded_facts 数组
4. 不要重复已有 permanent_facts 中已记录的事实
5. 每条 permanent_facts 只记录一个原子事实，使用简短中文，建议不超过40字；不要保存寒暄、临时情绪或整段对话`;

  return chatWithAI([
    { role: 'system', content: '你是信息提取助手，只输出JSON，不要输出其他文字。' },
    { role: 'user', content: prompt },
  ]).then(response => {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const updates = JSON.parse(jsonMatch[0]);
      const userEvidenceText = msgsToAnalyze
        .filter(message => message?.role === 'user')
        .map(message => message.content)
        .join('\n');
      mergeMemoryUpdates(memory, updates, { requireUserEvidence: true, userEvidenceText });
      writeMemory(characterId, memory);
      console.log('[MemoryService] AI提取重要信息完成');
      return { memory, updated: true };
    }
    return { memory, updated: false };
  }).catch(error => {
    console.error('[MemoryService] AI提取重要信息失败:', error.message);
    return { memory, updated: false };
  });
}

function normalizeMemoryText(value) {
  return String(value || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

function memoryTextMatches(left, right) {
  const a = normalizeMemoryText(left);
  const b = normalizeMemoryText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const aNegated = /(?:不|没|无|从未|不再)/.test(a);
  const bNegated = /(?:不|没|无|从未|不再)/.test(b);
  if (aNegated !== bNegated) return false;
  return Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a));
}

function evidenceSupportsMemoryText(value, evidenceText) {
  const valueText = normalizeMemoryText(value);
  const evidence = normalizeMemoryText(evidenceText);
  if (!valueText || !evidence) return false;
  if (evidence.includes(valueText)) return true;
  const valueGrams = extractNgrams(valueText);
  const evidenceGrams = extractNgrams(evidence);
  if (valueGrams.size === 0 || evidenceGrams.size === 0) return false;
  let overlap = 0;
  for (const gram of valueGrams) if (evidenceGrams.has(gram)) overlap++;
  return overlap / valueGrams.size >= 0.18;
}

function mergeMemoryUpdates(memory, updates, options = {}) {
  const requireUserEvidence = options.requireUserEvidence === true;
  const userEvidenceText = String(options.userEvidenceText || '');
  if (updates.user_profile) {
    for (const [key, value] of Object.entries(updates.user_profile)) {
      if (value && value !== '' && memory.user_profile.hasOwnProperty(key)
          && (!requireUserEvidence || normalizeMemoryText(userEvidenceText).includes(normalizeMemoryText(value)))) {
        memory.user_profile[key] = value;
      }
    }
  }

  if (updates.preferences) {
    if (updates.preferences.likes && updates.preferences.likes.length > 0) {
      for (const like of updates.preferences.likes) {
        if (requireUserEvidence && !evidenceSupportsMemoryText(like, userEvidenceText)) continue;
        const conflictIdx = memory.preferences.dislikes.indexOf(like);
        if (conflictIdx !== -1) {
          memory.preferences.dislikes.splice(conflictIdx, 1);
        }
        if (!memory.preferences.likes.includes(like)) {
          memory.preferences.likes.push(like);
        }
      }
    }
    if (updates.preferences.dislikes && updates.preferences.dislikes.length > 0) {
      for (const dislike of updates.preferences.dislikes) {
        if (requireUserEvidence && !evidenceSupportsMemoryText(dislike, userEvidenceText)) continue;
        const conflictIdx = memory.preferences.likes.indexOf(dislike);
        if (conflictIdx !== -1) {
          memory.preferences.likes.splice(conflictIdx, 1);
        }
        if (!memory.preferences.dislikes.includes(dislike)) {
          memory.preferences.dislikes.push(dislike);
        }
      }
    }
    if (updates.preferences.topics && updates.preferences.topics.length > 0) {
      for (const topic of updates.preferences.topics) {
        if (requireUserEvidence && !evidenceSupportsMemoryText(topic, userEvidenceText)) continue;
        if (!memory.preferences.topics.includes(topic)) {
          memory.preferences.topics.push(topic);
        }
      }
    }
    if (updates.preferences.communication_style && updates.preferences.communication_style !== '') {
      if (!requireUserEvidence
          || evidenceSupportsMemoryText(updates.preferences.communication_style, userEvidenceText)) {
        memory.preferences.communication_style = updates.preferences.communication_style;
      }
    }
  }

  if (updates.emotional_state) {
    const incomingState = updates.emotional_state;
    if (incomingState.recent_mood) {
      applyEmotionObservation(memory, {
        mood: incomingState.recent_mood,
        intensity: incomingState.recent_mood_intensity,
        trigger: incomingState.recent_mood_trigger,
        source: incomingState.recent_mood_source || 'assistant_inference',
        confidence: incomingState.recent_mood_source === 'explicit_user'
          ? 1
          : Math.min(0.6, Number(incomingState.recent_mood_confidence) || 0.55),
        timestamp: incomingState.last_updated || nowDateTimeStr(),
      });
    }
    for (const [key, value] of Object.entries(updates.emotional_state)) {
      if (value && value !== '') {
        if (['recent_mood', 'recent_mood_intensity', 'recent_mood_trigger', 'recent_mood_source', 'recent_mood_confidence', 'last_updated'].includes(key)) {
          continue;
        }
        if (key === 'recent_troubles' && Array.isArray(value)) {
          memory.emotional_state.recent_troubles = value.slice(-5);
        } else if (key === 'mood_trajectory' && Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string') {
              applyEmotionObservation(memory, {
                mood: item, source: 'assistant_inference', confidence: 0.5, timestamp: nowDateTimeStr(),
              });
            } else if (item && item.mood) {
              applyEmotionObservation(memory, {
                mood: item.mood,
                intensity: Number(item.intensity) || 0,
                trigger: item.trigger || '',
                source: item.source || 'assistant_inference',
                confidence: item.source === 'explicit_user' ? 1 : Math.min(0.6, Number(item.confidence) || 0.55),
                timestamp: item.timestamp || nowDateTimeStr(),
              });
            }
          }
        } else {
          memory.emotional_state[key] = value;
        }
      }
    }
  }

  // 角色自身情感状态
  if (updates.character_emotional_state) {
    if (!memory.character_emotional_state) {
      memory.character_emotional_state = {
        current_emotion: '', emotion_intensity: 0, emotion_trigger: '',
        emotion_trajectory: [], last_updated: '',
      };
    }
    for (const [key, value] of Object.entries(updates.character_emotional_state)) {
      if (value && value !== '') {
        if (key === 'emotion_trajectory' && Array.isArray(value)) {
          for (const item of value) {
            if (item && item.emotion) {
              memory.character_emotional_state.emotion_trajectory.push({
                emotion: item.emotion,
                intensity: Number(item.intensity) || 0,
                trigger: item.trigger || '',
                timestamp: item.timestamp || nowDateTimeStr(),
              });
            }
          }
          if (memory.character_emotional_state.emotion_trajectory.length > 20) {
            memory.character_emotional_state.emotion_trajectory = memory.character_emotional_state.emotion_trajectory.slice(-20);
          }
        } else {
          memory.character_emotional_state[key] = value;
        }
      }
    }
    if (!memory.character_emotional_state.last_updated) {
      memory.character_emotional_state.last_updated = nowDateTimeStr();
    }
  }

  if (updates.important_events && updates.important_events.length > 0) {
    for (const event of updates.important_events) {
      const eventStr = typeof event === 'string' ? event : event.event || JSON.stringify(event);
      if (requireUserEvidence && !evidenceSupportsMemoryText(eventStr, userEvidenceText)) continue;
      const exists = memory.important_events.some(e =>
        typeof e === 'string' ? e === eventStr : e.event === eventStr
      );
      if (!exists) {
        const normalizedEvent = typeof event === 'string'
          ? { event: eventStr, date: new Date().toISOString().substring(0, 10) }
          : { ...event };
        // 模型确认写入 important_events 的项目默认带星标，清理策略永不淘汰。
        normalizedEvent.important = true;
        memory.important_events.push(normalizedEvent);
      }
    }
    if (memory.important_events.length > 20) {
      memory.important_events = memory.important_events.slice(-20);
    }
  }

  // 处理 superseded_facts：把被纠正的旧事实标记为 superseded_by（不删除，保留历史）
  if (updates.superseded_facts && updates.superseded_facts.length > 0) {
    if (!memory.permanent_facts) memory.permanent_facts = [];
    for (const oldFactText of updates.superseded_facts) {
      // 在已有 facts 中查找匹配项
      for (const f of memory.permanent_facts) {
        const fText = typeof f === 'string' ? f : f.fact;
        if (memoryTextMatches(fText, oldFactText) && !(typeof f === 'object' && f.superseded_by)) {
          if (typeof f === 'string') {
            // 旧格式字符串，升级为对象
            const idx = memory.permanent_facts.indexOf(f);
            memory.permanent_facts[idx] = {
              fact: f,
              superseded_by: '已纠正',
              superseded_at: nowDateTimeStr(),
              date: nowDateStr(),
            };
          } else {
            f.superseded_by = '已纠正';
            f.superseded_at = nowDateTimeStr();
          }
          console.log(`[Memory] 事实被纠正: ${fText}`);
        }
      }
    }
  }

  if (updates.permanent_facts && updates.permanent_facts.length > 0) {
    if (!memory.permanent_facts) memory.permanent_facts = [];
    for (const fact of updates.permanent_facts) {
      const factStr = String(typeof fact === 'string' ? fact : fact.fact || JSON.stringify(fact))
        .replace(/\s+/g, ' ').trim().slice(0, 80);
      if (factStr.length < 2) continue;
      // 跳过已被纠正的事实
      if (typeof fact === 'object' && fact.superseded_by) continue;
      let source = typeof fact === 'object' ? (fact.source || '对话中明确提及') : '对话中明确提及';
      let confidence = typeof fact === 'object' && typeof fact.confidence === 'number'
        ? Math.max(0, Math.min(1, fact.confidence))
        : (String(source).includes('推断') ? 0.6 : 1.0);
      if (requireUserEvidence && String(source).includes('明确')
          && !evidenceSupportsMemoryText(factStr, userEvidenceText)) {
        source = '对话中推断（缺少用户原话支持）';
        confidence = Math.min(confidence, 0.6);
      }
      // 检查是否已存在（包括被纠正的旧事实，避免重新添加）
      const existingIndex = memory.permanent_facts.findIndex(f => {
        const fText = typeof f === 'string' ? f : f.fact;
        return memoryTextMatches(fText, factStr);
      });
      if (existingIndex >= 0) {
        const existing = memory.permanent_facts[existingIndex];
        if (typeof existing === 'object' && !existing.superseded_by
            && confidence > Number(existing.confidence ?? 0)) {
          existing.confidence = confidence;
          existing.source = source;
          if (typeof fact === 'object' && fact.category) existing.category = fact.category;
        }
        continue;
      }
      memory.permanent_facts.push({
        fact: typeof fact === 'object' ? (fact.fact || factStr) : factStr,
        category: typeof fact === 'object' ? (fact.category || 'other') : 'other',
        confidence,
        date: typeof fact === 'object' ? (fact.date || nowDateStr()) : nowDateStr(),
        source,
        important: typeof fact === 'object'
          ? fact.important === true || fact.category === 'major_event'
          : /(生日|纪念日|结婚|订婚|分手|离婚|住院|手术|重大|去世|葬礼|怀孕|生子|毕业|考试|搬家|迁居|入职|离职|失业|创业|疾病|确诊)/.test(factStr),
      });
    }
  }

  if (updates.relationship_notes && updates.relationship_notes.length > 0) {
    for (const note of updates.relationship_notes) {
      const noteText = String(typeof note === 'string' ? note : note?.note || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const evidence = typeof note === 'object' ? note?.evidence : '';
      if (requireUserEvidence && (!evidence || !evidenceSupportsMemoryText(evidence, userEvidenceText))) continue;
      if (noteText.length >= 3 && !memory.relationship_notes.some(existing => memoryTextMatches(existing, noteText))) {
        memory.relationship_notes.push(noteText);
      }
    }
    if (memory.relationship_notes.length > 20) memory.relationship_notes = memory.relationship_notes.slice(-20);
  }

  if (updates.festival_notes && updates.festival_notes.length > 0) {
    for (const note of updates.festival_notes) {
      if (!memory.festival_notes.includes(note)) {
        memory.festival_notes.push(note);
      }
    }
  }

  if (updates.summary && updates.summary !== '') {
    memory.summary = updates.summary;
  }
}

function addPermanentFact(characterId, factText) {
  const memory = readMemory(characterId);
  if (!memory.permanent_facts) memory.permanent_facts = [];
  factText = String(factText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (factText.length < 2) return false;
  const exists = memory.permanent_facts.some(f =>
    typeof f === 'string' ? f === factText : f.fact === factText
  );
  if (!exists) {
    memory.permanent_facts.push({
      fact: factText,
      date: new Date().toISOString().substring(0, 10),
      important: false,
    });
    writeMemory(characterId, memory);
    return true;
  }
  return false;
}

function setPermanentFactImportant(characterId, index, important) {
  const memory = readMemory(characterId);
  if (!Array.isArray(memory.permanent_facts) || index < 0 || index >= memory.permanent_facts.length) return false;
  const current = memory.permanent_facts[index];
  const factText = typeof current === 'string' ? current : current?.fact;
  if (!factText) return false;
  memory.permanent_facts[index] = typeof current === 'string'
    ? { fact: current, date: nowDateStr(), important: important === true }
    : { ...current, important: important === true };
  writeMemory(characterId, memory);
  return true;
}

function setImportantEventImportant(characterId, index, important) {
  const memory = readMemory(characterId);
  if (!Array.isArray(memory.important_events) || index < 0 || index >= memory.important_events.length) return false;
  const current = memory.important_events[index];
  const eventText = typeof current === 'string' ? current : current?.event;
  if (!eventText) return false;
  memory.important_events[index] = typeof current === 'string'
    ? { event: current, date: nowDateStr(), important: important === true }
    : { ...current, important: important === true };
  writeMemory(characterId, memory);
  return true;
}

function removeImportantEvent(characterId, index) {
  const memory = readMemory(characterId);
  if (!Array.isArray(memory.important_events) || index < 0 || index >= memory.important_events.length) return false;
  memory.important_events.splice(index, 1);
  writeMemory(characterId, memory);
  return true;
}

function removePermanentFact(characterId, index) {
  const memory = readMemory(characterId);
  if (!memory.permanent_facts) return false;
  if (index >= 0 && index < memory.permanent_facts.length) {
    memory.permanent_facts.splice(index, 1);
    writeMemory(characterId, memory);
    return true;
  }
  return false;
}

function checkBirthday(memory) {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  const todayStr = `${month}月${day}日`;

  if (memory.user_profile.birthday) {
    const birthday = memory.user_profile.birthday;
    if (birthday.includes(todayStr) || birthday === todayStr) {
      return true;
    }
  }
  return false;
}

function checkFestival() {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();

  const festivals = {
    '1月1日': '元旦',
    '2月14日': '情人节',
    '3月8日': '妇女节',
    '5月1日': '劳动节',
    '6月1日': '儿童节',
    '10月1日': '国庆节',
    '12月25日': '圣诞节',
  };

  const key = `${month}月${day}日`;
  return festivals[key] || null;
}

function addCharacterEvent(characterId, event, type, importance) {
  const memory = readMemory(characterId);
  if (!memory.character_events) memory.character_events = [];
  const exists = memory.character_events.some(e => e.event === event);
  if (!exists) {
    memory.character_events.push({
      event,
      type: type || 'general',
      date: nowDateStr(),
      importance: importance || 0.7,
    });
    if (memory.character_events.length > 30) {
      memory.character_events = memory.character_events
        .sort((a, b) => (b.importance || 0.5) - (a.importance || 0.5))
        .slice(0, 30);
    }
    writeMemory(characterId, memory);
    return true;
  }
  return false;
}

function addSessionSummary(characterId, summary, keyTopics, emotion) {
  const memory = readMemory(characterId);
  if (!memory.session_summaries) memory.session_summaries = [];
  memory.session_summaries.push({
    date: nowDateStr(),
    summary,
    key_topics: keyTopics || [],
    emotion: emotion || '',
  });
  if (memory.session_summaries.length > 10) {
    memory.session_summaries = memory.session_summaries.slice(-10);
  }
  writeMemory(characterId, memory);
  return true;
}

function getRelevantCharacterEvents(characterId, limit) {
  const memory = readMemory(characterId);
  if (!memory.character_events || memory.character_events.length === 0) return [];
  const sorted = [...memory.character_events].sort((a, b) => (b.importance || 0.5) - (a.importance || 0.5));
  return sorted.slice(0, limit || 5);
}

function getRecentSessionSummaries(characterId, limit) {
  const memory = readMemory(characterId);
  if (!memory.session_summaries || memory.session_summaries.length === 0) return [];
  return memory.session_summaries.slice(-(limit || 2));
}

// 优化版：智能获取会话摘要，按重要度和时间衰减
function getSmartSessionSummaries(characterId, limit) {
  const memory = readMemory(characterId);
  if (!memory.session_summaries || memory.session_summaries.length === 0) return [];

  const now = Date.now();
  const scored = memory.session_summaries.map(s => {
    // 时间衰减：越久远的摘要分数越低
    const ageDays = (now - new Date(s.date).getTime()) / (1000 * 60 * 60 * 24);
    const timeScore = Math.max(0, 1 - ageDays / 30); // 30天后衰减为0
    // 重要度：有key_topics的摘要更重要
    const topicScore = (s.key_topics && s.key_topics.length > 0) ? 0.3 : 0;
    const score = timeScore + topicScore;
    return { ...s, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, limit || 2).map(s => {
    const { _score, ...rest } = s;
    return rest;
  });
}

// 优化版：构建精简记忆摘要（节约token）
function buildMemorySummary(characterId, options = {}) {
  const memory = readMemory(characterId);
  const parts = [];

  // 用户画像：只保留关键信息，用紧凑格式
  if (memory.user_profile) {
    const p = memory.user_profile;
    const items = [];
    if (p.name) items.push(p.name);
    if (p.nickname) items.push(`昵称${p.nickname}`);
    if (p.birthday) items.push(`生日${p.birthday}`);
    if (p.location) items.push(p.location);
    if (p.occupation) items.push(p.occupation);
    if (items.length > 0) parts.push('用户: ' + items.join('，'));
  }

  // 用户偏好：紧凑格式
  if (memory.preferences) {
    const p = memory.preferences;
    const items = [];
    if (p.likes && p.likes.length > 0) items.push(`喜欢${p.likes.join('、')}`);
    if (p.dislikes && p.dislikes.length > 0) items.push(`不喜欢${p.dislikes.join('、')}`);
    if (p.topics && p.topics.length > 0) items.push(`常聊${p.topics.join('、')}`);
    if (p.communication_style && String(p.communication_style).trim()) {
      items.push(`沟通偏好${String(p.communication_style).trim()}`);
    }
    if (items.length > 0) parts.push('偏好: ' + items.join('；'));
  }

  // 情绪状态：只保留近期，紧凑格式
  if (options.includeEmotion !== false && memory.emotional_state) {
    const e = memory.emotional_state;
    const items = [];
    if (e.recent_mood) items.push(`情绪${e.recent_mood}`);
    if (e.recent_troubles && e.recent_troubles.length > 0) items.push(`困扰${e.recent_troubles.join('、')}`);
    if (items.length > 0) parts.push('近期: ' + items.join('；'));
  }

  // 永久事实：全量保留（这是最重要的记忆）
  if (options.includePermanent !== false && memory.permanent_facts && memory.permanent_facts.length > 0) {
    const facts = memory.permanent_facts.map(f => typeof f === 'string' ? f : f.fact).join('；');
    parts.push('永久记忆: ' + facts);
  }

  return parts.join('\n');
}

// ============================================================
// 纯 JS 检索：基于 n-gram Jaccard 相似度（无需装包）
// ============================================================

/**
 * 提取中文/英文文本的 n-gram 集合
 * - 中文：2-3 字 n-gram
 * - 英文：单词（按空格分词）
 */
function extractNgrams(text, opts = {}) {
  if (!text) return new Set();
  const minN = opts.minN || 2;
  const maxN = opts.maxN || 3;
  const grams = new Set();
  // 英文单词（1-gram 单词）
  const words = text.match(/[a-zA-Z]{2,}/g) || [];
  for (const w of words) grams.add(w.toLowerCase());
  // 中文 n-gram
  const cjkChars = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cjkChars) {
    for (let n = minN; n <= maxN; n++) {
      for (let i = 0; i + n <= seg.length; i++) {
        grams.add(seg.substring(i, i + n));
      }
    }
  }
  return grams;
}

/**
 * 计算 Jaccard 相似度（交集/并集）
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  const smaller = setA.size < setB.size ? setA : setB;
  const larger = setA.size < setB.size ? setB : setA;
  for (const g of smaller) {
    if (larger.has(g)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 在 facts 中检索与 query 最相似的 topK 条
 * @param {Array} facts - 字符串数组或 {fact, ...} 对象数组
 * @param {string} query - 查询文本
 * @param {number} topK - 返回前 K 条
 * @param {number} threshold - 相似度阈值（0-1），低于此值不返回
 */
function searchSimilarFacts(facts, query, topK = 3, threshold = 0.05) {
  if (!query || !facts || facts.length === 0) return [];
  const queryGrams = extractNgrams(query);
  if (queryGrams.size === 0) return [];
  const scored = facts.map(f => {
    const text = typeof f === 'string' ? f : (f.fact || '');
    const factGrams = extractNgrams(text);
    const sim = jaccardSimilarity(queryGrams, factGrams);
    // 加权：confidence 高的事实分数加成
    const conf = typeof f === 'object' ? (f.confidence ?? 1.0) : 1.0;
    const score = sim * (0.7 + 0.3 * conf);
    return { fact: f, score, sim };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter(s => s.score >= threshold)
    .slice(0, topK)
    .map(s => s.fact);
}

// 记忆仍完整保存在本地；只有与本轮用户消息有明确词面关联时才进入提示。
// 这是轻量门控，不冒充语义模型，也不会因为一次无关消息删除或修改记忆。
function isMemoryTextRelevant(value, query, threshold = 0.08) {
  const text = String(value || '').trim();
  const input = String(query || '').trim();
  if (!text || !input) return false;
  const normalizedText = normalizeMemoryText(text);
  const normalizedInput = normalizeMemoryText(input);
  if (!normalizedText || !normalizedInput) return false;
  if (normalizedInput.includes(normalizedText) || normalizedText.includes(normalizedInput)) return true;
  return searchSimilarFacts([{ fact: text }], input, 1, threshold).length > 0;
}

// 构建分层记忆上下文（用于promptBuilder，节约token）
function buildLayeredMemoryContext(characterId, userInput, options = {}) {
  const memory = readMemory(characterId);
  const parts = [];
  const relevantOnly = options.relevantOnly === true;
  const isRelevant = (value, threshold = 0.08) => (
    !relevantOnly || isMemoryTextRelevant(value, userInput, threshold)
  );

  // 第1层：可信核心事实常驻；其余事实按最近性与本轮相关性选取。
  // 所有事实仍保存在 memory.json，未注入本轮不等于删除或遗忘。
  if (memory.permanent_facts && memory.permanent_facts.length > 0) {
    const validFacts = memory.permanent_facts.filter(f => {
      if (typeof f === 'string') return true;
      return !f.superseded_by;
    });
    const coreCategories = new Set(['personal_info', 'family', 'career', 'health', 'relationship']);
    const coreFacts = validFacts.filter(f => {
      const text = typeof f === 'string' ? f : f.fact;
      if (!isRelevant(text)) return false;
      if (typeof f === 'string') return true;
      return (f.confidence ?? 1) >= 0.8 && coreCategories.has(f.category);
    }).slice(-20);
    const selectedFacts = [];
    const selectedKeys = new Set();
    const addFact = (fact) => {
      const text = typeof fact === 'string' ? fact : fact.fact;
      const key = normalizeMemoryText(text);
      if (!key || selectedKeys.has(key)) return;
      selectedKeys.add(key);
      selectedFacts.push(fact);
    };
    coreFacts.forEach(addFact);
    validFacts.filter(f => {
      const text = typeof f === 'string' ? f : f.fact;
      return isRelevant(text) && (typeof f === 'object' ? (f.confidence ?? 1) : 1) >= 0.8;
    })
      .slice(-5)
      .forEach(addFact);
    if (userInput && String(userInput).trim()) {
      searchSimilarFacts(validFacts.filter(f => {
        const text = typeof f === 'string' ? f : f.fact;
        return !selectedKeys.has(normalizeMemoryText(text));
      }), userInput, 5).forEach(addFact);
    }

    const factsLines = [];
    for (const f of selectedFacts.slice(0, 30)) {
      const text = typeof f === 'string' ? f : f.fact;
      const category = (typeof f === 'object' && f.category && f.category !== 'other') ? `[${f.category}]` : '';
      const confidence = typeof f === 'object' ? (f.confidence ?? 1) : 1;
      const caution = confidence < 0.8 ? '（低置信度，仅作参考）' : '';
      factsLines.push(`- ${category}${text}${caution}`.trim());
    }
    if (factsLines.length > 0) {
      parts.push('【可信长期记忆】\n' + factsLines.join('\n'));
    }
  }

  // 第2层：核心画像（紧凑格式，常驻）
  const summary = buildMemorySummary(characterId, {
    includePermanent: false,
    includeEmotion: options.includeEmotion !== false,
  });
  if (summary && isRelevant(summary, 0.06)) {
    parts.push('【用户记忆】\n' + summary);
  }

  // 关系备注原本只参与后台记忆抽取，没有进入主回复上下文，容易让长期关系被重置。
  // 只注入最近的少量有效备注；当前用户的明确表述始终优先，禁止据此擅自升级亲密度。
  const relationshipNotes = Array.isArray(memory.relationship_notes)
    ? memory.relationship_notes
      .map(note => String(note || '').trim())
      .filter(note => note && isRelevant(note))
      .slice(-5)
    : [];
  if (relationshipNotes.length > 0) {
    const notesText = relationshipNotes.map(note => `- ${note}`).join('\n');
    parts.push(
      '【关系连续性】\n'
      + notesText
      + '\n仅用于延续已经建立的关系事实和相处方式；以用户当前明确表述为准，不重置关系，也不虚构或擅自升级亲密程度。'
    );
  }

  const importantEvents = Array.isArray(memory.important_events)
    ? memory.important_events.slice(-5)
    : [];
  if (importantEvents.length > 0) {
    const eventsText = importantEvents.map(event => {
      const text = typeof event === 'string' ? event : event.event;
      if (!text) return '';
      if (!isRelevant(text)) return '';
      const date = typeof event === 'object' && event.date ? `（${event.date}）` : '';
      return `- ${text}${date}`;
    }).filter(Boolean).join('\n');
    if (eventsText) parts.push('【用户重要事件】\n' + eventsText);
  }

  // 第3层：角色重要事件（按重要度排序，限3条，节约token）
  const characterEvents = getRelevantCharacterEvents(characterId, 3)
    .filter(event => isRelevant(event.event));
  if (characterEvents.length > 0) {
    const eventsText = characterEvents.map(e => `- ${e.event}（${e.date}）`).join('\n');
    parts.push('【重要事件】\n' + eventsText);
  }

  // 第4层：智能会话摘要（按时间衰减+重要度，限2条）
  const sessionSummaries = options.includeSessionSummaries === false ? [] : getSmartSessionSummaries(characterId, 2)
    .filter(summaryItem => isRelevant(
      `${summaryItem.summary || ''} ${(summaryItem.key_topics || []).join(' ')}`,
    ));
  if (sessionSummaries.length > 0) {
    const summariesText = sessionSummaries.map(s => {
      const topics = s.key_topics && s.key_topics.length > 0 ? `（${s.key_topics.join('、')}）` : '';
      return `- [${s.date}] ${s.summary}${topics}`;
    }).join('\n');
    parts.push('【近期会话】\n' + summariesText);
  }

  if (options.includeSessionSummaries !== false && memory.long_term_summary
      && isRelevant(memory.long_term_summary)) {
    parts.push('【更早长期摘要】\n' + String(memory.long_term_summary).slice(0, 800));
  }

  // 第5层：用户情绪轨迹（高频变化；稳定缓存层可显式排除）
  if (options.includeEmotion !== false && memory.emotional_state && memory.emotional_state.mood_trajectory
      && memory.emotional_state.mood_trajectory.length > 0) {
    const traj = memory.emotional_state.mood_trajectory.slice(-3);
    const trajText = traj.map(t => {
      const intensity = t.intensity ? `(${t.intensity}/5)` : '';
      const trigger = t.trigger ? `[${t.trigger}]` : '';
      return `${t.mood}${intensity}${trigger}`;
    }).join(' → ');
    const curIntensity = memory.emotional_state.recent_mood_intensity
      ? `(${memory.emotional_state.recent_mood_intensity}/5)` : '';
    const curTrigger = memory.emotional_state.recent_mood_trigger
      ? `[${memory.emotional_state.recent_mood_trigger}]` : '';
    parts.push(`【用户情绪轨迹】${trajText} → 当前${memory.emotional_state.recent_mood || '未知'}${curIntensity}${curTrigger}`);
  }

  // 第6层：角色自身情感（区别于用户情绪，让角色有连续的情感记忆）
  if (options.includeEmotion !== false && memory.character_emotional_state && memory.character_emotional_state.current_emotion) {
    const ces = memory.character_emotional_state;
    const intensity = ces.emotion_intensity ? `(${ces.emotion_intensity}/5)` : '';
    const trigger = ces.emotion_trigger ? `[${ces.emotion_trigger}]` : '';
    let trajText = '';
    if (ces.emotion_trajectory && ces.emotion_trajectory.length > 0) {
      const traj = ces.emotion_trajectory.slice(-3);
      trajText = ' 轨迹: ' + traj.map(t => `${t.emotion}${t.intensity ? `(${t.intensity}/5)` : ''}`).join(' → ');
    }
    parts.push(`【角色自身情感】当前: ${ces.current_emotion}${intensity}${trigger}${trajText}`);
  }

  return parts.join('\n\n');
}

function buildDurableMemoryContext(characterId) {
  return buildLayeredMemoryContext(characterId, '', {
    includeEmotion: false,
  });
}

function buildEmotionalMemoryContext(characterId) {
  const memory = readMemory(characterId);
  const parts = [];
  if (memory.emotional_state && Array.isArray(memory.emotional_state.mood_trajectory)
      && memory.emotional_state.mood_trajectory.length > 0) {
    const state = memory.emotional_state;
    const trajectory = state.mood_trajectory.slice(-3).map(item => {
      const intensity = item.intensity ? `(${item.intensity}/5)` : '';
      const trigger = item.trigger ? `[${item.trigger}]` : '';
      return `${item.mood}${intensity}${trigger}`;
    }).join(' → ');
    const currentIntensity = state.recent_mood_intensity ? `(${state.recent_mood_intensity}/5)` : '';
    const currentTrigger = state.recent_mood_trigger ? `[${state.recent_mood_trigger}]` : '';
    parts.push(`【用户近期情绪线索】${trajectory} → 当前${state.recent_mood || '未知'}${currentIntensity}${currentTrigger}`);
  }
  if (memory.character_emotional_state && memory.character_emotional_state.current_emotion) {
    const state = memory.character_emotional_state;
    const intensity = state.emotion_intensity ? `(${state.emotion_intensity}/5)` : '';
    const trigger = state.emotion_trigger ? `[${state.emotion_trigger}]` : '';
    parts.push(`【角色上一轮情感】${state.current_emotion}${intensity}${trigger}`);
  }
  if (parts.length === 0) return '';
  return `${parts.join('\n\n')}\n这些只是连续性线索；若与用户当前文字冲突，以当前文字为准。`;
}

// 记忆压缩：将过期的会话摘要合并为一个长期摘要（节约token）
function compressOldSessionSummaries(characterId) {
  const memory = readMemory(characterId);
  if (!memory.session_summaries || memory.session_summaries.length <= 5) {
    return false; // 不需要压缩
  }

  // 保留最近5条，将更早的合并为一个长期摘要
  const toCompress = memory.session_summaries.slice(0, -5);
  const recent = memory.session_summaries.slice(-5);

  // 合并旧摘要
  const oldTopics = new Set();
  const oldSummaries = [];
  for (const s of toCompress) {
    if (s.summary) oldSummaries.push(s.summary);
    if (s.key_topics) s.key_topics.forEach(t => oldTopics.add(t));
  }

  const combinedParts = `${memory.long_term_summary || ''}；${oldSummaries.join('；')}`
    .split(/[；\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const uniqueParts = [];
  const seen = new Set();
  for (const part of combinedParts) {
    const key = part.replace(/\s+/g, '').toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueParts.push(part);
    }
  }
  let compressedSummary = uniqueParts.join('；');
  if (compressedSummary.length > 500) {
    compressedSummary = `${compressedSummary.slice(0, 190)}；…；${compressedSummary.slice(-300)}`;
  }
  memory.long_term_summary = compressedSummary;
  memory.session_summaries = recent;

  writeMemory(characterId, memory);
  console.log(`[MemoryService] 压缩了${toCompress.length}条旧会话摘要为长期摘要`);
  return true;
}

module.exports = {
  readMemory,
  writeMemory,
  clearMemory,
  updateMemoryFromMessage,
  updateMemoryWithAI,
  updateMemoryWithAIThrottled,
  extractImportantFacts,
  getCompactMemoryState,
  applyExtractedMemoryUpdates,
  pruneTransientMemories,
  parseAndApplyEmotionFromReply,
  parseReplyPerformance,
  applyReplyPerformance,
  addPermanentFact,
  setPermanentFactImportant,
  setImportantEventImportant,
  removeImportantEvent,
  removePermanentFact,
  checkBirthday,
  checkFestival,
  getDefaultMemory,
  addCharacterEvent,
  addSessionSummary,
  getRelevantCharacterEvents,
  getRecentSessionSummaries,
  getSmartSessionSummaries,
  buildMemorySummary,
  buildLayeredMemoryContext,
  buildDurableMemoryContext,
  buildEmotionalMemoryContext,
  compressOldSessionSummaries,
  applyEmotionObservation,
  // 纯 JS 检索工具
  extractNgrams,
  jaccardSimilarity,
  searchSimilarFacts,
  isMemoryTextRelevant,
};
