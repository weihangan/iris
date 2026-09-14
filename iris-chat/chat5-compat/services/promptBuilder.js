// owner-trace: wha1999/core/prompt
const fs = require('fs');
const path = require('path');
const memoryService = require('./memoryService');
const historyService = require('./historyService');
const archiveService = require('./archiveService');
const stickerService = require('./stickerService');
const { buildChatRulePrompt, buildFinalDecisionPrompt } = require('./chatRulePolicy');
const {
  selectRecentConversationContext,
  RECENT_CONTEXT_MESSAGE_LIMIT,
  RECENT_CONTEXT_CHAR_LIMIT,
  MAX_PROACTIVE_ASSISTANTS_IN_CONTEXT,
} = require('./chatMemoryPolicy');
const { CHARACTER_DIR, DATA_DIR } = require('./appPaths');
const { writeUtf8Atomic, writeJsonAtomic } = require('./atomic-persistence');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

function getCharacterDir(characterId) {
  return path.join(CHARACTER_DIR, characterId);
}

// ============================================================
// character.md 统一读写（合并原5个txt为1个md，方便索引和调用）
// 格式：用 ## 章节标题分隔各字段
// ============================================================

const CHARACTER_MD_SECTIONS = ['背景', '性格', '说话风格', '喜好', '故事'];
const CHARACTER_MD_KEYS = ['background', 'personality', 'speaking_style', 'likes', 'story'];

// 从 character.md 读取所有字段，返回 { background, personality, speaking_style, likes, story }
function readCharacterMd(characterId) {
  const filePath = path.join(getCharacterDir(characterId), 'character.md');

  // 迁移：如果 character.md 不存在但旧 txt 文件存在，自动合并生成
  if (!fs.existsSync(filePath)) {
    const migrated = migrateFromTxt(characterId);
    if (migrated) return migrated;
    // 无旧文件，返回空
    return { background: '', personality: '', speaking_style: '', likes: '', story: '' };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseCharacterMd(content);
  } catch (error) {
    console.error(`[PromptBuilder] 读取 character.md 失败:`, error.message);
    return { background: '', personality: '', speaking_style: '', likes: '', story: '' };
  }
}

