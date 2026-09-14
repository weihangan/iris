import { describe, expect, it } from 'vitest';
import { resolveModelSpecificDisabledDynamicBones } from '../../src/physics/avatar-physics-runtime';

const weddingDynamicBones = [
  '左后裙子',
  '右后裙子',
  ...Array.from({ length: 18 }, (_, index) => `スカート_11_${index}`),
  ...Array.from({ length: 18 }, (_, index) => `スカート_12_${index}`),
  'BangsBone60'
];

describe('wedding Selena rear-skirt physics policy', () => {
  it('selects only the two wedding PMX rear skirt chains', () => {
    const disabled = resolveModelSpecificDisabledDynamicBones({
      pmxSha256: '490875e333c2b3a3a09ba5d5d49580b10f04ff93532ceafa2b7585f13ffcf9cd',
      dynamicBoneNames: weddingDynamicBones
    });

    expect(disabled).toHaveLength(38);
    expect(disabled).not.toContain('BangsBone60');
    expect(disabled).toContain('左后裙子');
    expect(disabled).toContain('スカート_12_17');
  });

  it('does not affect another character or an unknown PMX', () => {
    expect(resolveModelSpecificDisabledDynamicBones({
      packId: 'yyxuanling',
      pmxSha256: 'deadbeef',
      dynamicBoneNames: weddingDynamicBones
    })).toEqual([]);
  });
});
