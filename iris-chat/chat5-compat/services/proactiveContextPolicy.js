// owner-trace: wha1999/core/proactive-context-policy

const FIXED_FESTIVALS = Object.freeze({
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '05-01': '劳动节',
  '06-01': '儿童节',
  '10-01': '国庆节',
  '12-25': '圣诞节',
});

// Lunar festivals have no stable Gregorian date. Keep a bounded table so the
// standalone package does not need a calendar dependency or network access.
const LUNAR_FESTIVALS = Object.freeze({
  '2025-01-29': '春节', '2025-02-12': '元宵节', '2025-05-31': '端午节',
  '2025-08-29': '七夕节', '2025-10-06': '中秋节',
  '2026-02-17': '春节', '2026-03-03': '元宵节', '2026-06-19': '端午节',
  '2026-08-19': '七夕节', '2026-09-25': '中秋节',
  '2027-02-06': '春节', '2027-02-20': '元宵节', '2027-06-09': '端午节',
  '2027-08-08': '七夕节', '2027-09-15': '中秋节',
  '2028-01-26': '春节', '2028-02-09': '元宵节', '2028-05-28': '端午节',
  '2028-08-26': '七夕节', '2028-10-03': '中秋节',
  '2029-02-13': '春节', '2029-02-27': '元宵节', '2029-06-16': '端午节',
  '2029-08-16': '七夕节', '2029-09-22': '中秋节',
  '2030-02-03': '春节', '2030-02-17': '元宵节', '2030-06-05': '端午节',
  '2030-08-05': '七夕节', '2030-09-12': '中秋节',
});

