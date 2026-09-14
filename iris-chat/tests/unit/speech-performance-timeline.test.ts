import { describe, expect, it } from 'vitest';
import {
  buildSpeechPerformanceTimeline,
  buildSpeechPlannerExclusions,
  coordinateSpeechMotionSemantic,
  resolveSpeechGazeSemantic,
  selectSpeechBackgroundVmd,
  shouldDispatchSpeechGesture,
  shouldUseSpeechBackgroundForCue,
  shouldDeferSpeechGestureForCurrentClip,
  shouldDeferSpeechGestureForCurrentOwner,
  isCalmSpeechCue,
  shouldRestoreSpeechBackground,
  SpeechCueDispatchState
} from '../../src/performance/speech-performance-timeline';
import type { PerformanceSemantic } from '../../src/performance/semantic-performance';

const neutralBase: PerformanceSemantic = {
  emotion: 'serious', intent: 'explaining', intensity: 0.5, gaze: 'user'
};

describe('buildSpeechPerformanceTimeline', () => {
  it('uses the personality-refined face as the shared gaze and body semantic', () => {
    const cue = {
      ...neutralBase,
      index: 0,
      text: '我有些担心。',
      startSeconds: 0,
      endSeconds: 3,
      gestureEligible: false,
      isOpening: true,
      isClosing: true,
      facialEmotion: 'concerned'
    } as const;

    expect(resolveSpeechGazeSemantic(cue)).toBe('concerned');
    expect(coordinateSpeechMotionSemantic(cue, cue.facialEmotion)).toEqual({
      emotion: 'neutral',
      intent: 'explaining',
      gestureFamily: 'explaining'
    });
  });

  it('keeps the reported night-comfort reply on complete daily-action beats', () => {
    const text = '指挥，夜深了，你还没休息吗？我有些担心……（轻轻走到窗边）若觉得孤单或难以入眠，不妨听听我的歌声。我愿为你奏一曲安眠的乐章，伴你度过这漫长的黑夜。';
    const cues = buildSpeechPerformanceTimeline(
      text,
      21.58746875,
      { emotion: 'concerned', intent: 'concerned', intensity: 0.55, gaze: 'side-down' },
      { semanticBeatSeconds: 3.5, gestureGapSeconds: 3, maxMajorEmotionTransitions: 3 }
    );

    expect(cues.some(cue => cue.text === '指挥，')).toBe(false);
    expect(cues[0].text).toContain('你还没休息吗？');
    const coordinated = cues
      .filter(cue => shouldDispatchSpeechGesture(cue, 1))
      .map(cue => coordinateSpeechMotionSemantic(cue, cue.facialEmotion));
    expect(coordinated.length).toBeGreaterThan(0);
    expect(coordinated.every(value => value.intent === 'explaining'
      && !['concerned', 'sad'].includes(value.emotion))).toBe(true);
  });

  it('does not interrupt a selected voice action before its authored final frame', () => {
    expect(shouldDeferSpeechGestureForCurrentClip({
      motionPlaying: true,
      currentPackId: 'speech-cue:0:daily-explain.vmd',
      state: 'playing',
      currentAnimationTime: 2.1,
      animationDuration: 3.6
    })).toBe(true);
    expect(shouldDeferSpeechGestureForCurrentClip({
      motionPlaying: true,
      currentPackId: 'speech-cue:0:daily-explain.vmd',
      state: 'playing',
      currentAnimationTime: 3.6,
      animationDuration: 3.6
    })).toBe(false);
    expect(shouldDeferSpeechGestureForCurrentClip({
      motionPlaying: true,
      currentPackId: 'speech-background:user-idle.vmd',
      state: 'playing',
      currentAnimationTime: 1,
      animationDuration: 20
    })).toBe(false);
  });

  it('allows a validated emotion turn to hand off after the opening pose settles', () => {
    expect(shouldDeferSpeechGestureForCurrentClip({
      motionPlaying: true,
      currentPackId: 'speech-cue:0:daily-comfort.vmd',
      state: 'playing',
      currentAnimationTime: 1.35,
      animationDuration: 3.6,
      emotionTurn: true
    })).toBe(false);
    expect(shouldDeferSpeechGestureForCurrentClip({
      motionPlaying: true,
      currentPackId: 'speech-cue:0:daily-comfort.vmd',
      state: 'fading-in',
      currentAnimationTime: 0.4,
      animationDuration: 3.6,
      emotionTurn: true
    })).toBe(true);
    expect(shouldDeferSpeechGestureForCurrentClip({
      motionPlaying: true,
      currentPackId: 'speech-cue:0:daily-comfort.vmd',
      state: 'bridging',
      currentAnimationTime: 1.1,
      animationDuration: 1.3,
      emotionTurn: true
    })).toBe(false);
  });

  it('lets a new reply replace an old reply cue while preserving same-reply completion', () => {
    const clip = {
      motionPlaying: true,
      currentPackId: 'speech-cue:0:daily-explain.vmd',
      state: 'bridging',
      currentAnimationTime: 0.1,
      animationDuration: 3.6
    };

    expect(shouldDeferSpeechGestureForCurrentOwner({
      ...clip,
      ownerGeneration: 4,
      requestedGeneration: 4
    })).toBe(true);
    expect(shouldDeferSpeechGestureForCurrentOwner({
      ...clip,
      ownerGeneration: 3,
      requestedGeneration: 4
    })).toBe(false);
  });

  it('dispatches each cue once and only reuses a motion after its cooldown', () => {
    const state = new SpeechCueDispatchState();
    const cues = buildSpeechPerformanceTimeline('第一部分说明。第二部分欢迎你。', 10, neutralBase);

    expect(state.enter(cues[0])).toBe(true);
    expect(state.enter(cues[0])).toBe(false);
    expect(state.claimMotion('explain.vmd', 0, 10)).toBe(true);
    expect(state.enter(cues[1])).toBe(true);
    expect(state.claimMotion('explain.vmd', 5, 10)).toBe(false);
    expect(state.claimMotion('explain.vmd', 10, 10)).toBe(true);
    state.reset();
    expect(state.enter(cues[0])).toBe(true);
    expect(state.claimMotion('explain.vmd', 0, 10)).toBe(true);
  });

  it('enforces a short global handoff gap between different speech actions', () => {
    const state = new SpeechCueDispatchState();
    expect(state.claimMotion('first.vmd', 0, 0)).toBe(true);
    expect(state.claimMotion('second.vmd', 0.1, 0)).toBe(false);
    expect(state.claimMotion('second.vmd', 0.24, 0)).toBe(false);
    expect(state.claimMotion('second.vmd', 0.32, 0)).toBe(true);
  });

  it('releases a cue when its first attempt is deferred so the transition is retried', () => {
    const state = new SpeechCueDispatchState();
    const cues = buildSpeechPerformanceTimeline('第一段。第二段。', 8, neutralBase);
    expect(state.enter(cues[0])).toBe(true);
    expect(state.enter(cues[0])).toBe(false);
    state.release(cues[0]);
    expect(state.enter(cues[0])).toBe(true);
  });
  it('derives multiple expression and gaze cues inside one Chinese reply', () => {
    const cues = buildSpeechPerformanceTimeline(
      '太好了，我很开心！让我想一想。这个问题确实让人担心，不过欢迎你来试试。',
      16,
      neutralBase
    );

    expect(cues.length).toBeGreaterThanOrEqual(4);
    expect(cues.some(cue => cue.emotion === 'happy')).toBe(true);
    expect(cues.some(cue => cue.emotion === 'thinking' && cue.gaze === 'side-down')).toBe(true);
    expect(cues.some(cue => cue.emotion === 'concerned' && cue.gaze === 'side-down')).toBe(true);
    expect(cues.some(cue => cue.intent === 'inviting' && cue.gaze === 'user')).toBe(true);
    expect(cues.filter(cue => cue.emotionTurn).length).toBeGreaterThanOrEqual(3);
    expect(cues.filter(cue => cue.gestureEligible && !cue.isOpening)
      .every(cue => cue.emotionTurn)).toBe(true);
  });

  it('uses validated model phrase segments before keyword heuristics', () => {
    const text = '这件事确实不容易。可是我会陪你把下一步做好。';
    const cues = buildSpeechPerformanceTimeline(text, 8, {
      emotion: 'gentle',
      intent: 'explaining',
      intensity: 0.42,
      gaze: 'user',
      source: 'model',
      segments: [
        {
          text: '这件事确实不容易。', voiceEmotion: 'sad', emotion: 'concerned',
          intent: 'concerned', intensity: 0.45, gaze: 'side-down', confidence: 0.65
        },
        {
          text: '可是我会陪你把下一步做好。', voiceEmotion: 'strong', emotion: 'confident',
          intent: 'encouraging', intensity: 0.58, gaze: 'user', confidence: 0.65
        }
      ]
    });

    expect(cues.some(cue => cue.text.includes('确实不容易') && cue.emotion === 'concerned')).toBe(true);
    expect(cues.some(cue => cue.text.includes('下一步做好') && cue.emotion === 'confident')).toBe(true);
    expect(cues.some(cue => cue.emotionTurn)).toBe(true);
  });

  it('keeps repeated same-emotion beats expressive without extra body actions', () => {
    const cues = buildSpeechPerformanceTimeline(
      '我会慢慢为你说明这件事，并把每个细节讲清楚。',
      18,
      neutralBase
    );

    expect(cues.length).toBeGreaterThan(3);
    expect(cues.filter(cue => cue.gestureEligible)).toHaveLength(1);
    expect(cues.slice(1).every(cue => cue.emotionTurn === false)).toBe(true);
  });

  it('distributes a medium-length cached voice action into the latter half', () => {
    const cues = buildSpeechPerformanceTimeline(
      '我会把这件事完整说明清楚，并陪你一步一步确认后续安排。',
      15,
      neutralBase
    );
    const gestureStarts = cues.filter(cue => cue.gestureEligible).map(cue => cue.startSeconds);

    expect(gestureStarts.length).toBeGreaterThanOrEqual(2);
    expect(gestureStarts[1]).toBeGreaterThanOrEqual(15 / 3);
    expect(gestureStarts[1]).toBeLessThan(15 * 0.85);
  });

  it('keeps the long cached dialogue eligible beyond its opening paragraph', () => {
    const cues = buildSpeechPerformanceTimeline(
      '指挥，这午后的阳光透过窗纱洒在琴键上，泛起一层柔和的金边。若你此刻正感到些许疲惫，不妨停下手中的工作。我为你弹奏一曲舒缓的旋律，让心绪随着音符轻轻漂浮吧。',
      25.6,
      neutralBase
    );
    const gestureStarts = cues.filter(cue => cue.gestureEligible).map(cue => cue.startSeconds);
    expect(gestureStarts.length).toBeGreaterThanOrEqual(2);
    expect(gestureStarts.at(-1)).toBeGreaterThan(25.6 * 0.5);
  });

  it('covers the complete audio duration with ordered non-overlapping cues', () => {
    const cues = buildSpeechPerformanceTimeline('第一句。第二句！第三句？', 9, neutralBase);

    expect(cues[0].startSeconds).toBe(0);
    expect(cues.at(-1)?.endSeconds).toBeCloseTo(9, 6);
    for (let index = 0; index < cues.length; index += 1) {
      expect(cues[index].endSeconds).toBeGreaterThan(cues[index].startSeconds);
      if (index > 0) expect(cues[index].startSeconds).toBeCloseTo(cues[index - 1].endSeconds, 6);
    }
  });

  it('inherits the base semantic for a segment without an explicit emotion signal', () => {
    const shyBase: PerformanceSemantic = {
      emotion: 'shy', intent: 'shy', intensity: 0.55, gaze: 'side-down'
    };

    const cues = buildSpeechPerformanceTimeline('这部分我会慢慢说清楚。', 4, shyBase);

    expect(cues).toHaveLength(3);
    expect(cues.every(cue => cue.emotion === 'shy'
      && cue.intent === 'shy'
      && cue.gaze === 'side-down')).toBe(true);
  });

  it('schedules the user voice-action pool for a normal short reply', () => {
    const cues = buildSpeechPerformanceTimeline('好的。', 1.2, neutralBase);

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({
      gestureEligible: true,
      isOpening: true,
      isClosing: true
    });
    expect(shouldDispatchSpeechGesture(cues[0], 1)).toBe(true);
  });

  it('keeps a sub-second valid voice reply eligible for a pool action', () => {
    const cues = buildSpeechPerformanceTimeline('好。', 0.8, neutralBase);

    expect(cues).toHaveLength(1);
    expect(cues[0].gestureEligible).toBe(true);
    expect(shouldDispatchSpeechGesture(cues[0], 1)).toBe(true);
  });

  it('provides one dispatchable interior Planner action for a five-second calm reply', () => {
    const cues = buildSpeechPerformanceTimeline(
      '我会把这件事温和地说明清楚。',
      5,
      { emotion: 'gentle', intent: 'explaining', intensity: 0.42, gaze: 'user' }
    );
    const dispatchable = cues.filter(cue => shouldDispatchSpeechGesture(cue, 2));

    expect(cues).toHaveLength(3);
    expect(cues[0].isOpening).toBe(true);
    expect(cues.at(-1)?.isClosing).toBe(true);
    expect(dispatchable).toHaveLength(1);
    expect(dispatchable[0]).toMatchObject({ isOpening: true, isClosing: false });
  });

  it('does not let a rejected strong-emotion opening consume the short-reply gesture gap', () => {
    const cues = buildSpeechPerformanceTimeline(
      '这件事真的太过分了，我不能接受！',
      5,
      { emotion: 'angry', intent: 'rejecting', intensity: 0.8, gaze: 'user' }
    );

    expect(cues.filter(cue => shouldDispatchSpeechGesture(cue, 2))).toHaveLength(1);
    expect(cues[0].gestureEligible).toBe(true);
    expect(cues.at(-1)?.gestureEligible).toBe(false);
  });

  it('provides separated Planner opportunities for a fifteen-second calm reply', () => {
    const cues = buildSpeechPerformanceTimeline(
      '我会先说明事情的背景，再把需要注意的部分慢慢讲清楚，最后陪你一起确认结果。',
      15,
      { emotion: 'gentle', intent: 'explaining', intensity: 0.45, gaze: 'user' }
    );
    const dispatchable = cues.filter(cue => shouldDispatchSpeechGesture(cue, 2));

    expect(cues.length).toBeGreaterThanOrEqual(5);
    expect(dispatchable.length).toBeGreaterThanOrEqual(2);
    expect(dispatchable[0].isOpening).toBe(true);
    expect(dispatchable[1].startSeconds - dispatchable[0].startSeconds).toBeGreaterThanOrEqual(4);
  });

  it('keeps gesture-eligible cue starts at least four seconds apart', () => {
    const cues = buildSpeechPerformanceTimeline(
      '首先我来说明这个部分。然后让我想一想。接下来有一点需要担心。最后欢迎你继续尝试。',
      24,
      neutralBase
    );
    const gestureStarts = cues.filter(cue => cue.gestureEligible).map(cue => cue.startSeconds);

    expect(gestureStarts.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < gestureStarts.length; index += 1) {
      expect(gestureStarts[index] - gestureStarts[index - 1]).toBeGreaterThanOrEqual(4);
    }
  });

  it('uses the selected compute budget for semantic beat density and gesture spacing', () => {
    const text = '首先说明这一部分的完整背景，然后继续解释它的影响，最后给出可以执行的建议。';
    const low = buildSpeechPerformanceTimeline(text, 24, neutralBase, {
      semanticBeatSeconds: 8,
      gestureGapSeconds: 7,
      maxMajorEmotionTransitions: 1
    });
    const ultra = buildSpeechPerformanceTimeline(text, 24, neutralBase, {
      semanticBeatSeconds: 3.5,
      gestureGapSeconds: 3,
      maxMajorEmotionTransitions: 4
    });

    expect(ultra.length).toBeGreaterThan(low.length);
    const lowStarts = low.filter(cue => cue.gestureEligible).map(cue => cue.startSeconds);
    for (let index = 1; index < lowStarts.length; index += 1) {
    expect(lowStarts[index] - lowStarts[index - 1]).toBeGreaterThanOrEqual(6.5);
    }
  });

  it('keeps calm long-clause expression beats varied without rapid body actions', () => {
    const cues = buildSpeechPerformanceTimeline(
      '接下来我会把这个问题完整说明清楚并逐步讲解每一个关键细节以及它们之间的关系。',
      26,
      neutralBase
    );
    const gestureStarts = cues.filter(cue => cue.gestureEligible).map(cue => cue.startSeconds);

    expect(cues.length).toBeGreaterThanOrEqual(4);
    expect(gestureStarts.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < gestureStarts.length; index += 1) {
      expect(gestureStarts[index] - gestureStarts[index - 1]).toBeLessThanOrEqual(10);
    }
  });

  it('adds a restrained voice-action change before ten seconds of continuous speech', () => {
    const cues = buildSpeechPerformanceTimeline(
      '接下来我会把这个问题完整说明清楚并逐步讲解每一个关键细节以及它们之间的关系。',
      21,
      neutralBase
    );
    const gestureStarts = cues.filter(cue => cue.gestureEligible).map(cue => cue.startSeconds);

    expect(gestureStarts.length).toBeGreaterThanOrEqual(2);
    expect(gestureStarts[1] - gestureStarts[0]).toBeLessThanOrEqual(10);
  });

  it('splits a long final semantic segment while reserving only its last beat for idle', () => {
    const cues = buildSpeechPerformanceTimeline(
      '先说明背景。接下来我会把这个问题的原因和影响以及处理步骤和后续注意事项完整讲清楚让你可以按顺序慢慢理解并确认每一个细节。',
      24,
      neutralBase,
      { semanticBeatSeconds: 6, gestureGapSeconds: 4 }
    );
    const finalSegmentCues = cues.filter(cue => cue.text.includes('接下来我会把'));
    expect(finalSegmentCues.length).toBeGreaterThanOrEqual(2);
    expect(finalSegmentCues.at(-1)?.isClosing).toBe(true);
    expect(finalSegmentCues.at(-2)?.isClosing).toBe(false);
    expect(finalSegmentCues.at(-2)!.startSeconds - cues[0].startSeconds)
      .toBeGreaterThanOrEqual(4);
  });

  it('does not turn a gentle reply into curious body motion for punctuation alone', () => {
    const cues = buildSpeechPerformanceTimeline(
      '窗外很安静。你此刻是在忙些什么呢？若得闲，不妨听听这首轻柔的曲子。',
      18,
      { emotion: 'gentle', intent: 'explaining', intensity: 0.5, gaze: 'user' }
    );
    expect(cues.every(cue => cue.emotion === 'gentle')).toBe(true);
    expect(cues.filter(cue => shouldDispatchSpeechGesture(cue, 2))).toHaveLength(1);
  });

  it('selects the reviewed dialogue background and restores it only during speech gaps', () => {
    const paths = [
      'motions/preview-conversation/preview-stand.vmd',
      'motions/preview-conversation/preview-stand2.vmd'
    ];

    expect(selectSpeechBackgroundVmd(paths, 0)).toBe(paths[1]);
    expect(selectSpeechBackgroundVmd(paths, 1)).toBe(paths[0]);
    expect(shouldRestoreSpeechBackground({ speechActive: false, motionPlaying: false, currentPackId: null, requestInFlight: false })).toBe(false);
    expect(shouldRestoreSpeechBackground({ speechActive: true, motionPlaying: true, currentPackId: 'idle-default', requestInFlight: false })).toBe(true);
    expect(shouldRestoreSpeechBackground({ speechActive: true, motionPlaying: true, currentPackId: 'speech-background:stand', requestInFlight: false })).toBe(false);
    expect(shouldRestoreSpeechBackground({ speechActive: true, motionPlaying: false, currentPackId: null, requestInFlight: true })).toBe(false);
    expect(shouldRestoreSpeechBackground({ speechActive: true, motionPlaying: false, currentPackId: null, requestInFlight: false })).toBe(true);
  });

  it('prefers a starred neutral dialogue-safe action as the speech background', () => {
    const paths = [
      'motions/preview-conversation/preview-stand.vmd',
      '../shared/motions/待机 女性的.vmd'
    ];
    expect(selectSpeechBackgroundVmd(paths, 0, [
      {
        vmdPath: paths[0], displayName: 'legacy stand', type: 'gesture',
        gestureFamily: 'neutral', intent: 'explaining', emotions: ['neutral'], description: '',
        dialogueSafe: true
      },
      {
        vmdPath: paths[1], displayName: 'preferred stand', type: 'gesture',
        gestureFamily: 'neutral', intent: 'explaining', emotions: ['neutral', 'gentle'], description: '',
        dialogueSafe: true, starred: true
      }
    ])).toBe(paths[1]);
  });

  it('uses the user-selected default idle before any legacy neutral speech background', () => {
    const paths = [
      'motions/preview-conversation/preview-stand.vmd',
      '../shared/motions/待机 女性的.vmd'
    ];
    expect(selectSpeechBackgroundVmd(paths, 0, [], paths[1])).toBe(paths[1]);
  });

  it('temporarily excludes the visible background without adding it to recent accent history', () => {
    const recentAccentHistory = ['motions/recent-nod.vmd'];

    expect(buildSpeechPlannerExclusions(
      recentAccentHistory,
      'motions/user-default-idle.vmd'
    )).toEqual([
      'motions/recent-nod.vmd',
      'motions/user-default-idle.vmd'
    ]);
    expect(recentAccentHistory).toEqual(['motions/recent-nod.vmd']);
  });

  it('never suppresses an eligible voice-pool gesture because of reply parity', () => {
    const genericCue = { index: 0, intent: 'explaining', gestureEligible: true };
    expect(shouldDispatchSpeechGesture(genericCue, 1)).toBe(true);
    expect(shouldDispatchSpeechGesture(genericCue, 2)).toBe(true);
    expect(shouldDispatchSpeechGesture({ ...genericCue, intent: 'gratitude' }, 1)).toBe(true);
    expect(shouldDispatchSpeechGesture({ ...genericCue, gestureEligible: false }, 2)).toBe(false);
  });

  it('allows a closing-only reply to use one action when no action was admitted yet', () => {
    const closing = {
      index: 0,
      intent: 'explaining',
      gestureEligible: true,
      isOpening: false,
      isClosing: true,
      emotionTurn: false
    };
    expect(shouldDispatchSpeechGesture(closing, 1)).toBe(false);
    expect(shouldDispatchSpeechGesture(closing, 1, true)).toBe(true);
  });

  it('allows the selected voice action at a calm opening and returns to background at closing', () => {
    const cues = buildSpeechPerformanceTimeline(
      '夜深了，你还没休息吗？我会温柔地陪着你。愿你安心入眠。',
      14,
      { emotion: 'gentle', intent: 'explaining', intensity: 0.42, gaze: 'user' }
    );

    expect(cues[0].isOpening).toBe(true);
    expect(cues.at(-1)?.isClosing).toBe(true);
    expect(isCalmSpeechCue(cues[0])).toBe(true);
    expect(shouldDispatchSpeechGesture(cues[0], 2)).toBe(true);
    expect(shouldUseSpeechBackgroundForCue(cues[0])).toBe(false);
    expect(shouldDispatchSpeechGesture(cues.at(-1)!, 2)).toBe(false);
    expect(shouldUseSpeechBackgroundForCue(cues.at(-1)!)).toBe(true);
  });

  it('uses one restrained opening action and keeps the closing on standing', () => {
    const cues = buildSpeechPerformanceTimeline(
      '夜色很安静。慢慢休息就好。我会一直陪着你。',
      11,
      { emotion: 'gentle', intent: 'explaining', intensity: 0.38, gaze: 'user' }
    );

    expect(cues.filter(cue => shouldDispatchSpeechGesture(cue, 3))).toHaveLength(1);
    expect(shouldDispatchSpeechGesture(cues[0], 3)).toBe(true);
    expect(shouldDispatchSpeechGesture(cues.at(-1)!, 3)).toBe(false);
  });

  it('keeps a closing semantic turn eligible for a second voice-pool action', () => {
    const cues = buildSpeechPerformanceTimeline(
      '这件事让我有些担心。可是我会陪你一起想办法。',
      8,
      { emotion: 'concerned', intent: 'concerned', intensity: 0.5, gaze: 'side-down' },
      { semanticBeatSeconds: 4, gestureGapSeconds: 2.5 }
    );
    const closing = cues.at(-1)!;
    expect(closing.isClosing).toBe(true);
    expect(closing.emotionTurn).toBe(true);
    expect(closing.gestureEligible).toBe(true);
    expect(shouldDispatchSpeechGesture(closing, 1)).toBe(true);
    expect(shouldUseSpeechBackgroundForCue(closing)).toBe(false);
  });

  it('does not let the normal four-second cadence swallow a short two-sentence turn', () => {
    const text = '这件事让我有些担心。可是我会陪你一起想办法。';
    const cues = buildSpeechPerformanceTimeline(text, 6, {
      emotion: 'concerned',
      intent: 'concerned',
      intensity: 0.5,
      gaze: 'side-down',
      source: 'model',
      segments: [
        {
          text: '这件事让我有些担心。', voiceEmotion: 'sad', emotion: 'concerned',
          intent: 'concerned', intensity: 0.48, gaze: 'side-down', confidence: 0.9
        },
        {
          text: '可是我会陪你一起想办法。', voiceEmotion: 'comfort', emotion: 'gentle',
          intent: 'reassuring', intensity: 0.55, gaze: 'user', confidence: 0.9
        }
      ]
    });
    const turn = cues.find(cue => cue.emotionTurn)!;

    expect(turn.startSeconds).toBeLessThan(4);
    expect(turn.gestureEligible).toBe(true);
    expect(shouldDispatchSpeechGesture(turn, 1)).toBe(true);
  });

  it('preserves an explicit explaining intent for calm personality-refined faces', () => {
    const cue = buildSpeechPerformanceTimeline(
      '我会温柔地陪着你。',
      4,
      { emotion: 'concerned', intent: 'explaining', intensity: 0.5, gaze: 'user' }
    )[0];

    expect(coordinateSpeechMotionSemantic(cue, 'gentle')).toEqual({
      emotion: 'gentle',
      intent: 'explaining',
      gestureFamily: undefined
    });
    expect(coordinateSpeechMotionSemantic(cue, 'loving')).toEqual({
      emotion: 'loving',
      intent: 'explaining',
      gestureFamily: undefined
    });
  });

  it('keeps an intent-less calm cue on the neutral standing family', () => {
    expect(coordinateSpeechMotionSemantic({
      emotion: 'neutral', intent: '', intensity: 0.4
    }, 'gentle')).toEqual({
      emotion: 'neutral',
      intent: '',
      gestureFamily: 'neutral'
    });
  });

  it('keeps strong facial emotion and explicit gesture intent aligned', () => {
    const cue = buildSpeechPerformanceTimeline(
      '这件事真的让我很生气！',
      4,
      { emotion: 'angry', intent: 'rejecting', intensity: 0.7, gaze: 'user' }
    )[0];

    expect(coordinateSpeechMotionSemantic(cue, 'angry')).toEqual({
      emotion: 'angry',
      intent: 'rejecting',
      gestureFamily: undefined
    });
  });

  it('allows a strong opening gesture but keeps a multi-cue closing on the selected default', () => {
    expect(shouldDispatchSpeechGesture({
      index: 0, intent: 'rejecting', emotion: 'angry', intensity: 0.8,
      gestureEligible: true, isOpening: true, isClosing: false
    }, 2)).toBe(true);
    expect(shouldDispatchSpeechGesture({
      index: 3, intent: 'surprised', emotion: 'surprised', intensity: 0.8,
      gestureEligible: true, isOpening: false, isClosing: true
    }, 2)).toBe(false);
  });

  it.each([
    ['delighted', 'happy'],
    ['shocked', 'surprised'],
    ['furious', 'angry'],
    ['heartbroken', 'sad'],
    ['skeptical', 'thinking'],
    ['embarrassed', 'shy']
  ])('maps exaggerated %s face to the existing %s motion family', (face, motionEmotion) => {
    const cue = buildSpeechPerformanceTimeline(
      '这是一句带有明显情绪的话。',
      4,
      { emotion: 'neutral', intent: 'explaining', intensity: 0.8, gaze: 'user' }
    )[0];

    expect(coordinateSpeechMotionSemantic(cue, face).emotion).toBe(motionEmotion);
  });
});
