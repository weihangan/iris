// Phase 5.2B.3 Closeout Task 1：PerformanceProfile RED→GREEN
//
// 用户要求（docs/plans/phase-5.2b3-closeout-and-performance-foundation-plan.md Task 1）：
// - SHA 绑定的 PerformanceProfile 契约
// - validatePerformanceProfile(profile, actualSha256) 严格校验
// - 拒绝：哈希不匹配、非有限值、负幅度、speakingScale 越界、blink min>max、dwell min>max、
//   任何 relaxed-pose 分量绝对值 >= 0.3 rad
// - PerformanceProfile JSON 必须使用 PMX 真实 SHA-256
//
// 边界：
// - 不修改 PMX
// - 不接入 MotionPlayer
// - 不加入 whitelist
// - 只定义契约和校验器

import { describe, it, expect } from 'vitest';
import {
  validatePerformanceProfile,
  type PerformanceProfile,
  type ProceduralLifeProfile,
  type IdleDirectorProfile
} from '../../src/actor/performance-profile';
import type { RelaxedBasePoseOffsets } from '../../src/actor/relaxed-base-pose';

// 赛琳娜 PMX 的真实 SHA-256（来自 avatar-manifest.json）
const SELENA_PMX_SHA256 = 'C8636D99356C51D059B3FC38FFF062123C57D82164A00BBEB76B40674E503DF5';

function makeValidProfile(overrides: Partial<PerformanceProfile> = {}): PerformanceProfile {
  const relaxedBasePose: RelaxedBasePoseOffsets = {
    leftShoulder: [0, 0, 0.025],
    rightShoulder: [0, 0, -0.05],
    leftArm: [0, 0, 0.12],
    rightArm: [0, 0, -0.15],
    leftElbow: [0, -0.08, 0],
    rightElbow: [0, 0.11, 0],
    leftWrist: [0, 0, 0.04],
    rightWrist: [0, 0, -0.07]
  };
  const proceduralLife: ProceduralLifeProfile = {
    breathPrimaryRadians: 0.006,
    breathSecondaryRadians: 0.002,
    swayRadians: 0.008,
    speakingScale: 0.7,
    blinkIntervalMinSeconds: 3.2,
    blinkIntervalMaxSeconds: 5.4
  };
  const idleDirector: IdleDirectorProfile = {
    minDwellSeconds: 25,
    maxDwellSeconds: 70,
    recentHistorySize: 2
  };
  return {
    avatarSha256: SELENA_PMX_SHA256,
    relaxedBasePose,
    proceduralLife,
    idleDirector,
    ...overrides
  };
}