// A remembered interaction is not automatically an unresolved task.  Keep a
// small semantic key for personal topics that are especially easy to repeat
// with different wording (for example, repeatedly asking about a past
// "想看你害羞的样子" request).
const PROACTIVE_TOPIC_FRESHNESS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getGreetingTypeByHour(hour) {
  if (hour >= 6 && hour < 13) return 'morning';
  if (hour >= 13 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'late_night';
}

function getGreetingDecision(state = {}, now = new Date()) {
  const date = localDateKey(now);
  if (state.daily_greeting_sent_date === date) {
    return { shouldGreet: false, type: null, reason: 'already_sent_today', date };
  }
  return { shouldGreet: true, type: getGreetingTypeByHour(now.getHours()), reason: 'first_entry_today', date };
}

function getFestivalForDate(date = new Date(), festivalNotes = []) {
  const dateKey = localDateKey(date);
  const monthDay = dateKey.slice(5);
  const personal = (Array.isArray(festivalNotes) ? festivalNotes : []).find(note => {
    if (!note || typeof note !== 'object') return false;
    return note.date === dateKey || note.date === monthDay;
  });
  return (personal && (personal.name || personal.festival)) || LUNAR_FESTIVALS[dateKey] || FIXED_FESTIVALS[monthDay] || null;
}

function getInactivityTier(elapsedMinutes) {
  const minutes = Math.max(0, Number(elapsedMinutes) || 0);
  if (minutes < 5) return { id: 'none', minMinutes: 0, tone: 'none' };
  if (minutes < 30) return { id: 'light_followup', minMinutes: 5, tone: 'casual' };
  if (minutes < 180) return { id: 'quiet_checkin', minMinutes: 30, tone: 'rest_assumption' };
  if (minutes < 360) return { id: 'gentle_checkin', minMinutes: 180, tone: 'gentle' };
  if (minutes < 720) return { id: 'curious_checkin', minMinutes: 360, tone: 'curious' };
  if (minutes < 1440) return { id: 'warm_concern', minMinutes: 720, tone: 'warm' };
  if (minutes < 2160) return { id: 'concerned', minMinutes: 1440, tone: 'concerned' };
  if (minutes < 2880) return { id: 'anxious_concern', minMinutes: 2160, tone: 'anxious' };
  return { id: 'long_absence', minMinutes: 2880, tone: 'calm_concern' };
}

function normalizeUserDetail(text) {
  const value = String(text || '')
    .replace(/<\|\s*(?:assistant|user|system|end|im_start|im_end)\s*\|>/gi, ' ')
    .replace(/\[图片:[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value || value.length < 4) return '';
  const withoutDecoration = value
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[()（）\s_*~～^＾≧≦▽♡♥╥ω✿☆※＊∧∨∃∀∇∂。！!？?…·-]/g, '');
  return withoutDecoration.length >= 3 ? value.slice(0, 160) : '';
}

function getRecentUserDetail(history) {
  const users = (Array.isArray(history) ? history : [])
    .filter(message => message && message.role === 'user')
    .map(message => normalizeUserDetail(message.content))
    .filter(Boolean);
  return users.length > 0 ? users[users.length - 1] : '';
}

function buildProactiveUserContext(history, limit = 4) {
  const users = (Array.isArray(history) ? history : [])
    .filter(message => message && message.role === 'user' && String(message.content || '').trim())
    .slice(-Math.max(1, limit))
    .map(message => ({ ...message, detail: normalizeUserDetail(message.content) }))
    .filter(message => message.detail);
  if (users.length === 0) return '';
  const last = users[users.length - 1];
  const earlier = users.slice(0, -1);
  const lines = [`最后一条用户原话：[${last.time || '时间未知'}] ${last.detail}`];
  if (earlier.length > 0) {
    lines.push('最近可核实的用户细节：');
    for (const message of earlier) lines.push(`- [${message.time || '时间未知'}] ${message.detail}`);
  }
  lines.push('跟进时最多自然引用一个具体细节；没有明确细节时不得自行补写工作、地点、情绪或经历。');
  lines.push('提及用户说过的话时，优先用角色自己的理解自然转述；只有专有名词、数字或约定必须精确时，才引用一个不超过12字的关键短语，禁止整句复述用户原话，也不要连续使用相同引用开场。');
  return lines.join('\n');
}

function buildProactiveInstruction(options = {}) {
  const type = options.type || 'greeting';
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const festival = options.festival || null;
  const elapsedMinutes = Math.max(0, Number(options.elapsedMinutes) || 0);
  const lines = [];

  if (type === 'morning') lines.push('这是用户今天第一次进入聊天。自然地说一句早安，并从吃饭、出门安排或今天的计划中任选一个轻松切入。');
  else if (type === 'afternoon') lines.push('这是用户今天第一次进入聊天。自然地打招呼，并轻轻问一句今天进行得怎样。');
  else if (type === 'evening') lines.push('这是用户今天第一次进入聊天。自然地打招呼，可以关心今天是否顺利，但不要制造压力。');
  else if (type === 'late_night' || type === 'late_night_care') lines.push('现在已过22点。用关心而不命令的口吻问对方是否准备休息；同一夜只提醒一次，不夸大担忧。');
  else if (type === 'idle' || type === 'long-absence') {
    const tier = getInactivityTier(elapsedMinutes);
    const lateNight = now.getHours() >= 22 || now.getHours() < 6;
    if (tier.id === 'light_followup') lines.push('用户暂时没有回复。只延续最后一个未完话题，保持轻松、不催促，也不要升级关切程度。');
    else if (tier.id === 'quiet_checkin' && lateNight) lines.push('现在是深夜，用户约半小时没有回复。优先理解为用户可能已经休息；可以自然道晚安、提醒照顾身体，保持轻柔，不升级关切程度。');
    else if (tier.id === 'quiet_checkin') lines.push('用户约半小时没有回复。轻轻延续最近话题或问候即可，不猜测原因，不升级为担心。');
    else if (tier.id === 'gentle_checkin') lines.push('用户已有一段时间没有回复。结合最后一个用户话题做一次温和问候，不猜测原因。');
    else if (tier.id === 'curious_checkin') lines.push('用户约六小时没有回复。可以带着自然的疑问询问近况，表达一点挂念，但不追问、不猜测原因。');
    else if (tier.id === 'warm_concern') lines.push('用户较久没有出现。可以表达一点挂念并给对方留出空间，不委屈、不责备。');
    else if (tier.id === 'concerned') lines.push('用户约一天没有回复。可以更明确地说有些担心，优先关心身体和近况，但仍不质问、不施压。');
    else if (tier.id === 'anxious_concern') lines.push('用户约一天半没有回复。担心可以再明显一些；只有当前语境和角色 Skill 支持时才略带焦急，禁止情绪勒索或虚构事故。');
    else if (tier.id === 'long_absence') lines.push('用户已经超过48小时没有回复。可以明确说“有些担心”或“有些挂念”，但不得质问、惊吓或情绪勒索；优先跟进最近用户明确提过的细节，没有可靠细节就只关心近况。');
    else lines.push('当前间隔不足，不应发送主动消息。');
  } else lines.push('主动发起一句简短、自然、与最近用户话题有关的问候。');

  if (festival) lines.push(`今天是${festival}。把祝福自然融入一句话，只提一次，不写成群发通知。`);
  if (now.getHours() >= 22 || now.getHours() < 6) {
    lines.push('当前是深夜。禁止写阳光、日光、晨光、曙光、夕阳、晚霞、光束、天色或光线渐暗等自然光变化；除非最近用户原话明确提到室内灯光，否则也不得自行描写灯光。');
  }
  lines.push('不要自行搭建琴房、窗边、花茶、天气、风声等场景；只有最近用户原话明确提供时才能引用。优先接住最近未完话题中的一个具体细节。');
  lines.push('只写1至2句；普通问候默认不写括号动作，不复用最近主动消息的主题或场景。');
  lines.push('每次主动消息只承担一个功能：轻量延续、日常问候、温和关心或自然拓展。先回应最近用户留下的事实或未完话题，再决定是否打开一个相关新点；用户刚开始推进某件事时不要突然转题。');
  lines.push('主动内容要轮换回应动作和角度：不要连续使用“想起/记得/挂念”开场，不要连续追问同一件事的进展，也不要只把同一句话换成同义词。若近期已用过追问，下一次可以改为一句具体观察、简短建议或留白；没有新的可靠细节时宁可只问候，不制造剧情。');
  lines.push('关心强度与证据匹配：短暂无回复只轻轻问候；用户明确说累、难过或不舒服时先回应该信号；长时间无回复才逐级增强关切。不得因为一个问号、普通沉默或旧记忆直接升级情绪，也不得用“后来怎样了”反复索取回应。');
  lines.push('长期记忆不是主动话题清单。同一长期主题即使改用同义词、换开场或改成“想起/挂念”等说法，也视为同一主题；主动跟进后在新鲜度冷却期内不得再次提起。除非用户重新提及、提供明确新进展，或冷却期结束，否则改用当前问候或其他可靠细节，不要反复追问“后来怎样了”。过去的暧昧请求、玩笑或一次性互动不自动视为未解决事件。');
  lines.push('以上沉默时长只提供通用情绪倾向；最终表达必须结合当前话题、用户已提供的事实和角色 Skill，不得机械套用情绪词。');
  lines.push(`当前本地小时：${now.getHours()}。`);
  return lines.join('\n');
}

function classifyPersonalTopic(text) {
  const value = String(text || '');
  if (/(?:想看|想要看|看看|希望看到).{0,10}(?:害羞|脸红|羞涩|不好意思)/.test(value)
    || /(?:害羞|脸红|羞涩|不好意思).{0,10}(?:样子|模样|反应)/.test(value)) {
    return 'shy_appearance_request';
  }
  return '';
}

function classifyProactiveContent(text) {
  const value = String(text || '');
  const topicKey = classifyPersonalTopic(value);
  let topicCategory = 'general_checkin';
  if (/睡|休息|熬夜|晚安/.test(value)) topicCategory = 'sleep_care';
  else if (/吃|饭|早餐|午餐|晚餐/.test(value)) topicCategory = 'meal_care';
  else if (/工作|学习|忙|计划|今天过得/.test(value)) topicCategory = 'daily_checkin';
  else if (/想念|想你|好久/.test(value)) topicCategory = 'missing_you';
  else if (/节|生日|祝/.test(value)) topicCategory = 'festival';

  let actionCategory = 'none';
  if (/[（(][^）)]*(?:窗|窗边)[^）)]*[）)]/.test(value)) actionCategory = 'window';
  else if (/[（(][^）)]*(?:琴|弹奏|演奏)[^）)]*[）)]/.test(value)) actionCategory = 'music';
  else if (/[（(][^）)]+[）)]/.test(value)) actionCategory = 'stage_action';

  let sceneCategory = 'none';
  if (/琴房|琴盖|钢琴|琴谱|新谱/.test(value)) sceneCategory = 'music_room';
  else if (/窗边|窗外|窗前|夜色|月色/.test(value)) sceneCategory = 'window_night';
  else if (/花茶|泡.{0,3}茶|茶香|点心/.test(value)) sceneCategory = 'tea_food';
  else if (/阳光|日光|晨光|曙光|夕阳|晚霞|光束|光线|天色|风声|晚风/.test(value)) sceneCategory = 'light_weather';

  const motifCategories = [];
  if (/琴|曲子|旋律|歌声|弹奏|演奏|奏一曲|哼唱|新谱/.test(value)) motifCategories.push('music_invitation');
  if (/花茶|泡.{0,3}茶|茶香|点心/.test(value)) motifCategories.push('tea_care');
  if (/窗|晚风|风声|夜色|月色/.test(value)) motifCategories.push('window_weather');
  if (/光束|光线|阳光|日光|晨光|夕阳|天色/.test(value)) motifCategories.push('light_imagery');

  let openingPattern = 'other';
  if (/若(?:你|是).{0,6}(?:得闲|有空|方便)|如果.{0,6}(?:得闲|有空|方便)|不妨/.test(value)) openingPattern = 'if_free_invitation';
  else if (/^(?:指挥[，,……\s]*)?(?:夜深了|这么晚|还没休息|你还好吗)/.test(value)) openingPattern = 'direct_checkin';
  else if (/^(?:指挥[，,……\s]*)?我(?:在听|有些担心|有些挂念|想起)/.test(value)) openingPattern = 'first_person_care';

  let invitationPattern = 'none';
  if (/来.{0,8}(?:坐坐|陪我|听听|琴房)|为你.{0,8}(?:弹奏|演奏|奏|唱)|听听.{0,8}(?:曲子|歌声|旋律)/.test(value)) invitationPattern = 'come_or_listen';

  return { topicCategory, actionCategory, sceneCategory, motifCategories, openingPattern, invitationPattern, topicKey };
}

