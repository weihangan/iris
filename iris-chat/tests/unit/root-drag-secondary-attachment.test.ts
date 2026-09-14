import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  RootDragSecondaryAttachmentController,
  selectRootDragAttachmentBones
} from '../../src/physics/root-drag-secondary-attachment';

function rootLocalPosition(root: THREE.Object3D, bone: THREE.Bone): THREE.Vector3 {
  root.updateWorldMatrix(true, true);
  bone.updateWorldMatrix(true, false);
  return new THREE.Vector3()
    .setFromMatrixPosition(bone.matrixWorld)
    .applyMatrix4(new THREE.Matrix4().copy(root.matrixWorld).invert());
}

function rootLocalRotation(root: THREE.Object3D, bone: THREE.Bone): THREE.Quaternion {
  root.updateWorldMatrix(true, true);
  bone.updateWorldMatrix(true, false);
  const matrix = new THREE.Matrix4()
    .copy(root.matrixWorld)
    .invert()
    .multiply(bone.matrixWorld);
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);
  return rotation;
}

describe('RootDragSecondaryAttachmentController', () => {
  it('uses the authored settle tail when the desktop drag pointer is released', () => {
    const rendererSource = readFileSync(resolve('src', 'desktop-avatar-renderer.ts'), 'utf8');
    expect(rendererSource).toContain('dragSecondaryAttachment.end();');
  });

  it('rebuilds Bullet after the drag settle tail only when a skirt fold is detected', () => {
    const rendererSource = readFileSync(resolve('src', 'desktop-avatar-renderer.ts'), 'utf8');
    // 恢复性物理重置仍然存在：拖拽 settle 尾巴结束后按当前动画姿态重建 Bullet 世界。
    expect(rendererSource).toContain('pendingDragKinkRecovery');
    expect(rendererSource).toContain('requestHardReset');
    // 但现在是条件触发：仅在守卫样本中"被持续推越界"的骨骼占比达到阈值（折叠/Z 形）
    // 时才重建世界；正常回摆不重置，避免清零长发动量、把甩动峰值推迟到 >1s。
    expect(rendererSource).toContain('KINK_FOLD_RATIO_THRESHOLD');
    expect(rendererSource).toContain('kinkFoldedBoneSamples / Math.max(1, kinkSampleBoneCount)');
  });

  it('reads the shared backend envelope at apply time instead of caching startup state', () => {
    const root = new THREE.Group();
    const hair = new THREE.Bone();
    root.add(hair);
    let envelope = 0.04;
    const controller = new RootDragSecondaryAttachmentController(root, [hair], {
      getMaxRootLocalTranslation: () => envelope
    });
    controller.begin();
    hair.position.x = 1;
    controller.apply(1 / 60);
    expect(rootLocalPosition(root, hair).x).toBeCloseTo(0.04, 6);

    envelope = 0.01;
    hair.position.x = 1;
    controller.apply(1 / 60);
    expect(rootLocalPosition(root, hair).x).toBeCloseTo(0.01, 6);
  });

  it('selects only body-connected dynamic roots and leaves chain descendants free', () => {
    const root = new THREE.Group();
    const body = new THREE.Bone();
    const hairRoot = new THREE.Bone();
    const hairMid = new THREE.Bone();
    const hairTip = new THREE.Bone();
    root.add(body);
    body.add(hairRoot);
    hairRoot.add(hairMid);
    hairMid.add(hairTip);
    const dynamic = new Set([hairRoot, hairMid, hairTip]);

    expect(selectRootDragAttachmentBones(
      [body, hairRoot, hairMid, hairTip],
      bone => dynamic.has(bone)
    )).toEqual([hairRoot]);
  });

  it('keeps final rendered secondary bones inside the drag attachment envelope', () => {
    const root = new THREE.Group();
    const meshParent = new THREE.Group();
    const hairRoot = new THREE.Bone();
    const hairTip = new THREE.Bone();
    hairRoot.position.set(0, 10, 0);
    hairTip.position.set(0, -2, 0);
    root.add(meshParent);
    meshParent.add(hairRoot);
    hairRoot.add(hairTip);
    const controller = new RootDragSecondaryAttachmentController(root, [hairRoot, hairTip]);
    const before = rootLocalPosition(root, hairTip);
    const beforeRotation = rootLocalRotation(root, hairTip);

    controller.begin();
    root.position.set(4, -1, 0);
    hairRoot.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.8);
    hairTip.position.x = -3;
    root.updateWorldMatrix(true, true);
    expect(controller.apply(1 / 60)).toBe(true);

    const after = rootLocalPosition(root, hairTip);
    expect(after.distanceTo(before)).toBeLessThanOrEqual(0.040001);
    expect(rootLocalRotation(root, hairTip).angleTo(beforeRotation)).toBeCloseTo(0.35, 6);
  });

  it('does not alter ordinary secondary motion outside a root drag', () => {
    const root = new THREE.Group();
    const hair = new THREE.Bone();
    root.add(hair);
    const controller = new RootDragSecondaryAttachmentController(root, [hair]);
    hair.position.x = 2;

    expect(controller.apply(1 / 60)).toBe(false);
    expect(hair.position.x).toBe(2);
  });

  it('guards only anchor bones and leaves dynamic descendants under Bullet ownership', () => {
    const root = new THREE.Group();
    const anchor = new THREE.Bone();
    const tip = new THREE.Bone();
    root.add(anchor);
    anchor.add(tip);
    const controller = new RootDragSecondaryAttachmentController(root, [anchor]);
    controller.begin();
    anchor.position.x = 1;
    tip.position.x = 3;

    expect(controller.apply(1 / 60)).toBe(true);
    expect(rootLocalPosition(root, anchor).x).toBeLessThanOrEqual(0.040001);
    expect(tip.position.x).toBe(3);
  });

  it('releases final-pose ownership immediately when the pointer is released', () => {
    const root = new THREE.Group();
    const hair = new THREE.Bone();
    root.add(hair);
    const controller = new RootDragSecondaryAttachmentController(root, [hair]);
    controller.begin();
    controller.releaseImmediately();
    hair.position.x = 2;

    expect(controller.apply(1 / 60)).toBe(false);
    expect(hair.position.x).toBe(2);
  });

  it('holds body-connected roots through the post-release physics tail', () => {
    const root = new THREE.Group();
    const hair = new THREE.Bone();
    root.add(hair);
    const controller = new RootDragSecondaryAttachmentController(root, [hair]);
    controller.begin();
    controller.end();

    // A fast root drag can leave Bullet carrying velocity for well beyond the
    // old half-second tail. The chain root must remain attached while that
    // motion dissipates; descendants are intentionally not part of this guard.
    for (let frame = 0; frame < 20; frame += 1) {
      hair.position.x = 1;
      controller.apply(0.05);
    }

    expect(rootLocalPosition(root, hair).x).toBeCloseTo(0.04, 6);
  });

});
