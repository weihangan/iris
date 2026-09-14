import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createViewerControls } from '../../src/desktop-avatar/viewer-controls';

function createTestOptions(overrides: Partial<{
  root: THREE.Object3D;
  mesh: THREE.SkinnedMesh;
  camera: THREE.PerspectiveCamera;
  bounds: THREE.Box3;
  physicsAvailable: boolean;
}> = {}) {
  const root = overrides.root ?? new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshStandardMaterial();
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.morphTargetDictionary = {};
  mesh.morphTargetInfluences = [];

  // 构造骨架包含 頭 骨骼
  const headBone = new THREE.Bone();
  headBone.name = '頭';
  headBone.position.set(0, 1.5, 0);
  const rootBone = new THREE.Bone();
  rootBone.name = '全ての親';
  rootBone.add(headBone);
  mesh.add(rootBone);
  mesh.skeleton = new THREE.Skeleton([rootBone, headBone]);

  const camera = overrides.camera ?? new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const bounds = overrides.bounds ?? new THREE.Box3(
    new THREE.Vector3(-1, 0, -0.5),
    new THREE.Vector3(1, 2, 0.5)
  );

  const render = vi.fn();

  return {
    options: {
      root,
      mesh,
      camera,
      bounds,
      render,
      physicsAvailable: overrides.physicsAvailable ?? false,
      onPhysicsChanged: vi.fn()
    },
    render
  };
}

describe('ViewerControls（Task 4）', () => {
  it('setScale 钳制到 0.4-1.6 范围', () => {
    const { options, render } = createTestOptions();
    const controls = createViewerControls(options);

    expect(controls.setScale(0.1)).toBe(0.4);
    expect(options.root.scale.x).toBe(0.4);

    expect(controls.setScale(2)).toBe(1.6);
    expect(options.root.scale.x).toBe(1.6);

    expect(controls.setScale(1)).toBe(1);
    expect(options.root.scale.x).toBe(1);

    expect(render).toHaveBeenCalled();
  });

  it('setAngle("face") 用头骨定位镜头，距离让整个面部可见', () => {
    const { options } = createTestOptions();
    const controls = createViewerControls(options);

    const ok = controls.setAngle('face');
    expect(ok).toBe(true);
    // 头骨在 (0, 1.5, 0)，相机应位于头骨前方
    expect(options.camera.position.x).toBeCloseTo(0, 5);
    expect(options.camera.position.y).toBeCloseTo(1.5, 5);
    expect(options.camera.position.z).toBeGreaterThan(0);

    // Phase 3 收口修复：face 镜头距离必须让整个面部（头顶到下巴）可见
    // 不能是鼻口特写。头部高度约模型高度的 1/6（约 0.33），
    // FOV 30 度时，要让头部占画面约 60%，距离 = (headHeight / 0.6) / (2 * tan(15°))
    // 头部高度 ~0.33，距离应 > 1.0，且 < full 镜头距离
    const faceDistance = options.camera.position.z;
    expect(faceDistance).toBeGreaterThan(1.0);

    // face 镜头应比 full 镜头近，但不能是特写
    controls.setAngle('full');
    const fullDistance = options.camera.position.z;
    expect(faceDistance).toBeLessThan(fullDistance);

    // 关键断言：face 镜头下，画面可见高度应至少容纳整个头部（~0.5）
    // 可见高度 = 2 * distance * tan(fov/2)
    const fov = THREE.MathUtils.degToRad(options.camera.fov);
    const visibleHeight = 2 * faceDistance * Math.tan(fov / 2);
    expect(visibleHeight).toBeGreaterThan(0.5);
  });

  it('setAngle("full") 距离比 front 更远（更大 margin）', () => {
    const { options } = createTestOptions();
    const controls = createViewerControls(options);

    controls.setAngle('front');
    const frontDistance = options.camera.position.z;

    controls.setAngle('full');
    const fullDistance = options.camera.position.z;

    expect(fullDistance).toBeGreaterThan(frontDistance);
  });

  it('setAngle("side") 相机位于模型侧方', () => {
    const { options } = createTestOptions();
    const controls = createViewerControls(options);

    const ok = controls.setAngle('side');
    expect(ok).toBe(true);
    expect(options.camera.position.x).toBeGreaterThan(0);
    expect(options.camera.position.z).toBeCloseTo(0, 5);
  });

  it('setAngle 未知角度返回 false', () => {
    const { options } = createTestOptions();
    const controls = createViewerControls(options);

    // @ts-expect-error 测试未知角度
    expect(controls.setAngle('unknown')).toBe(false);
  });

  it('resetCamera 复位到正面全身视角', () => {
    const { options } = createTestOptions();
    const controls = createViewerControls(options);

    // 先移到别处
    options.camera.position.set(10, 10, 10);
    controls.resetCamera();

    // 复位后应在中心前方
    expect(options.camera.position.x).toBeCloseTo(0, 5);
    expect(options.camera.position.z).toBeGreaterThan(0);
  });

  it('半身视角使用更远的镜头而不缩放 PMX 根节点', () => {
    const { options } = createTestOptions();
    const controls = createViewerControls(options);

    controls.setViewMode('half');

    // 半身预设等于滚轮向下三档，避免直接 root scale 破坏 MMD 物理骨骼。
    expect(controls.getZoom()).toBeCloseTo(0.78, 5);
    expect(options.root.scale.x).toBeCloseTo(1, 5);
    expect(options.camera.position.z).toBeGreaterThan(0);
  });

  it('setTexturesEnabled(false) 移除材质 map', () => {
    const { options } = createTestOptions();
    const materials = Array.isArray(options.mesh.material)
      ? options.mesh.material
      : [options.mesh.material];
    const tex = new THREE.Texture();
    (materials[0] as THREE.MeshStandardMaterial).map = tex;

    const controls = createViewerControls(options);
    controls.setTexturesEnabled(false);

    expect((materials[0] as THREE.MeshStandardMaterial).map).toBeNull();

    controls.setTexturesEnabled(true);
    expect((materials[0] as THREE.MeshStandardMaterial).map).toBe(tex);
  });

  it('setPhysicsEnabled backend 不可用时返回 false', () => {
    const { options } = createTestOptions({ physicsAvailable: false });
    const controls = createViewerControls(options);

    expect(controls.setPhysicsEnabled(true)).toBe(false);
    expect(options.onPhysicsChanged).not.toHaveBeenCalled();
  });

  it('setPhysicsEnabled backend 可用时返回 true 并通知', () => {
    const { options } = createTestOptions({ physicsAvailable: true });
    const controls = createViewerControls(options);

    expect(controls.setPhysicsEnabled(true)).toBe(true);
    expect(options.onPhysicsChanged).toHaveBeenCalledWith(true);

    expect(controls.setPhysicsEnabled(false)).toBe(true);
    expect(options.onPhysicsChanged).toHaveBeenCalledWith(false);
  });

  it('isPhysicsAvailable 反映 backend 状态', () => {
    const { options: opts1 } = createTestOptions({ physicsAvailable: false });
    expect(createViewerControls(opts1).isPhysicsAvailable()).toBe(false);

    const { options: opts2 } = createTestOptions({ physicsAvailable: true });
    expect(createViewerControls(opts2).isPhysicsAvailable()).toBe(true);
  });
});