function hasFeatureOverlap(candidate, previous) {
  if (candidate.topicKey && previous.topicKey && candidate.topicKey === previous.topicKey) return true;
  if (candidate.topicCategory && candidate.topicCategory !== 'general_checkin'
    && previous.topicCategory === candidate.topicCategory) return true;
  if (candidate.actionCategory && candidate.actionCategory !== 'none'
    && previous.actionCategory === candidate.actionCategory) return true;
  if (candidate.sceneCategory && candidate.sceneCategory !== 'none'
    && previous.sceneCategory === candidate.sceneCategory) return true;
  if (candidate.openingPattern && candidate.openingPattern !== 'other'
    && previous.openingPattern === candidate.openingPattern) return true;
  if (candidate.invitationPattern && candidate.invitationPattern !== 'none'
    && previous.invitationPattern === candidate.invitationPattern) return true;
  const candidateMotifs = Array.isArray(candidate.motifCategories) ? candidate.motifCategories : [];
  const previousMotifs = new Set(Array.isArray(previous.motifCategories) ? previous.motifCategories : []);
  return candidateMotifs.some(motif => previousMotifs.has(motif));
}

function parseMessageTime(value) {
  if (!value) return 0;
  const normalized = String(value).trim().replace(' ', 'T');
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMessageCategory(message) {
  const explicit = message && message.proactiveCategory;
  const inferred = classifyProactiveContent(message && message.content || '');
  if (explicit && typeof explicit === 'object') {
    return { ...inferred, ...explicit, topicKey: explicit.topicKey || inferred.topicKey || '' };
  }
  return inferred;
}

function passesCooldown(candidate, recentMessages, cooldown = 12, options = {}) {
  const recent = (Array.isArray(recentMessages) ? recentMessages : []).slice(-Math.max(0, cooldown));
  const nowValue = options && options.now instanceof Date ? options.now.getTime() : Number(options && options.now);
  const now = Number.isFinite(nowValue) ? nowValue : Date.now();
  const freshnessMs = Math.max(0, Number(options.topicFreshnessDays ?? PROACTIVE_TOPIC_FRESHNESS_DAYS)) * DAY_MS;
  const reopenedTopics = new Set(Array.isArray(options.reopenedTopicKeys) ? options.reopenedTopicKeys : []);
  return !recent.some(message => {
    const previous = getMessageCategory(message);
    if (!hasFeatureOverlap(candidate, previous)) return false;
    if (candidate.topicKey && previous.topicKey && candidate.topicKey === previous.topicKey) {
      if (reopenedTopics.has(candidate.topicKey)) return false;
      // Missing/invalid timestamps are treated as recent for safety and for
      // backwards compatibility with category-only unit callers.
      const timestamp = parseMessageTime(message && message.time);
      if (timestamp > 0 && now - timestamp > freshnessMs) return false;
    }
    return true;
  });
}

function validateTemporalConsistency(reply, now = new Date(), recentUserContext = '') {
  const value = String(reply || '');
  const date = now instanceof Date ? now : new Date(now || Date.now());
  const hour = date.getHours();
  const reasons = [];
  if (hour >= 22 || hour < 6) {
    const deepNightNaturalLight = /阳光|日光|晨光|曙光|夕阳|晚霞|光束|天色(?:正|渐|逐|变|已|将)|光线.{0,6}(?:渐|逐|暗|亮)/;
    if (deepNightNaturalLight.test(value)) reasons.push('deep_night_natural_light');
    if (/灯光/.test(value) && !/灯光/.test(String(recentUserContext || ''))) reasons.push('ungrounded_indoor_light');
  }
  return { valid: reasons.length === 0, reasons };
}

function validateProactiveGrounding(reply, recentUserContext = '') {
  const value = String(reply || '');
  const context = String(recentUserContext || '');
  const sceneRules = [
    { id: 'music_room', pattern: /琴房|琴盖|钢琴|琴谱|新谱/ },
    { id: 'tea_scene', pattern: /花茶|泡.{0,3}茶|茶香|点心/ },
    { id: 'window_scene', pattern: /窗边|窗外|窗前/ },
    { id: 'weather_scene', pattern: /晚风|风声|雨声|雪|天气/ },
  ];
  const reasons = sceneRules
    .filter(rule => rule.pattern.test(value) && !rule.pattern.test(context))
    .map(rule => `ungrounded_${rule.id}`);
  return { valid: reasons.length === 0, reasons };
}

module.exports = {
  FIXED_FESTIVALS,
  LUNAR_FESTIVALS,
  localDateKey,
  getGreetingTypeByHour,
  getGreetingDecision,
  getFestivalForDate,
  getInactivityTier,
  normalizeUserDetail,
  getRecentUserDetail,
  buildProactiveUserContext,
  buildProactiveInstruction,
  classifyPersonalTopic,
  classifyProactiveContent,
  parseMessageTime,
  getMessageCategory,
  PROACTIVE_TOPIC_FRESHNESS_DAYS,
  passesCooldown,
  validateTemporalConsistency,
  validateProactiveGrounding,
};
