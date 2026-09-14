import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  appendTrainLog,
  readTrainLogsSince,
  resetTrainLogs
} = require('../../chat5-compat/services/boundedTrainLog.js') as {
  appendTrainLog(job: Record<string, any>, entry: Record<string, any>, options?: Record<string, number>): void;
  readTrainLogsSince(job: Record<string, any>, cursor?: number): {
    entries: Record<string, any>[];
    nextCursor: number;
    droppedBeforeCursor: boolean;
  };
  resetTrainLogs(job: Record<string, any>): void;
};

describe('bounded training log', () => {
  it('keeps only the latest entries while preserving a monotonic SSE cursor', () => {
    const job: Record<string, any> = { logs: [] };
    for (let i = 0; i < 5; i++) {
      appendTrainLog(job, { stage: 'train', msg: `line-${i}` }, { maxEntries: 3, maxBytes: 10_000 });
    }

    const replay = readTrainLogsSince(job, 0);
    expect(replay.entries.map(entry => entry.msg)).toEqual(['line-2', 'line-3', 'line-4']);
    expect(replay.nextCursor).toBe(5);
    expect(replay.droppedBeforeCursor).toBe(true);
  });

  it('bounds retained bytes and resets cleanly for a resumed job', () => {
    const job: Record<string, any> = { logs: [] };
    for (let i = 0; i < 10; i++) {
      appendTrainLog(job, { stage: 'stderr', msg: `${i}:${'x'.repeat(80)}` }, { maxEntries: 100, maxBytes: 300 });
    }

    expect(job.logs.length).toBeLessThan(10);
    expect(job.logBytes).toBeLessThanOrEqual(300);
    expect(readTrainLogsSince(job, job.logBaseIndex).entries).toEqual(job.logs);

    resetTrainLogs(job);
    expect(job.logs).toEqual([]);
    expect(job.logBaseIndex).toBe(0);
    expect(job.logBytes).toBe(0);
  });

  it('truncates a single oversized stderr chunk to the configured byte cap', () => {
    const job: Record<string, any> = { logs: [] };
    appendTrainLog(job, { stage: 'stderr', status: 'running', msg: 'x'.repeat(20_000) }, {
      maxEntries: 10,
      maxBytes: 512
    });

    expect(job.logs).toHaveLength(1);
    expect(job.logBytes).toBeLessThanOrEqual(512);
    expect(job.logs[0].msg).toContain('过长日志已截断');
  });
});
