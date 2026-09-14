import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('chat history compression nodes', () => {
  it('keeps full local history and produces summary plus durable memory in one API call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chatx2-compression-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'characters', '1'), { recursive: true });
    const oldAppData = process.env.APP_DATA_DIR;
    process.env.APP_DATA_DIR = root;
    for (const id of [
      '../../chat5-compat/services/historyService.js',
      '../../chat5-compat/services/memoryService.js',
      '../../chat5-compat/services/archiveService.js',
      '../../chat5-compat/services/appPaths.js',
    ]) {
      try { delete require.cache[require.resolve(id)]; } catch {}
    }

    try {
      const historyService = require('../../chat5-compat/services/historyService.js');
      const memoryService = require('../../chat5-compat/services/memoryService.js');
      const archiveService = require('../../chat5-compat/services/archiveService.js');
      const history = Array.from({ length: 220 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index === 0
          ? `我喜欢蓝色，这是想让你长期记住的偏好。${'甲'.repeat(500)}`
          : `${index}-${'测试对话'.repeat(125)}`,
        time: `2026-08-01 10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
      }));
      historyService.writeHistory('1', history);
      expect(historyService.needsCompression('1')).toBe(true);

      let apiCalls = 0;
      let apiOptions: any = null;
      const chatWithAI = async (_messages: any, options: any) => {
        apiCalls++;
        apiOptions = options;
        return JSON.stringify({
          summary: '用户明确表示喜欢蓝色；其余为测试对话。',
          memory_updates: {
            preferences: { likes: ['蓝色'] },
            permanent_facts: [{
              fact: '用户喜欢蓝色',
              category: 'other',
              confidence: 1,
              source: '对话中明确提及',
            }],
          },
        });
      };

      await historyService.compressHistory('1', chatWithAI, memoryService, archiveService);

      const compressed = historyService.readCompressed('1');
      expect(apiCalls).toBe(1);
      expect(apiOptions).toMatchObject({ maxTokens: 2048 });
      expect(historyService.readHistory('1')).toEqual(history);
      expect(historyService.readActiveHistory('1').length).toBeLessThan(history.length);
      expect(compressed).toMatchObject({
        schema_version: 2,
        history_mode: 'canonical_full',
        summary: '用户明确表示喜欢蓝色；其余为测试对话。',
      });
      expect(compressed.active_start_index).toBeGreaterThan(0);
      expect(compressed.nodes).toHaveLength(1);
      expect(memoryService.readMemory('1').preferences.likes).toContain('蓝色');

      const recalled = archiveService.searchUserContext('1', '你还记得我说喜欢蓝色吗', 1);
      expect(recalled).toHaveLength(1);
      expect(recalled[0].content).toContain('这是想让你长期记住的偏好');
    } finally {
      if (oldAppData === undefined) delete process.env.APP_DATA_DIR;
      else process.env.APP_DATA_DIR = oldAppData;
    }
  });
});
