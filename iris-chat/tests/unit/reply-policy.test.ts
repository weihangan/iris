import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const replyPolicy = require('../../chat5-compat/services/replyPolicy.js') as {
  sanitize(reply: string, recentAssistants?: unknown[], options?: unknown): string;
  stripModelControlTokens(text: string): string;
  pickNonRepeatingFallback(userInput: string, recentAssistants: Array<{ content: string }>): string;
  isSimilarToRecent(reply: string, recentAssistants: Array<{ content: string }>, threshold?: number): boolean;
  isQuoteUsageAcceptable(reply: string, userInput: string, recentAssistants?: Array<{ content: string }>): boolean;
  maybeAddSticker(
    reply: string,
    recentAssistants: Array<{ content: string }>,
    characterId: string,
    appRoot: string,
    minInterval?: number,
  ): string;
  selectStickerForReply(
    reply: string,
    stickers: Array<{ name: string; category: string; detail: string }>,
  ): string | null;
  pickProactiveFallback(options: {
    now: Date;
    elapsedMinutes: number;
    recentUserDetail?: string;
    recentAssistants: Array<{ content: string }>;
  }): string;
};
const stickerService = require('../../chat5-compat/services/stickerService.js') as {
  listStickers(characterId: string): Array<{ name: string; category: string; detail: string }>;
};

