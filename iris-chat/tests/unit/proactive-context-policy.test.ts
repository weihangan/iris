import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('proactiveContextPolicy', () => {
  const policy = () => require('../../chat5-compat/services/proactiveContextPolicy.js');

  it('allows the first greeting only once per local day', () => {
    const { getGreetingDecision } = policy();
    const now = new Date('2026-08-04T09:30:00+08:00');
    expect(getGreetingDecision({}, now)).toMatchObject({ shouldGreet: true, type: 'morning' });
    expect(getGreetingDecision({ daily_greeting_sent_date: '2026-08-04' }, now))
      .toMatchObject({ shouldGreet: false, reason: 'already_sent_today' });
  });

  it('never adds sleep care before 22:00 and permits gentle care after 22:00', () => {
    const { buildProactiveInstruction } = policy();
    const evening = buildProactiveInstruction({ type: 'evening', now: new Date('2026-08-04T20:30:00+08:00') });
    const late = buildProactiveInstruction({ type: 'late_night', now: new Date('2026-08-04T23:10:00+08:00') });

    expect(evening).not.toMatch(/睡|熬夜|休息/);
    expect(late).toMatch(/休息|熬夜/);
  });

  it('uses restrained inactivity tiers based on elapsed time', () => {
    const { getInactivityTier } = policy();
    expect(getInactivityTier(4).id).toBe('none');
    expect(getInactivityTier(15).id).toBe('light_followup');
    expect(getInactivityTier(180).id).toBe('gentle_checkin');
    expect(getInactivityTier(12 * 60).id).toBe('warm_concern');
    expect(getInactivityTier(48 * 60).id).toBe('long_absence');
  });

  it('exposes additional silence tiers around 30m, 6h, 24h and 36h', () => {
    const { getInactivityTier } = policy();
    expect(getInactivityTier(30).id).toBe('quiet_checkin');
    expect(getInactivityTier(6 * 60).id).toBe('curious_checkin');
    expect(getInactivityTier(24 * 60).id).toBe('concerned');
    expect(getInactivityTier(36 * 60).id).toBe('anxious_concern');
  });

  it('treats a short late-night silence as likely rest rather than immediate worry', () => {
    const { buildProactiveInstruction } = policy();
    const instruction = buildProactiveInstruction({
      type: 'idle',
      elapsedMinutes: 30,
      now: new Date('2026-08-14T00:30:00+08:00'),
    });
    expect(instruction).toMatch(/可能已经休息|晚安|身体/);
    expect(instruction).not.toMatch(/焦急|明确说“有些担心”/);
  });

  it('builds proactive context from recent user messages only', () => {
    const { buildProactiveUserContext } = policy();
    const history = [
      { role: 'user', content: '我明天要面试', time: '2026-08-03 10:00:00' },
      { role: 'assistant', content: '旧的音乐和窗边动作模板', time: '2026-08-03 10:00:02' },
      { role: 'user', content: '现在有点紧张', time: '2026-08-04 09:00:00' },
    ];
    const context = buildProactiveUserContext(history, 4);

    expect(context).toContain('我明天要面试');
    expect(context).toContain('现在有点紧张');
    expect(context).not.toContain('旧的音乐和窗边动作模板');
  });

  it('adds a festival naturally once and enforces topic/action cooldown', () => {
    const { getFestivalForDate, buildProactiveInstruction, passesCooldown } = policy();
    const now = new Date('2026-10-01T09:00:00+08:00');
    const festival = getFestivalForDate(now);
    expect(festival).toBe('国庆节');
    expect(buildProactiveInstruction({ type: 'morning', now, festival })).toContain('国庆节');
    expect(passesCooldown(
      { topicCategory: 'daily_checkin', actionCategory: 'none' },
      [{ proactiveCategory: { topicCategory: 'daily_checkin', actionCategory: 'none' } }],
      3,
    )).toBe(false);
  });

  it('makes deep-night environmental limits explicit and rejects impossible natural light', () => {
    const { buildProactiveInstruction, validateTemporalConsistency } = policy();
    const now = new Date('2026-07-27T02:27:00+08:00');
    const instruction = buildProactiveInstruction({ type: 'idle', now, elapsedMinutes: 180 });

    expect(instruction).toMatch(/阳光|光束/);
    expect(instruction).toMatch(/不得|禁止/);
    expect(validateTemporalConsistency('尘埃在光束中静止了。', now, '')).toMatchObject({ valid: false });
    expect(validateTemporalConsistency('琴房里的光线渐渐暗了下来。', now, '')).toMatchObject({ valid: false });
    expect(validateTemporalConsistency('你之前提到灯光太亮，现在好些了吗？', now, '用户说：灯光太亮')).toMatchObject({ valid: true });
  });

  it('extracts recent user details without copying assistant imagery or inventing details from emoticons', () => {
    const { buildProactiveUserContext, getRecentUserDetail } = policy();
    const history = [
      { role: 'user', content: '我明天十点有产品经理面试', time: '2026-08-03 10:00:00' },
      { role: 'assistant', content: '来琴房喝花茶吧，窗外晚风正好', time: '2026-08-03 10:00:02' },
      { role: 'user', content: '还在准备案例题', time: '2026-08-04 09:00:00' },
    ];
    const context = buildProactiveUserContext(history, 4);

    expect(context).toContain('最后一条用户原话');
    expect(context).toContain('还在准备案例题');
    expect(context).toContain('产品经理面试');
    expect(context).not.toContain('琴房');
    expect(context).toContain('优先用角色自己的理解自然转述');
    expect(context).not.toContain('默认用「你之前说过……」');
    expect(getRecentUserDetail(history)).toContain('准备案例题');
    expect(getRecentUserDetail([{ role: 'user', content: '(≧▽≦)' }])).toBe('');
  });

  it('classifies repeated scenes, motifs and stock openings across a twelve-message cooldown', () => {
    const { classifyProactiveContent, passesCooldown, validateProactiveGrounding } = policy();
    const first = classifyProactiveContent('指挥，若你得闲，不妨来琴房坐坐？我为你弹奏一曲。');
    const second = classifyProactiveContent('若是有空，来听听我新谱的曲子吧。');
    const recent = Array.from({ length: 11 }, (_, index) => ({
      content: index === 0 ? '我们去琴房吧，我想弹奏一曲。' : `不重复的占位消息${index}`,
    }));

    expect(first.sceneCategory).toBe('music_room');
    expect(first.openingPattern).toBe('if_free_invitation');
    expect(first.motifCategories).toContain('music_invitation');
    expect(second.motifCategories).toContain('music_invitation');
    expect(passesCooldown(second, recent, 12)).toBe(false);
    expect(validateProactiveGrounding('我在琴房泡了花茶，窗外晚风正好。', '用户说明天要面试'))
      .toMatchObject({ valid: false });
    expect(validateProactiveGrounding('你说琴房有些冷，现在好一点了吗？', '最后一条用户原话：琴房有些冷'))
      .toMatchObject({ valid: true });
  });

  it('treats repeated personal interaction topics as one fresh topic', () => {
    const { classifyProactiveContent, passesCooldown } = policy();
    const candidate = classifyProactiveContent('关于你之前提到的“想看你害羞的样子”，这次有新的进展吗？');
    expect(candidate.topicKey).toBe('shy_appearance_request');
    expect(passesCooldown(candidate, [
      { content: '我还记得你想看我害羞的样子，后来怎样了？', time: '2026-08-20 00:03:00' },
    ], 48, { now: new Date('2026-08-24T00:03:00+08:00') })).toBe(false);
  });

  it('allows the same personal topic after the freshness window, but blocks unknown timestamps', () => {
    const { classifyProactiveContent, passesCooldown } = policy();
    const candidate = classifyProactiveContent('我想看看你害羞时的反应，若你愿意再告诉我。');
    expect(candidate.topicKey).toBe('shy_appearance_request');
    expect(passesCooldown(candidate, [
      { content: '想看你害羞的样子', time: '2026-07-01 00:00:00' },
    ], 48, { now: new Date('2026-08-24T00:00:00+08:00') })).toBe(true);
    expect(passesCooldown(candidate, [
      { content: '想看你害羞的样子' },
    ], 48, { now: new Date('2026-08-24T00:00:00+08:00') })).toBe(false);
  });

  it('lets an explicit newer user mention reopen a cooled topic', () => {
    const { classifyProactiveContent, passesCooldown } = policy();
    const candidate = classifyProactiveContent('我想看看你害羞时的反应，若你愿意再告诉我。');
    expect(passesCooldown(candidate, [
      { content: '想看你害羞的样子', time: '2026-08-20 00:00:00' },
    ], 48, {
      now: new Date('2026-08-21T00:00:00+08:00'),
      reopenedTopicKeys: ['shy_appearance_request'],
    })).toBe(true);
  });

  it('gives progressively concerned but non-coercive long-absence guidance', () => {
    const { buildProactiveInstruction } = policy();
    const short = buildProactiveInstruction({ type: 'idle', elapsedMinutes: 15, now: new Date('2026-08-14T16:00:00+08:00') });
    const long = buildProactiveInstruction({ type: 'long-absence', elapsedMinutes: 48 * 60, now: new Date('2026-08-14T16:00:00+08:00') });

    expect(short).toMatch(/只延续最后一个未完话题/);
    expect(short).not.toMatch(/担心/);
    expect(long).toMatch(/有些担心/);
    expect(long).toMatch(/最近用户明确提过的细节/);
    expect(long).toMatch(/不质问|不得质问/);
  });
});
