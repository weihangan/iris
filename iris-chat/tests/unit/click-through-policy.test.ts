import { describe, expect, it } from 'vitest';
import { AvatarMousePolicyController, computeEffectiveIgnoreMouse } from '../../src/click-through-policy';

/**
 * 规格 1.3 & 1.4：穿透状态公式与真值表
 *
 * effectiveIgnoreMouse =
 *   manualModelPassThrough ||
 *   (!pointerOnModel && !draggingModel);
 *
 * 三状态语义不可混淆：
 * - manualModelPassThrough：用户意图（仅按钮可改）
 * - pointerOnModel：瞬时命中（射线检测）
 * - draggingModel：瞬时状态（mousedown/mouseup）
 */
describe('computeEffectiveIgnoreMouse', () => {
  describe('规格 1.4 真值表全部 7 种情况', () => {
    it('情况1 默认：模型可点击、透明区穿透', () => {
      // manual=false, pointer=true, dragging=false → false（不穿透，模型可交互）
      expect(computeEffectiveIgnoreMouse(false, true, false)).toBe(false);
    });

    it('情况2 鼠标移到模型外：透明区穿透', () => {
      // manual=false, pointer=false, dragging=false → true（穿透，桌面可点击）
      expect(computeEffectiveIgnoreMouse(false, false, false)).toBe(true);
    });

    it('情况3 拖动模型（鼠标在模型上）：不穿透', () => {
      // manual=false, pointer=true, dragging=true → false（拖拽中不穿透）
      expect(computeEffectiveIgnoreMouse(false, true, true)).toBe(false);
    });

    it('情况3 拖动模型（鼠标在模型外）：不穿透', () => {
      // manual=false, pointer=false, dragging=true → false（拖拽中不穿透）
      expect(computeEffectiveIgnoreMouse(false, false, true)).toBe(false);
    });

    it('情况4 拖动结束（鼠标在模型外）：立即恢复穿透', () => {
      // manual=false, pointer=false, dragging=false → true（穿透）
      expect(computeEffectiveIgnoreMouse(false, false, false)).toBe(true);
    });

    it('情况5 拖动结束（鼠标仍在模型上）：保持可点击', () => {
      // manual=false, pointer=true, dragging=false → false（不穿透）
      expect(computeEffectiveIgnoreMouse(false, true, false)).toBe(false);
    });

    it('情况6 用户开启"模型穿透"（鼠标在模型上）：穿透', () => {
      // manual=true, pointer=true, dragging=false → true（穿透）
      expect(computeEffectiveIgnoreMouse(true, true, false)).toBe(true);
    });

    it('情况6 用户开启"模型穿透"（鼠标在模型外）：穿透', () => {
      // manual=true, pointer=false, dragging=false → true（穿透）
      expect(computeEffectiveIgnoreMouse(true, false, false)).toBe(true);
    });

    it('情况6 用户开启"模型穿透"（拖拽中）：穿透', () => {
      // manual=true, pointer=任意, dragging=true → true（穿透，模型也不可交互）
      expect(computeEffectiveIgnoreMouse(true, true, true)).toBe(true);
      expect(computeEffectiveIgnoreMouse(true, false, true)).toBe(true);
    });

    it('情况7 用户关闭"模型穿透"（鼠标在模型上）：恢复可点击', () => {
      // manual=false, pointer=true, dragging=false → false（不穿透）
      expect(computeEffectiveIgnoreMouse(false, true, false)).toBe(false);
    });

    it('情况7 用户关闭"模型穿透"（鼠标在模型外）：继续穿透', () => {
      // manual=false, pointer=false, dragging=false → true（穿透）
      expect(computeEffectiveIgnoreMouse(false, false, false)).toBe(true);
    });
  });

  describe('manualModelPassThrough=true 时，无论 pointer/dragging 如何变化，结果恒为 true', () => {
    it('pointer=true, dragging=false → true', () => {
      expect(computeEffectiveIgnoreMouse(true, true, false)).toBe(true);
    });
    it('pointer=false, dragging=false → true', () => {
      expect(computeEffectiveIgnoreMouse(true, false, false)).toBe(true);
    });
    it('pointer=true, dragging=true → true', () => {
      expect(computeEffectiveIgnoreMouse(true, true, true)).toBe(true);
    });
    it('pointer=false, dragging=true → true', () => {
      expect(computeEffectiveIgnoreMouse(true, false, true)).toBe(true);
    });
  });

  describe('draggingModel=true 时，即使 pointer=false，结果仍为 false（拖拽中不穿透）', () => {
    it('manual=false, pointer=false, dragging=true → false', () => {
      expect(computeEffectiveIgnoreMouse(false, false, true)).toBe(false);
    });
    it('manual=false, pointer=true, dragging=true → false', () => {
      expect(computeEffectiveIgnoreMouse(false, true, true)).toBe(false);
    });
  });

  describe('manualModelPassThrough 优先级最高', () => {
    it('manual=true 覆盖 dragging 的不穿透效果', () => {
      // 如果用户手动开启模型穿透，即使拖拽中也应穿透
      expect(computeEffectiveIgnoreMouse(true, false, true)).toBe(true);
      expect(computeEffectiveIgnoreMouse(true, true, true)).toBe(true);
    });
  });
});

describe('AvatarMousePolicyController', () => {
  it('applies physical hover transitions without changing the manual preference', () => {
    const applied: boolean[] = [];
    const policy = new AvatarMousePolicyController(value => applied.push(value));

    policy.sync();
    policy.setPointerOnModel(true);
    policy.setPointerOnModel(false);

    expect(applied).toEqual([true, false, true]);
    expect(policy.getState().manualModelPassThrough).toBe(false);
  });

  it('keeps the window interactive throughout a drag and restores transparent-area passthrough on release', () => {
    const applied: boolean[] = [];
    const policy = new AvatarMousePolicyController(value => applied.push(value));

    policy.sync();
    policy.setPointerOnModel(true);
    policy.setDraggingModel(true);
    policy.setPointerOnModel(false);
    policy.setDraggingModel(false);

    expect(applied).toEqual([true, false, true]);
  });

  it('manual passthrough remains authoritative until explicitly disabled', () => {
    const applied: boolean[] = [];
    const policy = new AvatarMousePolicyController(value => applied.push(value));

    policy.sync();
    policy.setManualModelPassThrough(true);
    policy.setPointerOnModel(true);
    policy.setManualModelPassThrough(false);

    expect(applied).toEqual([true, false]);
  });
});
