// ChatX2 Electron 主进程入口
// 职责：身份设置、ModeController、三窗口管理、托盘、IPC、事务性模式切换
// Phase 2 修复要点：
// - 三个 preload 按权限分离：chat/avatar/composer 各自独立
// - avatar-placeholder-ready 校验 event.sender === avatarWindow.webContents
// - 使用正确事件名 render-process-gone（非 render-gone）
// - 事务性切换：transition(desktop) → loading → showDesktopWindows → commitDesktop；失败 rollbackDesktop
// - test-only-ready 证据源仅测试模式可用
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell, screen, session } from 'electron';
import { ensureLiveWindow, restoreChatFromTray } from './tray-chat-recovery';
import { shouldHideChatWindowOnClose } from './chat-window-lifecycle';
import { join, resolve, dirname, relative as pathRelative, basename, extname } from 'node:path';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, cpSync, copyFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync, fork } from 'node:child_process';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { ModeController } from './mode-controller';
import type { AppMode, AvatarReadyEvidence, ModeChangeEvent } from './mode-controller';
import { createChatWindow } from './windows/chat-window';
import { createDesktopAvatarWindow } from './windows/desktop-avatar-window';
import { createDesktopComposerWindow } from './windows/desktop-composer-window';
import {
  resolveModelAsset,
  type SelectedModel
} from './model-selection';
// Phase 4: 唯一 ConversationController + Mock Chat Adapter
import { ConversationController } from '../src/conversation/conversation-controller';
import { createConversationAdapters } from '../src/conversation/conversation-adapter-factory';
import type { ConversationSubmit } from '../src/conversation/conversation-types';
import { parseConversationText, resolveConversationSource } from './conversation-ipc-policy';
// Phase 5.2 修正（2026-07-19）：主进程持有 MotionPackRegistry 与生命周期
// - 主进程持有 Registry 单例，所有 pack 注册/查询/释放都在主进程
// - Renderer 不能自行信任路径，必须通过 motion IPC 请求主进程
// - 所有动作通过 models/selena-xisheng/motions/ 目录下的 VMD 文件加载
import { MotionPackRegistry } from '../src/motion/motion-pack-registry';
import { getMotionRuntimeMode } from '../src/motion/motion-runtime-mode';
import {
  CandidateReviewMotionCatalog,
  createCandidateReviewMotionDefinitions
} from './candidate-review-motion-catalog';
import { validateCandidateReviewRequest } from './candidate-review-ipc-policy';
import { normalizeAvatarSyncStopReason } from './avatar-sync-stop-policy';
import {
  DEFAULT_TRANSITION_SPEED,
  loadTransitionSpeed,
  MAX_TRANSITION_SPEED,
  MIN_TRANSITION_SPEED,
  saveTransitionSpeed
} from './transition-speed-settings';
import {
  loadAvatarComputeLevel,
  saveAvatarComputeLevel
} from './avatar-compute-settings';
import {
  DEFAULT_AVATAR_EXPRESSION,
  isValidDefaultExpression,
  loadDefaultAvatarExpression,
  saveDefaultAvatarExpression
} from './default-avatar-expression-settings';
import {
  isAvatarComputeLevel,
  type AvatarComputeLevel
} from '../src/performance/avatar-compute-profile';
// Phase 6: 旧 idle/gesture 程序化动作已删除，不再需要导入
import { derivePerformanceSemantic, resolvePlaybackSemantic } from '../src/performance/semantic-performance';
import type { PerformanceSemantic } from '../src/performance/semantic-performance';
// ChatX2 模型包系统：支持多模型切换、动作管理、VMD 导入
import { ModelPackManager } from '../src/model-pack/model-pack-manager';
import { MAX_IDLE_QUICK_SLOTS } from '../src/model-pack/idle-quick-slots';
import type { ModelPackListItem, SwitchModelResult } from '../src/model-pack/model-pack-types';
import { BUILD_ID, BUILD_META } from '../src/build-identity';
import { isVoiceActionPoolEntry } from '../src/performance/voice-action-pool';
import { isProtectedVoiceActionPath } from '../src/performance/protected-head-voice-actions';
import { DailyPerformanceCandidateStore } from './daily-performance-candidate-store';
import { AcceptedSpeechExpressionStore } from './accepted-speech-expression-store';
import { DailyPerformanceCandidatePromotionService } from './daily-performance-candidate-promotion';
import {
  DailyPerformanceCandidateController,
  validatePerformanceCandidateSender
} from './daily-performance-candidate-ipc';
import type {
  ExpressionCandidateRecord,
  MotionCandidateRecord
} from '../src/performance/daily-candidate-types';
import {
  mergeLightingPresetSummaries
} from './character-avatar-preferences';
import { clampLightingContrast, clampLightingSaturation } from '../src/lighting/contrast';

// Some Windows systems terminate Electron's GPU subprocess during sandbox
// bootstrap (0xC0000135). Keep hardware/WebGL rendering enabled while only
// disabling the GPU-process sandbox; renderer sandbox settings are unchanged.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// 桌宠渲染帧率修复（2026-08 实测定位）：
// 透明 + 点击穿透（setIgnoreMouseEvents forward）+ alwaysOnTop 的 Avatar
// 窗口会被 Windows 的 NativeWindowOcclusionTracker 误判为"被遮挡"，
// Chromium 把 rAF 节流到 ~20fps（实测每帧实际工作仅 4.3ms 却有 48ms
// 间隔）。backgroundThrottling:false 管不到 occlusion 节流路径。
// 三个开关分别禁用：后台渲染降级 / 后台定时器节流 / 被遮挡窗口节流。
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// ChatX2 独立身份（基于 chat6.0 架构，端口/userData/appId 完全隔离）
const APP_ID = 'com.wha1999.chatx2.selena';
const PRODUCT_NAME = 'iris-chat';
const APP_NAME = 'IrisChat';
const EXPRESS_PORT_DEFAULT = 3013;
const TTS_PORT_RESERVED = 9882;
// VMD 备选池默认随 ChatX2 一起发布，路径根据当前 resources/app 位置
// 计算；用户仍可通过环境变量覆盖到自己的候选目录。这样移动发布目录
// 或在另一台电脑运行时，不会回落到开发机盘符。
const EXTERNAL_VMD_CANDIDATE_ROOT = resolve(
  process.env.CHATX2_VMD_CANDIDATE_ROOT?.trim() ||
  resolve(__dirname, '..', '..', 'models', 'shared', 'conversation-motion-candidates')
);

// 模型路径（只读访问 chat6.0 原模型，不复制/转换/上传/分发）
// 开发模式直接指向 chat6.0 的原 PMX；Task 5 通过 selectVerifiedModel 校验 SHA-256
// chatx2:select-pmx-model IPC 已实现，用户可选择其他路径（须同样哈希校验）

// 当前选中的模型由 ModelPackManager 从当前应用的 models/或 userData/models
// 恢复。初始化为空，避免在编译产物中固化任何开发机模型路径；用户仍可
// 通过“选择模型”导入并经过哈希校验。
// 用户通过 chatx2:select-pmx-model IPC 可切换（须同样哈希校验，失败返回 reason 不变更 selectedModel）
let selectedModel: SelectedModel | null = null;

// ChatX2 模型包管理器：扫描/加载/切换模型包，管理动作配置
// 内置包根目录 = chatX2/models；用户包根目录 = userData/models
// 启动时自动切换到内置 selena-xisheng-v1（兼容旧 selectedModel 路径）
// 注意：userPacksRoot 依赖 userDataDir，在 userDataDir 定义后初始化
const builtinPacksRoot = resolve(__dirname, '..', '..', 'models');
let modelPackManager: ModelPackManager;
const DEFAULT_MODEL_PACK_ID = 'selena-q-example';

// 从 package.json 读取版本
function findPackageJson(): string {
  const devPath = resolve(__dirname, '..', '..', 'package.json');
  const packagedPath = resolve(process.resourcesPath, 'app', 'package.json');
  try {
    readFileSync(devPath, 'utf-8');
    return devPath;
  } catch {
    return packagedPath;
  }
}
const pkgPath = findPackageJson();
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const APP_VERSION = pkg.version;

// 测试模式必须使用临时 userData
const IS_TEST = process.env.NODE_ENV === 'test';
const IS_RELEASE_AUDIT = process.env.CHATX2_RELEASE_AUDIT === '1';
let tempUserDataDir: string | null = null;

function getUserDataDir(): string {
  const requestedUserDataDir = process.env.CHATX2_USER_DATA_DIR?.trim();
  if (requestedUserDataDir) {
    const isolatedUserDataDir = resolve(requestedUserDataDir);
    mkdirSync(isolatedUserDataDir, { recursive: true });
    return isolatedUserDataDir;
  }
  if (IS_TEST) {
    const requestedTestDir = process.env.CHAT6_TEST_USER_DATA?.trim();
    if (requestedTestDir) {
      tempUserDataDir = resolve(requestedTestDir);
      mkdirSync(tempUserDataDir, { recursive: true });
      return tempUserDataDir;
    }
    tempUserDataDir = mkdtempSync(join(tmpdir(), 'chatx2-test-'));
    return tempUserDataDir;
  }
  const base = process.env.APPDATA || app.getPath('appData');
  return join(base, 'wha1999', APP_NAME);
}

function getSharedDataDir(): string {
  const requested = process.env.CHATX2_SHARED_DATA_DIR?.trim();
  if (requested) return resolve(requested);
  const projectRoot = app.isPackaged
    ? resolve(dirname(process.execPath), '..', '..')
    : resolve(__dirname, '..', '..');
  return resolve(projectRoot, 'shared-user-data', APP_NAME);
}

function copyIfMissing(source: string, target: string): void {
  if (!existsSync(source) || existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, errorOnExist: false, force: false });
}

function ensureSharedDataDir(userDataDir: string): string {
  const sharedDir = getSharedDataDir();
  const existed = existsSync(sharedDir);
  mkdirSync(sharedDir, { recursive: true });
  if (!existed) {
    // The current account is the one authoritative baseline. Copy only
    // business data; Electron's per-account profile/cache stays private.
  for (const name of [
      'data', 'characters', 'uploads', 'cache', 'training', 'voices', 'models',
      'voice-actions.json', 'motion-deletions.json', 'model-settings.json',
      'avatar-motion-settings.json', 'avatar-compute-settings.json'
  ]) {
    copyIfMissing(join(userDataDir, name), join(sharedDir, name));
  }
  for (const name of ['voice-actions.json', 'motion-deletions.json', 'model-settings.json']) {
    copyIfMissing(join(builtinPacksRoot, 'shared', name), join(sharedDir, name));
  }
  }
  for (const name of ['data', 'characters', 'uploads', 'cache', 'training', 'voices', 'motions']) {
    mkdirSync(join(sharedDir, name), { recursive: true });
  }
  // Seed the shared VMD store once from packaged defaults. Existing shared
  // files and deletion tombstones always win, so deleted motions never return.
  const packagedMotionRoots = [
    resolve(builtinPacksRoot, 'shared', 'motions'),
    resolve(builtinPacksRoot, 'selena-xisheng', 'motions'),
    resolve(builtinPacksRoot, 'yyxuanling', 'motions')
  ];
  const tombstonePath = join(sharedDir, 'motion-deletions.json');
  let deleted = new Set<string>();
  try {
    if (existsSync(tombstonePath)) {
      const parsed = JSON.parse(readFileSync(tombstonePath, 'utf8'));
      deleted = new Set((Array.isArray(parsed.paths) ? parsed.paths : [])
        .map((p: unknown) => String(p).replace(/\\/g, '/').toLowerCase()));
    }
  } catch { /* ModelPackManager will report malformed tombstones. */ }
  const sharedMotions = join(sharedDir, 'motions');
  for (const root of packagedMotionRoots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const source = join(root, entry);
      if (!statSync(source).isFile() || !entry.toLowerCase().endsWith('.vmd')) continue;
      const aliases = [
        `motions/${entry}`.toLowerCase(),
        `../shared/motions/${entry}`.toLowerCase(),
        `../selena-xisheng/motions/${entry}`.toLowerCase(),
        `../yyxuanling/motions/${entry}`.toLowerCase()
      ];
      if (aliases.some(alias => deleted.has(alias))) continue;
      copyIfMissing(source, join(sharedMotions, entry));
    }
  }
  console.log('[shared-data] dir:', sharedDir);
  return sharedDir;
}

// 在 app ready 前设置身份
if (!IS_TEST) {
  app.setName(APP_NAME);
}
app.setAppUserModelId(APP_ID);
// One authoritative main process owns userData.  A second packaged instance
// could otherwise keep an old in-memory motion catalog and overwrite a newer
// edit/deletion when either window saved later.
const hasSingleInstanceLock = process.env.NODE_ENV === 'test' || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.exit(0);
}
const userDataDir = getUserDataDir();
app.setPath('userData', userDataDir);
const sharedDataDir = ensureSharedDataDir(userDataDir);

