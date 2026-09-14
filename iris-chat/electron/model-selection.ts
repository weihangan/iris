// 本地 PMX 模型选择与路径边界（Task 5）
//
// 设计原则：
// - 主进程通过 dialog.showOpenDialog 让用户选择 .pmx 文件
// - 选择后校验 SHA-256，未知哈希拒绝
// - 纹理文件只能位于所选模型所在目录（用 path.relative 判断，不用 startsWith）
// - 拒绝绝对路径、.. 路径、空字节
//
// 解决问题：
// - 旧实现：模型路径硬编码在开发目录
// - 旧实现：纹理边界用 startsWith，存在 "selena-evil" 前缀目录绕过风险

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path';

export interface SelectedModel {
  modelPath: string;
  modelDir: string;
  sha256: string;
}

/**
 * 判断 candidate 路径是否位于 base 目录内（或等于 base）。
 * 使用 path.relative 而非 startsWith，避免 "selena" 前缀目录绕过。
 */
export function isPathInside(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  if (rel === '') return true; // candidate === base
  if (isAbsolute(rel)) return false;
  if (rel === '..') return false;
  if (rel.startsWith('..' + sep)) return false;
  return true;
}

/**
 * 校验并选择 PMX 模型。SHA-256 必须匹配 expectedSha256。
 */
export function selectVerifiedModel(
  modelPath: string,
  expectedSha256: string
): SelectedModel {
  if (extname(modelPath).toLowerCase() !== '.pmx') {
    throw new Error('Only .pmx models are supported in Phase 3');
  }
  const bytes = readFileSync(modelPath);
  const sha256 = createHash('sha256')
    .update(bytes)
    .digest('hex')
    .toUpperCase();
  if (sha256 !== expectedSha256.toUpperCase()) {
    throw new Error('Unknown PMX SHA-256: ' + sha256);
  }
  return {
    modelPath: resolve(modelPath),
    modelDir: dirname(resolve(modelPath)),
    sha256
  };
}

/**
 * 解析模型目录内的相对纹理路径。
 * 拒绝绝对路径、.. 路径、空字节。
 * 返回 null 表示路径越界或非法。
 */
export function resolveModelAsset(
  selection: SelectedModel,
  relativePath: string
): string | null {
  if (!relativePath) return null;
  if (relativePath.includes('\0')) return null;
  if (isAbsolute(relativePath)) return null;

  const candidate = resolve(selection.modelDir, relativePath);
  return isPathInside(selection.modelDir, candidate) ? candidate : null;
}
