// Phase 5.2 Task 5.2.6: AvatarPerformanceSession（RED）
//
// AvatarPerformanceSession 职责：
// - 封装 PerformanceClock + LipTimeline + PerformancePlanner 的集成
// - 在 Avatar 渲染器内提供"同一音频时钟基准"的表演会话
// - 对齐音频开始时间、生成 viseme 时间轴、查询当前 viseme 权重
// - 暴露 PerformanceClock 供动作播放器（Phase 5.3+）使用
// - 表演结束时清零 viseme + 清除时钟对齐
//
// 硬规则（Phase 5.1 不回归）：
// - Avatar 是唯一 AudioContext/解码器/播放时钟所有者，session 不直接访问 AudioContext
// - 通过构造函数注入 getAudioContextTime 回调获取时间
// - session 不向 Composer/Chat 暴露 wavBytes / 时间轴内容（隐私边界）
// - endPerformance 后必须清零所有 viseme 权重，防止切回 Chat 后口型残留

import { describe, it, expect } from 'vitest';
import { AvatarPerformanceSession } from '../../src/performance/avatar-performance-session';
import { FACIAL_CHANNELS } from '../../src/performance/facial-pose';
import { generateMockWav } from '../../src/conversation/mock-wav-generator';
import type { AcceptedExpressionRecord } from '../../src/performance/daily-candidate-types';

function acceptedExpression(
  id: string,
  emotion: AcceptedExpressionRecord['emotion'],
  channel: 'eyeSmile' | 'mouthPucker',
  value: number
): AcceptedExpressionRecord {
  return {
    kind: 'expression', id, displayName: id, emotion, durationSeconds: 2,
    source: {
      sourceType: 'generated', sourceUrl: `generated://${id}`, author: 'ChatX2',
      statedTerms: 'local test', downloadedAt: '2026-08-15T00:00:00.000Z',
      sha256: 'A'.repeat(64), sourceRelativePath: `${id}.json`
    },
    status: 'accepted', automatic: true, acceptedAt: '2026-08-15T01:00:00.000Z',
    channelCurves: { [channel]: [{ timeSeconds: 1, value }] }
  };
}

