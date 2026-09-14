import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CandidateCueId } from '../src/performance/candidate-review-performance';
import type { MotionRuntimeMode } from '../src/motion/motion-runtime-mode';
import { ExternalMotionCandidateStore } from './external-motion-candidate-store';

export interface CandidateReviewMotionDefinition {
  readonly cueId: CandidateCueId;
  readonly packId: string;
  readonly absolutePath: string;
  readonly sha256: string;
  readonly durationSeconds: number;
  readonly candidateTrackPolicy: 'dialogue-body-only';
  readonly looping: false;
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
}

export interface CandidateMotionPayload {
  readonly cueId: CandidateCueId;
  readonly bytes: Uint8Array;
  readonly durationSeconds: number;
  readonly candidateTrackPolicy: 'dialogue-body-only';
  readonly looping: false;
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
}

interface CandidateReviewMotionCatalogOptions {
  readonly mode: MotionRuntimeMode;
  readonly allowedRoots: readonly string[];
  readonly definitions: readonly CandidateReviewMotionDefinition[];
  readonly readFile?: (absolutePath: string) => Uint8Array;
  readonly warn?: (message: string) => void;
}

export function createCandidateReviewMotionDefinitions(
  projectRoot: string
): readonly CandidateReviewMotionDefinition[] {
  const easyDailyRoot = resolve(
    projectRoot,
    'temp',
    'motion-candidates',
    'bowlroll-143637',
    'extracted-cp932',
    'お手軽日常モーションセット'
  );
  const elecomuRoot = resolve(
    projectRoot,
    'temp',
    'motion-candidates',
    'bowlroll-37514',
    'extracted-cp932'
  );
  // 净化对话动作（2026-07-28）：真实模型试播后接入
  const sanitizedRoot = resolve(
    projectRoot,
    'models',
    'shared',
    'conversation-vmd-cn-sanitized'
  );
  const commonPolicy = {
    candidateTrackPolicy: 'dialogue-body-only' as const,
    looping: false as const,
    fadeInSeconds: 0.35,
    fadeOutSeconds: 0.55
  };

  return [
    // --- 旧版 bowlroll 候选（保留兼容） ---
    {
      cueId: 'disagree-small',
      packId: 'candidate-review-disagree-small',
      absolutePath: resolve(easyDailyRoot, 'いえいえ.vmd'),
      sha256: 'EFAC4ADDEE2E6118426867F8E6573BD4510508CDED6825A3684850CD902156F0',
      durationSeconds: 2.7,
      ...commonPolicy
    },
    {
      cueId: 'acknowledge-small',
      packId: 'candidate-review-acknowledge-small',
      absolutePath: resolve(easyDailyRoot, 'なるほど.vmd'),
      sha256: '372F8B475CB476BC9CF03DCEF36DBE049015DF1F1B7F9E6ECC51CB0DD65BE2E4',
      durationSeconds: 1.4,
      ...commonPolicy
    },
    {
      cueId: 'thinking-small',
      packId: 'candidate-review-thinking-small',
      absolutePath: resolve(easyDailyRoot, 'うーん.vmd'),
      sha256: '8ED4D4F0248CA685A6B3F968A17C7429DAD257AD946612B020ACAFA046E18FDD',
      durationSeconds: 1.567,
      ...commonPolicy
    },
    {
      cueId: 'realization-small',
      packId: 'candidate-review-realization-small',
      absolutePath: resolve(easyDailyRoot, 'そうだ.vmd'),
      sha256: '84FE33F8AD5AEE81930DC1692E57471A6B6D3743E99F54F1CF78E5F95C5B6B46',
      durationSeconds: 1.167,
      ...commonPolicy
    },
    {
      cueId: 'giggle-small',
      packId: 'candidate-review-giggle-small',
      absolutePath: resolve(easyDailyRoot, 'くすくす.vmd'),
      sha256: '208E3E0F1199EB4C6716CF5A7126AA07E954A314582AD1A401E3BBF49CE81C0F',
      durationSeconds: 2.2,
      ...commonPolicy
    },
    {
      cueId: 'shy-head-scratch',
      packId: 'candidate-review-shy-head-scratch',
      absolutePath: resolve(elecomuRoot, 'えへへへへ.vmd'),
      sha256: 'DF517D1BFC0F93C9C8C2822FC9F83562B38EFB9350125A657A7C050FE553C8DA',
      durationSeconds: 2.933,
      ...commonPolicy
    },

    // --- 净化对话动作（2026-07-28）：sanitized VMD，additive-from-base ---
    // 日常高频
    {
      cueId: 'thinking-deep',
      packId: 'candidate-review-thinking-deep',
      absolutePath: resolve(sanitizedRoot, '05_思考_双手思考后回正_5.3秒.vmd'),
      sha256: '5BFA1CED0645320AAD8AFB29D37F85E3F7CD855507C30900447C0054DF91C39E',
      durationSeconds: 5.267,
      ...commonPolicy
    },
    {
      cueId: 'shy-glance',
      packId: 'candidate-review-shy-glance',
      absolutePath: resolve(sanitizedRoot, '07_害羞_低头看左下后回正_6.9秒.vmd'),
      sha256: 'B2BD1D890D7658B105D3FF54D70DF6BCD6FD2197FF4B587CDCE119AA21A7A73B',
      durationSeconds: 6.5,
      ...commonPolicy
    },
    {
      cueId: 'inviting-gesture',
      packId: 'candidate-review-inviting-gesture',
      absolutePath: resolve(sanitizedRoot, '08_邀请_右手向前递出后回正_5.0秒.vmd'),
      sha256: '234FA649067AB69A762F9F7DB1C6C9A2FA69E3B3792B3EF4F6BA9E8165CEBDE9',
      durationSeconds: 5.567,
      ...commonPolicy
    },
    {
      cueId: 'thanks-sincere',
      packId: 'candidate-review-thanks-sincere',
      absolutePath: resolve(sanitizedRoot, '09_认真感谢_右手放胸口后回正_5.1秒.vmd'),
      sha256: '886EFF4FD26FB7B8E08786675EB07EBA7D7FCF67EEE8E488E27E6AE272A5DE65',
      durationSeconds: 5.133,
      ...commonPolicy
    },
    {
      cueId: 'explaining-gesture',
      packId: 'candidate-review-explaining-gesture',
      absolutePath: resolve(sanitizedRoot, '10_解释_右手轻摊一次后回正_3.6秒.vmd'),
      sha256: 'F61BFE6259DC38DA7A6372355DAA0AE1DA05FAF86ACCDFF008CA16DD95E5C7BA',
      durationSeconds: 4.233,
      ...commonPolicy
    },
    {
      cueId: 'explaining-emphasis',
      packId: 'candidate-review-explaining-emphasis',
      absolutePath: resolve(sanitizedRoot, '11_解释强调_左手轻摊两次后回正_4.0秒.vmd'),
      sha256: 'B8994CEFA7AF12D3E08C63750C94E00C7E1825A993CDA418E236159F7C5FF594',
      durationSeconds: 4.567,
      ...commonPolicy
    },
    {
      cueId: 'depressed-low',
      packId: 'candidate-review-depressed-low',
      absolutePath: resolve(sanitizedRoot, '06_低落_低头郁闷后回正_6.2秒.vmd'),
      sha256: '26C09225BF53ADD72B756BFB498319FBB20E7DC9B802CEB0A67D64D3E60D3603',
      durationSeconds: 6.767,
      ...commonPolicy
    },
    // 低频候选：惊讶/拒绝
    {
      cueId: 'surprised-gasp',
      packId: 'candidate-review-surprised-gasp',
      absolutePath: resolve(sanitizedRoot, '03_惊讶_双手握拳前倾后回正_4.3秒.vmd'),
      sha256: 'FFEDDDC1AF2AE618F3AA4F199BB02575562F6062A886F1125D58D8EF926E2C84',
      durationSeconds: 4.9,
      ...commonPolicy
    },
    {
      cueId: 'rejection-block',
      packId: 'candidate-review-rejection-block',
      absolutePath: resolve(sanitizedRoot, '04_拒绝_双手格挡后仰后回正_5.4秒.vmd'),
      sha256: '35DBD125EEBF5C37CF74FD7888183E74DA794BC659AA23F4AC0AF964C9F43946',
      durationSeconds: 5.233,
      ...commonPolicy
    }
  ];
}