describe('PerformanceProfile - SHA 绑定与校验', () => {
  describe('validatePerformanceProfile', () => {
    it('接受完全有效的 profile', () => {
      const profile = makeValidProfile();
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(true);
    });

    it('拒绝 SHA-256 不匹配', () => {
      const profile = makeValidProfile();
      const wrongSha = '0'.repeat(64);
      const result = validatePerformanceProfile(profile, wrongSha);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toMatch(/sha/i);
      }
    });

    it('拒绝空 SHA', () => {
      const profile = makeValidProfile({ avatarSha256: '' });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
    });

    it('拒绝 breathPrimaryRadians 为 NaN', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: NaN,
          breathSecondaryRadians: 0.002,
          swayRadians: 0.008,
          speakingScale: 0.7,
          blinkIntervalMinSeconds: 3.2,
          blinkIntervalMaxSeconds: 5.4
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toMatch(/finite|nan/i);
      }
    });

    it('拒绝 breathPrimaryRadians 为 Infinity', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: Infinity,
          breathSecondaryRadians: 0.002,
          swayRadians: 0.008,
          speakingScale: 0.7,
          blinkIntervalMinSeconds: 3.2,
          blinkIntervalMaxSeconds: 5.4
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
    });

    it('拒绝负的 breathPrimaryRadians', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: -0.001,
          breathSecondaryRadians: 0.002,
          swayRadians: 0.008,
          speakingScale: 0.7,
          blinkIntervalMinSeconds: 3.2,
          blinkIntervalMaxSeconds: 5.4
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toMatch(/negative|负/i);
      }
    });

    it('拒绝 swayRadians 为负', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: 0.006,
          breathSecondaryRadians: 0.002,
          swayRadians: -0.008,
          speakingScale: 0.7,
          blinkIntervalMinSeconds: 3.2,
          blinkIntervalMaxSeconds: 5.4
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
    });

    it('拒绝 speakingScale < 0', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: 0.006,
          breathSecondaryRadians: 0.002,
          swayRadians: 0.008,
          speakingScale: -0.1,
          blinkIntervalMinSeconds: 3.2,
          blinkIntervalMaxSeconds: 5.4
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
    });

    it('拒绝 speakingScale > 1', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: 0.006,
          breathSecondaryRadians: 0.002,
          swayRadians: 0.008,
          speakingScale: 1.5,
          blinkIntervalMinSeconds: 3.2,
          blinkIntervalMaxSeconds: 5.4
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
    });

    it('接受 speakingScale = 0（边界）', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: 0.006,
          breathSecondaryRadians: 0.002,
          swayRadians: 0.008,
          speakingScale: 0,
          blinkIntervalMinSeconds: 3.2,
          blinkIntervalMaxSeconds: 5.4
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(true);
    });

    it('接受 speakingScale = 1（边界）', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: 0.006,
          breathSecondaryRadians: 0.002,
          swayRadians: 0.008,
          speakingScale: 1,
          blinkIntervalMinSeconds: 3.2,
          blinkIntervalMaxSeconds: 5.4
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(true);
    });

    it('拒绝 blinkIntervalMinSeconds > blinkIntervalMaxSeconds', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: 0.006,
          breathSecondaryRadians: 0.002,
          swayRadians: 0.008,
          speakingScale: 0.7,
          blinkIntervalMinSeconds: 5.5,
          blinkIntervalMaxSeconds: 3.2
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toMatch(/blink|min|max/i);
      }
    });

    it('接受 blinkIntervalMin = blinkIntervalMax（边界，固定间隔）', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: 0.006,
          breathSecondaryRadians: 0.002,
          swayRadians: 0.008,
          speakingScale: 0.7,
          blinkIntervalMinSeconds: 4,
          blinkIntervalMaxSeconds: 4
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(true);
    });

    it('拒绝负的 blink 间隔', () => {
      const profile = makeValidProfile({
        proceduralLife: {
          breathPrimaryRadians: 0.006,
          breathSecondaryRadians: 0.002,
          swayRadians: 0.008,
          speakingScale: 0.7,
          blinkIntervalMinSeconds: -1,
          blinkIntervalMaxSeconds: 5.4
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
    });

    it('拒绝 minDwellSeconds > maxDwellSeconds', () => {
      const profile = makeValidProfile({
        idleDirector: {
          minDwellSeconds: 80,
          maxDwellSeconds: 70,
          recentHistorySize: 2
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toMatch(/dwell|min|max/i);
      }
    });

    it('拒绝负的 dwell 秒数', () => {
      const profile = makeValidProfile({
        idleDirector: {
          minDwellSeconds: -1,
          maxDwellSeconds: 70,
          recentHistorySize: 2
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
    });

    it('拒绝 dwell min/max 为 NaN', () => {
      const profile = makeValidProfile({
        idleDirector: {
          minDwellSeconds: NaN,
          maxDwellSeconds: 70,
          recentHistorySize: 2
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
    });

    it('拒绝 recentHistorySize < 0', () => {
      const profile = makeValidProfile({
        idleDirector: {
          minDwellSeconds: 25,
          maxDwellSeconds: 70,
          recentHistorySize: -1
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
    });

    it('接受 recentHistorySize = 0（无历史）', () => {
      const profile = makeValidProfile({
        idleDirector: {
          minDwellSeconds: 25,
          maxDwellSeconds: 70,
          recentHistorySize: 0
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(true);
    });

    it('拒绝 recentHistorySize 为 NaN', () => {
      const profile = makeValidProfile({
        idleDirector: {
          minDwellSeconds: 25,
          maxDwellSeconds: 70,
          recentHistorySize: NaN
        }
      });
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(false);
    });

    describe('relaxed-pose 分量幅度上限', () => {
      it('拒绝 leftShoulder 分量绝对值 >= 0.3 rad', () => {
        const profile = makeValidProfile({
          relaxedBasePose: {
            leftShoulder: [0.31, 0, 0.025],
            rightShoulder: [0, 0, -0.05],
            leftArm: [0, 0, 0.12],
            rightArm: [0, 0, -0.15],
            leftElbow: [0, -0.08, 0],
            rightElbow: [0, 0.11, 0],
            leftWrist: [0, 0, 0.04],
            rightWrist: [0, 0, -0.07]
          }
        });
        const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toMatch(/relaxed|shoulder|0\.3|幅度/i);
        }
      });

      it('拒绝 rightArm 分量绝对值 = 0.3 rad（边界外）', () => {
        const profile = makeValidProfile({
          relaxedBasePose: {
            leftShoulder: [0, 0, 0.025],
            rightShoulder: [0, 0, -0.05],
            leftArm: [0, 0, 0.12],
            rightArm: [0, 0, -0.3],
            leftElbow: [0, -0.08, 0],
            rightElbow: [0, 0.11, 0],
            leftWrist: [0, 0, 0.04],
            rightWrist: [0, 0, -0.07]
          }
        });
        const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
        expect(result.valid).toBe(false);
      });

      it('接受 leftElbow 分量绝对值 = 0.299 rad（边界内）', () => {
        const profile = makeValidProfile({
          relaxedBasePose: {
            leftShoulder: [0, 0, 0.025],
            rightShoulder: [0, 0, -0.05],
            leftArm: [0, 0, 0.12],
            rightArm: [0, 0, -0.15],
            leftElbow: [0, -0.299, 0],
            rightElbow: [0, 0.11, 0],
            leftWrist: [0, 0, 0.04],
            rightWrist: [0, 0, -0.07]
          }
        });
        const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
        expect(result.valid).toBe(true);
      });

      it('拒绝 leftWrist NaN 分量', () => {
        const profile = makeValidProfile({
          relaxedBasePose: {
            leftShoulder: [0, 0, 0.025],
            rightShoulder: [0, 0, -0.05],
            leftArm: [0, 0, 0.12],
            rightArm: [0, 0, -0.15],
            leftElbow: [0, -0.08, 0],
            rightElbow: [0, 0.11, 0],
            leftWrist: [NaN, 0, 0.04],
            rightWrist: [0, 0, -0.07]
          }
        });
        const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
        expect(result.valid).toBe(false);
      });

      it('检查所有 8 块骨骼（不只第一块）', () => {
        // 右手腕幅度超界
        const profile = makeValidProfile({
          relaxedBasePose: {
            leftShoulder: [0, 0, 0.025],
            rightShoulder: [0, 0, -0.05],
            leftArm: [0, 0, 0.12],
            rightArm: [0, 0, -0.15],
            leftElbow: [0, -0.08, 0],
            rightElbow: [0, 0.11, 0],
            leftWrist: [0, 0, 0.04],
            rightWrist: [0, 0, -0.5]
          }
        });
        const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
        expect(result.valid).toBe(false);
      });
    });
  });

  describe('Selena performance-profile.json 真实文件', () => {
    it('文件存在且通过校验', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const profilePath = resolve(__dirname, '..', '..', 'src', 'actor', 'selena', 'performance-profile.json');
      const raw = readFileSync(profilePath, 'utf-8');
      const profile = JSON.parse(raw) as PerformanceProfile;
      const result = validatePerformanceProfile(profile, SELENA_PMX_SHA256);
      expect(result.valid).toBe(true);
    });
  });
});
