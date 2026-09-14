import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ModelUserFacingController } from '../../src/desktop-avatar/model-user-facing-controller';

describe('ModelUserFacingController', () => {
  it('turns a model moved to the right gently toward the centered user', () => {
    const root = new THREE.Object3D();
    root.position.set(8, 0, 0);
    const controller = new ModelUserFacingController(root.quaternion);

    const target = controller.setUserWorldPosition(root.position, new THREE.Vector3(0, 8, 30));
    expect(target).toBeLessThan(0);

    controller.advance(root.quaternion, 1 / 60);
    expect(controller.getCurrentYaw()).toBeLessThan(0);
    expect(Math.abs(controller.getCurrentYaw())).toBeLessThan(Math.abs(target));

    for (let frame = 0; frame < 180; frame += 1) controller.advance(root.quaternion, 1 / 60);
    expect(controller.getCurrentYaw()).toBeCloseTo(target, 3);
  });

  it('keeps the whole-body turn restrained and returns to center smoothly', () => {
    const root = new THREE.Object3D();
    const controller = new ModelUserFacingController(root.quaternion);

    controller.setUserWorldPosition(new THREE.Vector3(100, 0, 0), new THREE.Vector3(0, 0, 1));
    for (let frame = 0; frame < 180; frame += 1) controller.advance(root.quaternion, 1 / 60);
    expect(Math.abs(controller.getCurrentYaw())).toBeLessThanOrEqual(THREE.MathUtils.degToRad(14) + 1e-6);

    controller.setUserWorldPosition(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 30));
    const before = Math.abs(controller.getCurrentYaw());
    controller.advance(root.quaternion, 1 / 60);
    expect(Math.abs(controller.getCurrentYaw())).toBeLessThan(before);
    expect(Math.abs(controller.getCurrentYaw())).toBeGreaterThan(0);
  });

  it('preserves the root base pose while adding user-facing yaw', () => {
    const root = new THREE.Object3D();
    root.rotation.set(0.05, 0, -0.03);
    const base = root.quaternion.clone();
    const controller = new ModelUserFacingController(base);
    controller.setUserWorldPosition(new THREE.Vector3(-5, 0, 0), new THREE.Vector3(0, 0, 30));
    for (let frame = 0; frame < 180; frame += 1) controller.advance(root.quaternion, 1 / 60);

    const expected = base.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), controller.getCurrentYaw())
    );
    expect(root.quaternion.angleTo(expected)).toBeLessThan(1e-6);
  });
});
