import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('chat archive RAG retrieval', () => {
  it('bridges common Chinese/English chat concepts, filters assistants, and deduplicates repeats', () => {
    const root = mkdtempSync(join(tmpdir(), 'chatx2-rag-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'characters', '1'), { recursive: true });
    const oldAppData = process.env.APP_DATA_DIR;
    process.env.APP_DATA_DIR = root;
    for (const id of [
      '../../chat5-compat/services/archiveService.js',
      '../../chat5-compat/services/appPaths.js',
    ]) {
      try { delete require.cache[require.resolve(id)]; } catch {}
    }

    try {
      const archive = require('../../chat5-compat/services/archiveService.js');
      archive.appendMessage('1', { role: 'assistant', content: '我喜欢你，我会一直想你。', time: '2026-08-01 10:00:00' });
      archive.appendMessage('1', { role: 'user', content: 'l love you', time: '2026-08-01 10:00:01' });
      archive.appendMessage('1', { role: 'user', content: 'l love you', time: '2026-08-01 10:00:01' });
      archive.appendMessage('1', { role: 'user', content: '我那天很累', time: '2026-08-01 10:00:02' });
      archive.appendMessage('1', { role: 'user', content: '我明天要参加面试', time: '2026-08-01 10:00:03' });

      const results = archive.searchUserContext('1', '你还记得我说喜欢你吗', 3);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ role: 'user', snippet: 'l love you' });
      expect(archive.searchUserContext('1', '今天有点累', 3)).toEqual([]);
      expect(archive.searchUserContext('1', '面试结果出来了', 3)[0].content).toBe('我明天要参加面试');
    } finally {
      if (oldAppData === undefined) delete process.env.APP_DATA_DIR;
      else process.env.APP_DATA_DIR = oldAppData;
    }
  });

  it('lazily indexes reference documents and returns only relevant knowledge chunks', () => {
    const root = mkdtempSync(join(tmpdir(), 'chatx2-knowledge-'));
    const referenceDir = join(root, 'characters', '1', 'references');
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(referenceDir, { recursive: true });
    writeFileSync(join(referenceDir, 'research.md'), '赛琳娜曾经是歌剧家，后来加入地表考古队。', 'utf8');
    const oldAppData = process.env.APP_DATA_DIR;
    process.env.APP_DATA_DIR = root;
    for (const id of [
      '../../chat5-compat/services/archiveService.js',
      '../../chat5-compat/services/appPaths.js',
    ]) {
      try { delete require.cache[require.resolve(id)]; } catch {}
    }

    try {
      const archive = require('../../chat5-compat/services/archiveService.js');
      const results = archive.searchKnowledge('1', '她过去做什么歌剧工作', 3);
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('歌剧家');
      expect(existsSync(join(root, 'data', '1_knowledge_index.json'))).toBe(true);
      const index = JSON.parse(readFileSync(join(root, 'data', '1_knowledge_index.json'), 'utf8'));
      expect(index.version).toBe(3);
      expect(Object.values(index.keywords).flat().every((entry) => typeof entry === 'string')).toBe(true);
    } finally {
      if (oldAppData === undefined) delete process.env.APP_DATA_DIR;
      else process.env.APP_DATA_DIR = oldAppData;
    }
  });
});
