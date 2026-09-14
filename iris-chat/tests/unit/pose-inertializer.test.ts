import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PoseInertializer, type LocalBonePose } from '../../src/motion/pose-inertializer';

function pose(degrees: number, position: readonly [number, number, number] = [0, 0, 0]): LocalBonePose {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(degrees));
  return { quaternion: [q.x, q.y, q.z, q.w], position };
}

function quaternionOf(value: LocalBonePose): THREE.Quaternion {
  return new THREE.Quaternion(...value.quaternion);
}

describe('PoseInertializer', () => {
  it('keeps the captured visible pose on the first target sample', () => {
    const inertializer = new PoseInertializer();
    const previous = pose(39);
    const current = pose(40);
    const target = pose(0);

    inertializer.begin(current, previous, target, 1 / 60, 0.8);
    const first = inertializer.sample(target, 0);

    expect(quaternionOf(first).angleTo(quaternionOf(current))).toBeLessThan(1e-6);
  });

  it('uses the short quaternion arc when source and target straddle 180 degrees', () => {
    const inertializer = new PoseInertializer();
    const previous = pose(169);
    const current = pose(170);
    const target = pose(-170);

    inertializer.begin(current, previous, target, 1 / 60, 0.2);
    const middle = inertializer.sample(target, 0.1);

    // The source-to-target distance is 20 degrees, never a 340-degree spin.
    expect(quaternionOf(middle).angleTo(quaternionOf(target))).toBeLessThan(THREE.MathUtils.degToRad(20.1));
    expect(quaternionOf(middle).angleTo(quaternionOf(current))).toBeLessThan(THREE.MathUtils.degToRad(20.1));
  });

  it('converges to the target with a finite normalized quaternion', () => {
    const inertializer = new PoseInertializer();
    const target = pose(-15);
    inertializer.begin(pose(65), pose(64), target, 1 / 60, 0.25);

    let result = target;
    for (let i = 0; i < 20; i += 1) result = inertializer.sample(target, 1 / 60);

    const q = quaternionOf(result);
    expect(q.angleTo(quaternionOf(target))).toBeLessThan(1e-6);
    expect(q.length()).toBeCloseTo(1, 6);
    expect(inertializer.active).toBe(false);
  });

  it('does not blend local translations unless explicitly enabled', () => {
    const inertializer = new PoseInertializer();
    const current = pose(0, [5, 4, 3]);
    const target = pose(0, [0, 0, 0]);

    inertializer.begin(current, current, target, 1 / 60, 0.4);
    const result = inertializer.sample(target, 0);

    expect(result.position).toEqual([0, 0, 0]);
  });
});
