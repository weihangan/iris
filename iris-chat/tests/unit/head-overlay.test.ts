import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  HEAD_OVERLAY_DEFINITIONS,
  HeadOverlayController,
  resolveHeadOverlayId,
  resolveInwardHeadDirection,
  validateHeadOverlayTracks
} from '../../src/motion/head-overlay';

function angleDegrees(quaternion: THREE.Quaternion): number {
  return THREE.MathUtils.radToDeg(new THREE.Quaternion().angleTo(quaternion));
}

describe('head-only voice overlay', () => {
  it('routes only explicit formal head-overlay metadata', () => {
    expect(resolveHeadOverlayId({
      motionScope: 'head-overlay',
      headOverlayId: 'curious-left-tilt'
    })).toBe('curious-left-tilt');
    expect(resolveHeadOverlayId({
      motionScope: 'head-overlay',
      headOverlayId: 'unknown'
    })).toBeNull();
    expect(resolveHeadOverlayId({ headOverlayId: 'shy-right-down' })).toBeNull();
    expect(resolveHeadOverlayId({
      motionScope: 'head-overlay',
      headOverlayId: 'concerned-down'
    })).toBe('concerned-down');
    expect(resolveHeadOverlayId({
      motionScope: 'head-overlay',
      headOverlayId: 'remember-inward-up'
    })).toBe('remember-inward-up');
  });

  it('defines a character-left curious tilt near ten degrees', () => {
    const definition = HEAD_OVERLAY_DEFINITIONS['curious-left-tilt'];
    expect(THREE.MathUtils.radToDeg(definition.headEuler.z + definition.neckEuler.z))
      .toBeCloseTo(10, 5);
    expect(definition.headEuler.y).toBeGreaterThanOrEqual(0);
    expect(definition.allowedBones).toEqual(['首', '頭']);
  });

  it('defines a restrained concerned head-down pose in the PMX downward direction', () => {
    const definition = HEAD_OVERLAY_DEFINITIONS['concerned-down'];
    expect(THREE.MathUtils.radToDeg(definition.headEuler.x + definition.neckEuler.x))
      .toBeCloseTo(20, 5);
    expect(definition.headEuler.x).toBeGreaterThan(0);
    expect(definition.neckEuler.x).toBeGreaterThan(0);
    expect(definition.headEuler.y).toBe(0);
    expect(definition.neckEuler.y).toBe(0);
  });

  it('resolves display-inward direction with a stable center dead zone', () => {
    expect(resolveInwardHeadDirection({
      avatarCenterX: 200,
      displayLeft: 0,
      displayWidth: 1920,
      lastStable: -1
    })).toBe(1);
    expect(resolveInwardHeadDirection({
      avatarCenterX: 1700,
      displayLeft: 0,
      displayWidth: 1920,
      lastStable: 1
    })).toBe(-1);
    expect(resolveInwardHeadDirection({
      avatarCenterX: 960,
      displayLeft: 0,
      displayWidth: 1920,
      lastStable: -1
    })).toBe(-1);
  });

  it('snapshots recall direction and tuning when the action starts', () => {
    const controller = new HeadOverlayController();
    controller.start('remember-inward-up', { inwardDirection: 1, rotationScale: 1.2 });
    controller.advance(2);
    const towardScreenRight = controller.deltaFor('頭');
    controller.stop();
    controller.start('remember-inward-up', { inwardDirection: -1, rotationScale: 1.2 });
    controller.advance(2);
    const towardScreenLeft = controller.deltaFor('頭');
    const rightEuler = new THREE.Euler().setFromQuaternion(towardScreenRight, 'XYZ');
    const leftEuler = new THREE.Euler().setFromQuaternion(towardScreenLeft, 'XYZ');

    expect(rightEuler.x).toBeLessThan(0);
    expect(leftEuler.x).toBeLessThan(0);
    expect(Math.sign(rightEuler.y)).toBe(-Math.sign(leftEuler.y));
    expect(Math.abs(rightEuler.y)).toBeGreaterThan(THREE.MathUtils.degToRad(8));
  });

  it('rejects every non-head track, translation, and morph channel', () => {
    const identityTrack = {
      frameNumbers: new Uint32Array([0, 30]),
      translations: new Float32Array(6),
      rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
      physicsToggles: new Int8Array([-1, -1])
    };
    expect(validateHeadOverlayTracks({
      boneTracks: { '首': identityTrack, '頭': identityTrack },
      morphTracks: {}
    })).toEqual({ valid: true, reasons: [] });
    expect(validateHeadOverlayTracks({
      boneTracks: { '頭': identityTrack, '左足': identityTrack },
      morphTracks: {}
    }).valid).toBe(false);
    expect(validateHeadOverlayTracks({
      boneTracks: {
        '頭': { ...identityTrack, translations: new Float32Array([0, 0, 0, 0.01, 0, 0]) }
      },
      morphTracks: {}
    }).valid).toBe(false);
    expect(validateHeadOverlayTracks({
      boneTracks: { '頭': identityTrack },
      morphTracks: { '笑い': { frameNumbers: new Uint32Array([0]), weights: new Float32Array([1]) } }
    }).valid).toBe(false);
  });

  it('eases from the current sampled pose and returns exactly to it', () => {
    const controller = new HeadOverlayController();
    controller.start('curious-left-tilt');
    const base = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.04, -0.03, 0.02));
    const atStart = controller.compose('頭', base);
    expect(atStart.angleTo(base)).toBeLessThan(1e-8);

    controller.advance(1.2);
    const active = controller.compose('頭', base);
    expect(THREE.MathUtils.radToDeg(active.angleTo(base))).toBeGreaterThan(5);
    expect(THREE.MathUtils.radToDeg(active.angleTo(base))).toBeLessThanOrEqual(10.001);

    controller.advance(10);
    const atEnd = controller.compose('頭', base);
    expect(atEnd.angleTo(base)).toBeLessThan(1e-8);
    expect(controller.isActive()).toBe(false);
  });

  it('never changes body bones or local translations', () => {
    const controller = new HeadOverlayController();
    controller.start('curious-left-tilt');
    controller.advance(1.5);
    const body = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, 0.3));
    expect(controller.compose('上半身', body).toArray()).toEqual(body.toArray());
    expect(controller.translationFor('頭')).toEqual([0, 0, 0]);
  });

  it('feeds a restrained head impulse to secondary physics without matching the visual turn', () => {
    const controller = new HeadOverlayController();
    controller.start('remember-inward-up');
    controller.advance(2.2);

    const visual = controller.deltaFor('頭');
    const physics = controller.deltaForPhysics('頭');
    const visualAngle = angleDegrees(visual);
    const physicsAngle = angleDegrees(physics);

    expect(visualAngle).toBeGreaterThan(10);
    expect(physicsAngle).toBeGreaterThan(0.5);
    expect(physicsAngle).toBeLessThan(visualAngle * 0.5);
  });
});
