// Phase 5.2 Task 5.2.5: PerformancePlanner（RED）
//
// PerformancePlanner 职责：
// - 根据情绪/意图/状态生成 PerformancePlan
// - 决定动作选择（motionPackId）、注视方向（gaze）、手势家族（gestureFamily）
// - 输出归一化的 intensity（0-1）供下游使用
//
// 规则：
// - speaking=true → state='speaking'
// - speaking=false 且 emotion='listening' → state='listening'
// - speaking=false 且 emotion='thinking' → state='thinking'
// - 其他 → state='idle'
// - emotion 映射到 gaze/gestureFamily/intensity
// - idle 状态下选择待机包（motionPackId）

import { describe, it, expect } from 'vitest';
import { PerformancePlanner, type PerformancePlan } from '../../src/performance/performance-planner';

describe('PerformancePlanner', () => {
  describe('plan()', () => {
    it('speaking=true → state=speaking', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'neutral', speaking: true });
      expect(plan.state).toBe('speaking');
    });

    it('speaking=false, emotion=listening → state=listening', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'listening', speaking: false });
      expect(plan.state).toBe('listening');
    });

    it('speaking=false, emotion=thinking → state=thinking', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'thinking', speaking: false });
      expect(plan.state).toBe('thinking');
    });

    it('speaking=false, emotion=neutral → state=idle', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'neutral', speaking: false });
      expect(plan.state).toBe('idle');
    });

    it('emotion 透传到 plan.emotion', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'happy', speaking: true });
      expect(plan.emotion).toBe('happy');
    });

    it('intent 透传到 plan.intent（未提供时为空字符串）', () => {
      const planner = new PerformancePlanner();
      const plan1 = planner.plan({ emotion: 'neutral', speaking: true, intent: 'greet' });
      const plan2 = planner.plan({ emotion: 'neutral', speaking: true });
      expect(plan1.intent).toBe('greet');
      expect(plan2.intent).toBe('');
    });
  });

  describe('intensity', () => {
    it('intensity 在 [0, 1] 范围内', () => {
      const planner = new PerformancePlanner();
      for (const emotion of ['neutral', 'happy', 'angry', 'sad', 'surprised', 'concerned']) {
        const plan = planner.plan({ emotion, speaking: true });
        expect(plan.intensity).toBeGreaterThanOrEqual(0);
        expect(plan.intensity).toBeLessThanOrEqual(1);
      }
    });

    it('angry 的 intensity > neutral 的 intensity', () => {
      const planner = new PerformancePlanner();
      const angry = planner.plan({ emotion: 'angry', speaking: true });
      const neutral = planner.plan({ emotion: 'neutral', speaking: true });
      expect(angry.intensity).toBeGreaterThan(neutral.intensity);
    });

    it('happy 的 intensity > neutral 的 intensity', () => {
      const planner = new PerformancePlanner();
      const happy = planner.plan({ emotion: 'happy', speaking: true });
      const neutral = planner.plan({ emotion: 'neutral', speaking: true });
      expect(happy.intensity).toBeGreaterThan(neutral.intensity);
    });

    it('speaking 时 intensity > 0', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'neutral', speaking: true });
      expect(plan.intensity).toBeGreaterThan(0);
    });
  });

  describe('gaze', () => {
    it('happy → gaze=user', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'happy', speaking: true });
      expect(plan.gaze).toBe('user');
    });

    it('thinking → gaze=away', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'thinking', speaking: false });
      expect(plan.gaze).toBe('away');
    });

    it('sad → gaze=down', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'sad', speaking: true });
      expect(plan.gaze).toBe('down');
    });

    it('未知 emotion → gaze=user（默认）', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'unknown', speaking: true });
      expect(plan.gaze).toBe('user');
    });
  });

  describe('gestureFamily', () => {
    it('happy → gestureFamily 为 happy', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'happy', speaking: true });
      expect(plan.gestureFamily).toBe('happy');
    });

    it('angry → gestureFamily 为 angry', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'angry', speaking: true });
      expect(plan.gestureFamily).toBe('angry');
    });

    it('sad → gestureFamily 为 sad', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'sad', speaking: true });
      expect(plan.gestureFamily).toBe('sad');
    });

    it('neutral → gestureFamily 为 neutral', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'neutral', speaking: true });
      expect(plan.gestureFamily).toBe('neutral');
    });
  });

  describe('gestureFamily 和 speakingVmdPath（Phase 6：基于 VMD 情绪映射）', () => {
    it('automatic speech ignores entries that are not explicitly dialogue-safe', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([
        {
          vmdPath: 'motions/battle.vmd', displayName: 'battle', type: 'voice',
          gestureFamily: 'happy', intent: 'greeting', emotions: ['happy'], description: 'large motion',
          dialogueSafe: false
        },
        {
          vmdPath: 'motions/small-greeting.vmd', displayName: 'small greeting', type: 'voice',
          gestureFamily: 'happy', intent: 'greeting', emotions: ['happy'], description: 'daily motion',
          dialogueSafe: true
        }
      ]);

      const plan = planner.plan({
        emotion: 'happy', intent: 'greeting', speaking: true,
        enabledVmdPaths: ['motions/battle.vmd', 'motions/small-greeting.vmd']
      });

      expect(plan.speakingVmdPath).toBe('motions/small-greeting.vmd');
    });

    it('prefers starred dialogue-safe actions over unstarred semantic matches', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([
        {
          vmdPath: 'motions/unstarred.vmd', displayName: 'unstarred', type: 'voice',
          gestureFamily: 'happy', intent: 'greeting', emotions: ['happy'], description: 'daily',
          dialogueSafe: true
        },
        {
          vmdPath: 'motions/starred.vmd', displayName: 'starred', type: 'voice',
          gestureFamily: 'happy', intent: 'greeting', emotions: ['happy'], description: 'preferred',
          dialogueSafe: true, starred: true
        }
      ]);
      const plan = planner.plan({
        emotion: 'happy', intent: 'greeting', speaking: true,
        enabledVmdPaths: ['motions/unstarred.vmd', 'motions/starred.vmd']
      });
      expect(plan.speakingVmdPath).toBe('motions/starred.vmd');
    });

    it('treats starred as a preference instead of permanently hiding other enabled daily actions', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([
        {
          vmdPath: 'motions/starred.vmd', displayName: 'starred', type: 'voice',
          gestureFamily: 'explaining', intent: 'explaining', emotions: ['neutral'], description: 'preferred',
          dialogueSafe: true, starred: true
        },
        {
          vmdPath: 'motions/daily.vmd', displayName: 'daily', type: 'voice',
          gestureFamily: 'explaining', intent: 'explaining', emotions: ['neutral'], description: 'daily',
          dialogueSafe: true
        }
      ]);

      const selected = Array.from({ length: 4 }, () => planner.plan({
        emotion: 'neutral', intent: 'explaining', speaking: true,
        enabledVmdPaths: ['motions/starred.vmd', 'motions/daily.vmd']
      }).speakingVmdPath);

      expect(selected[0]).toBe('motions/starred.vmd');
      expect(new Set(selected)).toEqual(new Set(['motions/starred.vmd', 'motions/daily.vmd']));
    });

    it('admits type=voice entries and rotates context-matching general daily actions with exact intent actions', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([
        {
          vmdPath: 'motions/explain.vmd', displayName: 'explain', type: 'voice',
          gestureFamily: 'explaining', intent: 'explaining', emotions: ['neutral'], description: 'exact',
          dialogueSafe: true
        },
        {
          vmdPath: 'motions/daily-thinking-b.vmd', displayName: 'daily B', type: 'voice',
          gestureFamily: 'general', intent: 'general', emotions: ['neutral', 'thinking'], description: 'daily',
          dialogueSafe: true
        },
        {
          vmdPath: 'motions/daily-thinking-c.vmd', displayName: 'daily C', type: 'voice',
          gestureFamily: 'general', intent: 'general', emotions: ['neutral', 'worried'], description: 'daily',
          dialogueSafe: true
        }
      ]);

      const selected = Array.from({ length: 6 }, () => planner.plan({
        emotion: 'neutral', intent: 'explaining', gestureFamily: 'explaining', speaking: true,
        enabledVmdPaths: [
          'motions/explain.vmd',
          'motions/daily-thinking-b.vmd',
          'motions/daily-thinking-c.vmd'
        ]
      }).speakingVmdPath);

      expect(new Set(selected)).toEqual(new Set([
        'motions/explain.vmd',
        'motions/daily-thinking-b.vmd',
        'motions/daily-thinking-c.vmd'
      ]));
    });

    it.each([
      ['thinking', 'think'],
      ['concerned', 'worry'],
      ['explaining', 'explain']
    ])('matches canonical intent alias %s to stored %s', (requestedIntent, storedIntent) => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([{
        vmdPath: `motions/${storedIntent}.vmd`, displayName: storedIntent, type: 'voice',
        gestureFamily: 'other', intent: storedIntent, emotions: ['other'], description: '',
        dialogueSafe: true
      }]);

      expect(planner.plan({
        emotion: 'neutral', intent: requestedIntent, speaking: true,
        enabledVmdPaths: [`motions/${storedIntent}.vmd`]
      }).speakingVmdPath).toBe(`motions/${storedIntent}.vmd`);
    });

    it('falls through to another safe candidate when the starred match is excluded', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([
        {
          vmdPath: 'motions/starred.vmd', displayName: 'starred', type: 'voice',
          gestureFamily: 'thinking', intent: 'think', emotions: ['thinking'], description: '',
          dialogueSafe: true, starred: true
        },
        {
          vmdPath: 'motions/fallback.vmd', displayName: 'fallback', type: 'voice',
          gestureFamily: 'thinking', intent: 'think', emotions: ['thinking'], description: '',
          dialogueSafe: true
        }
      ]);

      expect(planner.plan({
        emotion: 'thinking', intent: 'thinking', speaking: true,
        enabledVmdPaths: ['motions/starred.vmd', 'motions/fallback.vmd'],
        excludedVmdPaths: ['motions/starred.vmd']
      }).speakingVmdPath).toBe('motions/fallback.vmd');
    });

    it('uses another daily voice action when all exact semantic actions are recent', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([
        {
          vmdPath: 'motions/exact.vmd', displayName: 'exact', type: 'voice',
          gestureFamily: 'explaining', intent: 'explaining', emotions: ['neutral'], description: '',
          dialogueSafe: true
        },
        {
          vmdPath: 'motions/daily.vmd', displayName: 'daily', type: 'voice',
          gestureFamily: 'general', intent: 'general', emotions: ['shy'], description: '',
          dialogueSafe: true
        }
      ]);

      const plan = planner.plan({
        emotion: 'neutral', intent: 'explaining', gestureFamily: 'explaining', speaking: true,
        enabledVmdPaths: ['motions/exact.vmd', 'motions/daily.vmd'],
        excludedVmdPaths: ['motions/exact.vmd']
      });

      expect(plan.speakingVmdPath).toBe('motions/daily.vmd');
      expect(plan.speakingVmdMatch?.level).toBe('daily');
    });

    it('reuses the only enabled semantic action instead of returning no motion', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([{
        vmdPath: 'motions/only.vmd', displayName: 'only', type: 'voice',
        gestureFamily: 'explaining', intent: 'explaining', emotions: ['neutral'], description: '',
        dialogueSafe: true
      }]);

      expect(planner.plan({
        emotion: 'neutral', intent: 'explaining', speaking: true,
        enabledVmdPaths: ['motions/only.vmd'],
        excludedVmdPaths: ['motions/only.vmd']
      }).speakingVmdPath).toBe('motions/only.vmd');
    });

    it('does not auto-play an unsafe or non-voice catalog entry', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([
        {
          vmdPath: 'motions/applause.vmd', displayName: 'applause', type: 'gesture',
          gestureFamily: 'happy', intent: 'greeting', emotions: ['happy'], description: 'gesture only',
          dialogueSafe: true
        },
        {
          vmdPath: 'motions/unsafe-voice.vmd', displayName: 'unsafe voice', type: 'voice',
          gestureFamily: 'happy', intent: 'greeting', emotions: ['happy'], description: 'manual only',
          dialogueSafe: false
        }
      ]);

      const plan = planner.plan({
        emotion: 'happy', intent: 'greeting', speaking: true,
        enabledVmdPaths: ['motions/applause.vmd', 'motions/unsafe-voice.vmd']
      });

      expect(plan.speakingVmdPath).toBeUndefined();
      expect(plan.voiceActionSelectionReason).toBe('voice-pool-empty');
    });

    it('accepts shared and model-local aliases for the same motions file', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([{
        vmdPath: '../shared/motions/explain.vmd', displayName: 'explain', type: 'voice',
        gestureFamily: 'explaining', intent: 'explaining', emotions: ['serious'], description: '',
        dialogueSafe: true
      }]);

      expect(planner.plan({
        emotion: 'serious', intent: 'explaining', speaking: true,
        enabledVmdPaths: ['motions/explain.vmd']
      }).speakingVmdPath).toBe('../shared/motions/explain.vmd');
    });

    it('maps strong emotion aliases to the compatible shared action family', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([{
        vmdPath: 'motions/surprise.vmd', displayName: 'surprise', type: 'voice',
        gestureFamily: 'surprised', intent: 'react', emotions: ['surprised'], description: '',
        dialogueSafe: true
      }]);
      const plan = planner.plan({
        emotion: 'shocked', intent: 'surprised', speaking: true,
        enabledVmdPaths: ['motions/surprise.vmd']
      });
      expect(plan.gestureFamily).toBe('surprised');
      expect(plan.speakingVmdPath).toBe('motions/surprise.vmd');
    });

    it('ranks an exact intent above a generic daily action while retaining rotation', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([
        {
          vmdPath: 'motions/generic.vmd', displayName: 'generic', type: 'voice',
          gestureFamily: 'general', intent: 'general', emotions: ['happy'], description: '',
          dialogueSafe: true, starred: true
        },
        {
          vmdPath: 'motions/exact.vmd', displayName: 'exact', type: 'voice',
          gestureFamily: 'happy', intent: 'greeting', emotions: ['happy'], description: '',
          dialogueSafe: true
        }
      ]);
      const first = planner.plan({
        emotion: 'happy', intent: 'greeting', speaking: true,
        enabledVmdPaths: ['motions/generic.vmd', 'motions/exact.vmd']
      });
      expect(first.speakingVmdPath).toBe('motions/exact.vmd');
      expect(first.speakingVmdMatch?.level).toBe('intent');
    });

    it('keeps a starred but disabled voice action outside automatic selection', () => {
      const planner = new PerformancePlanner();
      planner.updateVmdEmotionMap([
        {
          vmdPath: 'motions/safe.vmd', displayName: 'safe', type: 'voice',
          gestureFamily: 'happy', intent: 'greeting', emotions: ['happy'], description: '',
          dialogueSafe: true
        },
        {
          vmdPath: 'motions/selected.vmd', displayName: 'selected', type: 'voice',
          gestureFamily: 'happy', intent: 'greeting', emotions: ['happy'], description: '',
          dialogueSafe: false, starred: true
        }
      ]);

      expect(planner.plan({
        emotion: 'happy', intent: 'greeting', speaking: true,
        enabledVmdPaths: ['motions/safe.vmd', 'motions/selected.vmd']
      }).speakingVmdPath).toBe('motions/safe.vmd');
    });

    it('state=idle → speakingVmdPath 为 undefined', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'neutral', speaking: false });
      expect(plan.state).toBe('idle');
      expect(plan.speakingVmdPath).toBeUndefined();
    });

    it('state=speaking 但无 vmdEmotionMap 且无可用的 fallback → speakingVmdPath 为 undefined', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'neutral', speaking: true, enabledVmdPaths: [] });
      expect(plan.state).toBe('speaking');
      expect(plan.speakingVmdPath).toBeUndefined();
    });

    it('state=listening → speakingVmdPath 为 undefined', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'listening', speaking: false });
      expect(plan.state).toBe('listening');
      expect(plan.speakingVmdPath).toBeUndefined();
    });

    it('state=thinking → speakingVmdPath 为 undefined', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'thinking', speaking: false });
      expect(plan.state).toBe('thinking');
      expect(plan.speakingVmdPath).toBeUndefined();
    });

    it('neutral idle → gestureFamily 为 neutral', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'neutral', speaking: false });
      expect(plan.gestureFamily).toBe('neutral');
    });

    it('curious idle → gestureFamily 为 curious', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'curious', speaking: false });
      expect(plan.gestureFamily).toBe('curious');
    });
  });

  describe('PerformancePlan 接口完整性', () => {
    it('包含所有必需字段', () => {
      const planner = new PerformancePlanner();
      const plan = planner.plan({ emotion: 'happy', speaking: true, intent: 'greet' });
      expect(plan).toHaveProperty('state');
      expect(plan).toHaveProperty('emotion');
      expect(plan).toHaveProperty('intent');
      expect(plan).toHaveProperty('intensity');
      expect(plan).toHaveProperty('gaze');
      expect(plan).toHaveProperty('gestureFamily');
      // Phase 6: speakingVmdPath 替代 motionPackId
      expect(plan).toHaveProperty('speakingVmdPath');
    });
  });
});
