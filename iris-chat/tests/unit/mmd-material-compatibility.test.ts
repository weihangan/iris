import * as THREE from 'three';
import { syncMmdMaterialStates } from '@yohawing/three-mmd-loader/three';
import { describe, expect, it } from 'vitest';
import {
  applyMmdMaterialCompatibility,
  computeSha256Hex
} from '../../src/desktop-avatar/mmd-material-compatibility';

const SELENA_SHA = 'C8636D99356C51D059B3FC38FFF062123C57D82164A00BBEB76B40674E503DF5';

const manifest = {
  model: { sha256: SELENA_SHA },
  materialCompatibility: {
    rules: [
      {
        materialIndex: 7,
        action: 'suppress-color' as const,
        reason: 'optional white nose overlay'
      }
    ]
  }
};

const runtimeState = {
  diffuse: [1, 1, 1, 1],
  specular: [0, 0, 0],
  specularPower: 1,
  ambient: [0.2, 0.2, 0.2],
  edgeColor: [0, 0, 0, 1],
  edgeSize: 0,
  textureFactor: [1, 1, 1, 1],
  sphereTextureFactor: [1, 1, 1, 1],
  toonTextureFactor: [1, 1, 1, 1]
} as const;

function createMaterials(): THREE.MeshStandardMaterial[] {
  return Array.from({ length: 10 }, (_, index) => {
    const material = new THREE.MeshStandardMaterial();
    material.name = `material-${index}`;
    material.map = new THREE.Texture();
    material.visible = true;
    material.colorWrite = true;
    material.depthWrite = true;
    material.userData.mmdMaterial = {
      materialIndex: index,
      transparencyMode: 'opaque',
      flags: {
        groundShadow: true,
        selfShadowMap: true
      }
    };
    return material;
  });
}

describe('MMD material compatibility', () => {
  it('computes the actual PMX byte hash in uppercase hexadecimal', async () => {
    const bytes = new TextEncoder().encode('abc');

    await expect(computeSha256Hex(bytes)).resolves.toBe(
      'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'
    );
  });

  it('suppresses only the numeric material rule for the exact model hash', () => {
    const materials = createMaterials();
    const targetMap = materials[7].map;

    const applied = applyMmdMaterialCompatibility(materials, SELENA_SHA.toLowerCase(), manifest);

    expect(applied).toBe(1);
    expect(materials[7].colorWrite).toBe(false);
    expect(materials[7].visible).toBe(true);
    expect(materials[7].map).toBe(targetMap);
    expect(materials[7].depthWrite).toBe(true);
    expect(materials[6].colorWrite).toBe(true);
    expect(materials[8].colorWrite).toBe(true);
  });

  it('fails closed for an unknown model hash', () => {
    const materials = createMaterials();

    const applied = applyMmdMaterialCompatibility(materials, '0'.repeat(64), manifest);

    expect(applied).toBe(0);
    expect(materials.every(material => material.colorWrite)).toBe(true);
  });

  it('ignores an out-of-range numeric material index', () => {
    const materials = createMaterials();
    const outOfRangeManifest = {
      ...manifest,
      materialCompatibility: {
        rules: [{ materialIndex: 99, action: 'suppress-color' as const, reason: 'invalid' }]
      }
    };

    const applied = applyMmdMaterialCompatibility(materials, SELENA_SHA, outOfRangeManifest);

    expect(applied).toBe(0);
    expect(materials.every(material => material.colorWrite)).toBe(true);
  });

  it('can be reapplied after runtime synchronization restores colorWrite', () => {
    const materials = createMaterials();
    applyMmdMaterialCompatibility(materials, SELENA_SHA, manifest);
    expect(materials[7].colorWrite).toBe(false);

    syncMmdMaterialStates(materials[7], [runtimeState as any]);
    expect(materials[7].colorWrite).toBe(true);

    const applied = applyMmdMaterialCompatibility(materials, SELENA_SHA, manifest);
    expect(applied).toBe(1);
    expect(materials[7].colorWrite).toBe(false);
  });
});
