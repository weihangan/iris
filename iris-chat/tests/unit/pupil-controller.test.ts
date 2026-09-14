import { describe, expect, it } from 'vitest';
import { MorphController } from '../../src/actor/morph-controller';
import { PupilController } from '../../src/actor/pupil-controller';

describe('PupilController', () => {
  it('drives Selena pupil size morphs from speech semantics and returns to idle life on stop', () => {
    const morphs = new MorphController(['瞳小', '瞳大']);
    const controller = new PupilController(morphs);
    controller.startSpeaking('surprised');
    for (let index = 0; index < 40; index += 1) controller.update(0.05);
    expect(morphs.getWeight('瞳大')).toBeGreaterThan(0.18);
    expect(morphs.getWeight('瞳小')).toBeLessThan(0.02);

    controller.setSemantic('thinking');
    for (let index = 0; index < 40; index += 1) controller.update(0.05);
    expect(morphs.getWeight('瞳小')).toBeLessThan(0.04);
    expect(morphs.getWeight('瞳大')).toBeGreaterThan(0.02);
    expect(morphs.getWeight('瞳大')).toBeLessThan(0.12);

    controller.stopSpeaking();
    for (let index = 0; index < 40; index += 1) controller.update(0.05);
    expect(morphs.getWeight('瞳大')).toBeGreaterThan(0.04);
    expect(morphs.getWeight('瞳大')).toBeLessThan(0.2);
  });

  it('uses the available small-pupil morph on Yangyang without borrowing Selena morphs', () => {
    const morphs = new MorphController(['瞳小']);
    const controller = new PupilController(morphs);
    controller.startSpeaking('concerned');
    for (let index = 0; index < 30; index += 1) controller.update(0.05);
    expect(morphs.getWeight('瞳小')).toBeLessThan(0.04);
    expect(morphs.getKnownMorphs()).not.toContain('瞳大');
  });

  it('keeps gentle and loving pupils close to normal with only a slow subtle pulse', () => {
    const morphs = new MorphController(['瞳小', '瞳大']);
    const controller = new PupilController(morphs);
    controller.startSpeaking('loving');
    for (let index = 0; index < 40; index += 1) controller.update(0.05);
    const first = morphs.getWeight('瞳大');
    for (let index = 0; index < 30; index += 1) controller.update(0.05);
    const second = morphs.getWeight('瞳大');
    expect(first).toBeGreaterThan(0.02);
    expect(first).toBeLessThan(0.12);
    expect(second).toBeGreaterThan(0.02);
    expect(second).toBeLessThan(0.12);
    expect(Math.abs(second - first)).toBeLessThan(0.04);
  });

  it('keeps pupils slowly changing while idle', () => {
    const morphs = new MorphController(['瞳小', '瞳大']);
    const controller = new PupilController(morphs);
    for (let index = 0; index < 30; index += 1) controller.update(0.1);
    const first = morphs.getWeight('瞳大');
    for (let index = 0; index < 35; index += 1) controller.update(0.1);
    const second = morphs.getWeight('瞳大');

    expect(first).toBeGreaterThan(0.04);
    expect(second).toBeGreaterThan(0.04);
    expect(Math.abs(second - first)).toBeGreaterThan(0.005);
    expect(first).toBeLessThan(0.11);
    expect(second).toBeLessThan(0.11);
  });

  it('uses clearly different pupil ranges for surprise and concern', () => {
    const morphs = new MorphController(['瞳小', '瞳大']);
    const controller = new PupilController(morphs);
    controller.startSpeaking('surprised');
    for (let index = 0; index < 30; index += 1) controller.update(0.05);
    const surprisedLarge = morphs.getWeight('瞳大');

    controller.setSemantic('concerned');
    for (let index = 0; index < 30; index += 1) controller.update(0.05);
    const concernedSmall = morphs.getWeight('瞳小');

    expect(surprisedLarge).toBeGreaterThan(0.35);
    expect(concernedSmall).toBeLessThan(0.04);
  });

  it('simulates dilation by releasing the small-pupil morph when no large morph exists', () => {
    const morphs = new MorphController(['瞳小']);
    const controller = new PupilController(morphs);
    for (let index = 0; index < 30; index += 1) controller.update(0.1);
    const idleSmall = morphs.getWeight('瞳小');

    controller.startSpeaking('surprised');
    for (let index = 0; index < 30; index += 1) controller.update(0.05);
    const surprisedSmall = morphs.getWeight('瞳小');

    expect(idleSmall).toBeGreaterThan(0.006);
    expect(idleSmall).toBeLessThan(0.03);
    expect(surprisedSmall).toBeLessThan(0.04);
    expect(surprisedSmall).toBeLessThan(idleSmall * 0.6);
  });
});
