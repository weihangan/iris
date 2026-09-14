// Three.js SkinnedMesh 与 ActorRuntime 之间的唯一桥接（Task 2）
//
// 设计原则：
// - MorphController 是唯一 Morph 写入口，SkinnedMesh 只作为 Sink
// - 面板/ActorRuntime/任何写入方都通过 createAvatarMorphControl → MorphController
// - 真实 Mesh 权重通过 getRenderedWeight 读取，用于 E2E 验证
// - FaceRed 0.35 上限只在 MorphController.safeRanges 中定义，Mesh Sink 不复制业务规则
//
// 解决问题：
// - Bug 4 双状态：旧 morphPanel 直接写 mesh，ActorRuntime 又维护一套权重
// - E2E 假阳性：旧测试只读 MorphController，删除 Sink 后仍通过

import type * as THREE from 'three';
import type { ActorRuntime } from './actor-runtime';
import type { MorphSink } from './morph-controller';

/**
 * 面板和高层 API 使用的 Morph 控制接口。
 * 所有写入都经过 MorphController（唯一状态源），保证安全范围和 sink 推送。
 */
export interface AvatarMorphControl {
  /**
   * 设置 morph 权重。未知 morph 返回 false。
   * 权重经过 MorphController 钳制（含 FaceRed 0.35 上限）。
   */
  setWeight(name: string, weight: number): boolean;

  /**
   * 读取 MorphController 中的逻辑权重。
   * 未知 morph 返回 -1。
   */
  getWeight(name: string): number;

  /**
   * 读取真实 SkinnedMesh 上的 morphTargetInfluences 权重。
   * 用于 E2E 验证 mesh 真实状态，而非逻辑层状态。
   * 未知 morph 返回 -1。
   */
  getRenderedWeight(name: string): number;

  /**
   * 重置所有 morph 权重为 0。同步推送到 mesh。
   */
  reset(): void;

  /**
   * 返回可用 morph 名称列表。
   */
  getAvailableMorphs(): string[];
}

/**
 * 创建绑定到 SkinnedMesh 的 MorphSink。
 * Sink 只负责把 MorphController 已钳制的权重写入 mesh.morphTargetInfluences，
 * 不复制任何业务规则（如 FaceRed 上限）。
 * 未知 morph 名称（mesh 上无对应 morph target）安全忽略。
 *
 * 重要：每次调用都通过 mesh.morphTargetInfluences 实时访问，不缓存引用。
 * 原因：MMD runtime 的 model.update() 可能替换 mesh.morphTargetInfluences
 * 数组（而非原地修改），缓存引用会指向旧数组，导致写入丢失。
 */
export function createMeshMorphSink(
  mesh: THREE.SkinnedMesh,
  render: () => void
): MorphSink {
  const dictionary = mesh.morphTargetDictionary;
  if (!dictionary || !mesh.morphTargetInfluences) {
    throw new Error('SkinnedMesh does not expose morph targets');
  }

  return {
    setWeight(name, weight) {
      const dict = mesh.morphTargetDictionary;
      const infl = mesh.morphTargetInfluences;
      if (!dict || !infl) return;
      const index = dict[name];
      if (index === undefined) return; // mesh 上无此 morph，安全忽略
      infl[index] = weight;
      render();
    },
    resetAll() {
      const infl = mesh.morphTargetInfluences;
      if (!infl) return;
      for (let i = 0; i < infl.length; i++) {
        infl[i] = 0;
      }
      render();
    }
  };
}

/**
 * 创建 AvatarMorphControl，桥接 ActorRuntime、MorphController 和 SkinnedMesh。
 * 所有写入通过 MorphController（唯一状态源），自动推送 sink 到真实 mesh。
 * getRenderedWeight 直接读取 mesh.morphTargetInfluences，用于 E2E 真实验证。
 *
 * 重要：getRenderedWeight 每次调用都通过 mesh.morphTargetInfluences 实时访问，
 * 不缓存引用。原因同 createMeshMorphSink：MMD runtime 可能替换该数组。
 */
export function createAvatarMorphControl(
  actor: ActorRuntime,
  mesh: THREE.SkinnedMesh
): AvatarMorphControl {
  const controller = actor.getMorphController();
  const available = new Set(controller.getKnownMorphs());

  return {
    setWeight(name, weight) {
      if (!available.has(name)) return false;
      controller.setWeight(name, weight);
      return true;
    },
    getWeight(name) {
      return available.has(name) ? controller.getWeight(name) : -1;
    },
    getRenderedWeight(name) {
      const dict = mesh.morphTargetDictionary;
      const infl = mesh.morphTargetInfluences;
      if (!dict || !infl) return -1;
      const index = dict[name];
      return index === undefined ? -1 : infl[index] ?? -1;
    },
    reset() {
      controller.reset();
    },
    getAvailableMorphs() {
      return Array.from(available);
    }
  };
}
