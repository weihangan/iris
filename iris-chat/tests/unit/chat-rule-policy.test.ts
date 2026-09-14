import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

describe('chatRulePolicy', () => {
  it('publishes one unambiguous priority order', () => {
    const { buildChatRulePrompt, buildFinalDecisionPrompt, FINAL_DECISION_PRIORITY } = require('../../chat5-compat/services/chatRulePolicy.js');
    const prompt = buildChatRulePrompt({ characterName: '赛琳娜', userTitle: '指挥' });
    const finalPrompt = buildFinalDecisionPrompt();

    const explicit = prompt.indexOf('用户在设置中保存');
    const current = prompt.indexOf('当前用户消息');
    const persona = prompt.indexOf('基础角色资料');
    const memory = prompt.indexOf('相关记忆');
    const defaults = prompt.indexOf('通用默认规则');
    expect(explicit).toBeGreaterThanOrEqual(0);
    expect(current).toBeLessThan(explicit);
    expect(explicit).toBeLessThan(persona);
    expect(persona).toBeLessThan(memory);
    expect(memory).toBeLessThan(defaults);
    expect(FINAL_DECISION_PRIORITY).toHaveLength(7);
    expect(finalPrompt).toContain('安全边界');
    expect(finalPrompt.indexOf('当前用户消息')).toBeLessThan(finalPrompt.indexOf('用户在设置中保存'));
    expect(finalPrompt.indexOf('用户在设置中保存')).toBeLessThan(finalPrompt.indexOf('角色身份'));
    expect(finalPrompt.indexOf('角色身份')).toBeLessThan(finalPrompt.indexOf('最近原始对话'));
    expect(finalPrompt.indexOf('最近原始对话')).toBeLessThan(finalPrompt.indexOf('关系状态'));
    expect(finalPrompt.indexOf('关系状态')).toBeLessThan(finalPrompt.indexOf('自动蒸馏资料'));
  });

  it('keeps universal rules character-neutral and action-light', () => {
    const { buildChatRulePrompt } = require('../../chat5-compat/services/chatRulePolicy.js');
    const prompt = buildChatRulePrompt({ characterName: '秧秧', userTitle: '漂泊者' });

    expect(prompt).toContain('普通回复默认不写括号动作');
    expect(prompt).toContain('先直接回应用户当前内容');
    expect(prompt).not.toContain('菲比丘比');
    expect(prompt).not.toContain('啾');
    expect(prompt).not.toContain('必须先共情');
    expect(prompt).not.toContain('必须用音乐');
  });

  it('does not turn a character trait into a mandatory reply formula', () => {
    const { DEFAULT_CHAT_RULES } = require('../../chat5-compat/services/chatRulePolicy.js');
    const joined = DEFAULT_CHAT_RULES.join('\n');

    expect(joined).toContain('角色意象只在话题自然相关时低频使用');
    expect(joined).toContain('用户明确表达强烈情绪时再简短共情');
  });

  it('grounds vivid replies in time and recent facts instead of stock scenery', () => {
    const { DEFAULT_CHAT_RULES } = require('../../chat5-compat/services/chatRulePolicy.js');
    const joined = DEFAULT_CHAT_RULES.join('\n');

    expect(joined).toContain('当前本地时间');
    expect(joined).toContain('不得虚构光线');
    expect(joined).toContain('最近一个尚未解决的具体细节');
    expect(joined).toContain('开场、意象、邀约或收尾');
    expect(joined).toContain('有依据的细节');
  });

  it('keeps questions purposeful and lets relationship state continue naturally', () => {
    const { DEFAULT_CHAT_RULES } = require('../../chat5-compat/services/chatRulePolicy.js');
    const joined = DEFAULT_CHAT_RULES.join('\n');

    expect(joined).toContain('不必每轮都提问');
    expect(joined).toContain('一次最多问一个重点');
    expect(joined).toContain('不把关系重置');
    expect(joined).toContain('最新的用户明确表述');
  });

  it('defines one canonical output contract and a hard duplicate-repair path', () => {
    const { DEFAULT_CHAT_RULES } = require('../../chat5-compat/services/chatRulePolicy.js');
    const joined = DEFAULT_CHAT_RULES.join('\n');

    expect(joined).toContain('默认1至4句');
    expect(joined).toContain('不把时间戳、控制标记、情感元数据或思考过程写入可见正文');
    expect(joined).toContain('普通对话比较最近8条');
    expect(joined).toContain('主动消息比较最近12条');
    expect(joined).toContain('不得把已判定重复的候选作为兜底');
  });

  it('keeps user-quote usage short, sparse, and paraphrased by default', () => {
    const { DEFAULT_CHAT_RULES } = require('../../chat5-compat/services/chatRulePolicy.js');
    const joined = DEFAULT_CHAT_RULES.join('\n');

    expect(joined).toContain('默认不引用用户原话');
    expect(joined).toContain('不要使用固定的“你之前说过”句式');
    expect(joined).toContain('先理解后转述');
    expect(joined).toContain('不连续多轮引用');
  });

  it('keeps proactive care separate from ordinary user-requested replies', () => {
    const { DEFAULT_CHAT_RULES } = require('../../chat5-compat/services/chatRulePolicy.js');
    const joined = DEFAULT_CHAT_RULES.join('\n');

    expect(joined).toContain('主动关心只在主动消息策略触发时使用');
    expect(joined).toContain('短暂沉默不升级为担心');
    expect(joined).toContain('深夜不补写自然光线或室内场景');
  });

  it('delegates silence-time emotion changes to the shared proactive gradient', () => {
    const { DEFAULT_CHAT_RULES } = require('../../chat5-compat/services/chatRulePolicy.js');
    const joined = DEFAULT_CHAT_RULES.join('\n');

    expect(joined).toContain('0.5小时、6小时、12小时、24小时、36小时和48小时');
    expect(joined).toContain('角色 Skill');
  });

  it('keeps universal reply guidance in the shared rule source', () => {
    const template = readFileSync(join(process.cwd(), 'chat5-compat', 'prompts', 'system_prompt.txt'), 'utf8');
    expect(template).not.toContain('普通对话比较最近8条助手回复');
    expect(template).not.toContain('不必每轮以问题结尾');
    expect(template).not.toContain('长期记忆只在用户本轮提及');
    expect(template).toContain('通用回复规则由服务端统一注入');
  });

  it('uses one canonical priority vocabulary for stable and final prompts', () => {
    const { buildChatRulePrompt, buildFinalDecisionPrompt } = require('../../chat5-compat/services/chatRulePolicy.js');
    const stable = buildChatRulePrompt({ characterName: '赛琳娜', userTitle: '指挥' });
    const final = buildFinalDecisionPrompt();
    for (const phrase of ['安全边界', '当前用户消息', '用户在设置中保存', '角色身份', '最近原始对话', '相关记忆']) {
      expect(stable).toContain(phrase);
      expect(final).toContain(phrase);
    }
  });
});
