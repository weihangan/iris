// Phase 5.2 Task 5.2.5: PerformanceClock（RED）
//
// PerformanceClock 职责：
// - 与 AudioContext.currentTime 对齐（同一时钟基准）
// - 提供 now() 返回当前表演时间（秒）
// - alignTo(taskId, audioStartTime) 锁定某个任务的音频开始时间
// - 后续 now() 返回相对于 audioStartTime 的时间
//
// 硬规则（Phase 5.1 不回归）：
// - Avatar 是唯一 AudioContext 所有者，PerformanceClock 不直接访问 AudioContext
// - 通过构造函数注入 getAudioContextTime 回调获取时间
// - Date.now() fallback 仅在 AudioContext 不可用时使用

import { describe, it, expect, vi } from 'vitest';
import { PerformanceClock } from '../../src/performance/performance-clock';

describe('PerformanceClock', () => {
  describe('now()', () => {
    it('返回 getAudioContextTime() 的值', () => {
      let time = 100.5;
      const clock = new PerformanceClock(() => time);
      expect(clock.now()).toBe(100.5);
      time = 101.2;
      expect(clock.now()).toBe(101.2);
    });

    it('未对齐时返回原始 audioContextTime', () => {
      const clock = new PerformanceClock(() => 42.0);
      expect(clock.now()).toBe(42.0);
    });

    it('AudioContext 不可用时 fallback 到 Date.now() / 1000', () => {
      const realDateNow = Date.now;
      Date.now = () => 5000;
      try {
        const clock = new PerformanceClock(() => {
          throw new Error('AudioContext unavailable');
        });
        expect(clock.now()).toBe(5);
      } finally {
        Date.now = realDateNow;
      }
    });
  });

  describe('alignTo()', () => {
    it('对齐后 now() 返回相对于 audioStartTime 的时间', () => {
      let time = 100.0;
      const clock = new PerformanceClock(() => time);
      clock.alignTo('task-1', 100.0);
      time = 100.5;
      expect(clock.now()).toBeCloseTo(0.5, 5);
      time = 102.3;
      expect(clock.now()).toBeCloseTo(2.3, 5);
    });

    it('多次 alignTo() 切换到新任务', () => {
      let time = 100.0;
      const clock = new PerformanceClock(() => time);
      clock.alignTo('task-1', 100.0);
      time = 105.0;
      expect(clock.now()).toBeCloseTo(5.0, 5);

      clock.alignTo('task-2', 105.0);
      time = 106.5;
      expect(clock.now()).toBeCloseTo(1.5, 5);
    });

    it('对齐前 audioStartTime 为 undefined', () => {
      const clock = new PerformanceClock(() => 100.0);
      expect(clock.getAudioStartTime()).toBeUndefined();
    });

    it('对齐后 getAudioStartTime() 返回 audioStartTime', () => {
      const clock = new PerformanceClock(() => 100.0);
      clock.alignTo('task-1', 100.0);
      expect(clock.getAudioStartTime()).toBe(100.0);
    });

    it('对齐后 getCurrentTaskId() 返回 taskId', () => {
      const clock = new PerformanceClock(() => 100.0);
      clock.alignTo('task-abc', 100.0);
      expect(clock.getCurrentTaskId()).toBe('task-abc');
    });

    it('未对齐时 getCurrentTaskId() 返回 undefined', () => {
      const clock = new PerformanceClock(() => 100.0);
      expect(clock.getCurrentTaskId()).toBeUndefined();
    });
  });

  describe('clearAlignment()', () => {
    it('清除对齐后 now() 返回原始时间', () => {
      let time = 100.0;
      const clock = new PerformanceClock(() => time);
      clock.alignTo('task-1', 100.0);
      time = 105.0;
      expect(clock.now()).toBe(5.0);

      clock.clearAlignment();
      expect(clock.now()).toBe(105.0);
    });

    it('清除对齐后 getAudioStartTime() 为 undefined', () => {
      const clock = new PerformanceClock(() => 100.0);
      clock.alignTo('task-1', 100.0);
      clock.clearAlignment();
      expect(clock.getAudioStartTime()).toBeUndefined();
    });

    it('清除对齐后 getCurrentTaskId() 为 undefined', () => {
      const clock = new PerformanceClock(() => 100.0);
      clock.alignTo('task-1', 100.0);
      clock.clearAlignment();
      expect(clock.getCurrentTaskId()).toBeUndefined();
    });
  });

  describe('同一时钟基准', () => {
    it('动作时间轴和音频时间轴使用同一 clock', () => {
      let time = 200.0;
      const clock = new PerformanceClock(() => time);
      clock.alignTo('task-x', 200.0);

      // 音频播放器调用
      time = 201.5;
      const audioTime = clock.now();

      // 动作播放器调用（稍后）
      time = 201.7;
      const motionTime = clock.now();

      // 两次调用都相对于同一 audioStartTime
      expect(audioTime).toBeCloseTo(1.5, 5);
      expect(motionTime).toBeCloseTo(1.7, 5);
      // 差值正确反映时间流逝
      expect(motionTime - audioTime).toBeCloseTo(0.2, 5);
    });
  });
});