describe('reply policy model control token boundary', () => {
  it('removes chat-template role and end tokens before history persistence', () => {
    const source = '指挥……这么晚了还在忙吗？<|assistant|>（微笑）<|im_end|>';
    const sanitized = replyPolicy.sanitize(source, [], {});

    expect(sanitized).toBe('指挥……这么晚了还在忙吗？ （微笑）');
    expect(sanitized).not.toMatch(/<\|[^>]+\|>/);
  });

  it('removes every supported role token without deleting normal angle brackets', () => {
    expect(replyPolicy.stripModelControlTokens(
      '<|system|><|user|><|assistant|><|end|><|im_start|><|im_end|> 保留 <普通文本>'
    )).toBe('保留 <普通文本>');
  });

  it('builds ten non-identical proactive fallbacks without fictional scenery', () => {
    const recentAssistants: Array<{ content: string }> = [];
    const generated = new Set<string>();
    for (let index = 0; index < 10; index += 1) {
      const text = replyPolicy.pickProactiveFallback({
        now: new Date('2026-07-27T02:27:00+08:00'),
        elapsedMinutes: 48 * 60,
        recentUserDetail: '明天十点的产品经理面试',
        recentAssistants,
      });
      generated.add(text);
      recentAssistants.push({ content: text });
    }

    expect(generated.size).toBe(10);
    for (const text of generated) {
      expect(text).toContain('产品经理面试');
      expect(text).not.toMatch(/光束|光线渐暗|琴房|花茶|晚风/);
      expect(text).not.toMatch(/为什么不理我|是不是出事|我很委屈/);
    }
  });

  it('changes proactive fallback concern with silence duration and late-night rest context', () => {
    const base = { now: new Date('2026-08-14T16:00:00+08:00'), recentAssistants: [] };
    expect(replyPolicy.pickProactiveFallback({ ...base, elapsedMinutes: 30, recentUserDetail: '' }))
      .toMatch(/轻轻问候|不着急|想知道/);
    expect(replyPolicy.pickProactiveFallback({ ...base, elapsedMinutes: 6 * 60, recentUserDetail: '' }))
      .toMatch(/好几个小时|想知道|挂念/);
    expect(replyPolicy.pickProactiveFallback({ ...base, elapsedMinutes: 24 * 60, recentUserDetail: '' }))
      .toMatch(/担心/);
    expect(replyPolicy.pickProactiveFallback({
      ...base,
      now: new Date('2026-08-14T00:30:00+08:00'),
      elapsedMinutes: 30,
      recentUserDetail: '',
    })).toMatch(/休息|晚安|身体/);
  });

  it('never reuses the fixed fallback phrase when every canned option is already recent', () => {
    const recentAssistants = [
      { content: '我在听。换个角度说，你最希望我回应的是哪一点？' },
      { content: '先不沿用刚才的说法。你愿意把最在意的那部分再告诉我一点吗？' },
      { content: '我不想用重复的话敷衍你。此刻你更想被理解，还是想听一个具体建议？' },
    ];

    const fallback = replyPolicy.pickNonRepeatingFallback('好的', recentAssistants);

    expect(fallback).not.toBe(recentAssistants[2].content);
    expect(replyPolicy.isSimilarToRecent(fallback, recentAssistants, 0.5)).toBe(false);
  });

  it('does not echo the user message when all fallback candidates are exhausted', () => {
    const userInput = '露西亚还在地方其他坏女人 我们出去约个会吧';
    const recentAssistants = [
      { content: '我先不替你下结论。你想继续说时，我会从刚才那句接着听。' },
      { content: '这个问题可以拆开看。你想先厘清事实，还是先说说你的判断？' },
      { content: '我先把回应放在这里。你愿意继续时，直接告诉我最想让我接住的一点就好。' },
      { content: '这次我换个落点：你刚才的话里，哪一部分最需要我先回应？' },
      { content: '我不急着替你归纳。你想从哪个细节继续，我就跟着那个细节说。' },
      { content: '先给你留出一点空间。等你开口时，我会认真接住新的内容。' },
      { content: `关于“${userInput}”，这次我只想知道有没有新的进展；没有也没关系，等你方便再说。` },
      { content: `我把“${userInput}”留在这里，等你愿意时再从任何一处接着说。` },
      { content: `收到“${userInput}”。这次我会按新的内容回应，不再套用刚才的句式。` },
    ];

    const fallback = replyPolicy.pickNonRepeatingFallback(userInput, recentAssistants);

    expect(fallback).not.toContain(userInput);
    expect(fallback).not.toMatch(/[“”]/);
    expect(replyPolicy.isSimilarToRecent(fallback, recentAssistants, 0.5)).toBe(false);
  });

  it('treats different wording with the same intimate intent as a repeated reply', () => {
    const recentAssistants = [{ content: '有点想看你脸红时会是什么反应。' }];
    expect(replyPolicy.isSimilarToRecent('真想看看你害羞时的样子。', recentAssistants, 0.5)).toBe(true);
  });

  it('treats replies with different quotes but identical surrounding text as repeated', () => {
    const recentAssistants = [{ content: '“我今天很累”，先照顾好自己，慢慢来。' }];
    expect(replyPolicy.isSimilarToRecent('“最近工作好多”，先照顾好自己，慢慢来。', recentAssistants, 0.5)).toBe(true);
  });

  it('rejects a long or near-verbatim quote while allowing a short factual fragment', () => {
    const userInput = '我今天在公司连续开了三个小时的会，回家以后还要继续处理项目，真的有点累。';
    expect(replyPolicy.isQuoteUsageAcceptable(
      '“我今天在公司连续开了三个小时的会，回家以后还要继续处理项目”听起来确实很累。',
      userInput,
      [],
    )).toBe(false);
    expect(replyPolicy.isQuoteUsageAcceptable('你提到“连续开会”，先歇一会儿。', userInput, [])).toBe(true);
    expect(replyPolicy.isQuoteUsageAcceptable('又提到“连续开会”，先歇一会儿。', userInput, [
      { content: '你说过“连续开会”，先歇一会儿。' },
    ])).toBe(false);
  });

  it('rejects a long verbatim user fragment even when the model omits quotation marks', () => {
    const userInput = '我今天在公司连续开了三个小时的会，回家以后还要继续处理项目，真的有点累。';
    expect(replyPolicy.isQuoteUsageAcceptable(
      '连续开了三个小时的会，回家以后还要继续处理项目，先去休息一下吧。',
      userInput,
      [],
    )).toBe(false);
  });

  it('does not rewrite a visible quote during normal sanitization', () => {
    const reply = '你提到“连续开会”，先歇一会儿。';
    expect(replyPolicy.sanitize(reply, [], {})).toBe(reply);
  });

  it('adds an emotion-matched Selena sticker after eight sticker-free replies', () => {
    const recentAssistants = Array.from({ length: 8 }, (_, index) => ({ content: `普通回复 ${index + 1}` }));
    const result = replyPolicy.maybeAddSticker(
      '太好了，听起来这件事已经顺利解决了。',
      recentAssistants,
      '1',
      join(process.cwd(), 'chat5-compat'),
    );

    expect(result).toMatch(/\n\[表情包:(?:开心|高兴)-[^\]]+\]$/);
  });

  it('keeps sticker cooldown hard and never adds one before eight replies', () => {
    const appRoot = join(process.cwd(), 'chat5-compat');
    const sevenReplies = Array.from({ length: 7 }, (_, index) => ({ content: `普通回复 ${index + 1}` }));
    expect(replyPolicy.maybeAddSticker('今天见到你很开心。', sevenReplies, '1', appRoot))
      .not.toContain('[表情包:');

    const recentWithSticker = [
      { content: '上次回复\n[表情包:开心-小骄傲]' },
      ...Array.from({ length: 7 }, (_, index) => ({ content: `之后回复 ${index + 1}` })),
    ];
    expect(replyPolicy.maybeAddSticker('今天见到你很开心。', recentWithSticker, '1', appRoot))
      .not.toContain('[表情包:');
  });

  it('does not use a generic fallback or borrow stickers from another character ID', () => {
    const appRoot = join(process.cwd(), 'chat5-compat');
    const recentAssistants = Array.from({ length: 8 }, (_, index) => ({ content: `普通回复 ${index + 1}` }));

    expect(replyPolicy.maybeAddSticker('知道了，我们之后再继续讨论。', recentAssistants, '1', appRoot))
      .not.toContain('[表情包:');
    expect(replyPolicy.maybeAddSticker('太好了，事情已经顺利解决。', recentAssistants, '2', appRoot))
      .not.toContain('[表情包:');
  });

  it('discovers a future sticker category from its semantic filename without a code whitelist', () => {
    const selected = replyPolicy.selectStickerForReply('太好了，这确实值得庆祝。', [
      { name: '庆祝-撒花', category: '庆祝', detail: '撒花' },
      { name: '难过-流泪', category: '难过', detail: '流泪' },
    ]);

    expect(selected).toBe('庆祝-撒花');
    expect(replyPolicy.selectStickerForReply('这是一句普通说明。', [
      { name: '庆祝-撒花', category: '庆祝', detail: '撒花' },
    ])).toBeNull();
  });

  it('uses Selena current catalog across distinct conversation moods', () => {
    const stickers = stickerService.listStickers('1');
    const available = new Set(stickers.map(sticker => sticker.name));
    const samples = [
      '晚安，今晚早点休息，祝你好梦。',
      '你这样说让我有点害羞，脸都红了。',
      '我当然喜欢你，也会一直陪着你。',
      '太好了，这件事顺利解决，值得庆祝。',
      '听起来你很累，也有些难过。',
      '再试一次吧，我相信你做得到，加油。',
      '没想到事情居然会这样，确实很惊讶。',
      '这件事确实很过分，难怪你会生气。',
      '真拿你没办法，我都有些无奈了。',
      '你饿了吗？先吃饭或者喝杯奶茶吧。',
      '这张自拍很好看，今天的打扮也很漂亮。',
      '我只是逗你一下，开个小玩笑。',
      '你最在意的是哪一点？',
      '没错，我也同意你的判断。',
    ];
    const selected = samples.map(text => replyPolicy.selectStickerForReply(text, stickers));

    expect(selected.every(name => name !== null && available.has(name))).toBe(true);
    expect(new Set(selected.map(name => name!.split('-')[0])).size).toBeGreaterThanOrEqual(10);
  });
});
