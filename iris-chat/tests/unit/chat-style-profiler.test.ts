import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('chat style profiler for custom distillation', () => {
  it('computes quantitative speech habits from raw material', () => {
    const { analyzeChatStyle } = require('../../chat5-compat/services/chatStyleProfiler.js');
    const text = [
      '我：今天好累啊……',
      '他：怎么了？',
      '我：没事，就是想你了呢。',
      '他：哈哈，我也是。',
      '我：真的吗？！',
    ].join('\n');
    const stats = analyzeChatStyle(text);
    expect(stats.totalChars).toBeGreaterThan(0);
    expect(stats.lineCount).toBe(5);
    expect(stats.avgSentenceLength).toBeGreaterThan(0);
    expect(Array.isArray(stats.frequentPhrases)).toBe(true);
    expect(Array.isArray(stats.punctuation)).toBe(true);
  });

  it('ranks frequent phrases by real occurrence count with ellipsis detection', () => {
    const { analyzeChatStyle } = require('../../chat5-compat/services/chatStyleProfiler.js');
    const text = [
      '我：这个嘛，今天就这样吧。',
      '我：这个嘛，再说吧。',
      '我：这个嘛，先睡了。',
      '我：好的。',
    ].join('\n');
    const stats = analyzeChatStyle(text);
    const phrase = stats.frequentPhrases.find((p: { phrase: string }) => p.phrase === '这个嘛');
    expect(phrase).toBeDefined();
    expect(phrase.count).toBe(3);
    const ellipsis = stats.punctuation.find((p: { mark: string }) => p.mark === '……');
    expect(ellipsis).toBeUndefined();
  });

  it('detects ellipsis, question and exclamation usage rates', () => {
    const { analyzeChatStyle } = require('../../chat5-compat/services/chatStyleProfiler.js');
    const text = '我：在吗……\n我：吃饭了吗？\n我：太好了！！';
    const stats = analyzeChatStyle(text);
    const marks = Object.fromEntries(stats.punctuation.map((p: { mark: string; count: number }) => [p.mark, p.count]));
    expect(marks['……']).toBe(1);
    expect(marks['？']).toBe(1);
    expect(marks['！']).toBe(2);
  });

  it('builds a compact stats block for prompt injection', () => {
    const { analyzeChatStyle, buildStyleStatsBlock } = require('../../chat5-compat/services/chatStyleProfiler.js');
    const stats = analyzeChatStyle('我：这个嘛，好累啊……\n我：这个嘛，想你了呢。\n我：这个嘛，先睡了。');
    const block = buildStyleStatsBlock(stats);
    expect(block).toContain('素材统计分析');
    expect(block).toContain('平均句长');
    expect(block).toContain('高频表达');
    expect(block).toContain('“这个嘛”×3');
  });

  it('returns empty phrase list for text without repetition', () => {
    const { analyzeChatStyle } = require('../../chat5-compat/services/chatStyleProfiler.js');
    const stats = analyzeChatStyle('我：完全不同的一句话。\n我：另一句毫无重叠。');
    expect(stats.frequentPhrases.length).toBe(0);
  });
});

describe('smart sampling for long custom material', () => {
  it('keeps head, middle and tail within budget at paragraph boundaries', () => {
    const { smartSampleMaterial } = require('../../chat5-compat/services/chatStyleProfiler.js');
    const paragraphs = Array.from({ length: 300 }, (_, i) => `第${i}段：${'内容'.repeat(30)}`);
    const text = paragraphs.join('\n\n');
    const sampled = smartSampleMaterial(text, 6000);
    expect(sampled.length).toBeLessThanOrEqual(6200);
    expect(sampled.length).toBeGreaterThan(3000);
    expect(sampled).toContain('第0段');
    expect(sampled).toContain('第299段');
    expect(sampled).toContain('[中段抽样]');
  });

  it('returns short material unchanged', () => {
    const { smartSampleMaterial } = require('../../chat5-compat/services/chatStyleProfiler.js');
    const text = '很短的素材。';
    expect(smartSampleMaterial(text, 6000)).toBe(text);
  });
});

describe('custom distillation prompt with style stats and speaker separation', () => {
  it('injects the quantitative stats block and speaker-separation rules', () => {
    const { buildUniversalCustomDistillPrompt } = require('../../chat5-compat/services/distillPrompt.js');
    const prompt = buildUniversalCustomDistillPrompt({
      name: '真实人物',
      relationship: '朋友',
      purpose: 'neutral',
      inputData: '聊天记录',
      styleStats: '【素材统计分析】\n- 平均句长：12字',
      existingSkill: '',
      today: '2026-08-30',
    });
    expect(prompt).toContain('素材统计分析');
    expect(prompt).toContain('平均句长：12字');
    expect(prompt).toContain('区分发言人');
    expect(prompt).toContain('自己的发言提炼说话习惯');
  });

  it('distills without stats block when styleStats is absent', () => {
    const { buildUniversalCustomDistillPrompt } = require('../../chat5-compat/services/distillPrompt.js');
    const prompt = buildUniversalCustomDistillPrompt({
      name: '真实人物',
      relationship: '朋友',
      purpose: 'neutral',
      inputData: '聊天记录',
      existingSkill: '',
      today: '2026-08-30',
    });
    expect(prompt).not.toContain('【素材统计分析】');
  });

  it('routes the custom distillation through stats profiling and smart sampling', () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const source = readFileSync(join(process.cwd(), 'chat5-compat', 'services', 'distillService.js'), 'utf8');
    expect(source).toContain('analyzeChatStyle');
    expect(source).toContain('smartSampleMaterial');
    expect(source).not.toContain("inputChunks.join('\\n\\n').substring(0, 12000)");
  });
});