describe('AvatarPerformanceSession', () => {
  describe('初始状态', () => {
    it('新会话状态为 idle', () => {
      const session = new AvatarPerformanceSession(() => 0);
      expect(session.getState()).toBe('idle');
    });

    it('新会话 getCurrentTaskId 返回 null', () => {
      const session = new AvatarPerformanceSession(() => 0);
      expect(session.getCurrentTaskId()).toBeNull();
    });

    it('新会话 getCurrentTime 返回 0', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      expect(session.getCurrentTime()).toBe(0);
    });

    it('新会话 getVisemeTimeline 为空', () => {
      const session = new AvatarPerformanceSession(() => 0);
      expect(session.getVisemeTimeline()).toHaveLength(0);
    });

    it('新会话 getDurationSeconds 为 0', () => {
      const session = new AvatarPerformanceSession(() => 0);
      expect(session.getDurationSeconds()).toBe(0);
    });
  });

  describe('beginPerformance()', () => {
    it('开始会话后状态变为 performing', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world' });
      session.beginPerformance('task-1', 100.0, wav);
      expect(session.getState()).toBe('performing');
    });

    it('开始会话后 getCurrentTaskId 返回 taskId', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world' });
      session.beginPerformance('task-1', 100.0, wav);
      expect(session.getCurrentTaskId()).toBe('task-1');
    });

    it('开始会话后返回 PerformanceBeginInfo', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world' });
      const info = session.beginPerformance('task-1', 100.0, wav);
      expect(info.taskId).toBe('task-1');
      expect(info.audioStartTime).toBe(100.0);
      expect(info.visemeCount).toBeGreaterThan(0);
      expect(info.durationSeconds).toBeGreaterThan(0);
    });

    it('visemeCount 与 getVisemeTimeline().length 一致', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world' });
      const info = session.beginPerformance('task-1', 100.0, wav);
      expect(session.getVisemeTimeline()).toHaveLength(info.visemeCount);
    });

    it('durationSeconds 与 getDurationSeconds() 一致', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world' });
      const info = session.beginPerformance('task-1', 100.0, wav);
      expect(session.getDurationSeconds()).toBeCloseTo(info.durationSeconds, 5);
    });

    it('空 WAV 不生成 viseme（fail-closed）', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const info = session.beginPerformance('task-x', 100.0, new ArrayBuffer(0));
      expect(info.visemeCount).toBe(0);
      expect(info.durationSeconds).toBe(0);
      expect(session.getVisemeTimeline()).toHaveLength(0);
    });

    it('无效 WAV（非 RIFF）不生成 viseme', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const badWav = new ArrayBuffer(100);
      const info = session.beginPerformance('task-y', 100.0, badWav);
      expect(info.visemeCount).toBe(0);
      expect(info.durationSeconds).toBe(0);
    });
  });

  describe('getCurrentTime()（同一时钟基准）', () => {
    it('performing 状态返回相对于 audioStartTime 的时间', () => {
      let ctxTime = 100.0;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello' });
      session.beginPerformance('task-1', 100.0, wav);

      ctxTime = 100.5;
      expect(session.getCurrentTime()).toBeCloseTo(0.5, 5);

      ctxTime = 102.3;
      expect(session.getCurrentTime()).toBeCloseTo(2.3, 5);
    });

    it('idle 状态始终返回 0', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      expect(session.getCurrentTime()).toBe(0);
    });

    it('endPerformance 后即使时间继续推进也返回 0', () => {
      let ctxTime = 100.0;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello' });
      session.beginPerformance('task-1', 100.0, wav);
      ctxTime = 105.0;
      expect(session.getCurrentTime()).toBeCloseTo(5.0, 5);

      session.endPerformance();
      ctxTime = 110.0;
      expect(session.getCurrentTime()).toBe(0);
    });
  });

  describe('getClock()', () => {
    it('返回的 clock 在 beginPerformance 后对齐', () => {
      let ctxTime = 100.0;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello' });
      session.beginPerformance('task-1', 100.0, wav);

      const clock = session.getClock();
      expect(clock.getCurrentTaskId()).toBe('task-1');
      expect(clock.getAudioStartTime()).toBe(100.0);

      ctxTime = 101.5;
      expect(clock.now()).toBeCloseTo(1.5, 5);
    });

    it('返回的 clock 在 endPerformance 后清除对齐', () => {
      let ctxTime = 100.0;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello' });
      session.beginPerformance('task-1', 100.0, wav);
      session.endPerformance();

      const clock = session.getClock();
      expect(clock.getCurrentTaskId()).toBeUndefined();
      expect(clock.getAudioStartTime()).toBeUndefined();
    });

    it('动作播放器和音频使用同一 clock 基准', () => {
      let ctxTime = 200.0;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const wav = generateMockWav({ taskId: 'task-x', userText: 'hello world' });
      session.beginPerformance('task-x', 200.0, wav);

      const clock = session.getClock();

      // 音频播放器查询时间
      ctxTime = 201.5;
      const audioTime = clock.now();

      // 动作播放器稍后查询
      ctxTime = 201.7;
      const motionTime = clock.now();

      expect(audioTime).toBeCloseTo(1.5, 5);
      expect(motionTime).toBeCloseTo(1.7, 5);
      expect(motionTime - audioTime).toBeCloseTo(0.2, 5);
    });
  });

  describe('getCurrentViseme()', () => {
    it('按音频时钟返回完整五口型权重而不是固定 あ', () => {
      let ctxTime = 100;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const wav = generateMockWav({ taskId: 'five-viseme', userText: 'long enough audio' });
      session.beginPerformance('five-viseme', 100, wav, '啊咿呜诶哦');
      ctxTime = 100.35;
      const weights = session.getCurrentVisemeWeights();
      expect(Object.keys(weights)).toEqual(['A', 'I', 'U', 'E', 'O']);
      expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(1);
      expect(Object.values(weights).some(value => value > 0)).toBe(true);
    });

    it('performing 状态返回当前时间的 viseme keyframe', () => {
      let ctxTime = 100.0;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world this is a test' });
      session.beginPerformance('task-1', 100.0, wav);

      ctxTime = 100.0; // time=0
      const viseme0 = session.getCurrentViseme(session.getCurrentTime());
      expect(viseme0).not.toBeNull();
      expect(viseme0!.weight).toBe(0); // 第一帧权重为 0

      ctxTime = 100.15; // time=0.15
      const viseme1 = session.getCurrentViseme(session.getCurrentTime());
      expect(viseme1).not.toBeNull();
    });

    it('idle 状态返回 null', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      expect(session.getCurrentViseme(0)).toBeNull();
    });

    it('空时间轴返回 null', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      // 空 WAV 触发 fail-closed，时间轴为空
      session.beginPerformance('task-empty', 100.0, new ArrayBuffer(0));
      expect(session.getCurrentViseme(0)).toBeNull();
    });

    it('时间早于第一帧返回第一帧（权重 0）', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world' });
      session.beginPerformance('task-1', 100.0, wav);
      const viseme = session.getCurrentViseme(-1);
      expect(viseme).not.toBeNull();
      expect(viseme!.weight).toBe(0);
    });

    it('时间晚于最后一帧返回最后一帧（权重 0）', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world' });
      const info = session.beginPerformance('task-1', 100.0, wav);
      const viseme = session.getCurrentViseme(info.durationSeconds + 10);
      expect(viseme).not.toBeNull();
      expect(viseme!.weight).toBe(0); // 最后一帧权重为 0
    });
  });

  describe('expression timeline', () => {
    it('与口型共享同一个音频时钟并连续输出 emotion 权重', () => {
      let ctxTime = 10;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const wav = generateMockWav({ taskId: 'expression', userText: 'a sufficiently long sentence' });
      session.beginPerformance('expression', 10, wav, '你好', 'happy', 0.7);
      expect(session.getCurrentExpression().weight).toBe(0);
      ctxTime = 10.4;
      const expression = session.getCurrentExpression();
      expect(expression.emotion).toBe('greeting');
      expect(expression.weight).toBeGreaterThan(0);
      expect(expression.pose.mouthSmileLeft).toBeGreaterThan(0);
      session.endPerformance();
      expect(session.getCurrentExpression().weight).toBe(0);
    });

    it('uses phrase cues to change expression on the same audio clock', () => {
      let ctxTime = 20;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const text = '我很开心！让我想一想。这个情况有点让人担心。';
      const wav = generateMockWav({ taskId: 'phrase-cues', userText: text });
      session.beginPerformance('phrase-cues', 20, wav, text, 'serious', 0.5, {
        emotion: 'serious', intent: 'explaining', intensity: 0.5, gaze: 'user'
      });

      const cues = session.getPerformanceCues();
      expect(cues.length).toBeGreaterThanOrEqual(3);
      const thinkingCue = cues.find(cue => cue.emotion === 'thinking');
      expect(thinkingCue).toBeDefined();
      ctxTime = 20 + (thinkingCue!.startSeconds + thinkingCue!.endSeconds) / 2;

      expect(session.getCurrentPerformanceCue()?.emotion).toBe('thinking');
      expect(session.getCurrentExpression()).toMatchObject({ emotion: 'thinking' });
      expect(session.getCurrentExpression().weight).toBeGreaterThan(0);
    });

    it('uses model personality to vary only the face across a calm comforting reply', () => {
      let ctxTime = 60;
      const session = new AvatarPerformanceSession(() => ctxTime);
      session.setFacialPersonality({ warmth: 0.9, calmness: 0.9, affection: 0.8, concern: 0.85 });
      const text = '指挥，夜深了，你还没休息吗？我有些担心。若觉得孤单或难以入眠，不妨听听我的歌声。我愿为你奏一曲安眠的乐章，伴你度过这漫长的黑夜。';
      const wav = generateMockWav({ taskId: 'night-comfort', userText: text });
      session.beginPerformance('night-comfort', 60, wav, text, 'concerned', 0.55, {
        emotion: 'concerned', intent: 'concerned', intensity: 0.55, gaze: 'side-down'
      });

      const cues = session.getPerformanceCues();
      const facialEmotions = cues.map(cue => {
        ctxTime = 60 + (cue.startSeconds + cue.endSeconds) / 2;
        const expressionEmotion = session.getCurrentExpression().emotion;
        expect(expressionEmotion).toBe(cue.facialEmotion);
        return cue.facialEmotion;
      });

      expect(facialEmotions).toContain('concerned');
      expect(facialEmotions).toContain('gentle');
      expect(facialEmotions).toContain('loving');
      expect(cues.every(cue => cue.intent === 'concerned' || typeof cue.intent === 'string')).toBe(true);
    });

    it('keeps a personality-refined gentle face visible when the raw cue is neutral', () => {
      let ctxTime = 80;
      const session = new AvatarPerformanceSession(() => ctxTime);
      session.setFacialPersonality({ warmth: 0.9, calmness: 0.9, affection: 0.8, concern: 0.85 });
      const text = '我来慢慢说明现在的情况。';
      const wav = generateMockWav({ taskId: 'neutral-gentle', userText: text });
      session.beginPerformance('neutral-gentle', 80, wav, text, 'neutral', 0.2, {
        emotion: 'neutral', intent: 'explaining', intensity: 0.2, gaze: 'user'
      });

      const cue = session.getPerformanceCues()[0];
      ctxTime = 80 + (cue.startSeconds + cue.endSeconds) / 2;
      const expression = session.getCurrentExpression();

      expect(expression.emotion).toBe('gentle');
      expect(expression.pose.eyeSmile).toBeGreaterThan(0.1);
      expect(expression.pose.mouthSmileLeft).toBeGreaterThan(0.2);
    });

    it('keeps shy visibly blushing even when the raw speech intensity is low', () => {
      let ctxTime = 90;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const text = '你这样说，我真的有些害羞。';
      const wav = generateMockWav({ taskId: 'shy-blush-floor', userText: text });
      session.beginPerformance('shy-blush-floor', 90, wav, text, 'shy', 0.2, {
        emotion: 'shy', intent: 'shy', intensity: 0.2, gaze: 'side-down'
      });

      const cue = session.getPerformanceCues()[0];
      ctxTime = 90 + (cue.startSeconds + cue.endSeconds) / 2;
      const expression = session.getCurrentExpression();

      expect(['shy', 'embarrassed']).toContain(expression.emotion);
      expect(expression.pose.blush).toBeGreaterThan(0.3);
      expect(expression.pose.eyeSquintLeft).toBeGreaterThan(0.45);
      expect(expression.pose.mouthSmileLeft).toBeGreaterThan(0.4);
    });

    it('refines sadness for the face without changing the motion-facing cue emotion', () => {
      let ctxTime = 40;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const text = '想到这件事，我真的很难过。';
      const wav = generateMockWav({ taskId: 'face-only-sad', userText: text });
      session.beginPerformance('face-only-sad', 40, wav, text, 'concerned', 0.6, {
        emotion: 'concerned', intent: 'concerned', intensity: 0.6, gaze: 'side-down'
      });
      const cue = session.getPerformanceCues().find(item => item.text.includes('难过'))!;
      expect(cue).toBeDefined();
      ctxTime = 40 + (cue.startSeconds + cue.endSeconds) / 2;

      expect(session.getCurrentPerformanceCue()?.emotion).toBe('concerned');
      expect(session.getCurrentExpression().emotion).toBe('sad');
      expect(session.getCurrentExpression().pose.mouthFrownLeft).toBeGreaterThan(0);
    });

    it('does not drop expression weight to zero at phrase boundaries', () => {
      let ctxTime = 30;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const text = '我会认真说明这个部分。这个情况也让我有些担心。';
      const wav = generateMockWav({ taskId: 'continuous-expression', userText: text });
      session.beginPerformance('continuous-expression', 30, wav, text, 'serious', 0.6);
      const secondCue = session.getPerformanceCues()[1];
      expect(secondCue).toBeDefined();

      ctxTime = 30 + secondCue.startSeconds;
      const expression = session.getCurrentExpression();
      expect(expression.weight).toBeGreaterThanOrEqual(0.5);
      expect(FACIAL_CHANNELS.some(channel => expression.pose[channel] > 0)).toBe(true);
    });

    it('holds the final speech expression through the audio endpoint instead of fading to an empty face', () => {
      let ctxTime = 50;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const text = '今天真的很开心。';
      const wav = generateMockWav({ taskId: 'held-final-expression', userText: text });
      const info = session.beginPerformance('held-final-expression', 50, wav, text, 'happy', 0.8);

      ctxTime = 50 + info.durationSeconds;
      const finalExpression = session.getCurrentExpression();

      expect(['happy', 'loving']).toContain(finalExpression.emotion);
      expect(finalExpression.weight).toBeGreaterThan(0.7);
      expect(finalExpression.pose.mouthSmileLeft).toBeGreaterThan(0.2);
    });

    it('uses intent-specific expression-pool recipes and exposes micro-expression evidence', () => {
      let ctxTime = 120;
      const session = new AvatarPerformanceSession(() => ctxTime);
      const text = '你好，欢迎回来。接下来我会说明这个部分。';
      const wav = generateMockWav({ taskId: 'expression-pool-runtime', userText: text });
      session.beginPerformance('expression-pool-runtime', 120, wav, text, 'neutral', 0.55, {
        emotion: 'neutral', intent: 'greeting', intensity: 0.55, gaze: 'user'
      });

      const greeting = session.getPerformanceCues().find(cue => cue.intent === 'greeting');
      expect(greeting?.facialEmotion).toBe('greeting');
      ctxTime = 120 + (greeting!.startSeconds + greeting!.endSeconds) / 2;
      const sample = session.getCurrentExpression();

      expect(sample.emotion).toBe('greeting');
      expect(sample.microExpression?.id).toBeTruthy();
      expect(sample.microExpression?.weight).toBeGreaterThan(0);
    });

    it('uses accepted automatic expressions on the audio clock and changes them at a semantic turn', () => {
      let ctxTime = 140;
      const session = new AvatarPerformanceSession(() => ctxTime);
      session.updateAcceptedExpressions([
        acceptedExpression('accepted-gentle', 'gentle', 'eyeSmile', 0.75),
        acceptedExpression('accepted-thinking', 'thinking', 'mouthPucker', 0.8)
      ], ['eyeSmile', 'mouthPucker']);
      const text = '先别担心，我会陪着你。让我认真想一想这个办法。';
      const wav = generateMockWav({ taskId: 'accepted-expression-turn', userText: text });
      session.beginPerformance('accepted-expression-turn', 140, wav, text, 'gentle', 0.6, {
        emotion: 'gentle', intent: 'reassuring', intensity: 0.6, gaze: 'user',
        segments: [
          {
            text: '先别担心，我会陪着你。', voiceEmotion: 'comfort', emotion: 'gentle',
            intent: 'reassuring', intensity: 0.6, gaze: 'user', confidence: 0.9
          },
          {
            text: '让我认真想一想这个办法。', voiceEmotion: 'gentle', emotion: 'thinking',
            intent: 'thinking', intensity: 0.58, gaze: 'side-down', confidence: 0.9
          }
        ]
      });

      const cues = session.getPerformanceCues();
      const gentleCue = cues.find(cue => cue.emotion === 'gentle')!;
      const thinkingCue = cues.find(cue => cue.emotion === 'thinking')!;
      expect(thinkingCue.emotionTurn).toBe(true);

      ctxTime = 140 + (gentleCue.startSeconds + gentleCue.endSeconds) / 2;
      const gentle = session.getCurrentExpression();
      expect(gentle.automaticExpression?.id).toBe('accepted-gentle');
      expect(gentle.pose.eyeSmile).toBeGreaterThan(0.5);

      ctxTime = 140 + (thinkingCue.startSeconds + thinkingCue.endSeconds) / 2;
      const thinking = session.getCurrentExpression();
      expect(thinking.automaticExpression?.id).toBe('accepted-thinking');
      expect(thinking.pose.mouthPucker).toBeGreaterThan(0.5);
    });

    it('clears phrase cues when the performance ends', () => {
      const session = new AvatarPerformanceSession(() => 10);
      const wav = generateMockWav({ taskId: 'clear-cues', userText: '我很开心！' });
      session.beginPerformance('clear-cues', 10, wav, '我很开心！');
      expect(session.getPerformanceCues().length).toBeGreaterThan(0);

      session.endPerformance();

      expect(session.getPerformanceCues()).toEqual([]);
      expect(session.getCurrentPerformanceCue()).toBeNull();
    });
  });

  describe('plan()', () => {
    it('plan() 委托给 PerformancePlanner', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const plan = session.plan({ emotion: 'neutral', speaking: false });
      expect(plan.state).toBe('idle');
      expect(plan.emotion).toBe('neutral');
      // Phase 6: motionPackId 已移除，idle 状态通过 VMD 文件管理
      expect(plan.gestureFamily).toBeDefined();
    });

    it('speaking=true 时 state=speaking', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const plan = session.plan({ emotion: 'happy', speaking: true });
      expect(plan.state).toBe('speaking');
      expect(plan.intensity).toBeGreaterThan(0);
    });
  });

  describe('endPerformance()', () => {
    it('endPerformance 后状态变为 idle', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello' });
      session.beginPerformance('task-1', 100.0, wav);
      expect(session.getState()).toBe('performing');

      session.endPerformance();
      expect(session.getState()).toBe('idle');
    });

    it('endPerformance 后 taskId 清空', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello' });
      session.beginPerformance('task-1', 100.0, wav);
      session.endPerformance();
      expect(session.getCurrentTaskId()).toBeNull();
    });

    it('endPerformance 后 viseme 时间轴清空', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world' });
      session.beginPerformance('task-1', 100.0, wav);
      expect(session.getVisemeTimeline().length).toBeGreaterThan(0);

      session.endPerformance();
      expect(session.getVisemeTimeline()).toHaveLength(0);
    });

    it('endPerformance 后 duration 清零', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world' });
      session.beginPerformance('task-1', 100.0, wav);
      expect(session.getDurationSeconds()).toBeGreaterThan(0);

      session.endPerformance();
      expect(session.getDurationSeconds()).toBe(0);
    });

    it('endPerformance 后 clock 清除对齐', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello' });
      session.beginPerformance('task-1', 100.0, wav);
      expect(session.getClock().getCurrentTaskId()).toBe('task-1');

      session.endPerformance();
      expect(session.getClock().getCurrentTaskId()).toBeUndefined();
      expect(session.getClock().getAudioStartTime()).toBeUndefined();
    });

    it('多次调用 endPerformance 是幂等的', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello' });
      session.beginPerformance('task-1', 100.0, wav);

      session.endPerformance();
      session.endPerformance();
      session.endPerformance();

      expect(session.getState()).toBe('idle');
      expect(session.getCurrentTaskId()).toBeNull();
      expect(session.getVisemeTimeline()).toHaveLength(0);
    });
  });

  describe('任务切换', () => {
    it('beginPerformance 不自动 endPerformance 旧任务（调用方负责）', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav1 = generateMockWav({ taskId: 'task-1', userText: 'first task' });
      const wav2 = generateMockWav({ taskId: 'task-2', userText: 'second task' });

      session.beginPerformance('task-1', 100.0, wav1);
      // 没有调用 endPerformance，直接 beginPerformance 新任务
      session.beginPerformance('task-2', 105.0, wav2);

      // 应该切换到新任务（不是叠加）
      expect(session.getCurrentTaskId()).toBe('task-2');
      expect(session.getClock().getCurrentTaskId()).toBe('task-2');
      expect(session.getClock().getAudioStartTime()).toBe(105.0);
    });

    it('正确切换：先 endPerformance 旧任务再 beginPerformance 新任务', () => {
      const session = new AvatarPerformanceSession(() => 100.0);
      const wav1 = generateMockWav({ taskId: 'task-1', userText: 'first task' });
      const wav2 = generateMockWav({ taskId: 'task-2', userText: 'second task' });

      session.beginPerformance('task-1', 100.0, wav1);
      session.endPerformance();
      session.beginPerformance('task-2', 105.0, wav2);

      expect(session.getCurrentTaskId()).toBe('task-2');
      expect(session.getState()).toBe('performing');
      expect(session.getClock().getCurrentTaskId()).toBe('task-2');
    });
  });

  describe('同一时钟基准（与 Phase 5.1 硬门对齐）', () => {
    it('Avatar 内部所有时间查询使用同一 getAudioContextTime 回调', () => {
      let ctxTime = 50.0;
      let callCount = 0;
      const session = new AvatarPerformanceSession(() => {
        callCount++;
        return ctxTime;
      });
      const wav = generateMockWav({ taskId: 'task-1', userText: 'hello world' });
      session.beginPerformance('task-1', 50.0, wav);

      callCount = 0;
      ctxTime = 51.0;
      session.getCurrentTime(); // 调用 1 次
      session.getClock().now();  // 调用 1 次
      session.getCurrentViseme(session.getCurrentTime()); // 通过 getCurrentTime 调用 1 次

      // 至少调用了 3 次，每次都返回相同的 ctxTime
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('AudioContext 不可用时 fallback 到 Date.now()', () => {
      const realDateNow = Date.now;
      Date.now = () => 5000;
      try {
        const session = new AvatarPerformanceSession(() => {
          throw new Error('AudioContext closed');
        });
        const wav = generateMockWav({ taskId: 'task-1', userText: 'hello' });
        session.beginPerformance('task-1', 5, wav);
        // beginPerformance 时 audioStartTime=5，当前 Date.now()/1000=5，差值为 0
        expect(session.getCurrentTime()).toBeCloseTo(0, 1);
      } finally {
        Date.now = realDateNow;
      }
    });
  });
});
