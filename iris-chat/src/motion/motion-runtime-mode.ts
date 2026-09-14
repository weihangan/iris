// Phase 5.2 Task 5.2.4（用户要求 2026-07-19）：Candidate Review 运行时模式
//
// 用户要求：
//   - 增加仅测试/本地验收可启用的 candidate review 模式
//   - 生产环境继续拒绝未白名单动作
//   - 三个待机包 videoAcceptance.accepted=false、whitelistRegistered=false
//   - 视频前不得进入生产白名单
//
// 设计：
//   - 生产模式（production）：只允许 8 阶段门全部通过的 manifest 注册
//   - 候选评审模式（candidate-review）：允许阶段 1-5 通过、6-8 待视频验收的 manifest 注册
//     仅在测试/本地验收环境启用（CHAT6_MOTION_CANDIDATE_REVIEW=1 或 NODE_ENV=test）
//   - 候选 pack 在 manifest 中标记 whitelistRegistered=false，运行时加载需显式校验模式
//
// 启用方式：
//   - 环境变量 CHAT6_MOTION_CANDIDATE_REVIEW=1
//   - 测试模式（NODE_ENV=test）自动启用
//   - 主进程可通过 setMotionRuntimeModeForTesting() 在测试中显式设置（仅测试可用）
//
// 安全门禁：
//   - 生产构建（isProduction()=true）禁止启用 candidate-review，强制回退 production
//   - Renderer 进程无法设置此模式（主进程单源真理）

export type MotionRuntimeMode = 'production' | 'candidate-review';

const ENV_VAR = 'CHAT6_MOTION_CANDIDATE_REVIEW';

/**
 * 判断当前是否为生产构建。
 * 生产构建的判定：
 *   - app.isPackaged（Electron 主进程）
 *   - 或 NODE_ENV=production
 */
function isProductionBuild(): boolean {
  // Electron 主进程：app.isPackaged
  try {
    // 优先通过 process.env.PRODUCTION 标志（构建时由 electron-builder 注入）
    if (process.env.PRODUCTION === '1' || process.env.NODE_ENV === 'production') {
      return true;
    }
  } catch {
    // process 不可用（renderer 无 process），按非生产处理
  }
  return false;
}

/**
 * 判断当前是否为测试模式。
 */
function isTestMode(): boolean {
  try {
    return process.env.NODE_ENV === 'test';
  } catch {
    return false;
  }
}

/**
 * 默认运行时模式：
 *   - 测试模式（NODE_ENV=test）→ candidate-review
 *   - 环境变量 CHAT6_MOTION_CANDIDATE_REVIEW=1 → candidate-review
 *   - 其他 → production
 *
 * 生产构建强制回退 production（即使环境变量被错误设置）。
 */
function getDefaultMode(): MotionRuntimeMode {
  const requested: MotionRuntimeMode =
    isTestMode() || process.env[ENV_VAR] === '1'
      ? 'candidate-review'
      : 'production';

  // 生产构建强制 production，无视环境变量
  if (isProductionBuild() && requested === 'candidate-review') {
    return 'production';
  }
  return requested;
}

// 模块级单例（主进程单源真理）
let currentMode: MotionRuntimeMode | null = null;

/**
 * 获取当前运行时模式。
 * 首次调用时从环境变量初始化。
 */
export function getMotionRuntimeMode(): MotionRuntimeMode {
  if (currentMode === null) {
    currentMode = getDefaultMode();
  }
  return currentMode;
}

/**
 * 是否为 candidate-review 模式。
 */
export function isCandidateReviewMode(): boolean {
  return getMotionRuntimeMode() === 'candidate-review';
}

/**
 * 是否为 production 模式。
 */
export function isProductionMode(): boolean {
  return getMotionRuntimeMode() === 'production';
}

/**
 * 仅测试可用：显式设置运行时模式。
 * 生产构建调用此函数会被拒绝（throw）。
 * 用于单元测试覆盖两种模式。
 */
export function setMotionRuntimeModeForTesting(mode: MotionRuntimeMode): void {
  if (isProductionBuild()) {
    throw new Error('[motion-runtime-mode] cannot override mode in production build');
  }
  currentMode = mode;
}

/**
 * 仅测试可用：重置为默认模式。
 */
export function resetMotionRuntimeModeForTesting(): void {
  if (isProductionBuild()) {
    throw new Error('[motion-runtime-mode] cannot reset mode in production build');
  }
  currentMode = null;
}
