import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MotionPackRegistry,
  type RegistryEventListener,
  RegistryEvent
} from '../../src/motion/motion-pack-registry';
import type { MotionPackManifest } from '../../src/motion/motion-pack-types';
import { createEmptyManifest, MotionPackStage } from '../../src/motion/motion-pack-types';

function buildValidManifest(packId: string): MotionPackManifest {
  const m = createEmptyManifest(packId);
  m.sourceUrl = 'https://example.com/' + packId + '.vmd';
  m.downloadedAt = '2026-07-19T10:00:00Z';
  m.sha256 = 'a'.repeat(64);
  m.author = 'test-author';
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
  return m;
}

describe('motion-pack-registry', () => {
  let registry: MotionPackRegistry;

  beforeEach(() => {
    registry = new MotionPackRegistry();
  });

  describe('register', () => {
    it('合法 manifest 通过 8 阶段门 → 注册成功', () => {
      const m = buildValidManifest('idle-stand-breathe-v1');
      const result = registry.register(m);
      expect(result.success).toBe(true);
      expect(registry.has('idle-stand-breathe-v1')).toBe(true);
    });

    it('未通过 8 阶段门的 manifest → 拒绝注册', () => {
      const m = createEmptyManifest('incomplete');
      const result = registry.register(m);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('incomplete');
      expect(registry.has('incomplete')).toBe(false);
    });

    it('重复 packId → 拒绝注册', () => {
      const m = buildValidManifest('dup');
      registry.register(m);
      const result = registry.register(m);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('duplicate');
    });
  });

  describe('has / get / list', () => {
    it('has 查询已注册 packId', () => {
      registry.register(buildValidManifest('p1'));
      expect(registry.has('p1')).toBe(true);
      expect(registry.has('nonexistent')).toBe(false);
    });

    it('get 返回 manifest', () => {
      registry.register(buildValidManifest('p1'));
      const m = registry.get('p1');
      expect(m).toBeDefined();
      expect(m!.packId).toBe('p1');
    });

    it('get 不存在的 packId → undefined', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('list 返回所有已注册 manifest', () => {
      registry.register(buildValidManifest('p1'));
      registry.register(buildValidManifest('p2'));
      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list.map(m => m.packId)).toContain('p1');
      expect(list.map(m => m.packId)).toContain('p2');
    });
  });

  describe('unregister', () => {
    it('移除已注册的 packId', () => {
      registry.register(buildValidManifest('p1'));
      const result = registry.unregister('p1');
      expect(result).toBe(true);
      expect(registry.has('p1')).toBe(false);
    });

    it('移除不存在的 packId → false', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('releaseAll（主进程生命周期）', () => {
    it('清空所有已注册的 pack', () => {
      registry.register(buildValidManifest('p1'));
      registry.register(buildValidManifest('p2'));
      registry.register(buildValidManifest('p3'));
      const count = registry.releaseAll();
      expect(count).toBe(3);
      expect(registry.list()).toHaveLength(0);
    });

    it('空注册表 → releaseAll 返回 0', () => {
      expect(registry.releaseAll()).toBe(0);
    });

    it('触发 release-all 事件（携带被释放的 packId 列表）', () => {
      const listener: RegistryEventListener = vi.fn();
      registry.addEventListener(listener);
      registry.register(buildValidManifest('p1'));
      registry.register(buildValidManifest('p2'));
      registry.releaseAll();
      expect(listener).toHaveBeenCalledWith({
        type: RegistryEvent.ReleaseAll,
        packIds: expect.arrayContaining(['p1', 'p2'])
      });
    });
  });

  describe('事件', () => {
    it('register 触发 registered 事件', () => {
      const listener: RegistryEventListener = vi.fn();
      registry.addEventListener(listener);
      const m = buildValidManifest('p1');
      registry.register(m);
      expect(listener).toHaveBeenCalledWith({
        type: RegistryEvent.Registered,
        manifest: m
      });
    });

    it('unregister 触发 unregistered 事件', () => {
      const listener: RegistryEventListener = vi.fn();
      registry.addEventListener(listener);
      registry.register(buildValidManifest('p1'));
      registry.unregister('p1');
      expect(listener).toHaveBeenCalledWith({
        type: RegistryEvent.Unregistered,
        packId: 'p1'
      });
    });

    it('removeEventListener 移除监听器', () => {
      const listener: RegistryEventListener = vi.fn();
      registry.addEventListener(listener);
      registry.removeEventListener(listener);
      registry.register(buildValidManifest('p1'));
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("trigger='idle' 待机动作查询", () => {
    it('listIdle 返回所有 trigger=idle 的 pack', () => {
      const m1 = buildValidManifest('idle-stand-breathe-v1');
      (m1 as any).trigger = 'idle';
      const m2 = buildValidManifest('idle-look-around-v1');
      (m2 as any).trigger = 'idle';
      const m3 = buildValidManifest('wave-hand-v1');
      (m3 as any).trigger = 'user-only';
      registry.register(m1);
      registry.register(m2);
      registry.register(m3);
      const idle = registry.listByTrigger('idle');
      expect(idle).toHaveLength(2);
      expect(idle.map(m => m.packId)).toContain('idle-stand-breathe-v1');
      expect(idle.map(m => m.packId)).toContain('idle-look-around-v1');
    });
  });
});