// 解析 character.md 内容为字段对象
function parseCharacterMd(content) {
  const result = { background: '', personality: '', speaking_style: '', likes: '', story: '' };
  if (!content) return result;

  // 按 ## 标题分割
  const sectionRegex = /^## (.+)$/gm;
  const matches = [];
  let match;
  while ((match = sectionRegex.exec(content)) !== null) {
    matches.push({ title: match[1].trim(), index: match.index, matchLen: match[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const title = matches[i].title;
    const startIdx = matches[i].index + matches[i].matchLen;
    const endIdx = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const sectionContent = content.substring(startIdx, endIdx).trim();

    // 匹配章节标题到字段名
    const keyIdx = CHARACTER_MD_SECTIONS.indexOf(title);
    if (keyIdx !== -1) {
      result[CHARACTER_MD_KEYS[keyIdx]] = sectionContent;
    }
  }

  return result;
}

// 将字段对象写入 character.md
function writeCharacterMd(characterId, fields) {
  const dir = getCharacterDir(characterId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 直接读取文件内容（不走迁移逻辑，避免循环调用）
  const filePath = path.join(dir, 'character.md');
  let existing = { background: '', personality: '', speaking_style: '', likes: '', story: '' };
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      existing = parseCharacterMd(content);
    } catch (e) {}
  }

  const merged = { ...existing, ...fields };

  const lines = [];
  for (let i = 0; i < CHARACTER_MD_SECTIONS.length; i++) {
    const sectionTitle = CHARACTER_MD_SECTIONS[i];
    const key = CHARACTER_MD_KEYS[i];
    const value = merged[key] || '';
    lines.push(`## ${sectionTitle}`);
    lines.push(value);
    lines.push(''); // 空行分隔
  }

  try {
    writeUtf8Atomic(filePath, lines.join('\n').trim() + '\n');
    return true;
  } catch (error) {
    console.error(`[PromptBuilder] 写入 character.md 失败:`, error.message);
    return false;
  }
}

// 从旧5个txt文件迁移到character.md
function migrateFromTxt(characterId) {
  const dir = getCharacterDir(characterId);
  const txtFiles = ['background.txt', 'personality.txt', 'speaking_style.txt', 'likes.txt', 'story.txt'];

  // 检查是否有旧文件存在
  const hasAnyTxt = txtFiles.some(f => fs.existsSync(path.join(dir, f)));
  if (!hasAnyTxt) return null;

  console.log(`[PromptBuilder] 检测到旧txt文件，自动迁移到 character.md`);
  const fields = {};
  const txtKeys = ['background', 'personality', 'speaking_style', 'likes', 'story'];

  for (let i = 0; i < txtFiles.length; i++) {
    const filePath = path.join(dir, txtFiles[i]);
    try {
      if (fs.existsSync(filePath)) {
        fields[txtKeys[i]] = fs.readFileSync(filePath, 'utf-8').trim();
      }
    } catch (e) {}
  }

  // 写入 character.md
  writeCharacterMd(characterId, fields);

  // 删除旧txt文件
  for (const f of txtFiles) {
    try {
      const filePath = path.join(dir, f);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}
  }

  console.log(`[PromptBuilder] 迁移完成，已删除旧txt文件`);
  return fields;
}

function readCharacterFile(characterId, filename) {
  const filePath = path.join(getCharacterDir(characterId), filename);
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch (error) {
    console.error(`[PromptBuilder] 读取角色文件 ${characterId}/${filename} 失败:`, error.message);
    return '';
  }
}

function writeCharacterFile(characterId, filename, content) {
  const dir = getCharacterDir(characterId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, filename);
  try {
    writeUtf8Atomic(filePath, content);
    return true;
  } catch (error) {
    console.error(`[PromptBuilder] 写入角色文件 ${characterId}/${filename} 失败:`, error.message);
    return false;
  }
}

function readCharacterProfile(characterId) {
  const filePath = path.join(getCharacterDir(characterId), 'profile.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    console.error('[PromptBuilder] 读取角色配置失败:', error.message);
    return { name: 'AI', role: '聊天伙伴', style: '自然亲切' };
  }
}

function writeCharacterProfile(characterId, profile) {
  const dir = getCharacterDir(characterId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, 'profile.json');
  try {
    writeJsonAtomic(filePath, profile);
    return true;
  } catch (error) {
    console.error('[PromptBuilder] 写入角色配置失败:', error.message);
    return false;
  }
}

function readLore(characterId) {
  const filePath = path.join(getCharacterDir(characterId), 'lore.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return { entries: [] };
  }
}

function writeLore(characterId, lore) {
  const dir = getCharacterDir(characterId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, 'lore.json');
  try {
    writeJsonAtomic(filePath, lore);
    return true;
  } catch (error) {
    console.error('[PromptBuilder] 写入lore失败:', error.message);
    return false;
  }
}

function readSkill(characterId) {
  const filePath = path.join(getCharacterDir(characterId), 'SKILL.md');
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch (error) {
    return '';
  }
}

function writeSkill(characterId, content) {
  const dir = getCharacterDir(characterId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, 'SKILL.md');
  try {
    if (fs.existsSync(filePath)) {
      const oldContent = fs.readFileSync(filePath, 'utf-8');
      if (oldContent.trim()) {
        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        const backupPath = path.join(dir, `SKILL_backup_${ts}.md`);
        writeUtf8Atomic(backupPath, oldContent);
      }
    }
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith('SKILL_backup_') && f.endsWith('.md'))
      .sort();
    while (backups.length > 2) {
      fs.unlinkSync(path.join(dir, backups.shift()));
    }
    writeUtf8Atomic(filePath, content);
    return true;
  } catch (error) {
    console.error(`[PromptBuilder] 写入Skill失败:`, error.message);
    return false;
  }
}

function rollbackSkill(characterId) {
  const dir = getCharacterDir(characterId);
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith('SKILL_backup_') && f.endsWith('.md'))
    .sort();
  if (backups.length === 0) return null;
  const latestBackup = backups[backups.length - 1];
  const backupPath = path.join(dir, latestBackup);
  const content = fs.readFileSync(backupPath, 'utf-8');
  const filePath = path.join(dir, 'SKILL.md');
  writeUtf8Atomic(filePath, content);
  fs.unlinkSync(backupPath);
  return content;
}

