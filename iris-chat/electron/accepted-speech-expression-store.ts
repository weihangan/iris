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
import { basename, dirname, resolve } from 'node:path';
import type { AcceptedExpressionRecord } from '../src/performance/daily-candidate-types';

interface AcceptedSpeechExpressionFile {
  readonly schemaVersion: 1;
  readonly entries: readonly AcceptedExpressionRecord[];
}

function readStrictJson(path: string): AcceptedSpeechExpressionFile {
  const bytes = readFileSync(path);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`UTF-8 BOM is forbidden: ${path}`);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\uFFFD')) throw new Error(`UTF-8 replacement character is forbidden: ${path}`);
  const parsed = JSON.parse(text) as AcceptedSpeechExpressionFile;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('unsupported accepted speech expression schema');
  }
  return parsed;
}

function validate(entry: AcceptedExpressionRecord): AcceptedExpressionRecord {
  if (!entry.id.trim()) throw new Error('accepted expression ID is required');
  if (entry.status !== 'accepted' || entry.automatic !== true) {
    throw new Error('accepted expression must use status=accepted and automatic=true');
  }
  return structuredClone(entry);
}

export class AcceptedSpeechExpressionStore {
  private readonly path: string;
  private entries = new Map<string, AcceptedExpressionRecord>();

  constructor(path: string) {
    this.path = resolve(path);
    if (existsSync(this.path)) this.load();
  }

  list(): readonly AcceptedExpressionRecord[] {
    return [...this.entries.values()].map(entry => structuredClone(entry));
  }

  upsert(entry: AcceptedExpressionRecord): void {
    const next = new Map(this.entries);
    next.set(entry.id, validate(entry));
    this.persist(next);
  }

  remove(id: string): boolean {
    if (!this.entries.has(id)) return false;
    const next = new Map(this.entries);
    next.delete(id);
    this.persist(next);
    return true;
  }

  removeBySourceUrlPrefix(prefix: string): number {
    const normalizedPrefix = prefix.trim();
    if (!normalizedPrefix) throw new Error('source URL prefix is required');
    const ids = [...this.entries.values()]
      .filter(entry => entry.source.sourceUrl.startsWith(normalizedPrefix))
      .map(entry => entry.id);
    if (ids.length === 0) return 0;
    const next = new Map(this.entries);
    for (const id of ids) next.delete(id);
    this.persist(next);
    return ids.length;
  }

  private load(): void {
    const file = readStrictJson(this.path);
    const next = new Map<string, AcceptedExpressionRecord>();
    for (const raw of file.entries) {
      const entry = validate(raw);
      if (next.has(entry.id)) throw new Error(`duplicate accepted expression ID: ${entry.id}`);
      next.set(entry.id, entry);
    }
    this.entries = next;
  }

  private persist(entries: Map<string, AcceptedExpressionRecord>): void {
    const file: AcceptedSpeechExpressionFile = {
      schemaVersion: 1,
      entries: [...entries.values()]
    };
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = resolve(directory, `.${basename(this.path)}.${process.pid}.${Date.now()}.tmp`);
    const bytes = Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
    let handle: number | null = null;
    try {
      handle = openSync(temporaryPath, 'wx');
      writeSync(handle, bytes, 0, bytes.length, 0);
      fsyncSync(handle);
      closeSync(handle);
      handle = null;
      renameSync(temporaryPath, this.path);
      const persisted = readFileSync(this.path);
      if (!persisted.equals(bytes)) throw new Error('accepted expression read-back mismatch');
      const verified = readStrictJson(this.path);
      if (JSON.stringify(verified) !== JSON.stringify(file)) {
        throw new Error('accepted expression schema read-back mismatch');
      }
      this.entries = entries;
    } finally {
      if (handle !== null) closeSync(handle);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}
