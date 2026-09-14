import { describe, expect, it } from 'vitest';
import { MotionRequestGate, MotionRequestSupersededError } from '../../src/motion/motion-request-gate';

describe('MotionRequestGate', () => {
  it('only considers the most recent token current', () => {
    const gate = new MotionRequestGate();
    const first = gate.next();
    const second = gate.next();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it('invalidate supersedes the current token without creating a playable request', () => {
    const gate = new MotionRequestGate();
    const token = gate.next();

    gate.invalidate();

    expect(gate.isCurrent(token)).toBe(false);
  });

  it('assertCurrent throws a typed superseded error for an old async request', () => {
    const gate = new MotionRequestGate();
    const oldToken = gate.next();
    gate.next();

    expect(() => gate.assertCurrent(oldToken)).toThrow(MotionRequestSupersededError);
    expect(() => gate.assertCurrent(oldToken)).toThrow('motion request superseded');
  });
});
