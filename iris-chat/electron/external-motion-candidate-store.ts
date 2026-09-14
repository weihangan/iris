import { createHash } from 'node:crypto';
import path from 'node:path';

export interface ExternalMotionCandidateManifest {
  readonly packId: string;
  readonly absolutePath: string;
  readonly sha256: string;
}

interface RegisteredCandidate {
  readonly manifest: ExternalMotionCandidateManifest;
  readonly bytes: Uint8Array;
}

export class ExternalMotionCandidateStore {
  private readonly allowedRoots: string[];
  private readonly candidates = new Map<string, RegisteredCandidate>();

  constructor(options: { allowedRoots: readonly string[] }) {
    if (options.allowedRoots.length === 0) throw new Error('at least one allowed motion root is required');
    this.allowedRoots = options.allowedRoots.map(root => path.resolve(root));
  }

  async computeSha256(bytes: Uint8Array): Promise<string> {
    return createHash('sha256').update(bytes).digest('hex');
  }

  async register(manifest: ExternalMotionCandidateManifest, bytes: Uint8Array): Promise<void> {
    if (!manifest.packId.trim()) throw new Error('pack ID is required');
    if (this.candidates.has(manifest.packId)) throw new Error(`candidate already registered: ${manifest.packId}`);

    const absolutePath = path.resolve(manifest.absolutePath);
    const insideRoot = this.allowedRoots.some(root => {
      const relative = path.relative(root, absolutePath);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!insideRoot) throw new Error(`candidate path outside allowed motion roots: ${manifest.absolutePath}`);

    const actualSha256 = await this.computeSha256(bytes);
    if (!/^[a-f0-9]{64}$/i.test(manifest.sha256) || actualSha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
      throw new Error(`candidate SHA-256 mismatch: ${manifest.packId}`);
    }
    this.candidates.set(manifest.packId, { manifest: { ...manifest, absolutePath }, bytes: bytes.slice() });
  }

  has(packId: string): boolean {
    return this.candidates.has(packId);
  }

  getManifest(packId: string): ExternalMotionCandidateManifest {
    const candidate = this.candidates.get(packId);
    if (!candidate) throw new Error(`candidate not registered: ${packId}`);
    return { ...candidate.manifest };
  }

  getBytes(packId: string): Uint8Array {
    const candidate = this.candidates.get(packId);
    if (!candidate) throw new Error(`candidate not registered: ${packId}`);
    return candidate.bytes.slice();
  }

  release(packId: string): void {
    this.candidates.delete(packId);
  }

  releaseAll(): void {
    this.candidates.clear();
  }
}
