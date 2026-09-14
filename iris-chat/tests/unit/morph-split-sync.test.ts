import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { syncMorphSplitTargetInfluences } from '../../src/actor/morph-split-sync';

/**
 * syncMorphSplitTargetInfluences 单元测试
 *
 * 验证本地实现的 morph split 同步行为：
 * 1. 无 morphTargetInfluences 时 no-op
 * 2. 无 mmdMorphSplitBodyMeshes 时 no-op
 * 3. 将 source.morphTargetInfluences 同步到 body meshes 的 targetInfluences
 * 4. 跳过非 SkinnedMesh 的条目
 * 5. 缺失 morphTargetIndices/targetInfluences 时跳过
 *
 * 此函数是 Step 4.2 E2E 像素差 = 0 修复的关键：
 * @yohawing/three-mmd-loader 把稀疏顶点 morph 拆分到 per-material body meshes，
 * 实际渲染的是这些子几何体。setWeight 写入主 mesh.morphTargetInfluences 后，
 * 必须调用此函数同步到子几何体，否则像素无变化。
 */
describe('syncMorphSplitTargetInfluences', () => {
  it('mesh 无 morphTargetInfluences 时 no-op（不抛错）', () => {
    const mesh = new THREE.SkinnedMesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial()
    );
    // mesh.morphTargetInfluences 默认 undefined
    expect(() => syncMorphSplitTargetInfluences(mesh)).not.toThrow();
  });

  it('userData 无 mmdMorphSplitBodyMeshes 时 no-op', () => {
    const mesh = new THREE.SkinnedMesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial()
    );
    mesh.morphTargetInfluences = [0.5, 0.2];
    // userData.mmdMorphSplitBodyMeshes 未设置
    expect(() => syncMorphSplitTargetInfluences(mesh)).not.toThrow();
  });

  it('mmdMorphSplitBodyMeshes 不是数组时 no-op', () => {
    const mesh = new THREE.SkinnedMesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial()
    );
    mesh.morphTargetInfluences = [0.5];
    (mesh.userData as { mmdMorphSplitBodyMeshes?: unknown }).mmdMorphSplitBodyMeshes = 'not-an-array';
    expect(() => syncMorphSplitTargetInfluences(mesh)).not.toThrow();
  });

  it('将 source.morphTargetInfluences 同步到 body mesh 的 targetInfluences', () => {
    // 主 mesh：2 个 morph，权重 [0.7, 0.3]
    const sourceGeometry = new THREE.BufferGeometry();
    // 添加 position attribute（SkinnedMesh 需要）
    sourceGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const source = new THREE.SkinnedMesh(sourceGeometry, new THREE.MeshBasicMaterial());
    source.morphTargetInfluences = [0.7, 0.3];
    source.morphTargetDictionary = { 'あ': 0, 'い': 1 };

    // body mesh：1 个 morph slot，映射到 source 的 morph 0
    const bodyGeometry = new THREE.BufferGeometry();
    bodyGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const body = new THREE.SkinnedMesh(bodyGeometry, new THREE.MeshBasicMaterial());
    body.morphTargetInfluences = [0]; // 初始 0
    (body.userData as { mmdMorphSplitBody?: unknown }).mmdMorphSplitBody = {
      morphTargetIndices: [0] // 映射到 source 的第 0 个 morph
    };

    (source.userData as { mmdMorphSplitBodyMeshes?: unknown }).mmdMorphSplitBodyMeshes = [body];

    syncMorphSplitTargetInfluences(source);

    // body 的 targetInfluences[0] 应该被同步为 source 的第 0 个 morph 权重 0.7
    expect(body.morphTargetInfluences![0]).toBeCloseTo(0.7, 5);
  });

  it('多个 body meshes 都被同步', () => {
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const source = new THREE.SkinnedMesh(sourceGeometry, new THREE.MeshBasicMaterial());
    source.morphTargetInfluences = [0.4, 0.8];
    source.morphTargetDictionary = { 'あ': 0, 'い': 1 };

    const makeBody = (mappedIndex: number): THREE.SkinnedMesh => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
      m.morphTargetInfluences = [0];
      (m.userData as { mmdMorphSplitBody?: unknown }).mmdMorphSplitBody = {
        morphTargetIndices: [mappedIndex]
      };
      return m;
    };

    const body0 = makeBody(0); // 映射到 source morph 0 = 0.4
    const body1 = makeBody(1); // 映射到 source morph 1 = 0.8

    (source.userData as { mmdMorphSplitBodyMeshes?: unknown }).mmdMorphSplitBodyMeshes = [body0, body1];

    syncMorphSplitTargetInfluences(source);

    expect(body0.morphTargetInfluences![0]).toBeCloseTo(0.4, 5);
    expect(body1.morphTargetInfluences![0]).toBeCloseTo(0.8, 5);
  });

  it('body 缺失 morphTargetIndices 时跳过（不抛错）', () => {
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const source = new THREE.SkinnedMesh(sourceGeometry, new THREE.MeshBasicMaterial());
    source.morphTargetInfluences = [0.5];

    const bodyGeometry = new THREE.BufferGeometry();
    bodyGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const body = new THREE.SkinnedMesh(bodyGeometry, new THREE.MeshBasicMaterial());
    body.morphTargetInfluences = [0];
    // 不设置 mmdMorphSplitBody.morphTargetIndices
    (body.userData as { mmdMorphSplitBody?: unknown }).mmdMorphSplitBody = {};

    (source.userData as { mmdMorphSplitBodyMeshes?: unknown }).mmdMorphSplitBodyMeshes = [body];

    expect(() => syncMorphSplitTargetInfluences(source)).not.toThrow();
    // body 权重保持原值（未被同步）
    expect(body.morphTargetInfluences![0]).toBe(0);
  });

  it('body 缺失 morphTargetInfluences 时跳过', () => {
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const source = new THREE.SkinnedMesh(sourceGeometry, new THREE.MeshBasicMaterial());
    source.morphTargetInfluences = [0.5];

    const bodyGeometry = new THREE.BufferGeometry();
    bodyGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const body = new THREE.SkinnedMesh(bodyGeometry, new THREE.MeshBasicMaterial());
    // 不设置 morphTargetInfluences（undefined）
    (body.userData as { mmdMorphSplitBody?: unknown }).mmdMorphSplitBody = {
      morphTargetIndices: [0]
    };

    (source.userData as { mmdMorphSplitBodyMeshes?: unknown }).mmdMorphSplitBodyMeshes = [body];

    expect(() => syncMorphSplitTargetInfluences(source)).not.toThrow();
    // body.morphTargetInfluences 仍为 undefined
    expect(body.morphTargetInfluences).toBeUndefined();
  });

  it('数组中包含非 SkinnedMesh 条目时跳过', () => {
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const source = new THREE.SkinnedMesh(sourceGeometry, new THREE.MeshBasicMaterial());
    source.morphTargetInfluences = [0.5];

    // 非 SkinnedMesh 条目（普通 Object3D）
    const notAMesh = new THREE.Object3D();

    const bodyGeometry = new THREE.BufferGeometry();
    bodyGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const body = new THREE.SkinnedMesh(bodyGeometry, new THREE.MeshBasicMaterial());
    body.morphTargetInfluences = [0];
    (body.userData as { mmdMorphSplitBody?: unknown }).mmdMorphSplitBody = {
      morphTargetIndices: [0]
    };

    (source.userData as { mmdMorphSplitBodyMeshes?: unknown }).mmdMorphSplitBodyMeshes = [notAMesh, body];

    expect(() => syncMorphSplitTargetInfluences(source)).not.toThrow();
    // body 仍被同步（跳过 notAMesh）
    expect(body.morphTargetInfluences![0]).toBeCloseTo(0.5, 5);
  });

  it('支持 isSkinnedMesh 标记的对象（duck-typing）', () => {
    const sourceGeometry = new THREE.BufferGeometry();
    sourceGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const source = new THREE.SkinnedMesh(sourceGeometry, new THREE.MeshBasicMaterial());
    source.morphTargetInfluences = [0.6];

    // 模拟一个带 isSkinnedMesh 标记但不是 THREE.SkinnedMesh 实例的对象
    //（某些库可能用自定义类实现相同接口）
    const fakeBody = {
      isSkinnedMesh: true,
      userData: {
        mmdMorphSplitBody: { morphTargetIndices: [0] }
      },
      morphTargetInfluences: [0]
    };

    (source.userData as { mmdMorphSplitBodyMeshes?: unknown }).mmdMorphSplitBodyMeshes = [fakeBody];

    expect(() => syncMorphSplitTargetInfluences(source)).not.toThrow();
    expect(fakeBody.morphTargetInfluences[0]).toBeCloseTo(0.6, 5);
  });
});