function readSkillUrls(characterId) {
  const filePath = path.join(getCharacterDir(characterId), 'skill_urls.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return [];
  }
}

function writeSkillUrls(characterId, urls) {
  const dir = getCharacterDir(characterId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, 'skill_urls.json');
  try {
    writeJsonAtomic(filePath, urls);
    return true;
  } catch (error) {
    console.error('[PromptBuilder] 写入Skill网址失败:', error.message);
    return false;
  }
}

function readSupplementary(characterId) {
  const filePath = path.join(getCharacterDir(characterId), 'supplementary.txt');
  try { return fs.readFileSync(filePath, 'utf-8').trim(); } catch (error) { return ''; }
}

function writeSupplementary(characterId, content) {
  return writeCharacterFile(characterId, 'supplementary.txt', content);
}

function readKnowledgeUrls(characterId) {
  const filePath = path.join(getCharacterDir(characterId), 'knowledge_urls.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    const globalPath = path.join(DATA_DIR, 'knowledge_urls.json');
    try {
      const urls = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
      writeKnowledgeUrls(characterId, urls);
      return urls;
    } catch (e) {
      return [];
    }
  }
}

function writeKnowledgeUrls(characterId, urls) {
  const dir = getCharacterDir(characterId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, 'knowledge_urls.json');
  try {
    writeJsonAtomic(filePath, urls);
    return true;
  } catch (error) {
    console.error('[PromptBuilder] 写入知识网址失败:', error.message);
    return false;
  }
}

function readConversationSkills(characterId) {
  // 仅读取角色专属对话技能；不回退到默认（通用技能对用户隐藏，不自动注入）
  if (characterId) {
    const charPath = path.join(CHARACTER_DIR, characterId, 'conversation_skills.txt');
    try {
      const content = fs.readFileSync(charPath, 'utf-8').trim();
      if (content) return content;
    } catch (error) {}
  }
  return '';
}

function writeConversationSkills(characterId, content) {
  const charPath = path.join(CHARACTER_DIR, characterId, 'conversation_skills.txt');
  const dir = path.dirname(charPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeUtf8Atomic(charPath, content);
}

function writeDefaultConversationSkills(content) {
  const filePath = path.join(DATA_DIR, 'conversation_skills.txt');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeUtf8Atomic(filePath, content);
}

function listCharacters() {
  if (!fs.existsSync(CHARACTER_DIR)) {
    return [];
  }
  const dirs = fs.readdirSync(CHARACTER_DIR, { withFileTypes: true });
  const characters = [];
  for (const d of dirs) {
    if (d.isDirectory()) {
      const profilePath = path.join(CHARACTER_DIR, d.name, 'profile.json');
      let name = d.name;
      try {
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
        name = profile.name || d.name;
      } catch (e) {}
      characters.push({ id: d.name, name });
    }
  }
  return characters;
}

function createCharacter(characterId, data) {
  const dir = getCharacterDir(characterId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const profile = {
    name: data.name || characterId,
    role: data.role || '',
    user_title: data.user_title || '',
    user_cognition: data.user_cognition || '',
    style: data.style || '',
  };
  writeCharacterProfile(characterId, profile);

  // 写入 character.md（合并5个字段为1个md文件）
  writeCharacterMd(characterId, {
    background: data.background || '',
    personality: data.personality || '',
    speaking_style: data.speaking_style || '',
    likes: data.likes || '',
    story: data.story || '',
  });

  // 其他配置文件
  const files = {
    'supplementary.txt': data.supplementary || '',
    'lore.json': JSON.stringify({ entries: [] }, null, 2),
    'knowledge_urls.json': JSON.stringify([], null, 2),
  };

  for (const [filename, content] of Object.entries(files)) {
    writeUtf8Atomic(path.join(dir, filename), content);
  }

  return { id: characterId, name: profile.name };
}

function deleteCharacter(characterId) {
  const dir = getCharacterDir(characterId);
  if (characterId === 'default') return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });

    const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith(characterId + '_'));
    for (const f of dataFiles) {
      fs.unlinkSync(path.join(DATA_DIR, f));
    }
    return true;
  } catch (error) {
    console.error('[PromptBuilder] 删除角色失败:', error.message);
    return false;
  }
}

