import { describe, it, expect, beforeEach } from 'vitest';
import { MorphController, type MorphSafeRange, type MorphSink } from '../../src/actor/morph-controller';

// Phase 3 Task 3.1 + Bug 4 修复: MorphController 测试
// 验证：按名称设置权重、安全范围限制、批量设置、重置、未知 morph 拒绝、MorphSink 绑定

describe('MorphController（Phase 3 Task 3.1）', () => {
  const knownMorphs = ['あ', 'い', 'う', 'え', 'お', 'まばたき', '笑い', 'FaceRed', '照れ'];
  const safeRanges: Record<string, MorphSafeRange> = {
    FaceRed: { min: 0, max: 0.35 }, // FaceRed 安全上限 0.35
  };
  let controller: MorphController;

  beforeEach(() => {
    controller = new MorphController(knownMorphs, safeRanges);
  });

  it('已知 morph 设置权重在 [0,1] 范围内', () => {
    controller.setWeight('あ', 0.5);
    expect(controller.getWeight('あ')).toBe(0.5);
  });

  it('权重超出 [0,1] 会被钳制到边界', () => {
    controller.setWeight('あ', 1.5);
    expect(controller.getWeight('あ')).toBe(1);
    controller.setWeight('あ', -0.3);
    expect(controller.getWeight('あ')).toBe(0);
  });

  it('FaceRed 受安全范围 [0, 0.35] 限制', () => {
    controller.setWeight('FaceRed', 0.5);
    expect(controller.getWeight('FaceRed')).toBeCloseTo(0.35, 6);
    controller.setWeight('FaceRed', -0.1);
    expect(controller.getWeight('FaceRed')).toBe(0);
    controller.setWeight('FaceRed', 0.2);
    expect(controller.getWeight('FaceRed')).toBeCloseTo(0.2, 6);
  });

  it('未在 knownMorphs 列表中的 morph 会被拒绝（fail-closed）', () => {
    expect(() => controller.setWeight('未知Morph', 0.5)).toThrow(/unknown morph/i);
    expect(controller.getWeight('未知Morph')).toBe(0);
  });

  it('applyBatch 一次设置多个 morph 权重', () => {
    controller.applyBatch({ 'あ': 0.3, 'い': 0.7, 'まばたき': 1 });
    expect(controller.getWeight('あ')).toBe(0.3);
    expect(controller.getWeight('い')).toBe(0.7);
    expect(controller.getWeight('まばたき')).toBe(1);
  });

  it('applyBatch 中包含未知 morph 时整批拒绝（事务性）', () => {
    controller.applyBatch({ 'あ': 0.3 });
    expect(() => controller.applyBatch({ 'い': 0.5, '未知': 0.5 })).toThrow(/unknown morph/i);
    // 原 'あ' 不变，'い' 未被设置
    expect(controller.getWeight('あ')).toBe(0.3);
    expect(controller.getWeight('い')).toBe(0);
  });

  it('reset 将所有权重置零', () => {
    controller.applyBatch({ 'あ': 0.3, 'FaceRed': 0.2, '笑い': 0.8 });
    controller.reset();
    expect(controller.getWeight('あ')).toBe(0);
    expect(controller.getWeight('FaceRed')).toBe(0);
    expect(controller.getWeight('笑い')).toBe(0);
  });

  it('getActiveMorphs 返回权重 > 0 的 morph 列表', () => {
    controller.applyBatch({ 'あ': 0.3, 'い': 0, 'FaceRed': 0.2 });
    const active = controller.getActiveMorphs();
    expect(active).toHaveLength(2);
    const names = active.map(m => m.name);
    expect(names).toContain('あ');
    expect(names).toContain('FaceRed');
    expect(names).not.toContain('い');
  });

  it('已知 morph 列表为空时，任何 setWeight 都失败', () => {
    const empty = new MorphController([], {});
    expect(() => empty.setWeight('あ', 0.5)).toThrow(/unknown morph/i);
  });

  it('未提供 safeRanges 时，所有 morph 使用默认 [0,1] 范围', () => {
    const c = new MorphController(['FaceRed'], {});
    c.setWeight('FaceRed', 0.9);
    expect(c.getWeight('FaceRed')).toBe(0.9);
  });
});

