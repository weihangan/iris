// 本地实现 syncMorphSplitTargetInfluences，用于将 mesh.morphTargetInfluences
// 同步到 @yohawing/three-mmd-loader 的 morph split 子几何体。
//
// 背景：
// @yohawing/three-mmd-loader 把稀疏顶点 morph 拆分到 per-material body meshes
//（userData.mmdMorphSplitBodyMeshes），实际渲染的是这些子几何体。
// 主 mesh.morphTargetInfluences 只是"源"权重，必须同步到子几何体才能在画面上生效。
//
// 库内部在 model.update() → runtime.evaluate() → syncThreeMmdRuntimeToMesh() 中
// 调用此同步，但同时会用动画采样的 morph 权重覆盖 mesh.morphTargetInfluences。
// 我们在 renderOneFrame 中需要"只同步不覆盖"——保留 setWeight 写入的值，
// 因此不能走 model.update()，必须单独调用此同步函数。
//
// 原函数在 @yohawing/three-mmd-loader/dist/runtime/morphSplitSync.js
//（MIT 许可，见 node_modules/@yohawing/three-mmd-loader/package.json）
// 因包主入口和 ./runtime 子路径均未导出此函数，此处本地实现（行为一致）。

import * as THREE from 'three';

function isSkinnedMesh(value: unknown): value is THREE.SkinnedMesh {
  return (
    value instanceof THREE.SkinnedMesh ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { isSkinnedMesh?: boolean }).isSkinnedMesh === true)
  );
}

/**
 * 将 source.morphTargetInfluences 同步到 morph split 子几何体。
 * 行为与 @yohawing/three-mmd-loader 的 syncMorphSplitTargetInfluences 一致。
 */
export function syncMorphSplitTargetInfluences(source: THREE.SkinnedMesh): void {
  const sourceInfluences = source.morphTargetInfluences;
  if (!sourceInfluences) {
    return;
  }
  const bodyMeshes = (source.userData as { mmdMorphSplitBodyMeshes?: unknown }).mmdMorphSplitBodyMeshes;
  if (!Array.isArray(bodyMeshes)) {
    return;
  }
  for (let bodyIndex = 0; bodyIndex < bodyMeshes.length; bodyIndex += 1) {
    const body = bodyMeshes[bodyIndex];
    if (!isSkinnedMesh(body)) {
      continue;
    }
    const split = (body.userData as { mmdMorphSplitBody?: { morphTargetIndices?: ArrayLike<number> } }).mmdMorphSplitBody;
    const morphTargetIndices = split?.morphTargetIndices;
    const targetInfluences = body.morphTargetInfluences;
    if (!morphTargetIndices || !targetInfluences) {
      continue;
    }
    for (let index = 0; index < morphTargetIndices.length; index += 1) {
      const sourceIndex = morphTargetIndices[index] ?? -1;
      targetInfluences[index] = sourceInfluences[sourceIndex] ?? 0;
    }
  }
}