function buildStableSystemPrompt(characterId) {
  const profile = readCharacterProfile(characterId);
  const charMd = readCharacterMd(characterId);
  const background = charMd.background;
  const personality = charMd.personality;
  const speakingStyle = charMd.speaking_style;
  const likes = charMd.likes;
  const story = charMd.story;
  const supplementary = readSupplementary(characterId);
  const skill = readSkill(characterId);
  const lore = readLore(characterId);
  const conversationSkills = readConversationSkills(characterId);

  const promptPath = path.join(PROMPTS_DIR, 'system_prompt.txt');
  let systemPrompt = '';
  try {
    systemPrompt = fs.readFileSync(promptPath, 'utf-8');
  } catch (error) {
    console.error('[PromptBuilder] 读取系统提示词模板失败:', error.message);
    systemPrompt = '你是一个友好的AI聊天伙伴。';
  }

  systemPrompt = systemPrompt.replace('{{CHARACTER_NAME}}', profile.name || 'AI');
  // 用户称呼：优先 profile.user_title（设置中的"用户称呼"），没有则默认"你"
  const userTitle = (profile.user_title && String(profile.user_title).trim()) || '你';
  systemPrompt = systemPrompt.replace(/\{\{USER_TITLE\}\}/g, userTitle);
  // 角色对用户认知：与"用户称呼"同优先级，作为最高级人物设定注入
  const userCognition = (profile.user_cognition && String(profile.user_cognition).trim()) || '';
  if (userCognition) {
    systemPrompt = systemPrompt.replace(/\{\{USER_COGNITION\}\}/g, userCognition);
  } else {
    systemPrompt = systemPrompt.replace(/\{\{USER_COGNITION\}\}/g, '（未指定，不自行推断用户身份）');
  }
  systemPrompt = systemPrompt.replace('{{CHARACTER_PROFILE}}', JSON.stringify(profile, null, 2));
  systemPrompt = systemPrompt.replace('{{CHARACTER_BACKGROUND}}', background);
  systemPrompt = systemPrompt.replace('{{CHARACTER_PERSONALITY}}', personality);
  systemPrompt = systemPrompt.replace('{{CHARACTER_SPEAKING_STYLE}}', speakingStyle);
  systemPrompt = systemPrompt.replace('{{CHARACTER_LIKES}}', likes);
  systemPrompt = systemPrompt.replace('{{CHARACTER_STORY}}', story);

  const chatRulePrompt = buildChatRulePrompt({
    characterName: profile.name || '当前角色',
    userTitle,
  });

  // 低频长期记忆会作为第二个 system 消息放在原始历史之前；实时情绪、RAG 与
  // 日期则留在当前用户消息前。这样稳定规则 + 低频记忆能形成更长的缓存前缀。
  systemPrompt = systemPrompt.replace('{{MEMORY}}', '（低频长期记忆与本轮动态上下文由服务端分层提供）');
  systemPrompt = systemPrompt.replace('{{COMPRESSED_HISTORY}}', '（累计摘要由服务端放在近期原始对话之前）');

  if (supplementary && supplementary.trim()) {
    systemPrompt += '\n\n【用户补充设定（高于自动蒸馏资料）】\n' + supplementary;
  }

  if (conversationSkills && conversationSkills.trim()) {
    systemPrompt += '\n\n【用户在设置中补充的角色对话规则（高于基础角色资料与自动蒸馏资料）】\n' + conversationSkills;
  }

  if (skill && skill.trim()) {
    systemPrompt += '\n\n【角色专属蒸馏资料（不得覆盖用户明确设置或当前消息）】\n' + skill;
  }

  if (lore.entries && lore.entries.length > 0) {
    const loreText = lore.entries.map(e => e.content).join('\n');
    if (loreText.trim()) {
      systemPrompt += '\n\n【联网查询保存的设定】\n' + loreText;
    }
  }

  // 表情包系统：仅当角色配置了表情包时注入
  const stickerPrompt = stickerService.buildStickerPrompt(characterId);
  if (stickerPrompt) {
    systemPrompt += stickerPrompt;
  }

  // 可见正文不再携带 TTS 控制标签。关键词强调通过回复末尾的隐藏表现元数据传递，
  // 服务端验证后才交给语音引擎，避免控制标记进入历史或 UI。
  systemPrompt += `

【语音与表演元数据】
正文中不要输出[语气:...]等控制标签。需要突出关键词时，只在回复末尾隐藏元数据的 emphasis 中填写；最多2个短语，短语必须逐字出现在正文里。

【引用用户原话的规范】
默认不引用用户原话；先理解后用角色自己的判断、回应或建议转述，不要使用固定的“你之前说过”句式。只有专有名词、数字、约定等必须精确时，才用中文引号“”引用一个短片段（通常不超过12字），不要把引用当成回复主体，也不要连续多轮引用；禁止把用户整句话放进引号里。
`;

  // 所有动态资料都追加完后再次收束优先级，避免较晚出现的技能、知识或表情包说明
  // 因位置更靠后而盖过当前消息、用户设置或角色边界。
  systemPrompt += `\n\n${buildFinalDecisionPrompt()}\n`;

  return `${chatRulePrompt}\n\n${systemPrompt}`;
}

