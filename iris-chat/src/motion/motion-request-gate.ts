export class MotionRequestSupersededError extends Error {
  constructor() {
    super('motion request superseded');
    this.name = 'MotionRequestSupersededError';
  }
}

export class MotionRequestGate {
  private generation = 0;

  next(): number {
    this.generation += 1;
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  assertCurrent(token: number): void {
    if (!this.isCurrent(token)) throw new MotionRequestSupersededError();
  }
}
