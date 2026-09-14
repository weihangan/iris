import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  CandidateStatus,
  CandidateKind,
  DailyPerformanceCandidate,
  DailyPerformanceCandidateFile
} from '../src/performance/daily-candidate-types';
import { DAILY_CANDIDATE_AUDIT_POLICY_VERSION } from '../src/performance/daily-candidate-types';

export interface DailyPerformanceCandidateStoreOptions {
  readonly catalogPath: string;
  readonly sourceRoot: string;
}

function readStrictJson<T>(path: string): T {
  const bytes = readFileSync(path);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`UTF-8 BOM is forbidden: ${path}`);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\uFFFD')) throw new Error(`UTF-8 replacement character is forbidden: ${path}`);
  return JSON.parse(text) as T;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

export class DailyPerformanceCandidateStore {
  private readonly catalogPath: string;
  private readonly sourceRoot: string;
  private records = new Map<string, DailyPerformanceCandidate>();

  constructor(options: DailyPerformanceCandidateStoreOptions) {
    this.catalogPath = resolve(options.catalogPath);
    this.sourceRoot = resolve(options.sourceRoot);
    if (existsSync(this.catalogPath)) this.load();
  }

  list(kind?: CandidateKind): DailyPerformanceCandidate[] {
    return Array.from(this.records.values())
      .filter(record => kind === undefined || record.kind === kind)
      .map(record => structuredClone(record));
  }

  listReviewable(kind?: CandidateKind): DailyPerformanceCandidate[] {
    return Array.from(this.records.values())
      .filter(record => (kind === undefined || record.kind === kind) && this.isReviewable(record))
      .map(record => structuredClone(record));
  }

  getReviewable(id: string): DailyPerformanceCandidate | undefined {
    const record = this.records.get(id);
    return record && this.isReviewable(record) ? structuredClone(record) : undefined;
  }

  getReviewablePair(id: string): DailyPerformanceCandidate | undefined {
    const pairId = this.getReviewable(id)?.pairId;
    return pairId ? this.getReviewable(pairId) : undefined;
  }

  get(id: string): DailyPerformanceCandidate | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  getPair(id: string): DailyPerformanceCandidate | undefined {
    const pairId = this.records.get(id)?.pairId;
    return pairId ? this.get(pairId) : undefined;
  }

  setStatus(id: string, status: CandidateStatus): void {
    const current = this.records.get(id);
    if (!current) throw new Error(`candidate not found: ${id}`);
    const entries = [...this.records.values()].map(record =>
      record.id === id ? { ...record, status } : record
    );
    this.replaceAll(entries);
  }

  remove(id: string): boolean {
    const current = this.records.get(id);
    if (!current) return false;
    const entries = [...this.records.values()]
      .filter(record => record.id !== id)
      .map(record => record.pairId === id ? { ...record, pairId: undefined } : record);
    this.replaceAll(entries);
    return true;
  }

  removeBySourceUrlPrefix(prefix: string): number {
    const normalizedPrefix = prefix.trim();
    if (!normalizedPrefix) throw new Error('source URL prefix is required');
    const removedIds = new Set(
      [...this.records.values()]
        .filter(record => record.source.sourceUrl.startsWith(normalizedPrefix))
        .map(record => record.id)
    );
    if (removedIds.size === 0) return 0;
    const entries = [...this.records.values()]
      .filter(record => !removedIds.has(record.id))
      .map(record => removedIds.has(record.pairId ?? '') ? { ...record, pairId: undefined } : record);
    this.replaceAll(entries);
    return removedIds.size;
  }

  replaceAll(entries: readonly DailyPerformanceCandidate[]): void {
    const validated = this.validateEntries(entries);
    this.write({ schemaVersion: 1, entries: validated });
    this.records = new Map(validated.map(record => [record.id, record]));
  }