function buildDurableContext(characterId, userInput = '') {
  const blocks = [];
  const compressed = historyService.readCompressed(characterId);
  const relevanceGated = Boolean(String(userInput || '').trim());
  const layeredMemory = memoryService.buildLayeredMemoryContext(characterId, userInput, {
    includeEmotion: false,
    includeSessionSummaries: !String(compressed.summary || '').trim(),
    relevantOnly: relevanceGated,
  });
  if (layeredMemory && layeredMemory.trim()) blocks.push(layeredMemory.trim());
  if (String(compressed.summary || '').trim()
      && (!relevanceGated || memoryService.isMemoryTextRelevant(compressed.summary, userInput))) {
    blocks.push(`【压缩节点前的累计摘要（低于用户原话与明确设置）】\n${compressed.summary.trim()}`);
  }

  if (blocks.length === 0) return '';
  return `【低频长期连续性（低于用户当前消息与明确设置）】\n${blocks.join('\n\n')}\n【低频长期连续性结束】`;
}

function buildVolatileTurnContext(characterId, userInput) {
  const blocks = [];
  const emotionalContext = memoryService.buildEmotionalMemoryContext(characterId);
  if (emotionalContext) blocks.push(emotionalContext);

  const memory = memoryService.readMemory(characterId);
  if (memoryService.checkBirthday(memory)) {
    blocks.push('【日期提醒】今天是用户已保存的生日；仅在当前话题自然相关时简短祝福。');
  }
  const festival = memoryService.checkFestival();
  if (festival) {
    blocks.push(`【日期提醒】今天是${festival}；仅在当前话题自然相关时提及。`);
  }

  // 旧对话 RAG 只检索压缩节点前已归档的用户原话。本地检索不消耗 API token；
  // 无回忆意图且没有强主题命中时 searchUserContext 返回空，不向本轮请求注入内容。
  if (userInput && userInput.trim() && userInput.trim().length > 2) {
    const activeUserTexts = historyService.readActiveHistory(characterId)
      .filter(message => message && message.role === 'user')
      .map(message => message.content);
    const ragResults = archiveService.searchUserContext(characterId, userInput, 3, {
      excludeTexts: activeUserTexts,
    });
    if (ragResults.length > 0) {
      const ragText = ragResults.map(result => `- [${result.time}] 用户原话: ${result.content || result.snippet}`).join('\n');
      blocks.push(`【按当前话题取回的压缩节点前原文】\n${ragText}\n只用于恢复事实与上下文，不照搬旧助手措辞。`);
    }

    const knowledgeResults = archiveService.searchKnowledge(characterId, userInput, 3);
    if (knowledgeResults.length > 0) {
      const knowledgeText = knowledgeResults.map(item => `- [${item.title}] ${item.content}`).join('\n');
      blocks.push(`【角色知识库（低于用户保存的补充设定）】\n${knowledgeText}`);
    }
  }

  const today = new Date();
  const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][today.getDay()];
  const hour = today.getHours();
  let timePeriod = '深夜';
  if (hour >= 5 && hour < 9) timePeriod = '清晨';
  else if (hour >= 9 && hour < 12) timePeriod = '上午';
  else if (hour >= 12 && hour < 14) timePeriod = '中午';
  else if (hour >= 14 && hour < 18) timePeriod = '下午';
  else if (hour >= 18 && hour < 22) timePeriod = '晚上';
  blocks.push(`【本地日期与时段】${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日 星期${dayOfWeek} ${timePeriod}。不要复述时间。`);

  if (blocks.length === 0) return '';
  return `【本轮后台上下文】\n${blocks.join('\n\n')}\n【后台上下文结束】`;
}

