// Phase 6 重构（2026-07-24）：删除所有程序化生成的动作代码
//
// 旧的动作系统（idle-packs.ts / gesture-packs.ts）使用代码生成 VMD 字节，
// 存在骨骼外翻、面部表情缺失等问题。现已全面迁移到外部 VMD 文件系统。
//
// 所有待机/手势动作现在通过 models/selena-xisheng/motions/ 目录下的
// 真实 VMD 文件加载，这些文件来自鸣潮/战双等游戏的 MMD 社区。
//
// 本文件保留为空壳，仅维持向后兼容的 API 导出（全部返回空），
// 确保依赖此模块的其他文件不会编译报错。

import type { RuntimeMotionPackManifest } from './motion-pack-registry';

// ============================================================
// 空壳导出（全部返回空，实际动作来自 customVmd）
// ============================================================

export const GESTURE_PACK_IDS: readonly string[] = [];

export interface GestureSemanticMapping {
  packId: string;
  displayName: string;
  gestureFamily: string;
  intent: string;
  emotions: string[];
  description: string;
}

export interface GesturePackCatalogItem {
  packId: string;
  displayName: string;
  gestureFamily: string;
  description: string;
}

export type GesturePackManifest = RuntimeMotionPackManifest;

export function getAllGesturePackIds(): readonly string[] {
  return [];
}

export function getGesturePackDisplayName(_packId: string): string {
  return '';
}

export function getGesturePackCatalog(): readonly GesturePackCatalogItem[] {
  return [];
}

export function getAllGesturePackManifests(): GesturePackManifest[] {
  return [];
}

export function getGesturePackManifest(_packId: string): GesturePackManifest | undefined {
  return undefined;
}

export function getGesturePackBytes(_packId: string): Uint8Array {
  throw new Error(`[gesture-packs] 程序化动作已废弃，请使用 customVmd 文件。packId: ${_packId}`);
}

export async function initializeGesturePackHashes(): Promise<void> {
  // 无需初始化，已无程序化 pack
}

export function getGestureSemanticMappings(): readonly GestureSemanticMapping[] {
  return [];
}