export const CANDIDATE_REVIEW_MOTION_ENTRIES = createCandidateReviewMotionDefinitions(process.cwd());

export class CandidateReviewMotionCatalog {
  private readonly mode: MotionRuntimeMode;
  private readonly definitions: ReadonlyMap<CandidateCueId, CandidateReviewMotionDefinition>;
  private readonly store: ExternalMotionCandidateStore;
  private readonly readFile: (absolutePath: string) => Uint8Array;
  private readonly warn: (message: string) => void;
  private readonly warnedCueIds = new Set<CandidateCueId>();

  constructor(options: CandidateReviewMotionCatalogOptions) {
    this.mode = options.mode;
    this.definitions = new Map(options.definitions.map(definition => [definition.cueId, definition]));
    this.store = new ExternalMotionCandidateStore({ allowedRoots: options.allowedRoots });
    this.readFile = options.readFile ?? (absolutePath => new Uint8Array(readFileSync(absolutePath)));
    this.warn = options.warn ?? (message => console.warn(message));
  }

  async load(cueId: CandidateCueId): Promise<CandidateMotionPayload | null> {
    if (this.mode !== 'candidate-review') return null;
    const definition = this.definitions.get(cueId);
    if (!definition) return null;

    try {
      if (!this.store.has(definition.packId)) {
        const bytes = this.readFile(definition.absolutePath);
        await this.store.register({
          packId: definition.packId,
          absolutePath: definition.absolutePath,
          sha256: definition.sha256
        }, bytes);
      }
      return {
        cueId: definition.cueId,
        bytes: this.store.getBytes(definition.packId),
        durationSeconds: definition.durationSeconds,
        candidateTrackPolicy: definition.candidateTrackPolicy,
        looping: definition.looping,
        fadeInSeconds: definition.fadeInSeconds,
        fadeOutSeconds: definition.fadeOutSeconds
      };
    } catch (error) {
      if (!this.warnedCueIds.has(cueId)) {
        this.warnedCueIds.add(cueId);
        this.warn(`[candidate-review] ${cueId}: ${(error as Error).message}`);
      }
      return null;
    }
  }
}
