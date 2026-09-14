export type CandidateCueId =
  | 'disagree-small'
  | 'acknowledge-small'
  | 'thinking-small'
  | 'realization-small'
  | 'giggle-small'
  | 'shy-head-scratch'
  // 净化对话动作（2026-07-28）：真实模型试播后接入 candidate-review
  | 'thinking-deep'
  | 'shy-glance'
  | 'inviting-gesture'
  | 'thanks-sincere'
  | 'explaining-gesture'
  | 'explaining-emphasis'
  | 'depressed-low'
  | 'surprised-gasp'
  | 'rejection-block';

export type CandidateExpressionId =
  | 'concerned-soft'
  | 'gentle-smile'
  | 'thinking-serious'
  | 'surprised-to-happy'
  | 'warm-happy'
  | 'shy-side-down'
  | 'gentle-neutral'
  | 'depressed-soft'
  | 'inviting-warm'
  | 'grateful-warm';

export interface CandidatePerformanceInput {
  readonly text: string;
  readonly ttsEmotion?: string;
  readonly durationSeconds: number;
  readonly ttsReady: boolean;
  readonly muted?: boolean;
  readonly proactive?: boolean;
  readonly cancelled?: boolean;
  readonly stale?: boolean;
}

export interface CandidatePerformanceSelection {
  readonly cueId: CandidateCueId | null;
  readonly expressionId: CandidateExpressionId;
  readonly gaze: 'user' | 'side-down';
  readonly emotion: 'serious' | 'concerned' | 'smile' | 'thinking' | 'surprised' | 'happy' | 'shy' | 'sad' | 'grateful' | 'inviting';
  readonly intensity: number;
}

interface SemanticMatch {
  readonly cueId: CandidateCueId;
  readonly expressionId: CandidateExpressionId;
  readonly gaze: CandidatePerformanceSelection['gaze'];
  readonly emotion: CandidatePerformanceSelection['emotion'];
  readonly intensity: number;
}

function matchSemantic(text: string, ttsEmotion: string): SemanticMatch | null {
  // --- 净化对话动作（2026-07-28）：sanitized VMD，additive-from-base ---
  // 日常高频：思考、害羞、邀请、感谢、解释
  // 低频候选：惊讶、拒绝

  if (/(让我想想|让我想一想|想一想|想一下|思考|考虑|琢磨)/.test(text)) {
    return {
      cueId: 'thinking-deep', expressionId: 'thinking-serious', gaze: 'side-down',
      emotion: 'thinking', intensity: 0.55
    };
  }
  // Exact realization/disagreement intent must win before broad words such as
  // “不好意思”, “是这样的” or an emotion label can redirect the action.
  if (/(对了|我想到|想到了|忽然想到|突然想到|更合适的做法)/.test(text)) {
    return {
      cueId: 'realization-small', expressionId: 'surprised-to-happy', gaze: 'user',
      emotion: 'surprised', intensity: 0.65
    };
  }
  if (/(不是这样|不是这样的|换个思路|不太对|不赞同)/.test(text)) {
    return {
      cueId: 'disagree-small', expressionId: 'concerned-soft', gaze: 'user',
      emotion: 'concerned', intensity: 0.45
    };
  }
  if (/(不好意思|害羞|脸红|夸我|羞|难为情)/.test(text) || ttsEmotion === 'shy') {
    return {
      cueId: 'shy-glance', expressionId: 'shy-side-down', gaze: 'side-down',
      emotion: 'shy', intensity: 0.55
    };
  }
  if (/(邀请|欢迎|请进|请到|来吧|过来吧|这边请|一起(?:去|来|看|听|试试)|看看这个)/.test(text) || ttsEmotion === 'inviting') {
    return {
      cueId: 'inviting-gesture', expressionId: 'inviting-warm', gaze: 'user',
      emotion: 'inviting', intensity: 0.5
    };
  }
  if (/(谢谢|感谢|多谢|感恩|辛苦|感激|太感谢)/.test(text) || ttsEmotion === 'grateful') {
    return {
      cueId: 'thanks-sincere', expressionId: 'grateful-warm', gaze: 'user',
      emotion: 'grateful', intensity: 0.55
    };
  }
  if (/(解释|说明|是这样的|意思是|就是说|其实|因为|所以|比如|例如)/.test(text)) {
    return {
      cueId: 'explaining-gesture', expressionId: 'gentle-neutral', gaze: 'user',
      emotion: 'serious', intensity: 0.4
    };
  }
  if (/(重点|关键|重要|强调|注意|记住|核心)/.test(text)) {
    return {
      cueId: 'explaining-emphasis', expressionId: 'gentle-neutral', gaze: 'user',
      emotion: 'serious', intensity: 0.5
    };
  }
  if (/(难过|伤心|低落|郁闷|失望|遗憾|可惜)/.test(text) || ttsEmotion === 'sad') {
    return {
      cueId: 'depressed-low', expressionId: 'depressed-soft', gaze: 'side-down',
      emotion: 'sad', intensity: 0.45
    };
  }

  // --- 低频：惊讶/拒绝（仅强语义触发） ---
  // “什么” also appears in ordinary phrases such as “忙些什么呢”; only
  // explicit surprise wording may promote the body to a surprised gesture.
  if (/(天哪|不会吧|居然|竟然|惊讶|震惊|吓了一跳)/.test(text) || ttsEmotion === 'surprised') {
    return {
      cueId: 'surprised-gasp', expressionId: 'surprised-to-happy', gaze: 'user',
      emotion: 'surprised', intensity: 0.6
    };
  }
  if (/(不行|不要|拒绝|不可以|不能|没办法|不可能|算了)/.test(text) || ttsEmotion === 'rejecting') {
    return {
      cueId: 'rejection-block', expressionId: 'concerned-soft', gaze: 'user',
      emotion: 'concerned', intensity: 0.5
    };
  }

  // --- 旧版兜底（保留原有 bowlroll 匹配） ---
  if (/(原来如此|明白你的意思|我明白了|了解了|懂了)/.test(text)) {
    return {
      cueId: 'acknowledge-small', expressionId: 'gentle-smile', gaze: 'user',
      emotion: 'smile', intensity: 0.45
    };
  }
  if (/(做得很好|真棒|很开心|高兴|太好了|哈哈|呵呵|笑)/.test(text)) {
    return {
      cueId: 'giggle-small', expressionId: 'warm-happy', gaze: 'user',
      emotion: 'happy', intensity: 0.65
    };
  }
  return null;
}

export function selectCandidateReviewPerformance(
  input: CandidatePerformanceInput
): CandidatePerformanceSelection {
  const text = String(input.text ?? '').trim();
  const ttsEmotion = String(input.ttsEmotion ?? '').trim().toLowerCase();
  const match = matchSemantic(text, ttsEmotion);
  if (!match) {
    return {
      cueId: null,
      expressionId: 'gentle-neutral',
      gaze: 'user',
      emotion: 'serious',
      intensity: 0.3
    };
  }

  const gestureAllowed = input.ttsReady
    && Number.isFinite(input.durationSeconds)
    && input.durationSeconds >= 0.9
    && input.muted !== true
    && input.proactive !== true
    && input.cancelled !== true
    && input.stale !== true;

  return gestureAllowed ? match : { ...match, cueId: null };
}