  verifySource(id: string, sourceBytes?: Uint8Array): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`candidate not found: ${id}`);
    const absolutePath = this.resolveSourcePath(record.source.sourceRelativePath);
    const bytes = sourceBytes ?? new Uint8Array(readFileSync(absolutePath));
    const actual = sha256(bytes);
    if (!/^[A-F0-9]{64}$/i.test(record.source.sha256)
      || actual !== record.source.sha256.toUpperCase()) {
      throw new Error(`candidate SHA-256 mismatch: ${id}`);
    }
  }

  resolveVerifiedSourcePath(id: string): string {
    const record = this.records.get(id);
    if (!record) throw new Error(`candidate not found: ${id}`);
    this.verifySource(id);
    return this.resolveSourcePath(record.source.sourceRelativePath);
  }

  private load(): void {
    const file = readStrictJson<DailyPerformanceCandidateFile>(this.catalogPath);
    if (file.schemaVersion !== 1 || !Array.isArray(file.entries)) {
      throw new Error('unsupported performance candidate catalog schema');
    }
    const validated = this.validateEntries(file.entries);
    this.records = new Map(validated.map(record => [record.id, record]));
  }

  private validateEntries(entries: readonly DailyPerformanceCandidate[]): DailyPerformanceCandidate[] {
    const records = entries.map(record => structuredClone(record));
    const byId = new Map<string, DailyPerformanceCandidate>();
    for (const record of records) {
      if (!record.id.trim()) throw new Error('candidate ID is required');
      if (byId.has(record.id)) throw new Error(`duplicate candidate ID: ${record.id}`);
      if (!Number.isFinite(record.durationSeconds) || record.durationSeconds <= 0) {
        throw new Error(`invalid candidate duration: ${record.id}`);
      }
      if (record.kind === 'motion' && record.dialogueSafe !== false) {
        throw new Error(`motion candidate must remain dialogueSafe=false: ${record.id}`);
      }
      if (record.kind === 'expression' && record.automatic !== false) {
        throw new Error(`expression candidate must remain automatic=false: ${record.id}`);
      }
      if (record.audit) {
        const { audit } = record;
        if (!audit.policyVersion.trim()
          || !/^[A-F0-9]{64}$/i.test(audit.sourceSha256)
          || typeof audit.accepted !== 'boolean'
          || !Array.isArray(audit.reasons)
          || audit.reasons.some(reason => typeof reason !== 'string')
          || !audit.auditedAt.trim()
          || !audit.metrics
          || Array.isArray(audit.metrics)
          || typeof audit.metrics !== 'object'
          || Object.values(audit.metrics).some(value => typeof value === 'number' && !Number.isFinite(value))) {
          throw new Error(`invalid candidate audit: ${record.id}`);
        }
      }
      const absolutePath = this.resolveSourcePath(record.source.sourceRelativePath);
      if (!existsSync(absolutePath)) throw new Error(`candidate source is missing: ${record.id}`);
      const actualHash = sha256(new Uint8Array(readFileSync(absolutePath)));
      if (!/^[A-F0-9]{64}$/i.test(record.source.sha256)
        || actualHash !== record.source.sha256.toUpperCase()) {
        throw new Error(`candidate SHA-256 mismatch: ${record.id}`);
      }
      byId.set(record.id, record);
    }
    for (const record of records) {
      if (!record.pairId) continue;
      const pair = byId.get(record.pairId);
      if (!pair) throw new Error(`missing paired candidate: ${record.id}`);
      if (pair.kind === record.kind || pair.pairId !== record.id) {
        throw new Error(`pair link mismatch: ${record.id}`);
      }
    }
    return records;
  }

  private resolveSourcePath(sourceRelativePath: string): string {
    if (!sourceRelativePath.trim() || isAbsolute(sourceRelativePath)) {
      throw new Error(`outside candidate source root: ${sourceRelativePath}`);
    }
    const absolutePath = resolve(this.sourceRoot, sourceRelativePath);
    const relativePath = relative(this.sourceRoot, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`outside candidate source root: ${sourceRelativePath}`);
    }
    return absolutePath;
  }

  private isReviewable(record: DailyPerformanceCandidate): boolean {
    const audit = record.audit;
    if (record.status !== 'candidate'
      || !audit?.accepted
      || audit.policyVersion !== DAILY_CANDIDATE_AUDIT_POLICY_VERSION
      || audit.sourceSha256.toUpperCase() !== record.source.sha256.toUpperCase()) return false;
    try {
      this.verifySource(record.id);
      return true;
    } catch {
      return false;
    }
  }

  private write(file: DailyPerformanceCandidateFile): void {
    const directory = dirname(this.catalogPath);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    const temporaryPath = resolve(
      directory,
      `.${basename(this.catalogPath)}.${process.pid}.${Date.now()}.tmp`
    );
    const bytes = Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
    let handle: number | null = null;
    try {
      handle = openSync(temporaryPath, 'wx');
      writeSync(handle, bytes, 0, bytes.length, 0);
      fsyncSync(handle);
      closeSync(handle);
      handle = null;
      renameSync(temporaryPath, this.catalogPath);
      const persisted = readFileSync(this.catalogPath);
      if (!persisted.equals(bytes)) throw new Error('candidate catalog read-back mismatch');
      const parsed = readStrictJson<DailyPerformanceCandidateFile>(this.catalogPath);
      if (parsed.schemaVersion !== 1 || parsed.entries.length !== file.entries.length) {
        throw new Error('candidate catalog schema read-back mismatch');
      }
    } finally {
      if (handle !== null) closeSync(handle);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}
