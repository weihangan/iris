import { describe, expect, it } from 'vitest';
import { ModelRootDragController } from '../../src/desktop-avatar/model-root-drag-controller';

describe('ModelRootDragController', () => {
  it('moves the model root toward a pointer target without a one-frame teleport', () => {
    const position = { x: 0, y: 0, z: 0 };
    const controller = new ModelRootDragController(position);

    controller.setTarget(3, -1.5, 0);
    controller.advance(position, 1 / 60);

    expect(position.x).toBeGreaterThan(0);
    expect(position.x).toBeLessThan(3);
    expect(position.y).toBeLessThan(0);
    expect(position.y).toBeGreaterThan(-1.5);

    for (let frame = 0; frame < 24; frame += 1) {
      controller.advance(position, 1 / 60);
    }

    expect(position.x).toBeCloseTo(3, 2);
    expect(position.y).toBeCloseTo(-1.5, 2);
  });

  it('keeps the displayed root continuous when the pointer reverses direction', () => {
    const position = { x: 0, y: 0, z: 0 };
    const controller = new ModelRootDragController(position, 0.08);

    controller.setTarget(2, 0, 0);
    for (let frame = 0; frame < 4; frame += 1) {
      controller.advance(position, 1 / 60);
    }
    const beforeReverse = position.x;

    controller.setTarget(-2, 0, 0);
    controller.advance(position, 1 / 60);

    expect(Math.abs(position.x - beforeReverse)).toBeLessThan(0.5);
    expect(position.x).toBeGreaterThan(-2);
  });

  it('tracks a short drag target responsively without teleporting', () => {
    const position = { x: 0, y: 0, z: 0 };
    const controller = new ModelRootDragController(position);

    controller.setTarget(3, 0, 0);
    for (let frame = 0; frame < 4; frame += 1) controller.advance(position, 1 / 60);

    expect(position.x).toBeGreaterThan(1.8);
    expect(position.x).toBeLessThan(3);
  });
});