function buildTurnContext(characterId, userInput) {
  return [
    buildDurableContext(characterId, userInput),
    buildVolatileTurnContext(characterId, userInput),
  ].filter(Boolean).join('\n\n');
}

// 供设置预览/测试使用的完整提示；真实聊天请求会把稳定部分与本轮动态部分分开放置。
function buildSystemPrompt(characterId, userInput) {
  const stable = buildStableSystemPrompt(characterId);
  const durable = buildDurableContext(characterId, userInput);
  const volatile = buildVolatileTurnContext(characterId, userInput);
  return [stable, durable, volatile].filter(Boolean).join('\n\n');
}

function buildMessages(characterId, userInput, imageBase64, options = {}) {
  const systemPrompt = buildStableSystemPrompt(characterId);
  const history = historyService.readActiveHistory(characterId);
  const maxContext = Math.max(1, parseInt(process.env.MAX_CONTEXT_MESSAGES) || RECENT_CONTEXT_MESSAGE_LIMIT);
  const maxContextChars = Math.max(1000, parseInt(process.env.MAX_CONTEXT_CHARS) || RECENT_CONTEXT_CHAR_LIMIT);
  // 注意：server.js 在调用 buildMessages 之前已把当前用户消息 addMessage 写入历史，
  // 因此 recentHistory 的最后一条通常就是本次 userInput。
  // 末尾我们会再 push 一次 userInput 作为最新消息，为避免 AI 收到两次相同输入导致
  // "echo 式重复回复"，这里从 recentHistory 末尾剔除与 userInput 重复的最后一条 user 消息。
  let historyWithoutCurrent = history;
  if (historyWithoutCurrent.length > 0) {
    const last = historyWithoutCurrent[historyWithoutCurrent.length - 1];
    if (last && last.role === 'user') {
      // 比较时去除时间标记前缀和图片标记，只看核心文本
      const lastCore = String(last.content || '').replace(/\[图片: [^\]]+\]/g, '').trim();
      const inputCore = String(userInput || '').trim();
      if (lastCore === inputCore || lastCore.indexOf(inputCore) === 0 || inputCore.indexOf(lastCore) === 0) {
        historyWithoutCurrent = historyWithoutCurrent.slice(0, -1);
      }
    }
  }
  const recentHistory = selectRecentConversationContext(historyWithoutCurrent, {
    maxMessages: maxContext,
    maxChars: maxContextChars,
    maxProactiveAssistants: MAX_PROACTIVE_ASSISTANTS_IN_CONTEXT,
  });

  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  const durableContext = buildDurableContext(characterId, userInput);
  if (durableContext) {
    messages.push({ role: 'system', content: durableContext });
  }

  for (const msg of recentHistory) {
    // 只在用户消息前加时间标记，assistant消息不加（避免AI模仿在回复中加时间戳）
    const timeTag = (msg.role === 'user' && msg.time) ? `[${msg.time}] ` : '';
    const textContent = timeTag + msg.content;
    if (msg.role === 'user') {
      const imgMatch = msg.content.match(/\[图片: (uploads\/[^\]]+)\]/);
      if (imgMatch) {
        const textPart = msg.content.replace(/\[图片: [^\]]+\]/, '').trim();
        const content = [];
        if (textPart) {
          content.push({ type: 'text', text: timeTag + textPart });
        }
        content.push({ type: 'text', text: '[用户发送了一张图片]' });
        messages.push({ role: 'user', content: content.length === 1 ? content[0].text : content });
      } else {
        messages.push({ role: 'user', content: textContent });
      }
    } else {
      // ★ 剥离 assistant 历史中的 [表情包:xxx] 标记，防止 AI 看到历史里有表情包就模仿着连续发
      // 表情包频率由 prompt 与后端 8 条硬间隔共同控制，而不是靠模型模仿历史标记。
      const cleanedContent = (msg.role === 'assistant')
        ? textContent.replace(/\s*\[表情包:[^\]]*\]/g, '').trim()
        : textContent;
      messages.push({ role: msg.role, content: cleanedContent });
    }
  }

  const turnContext = buildVolatileTurnContext(characterId, userInput);
  const { externalContext = '' } = options;
  const normalizedExternalContext = String(externalContext || '').trim();
  const contextBlocks = [turnContext, normalizedExternalContext].filter(Boolean);
  const currentUserText = contextBlocks.length > 0
    ? `${contextBlocks.join('\n\n')}\n\n【用户当前消息】\n${userInput || (imageBase64 ? '请描述这张图片' : '')}`
    : userInput;

  if (imageBase64) {
    const userContent = [
      { type: 'text', text: currentUserText || '请描述这张图片' },
      { type: 'image_url', image_url: { url: imageBase64 } },
    ];
    messages.push({ role: 'user', content: userContent });
  } else {
    messages.push({ role: 'user', content: currentUserText });
  }

  return messages;
}

module.exports = {
  buildSystemPrompt,
  buildStableSystemPrompt,
  buildDurableContext,
  buildVolatileTurnContext,
  buildTurnContext,
  buildMessages,
  readCharacterProfile,
  writeCharacterProfile,
  readCharacterFile,
  writeCharacterFile,
  readCharacterMd,
  writeCharacterMd,
  readLore,
  writeLore,
  readSupplementary,
  writeSupplementary,
  readSkill,
  writeSkill,
  rollbackSkill,
  readSkillUrls,
  writeSkillUrls,
  readKnowledgeUrls,
  writeKnowledgeUrls,
  readConversationSkills,
  writeConversationSkills,
  writeDefaultConversationSkills,
  listCharacters,
  createCharacter,
  deleteCharacter,
};
