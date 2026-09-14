import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('ChatX2 chat prompt integration', () => {
  it('uses authoritative neutral rules with a real temporary userData character', () => {
    const root = mkdtempSync(join(tmpdir(), 'chatx2-prompt-'));
    const characterDir = join(root, 'characters', '1');
    mkdirSync(characterDir, { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(characterDir, '表情包'), { recursive: true });
    writeFileSync(join(characterDir, 'profile.json'), JSON.stringify({
      name: '赛琳娜', user_title: '指挥', user_cognition: '用户明确设定',
    }), 'utf8');
    writeFileSync(join(characterDir, 'character.md'), [
      '## 背景', '背景资料', '## 性格', '温和克制', '## 说话风格', '自然口语',
      '## 喜好', '艺术', '## 故事', '故事资料',
    ].join('\n'), 'utf8');
    writeFileSync(join(characterDir, 'SKILL.md'), '# 本地角色资料\n## 表达方式\n不使用固定套话。', 'utf8');
    writeFileSync(join(characterDir, 'lore.json'), '{"entries":[]}', 'utf8');
    writeFileSync(join(characterDir, 'supplementary.txt'), '后续补充设定：用户要求被称为队长。', 'utf8');
    writeFileSync(join(characterDir, 'conversation_skills.txt'), '后续补充规则：先回答当前问题。', 'utf8');
    writeFileSync(join(root, 'data', '1_compressed_history.json'), JSON.stringify({
      summary: '用户明确说过正在准备考试。', last_compressed_index: 12,
    }), 'utf8');
    writeFileSync(join(root, 'data', '1_memory.json'), JSON.stringify({
      user_profile: {},
      preferences: {
        likes: [], dislikes: [], topics: [], communication_style: '喜欢直接但温和的回应',
      },
      permanent_facts: [],
      important_events: [{ event: '下周参加考试', date: '2026-08-20' }],
      character_events: [],
      session_summaries: [{ date: '2026-08-16', summary: '用户明确说过正在准备考试。', key_topics: ['考试'] }],
      relationship_notes: ['双方已经建立信任，角色不应把关系重置为陌生人'],
      emotional_state: {},
      character_emotional_state: {},
    }), 'utf8');
    writeFileSync(join(characterDir, '表情包', '搞怪-菲比丘比.png'), '', 'utf8');
    writeFileSync(join(characterDir, '表情包', '开心-微笑.png'), '', 'utf8');

    const oldAppData = process.env.APP_DATA_DIR;
    process.env.APP_DATA_DIR = root;
    for (const id of [
      '../../chat5-compat/services/promptBuilder.js',
      '../../chat5-compat/services/appPaths.js',
      '../../chat5-compat/services/memoryService.js',
      '../../chat5-compat/services/historyService.js',
      '../../chat5-compat/services/archiveService.js',
    ]) {
      try { delete require.cache[require.resolve(id)]; } catch {}
    }

    try {
      const promptBuilder = require('../../chat5-compat/services/promptBuilder.js');
      const memoryService = require('../../chat5-compat/services/memoryService.js');
      const prompt = promptBuilder.buildSystemPrompt('1', '今天有点累');
      const stablePrompt = promptBuilder.buildStableSystemPrompt('1');
      const requestMessages = promptBuilder.buildMessages('1', '今天有点累');
      expect(prompt).toContain('统一规则优先级');
      expect(prompt).toContain('普通回复默认不写括号动作');
      expect(prompt).toContain('不得虚构光线');
      expect(prompt).toContain('不必每轮都提问');
      expect(prompt).toContain('长期记忆只在用户本轮提及或与当前内容直接相关时引用');
      expect(prompt).toContain('保持自然的话题宽度：可根据角色资料谈日常安排、工作或任务、世界观');
      expect(prompt).toContain('角色情绪、亲密和害羞反应由角色人设、关系阶段与当前语境共同决定');
      expect(prompt).toContain('默认不引用用户原话');
      expect(prompt).toContain('不要使用固定的“你之前说过”句式');
      expect(prompt).toContain('先理解后转述');
      expect(prompt).not.toContain('必须由用户明确引导才允许害羞');
      expect(prompt).toContain('用户明确设定');
      expect(prompt).not.toContain('菲比丘比');
      expect(prompt).toContain('开心: 微笑');
      expect(prompt).not.toContain('喜欢直接但温和的回应');
      expect(prompt).not.toContain('关系连续性');
      expect(prompt).not.toContain('双方已经建立信任');
      expect(prompt).not.toContain('用户重要事件');
      expect(prompt).not.toContain('下周参加考试');
      expect(prompt).toContain('后续补充设定：用户要求被称为队长');
      expect(prompt).toContain('后续补充规则：先回答当前问题');
      expect(prompt.indexOf('后续补充设定：用户要求被称为队长')).toBeLessThan(prompt.indexOf('角色专属蒸馏资料'));
      expect(prompt.indexOf('后续补充规则：先回答当前问题')).toBeLessThan(prompt.indexOf('角色专属蒸馏资料'));
      expect(prompt).not.toContain('【近期会话】');
      expect(prompt).toContain('本轮最终决策顺序');
      expect(prompt.lastIndexOf('本轮最终决策顺序')).toBeGreaterThan(prompt.indexOf('角色专属蒸馏资料'));
      expect(prompt.lastIndexOf('本轮最终决策顺序')).toBeGreaterThan(prompt.indexOf('表情包系统'));
      expect(prompt).not.toContain('用音乐说话');
      expect(prompt.length).toBeLessThan(12000);
      expect(stablePrompt).not.toContain('下周参加考试');
      expect(stablePrompt).not.toContain('用户明确说过正在准备考试');
      expect(requestMessages[0].content).toBe(stablePrompt);
      const durableMessage = requestMessages.find((message: any) =>
        message.role === 'system' && String(message.content).includes('【低频长期连续性'));
      expect(durableMessage?.content || '').not.toContain('下周参加考试');
      expect(durableMessage?.content || '').not.toContain('用户明确说过正在准备考试');
      expect(requestMessages.at(-1).content).toContain('【本轮后台上下文】');
      expect(requestMessages.at(-1).content).not.toContain('下周参加考试');
      expect(requestMessages.at(-1).content).not.toContain('用户明确说过正在准备考试');
      expect(requestMessages.at(-1).content).toContain('【用户当前消息】\n今天有点累');

      const unrelatedRequest = promptBuilder.buildMessages('1', '今天想聊聊艺术协会的日常');
      const unrelatedDurable = unrelatedRequest.find((message: any) =>
        message.role === 'system' && String(message.content).includes('【低频长期连续性'));
      expect(unrelatedDurable?.content || '').not.toContain('下周参加考试');
      expect(unrelatedDurable?.content || '').not.toContain('用户明确说过正在准备考试');

      const relevantRequest = promptBuilder.buildMessages('1', '我下周要参加考试，有点紧张');
      const relevantDurable = relevantRequest.find((message: any) =>
        message.role === 'system' && String(message.content).includes('【低频长期连续性'));
      expect(relevantDurable?.content).toContain('下周参加考试');

      const requestWithWorldContext = promptBuilder.buildMessages('1', '最近官方有什么新活动？', null, {
        externalContext: '【按需联网资料】\n- 官方公告\n  来源：https://example.com/latest',
      });
      expect(String(requestWithWorldContext.at(-1).content)).toContain('【按需联网资料】');
      expect(String(requestWithWorldContext.at(-1).content)).toContain('【用户当前消息】\n最近官方有什么新活动？');

      const durableBeforeEmotionChange = promptBuilder.buildDurableContext('1');
      const changedMemory = memoryService.readMemory('1');
      changedMemory.emotional_state = {
        recent_mood: '焦虑',
        recent_mood_intensity: 3,
        recent_mood_trigger: '等待结果',
        mood_trajectory: [{ mood: '焦虑', intensity: 3, trigger: '等待结果' }],
      };
      memoryService.writeMemory('1', changedMemory);
      expect(promptBuilder.buildDurableContext('1')).toBe(durableBeforeEmotionChange);
      expect(promptBuilder.buildVolatileTurnContext('1', '还没出结果')).toContain('用户近期情绪线索');
    } finally {
      if (oldAppData === undefined) delete process.env.APP_DATA_DIR;
      else process.env.APP_DATA_DIR = oldAppData;
    }
  });

  it('wires the proactive service through the contamination-free policy', () => {
    const server = readFileSync(join(process.cwd(), 'chat5-compat', 'server.js'), 'utf8');
    expect(server).toContain("require('./services/proactiveContextPolicy')");
    expect(server).toContain('buildProactiveUserContext');
    expect(server).toContain('const systemPrompt = promptBuilder.buildStableSystemPrompt(characterId);');
    expect(server).not.toContain('...recentHistory.map(m => ({ role: m.role, content: m.content }))');
  });

  it('keeps duplicate-retry guidance in the volatile final user message', () => {
    const server = readFileSync(join(process.cwd(), 'chat5-compat', 'server.js'), 'utf8');
    expect(server).toContain("index !== messages.length - 1 || message.role !== 'user'");
    expect(server).toContain("item && item.type === 'text'");
    expect(server).not.toContain('messages.map((m, i) => i === 0');
  });

  it('keeps latest-world lookup explicit and request-scoped', () => {
    const server = readFileSync(join(process.cwd(), 'chat5-compat', 'server.js'), 'utf8');
    const promptBuilder = readFileSync(join(process.cwd(), 'chat5-compat', 'services', 'promptBuilder.js'), 'utf8');
    expect(server).toContain("require('./services/worldKnowledgeSearch')");
    expect(server).toContain('fetchLatestWorldContext');
    expect(server).toContain('worldContext');
    expect(promptBuilder).toContain('externalContext = \'\'');
    expect(promptBuilder).toContain('externalContext');
  });

  it('preserves visual character settings when a role is created', () => {
    const server = readFileSync(join(process.cwd(), 'chat5-compat', 'server.js'), 'utf8');
    expect(server).toContain('user_title, user_cognition, style');
    expect(server).toContain("user_cognition: user_cognition || ''");
  });

  it('uses the same restrained inactivity schedule in the browser and server', () => {
    const server = readFileSync(join(process.cwd(), 'chat5-compat', 'server.js'), 'utf8');
    const browser = readFileSync(join(process.cwd(), 'chat5-compat', 'public', 'app.js'), 'utf8');

    expect(server).toContain('const PROACTIVE_WAIT_MINUTES = [30, 330, 360, 720, 720, 720]');
    expect(browser).toContain("{ waitMin: 30, type: 'idle' }");
    expect(browser).toContain("{ waitMin: 330, type: 'idle' }");
    expect(browser).toContain("{ waitMin: 720, type: 'long-absence' }");
  });

  it('counts a first-entry late-night greeting as that day\'s sleep-care message', () => {
    const server = readFileSync(join(process.cwd(), 'chat5-compat', 'server.js'), 'utf8');
    expect(server).toContain("type === 'late_night' && greetingReservationId");
    expect(server).toContain('state.midnight_care_sent_date = getTodayStr()');
  });

  it('applies the same sparse quote gate to proactive candidates', () => {
    const server = readFileSync(join(process.cwd(), 'chat5-compat', 'server.js'), 'utf8');
    expect(server).toContain('replyPolicy.isQuoteUsageAcceptable(cleanReply, recentUserDetail, recentAssistForPolicy)');
  });
});
