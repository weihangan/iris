// 模型包管理器
// 职责：扫描/加载/校验/切换模型包，管理动作配置，导入 VMD
// 约束：不修改/转换/重存/上传 PMX；只读访问模型文件
//
// 语音动作统一管理（2026-07-28）：
// - vmdEmotionMap 不再存储于各模型 manifest.json 中，改为统一存储在 models/shared/voice-actions.json
// - 所有模型共享同一份语音动作映射表，在任意模型添加/删除动作会自动同步到所有模型
// - 轮换待机动作（idleVmdPool）仍按模型独立管理

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import { dirname, join, resolve, extname, basename, relative } from 'node:path';
import type {
  ModelPackManifest,
  ModelPackMotions,
  LoadedModelPack,
  ModelPackListItem,
  SwitchModelResult,
  VmdEmotionEntry
} from './model-pack-types';
import { MAX_IDLE_QUICK_SLOTS } from './idle-quick-slots';
import { parsePmx } from '../actor/pmx-parser';
import {
  PROTECTED_HEAD_VOICE_ACTIONS,
  isProtectedVoiceActionPath,
  mergeProtectedHeadVoiceActions,
  normalizeProtectedVoiceActionPath,
  sanitizeProtectedHeadVoiceActionUpdates,
  type ProtectedHeadVoiceActionOverride,
  type ProtectedHeadVoiceActionOverrides
} from '../performance/protected-head-voice-actions';

export interface ModelPackManagerOptions {
  builtinPacksRoot: string;   // 内置模型包根目录（如 chatX2/models/）
  userPacksRoot: string;      // 用户模型包根目录（userData/models/）
  sharedMotionsRoot?: string; // 公共 VMD 目录（如 chatX2/models/shared/motions/），所有角色共享
  voiceActionsPath?: string;  // 可写语音动作映射表（发布版应放在 userData）
  defaultVoiceActionsPath?: string; // 只读默认动作表，仅在用户文件不存在时播种
  settingsPath?: string;      // 模型选择持久化文件路径（如 userData/model-settings.json）
  characterSettingsRoot?: string; // 角色专属 avatar_settings.json 根目录
  motionDeletionsPath?: string; // 用户删除动作墓碑（发布目录可能只读）
  protectedVoiceActionOverridesPath?: string; // 内置头部语音动作的独立可写偏好
}

export interface VoiceActionsFile {
  schemaVersion: number;
  description: string;
  entries: VmdEmotionEntry[];
}

interface DeletedMotionsFile {
  schemaVersion: 1;
  paths: string[];
}

interface ProtectedVoiceActionOverridesFile {
  schemaVersion: 1;
  overrides: Record<string, ProtectedHeadVoiceActionOverride>;
}

interface PerPackMotionSettings {
  defaultIdle?: string;
  idleVmdPool?: string[];
  idlePacks?: string[];
  gesturePacks?: string[];
}

interface CharacterAvatarSettingsFile {
  schemaVersion: 1;
  modelPackId?: string;
  motion?: PerPackMotionSettings;
  lighting?: Record<string, unknown>;
  [key: string]: unknown;
}

const EMPTY_IMPORTED_MORPHS = {
  visemes: { a: '', i: '', u: '', e: '', o: '' },
  blink: '',
  emotions: { neutral: '', serious: '', happy: '', smile: '', surprised: '', angry: '', concerned: '' },
  blush: { name: '', safeRange: { min: 0, max: 0 } },
  shy: '',
  tears: ''
};

const EMPTY_IMPORTED_BONES = {
  root: '', center: '', head: '', neck: '', bothEyes: '', leftEye: '', rightEye: '',
  upperBody: '', lowerBody: '', waist: '', leftShoulder: '', rightShoulder: '',
  leftArm: '', rightArm: '', leftElbow: '', rightElbow: '', leftHand: '', rightHand: '',
  leftLeg: '', rightLeg: '', leftKnee: '', rightKnee: '', leftFoot: '', rightFoot: '',
  leftFootIK: '', rightFootIK: '', leftToeIK: '', rightToeIK: ''
};

interface ModelSettingsFile {
  schemaVersion: 1;
  lastPackId?: string;
  updatedAt?: string;
  motionSettingsByPack: Record<string, PerPackMotionSettings>;
}

function normalizeVoiceActionPath(value: string): string {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

function readStrictUtf8Json<T>(path: string): T {
  const bytes = readFileSync(path);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`UTF-8 BOM is forbidden: ${path}`);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\uFFFD')) throw new Error(`UTF-8 replacement character is forbidden: ${path}`);
  return JSON.parse(text) as T;
}

const JOURNALED_USER_FILES = new Set([
  'voice-actions.json', 'model-settings.json', 'motion-deletions.json',
  'protected-voice-action-overrides.json'
]);

