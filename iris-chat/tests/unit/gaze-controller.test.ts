import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BoneOwnershipRegistry } from '../../src/actor/bone-ownership-registry';
import { GazeController } from '../../src/actor/gaze-controller';

function bones() {
  return {
    bothEyes: new THREE.Bone(),
    head: new THREE.Bone(),
    neck: new THREE.Bone()
  };
}

describe('GazeController', () => {
  it('物理启用时只写眼球，不在 Bullet 之后改写头颈', () => {
    const gazeBones = bones();
    const controller = new GazeController(gazeBones);
    controller.setPhysicsEnabled(true);
    controller.setSemanticTarget('thinking');

    controller.update(0.2);

    expect(gazeBones.bothEyes.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0);
    expect(gazeBones.head.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    expect(gazeBones.neck.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
  });

  it('uses deterministic low-amplitude eye drift while speaking', () => {
    const makeController = () => {
      const eyes = new THREE.Bone();
      eyes.name = '両目';
      const head = new THREE.Bone();
      head.name = '頭';
      const neck = new THREE.Bone();
      neck.name = '首';
      return { controller: new GazeController({ bothEyes: eyes, head, neck }), eyes };
    };
    const first = makeController();
    const second = makeController();
    first.controller.setSemanticTarget('thinking');
    second.controller.setSemanticTarget('thinking');
    first.controller.startSpeaking();
    second.controller.startSpeaking();

    for (let index = 0; index < 120; index += 1) {
      first.controller.update(1 / 60);
      second.controller.update(1 / 60);
    }

    expect(first.eyes.quaternion.toArray()).toEqual(second.eyes.quaternion.toArray());
  });
  it('眼睛先于头颈接近目标', () => {
    const gazeBones = bones();
    const controller = new GazeController(gazeBones);
    controller.setSemanticTarget('thinking');
    controller.update(0.05);
    const eyeAngle = gazeBones.bothEyes.quaternion.angleTo(new THREE.Quaternion());
    const headAngle = gazeBones.head.quaternion.angleTo(new THREE.Quaternion());
    expect(eyeAngle).toBeGreaterThan(headAngle);
  });

  it('keeps the screen-center focus while speaking semantics change', () => {
    const controller = new GazeController(bones());
    const screenFocus = controller.setScreenCenterTarget(720, 780, 960, 540);
    controller.startSpeaking();
    controller.setSpeakingSemantic('shy');
    expect(controller.getFocusTarget()).toEqual(screenFocus);
    controller.setSpeakingSemantic('concerned');
    expect(controller.getFocusTarget()).toEqual(screenFocus);
  });

  it('uses only the residual eye angle after the body has turned toward the user', () => {
    const controller = new GazeController(bones());
    const wholeTarget = controller.setScreenCenterTarget(1440, 540, 960, 540);
    const bodyYaw = wholeTarget.yaw * 0.6;
    const residual = controller.setScreenCenterTarget(1440, 540, 960, 540, bodyYaw);

    expect(Math.abs(residual.yaw)).toBeLessThan(Math.abs(wholeTarget.yaw));
    expect(residual.yaw).toBeCloseTo(wholeTarget.yaw - bodyYaw, 6);
  });

  it('keeps eyes on the user focus while gaze lock is enabled', () => {
    const gazeBones = bones();
    const controller = new GazeController(gazeBones);
    controller.setScreenCenterTarget(720, 780, 960, 540);
    controller.setFocusLocked(true);
    controller.startSpeaking();
    for (let index = 0; index < 240; index += 1) controller.update(1 / 60);

    const lockedPose = gazeBones.bothEyes.quaternion.clone();
    for (let index = 0; index < 240; index += 1) controller.update(1 / 60);
    expect(gazeBones.bothEyes.quaternion.angleTo(lockedPose)).toBeLessThan(0.01);
    expect(controller.isFocusLocked()).toBe(true);
  });

  it('creates a visible deterministic eye-led glance beat during neutral speech', () => {
    const gazeBones = bones();
    const controller = new GazeController(gazeBones);
    controller.setSemanticTarget('neutral');
    controller.startSpeaking();

    for (let index = 0; index < 120; index += 1) controller.update(1 / 60);

    const eyeAngle = gazeBones.bothEyes.quaternion.angleTo(new THREE.Quaternion());
    const headAngle = gazeBones.head.quaternion.angleTo(new THREE.Quaternion());
    expect(eyeAngle).toBeGreaterThan(0.1);
    expect(eyeAngle).toBeGreaterThan(headAngle);
  });

  it('limits automatic user-facing speech to one visible glance event', () => {
    const gazeBones = bones();
    const controller = new GazeController(gazeBones);
    controller.setSemanticTarget('neutral');
    controller.startSpeaking();
    let excursions = 0;
    let outside = false;
    for (let index = 0; index < 1500; index += 1) {
      controller.update(1 / 60);
      const nextOutside = gazeBones.bothEyes.quaternion.angleTo(new THREE.Quaternion()) > 0.05;
      if (nextOutside && !outside) excursions += 1;
      outside = nextOutside;
    }
    expect(excursions).toBeLessThanOrEqual(1);
  });

  it('falls back to synchronized left and right eye bones when both-eyes is absent', () => {
    const leftEye = new THREE.Bone();
    const rightEye = new THREE.Bone();
    const controller = new GazeController({ leftEye, rightEye });
    controller.startSpeaking();
    for (let index = 0; index < 140; index += 1) controller.update(1 / 60);

    expect(leftEye.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.1);
    expect(leftEye.quaternion.toArray()).toEqual(rightEye.quaternion.toArray());
  });

  it('returns both eyes to the user focus after speech stops', () => {
    const gazeBones = bones();
    const controller = new GazeController(gazeBones);
    controller.setScreenCenterTarget(760, 760, 960, 540);
    for (let index = 0; index < 120; index += 1) controller.update(1 / 60);
    const focused = gazeBones.bothEyes.quaternion.clone();

    controller.startSpeaking();
    for (let index = 0; index < 120; index += 1) controller.update(1 / 60);
    expect(gazeBones.bothEyes.quaternion.angleTo(focused)).toBeGreaterThan(0.05);

    controller.stopSpeaking();
    for (let index = 0; index < 120; index += 1) controller.update(1 / 60);
    expect(gazeBones.bothEyes.quaternion.angleTo(focused)).toBeLessThan(0.001);
  });

  it('VMD 持有头颈时只移动眼睛', () => {
    const gazeBones = bones();
    const ownership = new BoneOwnershipRegistry();
    ownership.claim('頭', 'vmd');
    ownership.claim('首', 'vmd');
    const controller = new GazeController(gazeBones, ownership);
    controller.setSemanticTarget('thinking');
    controller.update(0.2);
    expect(gazeBones.bothEyes.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0);
    expect(gazeBones.head.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
    expect(gazeBones.neck.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
  });

  it('幅度受限且 reset 回到中性', () => {
    const gazeBones = bones();
    const controller = new GazeController(gazeBones);
    controller.setTarget(10, 10);
    for (let i = 0; i < 20; i++) controller.update(0.05);
    expect(gazeBones.bothEyes.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(0.4);
    controller.reset();
    expect(gazeBones.bothEyes.quaternion.angleTo(new THREE.Quaternion())).toBe(0);
  });
});
