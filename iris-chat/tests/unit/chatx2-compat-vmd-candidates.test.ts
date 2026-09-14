import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ChatX2 compat model manager VMD candidates', () => {
  it('exposes the external candidate pool in the release chat UI', () => {
    const html = readFileSync(resolve(process.cwd(), 'chat5-compat/public/index.html'), 'utf8');
    expect(html).toContain('VMD 备选池（项目外）');
    expect(html).toContain('listExternalVmdCandidates');
    expect(html).toContain('previewExternalVmd');
    expect(html).toContain('acceptExternalVmd');
    expect(html).toContain('deleteExternalVmd');
  });
});
