import { describe, it, expect, beforeEach } from 'vitest';
import {
  BoneOwnershipRegistry,
  BoneOwner,
  BONE_OWNER_PRIORITY,
  MorphOwnershipRegistry,
  type OwnershipLease
} from '../../src/actor/bone-ownership-registry';

describe('bone-ownership-registry', () => {
  let registry: BoneOwnershipRegistry;

  beforeEach(() => {
    registry = new BoneOwnershipRegistry();
  });

  describe('BONE_OWNER_PRIORITY（显式优先级）', () => {
    it('procedural < vmd < performance-planner', () => {
      expect(BONE_OWNER_PRIORITY.procedural).toBeLessThan(BONE_OWNER_PRIORITY.vmd);
      expect(BONE_OWNER_PRIORITY.vmd).toBeLessThan(BONE_OWNER_PRIORITY['performance-planner']);
    });

    it('none 优先级最低', () => {
      expect(BONE_OWNER_PRIORITY.none).toBeLessThan(BONE_OWNER_PRIORITY.procedural);
    });
  });

  describe('claim（声明骨骼所有权）', () => {
    it('首次 claim 成功，返回 lease（含 token）', () => {
      const lease = registry.claim('頭', 'procedural');
      expect(lease).toBeDefined();
      expect(lease!.boneName).toBe('頭');
      expect(lease!.owner).toBe('procedural');
      expect(lease!.token).toBeTruthy(); // token 是非空字符串
      expect(lease!.token.length).toBeGreaterThan(0);
    });

    it('高优先级 owner 可以抢占低优先级 owner（返回新 lease）', () => {
      const procLease = registry.claim('頭', 'procedural');
      const vmdLease = registry.claim('頭', 'vmd');
      expect(vmdLease).toBeDefined();
      expect(vmdLease!.owner).toBe('vmd');
      expect(vmdLease!.token).not.toBe(procLease!.token);
      // 当前 owner 是 vmd
      expect(registry.getOwner('頭')).toBe('vmd');
    });

    it('低优先级 owner 不能抢占高优先级 owner（返回 null）', () => {
      registry.claim('頭', 'vmd');
      const procLease = registry.claim('頭', 'procedural');
      expect(procLease).toBeNull();
      // 当前 owner 仍是 vmd
      expect(registry.getOwner('頭')).toBe('vmd');
    });

    it('同优先级 owner 不能抢占（返回 null）', () => {
      const vmd1 = registry.claim('頭', 'vmd');
      const vmd2 = registry.claim('頭', 'vmd');
      expect(vmd2).toBeNull();
      expect(registry.getOwner('頭')).toBe('vmd');
    });

    it('相同 owner 重复 claim 同一骨骼返回 null（不允许多 lease）', () => {
      const lease1 = registry.claim('頭', 'vmd');
      const lease2 = registry.claim('頭', 'vmd');
      expect(lease2).toBeNull();
    });
  });

  describe('release（释放骨骼所有权，需要 lease token 验证）', () => {
    it('正确 token 释放成功', () => {
      const lease = registry.claim('頭', 'vmd');
      const released = registry.release(lease!);
      expect(released).toBe(true);
      expect(registry.getOwner('頭')).toBe('none');
    });

    it('错误 token 释放失败（旧 owner 不能释放新 owner 的骨骼）', () => {
      const oldLease = registry.claim('頭', 'procedural');
      // vmd 抢占 procedural
      const newLease = registry.claim('頭', 'vmd');
      // 旧 procedural lease 尝试释放（token 已失效）
      const released = registry.release(oldLease!);
      expect(released).toBe(false);
      // 当前 owner 仍是 vmd
      expect(registry.getOwner('頭')).toBe('vmd');
    });

    it('使用新 lease 释放成功', () => {
      const oldLease = registry.claim('頭', 'procedural');
      const newLease = registry.claim('頭', 'vmd');
      const released = registry.release(newLease!);
      expect(released).toBe(true);
      expect(registry.getOwner('頭')).toBe('none');
    });

    it('伪造 token 释放失败', () => {
      const lease = registry.claim('頭', 'vmd');
      const fakeLease: OwnershipLease = {
        boneName: '頭',
        owner: 'vmd',
        token: 'fake-token',
        acquiredAt: lease!.acquiredAt
      };
      expect(registry.release(fakeLease)).toBe(false);
    });

    it('已释放的 lease 再次释放失败', () => {
      const lease = registry.claim('頭', 'vmd');
      expect(registry.release(lease!)).toBe(true);
      expect(registry.release(lease!)).toBe(false);
    });
  });

  describe('releaseAllForOwner（批量释放某个 owner 的所有 lease）', () => {
    it('释放 procedural 持有的所有骨骼', () => {
      const l1 = registry.claim('頭', 'procedural');
      const l2 = registry.claim('上半身', 'procedural');
      const l3 = registry.claim('左肩', 'procedural');
      const released = registry.releaseAllForOwner('procedural');
      expect(released).toBe(3);
      expect(registry.getOwner('頭')).toBe('none');
      expect(registry.getOwner('上半身')).toBe('none');
      expect(registry.getOwner('左肩')).toBe('none');
    });

    it('只释放指定 owner，不影响其他 owner', () => {
      registry.claim('頭', 'procedural');
      registry.claim('上半身', 'vmd');
      const released = registry.releaseAllForOwner('procedural');
      expect(released).toBe(1);
      expect(registry.getOwner('頭')).toBe('none');
      expect(registry.getOwner('上半身')).toBe('vmd');
    });
  });

  describe('场景测试 1：VMD 控制頭/上半身/肩时，ProceduralLifeController 不覆盖', () => {
    it('VMD claim 头和上半身后，procedural claim 失败', () => {
      registry.claim('頭', 'vmd');
      registry.claim('上半身', 'vmd');
      registry.claim('左肩', 'vmd');
      registry.claim('右肩', 'vmd');
      // ProceduralLifeController 尝试 claim 全部失败
      expect(registry.claim('頭', 'procedural')).toBeNull();
      expect(registry.claim('上半身', 'procedural')).toBeNull();
      expect(registry.claim('左肩', 'procedural')).toBeNull();
      expect(registry.claim('右肩', 'procedural')).toBeNull();
      // 检查 ProceduralLifeController 是否应该跳过：通过 canApplyProcedural 判断
      expect(registry.canApplyProcedural('頭')).toBe(false);
      expect(registry.canApplyProcedural('上半身')).toBe(false);
      expect(registry.canApplyProcedural('左肩')).toBe(false);
      expect(registry.canApplyProcedural('右肩')).toBe(false);
    });
  });

  describe('场景测试 2：VMD 停止后程序化生命层能恢复', () => {
    it('VMD release 后，procedural 可以重新 claim', () => {
      const vmdLease = registry.claim('頭', 'vmd');
      expect(registry.canApplyProcedural('頭')).toBe(false);
      registry.release(vmdLease!);
      expect(registry.canApplyProcedural('頭')).toBe(true);
      // procedural 现在可以 claim
      const procLease = registry.claim('頭', 'procedural');
      expect(procLease).toBeDefined();
      expect(registry.getOwner('頭')).toBe('procedural');
    });

    it('VMD releaseAllForOwner 后，所有骨骼恢复 none，procedural 可接管', () => {
      registry.claim('頭', 'vmd');
      registry.claim('上半身', 'vmd');
      registry.claim('左肩', 'vmd');
      registry.claim('右肩', 'vmd');
      const released = registry.releaseAllForOwner('vmd');
      expect(released).toBe(4);
      // 现在所有骨骼都是 none，procedural 可以接管
      expect(registry.canApplyProcedural('頭')).toBe(true);
      expect(registry.canApplyProcedural('上半身')).toBe(true);
      expect(registry.canApplyProcedural('左肩')).toBe(true);
      expect(registry.canApplyProcedural('右肩')).toBe(true);
    });
  });

  describe('场景测试 3：旧 owner 不能释放新 owner（lease token 验证）', () => {
    it('procedural lease 在 vmd 抢占后失效，不能释放', () => {
      const procLease = registry.claim('頭', 'procedural');
      // vmd 抢占
      registry.claim('頭', 'vmd');
      // procedural 尝试释放（应该失败，因为 token 已失效）
      expect(registry.release(procLease!)).toBe(false);
      // vmd 仍持有
      expect(registry.getOwner('頭')).toBe('vmd');
    });

    it('多次抢占后，只有最新 lease 能释放', () => {
      const l1 = registry.claim('頭', 'procedural');
      const l2 = registry.claim('頭', 'vmd');
      const l3 = registry.claim('頭', 'performance-planner');
      // l1 和 l2 都不能释放
      expect(registry.release(l1!)).toBe(false);
      expect(registry.release(l2!)).toBe(false);
      // 只有 l3 能释放
      expect(registry.release(l3!)).toBe(true);
      expect(registry.getOwner('頭')).toBe('none');
    });
  });

  describe('场景测试 4：模式切换和 stopPerformance 后全部恢复安全 Base Pose', () => {
    it('releaseAll() 清空所有 lease（模式切换 / stopPerformance 调用）', () => {
      registry.claim('頭', 'vmd');
      registry.claim('上半身', 'vmd');
      registry.claim('左肩', 'procedural');
      registry.claim('右足', 'performance-planner');
      const count = registry.releaseAll();
      expect(count).toBe(4);
      // 所有骨骼恢复 none（安全 Base Pose）
      expect(registry.getOwner('頭')).toBe('none');
      expect(registry.getOwner('上半身')).toBe('none');
      expect(registry.getOwner('左肩')).toBe('none');
      expect(registry.getOwner('右足')).toBe('none');
      // procedural 可以重新接管
      expect(registry.canApplyProcedural('頭')).toBe(true);
    });

    it('releaseAll 后所有旧 lease 失效', () => {
      const l1 = registry.claim('頭', 'vmd');
      const l2 = registry.claim('上半身', 'procedural');
      registry.releaseAll();
      // 旧 lease 都不能释放（已经无效）
      expect(registry.release(l1!)).toBe(false);
      expect(registry.release(l2!)).toBe(false);
    });
  });

  describe('canApplyProcedural（ProceduralLifeController 专用查询）', () => {
    it('none 时 procedural 可以应用', () => {
      expect(registry.canApplyProcedural('頭')).toBe(true);
    });

    it('procedural 持有时可以应用', () => {
      registry.claim('頭', 'procedural');
      expect(registry.canApplyProcedural('頭')).toBe(true);
    });

    it('vmd 持有时 procedural 不能应用', () => {
      registry.claim('頭', 'vmd');
      expect(registry.canApplyProcedural('頭')).toBe(false);
    });

    it('performance-planner 持有时 procedural 不能应用', () => {
      registry.claim('頭', 'performance-planner');
      expect(registry.canApplyProcedural('頭')).toBe(false);
    });
  });
});

