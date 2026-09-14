import { describe, expect, it } from 'vitest';
import { ExternalMotionCandidateStore } from '../../electron/external-motion-candidate-store';

describe('ExternalMotionCandidateStore', () => {
  it('registers a SHA-bound candidate and returns defensive byte copies', async () => {
    const store = new ExternalMotionCandidateStore({ allowedRoots: ['D:/chat6-motion-packs'] });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = await store.computeSha256(bytes);
    await store.register({ packId: 'koa-stand', absolutePath: 'D:/chat6-motion-packs/koa/original.vmd', sha256 }, bytes);

    const first = store.getBytes('koa-stand');
    expect(first).toEqual(bytes);
    first[0] = 99;
    expect(store.getBytes('koa-stand')[0]).toBe(1);
  });

  it('rejects paths outside allowed roots and SHA mismatches', async () => {
    const store = new ExternalMotionCandidateStore({ allowedRoots: ['D:/chat6-motion-packs'] });
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = await store.computeSha256(bytes);
    await expect(store.register({ packId: 'escape', absolutePath: 'D:/other/original.vmd', sha256 }, bytes))
      .rejects.toThrow('outside allowed motion roots');
    await expect(store.register({ packId: 'bad-hash', absolutePath: 'D:/chat6-motion-packs/a/original.vmd', sha256: '0'.repeat(64) }, bytes))
      .rejects.toThrow('SHA-256 mismatch');
  });

  it('rejects duplicate pack IDs and releases candidates', async () => {
    const store = new ExternalMotionCandidateStore({ allowedRoots: ['D:/chat6-motion-packs'] });
    const bytes = new Uint8Array([5]);
    const sha256 = await store.computeSha256(bytes);
    const manifest = { packId: 'same', absolutePath: 'D:/chat6-motion-packs/a/original.vmd', sha256 };
    await store.register(manifest, bytes);
    await expect(store.register(manifest, bytes)).rejects.toThrow('already registered');
    store.releaseAll();
    expect(store.has('same')).toBe(false);
  });
});
