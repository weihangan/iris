import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('chat long-term memory accuracy', () => {
  it('does not promote assistant-only claims and upgrades a fact once the user confirms it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chatx2-memory-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'characters', '1'), { recursive: true });
    const oldAppData = process.env.APP_DATA_DIR;
    process.env.APP_DATA_DIR = root;
    for (const id of [
      '../../chat5-compat/services/memoryService.js',
      '../../chat5-compat/services/appPaths.js',
    ]) {
      try { delete require.cache[require.resolve(id)]; } catch {}
    }

    try {
      const memoryService = require('../../chat5-compat/services/memoryService.js');
      await memoryService.updateMemoryWithAI(
        '1',
        '我今天有点累',
        [{ role: 'user', content: '我今天有点累' }],
        async () => JSON.stringify({
          user_profile: { name: '小明' },
          permanent_facts: [{
            fact: '用户住在北京', category: 'personal_info', confidence: 1, source: '对话中明确提及',
          }],
          relationship_notes: [{ note: '双方已经结婚', evidence: '我们已经结婚', confidence: 1 }],
        }),
        '我记得你叫小明，也住在北京。',
      );

      let memory = memoryService.readMemory('1');
      expect(memory.user_profile.name).toBe('');
      expect(memory.relationship_notes).toEqual([]);
      expect(memory.permanent_facts[0]).toMatchObject({
        fact: '用户住在北京', confidence: 0.6, source: expect.stringContaining('缺少用户原话支持'),
      });

      await memoryService.updateMemoryWithAI(
        '1',
        '我叫小明，现在住在北京',
        [{ role: 'user', content: '我叫小明，现在住在北京' }],
        async () => JSON.stringify({
          user_profile: { name: '小明', location: '北京' },
          permanent_facts: [{
            fact: '用户住在北京', category: 'personal_info', confidence: 1, source: '对话中明确提及',
          }],
        }),
        '记住了。',
      );

      memory = memoryService.readMemory('1');
      expect(memory.user_profile).toMatchObject({ name: '小明', location: '北京' });
      expect(memory.permanent_facts).toHaveLength(1);
      expect(memory.permanent_facts[0]).toMatchObject({ confidence: 1, source: '对话中明确提及' });
    } finally {
      if (oldAppData === undefined) delete process.env.APP_DATA_DIR;
      else process.env.APP_DATA_DIR = oldAppData;
    }
  });

  it('keeps major facts but expires unmentioned one-off facts at a compression node', () => {
    const root = mkdtempSync(join(tmpdir(), 'chatx2-memory-prune-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'characters', '1'), { recursive: true });
    const oldAppData = process.env.APP_DATA_DIR;
    process.env.APP_DATA_DIR = root;
    for (const id of ['../../chat5-compat/services/memoryService.js', '../../chat5-compat/services/appPaths.js']) {
      try { delete require.cache[require.resolve(id)]; } catch {}
    }
    try {
      const memoryService = require('../../chat5-compat/services/memoryService.js');
      const memory = memoryService.readMemory('1');
      memory.important_events = [
        { event: '今天买了咖啡', date: '2026-08-01' },
        { event: '用户生日是8月8日', date: '2026-08-08' },
      ];
      memory.permanent_facts = [
        { fact: '用户喜欢蓝色', category: 'other', confidence: 1 },
        { fact: '用户曾在2026年参加一次聚会', category: 'other', confidence: 1 },
        { fact: '用户做过手术', category: 'health', confidence: 1 },
      ];
      memoryService.writeMemory('1', memory);
      memoryService.pruneTransientMemories('1', '本批只提到用户生日是8月8日');
      const after = memoryService.readMemory('1');
      expect(after.important_events.map((e: any) => e.event)).toEqual(['用户生日是8月8日']);
      expect(after.permanent_facts.map((f: any) => f.fact)).toEqual(['用户做过手术']);
    } finally {
      if (oldAppData === undefined) delete process.env.APP_DATA_DIR;
      else process.env.APP_DATA_DIR = oldAppData;
    }
  });

  it('allows a manually added fact to be starred and protects it from pruning', () => {
    const root = mkdtempSync(join(tmpdir(), 'chatx2-memory-star-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'characters', '1'), { recursive: true });
    const oldAppData = process.env.APP_DATA_DIR;
    process.env.APP_DATA_DIR = root;
    for (const id of ['../../chat5-compat/services/memoryService.js', '../../chat5-compat/services/appPaths.js']) {
      try { delete require.cache[require.resolve(id)]; } catch {}
    }
    try {
      const memoryService = require('../../chat5-compat/services/memoryService.js');
      expect(memoryService.addPermanentFact('1', '用户喜欢在周末喝茶')).toBe(true);
      expect(memoryService.setPermanentFactImportant('1', 0, true)).toBe(true);
      memoryService.pruneTransientMemories('1', '本批没有再次提到这件事');
      expect(memoryService.readMemory('1').permanent_facts[0]).toMatchObject({
        fact: '用户喜欢在周末喝茶', important: true,
      });
      const memory = memoryService.readMemory('1');
      memory.important_events = [{ event: '下周参加考试', important: true }];
      memoryService.writeMemory('1', memory);
      expect(memoryService.setImportantEventImportant('1', 0, false)).toBe(true);
      memoryService.pruneTransientMemories('1', '本批没有再次提到考试');
      expect(memoryService.readMemory('1').important_events).toEqual([]);
    } finally {
      if (oldAppData === undefined) delete process.env.APP_DATA_DIR;
      else process.env.APP_DATA_DIR = oldAppData;
    }
  });
});
