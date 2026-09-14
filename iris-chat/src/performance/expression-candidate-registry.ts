import type {
  AcceptedExpressionRecord,
  ExpressionCandidateRecord
} from './daily-candidate-types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class ExpressionCandidateRegistry {
  private readonly candidates = new Map<string, ExpressionCandidateRecord>();
  private readonly accepted = new Map<string, AcceptedExpressionRecord>();

  installCandidates(entries: readonly ExpressionCandidateRecord[]): void {
    const next = new Map<string, ExpressionCandidateRecord>();
    for (const entry of entries) {
      if (entry.automatic !== false) {
        throw new Error('Expression candidate must use automatic=false');
      }
      next.set(entry.id, clone(entry));
    }
    this.candidates.clear();
    for (const [id, entry] of next) this.candidates.set(id, entry);
  }

  installAccepted(entries: readonly AcceptedExpressionRecord[]): void {
    const next = new Map<string, AcceptedExpressionRecord>();
    for (const entry of entries) {
      if (entry.automatic !== true) {
        throw new Error('Accepted expression must use automatic=true');
      }
      next.set(entry.id, clone(entry));
    }
    this.accepted.clear();
    for (const [id, entry] of next) this.accepted.set(id, entry);
  }

  getCandidate(id: string): ExpressionCandidateRecord | undefined {
    const entry = this.candidates.get(id);
    return entry ? clone(entry) : undefined;
  }

  listCandidates(): readonly ExpressionCandidateRecord[] {
    return [...this.candidates.values()].map(clone);
  }

  listAccepted(): readonly AcceptedExpressionRecord[] {
    return [...this.accepted.values()].map(clone);
  }
}
