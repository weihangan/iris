import { describe, it, expect } from 'vitest';
import {
  MotionPackStage,
  type MotionPackManifest,
  type BoneMapping,
  type AmplitudeLimits,
  validateMotionPackManifest,
  createEmptyManifest,
  isStageComplete,
  MISSING_LICENSE_REJECTS
} from '../../src/motion/motion-pack-types';

describe('motion-pack-types', () => {
  describe('MotionPackStage 枚举（8 阶段强制门）', () => {
    it('定义完整 8 阶段，顺序固定', () => {
      expect(MotionPackStage.Download).toBe('download');
      expect(MotionPackStage.Hash).toBe('hash');
      expect(MotionPackStage.SourceRecord).toBe('source-record');
      expect(MotionPackStage.SkeletonRetarget).toBe('skeleton-retarget');
      expect(MotionPackStage.AmplitudeLimit).toBe('amplitude-limit');
      expect(MotionPackStage.SkatingCheck).toBe('skating-check');
      expect(MotionPackStage.VideoAcceptance).toBe('video-acceptance');
      expect(MotionPackStage.WhitelistRegister).toBe('whitelist-register');
    });
  });

  describe('createEmptyManifest', () => {
    it('返回 packId 唯一必填字段，其余为空', () => {
      const m = createEmptyManifest('idle-stand-breathe-v1');
      expect(m.packId).toBe('idle-stand-breathe-v1');
      expect(m.sourceUrl).toBe('');
      expect(m.author).toBe('');
      expect(m.license).toBe('');
      expect(m.downloadedAt).toBe('');
      expect(m.sha256).toBe('');
      expect(m.boneMapping).toEqual({});
      expect(m.amplitudeLimits).toBeNull();
      expect(m.skatingCheckPassed).toBe(false);
      expect(m.videoAcceptance).toBeNull();
      expect(m.whitelistRegistered).toBe(false);
    });
  });

  describe('isStageComplete', () => {
    it('Download 阶段：sourceUrl + downloadedAt 都非空才算完成', () => {
      const m = createEmptyManifest('p1');
      expect(isStageComplete(m, MotionPackStage.Download)).toBe(false);
      m.sourceUrl = 'https://example.com/motion.vmd';
      m.downloadedAt = '2026-07-19T10:00:00Z';
      expect(isStageComplete(m, MotionPackStage.Download)).toBe(true);
    });

    it('Hash 阶段：sha256 长度 64 才算完成', () => {
      const m = createEmptyManifest('p1');
      expect(isStageComplete(m, MotionPackStage.Hash)).toBe(false);
      m.sha256 = 'too-short';
      expect(isStageComplete(m, MotionPackStage.Hash)).toBe(false);
      m.sha256 = 'a'.repeat(64);
      expect(isStageComplete(m, MotionPackStage.Hash)).toBe(true);
    });

    it('SourceRecord 阶段：author + license 都非空才算完成', () => {
      const m = createEmptyManifest('p1');
      expect(isStageComplete(m, MotionPackStage.SourceRecord)).toBe(false);
      m.author = 'mobiusP';
      expect(isStageComplete(m, MotionPackStage.SourceRecord)).toBe(false);
      m.license = 'CC-BY-NC';
      expect(isStageComplete(m, MotionPackStage.SourceRecord)).toBe(true);
    });

    it('SourceRecord 阶段：未知许可证被拒绝（MISSING_LICENSE_REJECTS）', () => {
      const m = createEmptyManifest('p1');
      m.author = 'someone';
      m.license = 'unknown';
      expect(isStageComplete(m, MotionPackStage.SourceRecord)).toBe(false);
      m.license = 'CC-BY-NC-4.0';
      expect(isStageComplete(m, MotionPackStage.SourceRecord)).toBe(true);
    });

    it('SkeletonRetarget 阶段：boneMapping 至少包含頭/上半身/左肩/右肩才算完成', () => {
      const m = createEmptyManifest('p1');
      expect(isStageComplete(m, MotionPackStage.SkeletonRetarget)).toBe(false);
      m.boneMapping = { 頭: '頭' };
      expect(isStageComplete(m, MotionPackStage.SkeletonRetarget)).toBe(false);
      m.boneMapping = {
        頭: '頭', 上半身: '上半身', 左肩: '左肩', 右肩: '右肩'
      };
      expect(isStageComplete(m, MotionPackStage.SkeletonRetarget)).toBe(true);
    });

    it('AmplitudeLimit 阶段：amplitudeLimits 非 null 才算完成', () => {
      const m = createEmptyManifest('p1');
      expect(isStageComplete(m, MotionPackStage.AmplitudeLimit)).toBe(false);
      m.amplitudeLimits = {
        head: { x: 30, y: 30, z: 30 },
        upperBody: { x: 20, y: 20, z: 20 },
        shoulder: { x: 15, y: 15, z: 15 },
        faceRedMax: 0.35
      };
      expect(isStageComplete(m, MotionPackStage.AmplitudeLimit)).toBe(true);
    });

    it('SkatingCheck 阶段：skatingCheckPassed=true 才算完成', () => {
      const m = createEmptyManifest('p1');
      expect(isStageComplete(m, MotionPackStage.SkatingCheck)).toBe(false);
      m.skatingCheckPassed = false;
      expect(isStageComplete(m, MotionPackStage.SkatingCheck)).toBe(false);
      m.skatingCheckPassed = true;
      expect(isStageComplete(m, MotionPackStage.SkatingCheck)).toBe(true);
    });

    it('VideoAcceptance 阶段：videoAcceptance 非 null 且 accepted=true 才算完成', () => {
      const m = createEmptyManifest('p1');
      expect(isStageComplete(m, MotionPackStage.VideoAcceptance)).toBe(false);
      m.videoAcceptance = {
        accepted: false,
        acceptedBy: 'reviewer',
        acceptedAt: '2026-07-19',
        notes: '脚滑'
      };
      expect(isStageComplete(m, MotionPackStage.VideoAcceptance)).toBe(false);
      m.videoAcceptance = {
        accepted: true,
        acceptedBy: 'reviewer',
        acceptedAt: '2026-07-19',
        notes: '通过'
      };
      expect(isStageComplete(m, MotionPackStage.VideoAcceptance)).toBe(true);
    });

    it('WhitelistRegister 阶段：whitelistRegistered=true 才算完成', () => {
      const m = createEmptyManifest('p1');
      expect(isStageComplete(m, MotionPackStage.WhitelistRegister)).toBe(false);
      m.whitelistRegistered = true;
      expect(isStageComplete(m, MotionPackStage.WhitelistRegister)).toBe(true);
    });
  });

  describe('validateMotionPackManifest', () => {
    it('空 manifest：8 阶段全部缺失', () => {
      const m = createEmptyManifest('p1');
      const result = validateMotionPackManifest(m);
      expect(result.valid).toBe(false);
      expect(result.missing).toHaveLength(8);
      expect(result.missing).toContain(MotionPackStage.Download);
      expect(result.missing).toContain(MotionPackStage.Hash);
      expect(result.missing).toContain(MotionPackStage.SourceRecord);
      expect(result.missing).toContain(MotionPackStage.SkeletonRetarget);
      expect(result.missing).toContain(MotionPackStage.AmplitudeLimit);
      expect(result.missing).toContain(MotionPackStage.SkatingCheck);
      expect(result.missing).toContain(MotionPackStage.VideoAcceptance);
      expect(result.missing).toContain(MotionPackStage.WhitelistRegister);
    });

    it('完整合法 manifest：valid=true，missing 为空', () => {
      const m = createEmptyManifest('idle-stand-breathe-v1');
      m.sourceUrl = 'https://example.com/motion.vmd';
      m.downloadedAt = '2026-07-19T10:00:00Z';
      m.sha256 = 'a'.repeat(64);
      m.author = 'mobiusP';
      m.license = 'CC-BY-NC-4.0';
      m.boneMapping = { 頭: '頭', 上半身: '上半身', 左肩: '左肩', 右肩: '右肩' };
      m.amplitudeLimits = {
        head: { x: 30, y: 30, z: 30 },
        upperBody: { x: 20, y: 20, z: 20 },
        shoulder: { x: 15, y: 15, z: 15 },
        faceRedMax: 0.35
      };
      m.skatingCheckPassed = true;
      m.videoAcceptance = {
        accepted: true,
        acceptedBy: 'reviewer',
        acceptedAt: '2026-07-19',
        notes: '通过'
      };
      m.whitelistRegistered = true;
      const result = validateMotionPackManifest(m);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('未知许可证：SourceRecord 阶段失败（fail-closed）', () => {
      const m = createEmptyManifest('p1');
      m.author = 'someone';
      m.license = 'unknown';
      const result = validateMotionPackManifest(m);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain(MotionPackStage.SourceRecord);
    });

    it('缺失哈希：Hash 阶段失败（fail-closed）', () => {
      const m = createEmptyManifest('p1');
      m.sha256 = '';
      const result = validateMotionPackManifest(m);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain(MotionPackStage.Hash);
    });

    it('未通过视频验收：VideoAcceptance 阶段失败（fail-closed）', () => {
      const m = createEmptyManifest('p1');
      m.videoAcceptance = {
        accepted: false,
        acceptedBy: 'reviewer',
        acceptedAt: '2026-07-19',
        notes: '脚滑'
      };
      const result = validateMotionPackManifest(m);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain(MotionPackStage.VideoAcceptance);
    });

    it('缺失来源：SourceRecord 阶段失败（fail-closed）', () => {
      const m = createEmptyManifest('p1');
      m.author = '';
      m.license = 'CC-BY-NC-4.0';
      const result = validateMotionPackManifest(m);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain(MotionPackStage.SourceRecord);
    });
  });

  describe('MISSING_LICENSE_REJECTS', () => {
    it('包含 unknown / missing / empty / unspecified', () => {
      expect(MISSING_LICENSE_REJECTS).toContain('unknown');
      expect(MISSING_LICENSE_REJECTS).toContain('missing');
      expect(MISSING_LICENSE_REJECTS).toContain('empty');
      expect(MISSING_LICENSE_REJECTS).toContain('unspecified');
      expect(MISSING_LICENSE_REJECTS).toContain('');
    });
  });

  describe('BoneMapping 类型', () => {
    it('VMD 日文骨骼名 → 模型骨骼名映射', () => {
      const mapping: BoneMapping = {
        '頭': '頭',
        '上半身': '上半身',
        '左肩': '左肩',
        '右肩': '右肩',
        '全ての親': '全ての親',
        'センター': 'センター'
      };
      expect(Object.keys(mapping)).toHaveLength(6);
    });
  });

  describe('AmplitudeLimits 类型', () => {
    it('默认值：头 ±30 度 / 上半身 ±20 度 / 肩 ±15 度 / FaceRed ≤ 0.35', () => {
      const limits: AmplitudeLimits = {
        head: { x: 30, y: 30, z: 30 },
        upperBody: { x: 20, y: 20, z: 20 },
        shoulder: { x: 15, y: 15, z: 15 },
        faceRedMax: 0.35
      };
      expect(limits.faceRedMax).toBe(0.35);
      expect(limits.head.x).toBe(30);
    });
  });
});