/** Preserve the last good user motion configuration before every replacement. */
function journalUserMotionConfig(path: string): void {
  if (!JOURNALED_USER_FILES.has(basename(path)) || !existsSync(path)) return;
  const previous = readFileSync(path);
  const digest = createHash('sha256').update(previous).digest('hex');
  const journalDir = join(dirname(path), '.chatx2-history');
  if (!existsSync(journalDir)) mkdirSync(journalDir, { recursive: true });
  const prefix = `${basename(path)}.${new Date().toISOString().replace(/[:.]/g, '-')}.${digest.slice(0, 16)}`;
  const temporary = join(journalDir, `.${prefix}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const snapshot = join(journalDir, `${prefix}.bak`);
  try {
    copyFileSync(path, temporary);
    const handle = openSync(temporary, 'r+');
    try { fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temporary, snapshot);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    }
  }
}

/** Same-directory UTF-8/no-BOM atomic replacement with an explicit disk flush. */
function writeStrictUtf8JsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temporaryPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const bytes = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
  let handle: number | null = null;
  try {
    handle = openSync(temporaryPath, 'wx');
    writeSync(handle, bytes, 0, bytes.length, 0);
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    // Do not replace a user file unless a recoverable last-good copy exists.
    journalUserMotionConfig(path);
    // On Windows Node implements rename with the platform replace-existing
    // primitive; keeping the temp beside the destination preserves atomicity.
    renameSync(temporaryPath, path);
    const persisted = readFileSync(path);
    if (!persisted.equals(bytes)) {
      throw new Error(`atomic persistence byte verification failed: ${path}`);
    }
    // Strictly decode and parse every user motion/settings replacement. This
    // catches antivirus/filesystem interference before the UI reports success.
    readStrictUtf8Json(path);
  } finally {
    if (handle !== null) {
      try { closeSync(handle); } catch { /* ignore cleanup error */ }
    }
    if (existsSync(temporaryPath)) {
      try { unlinkSync(temporaryPath); } catch { /* ignore cleanup error */ }
    }
  }
}

export class ModelPackManager {
  private builtinRoot: string;
  private userRoot: string;
  private sharedMotionsRoot: string | null;
  private builtinSharedMotionsRoot: string;
  private voiceActionsPath: string | null;
  private defaultVoiceActionsPath: string | null;
  private settingsPath: string | null;
  private characterSettingsRoot: string | null;
  private motionDeletionsPath: string | null;
  private protectedVoiceActionOverridesPath: string | null;
  private deletedMotionPaths = new Set<string>();
  private loadedPacks: Map<string, LoadedModelPack> = new Map();
  private currentPackId: string | null = null;
  private activeCharacterId: string | null = null;
  private modelSettings: ModelSettingsFile = {
    schemaVersion: 1,
    motionSettingsByPack: {}
  };
  /**
   * Loose model folders are discovered from both the packaged models root and
   * the user models root.  Keep a cheap per-process signature so the
   * constructor and the first `discoverPacks()` call do not hash/import every
   * PMX twice.  The signature is intentionally invalidated by directory/file
   * mtime/size changes, so dropping a new model while the app is open still
   * gets picked up on the next discovery.
   */
  private looseModelScanSignature: string | null = null;
  /** 缓存的共享语音动作映射表 */
  private sharedVoiceActions: VoiceActionsFile | null = null;

  constructor(options: ModelPackManagerOptions) {
    this.builtinRoot = options.builtinPacksRoot;
    this.userRoot = options.userPacksRoot;
    this.sharedMotionsRoot = options.sharedMotionsRoot ?? null;
    this.builtinSharedMotionsRoot = join(this.builtinRoot, 'shared', 'motions');
    this.voiceActionsPath = options.voiceActionsPath ?? null;
    this.defaultVoiceActionsPath = options.defaultVoiceActionsPath ?? null;
    this.settingsPath = options.settingsPath ?? null;
    this.characterSettingsRoot = options.characterSettingsRoot ?? null;
    this.motionDeletionsPath = options.motionDeletionsPath
      ?? (this.voiceActionsPath ? join(dirname(this.voiceActionsPath), 'motion-deletions.json') : null);
    this.protectedVoiceActionOverridesPath = options.protectedVoiceActionOverridesPath
      ?? (this.voiceActionsPath
        ? join(dirname(this.voiceActionsPath), 'protected-voice-action-overrides.json')
        : null);
    this.loadDeletedMotionPaths();
    // 从 userData 恢复模型选择及每个模型的动作设置。
    this.restoreModelSettings();
    // 用户可直接把“包含 PMX 的模型文件夹”放入 userData/models；首次扫描时
    // 自动补一个轻量 manifest，使其无需手工编辑 JSON 即可出现在模型列表。
    this.materializeLooseModelPacks();
    // `models/shared/vmd+` is a user-facing drop folder.  Materialize its VMD
    // files into the runtime shared motion store so the existing action page
    // (which reads customVmd) can use them without a second discovery path.
    this.materializeSharedVmdPlus();
  }

  private materializeSharedVmdPlus(): void {
    const sourceRoot = join(this.builtinRoot, 'shared', 'vmd+');
    if (!existsSync(sourceRoot) || !this.sharedMotionsRoot) return;
    mkdirSync(this.sharedMotionsRoot, { recursive: true });
    const files: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const candidate = join(dir, entry);
        if (statSync(candidate).isDirectory()) scan(candidate);
        else if (extname(candidate).toLowerCase() === '.vmd') files.push(candidate);
      }
    };
    scan(sourceRoot);
    for (const source of files) {
      const base = basename(source);
      const targetName = `vmdplus-${base}`;
      const target = join(this.sharedMotionsRoot, targetName);
      try {
        const sourceBytes = readFileSync(source);
        if (existsSync(target)) {
          const existingBytes = readFileSync(target);
          if (!existingBytes.equals(sourceBytes)) {
            console.warn('[model-pack] skipped VMD+ name conflict:', targetName);
            continue;
          }
        } else {
          writeFileSync(target, sourceBytes);
        }
        const sharedPath = `../shared/motions/${targetName}`;
        this.clearMotionDeletion(sharedPath);
        this.syncVmdToAllModels(sharedPath, 'add');
      } catch (error) {
        console.warn('[model-pack] failed to materialize VMD+ motion:', source, error);
      }
    }
  }

  private importedPackId(folderName: string, sha256: string): string {
    const slug = String(folderName || 'model').trim()
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^imported-+/i, '') || 'model';
    return `imported-${slug}-${sha256.slice(0, 12).toLowerCase()}`;
  }

  /**
   * Find an existing user import by PMX content, rather than by its source
   * folder name. A model selected through the file picker and the same model
   * discovered under models/ must resolve to one pack.
   */
  private findImportedPackBySha256(sha256: string): { packDir: string; manifest: ModelPackManifest } | null {
    const wanted = String(sha256).toUpperCase();
    const candidates: Array<{ packDir: string; manifest: ModelPackManifest }> = [];
    const scan = (root: string, depth = 0): void => {
      if (!existsSync(root)) return;
      for (const entry of readdirSync(root).sort((a, b) => a.localeCompare(b))) {
        const packDir = join(root, entry);
        if (!statSync(packDir).isDirectory()) continue;
        const manifestPath = join(packDir, 'manifest.json');
        if (existsSync(manifestPath)) {
          try {
            const manifest = readStrictUtf8Json<ModelPackManifest>(manifestPath);
            const imported = manifest.model?.credit === '用户导入模型'
              || String(manifest.packId ?? '').startsWith('imported-');
            if (imported && String(manifest.model?.sha256 ?? '').toUpperCase() === wanted) {
              const pmxPath = resolve(packDir, manifest.model.pmxFile);
              // Verify the selected PMX too. A stale manifest must not block a
              // fresh import from creating a valid pack.
              if (existsSync(pmxPath) && statSync(pmxPath).isFile()) {
                const actual = createHash('sha256').update(readFileSync(pmxPath)).digest('hex').toUpperCase();
                if (actual === wanted) candidates.push({ packDir, manifest });
              }
            }
          } catch { /* ignore malformed/non-model folders */ }
        } else if (depth < 2) {
          scan(packDir, depth + 1);
        }
      }
    };
    scan(this.userRoot);
    if (candidates.length === 0) return null;
    // Prefer a readable model name over legacy folders whose display name is
    // still the generated `imported-...` identifier.
    candidates.sort((a, b) => {
      const aGenerated = a.manifest.displayName.startsWith('imported-') ? 1 : 0;
      const bGenerated = b.manifest.displayName.startsWith('imported-') ? 1 : 0;
      return aGenerated - bGenerated || a.packDir.length - b.packDir.length;
    });
    return candidates[0];
  }

  private pruneImportedPackSiblings(packDir: string, manifest: ModelPackManifest): void {
    const selected = resolve(packDir, manifest.model.pmxFile);
    if (!existsSync(selected)) return;
    for (const entry of readdirSync(packDir)) {
      const candidate = join(packDir, entry);
      if (extname(candidate).toLowerCase() !== '.pmx' || resolve(candidate) === selected) continue;
      try { unlinkSync(candidate); } catch (error) {
        console.warn('[model-pack] failed to prune duplicate PMX variant:', candidate, error);
      }
    }
  }

  private createImportedManifest(packDir: string, pmxName: string, sha256: string, displayName?: string): ModelPackManifest {
    const directoryName = basename(packDir);
    const importedSuffix = `-${sha256.slice(0, 12).toLowerCase()}`;
    const packId = directoryName.toLowerCase().startsWith('imported-')
      && directoryName.toLowerCase().endsWith(importedSuffix)
      ? directoryName
      : this.importedPackId(directoryName, sha256);
    return {
      schemaVersion: 1,
      packId,
      displayName: displayName?.trim() || basename(packDir),
      internalName: packId,
      createdAt: new Date().toISOString(),
      model: {
        pmxFile: pmxName,
        sha256: sha256.toUpperCase(),
        pmxVersion: 2,
        geometry: { vertices: 0, triangles: 0, materials: 0, bones: 0, morphs: 0, textures: 0 },
        credit: '用户导入模型',
        licenseStatus: 'user-provided'
      },
      textures: [],
      morphs: EMPTY_IMPORTED_MORPHS,
      bones: EMPTY_IMPORTED_BONES,
      materialCompatibility: { rules: [] },
      motions: { idlePacks: [], gesturePacks: [], defaultIdle: '', customVmd: [], longActionVmd: [], idleVmdPool: [] },
      capabilities: []
    };
  }

  private materializeLooseModelPack(packDir: string, selectedPmxPath?: string): string | null {
    if (!existsSync(packDir) || !statSync(packDir).isDirectory()) return null;
    const manifestPath = join(packDir, 'manifest.json');
    if (existsSync(manifestPath)) return manifestPath;
    const pmxPath = selectedPmxPath && existsSync(selectedPmxPath)
      ? selectedPmxPath
      : readdirSync(packDir)
        .map(name => join(packDir, name))
        .find(candidate => statSync(candidate).isFile() && extname(candidate).toLowerCase() === '.pmx');
    if (!pmxPath) return null;
    try {
      const bytes = readFileSync(pmxPath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const manifest = this.createImportedManifest(
        packDir,
        basename(pmxPath),
        sha256,
        basename(pmxPath, extname(pmxPath))
      );
      writeStrictUtf8JsonAtomic(manifestPath, manifest);
      return manifestPath;
    } catch (error) {
      console.warn('[model-pack] failed to materialize loose model:', packDir, error);
      return null;
    }
  }

  private getLooseModelScanSignature(): string {
    const signatureParts: string[] = [];
    const appendSignature = (root: string, depth = 0): void => {
      if (!existsSync(root)) {
        signatureParts.push(`${root}:missing`);
        return;
      }
      let entries: string[] = [];
      try { entries = readdirSync(root).sort((a, b) => a.localeCompare(b)); } catch {
        signatureParts.push(`${root}:unreadable`);
        return;
      }
      for (const entry of entries) {
        const candidate = join(root, entry);
        try {
          const stat = statSync(candidate);
          signatureParts.push(`${candidate}|${stat.isDirectory() ? 'd' : 'f'}|${stat.size}|${stat.mtimeMs}`);
          // A single nested level covers models/imported/MyModel while keeping
          // this check far cheaper than reading PMX bytes or walking all files.
          if (stat.isDirectory() && depth < 1) appendSignature(candidate, depth + 1);
        } catch { /* a concurrently removed file is harmless */ }
      }
    };
    appendSignature(this.builtinRoot);
    appendSignature(this.userRoot);
    return signatureParts.join('\n');
  }

  private materializeLooseModelPacks(): void {
    const signature = this.getLooseModelScanSignature();
    if (this.looseModelScanSignature === signature) return;
    this.looseModelScanSignature = signature;

    // 开发目录/便携包的 models 根目录也允许直接放入新模型；不修改只读
    // 内置目录，而是复制到 userData/models 后注册，升级包时用户模型不丢失。
    if (existsSync(this.builtinRoot)) {
      // Also accept a PMX dropped directly in models/ (without a wrapper
      // folder). It is imported into the same user-owned model registry as a
      // folder-based drop, so textures beside the PMX are preserved.
      for (const entry of readdirSync(this.builtinRoot)) {
        const candidate = join(this.builtinRoot, entry);
        if (statSync(candidate).isFile() && extname(candidate).toLowerCase() === '.pmx') {
          this.importExternalModel(candidate);
        }
      }
      for (const entry of readdirSync(this.builtinRoot)) {
        const candidate = join(this.builtinRoot, entry);
        if (!statSync(candidate).isDirectory() || existsSync(join(candidate, 'manifest.json'))) continue;
        // A downloaded folder can contain several PMX variants (for example
        // normal/transform versions).  Register every PMX independently so
        // one file never hides the others.  Non-model folders such as
        // `shared`, `vmd+`, and `千面AI_samples` simply have no candidates and
        // are skipped without affecting sibling model discovery.
        const pmxFiles = readdirSync(candidate)
          .map(name => join(candidate, name))
          .filter(file => statSync(file).isFile() && extname(file).toLowerCase() === '.pmx');
        for (const pmx of pmxFiles) this.importExternalModel(pmx);
      }
    }
    if (!existsSync(this.userRoot)) {
      this.looseModelScanSignature = this.getLooseModelScanSignature();
      return;
    }
    for (const entry of readdirSync(this.userRoot)) {
      const candidate = join(this.userRoot, entry);
      if (statSync(candidate).isFile() && extname(candidate).toLowerCase() === '.pmx') {
        this.importExternalModel(candidate);
      }
    }
    for (const entry of readdirSync(this.userRoot)) {
      const candidate = join(this.userRoot, entry);
      if (!statSync(candidate).isDirectory()) continue;
      if (existsSync(join(candidate, 'manifest.json'))) continue;
      const directPmx = readdirSync(candidate)
        .map(name => join(candidate, name))
        .filter(file => statSync(file).isFile() && extname(file).toLowerCase() === '.pmx');
      // Keep the lightweight in-place manifest for the common one-PMX case.
      // For multiple PMX files use separate imported packs, matching the
      // built-in-root behavior above.
      if (directPmx.length > 1) {
        for (const pmx of directPmx) this.importExternalModel(pmx);
      } else {
        this.materializeLooseModelPack(candidate);
      }
      // Also accept one conventional nesting level: models/imported/MyModel/*.pmx.
      for (const nested of readdirSync(candidate)) {
        const nestedDir = join(candidate, nested);
        if (existsSync(join(nestedDir, 'manifest.json'))) continue;
        if (statSync(nestedDir).isDirectory()) this.materializeLooseModelPack(nestedDir);
      }
    }
    // Imports may have created `userRoot/imported` during this pass.  Refresh
    // the signature after those writes so the immediate discoverPacks() call
    // remains a cache hit instead of repeating the same import work.
    this.looseModelScanSignature = this.getLooseModelScanSignature();
  }

  /** 将页面选择的外部 PMX 复制到专用 userData/models/imported 目录并注册。 */
  importExternalModel(sourcePath: string): { success: boolean; packId?: string; modelPath?: string; sha256?: string; reason?: string } {
    if (!sourcePath || extname(sourcePath).toLowerCase() !== '.pmx' || !existsSync(sourcePath)) {
      return { success: false, reason: 'invalid-extension' };
    }
    try {
      const bytes = readFileSync(sourcePath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const sourceFolderName = basename(dirname(sourcePath));
      const sourceVariantName = basename(sourcePath, extname(sourcePath));
      const readableName = sourceFolderName && sourceFolderName !== sourceVariantName
        ? `${sourceFolderName} - ${sourceVariantName}`
        : sourceVariantName;
      const importRoot = join(this.userRoot, 'imported');
      const folderName = this.importedPackId(basename(dirname(sourcePath)), sha256);
      const targetDir = join(importRoot, folderName);

      // The generated import directory is content-addressed.  Check it first
      // so normal startup discovery avoids recursively scanning every legacy
      // import and re-hashing all of them on each model switch.
      const canonicalManifestPath = join(targetDir, 'manifest.json');
      if (existsSync(canonicalManifestPath)) {
        try {
          const existing = readStrictUtf8Json<ModelPackManifest>(canonicalManifestPath);
          const existingPmx = join(targetDir, existing.model?.pmxFile ?? basename(sourcePath));
          if (String(existing.model?.sha256 ?? '').toUpperCase() === sha256.toUpperCase()
            && existsSync(existingPmx) && statSync(existingPmx).isFile()) {
            this.pruneImportedPackSiblings(targetDir, existing);
            if (existing.displayName.startsWith('imported-')) {
              existing.displayName = readableName;
              writeStrictUtf8JsonAtomic(canonicalManifestPath, existing);
            }
            return {
              success: true,
              packId: existing.packId,
              modelPath: existingPmx,
              sha256: sha256.toUpperCase()
            };
          }
        } catch { /* fall through to legacy hash lookup/rebuild */ }
      }

      // Content-addressed de-duplication. This also collapses legacy imports
      // created from a different parent folder (for example a downloaded
      // package name versus the user's renamed model folder).
      const existingByHash = this.findImportedPackBySha256(sha256);
      if (existingByHash) {
        const existingPmx = join(existingByHash.packDir, existingByHash.manifest.model.pmxFile);
        this.pruneImportedPackSiblings(existingByHash.packDir, existingByHash.manifest);
        return {
          success: true,
          packId: existingByHash.manifest.packId,
          modelPath: existingPmx,
          sha256: sha256.toUpperCase()
        };
      }
      mkdirSync(targetDir, { recursive: true });
      const manifestPath = join(targetDir, 'manifest.json');
      // Startup discovery is idempotent.  Do not recopy a user's imported
      // model (or rewrite its manifest) when the source PMX has not changed.
      if (existsSync(manifestPath)) {
        try {
          const existing = readStrictUtf8Json<ModelPackManifest>(manifestPath);
          const existingPmx = join(targetDir, existing.model?.pmxFile ?? basename(sourcePath));
          if (existing.model?.sha256?.toUpperCase() === sha256.toUpperCase()
            && existsSync(existingPmx)) {
            this.pruneImportedPackSiblings(targetDir, existing);
            if (existing.displayName.startsWith('imported-')) {
              existing.displayName = readableName;
              writeStrictUtf8JsonAtomic(manifestPath, existing);
            }
            return {
              success: true,
              packId: existing.packId,
              modelPath: existingPmx,
              sha256: sha256.toUpperCase()
            };
          }
        } catch { /* rebuild a damaged/incomplete imported pack below */ }
      }
      // 保留 PMX 同目录的纹理/材质相对路径；不触碰源目录。
      if (resolve(dirname(sourcePath)) !== resolve(targetDir)) {
        for (const entry of readdirSync(dirname(sourcePath))) {
          const from = join(dirname(sourcePath), entry);
          const to = join(targetDir, entry);
          // A folder can contain normal/transform PMX variants. Each variant
          // gets its own pack; copying sibling PMX files into every target
          // made the model manager look like it had merged or lost variants.
          if (extname(from).toLowerCase() === '.pmx'
            && resolve(from) !== resolve(sourcePath)) continue;
          cpSync(from, to, { recursive: true, force: true });
        }
      }
      writeStrictUtf8JsonAtomic(manifestPath, this.createImportedManifest(
        targetDir,
        basename(sourcePath),
        sha256,
        readableName
      ));
      const manifest = readStrictUtf8Json<ModelPackManifest>(manifestPath);
      this.pruneImportedPackSiblings(targetDir, manifest);
      return { success: true, packId: manifest.packId, modelPath: join(targetDir, basename(sourcePath)), sha256: sha256.toUpperCase() };
    } catch (error) {
      console.warn('[model-pack] external model import failed:', error);
      return { success: false, reason: 'import-failed' };
    }
  }

  private loadDeletedMotionPaths(): void {
    if (!this.motionDeletionsPath || !existsSync(this.motionDeletionsPath)) return;
    try {
      const data = readStrictUtf8Json<Partial<DeletedMotionsFile>>(this.motionDeletionsPath);
      if (data.schemaVersion === 1 && Array.isArray(data.paths)) {
        this.deletedMotionPaths = new Set(data.paths.map(normalizeVoiceActionPath).filter(Boolean));
      }
    } catch (error) {
      console.warn('[model-pack] failed to load motion deletion tombstones:', error);
    }
  }

  /**
   * Refresh user-owned tombstones before every mutation/read boundary.  More
   * than one renderer window can issue model-management IPC, and an older
   * process must never overwrite a deletion made by the newer one.
   */
  private refreshDeletedMotionPaths(): void {
    if (!this.motionDeletionsPath || !existsSync(this.motionDeletionsPath)) {
      this.deletedMotionPaths = new Set();
      return;
    }
    const data = readStrictUtf8Json<Partial<DeletedMotionsFile>>(this.motionDeletionsPath);
    if (data.schemaVersion !== 1 || !Array.isArray(data.paths)) {
      throw new Error(`Invalid motion deletion file: ${this.motionDeletionsPath}`);
    }
    this.deletedMotionPaths = new Set(data.paths.map(normalizeVoiceActionPath).filter(Boolean));
  }

  private saveDeletedMotionPaths(): boolean {
    if (!this.motionDeletionsPath) return false;
    try {
      const data: DeletedMotionsFile = {
        schemaVersion: 1,
        paths: Array.from(this.deletedMotionPaths).sort()
      };
      writeStrictUtf8JsonAtomic(this.motionDeletionsPath, data);
      return true;
    } catch (error) {
      console.warn('[model-pack] failed to save motion deletion tombstones:', error);
      return false;
    }
  }

  private isMotionDeleted(path: string, packDir?: string): boolean {
    if (isProtectedVoiceActionPath(path)) return false;
    const normalized = normalizeVoiceActionPath(path);
    if (this.deletedMotionPaths.has(normalized)) return true;
    void packDir;
    // Explicit shared and sibling-model paths are canonical and never borrow
    // a tombstone from a model-local `motions/...` path with the same basename.
    // Alias cleanup is handled when a deletion is recorded, while the exact
    // user-owned path remains the authority during every read.
    return false;
  }

  private markMotionDeleted(path: string): boolean {
    if (isProtectedVoiceActionPath(path)) return false;
    const normalized = normalizeVoiceActionPath(path);
    if (!normalized) return false;
    try {
      this.refreshDeletedMotionPaths();
      if (this.deletedMotionPaths.has(normalized)) return true;
      this.deletedMotionPaths.add(normalized);
      if (!this.saveDeletedMotionPaths()) return false;
      this.refreshDeletedMotionPaths();
      return this.deletedMotionPaths.has(normalized);
    } catch (error) {
      console.warn('[model-pack] failed to persist motion deletion:', error);
      return false;
    }
  }

  private clearMotionDeletion(path: string): boolean {
    const normalized = normalizeVoiceActionPath(path);
    try {
      this.refreshDeletedMotionPaths();
      if (!this.deletedMotionPaths.delete(normalized)) return true;
      if (!this.saveDeletedMotionPaths()) return false;
      this.refreshDeletedMotionPaths();
      return !this.deletedMotionPaths.has(normalized);
    } catch (error) {
      console.warn('[model-pack] failed to clear motion deletion:', error);
      return false;
    }
  }

  private motionPathExists(packDir: string, motionPath: string): boolean {
    const normalizedPath = motionPath.replace(/\\/g, '/').trim();
    if (!normalizedPath || extname(normalizedPath).toLowerCase() !== '.vmd') return false;
    const packPath = resolve(packDir, normalizedPath);
    const packRel = relative(packDir, packPath);
    const escapesPack = packRel === '..' || packRel.startsWith('..' + '\\') || packRel.startsWith('..' + '/');
    if (!escapesPack && existsSync(packPath) && statSync(packPath).isFile()) return true;
    const sharedMatch = normalizedPath.match(/^\.\.\/shared\/motions\/(.+\.vmd)$/i);
    if (sharedMatch) {
      for (const root of [this.builtinSharedMotionsRoot, this.sharedMotionsRoot].filter(Boolean) as string[]) {
        const candidate = resolve(root, sharedMatch[1]);
        const rel = relative(root, candidate);
        if (rel !== '..' && !rel.startsWith('..' + '\\') && !rel.startsWith('..' + '/')
          && existsSync(candidate) && statSync(candidate).isFile()) return true;
      }
    }
    const siblingMatch = normalizedPath.match(/^\.\.\/([^/]+)\/motions\/(.+\.vmd)$/i);
    if (siblingMatch) {
      const candidate = resolve(this.builtinRoot, siblingMatch[1], 'motions', siblingMatch[2]);
      const rel = relative(this.builtinRoot, candidate);
      if (rel !== '..' && !rel.startsWith('..' + '\\') && !rel.startsWith('..' + '/')
        && existsSync(candidate) && statSync(candidate).isFile()) return true;
    }
    if (this.sharedMotionsRoot) {
      const candidate = resolve(this.sharedMotionsRoot, basename(normalizedPath));
      const rel = relative(this.sharedMotionsRoot, candidate);
      if (rel !== '..' && !rel.startsWith('..' + '\\') && !rel.startsWith('..' + '/')
        && existsSync(candidate) && statSync(candidate).isFile()) return true;
    }
    return false;
  }

  private canonicalizeGeneratedMotionPath(packDir: string, motionPath: string): string {
    const normalized = motionPath.replace(/\\/g, '/').trim();
    if (!/^motions\//i.test(normalized)) return motionPath;
    const localPath = resolve(packDir, normalized);
    if (existsSync(localPath) && statSync(localPath).isFile()) return motionPath;
    const sharedPath = this.sharedMotionsRoot
      ? resolve(this.sharedMotionsRoot, basename(normalized))
      : null;
    if (sharedPath && existsSync(sharedPath) && statSync(sharedPath).isFile()) {
      return `../shared/motions/${basename(normalized)}`;
    }
    const builtinSharedPath = resolve(this.builtinSharedMotionsRoot, basename(normalized));
    if (existsSync(builtinSharedPath) && statSync(builtinSharedPath).isFile()) {
      return `../shared/motions/${basename(normalized)}`;
    }
    return motionPath;
  }

  private filterMotionPaths(paths: string[] | undefined, packDir: string, removeMissing = false): string[] {
    return (paths ?? []).filter(path => !this.isMotionDeleted(path, packDir)
      && (!removeMissing || this.motionPathExists(packDir, path)));
  }

  private applyMotionDeletionFilter(manifest: ModelPackManifest, packDir: string): void {
    const generatedImport = manifest.model?.credit === '用户导入模型'
      || String(manifest.packId ?? '').startsWith('imported-');
    // Older generated manifests inherited `motions/...` paths from Selena,
    // although imported packs do not contain that directory.  Drop only
    // missing paths for generated imports; established packs and user-authored
    // manifests retain their configured entries exactly as before.
    const canonicalize = (paths: string[]): string[] => generatedImport
      ? Array.from(new Set(paths.map(path => this.canonicalizeGeneratedMotionPath(packDir, path))))
      : paths;
    manifest.motions.customVmd = canonicalize(this.filterMotionPaths(manifest.motions.customVmd, packDir, generatedImport));
    manifest.motions.longActionVmd = canonicalize(this.filterMotionPaths(manifest.motions.longActionVmd, packDir, generatedImport));
    manifest.motions.idleVmdPool = canonicalize(this.filterMotionPaths(manifest.motions.idleVmdPool, packDir, generatedImport));
    if (this.isMotionDeleted(manifest.motions.defaultIdle, packDir)
      || (generatedImport && manifest.motions.defaultIdle.endsWith('.vmd')
        && !this.motionPathExists(packDir, manifest.motions.defaultIdle))) {
      manifest.motions.defaultIdle = manifest.motions.idleVmdPool[0]
        ?? manifest.motions.customVmd[0]
        ?? manifest.motions.longActionVmd[0]
        ?? manifest.motions.idlePacks[0]
        ?? '';
    }
    if (Array.isArray(manifest.motions.vmdEmotionMap)) {
      manifest.motions.vmdEmotionMap = manifest.motions.vmdEmotionMap.filter(
        entry => !this.isMotionDeleted(entry.vmdPath, packDir)
      );
    }
  }

  /** 从 userData settings 恢复模型选择及每模型动作设置。 */
  private restoreModelSettings(): void {
    if (!this.settingsPath) return;
    try {
      if (existsSync(this.settingsPath)) {
        const data = readStrictUtf8Json<Partial<ModelSettingsFile>>(this.settingsPath);
        const motionSettingsByPack: Record<string, PerPackMotionSettings> = {};
        if (data.motionSettingsByPack && typeof data.motionSettingsByPack === 'object') {
          for (const [packId, raw] of Object.entries(data.motionSettingsByPack)) {
            if (!raw || typeof raw !== 'object') continue;
            const settings = raw as PerPackMotionSettings;
            motionSettingsByPack[packId] = {
              ...(typeof settings.defaultIdle === 'string' ? { defaultIdle: settings.defaultIdle } : {}),
              ...(Array.isArray(settings.idleVmdPool)
                ? { idleVmdPool: settings.idleVmdPool.filter((value): value is string => typeof value === 'string') }
                : {}),
              ...(Array.isArray(settings.idlePacks)
                ? { idlePacks: settings.idlePacks.filter((value): value is string => typeof value === 'string') }
                : {}),
              ...(Array.isArray(settings.gesturePacks)
                ? { gesturePacks: settings.gesturePacks.filter((value): value is string => typeof value === 'string') }
                : {})
            };
          }
        }
        this.modelSettings = {
          schemaVersion: 1,
          ...(typeof data.lastPackId === 'string' ? { lastPackId: data.lastPackId } : {}),
          ...(typeof data.updatedAt === 'string' ? { updatedAt: data.updatedAt } : {}),
          motionSettingsByPack
        };
        if (data.lastPackId && typeof data.lastPackId === 'string') {
          // 只记录，不加载（加载由调用方在 switchModel 中完成）
          this.currentPackId = data.lastPackId;
        }
      }
    } catch (e) {
      console.warn('[model-pack] failed to restore model settings:', e);
    }
  }

  private saveModelSettings(): boolean {
    if (!this.settingsPath) return false;
    try {
      writeStrictUtf8JsonAtomic(this.settingsPath, this.modelSettings);
      return true;
    } catch (e) {
      console.warn('[model-pack] failed to save model settings:', e);
      return false;
    }
  }

  private savePackMotionSettings(packId: string, updates: PerPackMotionSettings): boolean {
    // Unit/dev embedders may intentionally omit persistence. The packaged app
    // always supplies settingsPath under userData.
    if (!this.settingsPath && !(this.activeCharacterId && this.characterSettingsRoot)) return true;
    const characterUpdates: PerPackMotionSettings = {
      ...(typeof updates.defaultIdle === 'string' ? { defaultIdle: updates.defaultIdle } : {}),
      ...(Array.isArray(updates.idleVmdPool) ? { idleVmdPool: updates.idleVmdPool } : {})
    };
    const sharedUpdates: PerPackMotionSettings = {
      ...(Array.isArray(updates.idlePacks) ? { idlePacks: updates.idlePacks } : {}),
      ...(Array.isArray(updates.gesturePacks) ? { gesturePacks: updates.gesturePacks } : {})
    };
    if (this.activeCharacterId && this.characterSettingsRoot && Object.keys(characterUpdates).length > 0) {
      const currentCharacter = this.getActiveCharacterMotionSettings(packId) ?? {};
      const legacy = this.modelSettings.motionSettingsByPack[packId] ?? {};
      return this.saveCharacterAvatarSettings({
        modelPackId: packId,
        motion: {
          ...(typeof currentCharacter.defaultIdle === 'string'
            ? { defaultIdle: currentCharacter.defaultIdle }
            : (typeof legacy.defaultIdle === 'string' ? { defaultIdle: legacy.defaultIdle } : {})),
          ...(Array.isArray(currentCharacter.idleVmdPool)
            ? { idleVmdPool: currentCharacter.idleVmdPool }
            : (Array.isArray(legacy.idleVmdPool) ? { idleVmdPool: legacy.idleVmdPool } : {})),
          ...characterUpdates
        }
      });
    }
    const previous = this.modelSettings.motionSettingsByPack[packId] ?? {};
    this.modelSettings.motionSettingsByPack[packId] = { ...previous, ...sharedUpdates, ...characterUpdates };
    this.modelSettings.updatedAt = new Date().toISOString();
    return this.saveModelSettings();
  }

  private applyPackMotionSettings(packId: string, manifest: ModelPackManifest): void {
    const sharedSettings = this.modelSettings.motionSettingsByPack[packId];
    const characterSettings = this.getActiveCharacterMotionSettings(packId);
    const settings = sharedSettings || characterSettings
      ? { ...(sharedSettings ?? {}), ...(characterSettings ?? {}) }
      : undefined;
    if (!settings) return;
    if (Array.isArray(settings.idlePacks)) {
      manifest.motions.idlePacks = Array.from(new Set(settings.idlePacks));
    }
    if (Array.isArray(settings.gesturePacks)) {
      manifest.motions.gesturePacks = Array.from(new Set(settings.gesturePacks));
    }
    const selectableVmd = [
      ...manifest.motions.customVmd,
      ...(manifest.motions.longActionVmd ?? [])
    ];
    const canonicalByPath = new Map(selectableVmd.map(path => [normalizeVoiceActionPath(path), path]));
    if (Array.isArray(settings.idleVmdPool)) {
      manifest.motions.idleVmdPool = Array.from(new Set(settings.idleVmdPool
        .map(path => canonicalByPath.get(normalizeVoiceActionPath(path)))
        .filter((path): path is string => typeof path === 'string'))).slice(0, MAX_IDLE_QUICK_SLOTS);
    }
    if (typeof settings.defaultIdle === 'string') {
      const canonicalVmd = canonicalByPath.get(normalizeVoiceActionPath(settings.defaultIdle));
      const canonicalIdlePack = manifest.motions.idlePacks.find(
        path => normalizeVoiceActionPath(path) === normalizeVoiceActionPath(settings.defaultIdle!)
      );
      const canonical = canonicalVmd ?? canonicalIdlePack;
      if (canonical) manifest.motions.defaultIdle = canonical;
    }
  }

  /**
   * Loose PMX imports receive a generated manifest.  Give them the same
   * shared action surface as the established Selena/Yangyang packs so a new
   * model does not appear to have lost the action library after switching.
   */
  private inheritSharedMotionDefaults(manifest: ModelPackManifest): void {
    const hasGeneratedManifest = manifest.model?.credit === '用户导入模型'
      || String(manifest.packId).startsWith('imported-');
    // Only fill the automatic empty profile. Never overwrite a model which
    // the user has already configured independently.
    const hasEmptyProfile = (manifest.capabilities?.length ?? 0) === 0
      && !manifest.bones?.root
      && manifest.motions.idleVmdPool?.length === 0;
    if (!hasGeneratedManifest || !hasEmptyProfile) return;
    const reference = this.readBuiltinModelReference();
    if (!reference) return;
    // Model-specific morph and bone maps must stay empty until a compatible
    // profile is supplied for this exact PMX.  Only the shared action surface
    // belongs to every model. Do not copy the reference model's local
    // `motions/...` files: those paths do not exist in an imported pack and
    // made the planner select actions that could never be loaded.
    const sharedPaths = this.loadSharedVoiceActions().map(entry => entry.vmdPath);
    const sharedReferencePaths = [
      ...(reference.motions.customVmd ?? []),
      ...(reference.motions.longActionVmd ?? []),
      ...(reference.motions.idleVmdPool ?? [])
    ].filter(path => /^(\.\.\/shared\/motions\/|shared\/motions\/)/i.test(path));
    const mergePaths = (...lists: readonly (string[] | undefined)[]): string[] =>
      Array.from(new Set(lists.flatMap(list => list ?? [])
        .filter(path => typeof path === 'string' && path.trim().length > 0)));
    manifest.motions = {
      ...manifest.motions,
      idlePacks: [],
      gesturePacks: [],
      defaultIdle: manifest.motions.defaultIdle
        || sharedReferencePaths.find(path => /待机 双手后背\.vmd$/i.test(path))
        || sharedPaths.find(path => /待机 双手后背\.vmd$/i.test(path))
        || '',
      customVmd: mergePaths(manifest.motions.customVmd, sharedReferencePaths, sharedPaths),
      longActionVmd: mergePaths(manifest.motions.longActionVmd),
      idleVmdPool: mergePaths(manifest.motions.idleVmdPool, sharedReferencePaths, sharedPaths)
    };
  }

  private readBuiltinModelReference(): ModelPackManifest | null {
    const candidates = [
      join(this.builtinRoot, 'selena-xisheng', 'manifest.json'),
      join(this.builtinRoot, 'yyxuanling', 'manifest.json')
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const manifest = readStrictUtf8Json<ModelPackManifest>(path);
        return manifest;
      } catch { /* try the next reference pack */ }
    }
    return null;
  }

  /**
   * The common model profile is opt-in by actual PMX names, never by model
   * folder name.  This gives ordinary MMD-compatible imports the shared
   * lip-sync/expression behavior while leaving unsupported fields blank.
   */
  private applyCommonMmdProfile(manifest: ModelPackManifest, pmxBytes: Buffer): void {
    const generated = manifest.model?.credit === '用户导入模型'
      || String(manifest.packId).startsWith('imported-');
    if (!generated || manifest.capabilities.length > 0 || manifest.bones.root) return;
    const reference = this.readBuiltinModelReference();
    if (!reference) return;
    let names: Set<string>;
    let boneNames: Set<string>;
    try {
      const parsed = parsePmx(new Uint8Array(pmxBytes));
      names = new Set(parsed.morphs.map(morph => morph.name));
      boneNames = new Set(parsed.bones.map(bone => bone.name));
    } catch {
      return;
    }
    const normalize = (name: string): string => String(name ?? '').normalize('NFKC').trim().toLowerCase();
    const findIfPresent = (name: string, available: Set<string>): string => {
      if (!name) return '';
      if (available.has(name)) return name;
      const wanted = normalize(name);
      for (const candidate of available) if (normalize(candidate) === wanted) return candidate;
      return '';
    };
    const copyIfPresent = (name: string): string => findIfPresent(name, names);
    manifest.morphs.visemes = {
      a: copyIfPresent(reference.morphs.visemes.a), i: copyIfPresent(reference.morphs.visemes.i),
      u: copyIfPresent(reference.morphs.visemes.u), e: copyIfPresent(reference.morphs.visemes.e),
      o: copyIfPresent(reference.morphs.visemes.o)
    };
    manifest.morphs.blink = copyIfPresent(reference.morphs.blink);
    manifest.morphs.emotions = {
      neutral: copyIfPresent(reference.morphs.emotions.neutral),
      serious: copyIfPresent(reference.morphs.emotions.serious),
      happy: copyIfPresent(reference.morphs.emotions.happy),
      smile: copyIfPresent(reference.morphs.emotions.smile),
      surprised: copyIfPresent(reference.morphs.emotions.surprised),
      angry: copyIfPresent(reference.morphs.emotions.angry),
      concerned: copyIfPresent(reference.morphs.emotions.concerned)
    };
    manifest.morphs.shy = copyIfPresent(reference.morphs.shy);
    manifest.morphs.tears = copyIfPresent(reference.morphs.tears);
    manifest.morphs.blush = {
      ...reference.morphs.blush,
      name: copyIfPresent(reference.morphs.blush.name)
    };
    const referenceBones = reference.bones;
    manifest.bones = Object.fromEntries(
      Object.entries(referenceBones).map(([key, value]) => [key, findIfPresent(value, boneNames)])
    ) as unknown as ModelPackManifest['bones'];
    const hasVisemes = Object.values(manifest.morphs.visemes).every(Boolean);
    const hasEmotion = Object.values(manifest.morphs.emotions).some(Boolean);
    manifest.capabilities = [
      ...(hasVisemes ? ['visemes'] : []),
      ...(manifest.morphs.blink ? ['blink'] : []),
      ...(hasEmotion ? ['emotions'] : []),
      ...(manifest.morphs.blush.name ? ['blush'] : []),
      ...(manifest.morphs.shy ? ['shy'] : []),
      ...(manifest.morphs.tears ? ['tears'] : [])
    ];
  }

  /**
   * Derive narrowly-scoped material fixes from the imported PMX itself.
   *
   * Some Selena-family PMX files contain a Face_2+ overlay used for a nose
   * highlight.  After conversion to MeshStandardMaterial that overlay can be
   * rendered as a solid white triangle.  The fix is intentionally bound to
   * the imported manifest/SHA and exact material name; it never copies a
   * Selena morph, bone, or material rule onto an unrelated model.
   */
  private applyImportedMaterialCompatibility(manifest: ModelPackManifest, pmxBytes: Buffer): void {
    const imported = manifest.model?.credit === '用户导入模型'
      || String(manifest.packId).startsWith('imported-');
    if (!imported) return;
    try {
      const parsed = parsePmx(new Uint8Array(pmxBytes));
      const existing = Array.isArray(manifest.materialCompatibility?.rules)
        ? [...manifest.materialCompatibility.rules]
        : [];
      for (let index = 0; index < parsed.materials.length; index += 1) {
        const materialName = String(parsed.materials[index]?.name ?? '').trim();
        if (!/^face[_ ]?2\+$/i.test(materialName)) continue;
        if (existing.some(rule => rule.materialIndex === index && rule.action === 'suppress-color')) continue;
        existing.push({
          materialIndex: index,
          materialName,
          action: 'suppress-color',
          reason: 'PMX Face_2+ 鼻部高光覆盖层在 Standard 材质路径下关闭颜色写入，避免白色三角覆盖。'
        });
      }
      manifest.materialCompatibility = { rules: existing };
    } catch (error) {
      // Material compatibility is a visual enhancement; never reject a model
      // because the optional audit could not be derived.
      console.warn('[model-pack] imported material compatibility audit skipped:', error);
    }
  }

  /** Internal compatibility probe used by unit tests and diagnostics. */
  deriveCommonMmdProfileForTest(morphNames: string[], boneNames: string[]) {
    const reference = this.readBuiltinModelReference();
    if (!reference) return { morphs: EMPTY_IMPORTED_MORPHS, bones: EMPTY_IMPORTED_BONES, capabilities: [] as string[] };
    const normalize = (name: string): string => String(name ?? '').normalize('NFKC').trim().toLowerCase();
    const find = (name: string, available: Set<string>): string => {
      const wanted = normalize(name);
      return Array.from(available).find(candidate => normalize(candidate) === wanted) ?? '';
    };
    const morphs = new Set(morphNames);
    const bones = new Set(boneNames);
    const map = (name: string) => find(name, morphs);
    const mapped = {
      visemes: { a: map(reference.morphs.visemes.a), i: map(reference.morphs.visemes.i), u: map(reference.morphs.visemes.u), e: map(reference.morphs.visemes.e), o: map(reference.morphs.visemes.o) },
      blink: map(reference.morphs.blink),
      emotions: Object.fromEntries(Object.entries(reference.morphs.emotions).map(([key, value]) => [key, map(value)])),
      blush: { ...reference.morphs.blush, name: map(reference.morphs.blush.name) },
      shy: map(reference.morphs.shy),
      tears: map(reference.morphs.tears)
    } as ModelPackManifest['morphs'];
    const mappedBones = Object.fromEntries(Object.entries(reference.bones).map(([key, value]) => [key, find(value, bones)])) as unknown as ModelPackManifest['bones'];
    return { morphs: mapped, bones: mappedBones, capabilities: ['visemes', 'blink', 'emotions'].filter((cap) => cap === 'visemes' ? Object.values(mapped.visemes).every(Boolean) : cap === 'blink' ? Boolean(mapped.blink) : Object.values(mapped.emotions).some(Boolean)) };
  }

  private characterAvatarSettingsPath(characterId = this.activeCharacterId): string | null {
    if (!characterId || !this.characterSettingsRoot) return null;
    const safeId = String(characterId).trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safeId) return null;
    return join(this.characterSettingsRoot, safeId, 'avatar_settings.json');
  }

  private readCharacterAvatarSettings(characterId = this.activeCharacterId): CharacterAvatarSettingsFile | null {
    const path = this.characterAvatarSettingsPath(characterId);
    if (!path || !existsSync(path)) return null;
    try {
      const data = readStrictUtf8Json<Partial<CharacterAvatarSettingsFile>>(path);
      const {
        schemaVersion: _schemaVersion,
        modelPackId: rawModelPackId,
        motion: rawMotion,
        ...preservedSettings
      } = data;
      const motion = rawMotion && typeof rawMotion === 'object' ? rawMotion as PerPackMotionSettings : undefined;
      return {
        ...preservedSettings,
        schemaVersion: 1,
        ...(typeof rawModelPackId === 'string' ? { modelPackId: rawModelPackId } : {}),
        ...(motion ? { motion } : {})
      };
    } catch (error) {
      console.warn('[model-pack] failed to read character avatar settings:', error);
      return null;
    }
  }

  private saveCharacterAvatarSettings(updates: Partial<CharacterAvatarSettingsFile>): boolean {
    const path = this.characterAvatarSettingsPath();
    if (!path) return false;
    const previous = this.readCharacterAvatarSettings() ?? { schemaVersion: 1 };
    try {
      writeStrictUtf8JsonAtomic(path, {
        ...previous,
        ...updates,
        schemaVersion: 1
      });
      return true;
    } catch (error) {
      console.warn('[model-pack] failed to save character avatar settings:', error);
      return false;
    }
  }

  private getActiveCharacterMotionSettings(packId: string): PerPackMotionSettings | undefined {
    const settings = this.readCharacterAvatarSettings();
    if (!settings || (settings.modelPackId && settings.modelPackId !== packId)) return undefined;
    if (!settings.motion) return undefined;
    return {
      ...(typeof settings.motion.defaultIdle === 'string' ? { defaultIdle: settings.motion.defaultIdle } : {}),
      ...(Array.isArray(settings.motion.idleVmdPool) ? { idleVmdPool: settings.motion.idleVmdPool } : {})
    };
  }

  /** 角色切换时刷新角色专属动作/灯光设置；共享动作资源仍由模型包管理。 */
  setActiveCharacterId(characterId: string): void {
    const normalized = String(characterId ?? '').trim();
    if (!normalized || normalized === this.activeCharacterId) return;
    this.activeCharacterId = normalized;
    // 同一模型包可能被多个角色复用，必须重新应用各自的动作设置。
    this.loadedPacks.clear();
  }

  getActiveCharacterId(): string | null {
    return this.activeCharacterId;
  }

  /** 持久化当前选择的 packId */
  private saveLastPackId(): void {
    if (!this.settingsPath || !this.currentPackId) return;
    this.modelSettings.lastPackId = this.currentPackId;
    this.modelSettings.updatedAt = new Date().toISOString();
    this.saveModelSettings();
  }

  // ============================================================
  // 共享语音动作映射表（统一管理，所有模型共享）
  // ============================================================

  /**
   * Filter a shared catalog against one concrete model pack without mutating
   * the user-owned JSON.  Protected head overlays are virtual runtime entries
   * and intentionally bypass the physical VMD check.
   */
  private filterSharedVoiceActionsForPack(
    entries: readonly VmdEmotionEntry[],
    packId?: string
  ): VmdEmotionEntry[] {
    if (!packId) return [...entries];
    const pack = this.loadPack(packId);
    if (!pack) return [...entries];
    return entries.filter(entry => entry.protected === true
      || entry.motionScope === 'head-overlay'
      || this.motionPathExists(pack.packDir, entry.vmdPath));
  }

  /** 加载共享语音动作映射表；传入 packId 时只返回当前模型可解析的动作。 */
  loadSharedVoiceActions(packId?: string): VmdEmotionEntry[] {
    if (!this.voiceActionsPath) {
      return this.filterSharedVoiceActionsForPack(mergeProtectedHeadVoiceActions([]), packId);
    }
    // Always re-read the authoritative user file.  Keeping a process-lifetime
    // cache here allowed a stale renderer/process to write an old catalog over
    // edits made moments earlier in another window.
    try {
      this.refreshDeletedMotionPaths();
    } catch (error) {
      console.warn('[model-pack] failed to refresh motion deletion tombstones:', error);
    }
    const persistedFileExists = existsSync(this.voiceActionsPath);
    const persisted = this.readVoiceActionsFile(this.voiceActionsPath);
    if (persisted) {
      // An existing user catalog is authoritative byte-for-byte. In
      // particular, `dialogueSafe` is metadata and must not silently change a
      // user's explicit `type: gesture` into a voice-pool entry. That previous
      // migration mutated user data on startup, making actions appear to move
      // between pools after a restart.
      this.sharedVoiceActions = {
        ...persisted,
        entries: persisted.entries.filter(entry => !this.isMotionDeleted(entry.vmdPath))
      };
      return this.filterSharedVoiceActionsForPack(
        this.mergeProtectedRuntimeEntries(this.sharedVoiceActions.entries),
        packId
      );
    }
    if (persistedFileExists) {
      // An existing user file is authoritative even when it is invalid. Never
      // replace it with packaged defaults; surface an empty in-memory catalog
      // and leave the original bytes untouched for diagnosis/recovery.
      this.sharedVoiceActions = { schemaVersion: 1, description: '用户语音动作配置读取失败', entries: [] };
      return this.filterSharedVoiceActionsForPack(
        this.mergeProtectedRuntimeEntries(this.sharedVoiceActions.entries),
        packId
      );
    }

    const defaults = this.defaultVoiceActionsPath
      ? this.readVoiceActionsFile(this.defaultVoiceActionsPath)
      : null;
    const normalizedDefaults = defaults?.entries.map(entry => ({
      ...entry,
      emotions: [...entry.emotions]
    }));
    this.sharedVoiceActions = defaults
      ? {
          ...defaults,
          description: `${defaults.description || '默认语音动作映射表'}（用户副本）`,
          entries: (normalizedDefaults ?? [])
            .filter(entry => !this.isMotionDeleted(entry.vmdPath))
        }
      : { schemaVersion: 1, description: '统一语音动作映射表', entries: [] };
    if (defaults && this.voiceActionsPath !== this.defaultVoiceActionsPath) {
      this.saveSharedVoiceActions();
    }
    return this.filterSharedVoiceActionsForPack(
      this.mergeProtectedRuntimeEntries(this.sharedVoiceActions.entries),
      packId
    );
  }

  private readProtectedVoiceActionOverrides(): ProtectedHeadVoiceActionOverrides {
    const path = this.protectedVoiceActionOverridesPath;
    if (!path || !existsSync(path)) return {};
    try {
      const data = readStrictUtf8Json<Partial<ProtectedVoiceActionOverridesFile>>(path);
      if (data.schemaVersion !== 1 || !data.overrides || typeof data.overrides !== 'object') return {};
      const result: Record<string, ProtectedHeadVoiceActionOverride> = {};
      for (const [candidatePath, candidate] of Object.entries(data.overrides)) {
        if (!isProtectedVoiceActionPath(candidatePath) || !candidate || typeof candidate !== 'object') continue;
        const sanitized = sanitizeProtectedHeadVoiceActionUpdates(candidate as Partial<VmdEmotionEntry>);
        if (!sanitized) continue;
        const canonical = PROTECTED_HEAD_VOICE_ACTIONS.find(entry =>
          normalizeProtectedVoiceActionPath(entry.vmdPath) === normalizeProtectedVoiceActionPath(candidatePath)
        );
        if (canonical) result[canonical.vmdPath] = sanitized;
      }
      return result;
    } catch (error) {
      console.warn('[model-pack] failed to read protected voice action overrides:', error);
      return {};
    }
  }

  private mergeProtectedRuntimeEntries(entries: readonly VmdEmotionEntry[]): VmdEmotionEntry[] {
    return mergeProtectedHeadVoiceActions(entries, this.readProtectedVoiceActionOverrides());
  }

  private updateProtectedVoiceAction(vmdPath: string, updates: Partial<VmdEmotionEntry>): boolean {
    const path = this.protectedVoiceActionOverridesPath;
    const sanitized = sanitizeProtectedHeadVoiceActionUpdates(updates);
    if (!path || !sanitized) return false;
    const canonical = PROTECTED_HEAD_VOICE_ACTIONS.find(entry =>
      normalizeProtectedVoiceActionPath(entry.vmdPath) === normalizeProtectedVoiceActionPath(vmdPath)
    );
    if (!canonical) return false;
    const current = this.readProtectedVoiceActionOverrides();
    const previous = current[canonical.vmdPath] ?? {};
    const next: ProtectedVoiceActionOverridesFile = {
      schemaVersion: 1,
      overrides: {
        ...current,
        [canonical.vmdPath]: {
          ...previous,
          ...sanitized,
          ...(sanitized.headTuning
            ? { headTuning: { ...sanitized.headTuning } }
            : {})
        }
      }
    };
    try {
      writeStrictUtf8JsonAtomic(path, next);
      const verified = readStrictUtf8Json<ProtectedVoiceActionOverridesFile>(path);
      return JSON.stringify(verified) === JSON.stringify(next);
    } catch (error) {
      console.warn('[model-pack] failed to update protected voice action:', error);
      return false;
    }
  }

  private readVoiceActionsFile(path: string): VoiceActionsFile | null {
    try {
      if (!existsSync(path)) return null;
      const data = readStrictUtf8Json<VoiceActionsFile>(path);
      if (data.schemaVersion !== 1 || !Array.isArray(data.entries)) return null;
      return data as VoiceActionsFile;
    } catch (e) {
      console.warn('[model-pack] failed to load voice actions:', path, e);
      return null;
    }
  }

  /** 保存共享语音动作映射表 */
  private saveSharedVoiceActions(): boolean {
    if (!this.voiceActionsPath) return false;
    try {
      writeStrictUtf8JsonAtomic(this.voiceActionsPath, this.sharedVoiceActions);
      const verified = this.readVoiceActionsFile(this.voiceActionsPath);
      if (!verified || JSON.stringify(verified) !== JSON.stringify(this.sharedVoiceActions)) {
        throw new Error('voice action catalog verification failed after atomic replacement');
      }
      console.log('[model-pack] shared voice actions saved:', this.sharedVoiceActions?.entries?.length ?? 0, 'entries');
      return true;
    } catch (e) {
      console.warn('[model-pack] failed to save shared voice actions:', e);
      return false;
    }
  }

  /** The user-owned shared catalog is authoritative for every model. */
  getMergedVmdEmotionMap(packId: string): VmdEmotionEntry[] {
    return this.loadSharedVoiceActions(packId);
  }

  /**
   * 添加语音动作到共享映射表。
   * 所有模型立即可用，无需单独同步。
   */
  addVoiceAction(entry: VmdEmotionEntry): boolean {
    if (isProtectedVoiceActionPath(entry.vmdPath)) return false;
    if (!this.clearMotionDeletion(entry.vmdPath)) return false;
    this.sharedVoiceActions = null;
    this.loadSharedVoiceActions(); // 写前重读用户权威文件
    if (!this.sharedVoiceActions) {
      this.sharedVoiceActions = { schemaVersion: 1, description: '统一语音动作映射表', entries: [] };
    }
    // 检查是否已存在（按 vmdPath 去重）
    const normalizedPath = normalizeVoiceActionPath(entry.vmdPath);
    const existing = this.sharedVoiceActions.entries.findIndex(
      e => normalizeVoiceActionPath(e.vmdPath) === normalizedPath
    );
    if (existing >= 0) {
      this.sharedVoiceActions.entries[existing] = entry; // 更新已有条目
    } else {
      this.sharedVoiceActions.entries.push(entry);
    }
    return this.saveSharedVoiceActions();
  }

  /**
   * 从共享映射表中移除语音动作。
   */
  removeVoiceAction(vmdPath: string): boolean {
    if (isProtectedVoiceActionPath(vmdPath)) return false;
    this.sharedVoiceActions = null;
    this.loadSharedVoiceActions();
    const catalog = this.sharedVoiceActions as VoiceActionsFile | null;
    // Voice-pool removal is a user deletion, not merely a transient list edit.
    // Persist the same tombstone used by the action library so a later packaged
    // default/manifest refresh cannot resurrect the entry.
    if (!this.markMotionDeleted(vmdPath)) return false;
    if (!catalog) return true;
    const normalizedPath = normalizeVoiceActionPath(vmdPath);
    const before = catalog.entries.length;
    catalog.entries = catalog.entries.filter(
      entry => normalizeVoiceActionPath(entry.vmdPath) !== normalizedPath
    );
    this.sharedVoiceActions = catalog;
    if (catalog.entries.length === before) return true;
    if (!this.saveSharedVoiceActions()) {
      // The tombstone remains authoritative on this and future starts.
      console.warn('[model-pack] voice catalog write failed; deletion tombstone remains authoritative');
    }
    return true;
  }

  /**
   * Remove only the automatic voice-pool reference for an accepted candidate.
   * The source VMD remains available and no permanent motion tombstone is written.
   */
  removeVoiceActionReference(vmdPath: string): boolean {
    if (isProtectedVoiceActionPath(vmdPath)) return false;
    this.sharedVoiceActions = null;
    this.loadSharedVoiceActions();
    const catalog = this.sharedVoiceActions as VoiceActionsFile | null;
    if (!catalog) return true;
    const normalizedPath = normalizeVoiceActionPath(vmdPath);
    const before = catalog.entries.length;
    catalog.entries = catalog.entries.filter(
      entry => normalizeVoiceActionPath(entry.vmdPath) !== normalizedPath
    );
    this.sharedVoiceActions = catalog;
    return catalog.entries.length === before || this.saveSharedVoiceActions();
  }

  /**
   * 更新语音动作的情绪映射。
   */
  updateVoiceAction(vmdPath: string, updates: Partial<VmdEmotionEntry>): boolean {
    if (isProtectedVoiceActionPath(vmdPath)) {
      return this.updateProtectedVoiceAction(vmdPath, updates);
    }
    this.sharedVoiceActions = null;
    this.loadSharedVoiceActions();
    const catalog = this.sharedVoiceActions as VoiceActionsFile | null;
    if (!catalog) return false;
    const normalizedPath = normalizeVoiceActionPath(vmdPath);
    const entry = catalog.entries.find(
      e => normalizeVoiceActionPath(e.vmdPath) === normalizedPath
    );
    if (!entry) return false;
    Object.assign(entry, updates);
    this.sharedVoiceActions = catalog;
    return this.saveSharedVoiceActions();
  }

  // ============================================================

  // 扫描所有模型包目录，加载 manifest（不校验 PMX，只读 manifest）
  discoverPacks(): ModelPackListItem[] {
    this.materializeLooseModelPacks();
    const items: Array<ModelPackListItem & { modelSha256?: string; generatedImport?: boolean }> = [];
    const scan = (root: string, isBuiltIn: boolean, depth = 0) => {
      if (!existsSync(root)) return;
      for (const entry of readdirSync(root)) {
        const packDir = join(root, entry);
        if (!statSync(packDir).isDirectory()) continue;
        const manifestPath = join(packDir, 'manifest.json');
        if (existsSync(manifestPath)) {
          try {
            const manifest = readStrictUtf8Json<ModelPackManifest>(manifestPath);
            if (manifest.schemaVersion !== 1) continue;
            const generatedImport = manifest.model?.credit === '用户导入模型'
              || String(manifest.packId ?? '').startsWith('imported-');
            items.push({
              packId: manifest.packId,
              displayName: manifest.displayName,
              internalName: manifest.internalName,
              capabilities: manifest.capabilities,
              motionCount: manifest.motions.idlePacks.length +
                           manifest.motions.gesturePacks.length +
                           manifest.motions.customVmd.length +
                           (manifest.motions.longActionVmd?.length ?? 0),
              isBuiltIn,
              modelSha256: generatedImport ? String(manifest.model?.sha256 ?? '').toUpperCase() : undefined,
              generatedImport
            });
          } catch { /* manifest 解析失败跳过 */ }
        } else if (depth < 2) {
          scan(packDir, isBuiltIn, depth + 1);
        }
      }
    };
    scan(this.builtinRoot, true);
    scan(this.userRoot, false);
    // Hide only duplicate user imports with the same verified PMX content.
    // Built-in packs remain visible, and distinct PMX variants in one source
    // folder have distinct hashes and therefore remain separate entries.
    const seenImportedHashes = new Set<string>();
    return items.filter(item => {
      if (!item.generatedImport || !item.modelSha256) return true;
      if (seenImportedHashes.has(item.modelSha256)) return false;
      seenImportedHashes.add(item.modelSha256);
      return true;
    }).map(({ modelSha256: _hash, generatedImport: _generated, ...item }) => item);
  }

  // 加载并校验模型包（校验 PMX SHA-256）
  loadPack(packId: string): LoadedModelPack | null {
    if (this.loadedPacks.has(packId)) {
      return this.loadedPacks.get(packId)!;
    }
    const found = this.findPackDir(packId);
    if (!found) return null;
    const { packDir, isBuiltIn } = found;
    const manifestPath = join(packDir, 'manifest.json');
    let manifest: ModelPackManifest;
    try {
      manifest = readStrictUtf8Json<ModelPackManifest>(manifestPath);
    } catch {
      return null;
    }
    if (manifest.schemaVersion !== 1) return null;

    this.inheritSharedMotionDefaults(manifest);

    // 校验 PMX
    const pmxPath = resolve(packDir, manifest.model.pmxFile);
    if (!existsSync(pmxPath)) return null;
    const bytes = readFileSync(pmxPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase();
    if (sha256 !== manifest.model.sha256.toUpperCase()) {
      return null;
    }
    this.applyCommonMmdProfile(manifest, bytes);
    this.applyImportedMaterialCompatibility(manifest, bytes);

    const loaded: LoadedModelPack = {
      manifest,
      packDir,
      pmxAbsolutePath: pmxPath,
      textureRoot: dirname(pmxPath)   // 纹理与 PMX 同目录（chat6.0 约定）
    };
    this.applyPackMotionSettings(packId, loaded.manifest);
    this.applyMotionDeletionFilter(loaded.manifest, packDir);
    this.loadedPacks.set(packId, loaded);
    void isBuiltIn;
    return loaded;
  }

  // 查找模型包目录
  private findPackDir(packId: string): { packDir: string; isBuiltIn: boolean } | null {
    const check = (root: string, isBuiltIn: boolean, depth = 0): string | null => {
      if (!existsSync(root)) return null;
      for (const entry of readdirSync(root)) {
        const packDir = join(root, entry);
        if (!statSync(packDir).isDirectory()) continue;
        const manifestPath = join(packDir, 'manifest.json');
        if (existsSync(manifestPath)) {
          try {
            const manifest = readStrictUtf8Json<ModelPackManifest>(manifestPath);
            if (manifest.packId === packId) return packDir;
          } catch { /* skip */ }
        } else if (depth < 2) {
          const nested = check(packDir, isBuiltIn, depth + 1);
          if (nested) return nested;
        }
      }
      return null;
    };
    const builtinDir = check(this.builtinRoot, true);
    if (builtinDir) return { packDir: builtinDir, isBuiltIn: true };
    const userDir = check(this.userRoot, false);
    if (userDir) return { packDir: userDir, isBuiltIn: false };
    return null;
  }

  // 切换当前模型
  switchModel(packId: string): SwitchModelResult {
    const loaded = this.loadPack(packId);
    if (!loaded) {
      return { success: false, reason: 'pack-not-found-or-sha-mismatch' };
    }
    const selectionChanged = this.currentPackId !== packId;
    this.currentPackId = packId;
    if (selectionChanged) this.saveLastPackId();
    if (this.activeCharacterId && this.characterSettingsRoot) {
      this.saveCharacterAvatarSettings({ modelPackId: packId });
    }
    return {
      success: true,
      packId,
      displayName: loaded.manifest.displayName,
      sha256: loaded.manifest.model.sha256
    };
  }

  getCurrentPack(): LoadedModelPack | null {
    if (!this.currentPackId) return null;
    return this.loadedPacks.get(this.currentPackId) ?? null;
  }

  getCurrentPackId(): string | null {
    return this.currentPackId;
  }

  // 读取 PMX 字节（供主进程 IPC 返回 ArrayBuffer 给 Renderer）
  readPmxBytes(packId: string): ArrayBuffer | null {
    const loaded = this.loadPack(packId);
    if (!loaded) return null;
    const bytes = readFileSync(loaded.pmxAbsolutePath);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  // 读取纹理（相对路径校验，防止越界）
  resolveTexture(packId: string, relativePath: string): { absolutePath: string; bytes: Buffer } | null {
    const loaded = this.loadPack(packId);
    if (!loaded) return null;
    if (!relativePath || relativePath.includes('\0')) return null;
    const candidate = resolve(loaded.textureRoot, relativePath);
    const rel = relative(loaded.textureRoot, candidate);
    if (rel === '') return null;
    if (rel === '..' || rel.startsWith('..' + '\\') || rel.startsWith('..' + '/')) return null;
    if (!existsSync(candidate)) return null;
    return { absolutePath: candidate, bytes: readFileSync(candidate) };
  }

  // 添加用户导入的 VMD 到公共 motions 目录（所有角色共享）
  // 同步到所有模型：一个模型导入，所有模型的 customVmd 列表同步更新
  importVmd(packId: string, vmdSourcePath: string, displayName?: string): { success: boolean; relativePath?: string; reason?: string } {
    const loaded = this.loadPack(packId);
    if (!loaded) return { success: false, reason: 'pack-not-found' };
    if (extname(vmdSourcePath).toLowerCase() !== '.vmd') {
      return { success: false, reason: 'not-vmd' };
    }
    const motionsDir = this.sharedMotionsRoot ?? join(loaded.packDir, 'motions');
    if (!existsSync(motionsDir)) mkdirSync(motionsDir, { recursive: true });
    const fileName = displayName
      ? `${displayName.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.vmd`
      : basename(vmdSourcePath);
    const destPath = join(motionsDir, fileName);
    // 复制字节（不修改源）
    const bytes = readFileSync(vmdSourcePath);
    writeFileSync(destPath, bytes);
    const relPath = `motions/${fileName}`;
    const sharedRelPath = `../shared/motions/${fileName}`;
    if (!this.clearMotionDeletion(sharedRelPath)) {
      return { success: false, reason: 'motion-deletion-write-failed' };
    }
    
    // 同步到所有模型：每个模型的 customVmd 列表都添加此 VMD
    this.syncVmdToAllModels(sharedRelPath, 'add');
    
    return { success: true, relativePath: sharedRelPath };
  }

  /**
   * 将外部备选池中的 VMD 复制到共享动作池的时长目录。
   * 这是“加入动作池”的唯一写入入口：源文件保持不变，所有模型只登记
   * 同一个共享路径。时长目录仅按播放时长划分，不参与情绪或骨骼推断。
   */
  importCandidateVmd(
    packId: string,
    vmdSourcePath: string,
    durationSeconds: number
  ): { success: boolean; relativePath?: string; folder?: 'short' | 'medium' | 'long'; reason?: string } {
    const loaded = this.loadPack(packId);
    if (!loaded) return { success: false, reason: 'pack-not-found' };
    if (!existsSync(vmdSourcePath) || !statSync(vmdSourcePath).isFile()) {
      return { success: false, reason: 'source-not-found' };
    }
    if (extname(vmdSourcePath).toLowerCase() !== '.vmd') {
      return { success: false, reason: 'not-vmd' };
    }
    const folder: 'short' | 'medium' | 'long' = durationSeconds <= 3
      ? 'short'
      : durationSeconds <= 8 ? 'medium' : 'long';
    const motionsDir = this.sharedMotionsRoot ?? join(loaded.packDir, 'motions');
    const targetDir = join(motionsDir, folder);
    mkdirSync(targetDir, { recursive: true });

    const sourceBytes = readFileSync(vmdSourcePath);
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex').slice(0, 8);
    const originalName = basename(vmdSourcePath);
    const stem = originalName.replace(/\.vmd$/i, '');
    let fileName = originalName;
    let targetPath = join(targetDir, fileName);
    if (existsSync(targetPath)) {
      const same = statSync(targetPath).isFile()
        && createHash('sha256').update(readFileSync(targetPath)).digest('hex').slice(0, 8) === sourceHash;
      if (!same) {
        fileName = `${stem}-candidate-${sourceHash}.vmd`;
        targetPath = join(targetDir, fileName);
      }
    }
    if (!existsSync(targetPath)) copyFileSync(vmdSourcePath, targetPath);

    const sharedRelPath = `../shared/motions/${folder}/${fileName}`;
    if (!this.clearMotionDeletion(sharedRelPath)) {
      return { success: false, reason: 'motion-deletion-write-failed' };
    }
    this.syncVmdToAllModels(sharedRelPath, 'add');
    if (folder === 'long') this.syncLongVmdToAllModels(sharedRelPath, 'add');
    return { success: true, relativePath: sharedRelPath, folder };
  }

  /**
   * 同步 VMD 到所有已加载的模型包。
   * mode: 'add' 添加到所有模型的 customVmd 列表，'remove' 从所有模型移除。
   */
  private syncVmdToAllModels(vmdPath: string, mode: 'add' | 'remove'): void {
    // 遍历所有已加载的模型包
    const packIds = Array.from(this.loadedPacks.keys());
    // 扫描所有模型包目录（包括未加载的）
    const allPackIds = new Set<string>(packIds);
    this.collectManifestPackIds(allPackIds);
    
    for (const pid of allPackIds) {
      const pack = this.loadPack(pid);
      if (!pack) continue;
      let changed = false;
      if (mode === 'add') {
        if (!pack.manifest.motions.customVmd.includes(vmdPath)) {
          pack.manifest.motions.customVmd.push(vmdPath);
          changed = true;
        }
      } else {
        const idx = pack.manifest.motions.customVmd.indexOf(vmdPath);
        if (idx !== -1) {
          pack.manifest.motions.customVmd.splice(idx, 1);
          // 同时从 idleVmdPool 中移除
          if (Array.isArray(pack.manifest.motions.idleVmdPool)) {
            const poolIdx = pack.manifest.motions.idleVmdPool.indexOf(vmdPath);
            if (poolIdx !== -1) pack.manifest.motions.idleVmdPool.splice(poolIdx, 1);
          }
          // 如果是默认待机，清除默认
          if (pack.manifest.motions.defaultIdle === vmdPath) {
            pack.manifest.motions.defaultIdle = pack.manifest.motions.customVmd[0] || pack.manifest.motions.idlePacks[0] || '';
          }
          changed = true;
        }
      }
      if (changed) {
        // The portable-release launch audit starts the packaged app with a
        // disposable shared-data directory. Shared voice-actions.json is the
        // runtime authority, so do not rewrite read-only packaged manifests
        // during that audit; otherwise the staging launch changes a file
        // after release-manifest.json was hashed and the commit can never
        // pass its own integrity check. Normal user sessions still persist
        // the synchronized list for backward compatibility.
        const builtinRoot = resolve(this.builtinRoot).replace(/[\\/]$/, '');
        const packRoot = resolve(pack.packDir);
        const isBuiltInPack = packRoot === builtinRoot
          || packRoot.startsWith(`${builtinRoot}${packRoot.includes('\\') ? '\\' : '/'}`);
        if (process.env.CHATX2_RELEASE_AUDIT === '1' && isBuiltInPack) continue;
        writeStrictUtf8JsonAtomic(join(pack.packDir, 'manifest.json'), pack.manifest);
        console.log(`[model-pack] synced VMD ${mode} to pack ${pid}: ${vmdPath}`);
      }
    }
  }

  /** Collect manifests from the same two-level layout used by discovery. */
  private collectManifestPackIds(target: Set<string>): void {
    const scan = (root: string, depth = 0): void => {
      if (!existsSync(root)) return;
      for (const entry of readdirSync(root)) {
        const packDir = join(root, entry);
        if (!statSync(packDir).isDirectory()) continue;
        const manifestPath = join(packDir, 'manifest.json');
        if (existsSync(manifestPath)) {
          try {
            const manifest = readStrictUtf8Json<ModelPackManifest>(manifestPath);
            if (manifest.packId) target.add(manifest.packId);
          } catch { /* ignore malformed/non-model folders */ }
        } else if (depth < 2) {
          scan(packDir, depth + 1);
        }
      }
    };
    scan(this.builtinRoot);
    scan(this.userRoot);
  }

  // 读取自定义 VMD 字节
  // 优先从角色 motions 目录读取，找不到时回退到公共 motions 目录
  resolveCustomVmdPath(packId: string, relativePath: string): string | null {
    const loaded = this.loadPack(packId);
    if (!loaded) return null;
    if (!relativePath || relativePath.includes('\0') || extname(relativePath).toLowerCase() !== '.vmd') {
      return null;
    }

    const packPath = resolve(loaded.packDir, relativePath);
    const packRel = relative(loaded.packDir, packPath);
    const escapesPack = packRel === '..' || packRel.startsWith('..' + '\\') || packRel.startsWith('..' + '/');
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');
    const isCanonicalSharedPath = /^\.\.\/shared\/motions\/[^/].*\.vmd$/i.test(normalizedRelativePath);
    const isCanonicalSiblingMotion = /^\.\.\/[^/]+\/motions\/[^/].*\.vmd$/i.test(normalizedRelativePath);
    if (escapesPack && !isCanonicalSharedPath && !isCanonicalSiblingMotion) {
      return null;
    }
    // Canonical shared resources are global. Resolve them before legacy
    // sibling aliases so imported models never depend on selena-xisheng.
    if (isCanonicalSharedPath) {
      const sharedName = normalizedRelativePath.slice('../shared/motions/'.length);
      for (const root of [this.builtinSharedMotionsRoot, this.sharedMotionsRoot].filter(Boolean) as string[]) {
        const sharedPath = resolve(root, sharedName);
        const sharedRel = relative(root, sharedPath);
        const escapesShared = sharedRel === '..' || sharedRel.startsWith('..' + '\\') || sharedRel.startsWith('..' + '/');
        if (!escapesShared && existsSync(sharedPath) && statSync(sharedPath).isFile()) return sharedPath;
      }
    }
    if (!escapesPack && existsSync(packPath) && statSync(packPath).isFile()) {
      return packPath;
    }
    if (escapesPack && isCanonicalSharedPath) {
      const builtinRelative = relative(this.builtinRoot, packPath);
      const escapesBuiltin = builtinRelative === '..' || builtinRelative.startsWith('..' + '\\') || builtinRelative.startsWith('..' + '/');
      if (!escapesBuiltin && existsSync(packPath) && statSync(packPath).isFile()) {
        return packPath;
      }
    }

    if (escapesPack && isCanonicalSiblingMotion) {
      // Imported packs live below `<models>/imported/<pack>`.  A shared
      // catalog entry such as `../selena-xisheng/motions/foo.vmd` refers to
      // the sibling built-in pack at `<models>/selena-xisheng`, not to
      // `<models>/imported/selena-xisheng`.  Resolve that canonical alias
      // explicitly while keeping the target constrained to builtinRoot.
      const siblingMatch = normalizedRelativePath.match(/^\.\.\/([^/]+)\/motions\/(.+\.vmd)$/i);
      if (siblingMatch) {
        const siblingName = siblingMatch[1];
        const motionRelative = siblingMatch[2];
        const builtinSiblingPath = resolve(this.builtinRoot, siblingName, 'motions', motionRelative);
        const builtinRelative = relative(this.builtinRoot, builtinSiblingPath);
        const escapesBuiltin = builtinRelative === '..'
          || builtinRelative.startsWith('..' + '\\')
          || builtinRelative.startsWith('..' + '/');
        if (!escapesBuiltin && existsSync(builtinSiblingPath) && statSync(builtinSiblingPath).isFile()) {
          return builtinSiblingPath;
        }
      }
      // Preserve the legacy case where the pack itself is directly under the
      // built-in root and the relative path already resolves correctly.
      const builtinRelative = relative(this.builtinRoot, packPath);
      const escapesBuiltin = builtinRelative === '..' || builtinRelative.startsWith('..' + '\\') || builtinRelative.startsWith('..' + '/');
      if (!escapesBuiltin && existsSync(packPath) && statSync(packPath).isFile()) {
        return packPath;
      }
    }

    if (this.sharedMotionsRoot) {
      const sharedPath = resolve(this.sharedMotionsRoot, basename(relativePath));
      const sharedRel = relative(this.sharedMotionsRoot, sharedPath);
      const escapesShared = sharedRel === '..' || sharedRel.startsWith('..' + '\\') || sharedRel.startsWith('..' + '/');
      if (!escapesShared && existsSync(sharedPath) && statSync(sharedPath).isFile()) {
        return sharedPath;
      }
    }
    return null;
  }

  // 读取自定义 VMD 字节
  // 优先从角色 motions 目录读取，找不到时回退到公共 motions 目录
  readCustomVmd(packId: string, relativePath: string): ArrayBuffer | null {
    const resolvedPath = this.resolveCustomVmdPath(packId, relativePath);
    if (!resolvedPath) return null;
    const bytes = readFileSync(resolvedPath);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  // 设置默认 idle pack（支持内置 idle pack ID、customVmd 路径或 longActionVmd 路径）
  setDefaultIdle(packId: string, idleOrVmdPath: string): boolean {
    const loaded = this.loadPack(packId);
    if (!loaded) return false;
    const isCustomVmd = loaded.manifest.motions.customVmd.includes(idleOrVmdPath);
    const isIdlePack = loaded.manifest.motions.idlePacks.includes(idleOrVmdPath);
    const isLongAction = Array.isArray(loaded.manifest.motions.longActionVmd) &&
                         loaded.manifest.motions.longActionVmd.includes(idleOrVmdPath);
    if (!isIdlePack && !isCustomVmd && !isLongAction) return false;
    const previous = loaded.manifest.motions.defaultIdle;
    loaded.manifest.motions.defaultIdle = idleOrVmdPath;
    if (!this.savePackMotionSettings(packId, { defaultIdle: idleOrVmdPath })) {
      loaded.manifest.motions.defaultIdle = previous;
      return false;
    }
    return true;
  }

  // 启用/停用内置动作 pack
  toggleMotionPack(packId: string, motionPackId: string, enabled: boolean, type: 'idle' | 'gesture'): boolean {
    const loaded = this.loadPack(packId);
    if (!loaded) return false;
    const list = type === 'idle' ? loaded.manifest.motions.idlePacks : loaded.manifest.motions.gesturePacks;
    const idx = list.indexOf(motionPackId);
    if (enabled && idx === -1) list.push(motionPackId);
    else if (!enabled && idx !== -1) list.splice(idx, 1);
    else return true; // 无变化
    if (!this.savePackMotionSettings(packId, type === 'idle'
      ? { idlePacks: [...loaded.manifest.motions.idlePacks] }
      : { gesturePacks: [...loaded.manifest.motions.gesturePacks] })) {
      if (enabled) list.splice(list.indexOf(motionPackId), 1);
      else list.splice(idx, 0, motionPackId);
      return false;
    }
    return true;
  }

  // 将 customVmd 或 longActionVmd 加入/移出待机轮换池
  // vmdPath 必须已存在于 customVmd 或 longActionVmd 列表中
  toggleIdleVmd(packId: string, vmdPath: string, inPool: boolean): boolean {
    const loaded = this.loadPack(packId);
    if (!loaded) return false;
    // 校验 vmdPath 存在于 customVmd 或 longActionVmd
    const isCustomVmd = loaded.manifest.motions.customVmd.includes(vmdPath);
    const isLongAction = Array.isArray(loaded.manifest.motions.longActionVmd) &&
                         loaded.manifest.motions.longActionVmd.includes(vmdPath);
    if (!isCustomVmd && !isLongAction) return false;
    // 确保 idleVmdPool 数组存在
    if (!Array.isArray(loaded.manifest.motions.idleVmdPool)) {
      loaded.manifest.motions.idleVmdPool = [];
    }
    const pool = loaded.manifest.motions.idleVmdPool;
    const idx = pool.indexOf(vmdPath);
    if (inPool && idx === -1) {
      if (pool.length >= MAX_IDLE_QUICK_SLOTS) return false;
      pool.push(vmdPath);
    } else if (!inPool && idx !== -1) {
      pool.splice(idx, 1);
    } else {
      return true; // 无变化
    }
    if (!this.savePackMotionSettings(packId, { idleVmdPool: [...pool] })) {
      if (inPool) pool.splice(pool.indexOf(vmdPath), 1);
      else pool.splice(idx, 0, vmdPath);
      return false;
    }
    return true;
  }

  // 导入长时间 VMD 动作（舞蹈/场景），保存到公共 motions 目录，同步到所有模型
  importLongVmd(packId: string, vmdSourcePath: string, displayName?: string): { success: boolean; relativePath?: string; reason?: string } {
    const loaded = this.loadPack(packId);
    if (!loaded) return { success: false, reason: 'pack-not-found' };
    if (extname(vmdSourcePath).toLowerCase() !== '.vmd') {
      return { success: false, reason: 'not-vmd' };
    }
    const motionsDir = this.sharedMotionsRoot ?? join(loaded.packDir, 'motions');
    if (!existsSync(motionsDir)) mkdirSync(motionsDir, { recursive: true });
    const fileName = displayName
      ? `${displayName.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.vmd`
      : basename(vmdSourcePath);
    const destPath = join(motionsDir, fileName);
    const bytes = readFileSync(vmdSourcePath);
    writeFileSync(destPath, bytes);
    const sharedRelPath = `../shared/motions/${fileName}`;
    if (!this.clearMotionDeletion(sharedRelPath)) {
      return { success: false, reason: 'motion-deletion-write-failed' };
    }
    
    // 同步到所有模型的 longActionVmd 列表
    this.syncLongVmdToAllModels(sharedRelPath, 'add');
    
    return { success: true, relativePath: sharedRelPath };
  }

  /**
   * 同步长时间 VMD 到所有模型包。
   */
  private syncLongVmdToAllModels(vmdPath: string, mode: 'add' | 'remove'): void {
    const packIds = Array.from(this.loadedPacks.keys());
    const allPackIds = new Set<string>(packIds);
    this.collectManifestPackIds(allPackIds);
    
    for (const pid of allPackIds) {
      const pack = this.loadPack(pid);
      if (!pack) continue;
      if (!Array.isArray(pack.manifest.motions.longActionVmd)) {
        pack.manifest.motions.longActionVmd = [];
      }
      let changed = false;
      if (mode === 'add') {
        if (!pack.manifest.motions.longActionVmd.includes(vmdPath)) {
          pack.manifest.motions.longActionVmd.push(vmdPath);
          changed = true;
        }
      } else {
        const idx = pack.manifest.motions.longActionVmd.indexOf(vmdPath);
        if (idx !== -1) {
          pack.manifest.motions.longActionVmd.splice(idx, 1);
          // 同时从待机轮换池中移除
          if (Array.isArray(pack.manifest.motions.idleVmdPool)) {
            const poolIdx = pack.manifest.motions.idleVmdPool.indexOf(vmdPath);
            if (poolIdx !== -1) pack.manifest.motions.idleVmdPool.splice(poolIdx, 1);
          }
          changed = true;
        }
      }
      if (changed) {
        writeStrictUtf8JsonAtomic(join(pack.packDir, 'manifest.json'), pack.manifest);
        console.log(`[model-pack] synced longVMD ${mode} to pack ${pid}: ${vmdPath}`);
      }
    }
  }

  // 移除自定义 VMD 动作（同步到所有模型）
  removeCustomVmd(_packId: string, relativePath: string): boolean {
    return this.removeLibraryVmd(relativePath).success;
  }

  // 移除长时间 VMD 动作（同步到所有模型）
  removeLongVmd(_packId: string, relativePath: string): boolean {
    return this.removeLibraryVmd(relativePath).success;
  }

  /**
   * Remove a motion from every library index and permanently delete the
   * shared VMD copy. The tombstone remains as an upgrade guard so a packaged
   * default cannot resurrect the deleted motion.
   */
  removeLibraryVmd(vmdPath: string): { success: boolean; removedReferences: number; reason?: string } {
    let removedReferences = 0;
    const normalizedPath = normalizeVoiceActionPath(vmdPath);

    if (!normalizedPath) {
      return { success: false, removedReferences: 0, reason: 'invalid-motion-path' };
    }
    if (isProtectedVoiceActionPath(vmdPath)) {
      return { success: false, removedReferences: 0, reason: 'protected-voice-action' };
    }
    // Capture the current user catalog before adding the tombstone; loading it
    // afterwards would correctly filter the entry but lose the opportunity to
    // physically remove it from the persisted catalog.
    this.sharedVoiceActions = null;
    this.loadSharedVoiceActions();
    const catalog = this.sharedVoiceActions as VoiceActionsFile | null;
    // The tombstone is authoritative even when the packaged model directory is
    // read-only or gets replaced by a later release update.
    if (!this.markMotionDeleted(vmdPath)) {
      return { success: false, removedReferences: 0, reason: 'motion-deletion-write-failed' };
    }

    if (catalog) {
      const before = catalog.entries.length;
      catalog.entries = catalog.entries.filter(
        entry => !this.isMotionDeleted(entry.vmdPath, this.getCurrentPack()?.packDir)
      );
      this.sharedVoiceActions = catalog;
      const removed = before - catalog.entries.length;
      if (removed > 0) {
        if (!this.saveSharedVoiceActions()) {
          console.warn('[model-pack] voice catalog write failed; deletion tombstone remains authoritative');
        }
        removedReferences += removed;
      }
    }

    const allPackIds = new Set(this.loadedPacks.keys());
    for (const root of [this.builtinRoot, this.userRoot]) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root)) {
        const packDir = join(root, entry);
        if (!statSync(packDir).isDirectory()) continue;
        const manifestPath = join(packDir, 'manifest.json');
        if (!existsSync(manifestPath)) continue;
        try {
          const manifest = readStrictUtf8Json<ModelPackManifest>(manifestPath);
          if (typeof manifest.packId === 'string') allPackIds.add(manifest.packId);
        } catch { /* invalid packs are ignored by discovery too */ }
      }
    }

    for (const packId of allPackIds) {
      const pack = this.loadPack(packId);
      if (!pack) continue;
      const motions = pack.manifest.motions;
      let changed = false;
      for (const key of ['customVmd', 'longActionVmd', 'idleVmdPool'] as const) {
        const values = motions[key];
        if (!Array.isArray(values)) continue;
        const before = values.length;
        motions[key] = values.filter(path => !this.isMotionDeleted(path, pack.packDir));
        const removed = before - motions[key]!.length;
        if (removed > 0) {
          removedReferences += removed;
          changed = true;
        }
      }
      if (Array.isArray(motions.vmdEmotionMap)) {
        const before = motions.vmdEmotionMap.length;
        motions.vmdEmotionMap = motions.vmdEmotionMap.filter(
          entry => !this.isMotionDeleted(entry.vmdPath, pack.packDir)
        );
        const removed = before - motions.vmdEmotionMap.length;
        if (removed > 0) {
          removedReferences += removed;
          changed = true;
        }
      }
      if (this.isMotionDeleted(motions.defaultIdle, pack.packDir)) {
        motions.defaultIdle = motions.idleVmdPool?.[0]
          ?? motions.customVmd[0]
          ?? motions.idlePacks[0]
          ?? '';
        removedReferences += 1;
        changed = true;
      }
      if (changed) {
        try {
          writeStrictUtf8JsonAtomic(join(pack.packDir, 'manifest.json'), pack.manifest);
        } catch (error) {
          console.warn('[model-pack] packaged manifest is not writable; using deletion tombstone:', error);
        }
      }
    }

    // Permanently delete the physical VMD from every authoritative motion
    // root. This prevents the next release build from reintroducing a motion
    // that the user deliberately deleted.
    const canonicalPath = vmdPath.replace(/\\/g, '/').trim();
    const fileName = basename(canonicalPath);
    if (fileName && extname(fileName).toLowerCase() === '.vmd') {
      const physicalCandidates = new Set<string>();
      if (this.sharedMotionsRoot) physicalCandidates.add(resolve(this.sharedMotionsRoot, fileName));
      const sharedMotionMatch = canonicalPath.match(/^\.\.\/shared\/motions\/(.+\.vmd)$/i);
      if (sharedMotionMatch) {
        const sharedRelative = sharedMotionMatch[1];
        if (this.sharedMotionsRoot) physicalCandidates.add(resolve(this.sharedMotionsRoot, sharedRelative));
        physicalCandidates.add(resolve(this.builtinRoot, 'shared', 'motions', sharedRelative));
      } else {
        const siblingMatch = canonicalPath.match(/^\.\.\/([^/]+)\/motions\//i);
        if (siblingMatch) {
          physicalCandidates.add(resolve(this.builtinRoot, siblingMatch[1], 'motions', fileName));
          physicalCandidates.add(resolve(this.userRoot, siblingMatch[1], 'motions', fileName));
        } else if (/^motions\//i.test(canonicalPath)) {
          const currentPack = this.getCurrentPack();
          if (currentPack) physicalCandidates.add(resolve(currentPack.packDir, 'motions', fileName));
        }
      }
      for (const physical of physicalCandidates) {
        if (!existsSync(physical) || !statSync(physical).isFile()) continue;
        try {
          unlinkSync(physical);
          console.log(`[model-pack] permanently deleted VMD: ${physical}`);
          removedReferences += 1;
        } catch (error) {
          return { success: false, removedReferences, reason: `motion-file-delete-failed: ${(error as Error).message}` };
        }
      }
    }

    return removedReferences > 0
      ? { success: true, removedReferences }
      : { success: true, removedReferences: 0 };
  }
}