// 角色级 Avatar 偏好（待机动作池、打光）与共享动作资源分开保存。
// 仅允许简单角色 ID，避免配置路径越界；旧的 model-settings.json 仍由
// ModelPackManager 作为兼容回退读取。
// Restore the last character before the Avatar/model manager is used.  This
// makes character-scoped lighting and idle settings available even when the
// chat renderer has not sent its first set-active-character IPC yet.
let activeCharacterId: string | null = null;
try {
  const persistedCharacter = readFileSync(join(sharedDataDir, 'data', 'current_character.txt'), 'utf8').trim();
  if (/^[a-zA-Z0-9_-]+$/.test(persistedCharacter)) activeCharacterId = persistedCharacter;
} catch { /* first launch or missing character file */ }
function characterAvatarSettingsPath(characterId = activeCharacterId): string | null {
  const id = String(characterId ?? '').trim();
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  return join(sharedDataDir, 'characters', id, 'avatar_settings.json');
}
function persistActiveCharacterId(characterId: string | null): void {
  if (!characterId) return;
  try {
    const target = join(sharedDataDir, 'data', 'current_character.txt');
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${characterId}\n`, 'utf8');
    renameSync(temporary, target);
  } catch (error) {
    console.warn('[character-settings] failed to persist current character:', error);
  }
}
function readCharacterAvatarSettings(characterId = activeCharacterId): any {
  const target = characterAvatarSettingsPath(characterId);
  if (!target || !existsSync(target)) return {};
  try {
    const value = JSON.parse(readFileSync(target, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    console.warn('[character-settings] failed to read avatar settings:', error);
    return {};
  }
}
function readCharacterModelPackId(characterId = activeCharacterId): string | undefined {
  const avatar = readCharacterAvatarSettings(characterId);
  if (typeof avatar?.modelPackId === 'string' && avatar.modelPackId.trim()) return avatar.modelPackId.trim();
  // Backward compatibility: older UI saved modelPackId in profile.json.
  if (!characterId) return undefined;
  try {
    const profilePath = join(sharedDataDir, 'characters', characterId, 'profile.json');
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    return typeof profile?.modelPackId === 'string' && profile.modelPackId.trim()
      ? profile.modelPackId.trim()
      : undefined;
  } catch { return undefined; }
}
function writeCharacterAvatarSettings(patch: Record<string, unknown>): boolean {
  const target = characterAvatarSettingsPath();
  if (!target) return false;
  try {
    const previous = readCharacterAvatarSettings();
    const next = { ...previous, ...patch, schemaVersion: 1 };
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
    renameSync(temporary, target);
    return true;
  } catch (error) {
    console.warn('[character-settings] failed to persist avatar settings:', error);
    return false;
  }
}

// 注意：临时 userData 的清理由测试进程负责（before-quit 清理不可靠，见 Phase 2 复核反馈）

// ChatX2 模型包管理器初始化（依赖 userDataDir）
// 启动时自动切换到内置 selena-xisheng-v1
// 发布和开发模式都从当前应用的 models/加载
// 若 ModelPackManager 也失败，selectedModel 保持 null，3D 模型不可用但聊天仍可用
modelPackManager = new ModelPackManager({
  builtinPacksRoot,
  userPacksRoot: resolve(sharedDataDir, 'models'),
  sharedMotionsRoot: resolve(sharedDataDir, 'motions'),
  voiceActionsPath: resolve(sharedDataDir, 'voice-actions.json'),
  defaultVoiceActionsPath: resolve(builtinPacksRoot, 'shared', 'voice-actions.json'),
  settingsPath: resolve(sharedDataDir, 'model-settings.json'),
  characterSettingsRoot: resolve(sharedDataDir, 'characters'),
  motionDeletionsPath: resolve(sharedDataDir, 'motion-deletions.json')
});
if (activeCharacterId) {
  modelPackManager.setActiveCharacterId(activeCharacterId);
}
{
  // 优先使用上次持久化的模型选择，否则回退到默认
  const characterModelPackId = readCharacterModelPackId(activeCharacterId);
  const restoredPackId = characterModelPackId || modelPackManager.getCurrentPackId();
  let targetPackId = restoredPackId ?? DEFAULT_MODEL_PACK_ID;
  let switchResult = modelPackManager.switchModel(targetPackId);
  // 如果持久化的模型不存在，回退到默认模型
  if (!switchResult.success && restoredPackId) {
    console.warn(`[model-pack] restored pack '${restoredPackId}' not found, falling back to default`);
    targetPackId = DEFAULT_MODEL_PACK_ID;
    switchResult = modelPackManager.switchModel(targetPackId);
  }
  if (switchResult.success && switchResult.sha256) {
    const pack = modelPackManager.getCurrentPack();
    if (pack) {
      selectedModel = {
        modelPath: pack.pmxAbsolutePath,
        modelDir: pack.textureRoot,
        sha256: switchResult.sha256
      };
      console.log('[model-pack] switched to:', switchResult.displayName);
    }
  } else {
    console.warn('[model-pack] default pack load failed:', switchResult.reason);
    console.warn('[model-pack] no model available — 3D avatar disabled, chat still works');
  }
}

// 模式控制器
const modeController = new ModeController();

// Phase 5.2 修正：主进程持有 MotionPackRegistry 与生命周期
// 模块级单例，before-quit 也能访问（与 ConversationController.getInstance() 同路径）
const motionRegistry = new MotionPackRegistry();
const candidateReviewProjectRoot = resolve(__dirname, '..', '..');
const candidateReviewCatalog = new CandidateReviewMotionCatalog({
  mode: getMotionRuntimeMode(),
  allowedRoots: [
    resolve(candidateReviewProjectRoot, 'temp', 'motion-candidates', 'bowlroll-143637', 'extracted-cp932'),
    resolve(candidateReviewProjectRoot, 'temp', 'motion-candidates', 'bowlroll-37514', 'extracted-cp932')
  ],
  definitions: createCandidateReviewMotionDefinitions(candidateReviewProjectRoot)
});

// 窗口引用
let chatWindow: BrowserWindow | null = null;
let avatarWindow: BrowserWindow | null = null;
let composerWindow: BrowserWindow | null = null;
const activeAvatarPerformanceTaskIds = new Set<string>();

const dailyCandidateSourceRoot = resolve(sharedDataDir, 'performance-candidates', 'sources');
const dailyCandidateStore = new DailyPerformanceCandidateStore({
  catalogPath: resolve(sharedDataDir, 'performance-candidates', 'catalog.json'),
  sourceRoot: dailyCandidateSourceRoot
});
const acceptedSpeechExpressionStore = new AcceptedSpeechExpressionStore(
  resolve(sharedDataDir, 'accepted-speech-expressions.json')
);

function installCandidateMotionSource(record: MotionCandidateRecord): string {
  const sourcePath = dailyCandidateStore.resolveVerifiedSourcePath(record.id);
  if (!sourcePath.toLowerCase().endsWith('.vmd')) {
    throw new Error(`motion candidate source must be VMD: ${record.id}`);
  }
  const fileName = `candidate-${record.id}.vmd`;
  const targetPath = resolve(sharedDataDir, 'motions', fileName);
  const sourceBytes = readFileSync(sourcePath);
  if (existsSync(targetPath)) {
    const existingBytes = readFileSync(targetPath);
    const existingHash = createHash('sha256').update(existingBytes).digest('hex');
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
    if (existingHash !== sourceHash) {
      throw new Error(`candidate motion target collision: ${fileName}`);
    }
  } else {
    const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      copyFileSync(sourcePath, temporaryPath);
      if (!readFileSync(temporaryPath).equals(sourceBytes)) {
        throw new Error(`candidate motion copy verification failed: ${record.id}`);
      }
      renameSync(temporaryPath, targetPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  return `../shared/motions/${fileName}`;
}

const dailyCandidatePromotion = new DailyPerformanceCandidatePromotionService({
  candidates: dailyCandidateStore,
  expressions: acceptedSpeechExpressionStore,
  installMotionSource: installCandidateMotionSource,
  addVoiceAction: entry => modelPackManager.addVoiceAction(entry),
  removeVoiceActionReference: path => modelPackManager.removeVoiceActionReference(path)
});

function sendMotionCandidatePreview(record: MotionCandidateRecord): void {
  if (!avatarWindow || avatarWindow.isDestroyed() || avatarWindow.webContents.isDestroyed()) {
    throw new Error('avatar window unavailable');
  }
  const bytes = readFileSync(dailyCandidateStore.resolveVerifiedSourcePath(record.id));
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  avatarWindow.webContents.send('chatx2:preview-motion-candidate', record, arrayBuffer);
}

function sendExpressionCandidatePreview(record: ExpressionCandidateRecord): void {
  if (!avatarWindow || avatarWindow.isDestroyed() || avatarWindow.webContents.isDestroyed()) {
    throw new Error('avatar window unavailable');
  }
  avatarWindow.webContents.send('chatx2:preview-expression-candidate', record);
}

const dailyCandidateController = new DailyPerformanceCandidateController({
  listCandidates: () => dailyCandidateStore.listReviewable(),
  getCandidate: id => dailyCandidateStore.getReviewable(id),
  getPair: id => dailyCandidateStore.getReviewablePair(id),
  verifySource: id => dailyCandidateStore.verifySource(id),
  isSpeechActive: () => activeAvatarPerformanceTaskIds.size > 0,
  previewMotion: sendMotionCandidatePreview,
  previewExpression: sendExpressionCandidatePreview,
  acceptMotion: record => dailyCandidatePromotion.acceptMotion(record.id),
  acceptExpression: async record => {
    await dailyCandidatePromotion.acceptExpression(record.id);
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      avatarWindow.webContents.send('chatx2:accepted-expressions-changed', acceptedSpeechExpressionStore.list());
    }
  },
  removeCandidate: record => {
    dailyCandidateStore.remove(record.id);
  }
});
app.on('second-instance', () => {
  void restoreMainWindowFromShell('second-instance');
});
interface AvatarVmdPreviewResult {
  requestId: string;
  success: boolean;
  reason?: string;
  packId?: string;
}
let previewRequestSequence = 0;
const pendingVmdPreviews = new Map<string, {
  resolve: (result: AvatarVmdPreviewResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

function requestAvatarVmdPreview(relativePath: string): Promise<AvatarVmdPreviewResult> {
  if (!avatarWindow || avatarWindow.isDestroyed() || avatarWindow.webContents.isDestroyed()) {
    return Promise.resolve({ requestId: '', success: false, reason: 'avatar-window-not-ready' });
  }
  const currentPackId = modelPackManager.getCurrentPackId();
  if (!currentPackId || !modelPackManager.resolveCustomVmdPath(currentPackId, relativePath)) {
    return Promise.resolve({ requestId: '', success: false, reason: 'vmd-unavailable' });
  }

  const requestId = `vmd-preview-${Date.now()}-${++previewRequestSequence}`;
  return new Promise(resolvePreview => {
    const timeout = setTimeout(() => {
      pendingVmdPreviews.delete(requestId);
      resolvePreview({ requestId, success: false, reason: 'avatar-preview-timeout' });
    }, 15_000);
    pendingVmdPreviews.set(requestId, { resolve: resolvePreview, timeout });
    avatarWindow!.webContents.send('chatx2:preview-vmd', { requestId, relativePath });
  });
}

/** 预览项目外备选池 VMD：只把字节临时发给 Avatar，不写入任何项目目录。 */
function requestAvatarRawVmdPreview(
  displayName: string,
  bytes: Buffer
): Promise<AvatarVmdPreviewResult> {
  if (!avatarWindow || avatarWindow.isDestroyed() || avatarWindow.webContents.isDestroyed()) {
    return Promise.resolve({ requestId: '', success: false, reason: 'avatar-window-not-ready' });
  }
  const requestId = `external-vmd-preview-${Date.now()}-${++previewRequestSequence}`;
  return new Promise(resolvePreview => {
    const timeout = setTimeout(() => {
      pendingVmdPreviews.delete(requestId);
      resolvePreview({ requestId, success: false, reason: 'avatar-preview-timeout' });
    }, 15_000);
    pendingVmdPreviews.set(requestId, { resolve: resolvePreview, timeout });
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    avatarWindow!.webContents.send(
      'chatx2:preview-raw-vmd',
      { requestId, displayName },
      arrayBuffer
    );
  });
}
let tray: Tray | null = null;
let isAppQuitting = false;

function ensureChatWindow(): BrowserWindow {
  return ensureLiveWindow({
    getCurrent: () => chatWindow,
    setCurrent: window => {
      chatWindow = window;
    },
    create: () => {
      const created = createChatWindow();
      created.on('close', event => {
        if (!shouldHideChatWindowOnClose({ isQuitting: isAppQuitting, isTest: IS_TEST })) return;
        event.preventDefault();
        created.hide();
      });
      return created;
    }
  });
}

function restoreMainWindowFromShell(source: 'tray' | 'second-instance' | 'activate'): Promise<void> {
  return restoreChatFromTray({
    ensureChatWindow,
    // Shell restore is deliberately incapable of hiding the desktop windows.
    showChatWindow: () => showChatWindow(true)
  }).catch(error => {
    console.error(`[${source}] failed to restore chat window:`, error);
  });
}

// Express 服务子进程（发布模式下由主进程 fork 启动，与 chat5.2 架构一致）
let serverProc: ReturnType<typeof fork> | null = null;

// 1x1 透明 PNG（Phase 2 托盘占位图标）
const TRAY_ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * 等待窗口可见（确认可见后才继续）
 */
async function waitForVisible(win: BrowserWindow, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (win.isVisible() && !win.isMinimized()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return win.isVisible();
}

/**
 * 事务性切换到 desktop 模式：
 * 1. ModeController 已进入 loading 状态（由 transition 触发）
 * 2. 显示 Avatar/Composer → 确认可见 → commitDesktop
 * 3. 任何失败 → rollbackDesktop（回滚到 chat）
 * 注意：桌宠与聊天界面共存，不再隐藏 Chat 窗口
 */
async function showDesktopWindowsAndCommit(): Promise<void> {
  if (!avatarWindow || !composerWindow || !chatWindow) {
    // 窗口缺失，回滚
    modeController.rollbackDesktop();
    return;
  }

  try {
    // Avatar 默认隐藏，此处首次显示
    if (!avatarWindow.isVisible()) {
      avatarWindow.show();
      // 显示后重新应用置顶，防止 show() 后置顶失效
      avatarWindow.setAlwaysOnTop(true, 'screen-saver');
    }
    const avatarVisible = await waitForVisible(avatarWindow);

    composerWindow.show();
    composerWindow.moveTop(); // 确保 Composer 在 Avatar 前面
    composerWindow.focus(); // 强制聚焦，确保置顶生效
    const composerVisible = await waitForVisible(composerWindow);

    // Avatar/Composer 确认可见后 commit
    // 桌宠与聊天界面共存：不隐藏 Chat 窗口，用户可同时看到两者
    if (avatarVisible && composerVisible) {
      modeController.commitDesktop();
    } else {
      // 显示失败，回滚
      modeController.rollbackDesktop();
      // 隐藏 Composer 和 Avatar
      composerWindow.hide();
      avatarWindow.hide();
    }
  } catch (e) {
    console.error('[desktop] showDesktopWindowsAndCommit failed:', e);
    modeController.rollbackDesktop();
    composerWindow?.hide();
    avatarWindow?.hide();
  }
}

/**
 * 切回 chat 模式：显示 Chat → 确认可见，隐藏桌宠窗口
 */
async function showChatWindow(preserveDesktop = false): Promise<void> {
  if (!chatWindow || chatWindow.isDestroyed()) return;

  try {
    chatWindow.show();
    await waitForVisible(chatWindow);
    // Tray restoration while desktop mode is active must only restore Chat.
    // Explicit desktop -> chat transitions still hide the desktop windows.
    if (!preserveDesktop) {
      avatarWindow?.hide();
      composerWindow?.hide();
    }
  } catch (e) {
    console.error('[desktop] showChatWindow failed:', e);
  }
}

/**
 * 创建托盘恢复入口
 */
function createTray(): void {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'));
  tray = new Tray(icon);
  tray.setToolTip('伊利斯 ChatX2');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示聊天窗口',
      click: (): void => {
        void restoreMainWindowFromShell('tray');
      }
    },
    { type: 'separator' },
    {
      label: '退出 ChatX2',
      click: (): void => {
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    void restoreMainWindowFromShell('tray');
  });
}

/**
 * 首次启动时在桌面创建快捷方式（指向 ChatX2.exe）
 * 仅在发布模式下执行；通过 userData 中的标记文件避免重复创建
 *
 * 与 chat5.2 架构一致：Express 在 Electron 主进程内 fork 启动，
 * TTS 由前端 API 触发，用户只需双击 exe 即可运行，无需 start.bat。
 *
 * 注意：离线构建模式（复用 chat5.2 Electron 二进制）下 app.isPackaged 返回 false，
 * 因为没有 asar 打包。改用 exe 同目录特征文件（如 start.bat 或 README.txt）作为发布模式标志。
 */
function createDesktopShortcutIfFirstRun(): void {
  if (IS_TEST || IS_RELEASE_AUDIT) return;
  const exePath = app.getPath('exe');
  const exeDir = dirname(exePath);
  // 发布模式标志：exe 同目录存在 start.bat 或 README.txt
  const startBatPath = join(exeDir, 'start.bat');
  const readmePath = join(exeDir, 'README.txt');
  if (!existsSync(startBatPath) && !existsSync(readmePath)) {
    return; // 开发模式，跳过
  }

  const markerFile = join(userDataDir, '.desktop-shortcut-created');
  if (existsSync(markerFile)) {
    return; // 已创建过
  }

  try {
    // 使用 Electron 原生 shell.writeShortcutLink（比 PowerShell 更可靠，无编码问题）
    const desktopPath = app.getPath('desktop');
    const shortcutPath = join(desktopPath, '伊利斯ChatX2.lnk');
    const iconPath = join(exeDir, 'resources', 'app', 'build', 'icon.ico');
    const details = {
      target: exePath,
      cwd: exeDir,
      args: '',
      description: '伊利斯 ChatX2 - 桌宠式 AI 数字人',
      icon: existsSync(iconPath) ? iconPath : exePath,
      iconIndex: 0,
      appUserModelId: APP_ID,
    };
    const ok = shell.writeShortcutLink(shortcutPath, 'create', details);
    if (ok) {
      writeFileSync(markerFile, new Date().toISOString(), 'utf-8');
      console.log('[shortcut] Desktop shortcut created:', shortcutPath);
    } else {
      console.error('[shortcut] shell.writeShortcutLink returned false');
    }
  } catch (e) {
    console.error('[shortcut] Failed to create desktop shortcut:', e);
    // 失败不阻塞启动
  }
}

/**
 * 发布模式下 fork 启动 Express 聊天服务（与 chat5.2 架构一致）
 * - 开发模式下 Express 由外部启动（vite dev server 或手动 node server.js）
 * - 发布模式下主进程 fork chat5-compat/server.js，等待端口就绪后创建窗口
 * - TTS 服务由前端 /api/voice/start 触发，不在此处启动
 */

/**
 * ChatX2 GPU 自动检测（2026-07-23）。
 * 检测 portable runtime/python_gpu 或旧 python_env_gpu 是否存在，存在则用 GPU，否则回退 CPU。
 * 用户可通过环境变量 CHATX2_RUNTIME_DEVICE 强制覆盖。
 */
function detectRuntimeDevice(): 'gpu' | 'cpu' {
  // 环境变量强制覆盖
  const envDevice = process.env.CHATX2_RUNTIME_DEVICE?.toLowerCase();
  if (envDevice === 'gpu') return 'gpu';
  if (envDevice === 'cpu') return 'cpu';

  const appRoot = resolve(__dirname, '..', '..');
  const gpuCandidates = [
    join(appRoot, 'runtime', 'python_gpu', 'python.exe'),
    join(appRoot, 'python_env_gpu', 'python.exe'),
    join(dirname(app.getPath('exe')), 'resources', 'python_env_gpu', 'python.exe'),
  ];
  if (gpuCandidates.some((candidate) => existsSync(candidate))) {
    console.log('[server] GPU Python runtime detected, using GPU mode');
    return 'gpu';
  }

  // 默认 CPU
  return 'cpu';
}

async function startExpressServerIfNeeded(): Promise<void> {
  if (IS_TEST) return; // 测试模式跳过

  // 开发模式（有 VITE_DEV_SERVER_URL）跳过，Express 由外部管理
  if (process.env.VITE_DEV_SERVER_URL) return;

  // 已有环境变量指示外部 Express 在运行（如 start.bat 启动）
  if (process.env.CHAT6_USE_REAL_CHAT5 === '1' && process.env.CHAT6_CHAT5_BASE_URL) {
    console.log('[server] external Express detected (CHAT6_USE_REAL_CHAT5=1), skip fork');
    return;
  }

  // 发布模式下 fork Express
  // __dirname 在发布模式下 = resources/app/dist/electron/
  // server.js 在 resources/app/chat5-compat/server.js
  const serverPath = resolve(__dirname, '..', '..', 'chat5-compat', 'server.js');
  if (!existsSync(serverPath)) {
    console.error('[server] server.js not found:', serverPath);
    return;
  }

  // ChatX2 GPU 自动检测（2026-07-23）：有 python_env_gpu 则用 GPU，否则回退 CPU
  const runtimeDevice = detectRuntimeDevice();
  console.log('[server] runtime device:', runtimeDevice);

  console.log('[server] forking Express server:', serverPath);
  serverProc = fork(serverPath, [], {
    cwd: dirname(serverPath),
    env: {
      ...process.env,
      ELECTRON_RUN: '1',
      PORT: String(EXPRESS_PORT_DEFAULT),
      CHATX2_RUNTIME_DEVICE: runtimeDevice,
      // Keep the portable release immutable. Settings, history, caches,
      // cloned voices, and training output belong to this app's userData.
      APP_DATA_DIR: sharedDataDir,
      PYTHONNOUSERSITE: '1',
    },
    silent: true,
  });

  serverProc.stdout?.on('data', (d) => process.stdout.write('[express] ' + d));
  serverProc.stderr?.on('data', (d) => process.stderr.write('[express:err] ' + d));
  serverProc.on('error', (e) => console.error('[server] fork error:', e.message));
  serverProc.on('exit', (code) => console.log('[server] Express exited, code=' + code));

  // 等待端口就绪（最多 30 秒）
  const ok = await waitForHttpPort(EXPRESS_PORT_DEFAULT, 30000);
  if (ok) {
    console.log('[server] Express ready on port', EXPRESS_PORT_DEFAULT);
    // 设置环境变量，让 ConversationController 使用真实 adapter
    process.env.CHAT6_USE_REAL_CHAT5 = '1';
    process.env.CHAT6_CHAT5_BASE_URL = `http://127.0.0.1:${EXPRESS_PORT_DEFAULT}`;
    process.env.CHAT6_CHAT5_CHARACTER_ID = '1';
  } else {
    console.warn('[server] Express not ready in 30s, continue with Mock mode');
  }
}

/** 轮询 HTTP 端口是否可连接 */
function waitForHttpPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = (): void => {
      const req = http.get(`http://127.0.0.1:${port}/api/runtime`, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(check, 1000);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(check, 1000);
      });
    };
    check();
  });
}