// Bug 4 修复：MorphSink 绑定测试
// 验证 setWeight/applyBatch/reset 的权重变更会推送到 sink
describe('MorphController.bindSink（Bug 4 修复）', () => {
  const knownMorphs = ['あ', 'い', 'FaceRed', '笑い'];
  const safeRanges: Record<string, MorphSafeRange> = {
    FaceRed: { min: 0, max: 0.35 },
  };

  /** 创建记录所有调用的 sink 用于断言 */
  function createRecordingSink(): { sink: MorphSink; calls: Array<{ type: 'set' | 'reset'; name?: string; weight?: number }> } {
    const calls: Array<{ type: 'set' | 'reset'; name?: string; weight?: number }> = [];
    const sink: MorphSink = {
      setWeight(name: string, weight: number): void {
        calls.push({ type: 'set', name, weight });
      },
      resetAll(): void {
        calls.push({ type: 'reset' });
      }
    };
    return { sink, calls };
  }

  it('bindSink 后 setWeight 推送钳制后的权重到 sink', () => {
    const controller = new MorphController(knownMorphs, safeRanges);
    const { sink, calls } = createRecordingSink();
    controller.bindSink(sink);

    controller.setWeight('あ', 0.5);
    expect(calls).toEqual([{ type: 'set', name: 'あ', weight: 0.5 }]);

    // 钳制测试：FaceRed 0.5 → 0.35
    controller.setWeight('FaceRed', 0.5);
    expect(calls[1]).toEqual({ type: 'set', name: 'FaceRed', weight: 0.35 });
  });

  it('bindSink 后 applyBatch 逐个推送每个 morph 到 sink', () => {
    const controller = new MorphController(knownMorphs, safeRanges);
    const { sink, calls } = createRecordingSink();
    controller.bindSink(sink);

    controller.applyBatch({ 'あ': 0.3, 'い': 0.7, 'FaceRed': 0.2 });
    expect(calls).toEqual([
      { type: 'set', name: 'あ', weight: 0.3 },
      { type: 'set', name: 'い', weight: 0.7 },
      { type: 'set', name: 'FaceRed', weight: 0.2 }
    ]);
  });

  it('bindSink 后 reset 推送 resetAll 到 sink', () => {
    const controller = new MorphController(knownMorphs, safeRanges);
    const { sink, calls } = createRecordingSink();
    controller.bindSink(sink);

    controller.setWeight('あ', 0.5);
    controller.reset();
    expect(calls[1]).toEqual({ type: 'reset' });
  });

  it('bindSink(undefined) 解除绑定后不再推送', () => {
    const controller = new MorphController(knownMorphs, safeRanges);
    const { sink, calls } = createRecordingSink();
    controller.bindSink(sink);
    controller.setWeight('あ', 0.5);
    expect(calls).toHaveLength(1);

    controller.bindSink(undefined);
    controller.setWeight('い', 0.7);
    expect(calls).toHaveLength(1); // 不再推送
  });

  it('未 bindSink 时 setWeight/reset 正常工作（无 sink 推送）', () => {
    const controller = new MorphController(knownMorphs, safeRanges);
    // 不 bindSink
    expect(() => controller.setWeight('あ', 0.5)).not.toThrow();
    expect(controller.getWeight('あ')).toBe(0.5);
    expect(() => controller.reset()).not.toThrow();
  });

  it('bindSink 在构造后任意时刻都可绑定', () => {
    const controller = new MorphController(knownMorphs, safeRanges);
    // 先设置一些权重（无 sink）
    controller.setWeight('あ', 0.5);
    // 后绑定 sink，不追溯推送历史
    const { sink, calls } = createRecordingSink();
    controller.bindSink(sink);
    expect(calls).toHaveLength(0); // 历史不推送

    // 新的 setWeight 推送
    controller.setWeight('い', 0.3);
    expect(calls).toEqual([{ type: 'set', name: 'い', weight: 0.3 }]);
  });
});
