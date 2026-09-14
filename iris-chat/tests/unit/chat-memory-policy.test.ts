import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('chatMemoryPolicy', () => {
  const policy = () => require('../../chat5-compat/services/chatMemoryPolicy.js');

  it('partitions old history while preserving recent Q&A verbatim', () => {
    const { partitionHistoryForCompression } = policy();
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `原文 ${index}，保留标点！`,
      time: `2026-08-04 10:00:${String(index).padStart(2, '0')}`,
    }));
    const result = partitionHistoryForCompression(history, 6);

    expect(result.toCompress).toEqual(history.slice(0, 14));
    expect(result.keepRecent).toEqual(history.slice(14));
  });

  it('prevents a lower-confidence inferred mood from replacing a recent explicit mood', () => {
    const { mergeEmotionObservation } = policy();
    const explicit = {
      mood: '焦虑', intensity: 4, source: 'explicit_user', confidence: 1,
      timestamp: '2026-08-04 10:00:00', trigger: '用户明确说面试焦虑',
    };
    const inferred = {
      mood: '平静', intensity: 1, source: 'assistant_inference', confidence: 0.55,
      timestamp: '2026-08-04 10:00:10', trigger: '模型推断',
    };
    const result = mergeEmotionObservation(explicit, inferred);

    expect(result.acceptedAsCurrent).toBe(false);
    expect(result.current).toEqual(explicit);
  });

  it('promotes explicit commitments, key events, relationships, and unresolved concerns', () => {
    const { findDurableMemoryCandidates } = policy();
    const candidates = findDurableMemoryCandidates([
      { role: 'user', content: '我答应你，明天面试结束后告诉你结果。' },
      { role: 'user', content: '小林是我妹妹，这件事对我很重要。' },
      { role: 'user', content: '最近失眠的问题还没有解决。' },
      { role: 'assistant', content: '我会永远在窗边弹琴。' },
    ]);

    expect(candidates.map((item: { type: string }) => item.type)).toEqual(
      expect.arrayContaining(['commitment', 'relationship', 'unresolved_concern']),
    );
    expect(candidates.every((item: { sourceRole: string }) => item.sourceRole === 'user')).toBe(true);
  });

  it('filters archive RAG results to relevant user-authored context', () => {
    const { selectRelevantUserArchiveResults } = policy();
    const results = selectRelevantUserArchiveResults([
      { role: 'assistant', snippet: '旧助手套话', score: 9 },
      { role: 'user', snippet: '用户说过喜欢安静', score: 5, finalScore: 5 },
      { role: 'user', snippet: ' 用户说过喜欢安静 ', score: 4, finalScore: 4 },
      { role: 'user', snippet: '用户说过面试', score: 4 },
      { role: 'user', snippet: '最近原文，不应重复注入', finalScore: 8 },
    ], 2, { excludeTexts: ['最近原文，不应重复注入'] });

    expect(results.map((item: { snippet: string }) => item.snippet)).toEqual(['用户说过喜欢安静', '用户说过面试']);
  });

  it('keeps a wider dialogue window without letting proactive messages crowd out user context', () => {
    const { selectRecentConversationContext } = policy();
    const history = [
      { role: 'user', content: '很早但仍在当前未压缩窗口内的用户信息' },
      { role: 'assistant', content: '正常回复' },
      ...Array.from({ length: 40 }, (_, index) => ({
        role: 'assistant', content: `主动消息${index}`, proactive: true,
      })),
      { role: 'user', content: '最新用户问题' },
    ];
    const selected = selectRecentConversationContext(history, {
      maxMessages: 48,
      maxChars: 24000,
      maxProactiveAssistants: 2,
    });

    expect(selected.filter((item: { proactive?: boolean }) => item.proactive)).toHaveLength(2);
    expect(selected.some((item: { content: string }) => item.content.includes('很早但仍在'))).toBe(true);
    expect(selected.at(-1)?.content).toBe('最新用户问题');
  });

  it('batches history compression instead of rewriting the summary every turn', () => {
    const historyService = require('../../chat5-compat/services/historyService.js');
    expect(historyService.COMPRESSION_TRIGGER_CHARS).toBe(50000);
    expect(historyService.COMPRESSION_KEEP_RECENT_CHARS).toBe(6000);
    expect(historyService.getCompressionPolicy()).toMatchObject({
      triggerChars: 50000,
      keepRecentChars: 6000,
      minRecentMessages: 24,
    });
    expect(historyService.normalizeCompressedSummary('x'.repeat(4000)).length).toBeLessThanOrEqual(2400);
  });

  it('partitions by character budget while keeping complete recent turns', () => {
    const { partitionHistoryForCompressionByBudget, estimateHistoryPromptChars } = policy();
    const history = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${index}-` + '内容'.repeat(100),
    }));
    const result = partitionHistoryForCompressionByBudget(history, {
      keepRecentChars: 3000,
      minRecentMessages: 8,
    });

    expect(result.toCompress.length).toBeGreaterThan(0);
    expect(estimateHistoryPromptChars(result.keepRecent)).toBeGreaterThanOrEqual(3000);
    expect(result.keepRecent[0].role).toBe('user');
    expect([...result.toCompress, ...result.keepRecent]).toEqual(history);
  });
});