/** 清理 Express 子进程 */
function killServerProc(): void {
  if (serverProc && !serverProc.killed) {
    try {
      if (process.platform === 'win32' && serverProc.pid) {
        execSync(`taskkill /F /PID ${serverProc.pid} /T`, { stdio: 'ignore', windowsHide: true });
      } else {
        serverProc.kill('SIGKILL');
      }
      console.log('[server] Express stopped');
    } catch {
      try { serverProc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
  serverProc = null;
}

app.whenReady().then(async () => {
  console.log(`[build] BUILD_ID=${BUILD_ID}`);
  console.log(`[build] appPath=${app.getAppPath()}`);
  console.log(`[build] resourcesPath=${process.resourcesPath}`);
  const canUseVoiceInput = (contents: Electron.WebContents | null, permission: string, details?: unknown): boolean => {
    const trustedWindow = contents === chatWindow?.webContents || contents === composerWindow?.webContents;
    const mediaTypes = details && typeof details === 'object' && 'mediaTypes' in details
      ? (details as { mediaTypes?: unknown }).mediaTypes
      : undefined;
    const mediaType = details && typeof details === 'object' && 'mediaType' in details
      ? (details as { mediaType?: unknown }).mediaType
      : undefined;
    const requestsAudio = mediaType === 'audio'
      || (Array.isArray(mediaTypes) && mediaTypes.includes('audio'));
    return trustedWindow && permission === 'media' && requestsAudio;
  };
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    canUseVoiceInput(contents, permission, details)
  );
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(canUseVoiceInput(contents, permission, details));
  });
  // 发布模式下先 fork 启动 Express 服务（与 chat5.2 架构一致）
  await startExpressServerIfNeeded();
  // Phase 4: 唯一 ConversationController（主进程单例）
  // - Mock Chat Adapter 醒目标注 isMock=true，不启动 Chat5.2/GPT-SoVITS
  // - Chat 和 Desktop Composer 只通过 IPC 调用，禁止各自实现聊天业务
  // - 真实 Adapter 仅在显式启用且 Chat5.2 /api/runtime 健康时使用
  const conversationController = ConversationController.getInstance();
  // 模型切换期间 Avatar renderer 会重载。语音不能发送到尚未完成 PMX/动作池
  // 初始化的旧/半初始化页面，否则会只进入默认待机并锁住交互。
  type PendingAvatarPlay = {
    taskId: string;
    wavBytes: ArrayBuffer;
    semantic?: Partial<PerformanceSemantic>;
    speechText?: string;
    mute: boolean;
  };
  const pendingAvatarPlays = new Map<string, PendingAvatarPlay>();
  let pendingAvatarFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const avatarRuntimeReady = (): boolean => {
    const evidence = modeController.getAvatarReadyEvidence();
    return evidence?.source === 'pmx-first-frame' || evidence?.source === 'test-only-ready';
  };
  const sendAvatarPlay = (item: PendingAvatarPlay): boolean => {
    if (!avatarWindow || avatarWindow.isDestroyed() || avatarWindow.webContents.isDestroyed()) return false;
    activeAvatarPerformanceTaskIds.add(item.taskId);
    avatarWindow.webContents.send(
      'avatar:play', item.taskId, item.wavBytes, item.semantic, item.speechText, item.mute
    );
    return true;
  };
  const flushPendingAvatarPlays = (): void => {
    pendingAvatarFlushTimer = null;
    if (!avatarRuntimeReady()) return;
    for (const [taskId, item] of pendingAvatarPlays) {
      if (sendAvatarPlay(item)) pendingAvatarPlays.delete(taskId);
    }
  };
  const schedulePendingAvatarFlush = (): void => {
    if (pendingAvatarFlushTimer !== null) clearTimeout(pendingAvatarFlushTimer);
    // 首帧通知发生在动作池绑定之前，给 renderer 一个短初始化窗口。
    pendingAvatarFlushTimer = setTimeout(flushPendingAvatarPlays, 250);
  };
  const realAdapterAllowedInThisProcess = !IS_TEST || process.env.CHAT6_REAL_ADAPTER_IN_TEST === '1';
  const adapterSelection = await createConversationAdapters({
    useReal: process.env.CHAT6_USE_REAL_CHAT5 === '1' && realAdapterAllowedInThisProcess,
    baseUrl: process.env.CHAT6_CHAT5_BASE_URL,
    characterId: process.env.CHAT6_CHAT5_CHARACTER_ID
  });
  conversationController.setAdapter(adapterSelection.chatAdapter);
  // regenerateAudio() 仍只调用 VoiceAdapter.synthesize(assistantText)，不会重跑聊天/记忆/RAG。
  conversationController.setVoiceAdapter(adapterSelection.voiceAdapter);
  if (adapterSelection.fallbackReason) {
    console.warn(`[conversation] real Chat5 unavailable; using Mock adapters: ${adapterSelection.fallbackReason}`);
  } else {
    console.log(`[conversation] ConversationController initialized in ${adapterSelection.mode} mode (${adapterSelection.baseUrl})`);
  }

  // Phase 5.1 修复（P1-F）：WAV 缓存 TTL 定期清理。
  // Chat 模式不调用 audio:play，缓存条目不会被 performance:ended 主动释放。
  // 每 60 秒清理过期条目（TTL 5 分钟），防止未请求播放的 WAV 无限增长。
  const wavCacheCleanupTimer = setInterval(() => {
    const removed = conversationController.cleanupExpiredWav();
    if (removed > 0) {
      console.log(`[audio] cleaned up ${removed} expired wavCache entries`);
    }
  }, 60 * 1000);
  // 不阻塞进程退出
  wavCacheCleanupTimer.unref();

  // Phase 6: 旧 idle/gesture 程序化动作已删除，不再注册到 motionRegistry
  // 所有动作现在通过 models/selena-xisheng/motions/ 目录下的 VMD 文件加载

  /**
   * Phase 5.2 修正（2026-07-19）：从 assistant 消息文本派生语义级 emotion/intent。
   *
   * 用户要求：Planner 根据语义级 emotion/intent/intensity/gaze/gestureFamily 选择 pack；
   * AI 或 IPC 不得直接传 VMD 文件名、骨骼值或 pack-id。
   *
   * 当前 Phase 5.2 Mock 阶段：ChatAdapter 不返回 emotion 元数据，因此用简单的关键词匹配
   * 从 assistant 正文派生 emotion/intent。
   * 真实 Phase 5+：ChatAdapter 应返回结构化 emotion 字段，主进程直接转发，不依赖文本匹配。
   *
   * 派生规则（mock 启发式）：
   * - 含问候词（你好/hello/hi/嗨）→ emotion='happy', intent='greeting'
   * - 含欢迎词（欢迎/welcome/请进/来吧）→ emotion='happy', intent='inviting'
   * - 含肯定词（是的/对/嗯/好的）→ emotion='neutral', intent='affirmative'
   * - 含思考词（让我想想/思考/想想/想一下）→ emotion='thinking', intent='thinking'
   * - 含疑问词（？/?）→ emotion='curious', intent='questioning'
   * - 默认 → emotion='neutral', intent=''
   */
  function deriveSemanticFromAssistantText(taskId: string) {
    try {
      const history = conversationController.getHistory();
      const assistantMsg = history.messages.find(
        m => m.role === 'assistant' && m.taskId === taskId
      );
      if (!assistantMsg) return derivePerformanceSemantic('');
      return derivePerformanceSemantic(assistantMsg.text);
    } catch {
      return derivePerformanceSemantic('');
    }
  }

  // IPC: 身份信息
  ipcMain.handle('chatx2:get-identity', () => ({
    appId: APP_ID,
    productName: PRODUCT_NAME,
    version: APP_VERSION,
    buildId: BUILD_ID,
    buildMeta: BUILD_META,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    expressPort: EXPRESS_PORT_DEFAULT,
    ttsPort: TTS_PORT_RESERVED,
    userDataDir,
    sharedDataDir,
    isTest: IS_TEST,
    isChat5: false,
    // Phase 3 Task 3.2：测试模式下是否启用真实 PMX 渲染
    // 默认测试模式不加载 PMX（保持现有 window-switch.spec.ts 行为）
    // pmx-render.spec.ts 通过 CHAT6_PMX_RENDER_IN_TEST=1 启用真实渲染
    pmxRenderInTest: process.env.CHAT6_PMX_RENDER_IN_TEST === '1',
    // Phase 4：对话后端是否为 Mock（UI 必须醒目标注 MOCK）
    conversationIsMock: conversationController.isMockAdapter(),
    conversationVoiceIsMock: conversationController.isMockVoiceAdapter(),
    conversationAdapterMode: adapterSelection.mode,
    chat5BaseUrl: adapterSelection.baseUrl,
    chat5FallbackReason: adapterSelection.fallbackReason
  }));

  const conversationSenderIds = (): { chatSenderId: number | null; composerSenderId: number | null } => ({
    chatSenderId: chatWindow?.webContents.id ?? null,
    composerSenderId: composerWindow?.webContents.id ?? null
  });

  const requirePerformanceCandidateSender = (event: Electron.IpcMainInvokeEvent): void => {
    validatePerformanceCandidateSender(Boolean(
      chatWindow && !chatWindow.isDestroyed() && event.sender === chatWindow.webContents
    ));
  };

  ipcMain.handle('chatx2:list-performance-candidates', event => {
    requirePerformanceCandidateSender(event);
    return dailyCandidateController.list();
  });
  ipcMain.handle('chatx2:preview-motion-candidate', async (event, id: unknown) => {
    requirePerformanceCandidateSender(event);
    await dailyCandidateController.previewMotion(String(id ?? ''));
    return { success: true };
  });
  ipcMain.handle('chatx2:preview-expression-candidate', async (event, id: unknown) => {
    requirePerformanceCandidateSender(event);
    await dailyCandidateController.previewExpression(String(id ?? ''));
    return { success: true };
  });
  ipcMain.handle('chatx2:preview-combined-candidate', async (event, id: unknown) => {
    requirePerformanceCandidateSender(event);
    await dailyCandidateController.previewCombined(String(id ?? ''));
    return { success: true };
  });
  ipcMain.handle('chatx2:accept-motion-candidate', async (event, id: unknown) => {
    requirePerformanceCandidateSender(event);
    await dailyCandidateController.acceptMotion(String(id ?? ''));
    return { success: true };
  });
  ipcMain.handle('chatx2:accept-expression-candidate', async (event, id: unknown) => {
    requirePerformanceCandidateSender(event);
    await dailyCandidateController.acceptExpression(String(id ?? ''));
    return { success: true };
  });
  ipcMain.handle('chatx2:delete-performance-candidate', async (event, id: unknown) => {
    requirePerformanceCandidateSender(event);
    await dailyCandidateController.delete(String(id ?? ''));
    return { success: true };
  });
  ipcMain.handle('chatx2:get-accepted-expressions', event => {
    if (!avatarWindow || avatarWindow.isDestroyed() || event.sender !== avatarWindow.webContents) {
      throw new Error('accepted expression access requires the Avatar sender');
    }
    return acceptedSpeechExpressionStore.list();
  });

  // Phase 4 IPC: 主进程按 sender 派生来源，只接受纯文本。
  ipcMain.handle('conversation:submit', async (event, payload: unknown) => {
    const source = resolveConversationSource(event.sender.id, conversationSenderIds());
    const text = parseConversationText(payload);
    const submit: ConversationSubmit = { text, source };
    return conversationController.submit(submit);
  });

  // Voice input stays separate from the conversation contract: renderer records locally,
  // main validates the trusted sender and byte budget, then only the transcript may enter submit().
  ipcMain.handle('voice-input:transcribe', async (event, audio: unknown, rawMimeType: unknown) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    // Electron's structured clone may deserialize an ArrayBuffer as Uint8Array
    // (or a Buffer-shaped object). Normalize all supported forms before the
    // size check; otherwise valid recordings are reported as empty.
    let audioBytes: Buffer | null = null;
    if (audio instanceof ArrayBuffer) {
      audioBytes = Buffer.from(new Uint8Array(audio));
    } else if (ArrayBuffer.isView(audio)) {
      audioBytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    } else if (audio && typeof audio === 'object' && 'type' in audio && (audio as { type?: unknown }).type === 'Buffer'
      && Array.isArray((audio as { data?: unknown }).data)) {
      audioBytes = Buffer.from((audio as unknown as { data: number[] }).data);
    }
    if (!audioBytes || audioBytes.byteLength === 0 || audioBytes.byteLength > 5 * 1024 * 1024) {
      return { success: false, error: '录音为空或超过 5MB 限制，请缩短后重试。' };
    }
    const mimeType = typeof rawMimeType === 'string'
      ? rawMimeType.split(';', 1)[0].trim().toLowerCase()
      : '';
    if (!['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav'].includes(mimeType)) {
      return { success: false, error: '不支持的录音格式，请重新录制。' };
    }
    if (adapterSelection.mode !== 'real') {
      return { success: false, error: '当前为模拟对话模式，语音输入不可用。' };
    }

    try {
      const response = await fetch(`${adapterSelection.baseUrl}/api/voice-input/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: audioBytes.toString('base64'),
          mimeType,
        }),
      });
      const payload = await response.json() as { success?: unknown; text?: unknown; error?: unknown };
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (response.ok && payload.success === true && text) return { success: true, text };
      return { success: false, error: typeof payload.error === 'string' ? payload.error : '语音识别失败，请稍后重试。' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[voice-input] transcription request failed:', message);
      return { success: false, error: '语音识别服务暂时不可用，请稍后重试。' };
    }
  });

  // Phase 4 IPC: 获取历史快照
  // 返回 { messages, activeTask }
  ipcMain.handle('conversation:history', (event) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    return conversationController.getHistory();
  });

  // Phase 4 IPC: 取消当前活动任务
  // 返回 { cancelled, taskId?, reason? }
  ipcMain.handle('conversation:cancel', (event) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    return conversationController.cancel();
  });

  // ChatX2 双向同步 IPC: Chat 页面通过 HTTP /api/chat 发送消息后，通知 Controller 注入外部消息。
  // Controller 更新内存 + 广播 conversation:event，Composer 收到后实时显示 Chat 页面的消息。
  // 消息已由 /api/chat 端点写入磁盘，此处不重复持久化。
  //
  // 异步生成 TTS 音频：注入消息后，通过 voiceAdapter 合成语音，
  // 然后调用 injectExternalAudio 存储 WAV + 广播 message-updated 事件。
  // Composer 收到 message-updated(audioReady=true) 后自动调用 audio:play(taskId) 触发 Avatar 说话。
  ipcMain.handle('conversation:inject-external', async (event, payload: unknown) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    if (!payload || typeof payload !== 'object') return;
    const p = payload as {
      userText?: string;
      assistantText?: string;
      performance?: Partial<PerformanceSemantic>;
      userTimestamp?: number;
      assistantTimestamp?: number;
    };
    if (typeof p.userText !== 'string' || typeof p.assistantText !== 'string') return;
    const performance = resolvePlaybackSemantic(p.assistantText, p.performance);
    const result = conversationController.injectExternalMessage({
      userText: p.userText,
      assistantText: p.assistantText,
      performance,
      userTimestamp: p.userTimestamp,
      assistantTimestamp: p.assistantTimestamp
    });
    if (!result) return;

    // 异步生成 TTS 音频 + 注入，不阻塞 IPC 响应
    const { taskId } = result;
    const assistantText = p.assistantText;
    void (async () => {
      try {
        const voiceResult = await conversationController.synthesizeSpeechDetailed(
          assistantText,
          performance,
          p.userText,
        );
        if (voiceResult) {
          conversationController.injectExternalAudio(taskId, voiceResult.wavBytes, performance);
          console.log(`[conversation] injected external audio for taskId=${taskId}`);
        } else {
          console.warn(`[conversation] TTS synthesis failed for external message taskId=${taskId}`);
          // 标记为 audioError 让 Composer 显示"重新生成"按钮
          conversationController.injectExternalAudio(taskId, new ArrayBuffer(0));
        }
      } catch (e) {
        console.error('[conversation] injectExternal audio generation failed:', e);
      }
    })();
  });

  // Phase 5.1 P0-A/B/C IPC: audio:play — Composer 请求 Avatar 开始播放
  // Composer 收到 message-added(assistant, audioReady=true, taskId) 后调用此 IPC。
  // 主进程校验：
  //   1. sender 必须是 Chat/Composer（resolveConversationSource 拒绝 Avatar 和未知 sender）
  //   2. taskId 必须在 wavCache 中（即 assistant 消息 audioReady=true 且 WAV 已校验）
  // 校验通过后取出 wavBytes 副本，转发 avatar:play(taskId, wavBytes, semantic?) 给 Avatar 窗口。
  // Avatar 收到后完成 decodeAudioData + sourceNode.start + actorRuntime.speak + sendPerformanceStarted。
  // Phase 5.2 修正（2026-07-19）：主进程派生语义级 emotion/intent 一并转发，
  //   Avatar 在 sourceNode.start() 后调用 Planner 选择 gesture pack 并播放。
  //   主进程不传 packId/VMD 文件名/骨骼值，只传语义级 emotion/intent。
  // 隐私边界：Avatar 只收到 taskId、wavBytes、semantic（emotion/intent），不收到对话文本。
  // 硬门：Composer 不再拥有 AudioContext，无法在解码完成前调用 audioSpeak。
  //       Avatar 是唯一 AudioContext 所有者，自然保证"解码完成前不张嘴"。
  ipcMain.handle('audio:play', async (event, taskId: unknown) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    if (typeof taskId !== 'string' || !taskId) {
      throw new TypeError('audio:play taskId must be a non-empty string');
    }
    // 从 wavCache 获取 wavBytes 副本（getWavBytes 内部 slice(0) 防止 renderer 修改主进程内存）
    const wavBytes = conversationController.getWavBytes(taskId);
    if (!wavBytes) {
      // taskId 不在缓存：拒绝（防止伪造 taskId 触发播放）
      console.warn(`[audio] audio:play rejected for taskId=${taskId} (not in wavCache)`);
      return;
    }
    const speechText = conversationController.getWavAssistantText(taskId);
    // 真实 Chat5/TTS 语义只能来自同一 taskId 的授权 WAV 缓存；Mock/旧消息才回退文本启发式。
    // Renderer 的 audio:play IPC 只有 taskId 参数，无法伪造 emotion、morph 或动作 ID。
    const semantic = conversationController.getWavSemantic(taskId)
      ?? deriveSemanticFromAssistantText(taskId);
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      const item: PendingAvatarPlay = {
        taskId,
        wavBytes,
        semantic,
        speechText: speechText ?? undefined,
        mute: false
      };
      if (!avatarRuntimeReady()) {
        pendingAvatarPlays.set(taskId, item);
        return;
      }
      sendAvatarPlay(item);
    } else {
      // Avatar 窗口不可用：通知 Composer 播放失败
      if (composerWindow && !composerWindow.isDestroyed() && !composerWindow.webContents.isDestroyed()) {
        composerWindow.webContents.send('performance:ended', taskId, 'failed');
      }
      conversationController.releaseWav(taskId);
    }
  });

  // Test-only local candidate admission. The renderer cannot provide a path;
  // the parent Playwright process fixes it before launch.
  ipcMain.handle('chatx2:test-load-motion-candidate', (event) => {
    if (!IS_TEST || event.sender.id !== avatarWindow?.webContents.id) {
      throw new Error('test motion candidate access denied');
    }
    const candidatePath = process.env.CHAT6_TEST_CANDIDATE_VMD_PATH;
    if (!candidatePath || !/[/\\]motion-packs[/\\].+[/\\]original\.vmd$/i.test(candidatePath)) {
      throw new Error('invalid test motion candidate path');
    }
    const bytes = readFileSync(candidatePath);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });

  ipcMain.handle('chatx2:load-candidate-review-motion', async (event, rawCueId: unknown) => {
    const cueId = validateCandidateReviewRequest({
      senderIsAvatar: Boolean(avatarWindow && !avatarWindow.isDestroyed()
        && event.sender === avatarWindow.webContents),
      mode: getMotionRuntimeMode(),
      rawCueId
    });
    return candidateReviewCatalog.load(cueId);
  });

  // Phase 5.1 P0-A/B/C IPC: audio:stop — Composer 请求 Avatar 停止播放（新消息打断）
  // Composer 在收到新 message-added(assistant) 时调用此 IPC 打断旧播放。
  // 主进程转发 avatar:stop-play('interrupted') 给 Avatar。
  // Avatar 停止 sourceNode + actorRuntime.stopSpeak + 发送 performance:ended('interrupted')。
  ipcMain.handle('audio:stop', async (event, taskId: unknown) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    if (typeof taskId !== 'string' || !taskId) {
      throw new TypeError('audio:stop taskId must be a non-empty string');
    }
    pendingAvatarPlays.delete(taskId);
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      avatarWindow.webContents.send('avatar:stop-play', 'interrupted');
    }
    // 注意：不在这里 releaseWav，等 Avatar 的 performance:ended 回来再释放
  });

  // ============================================================
  // Avatar 同步扩展：Chat 窗口播放语音时，通知 Avatar 窗口静音播放同一音频。
  // 与 audio:play 不同，这里的 wavBytes 由 Chat renderer 自己 fetch 获取，
  // 不经过 conversationController 的 wavCache（Chat 窗口用自己的语音播放链路）。
  // 主进程只做转发，第 5 个参数 mute=true 告诉 Avatar 不发声，仅驱动口型/动作。
  // ============================================================
  ipcMain.handle('avatar:sync-voice', async (
    event,
    taskId: unknown,
    wavBytes: unknown,
    semantic?: unknown,
    speechText?: unknown
  ): Promise<{ success: boolean; reason?: string }> => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    if (typeof taskId !== 'string' || !taskId) {
      return { success: false, reason: 'taskId must be a non-empty string' };
    }
    if (!(wavBytes instanceof ArrayBuffer) || wavBytes.byteLength === 0) {
      return { success: false, reason: 'wavBytes must be a non-empty ArrayBuffer' };
    }
    const safeSpeechText = typeof speechText === 'string' ? speechText : '';
    const safeSemantic = resolvePlaybackSemantic(
      safeSpeechText,
      semantic as Partial<PerformanceSemantic> | undefined,
    );
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      const item: PendingAvatarPlay = {
        taskId,
        wavBytes,
        semantic: safeSemantic,
        speechText: safeSpeechText || undefined,
        mute: true
      };
      if (!avatarRuntimeReady()) {
        pendingAvatarPlays.set(taskId, item);
        return { success: true, reason: 'avatar-not-ready-queued' };
      }
      // mute=true: Avatar 不连接 destination，仅驱动口型/动作
      sendAvatarPlay(item);
      return { success: true };
    }
    return { success: false, reason: 'avatar window unavailable' };
  });

  // Chat 窗口停止语音时，通知 Avatar 停止同步表演
  ipcMain.handle('avatar:sync-stop', async (event, taskId: unknown, reason?: unknown): Promise<{ success: boolean; reason?: string }> => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    if (typeof taskId !== 'string' || !taskId) {
      return { success: false, reason: 'taskId must be a non-empty string' };
    }
    pendingAvatarPlays.delete(taskId);
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      const stopReason = normalizeAvatarSyncStopReason(reason);
      avatarWindow.webContents.send('avatar:stop-play', stopReason, taskId);
    }
    return { success: true };
  });

  // Phase 5.1 P0-A/B/C IPC: performance:started — Avatar → 主进程 → Composer
  // Avatar 在 AudioContext.state === 'running' 且 decodeAudioData 成功 且 sourceNode.start() 调度后发送。
  // 主进程转发给 Composer，Composer 收到后显示字幕、设置 __composerSpeaking = true。
  // 校验 sender 必须是 avatarWindow.webContents（防止其他窗口伪造）。
  // Phase 5.2 Task 5.2.6：可选第三个参数 audioStartTime（number），转发给 Composer 用于字幕同步。
  ipcMain.on('performance:started', (event, taskId: unknown, audioStartTime?: unknown) => {
    if (!avatarWindow || event.sender !== avatarWindow.webContents) {
      console.error('[audio] rejected performance:started: sender is not avatarWindow');
      return;
    }
    if (typeof taskId !== 'string' || !taskId) {
      console.error('[audio] rejected performance:started: taskId must be a non-empty string');
      return;
    }
    // 校验 audioStartTime（可选，若提供必须是有限 number）
    const startTime: number | undefined =
      typeof audioStartTime === 'number' && Number.isFinite(audioStartTime)
        ? audioStartTime
        : undefined;
    if (composerWindow && !composerWindow.isDestroyed() && !composerWindow.webContents.isDestroyed()) {
      if (startTime !== undefined) {
        composerWindow.webContents.send('performance:started', taskId, startTime);
      } else {
        composerWindow.webContents.send('performance:started', taskId);
      }
    }
  });

  // Phase 5.1 P0-A/B/C IPC: performance:ended — Avatar → 主进程 → Composer
  // Avatar 在播放自然结束、解码/播放失败、或被中断时发送。
  // 主进程释放 wavCache[taskId]，转发给 Composer 隐藏字幕。
  // 校验 sender 必须是 avatarWindow.webContents（防止其他窗口伪造）。
  ipcMain.on('performance:ended', (event, taskId: unknown, reason: unknown) => {
    if (!avatarWindow || event.sender !== avatarWindow.webContents) {
      console.error('[audio] rejected performance:ended: sender is not avatarWindow');
      return;
    }
    if (typeof taskId !== 'string' || !taskId) {
      console.error('[audio] rejected performance:ended: taskId must be a non-empty string');
      return;
    }
    if (reason !== 'ended' && reason !== 'failed' && reason !== 'interrupted') {
      console.error('[audio] rejected performance:ended: reason must be "ended" | "failed" | "interrupted"');
      return;
    }
    // 释放 wavCache 条目（无论结束原因）
    conversationController.releaseWav(taskId);
    activeAvatarPerformanceTaskIds.delete(taskId);
    // 转发给 Composer
    if (composerWindow && !composerWindow.isDestroyed() && !composerWindow.webContents.isDestroyed()) {
      composerWindow.webContents.send('performance:ended', taskId, reason);
    }
  });

  // Phase 5.1 修复（P0-1）IPC: audio:regenerate — 重新生成语音
  // renderer 在用户点击"重新生成语音"按钮时调用（仅 Chat/Composer renderer 可调用）。
  // 主进程根据 taskId 查找 wavCache 或历史中的 assistant 消息，重新调用 adapter.submit() 生成 WAV。
  // 成功后 emit message-updated 事件，renderer 更新消息的 audioReady/audioError 字段。
  ipcMain.handle('audio:regenerate', async (event, taskId: unknown) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    if (typeof taskId !== 'string' || !taskId) {
      throw new TypeError('audio:regenerate taskId must be a non-empty string');
    }
    return conversationController.regenerateAudio(taskId);
  });

  // ============================================================
  // Phase 5.2 修正（2026-07-19）：motion IPC handlers
  //
  // 用户要求：在主进程实现并校验 motion:load/play/stop/list，
  // 主进程持有 Registry 和生命周期；Renderer 不能自行信任路径或未白名单 pack。
  //
  // 主进程职责：
  //   1. 持有 MotionPackRegistry 单例（启动时注册所有 idle + gesture pack）
  //   2. 接收 Renderer 的 motion:load/play/stop/list 请求
  //   3. 校验 packId 在 Registry 中且当前模式可加载（isLoadable）
  //   4. 校验通过后通过 motion:command IPC 转发给 Avatar 窗口
  //   5. Renderer 不能直接信任 packId，主进程校验后才能执行
  //
  // 语义级输入：Renderer 调用 motion:play 时可传 semantic（emotion/intent/gestureFamily），
  // 主进程不直接传 packId 给 Avatar，而是让 Avatar 根据 semantic 调用 Planner 选择 pack。
  // 这样确保 Renderer 永远不能直接指定 VMD 文件名/骨骼值/pack-id。
  // ============================================================

  // motion:list — 列出所有已注册的 pack（包含 packId + trigger + allowedStates + mode）
  // 任何 renderer 可调用（用于调试/UI 显示可用动作）
  // 返回值不包含 VMD 字节或骨骼值，只是元数据
  ipcMain.handle('motion:list', () => {
    return motionRegistry.list().map(m => ({
      packId: m.packId,
      trigger: m.trigger ?? 'idle',
      allowedStates: m.allowedStates ?? ['idle'],
      movesRoot: m.movesRoot ?? false,
      fadeInSeconds: m.fadeInSeconds ?? 0.5,
      fadeOutSeconds: m.fadeOutSeconds ?? 0.5,
      cooldownSeconds: m.cooldownSeconds ?? 30,
      mode: motionRegistry.getRegisterMode(m.packId) ?? 'unknown',
      // 显式不暴露 boneMapping / amplitudeLimits / sourceUrl / sha256（防止 Renderer 自行加载）
    }));
  });

  // motion:load — Renderer 请求预加载 pack（基于 semantic）
  // 用户要求：AI 或 IPC 不得直接传 VMD 文件名、骨骼值或 pack-id。
  // 因此 motion:load 只接受 semantic 输入，主进程不直接选择 pack，
  // 而是把 semantic 转发给 Avatar，Avatar 调用 Planner 选择 pack 并预加载。
  // 返回 { success, reason? }
  ipcMain.handle('motion:load', async (event, payload: unknown) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    if (!payload || typeof payload !== 'object') {
      return { success: false, reason: 'payload must be an object' };
    }
    const p = payload as { semantic?: { emotion?: string; intent?: string; gestureFamily?: string } };
    if (!p.semantic || typeof p.semantic !== 'object') {
      return { success: false, reason: 'semantic must be provided (emotion/intent/gestureFamily)' };
    }
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      avatarWindow.webContents.send('motion:command', {
        action: 'load',
        semantic: {
          emotion: p.semantic.emotion,
          intent: p.semantic.intent,
          gestureFamily: p.semantic.gestureFamily
        }
      });
    }
    return { success: true };
  });

  // motion:play — Renderer 请求播放 motion
  // 用户要求：AI 或 IPC 不得直接传 VMD 文件名、骨骼值或 pack-id。
  //   motion:play 只接受 semantic 输入，主进程不直接选择 pack，
  //   而是把 semantic 转发给 Avatar，Avatar 调用 Planner 选择 pack 并播放。
  //   这样确保 Renderer 永远不能直接指定 packId。
  // 返回 { success, reason? }
  ipcMain.handle('motion:play', async (event, payload: unknown) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    if (!payload || typeof payload !== 'object') {
      return { success: false, reason: 'payload must be an object' };
    }
    const p = payload as { semantic?: Record<string, unknown> };
    if (!p.semantic || typeof p.semantic !== 'object') {
      return { success: false, reason: 'semantic must be provided (emotion/intent/gestureFamily)' };
    }
    const sem = p.semantic;
    // 用户硬规则：AI 或 IPC 不得直接传 VMD 文件名、骨骼值或 pack-id。
    // 拒绝任何包含禁用字段的 semantic（即使有 emotion/intent 也拒绝）。
    const forbiddenKeys = ['packId', 'vmdBytes', 'vmd', 'boneMapping', 'sourceUrl', 'sha256', 'bones', 'path', 'url'];
    for (const key of forbiddenKeys) {
      if (key in sem) {
        return {
          success: false,
          reason: `semantic must not contain '${key}' — only emotion/intent/gestureFamily allowed (user hard rule: no packId/VMD filename/bone values)`
        };
      }
    }
    // semantic 必须包含至少一个有效字段（emotion/intent/gestureFamily 均为非空字符串）
    const emotion = typeof sem.emotion === 'string' ? sem.emotion : '';
    const intent = typeof sem.intent === 'string' ? sem.intent : '';
    const gestureFamily = typeof sem.gestureFamily === 'string' ? sem.gestureFamily : '';
    if (!emotion && !intent && !gestureFamily) {
      return {
        success: false,
        reason: 'semantic must contain at least one non-empty string field: emotion/intent/gestureFamily'
      };
    }
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      avatarWindow.webContents.send('motion:command', {
        action: 'play',
        semantic: { emotion, intent, gestureFamily }
      });
    }
    return { success: true };
  });

  // motion:stop — Renderer 请求停止 motion
  // 主进程校验 sender 后通过 motion:command 通知 Avatar 停止
  // 返回 { success }
  ipcMain.handle('motion:stop', async (event) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      avatarWindow.webContents.send('motion:command', { action: 'stop' });
    }
    return { success: true };
  });

  // motion:emotion-update — Renderer 请求在 speaking 中切换 emotion
  // 主进程校验 sender 后通过 motion:emotion-update 通知 Avatar
  // Avatar 收到后调用 Planner 重新选择 gesture pack，通过 fade-out → fade-in 切换
  // 主进程只传语义级 emotion/intent，不传 packId/VMD 文件名/骨骼值
  ipcMain.handle('motion:emotion-update', async (event, emotion: unknown, intent?: unknown) => {
    resolveConversationSource(event.sender.id, conversationSenderIds());
    if (typeof emotion !== 'string' || !emotion) {
      return { success: false, reason: 'emotion must be a non-empty string' };
    }
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      const intentStr = typeof intent === 'string' ? intent : undefined;
      avatarWindow.webContents.send('motion:emotion-update', emotion, intentStr);
    }
    return { success: true };
  });

  // Phase 4 IPC: 订阅 conversation 事件（renderer 通过 ipcRenderer.on 接收）
  // Controller 事件只广播给 Chat + Composer，不向 Avatar 暴露对话内容。
  conversationController.on((event) => {
    for (const win of [chatWindow, composerWindow]) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('conversation:event', event);
      }
    }
  });

  // IPC: 获取当前模式
  ipcMain.handle('chatx2:get-mode', () => modeController.getMode());

  // IPC: 模式切换（事务性：进入 loading，由 mode-change 事件编排窗口）
  ipcMain.handle('chatx2:transition', async (_event, target: AppMode) => {
    const result = await modeController.transition(target);
    // 如果进入 loading，异步编排窗口显示和 commit
    if (result.status === 'ok' && result.mode === 'loading') {
      void showDesktopWindowsAndCommit();
    }
    // 如果切回 chat，隐藏桌宠窗口
    if (result.status === 'ok' && result.mode === 'chat') {
      void showChatWindow();
    }
    return result;
  });

  // IPC: 检查 avatar-ready 证据是否就绪（测试用）
  ipcMain.handle('chatx2:has-avatar-ready', () => modeController.getAvatarReadyEvidence() !== null);

  // IPC: 获取所有窗口的可见性（测试用）
  ipcMain.handle('chatx2:get-windows-visibility', () => {
    const result: Array<{ title: string; visible: boolean; type: string }> = [];
    if (chatWindow) {
      result.push({ title: chatWindow.getTitle(), visible: chatWindow.isVisible(), type: 'chat' });
    }
    if (avatarWindow) {
      result.push({ title: avatarWindow.getTitle(), visible: avatarWindow.isVisible(), type: 'avatar' });
    }
    if (composerWindow) {
      result.push({ title: composerWindow.getTitle(), visible: composerWindow.isVisible(), type: 'composer' });
    }
    return result;
  });

  // IPC: Avatar renderer 通知 placeholder-canvas 就绪
  // 校验 event.sender 必须来自 avatarWindow.webContents（防止其他窗口伪造）
  ipcMain.on('chatx2:avatar-placeholder-ready', (event) => {
    if (!avatarWindow || event.sender !== avatarWindow.webContents) {
      console.error('[avatar] rejected avatar-placeholder-ready: sender is not avatarWindow');
      return;
    }
    const evidence: AvatarReadyEvidence = {
      source: 'placeholder-canvas',
      timestamp: Date.now()
    };
    modeController.setAvatarReady(evidence);
  });

  // Phase 3 Task 3.2: Avatar renderer 通知 PMX 首帧结果
  // success=true 设置 pmx-first-frame 证据（可授权 Desktop 切换）
  // success=false 仅记录错误，不清除证据（否则用户无法重试桌面模式）
  ipcMain.on('chatx2:pmx-first-frame', (event, payload: { success: boolean; error?: string }) => {
    if (!avatarWindow || event.sender !== avatarWindow.webContents) {
      console.error('[avatar] rejected pmx-first-frame: sender is not avatarWindow');
      return;
    }
    if (payload.success) {
      const evidence: AvatarReadyEvidence = {
        source: 'pmx-first-frame',
        timestamp: Date.now()
      };
      modeController.setAvatarReady(evidence);
      console.log('[avatar] pmx-first-frame: success, evidence set');
      schedulePendingAvatarFlush();
    } else {
      // 首帧失败：仅记录错误，不调用 clearAvatarReady
      // 清除证据会导致用户永远无法切换到桌宠模式，只能重启应用
      console.error('[avatar] pmx-first-frame: failed (evidence NOT cleared, user can retry):', payload.error || 'unknown');
    }
  });

  // Phase 3 Task 3.2 + Task 5: 加载 PMX 模型文件（只读，返回 ArrayBuffer）
  // SHA-256 已在 selectVerifiedModel 或 ModelPackManager 启动时校验
  // selectedModel 可能为 null（发布模式且 ModelPackManager 加载失败），此时抛错让 Avatar 显示占位
  ipcMain.handle('chatx2:load-pmx-model', (event) => {
    if (!avatarWindow || event.sender !== avatarWindow.webContents) {
      console.error('[avatar] rejected load-pmx-model: sender is not avatarWindow');
      throw new Error('Sender is not avatarWindow');
    }
    if (!selectedModel) {
      throw new Error('No model loaded — please select a model via "选择模型" button or check models/ directory');
    }
    if (!existsSync(selectedModel.modelPath)) {
      throw new Error(`Model file not found: ${selectedModel.modelPath}`);
    }
    const buffer = readFileSync(selectedModel.modelPath);
    // 返回 ArrayBuffer 副本（避免 Buffer 与 ArrayBuffer 在 IPC 传输时的边界问题）
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  });

  // Phase 3 Task 3.2 + Task 5: 加载纹理文件（只读，返回 ArrayBuffer 或 null）
  // Task 5：用 resolveModelAsset 替换 startsWith，防止字符串前缀绕过
  // 2026-08 性能：readFileSync 会阻塞主进程事件循环，模型加载时 64 个贴图
  // 请求（renderer 并行发起）在此串行排队，累计等待 ~18s、实际墙钟 ~2.4s。
  // 改为 fs.promises.readFile 后各 handler 让出事件循环，文件读取在线程池
  // 并行进行，墙钟时间取决于最大单文件而非文件总和。
  ipcMain.handle('chatx2:load-texture', async (event, relativePath: string) => {
    if (!avatarWindow || event.sender !== avatarWindow.webContents) {
      console.error('[avatar] rejected load-texture: sender is not avatarWindow');
      throw new Error('Sender is not avatarWindow');
    }
    if (!selectedModel) {
      console.error('[avatar] rejected load-texture: no model loaded');
      return null;
    }
    if (!relativePath || typeof relativePath !== 'string') {
      return null;
    }
    // Task 5：用 path.relative 判断边界，拒绝 .. 和绝对路径
    const fullPath = resolveModelAsset(selectedModel, relativePath);
    if (!fullPath) {
      console.error('[avatar] rejected load-texture: path outside model dir or invalid:', relativePath);
      return null;
    }
    try {
      const buffer = await fsPromises.readFile(fullPath);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } catch (e) {
      // 文件不存在（ENOENT）或其他读取错误统一按"纹理缺失"处理，
      // renderer 侧已有 texture not found 降级路径。
      console.warn('[avatar] texture not found:', relativePath);
      return null;
    }
  });

  // 用户选择 PMX 模型文件：允许任意外部模型，复制到 userData/models/imported
  // 后生成轻量 manifest；内置模型仍通过其正式 manifest/哈希校验加载。
  // 失败情况：用户取消返回 { success: false, reason: 'cancelled' }
  //         哈希不匹配返回 { success: false, reason: 'hash-mismatch' }
  //         非 .pmx 返回 { success: false, reason: 'invalid-extension' }
  // 成功返回 { success: true, modelPath, sha256 }
  // 失败时 selectedModel 不变，保证应用继续工作
  ipcMain.handle('chatx2:select-pmx-model', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 PMX 模型文件',
      filters: [{ name: 'PMX Models', extensions: ['pmx'] }],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, reason: 'cancelled' as const };
    }

    const filePath = result.filePaths[0];
    try {
      const imported = modelPackManager.importExternalModel(filePath);
      if (!imported.success || !imported.packId || !imported.modelPath || !imported.sha256) {
        return { success: false as const, reason: imported.reason === 'invalid-extension' ? 'invalid-extension' as const : 'import-failed' as const };
      }
      const switched = modelPackManager.switchModel(imported.packId);
      if (!switched.success) {
        return { success: false as const, reason: 'import-failed' as const };
      }
      selectedModel = {
        modelPath: imported.modelPath,
        modelDir: dirname(imported.modelPath),
        sha256: imported.sha256
      };
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.webContents.send('chatx2:model-pack-changed', {
          packId: imported.packId,
          displayName: imported.packId,
          sha256: imported.sha256,
          vmdEmotionMap: modelPackManager.getMergedVmdEmotionMap(imported.packId)
        });
        // 模型已写入并通知完成，立即重载 Avatar，避免固定等待。
        if (avatarWindow && !avatarWindow.isDestroyed()) avatarWindow.webContents.reload();
      }
      console.log('[avatar] external model imported and selected:', imported.modelPath);
      return {
        success: true as const,
        modelPath: imported.modelPath,
        sha256: imported.sha256,
        packId: imported.packId
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = msg.includes('SHA-256')
        ? 'hash-mismatch' as const
        : 'invalid-extension' as const;
      console.error('[avatar] model selection rejected:', msg);
      return { success: false as const, reason };
    }
  });

  // ===== ChatX2 模型包管理 IPC =====

  // Chat 窗口在切换角色后先设置活动角色，再切换模型包。这样同一模型包
  // 被多个角色复用时，待机池和打光偏好仍然严格按角色恢复。
  ipcMain.handle('chatx2:set-active-character', (_event, characterId: unknown) => {
    if (typeof characterId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(characterId.trim())) {
      return { success: false, reason: 'invalid-character-id' };
    }
    const nextCharacterId = characterId.trim();
    const characterChanged = activeCharacterId !== nextCharacterId;
    const previousPackId = modelPackManager.getCurrentPackId();
    activeCharacterId = nextCharacterId;
    persistActiveCharacterId(activeCharacterId);
    modelPackManager.setActiveCharacterId(activeCharacterId);
    const rememberedPackId = readCharacterModelPackId(activeCharacterId);
    const targetPackId = rememberedPackId ?? previousPackId;
    if (targetPackId) {
      const restored = modelPackManager.switchModel(targetPackId);
      if (restored.success && restored.sha256) {
        const restoredPack = modelPackManager.getCurrentPack();
        if (restoredPack) {
          selectedModel = {
            modelPath: restoredPack.pmxAbsolutePath,
            modelDir: restoredPack.textureRoot,
            sha256: restored.sha256
          };
        }
        if (avatarWindow && !avatarWindow.isDestroyed()
          && (characterChanged || previousPackId !== restored.packId)) {
          avatarWindow.webContents.send('chatx2:model-pack-changed', {
            packId: restored.packId,
            displayName: restored.displayName,
            sha256: restored.sha256,
            vmdEmotionMap: modelPackManager.getMergedVmdEmotionMap(restored.packId!)
          });
          // 角色对应模型已切换，立即重载 Avatar，避免固定等待。
          if (avatarWindow && !avatarWindow.isDestroyed()) avatarWindow.webContents.reload();
        }
      } else if (rememberedPackId) {
        console.warn(`[character-settings] remembered model '${rememberedPackId}' is unavailable for character ${activeCharacterId}`);
      }
    }
    return { success: true, characterId: activeCharacterId, modelPackId: modelPackManager.getCurrentPackId() };
  });

  // 列举所有可用模型包（内置 + 用户）
  ipcMain.handle('chatx2:list-model-packs', (): ModelPackListItem[] => {
    return modelPackManager.discoverPacks();
  });

  ipcMain.handle('chatx2:open-models-folder', async () => {
    const modelsDir = resolve(sharedDataDir, 'models');
    mkdirSync(modelsDir, { recursive: true });
    const error = await shell.openPath(modelsDir);
    return error ? { success: false, reason: error } : { success: true };
  });

  // 获取当前模型包信息
  ipcMain.handle('chatx2:get-current-model-pack', () => {
    const packId = modelPackManager.getCurrentPackId();
    const pack = modelPackManager.getCurrentPack();
    if (!packId || !pack) return { success: false };
    // 注入合并后的 vmdEmotionMap（共享 voice-actions.json + 模型专属）
    const mergedVmdEmotionMap = modelPackManager.getMergedVmdEmotionMap(packId);
    // Expose the shared catalog paths through the normal customVmd surface as
    // well. Older imported manifests may predate the shared catalog and have
    // an empty/stale customVmd list; the renderer and motion pages should see
    // the same candidates for every model without copying Selena-only paths.
    const sharedVmdPaths = mergedVmdEmotionMap.map(entry => entry.vmdPath);
    const customVmd = Array.from(new Set([
      ...(pack.manifest.motions.customVmd ?? []),
      ...sharedVmdPaths
    ]));
    const motions = {
      ...pack.manifest.motions,
      customVmd,
      vmdEmotionMap: mergedVmdEmotionMap
    };
    const manifestLighting = ((pack.manifest as any).lighting && typeof (pack.manifest as any).lighting === 'object')
      ? (pack.manifest as any).lighting
      : {};
    const characterLighting = readCharacterAvatarSettings().lighting;
    return {
      success: true,
      packId,
      displayName: pack.manifest.displayName,
      internalName: pack.manifest.internalName,
      capabilities: pack.manifest.capabilities,
      motions,
      physics: pack.manifest.physics,
      manifest: pack.manifest,
      lighting: {
        ...manifestLighting,
        ...(typeof characterLighting === 'object' && characterLighting ? characterLighting : {})
      }
    };
  });

  // 切换模型包（触发 Avatar 重新加载 PMX + morph 映射）
  ipcMain.handle('chatx2:switch-model-pack', async (_event, packId: string): Promise<SwitchModelResult> => {
    const previousPackId = modelPackManager.getCurrentPackId();
    const result = modelPackManager.switchModel(packId);
    if (result.success && result.sha256) {
      const pack = modelPackManager.getCurrentPack();
      if (pack) {
        selectedModel = {
          modelPath: pack.pmxAbsolutePath,
          modelDir: pack.textureRoot,
          sha256: result.sha256
        };
        // 主进程直接重载 Avatar 窗口加载新模型（比 renderer 内 window.location.reload() 更可靠）
        if (previousPackId !== packId && avatarWindow && !avatarWindow.isDestroyed()) {
          // 旧 renderer 的 ready 证据不能授权新模型期间的语音转发。
          modeController.clearAvatarReady();
          avatarWindow.webContents.send('chatx2:model-pack-changed', {
            packId,
            displayName: result.displayName,
            sha256: result.sha256,
            vmdEmotionMap: modelPackManager.getMergedVmdEmotionMap(pack.manifest.packId)
          });
          // 事件已发送后立即重载；旧实现额外等待 300ms，只是为了给
          // 即将被销毁的 renderer 刷新动作列表，反而放大了切换延迟。
          if (avatarWindow && !avatarWindow.isDestroyed()) {
            // reload 后 renderer 的三状态会重置，先同步窗口穿透状态。
            avatarWindow.setIgnoreMouseEvents(false);
            avatarWindow.webContents.reload();
          }
        }
        console.log('[model-pack] switched to:', result.displayName);
      }
    }
    return result;
  });

  // 导入本地 VMD 到当前模型包的 motions 目录
  ipcMain.handle('chatx2:import-vmd', async () => {
    const currentPackId = modelPackManager.getCurrentPackId();
    if (!currentPackId) return { success: false, reason: 'no-current-pack' };
    const result = await dialog.showOpenDialog({
      title: '选择 VMD 动作文件',
      filters: [{ name: 'VMD Motions', extensions: ['vmd'] }],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, reason: 'cancelled' as const };
    }
    const vmdPath = result.filePaths[0];
    const importResult = modelPackManager.importVmd(currentPackId, vmdPath);
    if (importResult.success) {
      console.log('[model-pack] vmd imported:', importResult.relativePath);
    }
    return importResult;
  });

  // 列出当前模型包的所有动作（内置 idle/gesture + 自定义 VMD）
  ipcMain.handle('chatx2:list-motion-packs', () => {
    const pack = modelPackManager.getCurrentPack();
    if (!pack) return { success: false };
    return {
      success: true,
      idlePacks: pack.manifest.motions.idlePacks,
      gesturePacks: pack.manifest.motions.gesturePacks,
      customVmd: pack.manifest.motions.customVmd,
      defaultIdle: pack.manifest.motions.defaultIdle
    };
  });

  // Phase 6: 旧 idle/gesture 程序化动作已删除，仅返回 VMD 列表
  ipcMain.handle('chatx2:list-all-motion-packs', () => {
    const pack = modelPackManager.getCurrentPack();
    if (!pack) return { success: false };
    return {
      success: true,
      idlePacks: [],
      gesturePacks: [],
      customVmd: pack.manifest.motions.customVmd,
      defaultIdle: pack.manifest.motions.defaultIdle,
      vmdEmotionMap: modelPackManager.getMergedVmdEmotionMap(pack.manifest.packId),
      idleVmdPool: pack.manifest.motions.idleVmdPool ?? [],
      longActionVmd: pack.manifest.motions.longActionVmd ?? []
    };
  });

  // 读取 VMD 文件时长（秒）：解析 bone/morph frames 的最大帧号 / 30fps
  function readVmdDuration(filePath: string): number {
    try {
      const buf = readFileSync(filePath);
      if (buf.length < 54) return 0;
      let offset = 30 + 20; // magic(30) + 模型名(20)
      const boneCount = buf.readUInt32LE(offset);
      offset += 4;
      let maxFrame = 0;
      const boneFrameSize = 15 + 4 + 12 + 16 + 64; // 111 bytes
      for (let i = 0; i < boneCount; i++) {
        if (offset + boneFrameSize > buf.length) break;
        const frame = buf.readUInt32LE(offset + 15);
        if (frame > maxFrame) maxFrame = frame;
        offset += boneFrameSize;
      }
      if (offset + 4 <= buf.length) {
        const morphCount = buf.readUInt32LE(offset);
        offset += 4;
        const morphFrameSize = 15 + 4 + 4; // 23 bytes
        for (let i = 0; i < morphCount; i++) {
          if (offset + morphFrameSize > buf.length) break;
          const frame = buf.readUInt32LE(offset + 15);
          if (frame > maxFrame) maxFrame = frame;
          offset += morphFrameSize;
        }
      }
      return maxFrame / 30;
    } catch (_) { return 0; }
  }

  type ExternalVmdCategory = 'short' | 'medium' | 'long';
  type ExternalVmdCandidate = {
    path: string;
    displayName: string;
    duration: number;
    category: ExternalVmdCategory;
    size: number;
    valid: boolean;
  };

  function resolveExternalVmdCandidate(relativePath: string): string | null {
    const normalized = String(relativePath ?? '').replace(/\\/g, '/').trim();
    if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      return null;
    }
    const candidate = resolve(EXTERNAL_VMD_CANDIDATE_ROOT, normalized);
    const rel = pathRelative(EXTERNAL_VMD_CANDIDATE_ROOT, candidate);
    if (rel === '..' || rel.startsWith('..' + '\\') || rel.startsWith('..' + '/')) return null;
    // Deleted candidates are retained for recovery but never shown or played.
    if (normalized.toLowerCase() === 'recycle-bin' || normalized.toLowerCase().startsWith('recycle-bin/')) {
      return null;
    }
    if (!existsSync(candidate) || !statSync(candidate).isFile() || extname(candidate).toLowerCase() !== '.vmd') {
      return null;
    }
    return candidate;
  }

  function readExternalVmdDuration(filePath: string): number {
    try {
      const bytes = readFileSync(filePath);
      if (bytes.length < 54) return 0;
      // A VMD bone frame is 111 bytes. Reject truncated/obviously malformed
      // downloads before the duration scanner walks a bogus frame count.
      const boneCount = bytes.readUInt32LE(50);
      const maxBoneFrames = Math.floor((bytes.length - 54) / 111);
      if (boneCount > maxBoneFrames) return 0;
      const duration = readVmdDuration(filePath);
      return Number.isFinite(duration) && duration > 0 && duration <= 3600 ? duration : 0;
    } catch {
      return 0;
    }
  }

  function listExternalVmdCandidates(): ExternalVmdCandidate[] {
    const items: ExternalVmdCandidate[] = [];
    const scan = (dir: string, prefix = ''): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
        if (entry.toLowerCase() === 'recycle-bin') continue;
        const absolute = join(dir, entry);
        const stat = statSync(absolute);
        if (stat.isDirectory()) {
          scan(absolute, prefix ? `${prefix}/${entry}` : entry);
          continue;
        }
        if (extname(entry).toLowerCase() !== '.vmd') continue;
        const rel = prefix ? `${prefix}/${entry}` : entry;
        const duration = readExternalVmdDuration(absolute);
        const category: ExternalVmdCategory = duration <= 3
          ? 'short'
          : duration <= 8 ? 'medium' : 'long';
        items.push({
          path: rel,
          displayName: translateVmdName(rel),
          duration,
          category,
          size: stat.size,
          valid: duration > 0
        });
      }
    };
    scan(EXTERNAL_VMD_CANDIDATE_ROOT);
    items.sort((a, b) => a.duration - b.duration || a.displayName.localeCompare(b.displayName, 'zh-CN'));
    return items;
  }

  // 将 VMD 文件名翻译为简洁中文名
  // 处理流程：去除路径/扩展名 → 去除下载源前缀 → 去除系列前缀 → 去除帧数/角色前缀
  //         → 去除括号备注 → 去除模型后缀 → 翻译日文 → 清理符号
  function translateVmdName(relPath: string): string {
    // 1. 去除路径前缀和 .vmd 后缀
    let name = relPath.replace(/^.*\//, '').replace(/\.vmd$/i, '');

    // 2. 去除下载源前缀（如 01-idle-review__bowlroll-106905__01E06DD573__）
    name = name.replace(/^\d+-[a-z]+-review__bowlroll-\d+__[A-F0-9]+__/i, '');

    // 3. 去除系列前缀
    name = name.replace(/^beruga_\d+_/i, '');                              // beruga_3_
    name = name.replace(/^kumachi_(kengen|pack\d+|zarei|walk)_M?\d*-/i, ''); // kumachi_pack01_M01-
    name = name.replace(/^kumachi_/i, '');                                  // kumachi_ 其他
    name = name.replace(/^fuyuneko_[a-z]+_/i, '');                          // fuyuneko_walk_
    name = name.replace(/^genshin_[a-z]+_(ult_)?/i, '');                    // genshin_barbara_ult_
    name = name.replace(/^genshin_[a-z]+_/i, '');                           // genshin_hotaru_
    name = name.replace(/^(popodance|dejavu|hisui_jacko|kunekune|kimiboshi)_/i, '');
    name = name.replace(/^(koa|marieru|ten|usa|montagem_hikari)_/i, '');

    // 4. 去除帧数和角色前缀（如 192R-191R_男性A-、290L-290R_女性-、101_男性A-）
    name = name.replace(/^\d+[LR]?-\d+[LR]?_[^一二三四五六七八九十百千\a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4e00-\u9faF]+-/i, '');
    name = name.replace(/^\d+_(男性A|女性|子供|少女)-/i, '');

    // 5. 去除括号备注（如 (要上半身2)、(90f_移動なし)、(足IKなし  通常こちらをお使いください)）
    name = name.replace(/\([^)]*\)/g, '');
    name = name.replace(/（[^）]*）/g, '');

    // 6. 去除模型/角色后缀（如 -Msk光忠-本体、-sam光忠-武装、_Tda式初音ミク・アペンド_Ver1.00）
    name = name.replace(/[-_](Msk|sam|Tda|武装解除|内番|本体|真剣必殺|おまけ)[^-=]*/g, '');
    name = name.replace(/[-_](光忠|ミク|レン|バーバラ|Lily|KAITO|IA|Alice|mark2C)[^-=]*/gi, '');
    name = name.replace(/[-_]?(Appearance Miku|Lat式ミク改変APPEND|YYB式桜ミク|Tda式初音ミク・アペンド|めんぼう式 初音ミク)[^-=]*/gi, '');
    name = name.replace(/_Ver[\d.]+/gi, '');
    name = name.replace(/v[\d.]+mark2C/gi, '');
    name = name.replace(/【MMDモーション】|【振り付け_足太ぺんたさん】/g, '');

    // 7. 翻译日文关键词（先长后短，避免部分匹配）
    const jpTranslations: Array<[RegExp, string]> = [
      // 复合短语优先
      [/基本モーション/g, '基本动作'],
      [/和装用モーション/g, '和装动作'],
      [/蛍待機モーション/g, '萤待机'],
      [/胡桃待機モーション/g, '胡桃待机'],
      [/シャイニングミラクル/g, '闪耀奇迹'],
      [/サンドウォーターダンス/g, '沙水舞'],
      [/タクティカルなあるき/g, '战术行走'],
      [/スネークが人を待たせた時の着地/g, '蛇叔让人等待的着地'],
      [/蜜月アン・ドゥ・トロワ/g, '蜜月一二三'],
      [/全歌詞リップシンク/g, '全歌词对口型'],
      [/HeartBeatsリップシンク/g, 'HeartBeats对口型'],
      [/ピチカートドロップス/g, '拨弦跌落'],
      [/ダーリンダンス/g, '达令舞'],
      [/Gehenna's chair/g, '地狱之椅'],
      [/JackO'challenge/gi, 'JackO挑战'],
      [/ゆるして猫/g, '原谅猫'],
      // beruga 系列
      [/がぶり/g, '咬'],
      [/きまずい/g, '尴尬'],
      [/じゃーん/g, '登场'],
      [/ばいばい/g, '再见'],
      [/もじもじ/g, '扭捏'],
      [/イライラ/g, '焦躁'],
      [/ガッツポーズ/g, '欢呼'],
      [/ファイティングポーズ/g, '战斗姿态'],
      [/ムキー/g, '暴怒'],
      [/丸目/g, '圆眼'],
      [/前のめり/g, '前倾'],
      [/失速/g, '失速'],
      [/得意げ/g, '得意'],
      [/手突き出し/g, '伸手'],
      [/拍手/g, '拍手'],
      [/指さし/g, '指认'],
      [/正拳突き/g, '正拳'],
      [/目を逸らす/g, '移开视线'],
      [/目閉じ/g, '闭眼'],
      [/考え中/g, '思考'],
      [/見下し/g, '俯视'],
      [/軽い挨拶/g, '轻招呼'],
      [/ジト目/g, '斜视'],
      [/キリっと/g, '锐利'],
      [/小突かれる/g, '被戳'],
      [/左を示す/g, '指左'],
      [/捨てる/g, '丢弃'],
      [/握る/g, '握拳'],
      [/喜び/g, '喜悦'],
      [/がっくし/g, '垂头丧气'],
      [/怯え/g, '胆怯'],
      [/手を叩く/g, '击掌'],
      [/焦り/g, '焦急'],
      [/ゆらゆら/g, '摇晃'],
      [/大の字/g, '大字'],
      [/メガリング/g, '戒指'],
      [/派生/g, '派生'],
      [/ジト睨み/g, '斜视瞪'],
      [/悩み/g, '烦恼'],
      [/指立て目見開き/g, '睁眼竖指'],
      [/指立て目閉じ/g, '闭眼竖指'],
      [/左を見る/g, '看左'],
      [/ガッツ/g, '干劲'],
      [/待機/g, '待机'],
      [/笑顔/g, '微笑'],
      [/怒り/g, '生气'],
      [/驚き/g, '惊讶'],
      [/悲しい/g, '悲伤'],
      [/呆れ/g, '无奈'],
      [/照れ/g, '害羞'],
      [/出撃/g, '出击'],
      [/不敵/g, '自信'],
      [/ループ/g, '循环'],
      // kumachi 系列
      [/口元を拭う/g, '擦嘴'],
      [/負傷歩行/g, '负伤行走'],
      [/台に手を着く/g, '手撑台'],
      [/胡坐から立ちあがる/g, '盘腿起身'],
      [/帯刀歩行/g, '带刀行走'],
      [/ご挨拶/g, '行礼'],
      [/おねむ/g, '犯困'],
      [/刀を持つ/g, '持刀'],
      [/持替有/g, '换手持'],
      [/持替無/g, '不换手持'],
      [/溜息/g, '叹气'],
      [/乾杯/g, '干杯'],
      [/瓦割り/g, '碎瓦'],
      [/すっ飛ばし/g, '飞踢'],
      [/指パッチン/g, '响指'],
      [/この花を君に/g, '献花'],
      [/スタスタ歩く/g, '快步走'],
      [/ノシノシ歩く/g, '慢步走'],
      [/ドスドス歩く/g, '重步走'],
      [/おさんぽ/g, '散步'],
      [/GodRayの設定/g, '光射线'],
      [/カメラモーション/g, '镜头动作'],
      [/鍛冶場の設定/g, '锻造场'],
      [/居合/g, '居合'],
      [/唐竹/g, '唐竹'],
      [/回し左切り上げ/g, '回旋左上砍'],
      // fuyuneko 系列
      [/深呼吸/g, '深呼吸'],
      [/しゃがむ/g, '蹲下'],
      [/ジャンプ/g, '跳跃'],
      [/座る/g, '坐下'],
      [/振り向き/g, '转身'],
      [/手を振る/g, '挥手'],
      [/準備運動/g, '热身'],
      [/歩く/g, '行走'],
      // 通用动作
      [/モーション/g, '动作'],
      [/アクション/g, '动作'],
      [/歩き/g, '走'],
      [/小走り/g, '小跑'],
      [/直進/g, '直行'],
      [/停止/g, '停止'],
      [/カッコつけ/g, '耍帅'],
      [/やんちゃ/g, '调皮'],
      [/猫背/g, '驼背'],
      [/女性的/g, '女性化'],
      [/元気/g, '精神'],
      [/素立ち/g, '自然站'],
      [/両手後ろ/g, '双手后背'],
      [/右手腰あて/g, '右手叉腰'],
      [/左手腰あて/g, '左手叉腰'],
      [/まばたき付き/g, '带眨眼'],
      [/Aスタンス/g, 'A字站'],
      [/呼吸/g, '呼吸'],
      [/ぼんやり待ち/g, '发呆'],
      [/回りキョロキョロ/g, '四处张望'],
      [/腕ブラブラ/g, '甩手'],
      [/腕組み/g, '抱臂'],
      [/左手腰/g, '左手叉腰'],
      [/右手腰/g, '右手叉腰'],
      [/前屈み/g, '前屈'],
      [/くの字/g, '弓身'],
      [/思考R/g, '思考'],
      [/思考L/g, '思考'],
      [/思考/g, '思考'],
      [/待機R/g, '待机'],
      [/待機L/g, '待机'],
      // 对话系列
      [/xs-talk\d+-[a-z]+-/gi, ''],
      [/謝/g, '道歉'],
      [/褒/g, '夸奖'],
      [/噂/g, '闲聊'],
      [/密/g, '密谈'],
      [/喜/g, '开心'],
      [/渉/g, '交谈'],
      // 表情/对口型
      [/リップシンク/g, '对口型'],
      // 原神
      [/蛍/g, '萤'],
      [/胡桃/g, '胡桃'],
      [/バーバラ/g, '芭芭拉'],
      [/低速アレンジ/g, '慢速版'],
      [/原作っぽいカメラ/g, '原作镜头'],
      // 其他
      [/cocoe/gi, ''],
      [/おナス九鬼/g, '茄子九鬼'],
      [/燭台切光忠/g, '烛台切光忠'],
      [/三日月宗近/g, '三日月宗近'],
      [/スイカ光忠/g, '西瓜光忠'],
      [/HYBRID/g, '混合'],
      [/パート/g, '段'],
      [/チルドレンレコード/g, 'Children Record'],
      [/あはははは/g, '啊哈哈哈'],
      [/えへへへへ/g, '嘿嘿嘿'],
      [/コケる/g, '摔倒'],
      [/腕を組む/g, '抱臂'],
      [/既视感/g, '既视感'],
      [/原神/g, '原神'],
    ];
    for (const [pattern, replacement] of jpTranslations) {
      name = name.replace(pattern, replacement);
    }

    // 8. 翻译剩余英文关键词
    const enTranslations: Array<[RegExp, string]> = [
      [/Lumine Idle cycle/gi, '荧待机循环'],
      [/Deja_Vu/gi, '既视感'],
      [/GENUiNE D-Motion/gi, 'GENUiNE舞'],
      [/You'll Be In My Heart/gi, '你在我心中'],
      [/SOBANi/gi, ''],
      [/for_YYB_Rin_10th/gi, ''],
      [/miniskirt_dance/gi, '短裙舞'],
      [/miniskirt_face/gi, '短裙舞表情'],
      [/montagem_hikari_dance/gi, 'Hikari舞'],
      [/montagem_hikari_eye/gi, 'Hikari眼神'],
      [/montagem_hikari_face/gi, 'Hikari表情'],
      [/greeting_loop/gi, '打招呼循环'],
      [/eye_disappointed_glare/gi, '失望瞪眼'],
      [/disappointed/gi, '失望'],
      [/glare/gi, '瞪眼'],
      [/standby/gi, '待机'],
      [/dance/gi, '舞蹈'],
      [/idle/gi, '待机'],
      [/wave/gi, '挥手'],
      [/bow/gi, '鞠躬'],
      [/nod/gi, '点头'],
      [/shake/gi, '摇头'],
      [/jump/gi, '跳跃'],
      [/sit/gi, '坐下'],
      [/stand/gi, '站立'],
      [/walk/gi, '行走'],
      [/run/gi, '跑步'],
      [/happy/gi, '开心'],
      [/sad/gi, '悲伤'],
      [/angry/gi, '生气'],
      [/surprised/gi, '惊讶'],
      [/shy/gi, '害羞'],
      [/eye_close/gi, '闭眼'],
      [/eye_open/gi, '睁眼'],
      [/smile/gi, '微笑'],
      [/laugh/gi, '大笑'],
      [/cry/gi, '哭泣'],
      [/think/gi, '思考'],
      [/body/gi, '身体'],
      [/face/gi, '表情'],
      [/eye/gi, '眼睛'],
      [/lips/gi, '嘴唇'],
      [/breathe/gi, '呼吸'],
      [/crouch/gi, '蹲下'],
      [/turn/gi, '转身'],
      [/warmup/gi, '热身'],
      [/camera/gi, '镜头'],
      [/horizontal/gi, '水平'],
      [/vertical/gi, '垂直'],
      [/motion/gi, '动作'],
    ];
    for (const [pattern, replacement] of enTranslations) {
      name = name.replace(pattern, replacement);
    }

    // 9. 清理多余符号和空格
    name = name.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    name = name.replace(/^[\s\u3000·,.：:]+|[\s\u3000·,.：:]+$/g, '');

    // 10. 如果名字为空或全是数字/符号，回退到原文件名（去前缀）
    if (!name || /^[\d\s\-_]+$/.test(name)) {
      const fallback = relPath.replace(/^.*\//, '').replace(/\.vmd$/i, '')
        .replace(/^beruga_\d+_/i, '')
        .replace(/^\d+-[a-z]+-review__bowlroll-\d+__[A-F0-9]+__/i, '');
      name = fallback.replace(/[_\-]/g, ' ').trim() || relPath.replace(/^.*\//, '').replace(/\.vmd$/i, '');
    }

    return name;
  }

  // IPC: 获取所有 VMD 带时长和分类信息
  ipcMain.handle('chatx2:list-vmd-with-info', () => {
    const pack = modelPackManager.getCurrentPack();
    if (!pack) return { success: false };
    // 注意：LoadedModelPack 接口字段是 packDir（不是 rootDir）
    // VMD 路径如 "motions/xxx.vmd" 相对于 packDir 解析
    const modelRoot = pack.packDir;
    // 共享语音动作池中的 VMD 也应出现在动作库，确保加入语音池的 VMD 能在 UI 中编辑/预览
    const sharedVoiceVmd = modelPackManager.getMergedVmdEmotionMap(pack.manifest.packId).map(e => e.vmdPath);
    const allVmd = Array.from(new Set([
      ...pack.manifest.motions.customVmd,
      ...(pack.manifest.motions.longActionVmd || []),
      ...(pack.manifest.motions.idleVmdPool || []),
      ...sharedVoiceVmd,
    ]));
    const items = allVmd.map(relPath => {
      const resolvedPath = modelPackManager.resolveCustomVmdPath(pack.manifest.packId, relPath);
      const duration = resolvedPath ? readVmdDuration(resolvedPath) : 0;
      const displayName = translateVmdName(relPath);
      let category: 'short' | 'medium' | 'long';
      if (duration <= 3) category = 'short';
      else if (duration <= 8) category = 'medium';
      else category = 'long';
      return { path: relPath, displayName, duration, category, available: resolvedPath !== null };
    }).filter(item => item.duration > 0); // 过滤掉 0.0s 的无效动作（镜头/设置文件，无骨骼动画）
    // 按时长排序（短→中→长，同类按名称）
    items.sort((a, b) => {
      if (a.category !== b.category) {
        const order = { short: 0, medium: 1, long: 2 };
        return order[a.category] - order[b.category];
      }
      return a.displayName.localeCompare(b.displayName, 'zh-CN');
    });
    return {
      success: true,
      items,
      defaultIdle: pack.manifest.motions.defaultIdle,
      idleVmdPool: pack.manifest.motions.idleVmdPool ?? [],
    };
  });

  // 项目外 VMD 备选池：只读扫描 + 明确的播放/删除/加入动作池操作。
  ipcMain.handle('chatx2:list-external-vmd-candidates', () => ({
    success: true,
    root: EXTERNAL_VMD_CANDIDATE_ROOT,
    items: listExternalVmdCandidates()
  }));

  ipcMain.handle('chatx2:preview-external-vmd', (_event, relativePath: string) => {
    const source = resolveExternalVmdCandidate(relativePath);
    if (!source) return { success: false, reason: 'candidate-not-found' };
    const duration = readExternalVmdDuration(source);
    if (!(duration > 0)) return { success: false, reason: 'invalid-vmd' };
    return requestAvatarRawVmdPreview(basename(source), readFileSync(source));
  });

  ipcMain.handle('chatx2:delete-external-vmd', (_event, relativePath: string) => {
    const source = resolveExternalVmdCandidate(relativePath);
    if (!source) return { success: false, reason: 'candidate-not-found' };
    try {
      const normalized = String(relativePath).replace(/\\/g, '/');
      let target = join(EXTERNAL_VMD_CANDIDATE_ROOT, 'recycle-bin', normalized);
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) {
        const ext = extname(target);
        target = `${target.slice(0, -ext.length)}-${Date.now()}${ext}`;
      }
      renameSync(source, target);
      return { success: true };
    } catch (error) {
      return { success: false, reason: `candidate-delete-failed: ${(error as Error).message}` };
    }
  });

  ipcMain.handle('chatx2:accept-external-vmd', (_event, relativePath: string) => {
    const currentPackId = modelPackManager.getCurrentPackId();
    const source = resolveExternalVmdCandidate(relativePath);
    if (!currentPackId) return { success: false, reason: 'no-current-pack' };
    if (!source) return { success: false, reason: 'candidate-not-found' };
    const duration = readExternalVmdDuration(source);
    if (!(duration > 0)) return { success: false, reason: 'invalid-vmd' };
    const result = modelPackManager.importCandidateVmd(currentPackId, source, duration);
    if (result.success) notifyMotionConfigChanged();
    return result;
  });

  // 动作配置变更后通知 Avatar / Chat 窗口重新加载当前模型包配置
  function notifyModelPackChanged(): void {
    const pack = modelPackManager.getCurrentPack();
    if (!pack) return;
    const payload = {
      packId: pack.manifest.packId,
      displayName: pack.manifest.displayName,
      sha256: pack.manifest.model.sha256,
      vmdEmotionMap: modelPackManager.getMergedVmdEmotionMap(pack.manifest.packId)
    };
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send('chatx2:model-pack-changed', payload);
    }
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('chatx2:model-pack-changed', payload);
    }
  }

  // 动作配置变更（设为默认/加入待机/删除/动作包开关）— 不触发模型重载
  function notifyMotionConfigChanged(): void {
    const pack = modelPackManager.getCurrentPack();
    if (!pack) return;
    const payload = {
      packId: pack.manifest.packId,
      displayName: pack.manifest.displayName,
      sha256: pack.manifest.model.sha256,
      vmdEmotionMap: modelPackManager.getMergedVmdEmotionMap(pack.manifest.packId)
    };
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send('chatx2:motion-config-changed', payload);
    }
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('chatx2:motion-config-changed', payload);
    }
  }

  // 启用/停用内置动作 pack
  ipcMain.handle('chatx2:toggle-motion-pack', (_event, motionPackId: string, enabled: boolean, type: 'idle' | 'gesture') => {
    const currentPackId = modelPackManager.getCurrentPackId();
    if (!currentPackId) return { success: false };
    const ok = modelPackManager.toggleMotionPack(currentPackId, motionPackId, enabled, type);
    if (ok) notifyMotionConfigChanged();
    return { success: ok };
  });

  // 设置默认 idle pack
  ipcMain.handle('chatx2:set-default-idle', (_event, idlePackId: string) => {
    const currentPackId = modelPackManager.getCurrentPackId();
    if (!currentPackId) return { success: false };
    const ok = modelPackManager.setDefaultIdle(currentPackId, idlePackId);
    if (ok) notifyMotionConfigChanged();
    return { success: ok };
  });

  // 将 customVmd 加入/移出待机轮换池
  ipcMain.handle('chatx2:toggle-idle-vmd', (_event, vmdPath: string, inPool: boolean) => {
    const currentPackId = modelPackManager.getCurrentPackId();
    const currentPack = modelPackManager.getCurrentPack();
    if (!currentPackId || !currentPack) return { success: false, reason: 'model-pack-unavailable' };
    const pool = currentPack.manifest.motions.idleVmdPool ?? [];
    if (inPool && !pool.includes(vmdPath) && pool.length >= MAX_IDLE_QUICK_SLOTS) {
      return { success: false, reason: 'idle-pool-full', maxSlots: MAX_IDLE_QUICK_SLOTS };
    }
    const ok = modelPackManager.toggleIdleVmd(currentPackId, vmdPath, inPool);
    if (ok) notifyMotionConfigChanged();
    return { success: ok, ...(ok ? {} : { reason: 'idle-pool-update-failed' }) };
  });

  // 暂停/恢复待机动作（Composer 窗口的待机开关）
  // 发送给 Avatar 窗口执行，并返回当前状态
  // Idle actions are opt-in. Opening desktop mode must not autonomously bind
  // a default/episodic VMD; the user can enable the composer idle toggle when
  // they want those actions. Speech still uses its selected background body
  // independently of this pause flag.
  let idlePaused = true;
  ipcMain.handle('chatx2:toggle-idle-paused', () => {
    idlePaused = !idlePaused;
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send('chatx2:toggle-idle-paused', { paused: idlePaused });
    }
    return { success: true, paused: idlePaused };
  });
  ipcMain.handle('chatx2:get-idle-paused', () => {
    return { paused: idlePaused };
  });

  // Pose lock is independent from idle pause. It freezes body VMD sampling
  // while the face, lips, gaze, blink, breathing and physics remain live.
  let poseLocked = false;
  const publishPoseLock = (): void => {
    const payload = { locked: poseLocked };
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send('chatx2:pose-lock-changed', payload);
    }
    if (composerWindow && !composerWindow.isDestroyed()) {
      composerWindow.webContents.send('chatx2:pose-lock-changed', payload);
    }
  };
  ipcMain.handle('chatx2:set-pose-lock', (_event, locked: boolean) => {
    poseLocked = Boolean(locked);
    publishPoseLock();
    return { success: true, locked: poseLocked };
  });
  ipcMain.handle('chatx2:toggle-pose-lock', () => {
    poseLocked = !poseLocked;
    publishPoseLock();
    return { success: true, locked: poseLocked };
  });
  ipcMain.handle('chatx2:get-pose-lock', () => ({ locked: poseLocked }));

  let gazeLocked = false;
  const publishGazeLock = (): void => {
    const payload = { locked: gazeLocked };
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send('chatx2:gaze-lock-changed', payload);
    }
    if (composerWindow && !composerWindow.isDestroyed()) {
      composerWindow.webContents.send('chatx2:gaze-lock-changed', payload);
    }
  };
  ipcMain.handle('chatx2:set-gaze-lock', (_event, locked: boolean) => {
    gazeLocked = Boolean(locked);
    publishGazeLock();
    return { success: true, locked: gazeLocked };
  });
  ipcMain.handle('chatx2:get-gaze-lock', () => ({ locked: gazeLocked }));

  // 预览动作包：从模型管理面板发送给 Avatar 窗口即时播放
  ipcMain.handle('chatx2:preview-motion-pack', (_event, motionPackId: string, type: 'idle' | 'gesture') => {
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      return { success: false, reason: 'avatar-window-not-ready' };
    }
    avatarWindow.webContents.send('chatx2:preview-motion-pack', { packId: motionPackId, type });
    return { success: true };
  });

  ipcMain.on('chatx2:preview-vmd-result', (event, result: AvatarVmdPreviewResult) => {
    if (!avatarWindow || event.sender !== avatarWindow.webContents) {
      console.error('[motion-preview] rejected result from non-avatar sender');
      return;
    }
    if (!result || typeof result.requestId !== 'string') return;
    const pending = pendingVmdPreviews.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingVmdPreviews.delete(result.requestId);
    pending.resolve(result);
  });

  // Short, medium, and long library motions share one truthful Avatar path.
  ipcMain.handle('chatx2:preview-custom-vmd', (_event, relativePath: string) =>
    requestAvatarVmdPreview(relativePath));

  // 导入长时间 VMD 动作（舞蹈/场景）
  ipcMain.handle('chatx2:import-long-vmd', async () => {
    const currentPackId = modelPackManager.getCurrentPackId();
    if (!currentPackId) return { success: false, reason: 'no-current-pack' };
    const result = await dialog.showOpenDialog({
      title: '选择长时间 VMD 动作文件（舞蹈/场景）',
      filters: [{ name: 'VMD Motions', extensions: ['vmd'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, reason: 'cancelled' as const };
    }
    const imported: string[] = [];
    for (const vmdPath of result.filePaths) {
      const importResult = modelPackManager.importLongVmd(currentPackId, vmdPath);
      if (importResult.success && importResult.relativePath) {
        imported.push(importResult.relativePath);
        console.log('[model-pack] long vmd imported:', importResult.relativePath);
      }
    }
    return { success: imported.length > 0, imported, reason: imported.length === 0 ? 'all-imports-failed' : undefined };
  });

  // Long motions use the same one-shot preview and actual-start acknowledgement.
  ipcMain.handle('chatx2:preview-long-vmd', (_event, relativePath: string) =>
    requestAvatarVmdPreview(relativePath));

  // 删除长时间 VMD 动作
  ipcMain.handle('chatx2:remove-long-vmd', (_event, relativePath: string) => {
    const currentPackId = modelPackManager.getCurrentPackId();
    if (!currentPackId) return { success: false };
    const ok = modelPackManager.removeLongVmd(currentPackId, relativePath);
    if (ok) notifyMotionConfigChanged();
    return { success: ok };
  });

  // 删除自定义 VMD 动作
  ipcMain.handle('chatx2:remove-custom-vmd', (_event, relativePath: string) => {
    const currentPackId = modelPackManager.getCurrentPackId();
    if (!currentPackId) return { success: false };
    const ok = modelPackManager.removeCustomVmd(currentPackId, relativePath);
    if (ok) notifyMotionConfigChanged();
    return { success: ok };
  });

  // The library is a merged view; remove every index reference regardless of duration/source.
  ipcMain.handle('chatx2:remove-library-vmd', (_event, relativePath: string) => {
    const result = modelPackManager.removeLibraryVmd(relativePath);
    if (result.success) notifyMotionConfigChanged();
    return result;
  });

  // 加载自定义 VMD 字节（供 Avatar 渲染播放）
  ipcMain.handle('chatx2:load-custom-vmd', (event, relativePath: string) => {
    if (!avatarWindow || event.sender !== avatarWindow.webContents) {
      throw new Error('Sender is not avatarWindow');
    }
    const currentPackId = modelPackManager.getCurrentPackId();
    if (!currentPackId) throw new Error('No current model pack');
    const bytes = modelPackManager.readCustomVmd(currentPackId, relativePath);
    if (!bytes) throw new Error('VMD not found: ' + relativePath);
    return bytes;
  });

  // ============================================================
  // 语音动作统一管理 IPC（所有模型共享的 vmdEmotionMap）
  // ============================================================

  // 获取所有语音动作（按情绪分组）
  ipcMain.handle('chatx2:list-voice-actions', () => {
    const entries = modelPackManager
      .getMergedVmdEmotionMap(modelPackManager.getCurrentPackId() ?? '')
      .filter(isVoiceActionPoolEntry);
    console.log('[main] list-voice-actions: loaded', entries.length, 'entries');
    // 按情绪分组
    const grouped: Record<string, typeof entries> = {};
    for (const entry of entries) {
      for (const emotion of entry.emotions) {
        if (!grouped[emotion]) grouped[emotion] = [];
        grouped[emotion].push(entry);
      }
    }
    console.log('[main] list-voice-actions: grouped into', Object.keys(grouped).length, 'emotions');
    return { success: true, entries, grouped };
  });

  // 添加语音动作到共享映射表
  ipcMain.handle('chatx2:add-voice-action', (_event, entry: { vmdPath: string; displayName: string; type: string; gestureFamily: string; intent: string; emotions: string[]; description: string; dialogueSafe?: boolean; starred?: boolean }) => {
    // This IPC represents an explicit "加入语音动作池" operation. Never
    // persist UI duration categories or a legacy gesture type by accident.
    const ok = modelPackManager.addVoiceAction({ ...entry, type: 'voice' } as any);
    if (ok) notifyMotionConfigChanged();
    return { success: ok };
  });

  // 从共享映射表移除语音动作
  ipcMain.handle('chatx2:remove-voice-action', (_event, vmdPath: string) => {
    if (isProtectedVoiceActionPath(vmdPath)) {
      return { success: false, reason: '内置头部语音动作不可删除' };
    }
    const ok = modelPackManager.removeVoiceAction(vmdPath);
    if (ok) notifyMotionConfigChanged();
    return ok
      ? { success: true }
      : { success: false, reason: '动作不存在或配置文件写入失败' };
  });

  // 更新语音动作的情绪映射
  ipcMain.handle('chatx2:update-voice-action', (_event, vmdPath: string, updates: Record<string, any>) => {
    const ok = modelPackManager.updateVoiceAction(vmdPath, updates);
    if (ok) notifyMotionConfigChanged();
    return { success: ok };
  });

  const transitionSpeedSettingsPath = join(sharedDataDir, 'avatar-motion-settings.json');
  let currentTransitionSpeed = loadTransitionSpeed(transitionSpeedSettingsPath, DEFAULT_TRANSITION_SPEED);

  ipcMain.handle('chatx2:get-transition-speed', () => ({ value: currentTransitionSpeed }));
  ipcMain.handle('chatx2:set-transition-speed', (_event, value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)
      || value < MIN_TRANSITION_SPEED || value > MAX_TRANSITION_SPEED) {
      return { success: false, reason: `transition speed must be between ${MIN_TRANSITION_SPEED} and ${MAX_TRANSITION_SPEED}` };
    }
    if (!saveTransitionSpeed(transitionSpeedSettingsPath, value)) {
      return { success: false, reason: 'transition speed could not be persisted' };
    }
    currentTransitionSpeed = value;
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      avatarWindow.webContents.send('chatx2:set-transition-speed', currentTransitionSpeed);
    }
    return { success: true, value: currentTransitionSpeed };
  });

  // 全局默认表情：右键菜单 "默认表情" 切换。跨模型统一，存 sharedDataDir。
  const defaultExpressionSettingsPath = join(sharedDataDir, 'default-avatar-expression.json');
  let currentDefaultExpression = loadDefaultAvatarExpression(defaultExpressionSettingsPath, DEFAULT_AVATAR_EXPRESSION);

  ipcMain.handle('chatx2:get-default-expression', () => ({ expression: currentDefaultExpression }));
  ipcMain.handle('chatx2:set-default-expression', (_event, expression: unknown) => {
    if (!isValidDefaultExpression(expression)) {
      return { success: false, reason: 'invalid-default-expression' };
    }
    if (!saveDefaultAvatarExpression(defaultExpressionSettingsPath, expression)) {
      return { success: false, reason: 'default-expression-not-persisted' };
    }
    currentDefaultExpression = expression;
    for (const win of [avatarWindow, composerWindow].filter(Boolean) as Electron.BrowserWindow[]) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('chatx2:default-expression-changed', expression);
      }
    }
    return { success: true, expression: currentDefaultExpression };
  });

  // 右键菜单：渲染进程提供菜单树，主进程用 native Menu.popup() 弹出。
  // 原生菜单由 OS 渲染，保证在透明 + 鼠标穿透的桌宠窗口上可见且有完整内容；
  // 用户点击某个 item 时，把其 id 回传给 Avatar 窗口由渲染进程执行动作。
  ipcMain.on('chatx2:open-avatar-context-menu', (event, payload: unknown) => {
    if (!avatarWindow || avatarWindow.isDestroyed() || avatarWindow.webContents.isDestroyed()) return;
    if (event.sender !== avatarWindow.webContents) return;

    type MenuNode =
      | { id: string; label: string; type: 'normal' | 'checkbox'; checked?: boolean; disabled?: boolean }
      | { id: string; label: string; type: 'submenu'; submenu: MenuNode[] }
      | { id: string; type: 'separator' };

    const sendSelection = (id: string): void => {
      if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
        avatarWindow.webContents.send('chatx2:avatar-context-menu-selected', id);
      }
    };
    const buildTemplate = (nodes: MenuNode[]): Electron.MenuItemConstructorOptions[] =>
      nodes.map((n) => {
        if (n.type === 'separator') return { type: 'separator' as const };
        if (n.type === 'submenu') return { label: n.label, submenu: buildTemplate(n.submenu) };
        return {
          label: n.label,
          type: n.type === 'checkbox' ? ('checkbox' as const) : ('normal' as const),
          checked: n.checked ?? false,
          enabled: n.disabled === true ? false : true,
          click: () => sendSelection(n.id)
        };
      });

    const items = Array.isArray(payload) ? (payload as unknown as MenuNode[]) : [];
    if (items.length === 0) return;
    const menu = Menu.buildFromTemplate(buildTemplate(items));
    menu.popup({ window: avatarWindow });
  });

  // 打光预设：应用指定预设
  ipcMain.handle('chatx2:set-lighting', (_event, presetId: string) => {
    if (typeof presetId !== 'string' || !presetId.trim()) {
      return { success: false, reason: 'invalid-preset-id' };
    }
    if (!writeCharacterAvatarSettings({
      lighting: { ...readCharacterAvatarSettings().lighting, currentPreset: presetId.trim() }
    })) {
      return { success: false, reason: 'lighting-not-persisted' };
    }
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      return { success: false, reason: 'avatar-window-not-ready' };
    }
    avatarWindow.webContents.send('chatx2:set-lighting', { presetId });
    return { success: true };
  });

  // 动态打光调节：设置灯光方向/强度（实时调节）
  ipcMain.handle('chatx2:set-lighting-dynamic', (_event, params: { keyIntensity?: number; keyX?: number; keyY?: number; keyZ?: number; fillIntensity?: number; rimIntensity?: number; hemiIntensity?: number; contrast?: number; saturation?: number }) => {
    if (!params || typeof params !== 'object') return { success: false, reason: 'invalid-lighting-params' };
    const allowed = ['keyIntensity', 'keyX', 'keyY', 'keyZ', 'fillIntensity', 'rimIntensity', 'hemiIntensity', 'contrast', 'saturation'] as const;
    const dynamic = Object.fromEntries(allowed
      .filter(key => typeof params[key] === 'number' && Number.isFinite(params[key]))
      .map(key => [
        key,
        key === 'contrast'
          ? clampLightingContrast(params[key])
          : key === 'saturation'
            ? clampLightingSaturation(params[key])
            : params[key]
      ]));
    const existingLighting = readCharacterAvatarSettings().lighting;
    if (!writeCharacterAvatarSettings({
      lighting: {
        ...existingLighting,
        dynamic: { ...(existingLighting?.dynamic ?? {}), ...dynamic }
      }
    })) {
      return { success: false, reason: 'lighting-not-persisted' };
    }
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      return { success: false, reason: 'avatar-window-not-ready' };
    }
    avatarWindow.webContents.send('chatx2:set-lighting-dynamic', {
      ...params,
      ...(dynamic.contrast !== undefined ? { contrast: dynamic.contrast } : {}),
      ...(dynamic.saturation !== undefined ? { saturation: dynamic.saturation } : {})
    });
    return { success: true };
  });

  // Unified avatar compute level: render cost plus lip/motion semantic budgets.
  const avatarComputeSettingsPath = join(sharedDataDir, 'avatar-compute-settings.json');
  let currentRenderQuality: AvatarComputeLevel = loadAvatarComputeLevel(avatarComputeSettingsPath);
  ipcMain.handle('chatx2:set-render-quality', (_event, level: AvatarComputeLevel) => {
    if (!isAvatarComputeLevel(level)) {
      return { success: false, reason: 'invalid-compute-level' };
    }
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      return { success: false, reason: 'avatar-window-not-ready' };
    }
    if (!saveAvatarComputeLevel(avatarComputeSettingsPath, level)) {
      return { success: false, reason: 'compute-level-not-persisted' };
    }
    currentRenderQuality = level;
    avatarWindow.webContents.send('chatx2:set-render-quality', { level });
    return { success: true, level: currentRenderQuality };
  });

  // Backward-compatible IPC name; this now returns the unified compute level.
  ipcMain.handle('chatx2:get-render-quality', () => {
    return { level: currentRenderQuality };
  });

  // 表情池短时预览。真实语音期间 runtime 会拒绝预览，防止覆盖自动表情。
  ipcMain.handle('chatx2:set-expression', async (
    _event,
    expressionId: string,
    channel?: string
  ) => {
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      return { success: false, reason: 'avatar-window-not-ready' };
    }
    const previewed = await avatarWindow.webContents.executeJavaScript(
      `window.__chatx2Runtime?.previewSpeechExpression?.(${JSON.stringify(expressionId)}, ${JSON.stringify(channel)}) ?? false`
    );
    return previewed
      ? { success: true }
      : { success: false, reason: 'unsupported-or-speech-active' };
  });

  // ============================================================
  // 桌宠窗口控制 IPC
  // ============================================================

  // 退出桌宠模式：隐藏 Avatar + Composer，切回 chat 模式
  ipcMain.handle('chatx2:exit-desktop', async () => {
    try {
      // 切换模式到 chat（会触发 mode-change 事件广播给所有窗口）
      // 如果已经是 chat 模式（already-in-mode），忽略错误继续隐藏窗口
      const result = await modeController.transition('chat');
      if (result.status === 'failure' && result.reason !== 'already-in-mode') {
        console.warn('[desktop] exit-desktop transition failed:', result.reason);
      }
      // 隐藏桌宠窗口（不销毁，以便重新打开）
      if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.hide();
      }
      if (composerWindow && !composerWindow.isDestroyed()) {
        composerWindow.hide();
      }
      return { success: true };
    } catch (e) {
      console.error('[desktop] exit-desktop failed:', e);
      return { success: false };
    }
  });

  // 移动桌宠——窗口全屏不移动，此 IPC 转发模型拖动 delta 给 Avatar 渲染进程
  ipcMain.handle('chatx2:move-avatar-window', (_event, deltaX: number, deltaY: number) => {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send('chatx2:pan-model', deltaX, deltaY);
    }
  });

  // 手动模型穿透状态（事实源由 Avatar renderer 维护，主进程仅缓存供窗口初始设置/重载）
  let manualModelPassThrough = false;
  let avatarDragInProgress = false;
  let avatarMouseState: boolean | undefined;
  let avatarHitProbeInFlight = false;
  let avatarLastReportedHover: boolean | undefined;

  function reportAvatarHover(onModel: boolean): void {
    if (avatarLastReportedHover === onModel || !avatarWindow || avatarWindow.isDestroyed()) return;
    avatarLastReportedHover = onModel;
    avatarWindow.webContents.send('chatx2:native-avatar-hover', onModel);
  }

  /**
   * Applies the real BrowserWindow mouse state from one place.  In particular,
   * do not rely on renderer mousemove while the transparent window ignores
   * mouse input: Windows may never dispatch that event to Chromium.
   */
  function applyAvatarMouseState(ignoreMouse: boolean): void {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    if (avatarMouseState === ignoreMouse) return;
    avatarMouseState = ignoreMouse;
    if (ignoreMouse) {
      avatarWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      avatarWindow.setIgnoreMouseEvents(false);
    }
  }

  /**
   * Windows-level hover recovery.  This runs independently of renderer
   * mousemove, so a transparent avatar can become interactive again after the
   * cursor re-enters the model from another desktop application.
   */
  function probeAvatarHitUnderSystemCursor(): void {
    if (avatarHitProbeInFlight || manualModelPassThrough || avatarDragInProgress) return;
    if (!avatarWindow || avatarWindow.isDestroyed() || !avatarWindow.isVisible()
      || avatarWindow.webContents.isDestroyed()) return;

    const bounds = avatarWindow.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const clientX = cursor.x - bounds.x;
    const clientY = cursor.y - bounds.y;
    if (clientX < 0 || clientY < 0 || clientX >= bounds.width || clientY >= bounds.height) {
      reportAvatarHover(false);
      applyAvatarMouseState(true);
      return;
    }

    avatarHitProbeInFlight = true;
    const script = `window.__chatx2Runtime?.__testIsPointOnModel?.(${JSON.stringify(clientX)}, ${JSON.stringify(clientY)}) === true`;
    void avatarWindow.webContents.executeJavaScript(script, true)
      .then((hit) => {
        if (!manualModelPassThrough && !avatarDragInProgress) {
          const onModel = hit === true;
          reportAvatarHover(onModel);
          applyAvatarMouseState(onModel ? false : true);
        }
      })
      .catch(() => {
        // Keep transparent-area behavior when the renderer is reloading.
        if (!manualModelPassThrough && !avatarDragInProgress) {
          reportAvatarHover(false);
          applyAvatarMouseState(true);
        }
      })
      .finally(() => {
        avatarHitProbeInFlight = false;
      });
  }

  // Raycasting through executeJavaScript every render frame competes with PMX
  // animation and Bullet. A 32 ms probe remains responsive while halving the
  // cross-process work; renderer pointer events still handle active dragging.
  const avatarHitProbeTimer = setInterval(probeAvatarHitUnderSystemCursor, 32);
  app.once('before-quit', () => clearInterval(avatarHitProbeTimer));

  // Composer → Avatar renderer：转发手动模型穿透请求
  // Avatar renderer 是唯一事实源，收到后更新 manualModelPassThrough 并广播变化（调用 apply-avatar-mouse-policy）
  ipcMain.handle('chatx2:set-model-pass-through', (_event, manual: boolean) => {
    manualModelPassThrough = manual;
    avatarDragInProgress = false;
    avatarMouseState = undefined;
    // 立即应用到窗口：
    //   manual=true  → 完全穿透（模型+模型外都不可交互）
    //   manual=false → 先进入 forward 等待状态；Avatar 收到 mousemove
    //                   并命中模型后会显式请求 setIgnoreMouseEvents(false)
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      if (manual) {
        avatarWindow.setIgnoreMouseEvents(true); // 不forward，完全穿透
        avatarMouseState = true;
      } else {
        // The probe will immediately recover model interaction if the cursor
        // is already over the avatar.  Do not wait for a forwarded mousemove.
        applyAvatarMouseState(true);
        probeAvatarHitUnderSystemCursor();
      }
    }
    // 同时通知 Avatar renderer 更新内部状态
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.webContents.send('chatx2:set-model-pass-through', manual);
    }
    // 通知 Composer 更新按钮显示
    if (composerWindow && !composerWindow.isDestroyed()) {
      composerWindow.webContents.send('chatx2:model-pass-through-changed', { manual });
    }
  });

  // Avatar → Composer：广播手动模型穿透开关变化（仅用户意图）
  ipcMain.on('chatx2:model-pass-through-changed', (_event, payload: { manual: boolean }) => {
    manualModelPassThrough = payload.manual;
    if (composerWindow && !composerWindow.isDestroyed()) {
      composerWindow.webContents.send('chatx2:model-pass-through-changed', payload);
    }
  });

  // Avatar → 主进程：应用窗口物理穿透状态（调 setIgnoreMouseEvents）
  // effectiveIgnoreMouse=true 时使用 forward 模式：窗口点击整体穿透，
  // 但 mousemove 仍转发给 Avatar；Avatar 射线命中模型后必须再次调用
  // effectiveIgnoreMouse=false，模型才能收到随后的 mousedown。
  // 注意：如果 manualModelPassThrough=true，忽略此调用（用户手动锁定完全穿透）
  ipcMain.on('chatx2:apply-avatar-mouse-policy', (event, effectiveIgnoreMouse: boolean) => {
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      event.returnValue = false;
      return;
    }
    if (manualModelPassThrough) {
      // 用户已手动锁定完全穿透，不被自动逻辑覆盖
      avatarWindow.setIgnoreMouseEvents(true);
      avatarMouseState = true;
      event.returnValue = true;
      return;
    }
    if (effectiveIgnoreMouse) {
      // 等待转发 mousemove；此状态不会自动让模型区域可交互
      applyAvatarMouseState(true);
    } else {
      // 完全不穿透（整窗口可交互，极少使用，保留向后兼容）
      applyAvatarMouseState(false);
    }
    event.returnValue = true;
  });

  // Renderer explicitly brackets a drag.  The screen-level hit probe must not
  // re-enable passthrough while the model is being moved away from the cursor.
  ipcMain.on('chatx2:avatar-dragging', (event, dragging: boolean) => {
    if (!avatarWindow || event.sender !== avatarWindow.webContents) return;
    if (manualModelPassThrough) return;
    avatarDragInProgress = dragging === true;
    if (avatarDragInProgress) {
      applyAvatarMouseState(false);
    } else {
      probeAvatarHitUnderSystemCursor();
    }
  });

  // 切换窗口置顶（Avatar + Composer 同步切换）
  // 两者都使用 screen-saver 级别确保始终在最上层
  ipcMain.handle('chatx2:toggle-always-on-top', (_event, onTop: boolean) => {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
      avatarWindow.setAlwaysOnTop(onTop, 'screen-saver');
    }
    if (composerWindow && !composerWindow.isDestroyed()) {
      composerWindow.setAlwaysOnTop(onTop, 'screen-saver');
    }
    return { success: true };
  });

  // Composer 聊天按钮：切换到 chat 模式（显示完整聊天窗口）
  ipcMain.handle('chatx2:transition-to-chat', async () => {
    try {
      await modeController.transition('chat');
      void showChatWindow();
      return { success: true };
    } catch (e) {
      console.error('[composer] transition-to-chat failed:', e);
      return { success: false };
    }
  });

  // 模型缩放：全屏模式下调整 3D 模型大小而非窗口大小（delta: 正=放大，负=缩小）
  ipcMain.handle('chatx2:set-model-scale', (_event, delta: number) => {
    if (!avatarWindow || avatarWindow.isDestroyed()) return { success: false };
    avatarWindow.webContents.send('chatx2:set-model-scale', delta);
    return { success: true };
  });

  // 视角模式切换：转发给 Avatar 窗口（窗口保持全屏，仅调整相机视角）
  ipcMain.handle('chatx2:set-camera-view', (_event, mode: 'full' | 'half') => {
    if (!avatarWindow || avatarWindow.isDestroyed()) return { success: false };
    avatarWindow.webContents.send('chatx2:set-camera-view', mode);
    return { success: true };
  });

  // 模型手动朝向：限制输入范围后转发给 Avatar，避免异常角度破坏姿态。
  ipcMain.handle('chatx2:set-model-rotation', (_event, yaw: number, pitch: number) => {
    if (!avatarWindow || avatarWindow.isDestroyed()) return { success: false };
    const clamp = (value: unknown, min: number, max: number): number => {
      const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      return Math.max(min, Math.min(max, numeric));
    };
    const payload = {
      yaw: clamp(yaw, -45, 45),
      pitch: clamp(pitch, -30, 30)
    };
    avatarWindow.webContents.send('chatx2:set-model-rotation', payload);
    return { success: true, ...payload };
  });

  // 获取打光预设列表（从 Avatar 窗口查询）
  ipcMain.handle('chatx2:get-lighting-presets', async () => {
    const savedLighting = readCharacterAvatarSettings().lighting ?? {};
    let runtimePresets: unknown = [];
    let runtimeCurrent = 'warm-studio';
    if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
      try {
        runtimePresets = await avatarWindow.webContents.executeJavaScript(
          'window.__chatx2Runtime?.getLightingPresets?.() ?? []'
        );
        runtimeCurrent = await avatarWindow.webContents.executeJavaScript(
          'window.__chatx2Runtime?.getCurrentLightingPreset?.() ?? "warm-studio"'
        );
      } catch (error) {
        console.warn('[lighting] Avatar runtime is not ready; using built-in presets:', error);
      }
    }
    return {
      success: true,
      presets: mergeLightingPresetSummaries(runtimePresets),
      current: typeof savedLighting.currentPreset === 'string' ? savedLighting.currentPreset : runtimeCurrent,
      dynamic: savedLighting.dynamic ?? {}
    };
  });

  // 获取共享语音表情池及当前模型通道支持情况。
  ipcMain.handle('chatx2:get-expression-presets', async () => {
    if (!avatarWindow || avatarWindow.isDestroyed()) {
      return { success: false, presets: [] };
    }
    const result = await avatarWindow.webContents.executeJavaScript(
      'window.__chatx2Runtime?.getExpressionPresets?.() ?? []'
    );
    return { success: true, presets: result, current: await avatarWindow.webContents.executeJavaScript('window.__chatx2Runtime?.getCurrentExpression?.() ?? "neutral"') };
  });

  // IPC: 测试主进程注入 test-only-ready 证据（仅测试模式）
  ipcMain.handle('chatx2:test-inject-ready', (event) => {
    if (!IS_TEST) {
      console.error('[avatar] rejected test-inject-ready: not in test mode');
      return { success: false, reason: 'not-test-mode' };
    }
    const evidence: AvatarReadyEvidence = {
      source: 'test-only-ready',
      timestamp: Date.now()
    };
    modeController.setAvatarReady(evidence);
    schedulePendingAvatarFlush();
    return { success: true };
  });

  // IPC: 报告 Avatar 崩溃
  ipcMain.on('chatx2:report-avatar-crash', () => {
    modeController.reportAvatarCrash();
  });

  // 创建三个窗口（Chat 可见，Avatar 和 Composer 隐藏，用户点击桌宠按钮后才显示）
  chatWindow = ensureChatWindow();
  avatarWindow = createDesktopAvatarWindow();
  composerWindow = createDesktopComposerWindow(avatarWindow.getBounds());

  // Avatar 不再开机自动显示，由用户点击桌宠按钮触发 showDesktopWindowsAndCommit 显示

  // Avatar renderer 崩溃时恢复 Chat（使用正确事件名 render-process-gone）
  // P1-E：同时通知 Composer 清理表演状态（Avatar 已崩溃，无法发送 performance:ended）
  // P1-F：同时释放所有 wavCache 条目（Avatar 已崩溃，无法发送 performance:ended 触发 releaseWav）
  // Phase 5.2 修正：同时调用 motionRegistry.releaseAll()（Avatar 崩溃，无法发送 motion:stop）
  avatarWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[avatar] render-process-gone:', details.reason);
    pendingAvatarPlays.clear();
    modeController.reportAvatarCrash();
    // 通知 Composer 清理 __composerSpeaking、字幕等状态
    if (composerWindow && !composerWindow.isDestroyed() && !composerWindow.webContents.isDestroyed()) {
      composerWindow.webContents.send('performance:ended', '', 'failed');
    }
    // P1-F：主进程主动释放所有 wavCache（不能信任 Renderer 主动通知）
    conversationController.releaseAllWav();
    // Phase 5.2 修正：释放所有 motion pack 注册（Avatar 崩溃后无法响应 motion 命令）
    const released = motionRegistry.releaseAll();
    if (released > 0) {
      console.log(`[motion] released ${released} packs after avatar crash`);
    }
  });

  // Avatar 窗口关闭时恢复 Chat（不退出应用）
  // P1-E：同时通知 Composer 清理表演状态
  // P1-F：同时释放所有 wavCache 条目
  // Phase 5.2 修正：同时调用 motionRegistry.releaseAll()
  avatarWindow.on('closed', () => {
    avatarWindow = null;
    pendingAvatarPlays.clear();
    modeController.reportAvatarCrash();
    if (composerWindow && !composerWindow.isDestroyed() && !composerWindow.webContents.isDestroyed()) {
      composerWindow.webContents.send('performance:ended', '', 'failed');
    }
    // P1-F：主进程主动释放所有 wavCache
    conversationController.releaseAllWav();
    // Phase 5.2 修正：释放所有 motion pack 注册
    const released = motionRegistry.releaseAll();
    if (released > 0) {
      console.log(`[motion] released ${released} packs after avatar closed`);
    }
  });

  // Composer 窗口关闭不退出应用
  composerWindow.on('closed', () => {
    composerWindow = null;
  });

  // 订阅模式变化，编排窗口显隐
  modeController.on('mode-change', async (event: ModeChangeEvent) => {
    // 广播给所有 renderer
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('chatx2:mode-change', event);
    }

    // P1-E：离开 desktop 时统一停止 Avatar 表演（清零口型、停止音频）
    // 触发场景：desktop → chat（用户切回）、desktop → loading（崩溃回退）
    // Avatar 收到 avatar:stop-play('mode-change') 后调用 stopPerformance()：
    //   - sourceNode.stop() + disconnect()
    //   - actorRuntime.stopSpeak() 清零 viseme
    //   - 发送 performance:ended(taskId, 'interrupted') 通知主进程释放 wavCache
    // 主进程收到 performance:ended 后转发给 Composer 清理字幕状态。
    // P1-F：同时主动 releaseAllWav()（不依赖 Avatar 的 performance:ended 回调，因为 Avatar 可能未响应）
    // Phase 5.2 修正：同时通过 motion:command 通知 Avatar stopImmediate()（mode-change 是紧急停止），
    //   并调用 motionRegistry.releaseAll() 释放所有 pack 注册（避免桌面模式外残留 motion 状态）
    if (event.from === 'desktop' && event.to !== 'desktop') {
      if (avatarWindow && !avatarWindow.isDestroyed() && !avatarWindow.webContents.isDestroyed()) {
        avatarWindow.webContents.send('avatar:stop-play', 'mode-change');
        avatarWindow.webContents.send('motion:command', { action: 'stop' });
      }
      // 桌宠与聊天界面共存：不再隐藏 Avatar 窗口，确保聊天模式下的口型/动作联动
      // 仅在 Avatar 窗口不可见时重新显示（兼容崩溃恢复场景）
      // P1-F：主进程主动释放所有 wavCache，防止 Avatar 未及时响应导致缓存残留
      conversationController.releaseAllWav();
      // Phase 5.2 修正：释放所有 motion pack 注册
      const released = motionRegistry.releaseAll();
      if (released > 0) {
        console.log(`[motion] released ${released} packs on mode-change ${event.from} -> ${event.to}`);
      }
    }

    // 注意：loading → desktop 的 commit 由 showDesktopWindowsAndCommit 处理
    // 这里只处理 chat 回退
    if (event.to === 'chat') {
      await showChatWindow();
    }
  });

  // 创建托盘（非测试模式）
  if (!IS_TEST) {
    createTray();
    // 首次启动创建桌面快捷方式（指向 start.bat）
    createDesktopShortcutIfFirstRun();
  }

  app.on('activate', () => {
    void restoreMainWindowFromShell('activate');
  });
});

app.on('window-all-closed', () => {
  // 测试模式直接退出；生产模式由托盘保持运行
  if (IS_TEST || process.platform === 'darwin') {
    app.quit();
  }
  // 生产模式：所有窗口关闭后保持托盘运行（不退出）
});

// Phase 5.1 修复（P1-F）：应用退出前释放所有 wavCache，防止进程结束后残留。
// Phase 5.2 修正：同时调用 motionRegistry.releaseAll() 释放所有 motion pack 注册。
app.on('before-quit', () => {
  isAppQuitting = true;
  try {
    ConversationController.getInstance().releaseAllWav();
  } catch (e) {
    // 退出时忽略清理错误
    void e;
  }
  try {
    motionRegistry.releaseAll();
  } catch (e) {
    void e;
  }
  // 杀掉 fork 的 Express 子进程（与 chat5.2 cleanup 一致）
  killServerProc();
});
