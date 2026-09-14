import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createCompletedDistillTask,
  toPublicDistillTask
} = require('../../chat5-compat/services/distillTaskState.js') as {
  createCompletedDistillTask(characterId: string, progress: string, result: Record<string, any>): Record<string, any>;
  toPublicDistillTask(task: Record<string, any>, readSkill: (characterId: string) => string): Record<string, any>;
};

describe('distillation task state', () => {
  it('retains only lightweight completed metadata in memory', () => {
    const task = createCompletedDistillTask('selena', '完成', {
      skill: 'S'.repeat(50_000),
      sources: [{ id: 'source-1', source: 'wiki', title: '角色页', status: 'success', content: 'R'.repeat(50_000) }],
      manifest: { rawResearch: 'M'.repeat(50_000) },
      partialResult: true,
      warnings: ['覆盖不足'],
      coverageBySection: { voice: 'partial' }
    });

    expect(task.characterId).toBe('selena');
    expect(task.result.skill).toBeUndefined();
    expect(task.result.manifest).toBeUndefined();
    expect(task.result.sources).toEqual([{ id: 'source-1', source: 'wiki', title: '角色页', status: 'success' }]);
    expect(JSON.stringify(task).length).toBeLessThan(1000);
  });

  it('hydrates the persisted role skill only when the UI polls a completed task', () => {
    const task = createCompletedDistillTask('selena', '完成', {
      sources: [],
      partialResult: false,
      warnings: []
    });
    const readSkill = vi.fn(() => '# Selena skill');

    const response = toPublicDistillTask(task, readSkill);

    expect(readSkill).toHaveBeenCalledWith('selena');
    expect(response.result.skill).toBe('# Selena skill');
    expect(task.result.skill).toBeUndefined();
  });

  it('does not read character files for running or failed tasks', () => {
    const readSkill = vi.fn(() => 'unused');
    const running = toPublicDistillTask({ status: 'running', characterId: '1', result: null }, readSkill);
    const failed = toPublicDistillTask({ status: 'failed', characterId: '1', result: null, error: 'failed' }, readSkill);

    expect(running.status).toBe('running');
    expect(failed.error).toBe('failed');
    expect(readSkill).not.toHaveBeenCalled();
  });
});