describe('morph-ownership-registry（眨眼属于 Morph 所有权，独立于骨骼所有权）', () => {
  let morphRegistry: MorphOwnershipRegistry;

  beforeEach(() => {
    morphRegistry = new MorphOwnershipRegistry();
  });

  describe('眨眼 morph 所有权', () => {
    it('procedural 默认拥有 まばたき', () => {
      expect(morphRegistry.getOwner('まばたき')).toBe('procedural');
    });

    it('VMD claim まばたき 后，procedural 让出', () => {
      const lease = morphRegistry.claim('まばたき', 'vmd');
      expect(lease).toBeDefined();
      expect(morphRegistry.getOwner('まばたき')).toBe('vmd');
      expect(morphRegistry.canApplyProcedural('まばたき')).toBe(false);
    });

    it('VMD release まばたき 后，procedural 恢复', () => {
      const lease = morphRegistry.claim('まばたき', 'vmd');
      morphRegistry.release(lease!);
      expect(morphRegistry.getOwner('まばたき')).toBe('procedural');
      expect(morphRegistry.canApplyProcedural('まばたき')).toBe(true);
    });

    it('VMD 不含 まばたき 时，procedural 继续程序化眨眼', () => {
      // 默认 procedural 持有
      expect(morphRegistry.canApplyProcedural('まばたき')).toBe(true);
      // VMD 未 claim，procedural 仍可应用
      expect(morphRegistry.canApplyProcedural('まばたき')).toBe(true);
    });

    it('releaseAll 后恢复 procedural 默认（安全 Base Pose）', () => {
      morphRegistry.claim('まばたき', 'vmd');
      morphRegistry.releaseAll();
      expect(morphRegistry.getOwner('まばたき')).toBe('procedural');
    });
  });

  describe('viseme morph 所有权（あ/い/う/え/お）', () => {
    it('LipTimeline 优先级 > VMD morph 轨道', () => {
      // VMD 先 claim あ
      const vmdLease = morphRegistry.claim('あ', 'vmd');
      expect(vmdLease).toBeDefined();
      // LipTimeline（performance-planner）抢占
      const lipLease = morphRegistry.claim('あ', 'performance-planner');
      expect(lipLease).toBeDefined();
      expect(morphRegistry.getOwner('あ')).toBe('performance-planner');
      // 旧 VMD lease 不能释放
      expect(morphRegistry.release(vmdLease!)).toBe(false);
    });
  });
});
