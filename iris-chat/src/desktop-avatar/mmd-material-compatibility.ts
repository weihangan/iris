import * as THREE from 'three';

export interface MmdMaterialCompatibilityRule {
  readonly materialIndex: number;
  readonly materialName?: string;
  readonly action: 'suppress-color';
  readonly reason: string;
}

export interface MmdMaterialCompatibilityManifest {
  readonly model: {
    readonly sha256: string;
  };
  readonly materialCompatibility?: {
    readonly rules: readonly MmdMaterialCompatibilityRule[];
  };
}

function normalizeSha256(value: string): string {
  return value.trim().toUpperCase();
}

export async function computeSha256Hex(
  bytes: ArrayBuffer | Uint8Array<ArrayBuffer>
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/**
 * Applies model-specific visual compatibility after MMD runtime material sync.
 * Rules are numeric-index-only and fail closed unless the loaded bytes match the
 * manifest hash exactly.
 */
export function applyMmdMaterialCompatibility(
  material: THREE.Material | THREE.Material[],
  actualSha256: string,
  manifest: MmdMaterialCompatibilityManifest
): number {
  if (normalizeSha256(actualSha256) !== normalizeSha256(manifest.model.sha256)) {
    return 0;
  }

  const materials = Array.isArray(material) ? material : [material];
  let applied = 0;
  for (const rule of manifest.materialCompatibility?.rules ?? []) {
    if (rule.action !== 'suppress-color') continue;
    if (!Number.isInteger(rule.materialIndex)) continue;
    const target = materials[rule.materialIndex];
    if (!target) continue;
    target.colorWrite = false;
    applied++;
  }
  return applied;
}
