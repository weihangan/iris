// Morph 面板 UI（Phase 3 Task 3.3 Step 3）
// 职责：提供 A/I/U/E/O 按钮、眨眼、FaceRed 滑杆（0-0.35）、笑い、困る 等关键 morph 预览
// 通过 window.chatx2.morphControl API 控制渲染器中的 morph 权重
//
// 设计原则：
// - 仅在 PMX 渲染成功后显示（渲染器调用 initMorphPanel）
// - 非侵入式：浮在 Avatar 窗口右下角，半透明背景
// - 即时预览：点击按钮/拖动滑杆立即触发重绘
// - FaceRed 滑杆强制 0-0.35 安全范围（与 MorphController 一致）
//
// Phase 3 Step 5 扩展：物理状态 UI
// - 显示"物理：不可用"（physicsAvailable = false 时）
// - 物理开关按钮禁用，点击无反应
// - API setPhysicsEnabled(true) 返回 false（在 viewer-controls 中实现）
// - 文档保持 real physics = untested/unavailable

interface MorphControl {
  setWeight(name: string, weight: number): boolean;
  getWeight(name: string): number;
  reset(): void;
  getAvailableMorphs(): string[];
}

interface PhysicsControl {
  isPhysicsAvailable(): boolean;
  setPhysicsEnabled(enabled: boolean): boolean;
}

/**
 * 运行时 API 命名空间（window.__chatx2Runtime 由 desktop-avatar-renderer.ts 声明）。
 * contextBridge.exposeInMainWorld('chatx2', ...) 创建只读代理，运行时 API 通过
 * window.__chatx2Runtime 暴露。
 */
interface ChatX2RuntimeWithMorph {
  morphControl?: MorphControl;
  cameraControl?: PhysicsControl;
}

// 按钮配置：morph 名称 + 显示标签
interface MorphButtonConfig {
  readonly morph: string;
  readonly label: string;
  readonly title: string;
}

const VISEME_BUTTONS: readonly MorphButtonConfig[] = [
  { morph: 'あ', label: 'A', title: '口型 あ (a)' },
  { morph: 'い', label: 'I', title: '口型 い (i)' },
  { morph: 'う', label: 'U', title: '口型 う (u)' },
  { morph: 'え', label: 'E', title: '口型 え (e)' },
  { morph: 'お', label: 'O', title: '口型 お (o)' },
];

const EMOTION_BUTTONS: readonly MorphButtonConfig[] = [
  { morph: '笑い', label: '笑い', title: '情绪：笑 (happy)' },
  { morph: '困る', label: '困る', title: '情绪：困扰 (concerned)' },
  { morph: 'にこり', label: 'にこり', title: '情绪：微笑 (smile)' },
  { morph: 'びっくり', label: 'びっくり', title: '情绪：惊讶 (surprised)' },
  { morph: '怒り', label: '怒り', title: '情绪：生气 (angry)' },
];

const FACE_RED_MAX = 0.35;  // 与 MorphController 安全范围一致

/**
 * 初始化 Morph 面板。创建 DOM 元素并附加到 document.body。
 * 仅在 PMX 渲染成功后调用。
 */
export function initMorphPanel(): void {
  // 避免重复初始化
  if (document.getElementById('morph-panel')) {
    return;
  }

  const api = getMorphControl();
  if (!api) {
    console.warn('[morph-panel] morphControl API not available, panel not initialized');
    return;
  }

  const available = api.getAvailableMorphs();
  if (available.length === 0) {
    console.warn('[morph-panel] no morph targets available, panel not initialized');
    return;
  }

  const panel = createPanelElement();
  document.body.appendChild(panel);

  // 标题
  const title = document.createElement('div');
  title.className = 'mp-title';
  title.textContent = 'Morph Preview';
  panel.appendChild(title);

  // Viseme 区域
  panel.appendChild(createSectionLabel('口型 (Visemes)'));
  panel.appendChild(createButtonRow(VISEME_BUTTONS, api));

  // 眨眼按钮
  panel.appendChild(createSectionLabel('眨眼 (Blink)'));
  const blinkRow = document.createElement('div');
  blinkRow.className = 'mp-row';
  blinkRow.appendChild(createToggleButton({
    morph: 'まばたき',
    label: 'まばたき',
    title: '眨眼 (blink)',
  }, api));
  panel.appendChild(blinkRow);

  // 情绪区域
  panel.appendChild(createSectionLabel('情绪 (Emotions)'));
  panel.appendChild(createButtonRow(EMOTION_BUTTONS, api));

  // FaceRed 滑杆
  panel.appendChild(createSectionLabel(`脸红 (FaceRed) [0 - ${FACE_RED_MAX}]`));
  panel.appendChild(createFaceRedSlider(api));

  // 其他 morph（照れ、涙）
  panel.appendChild(createSectionLabel('其他 (Others)'));
  const otherRow = document.createElement('div');
  otherRow.className = 'mp-row';
  otherRow.appendChild(createToggleButton({
    morph: '照れ',
    label: '照れ',
    title: '害羞 (shy)',
  }, api));
  otherRow.appendChild(createToggleButton({
    morph: '涙',
    label: '涙',
    title: '眼泪 (tears)',
  }, api));
  panel.appendChild(otherRow);

  // Phase 3 Step 5：物理状态 UI
  // physicsAvailable = false 时显示"物理：不可用"，开关禁用
  panel.appendChild(createPhysicsStatusSection());

  // 重置按钮
  const resetBtn = document.createElement('button');
  resetBtn.className = 'mp-btn mp-btn-reset';
  resetBtn.textContent = 'Reset All';
  resetBtn.title = '重置所有 morph 权重为 0';
  resetBtn.addEventListener('click', () => {
    api.reset();
    // 更新所有按钮的激活状态
    panel.querySelectorAll('.mp-btn-toggle').forEach(btn => {
      (btn as HTMLElement).classList.remove('active');
    });
    // 重置滑杆
    const slider = document.getElementById('mp-facered-slider') as HTMLInputElement | null;
    const valueLabel = document.getElementById('mp-facered-value');
    if (slider) slider.value = '0';
    if (valueLabel) valueLabel.textContent = '0.00';
  });
  panel.appendChild(resetBtn);

  console.log('[morph-panel] initialized with morphs:', available);
}

/**
 * 获取 morph 控制 API
 */
function getMorphControl(): MorphControl | null {
  const runtime = getRuntime();
  return runtime?.morphControl ?? null;
}

/**
 * 获取物理控制 API
 */
function getPhysicsControl(): PhysicsControl | null {
  const runtime = getRuntime();
  return runtime?.cameraControl ?? null;
}

function getRuntime(): ChatX2RuntimeWithMorph | undefined {
  return (window as unknown as { __chatx2Runtime?: ChatX2RuntimeWithMorph }).__chatx2Runtime;
}

/**
 * 创建面板根元素
 */
function createPanelElement(): HTMLDivElement {
  const panel = document.createElement('div');
  panel.id = 'morph-panel';
  panel.className = 'mp-panel';
  return panel;
}

/**
 * 创建分区标签
 */
function createSectionLabel(text: string): HTMLDivElement {
  const label = document.createElement('div');
  label.className = 'mp-section';
  label.textContent = text;
  return label;
}

/**
 * 创建按钮行
 */
function createButtonRow(buttons: readonly MorphButtonConfig[], api: MorphControl): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'mp-row';
  for (const cfg of buttons) {
    // 仅添加可用的 morph
    if (api.getWeight(cfg.morph) >= -1) {
      row.appendChild(createToggleButton(cfg, api));
    }
  }
  return row;
}

/**
 * 创建切换按钮（点击切换 0/1）
 */
function createToggleButton(cfg: MorphButtonConfig, api: MorphControl): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'mp-btn mp-btn-toggle';
  btn.textContent = cfg.label;
  btn.title = cfg.title;
  btn.dataset.morph = cfg.morph;

  btn.addEventListener('click', () => {
    const current = api.getWeight(cfg.morph);
    if (current > 0) {
      api.setWeight(cfg.morph, 0);
      btn.classList.remove('active');
    } else {
      api.setWeight(cfg.morph, 1);
      btn.classList.add('active');
    }
  });

  return btn;
}

/**
 * 创建 FaceRed 滑杆（0 - 0.35 安全范围）
 */
function createFaceRedSlider(api: MorphControl): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'mp-slider-container';

  const slider = document.createElement('input');
  slider.id = 'mp-facered-slider';
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(FACE_RED_MAX);
  slider.step = '0.01';
  slider.value = '0';
  slider.className = 'mp-slider';
  slider.title = `FaceRed 脸红程度 (0 - ${FACE_RED_MAX})`;

  const valueLabel = document.createElement('span');
  valueLabel.id = 'mp-facered-value';
  valueLabel.className = 'mp-slider-value';
  valueLabel.textContent = '0.00';

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    api.setWeight('FaceRed', v);
    valueLabel.textContent = v.toFixed(2);
  });

  container.appendChild(slider);
  container.appendChild(valueLabel);
  return container;
}

/**
 * Phase 3 Step 5：创建物理状态 UI 区块
 *
 * 行为：
 * - physicsAvailable = false（当前状态）：显示"物理：不可用"红色文本，开关按钮禁用
 * - physicsAvailable = true（未来接入真实物理后）：显示"物理：可用"，开关启用
 *
 * 文档约束：
 * - 真实物理未接入，UI 必须明确显示 unavailable，不能只在内部 API 返回 false
 * - 不得写成真实物理完成
 */
function createPhysicsStatusSection(): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'mp-physics-section';

  // 分区标签
  container.appendChild(createSectionLabel('物理 (Physics)'));

  // 状态行：显示"物理：不可用"或"物理：可用"
  const statusRow = document.createElement('div');
  statusRow.className = 'mp-physics-status-row';

  const statusLabel = document.createElement('span');
  statusLabel.id = 'physics-status';
  statusLabel.className = 'mp-physics-status';

  const physicsControl = getPhysicsControl();
  const available = physicsControl?.isPhysicsAvailable() ?? false;

  if (available) {
    statusLabel.textContent = '物理：可用';
    statusLabel.classList.add('mp-physics-available');
  } else {
    statusLabel.textContent = '物理：不可用';
    statusLabel.classList.add('mp-physics-unavailable');
  }
  statusRow.appendChild(statusLabel);
  container.appendChild(statusRow);

  // 开关按钮：physicsAvailable = false 时禁用
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'physics-toggle';
  toggleBtn.type = 'button';
  toggleBtn.dataset.physics = 'true';
  toggleBtn.className = 'mp-btn mp-physics-toggle';
  toggleBtn.textContent = available ? '开启物理' : '物理不可用';
  toggleBtn.disabled = !available;
  if (!available) {
    toggleBtn.classList.add('mp-btn-disabled');
  }
  // 即使 enabled 也通过 API 控制（API 会校验 backend 可用性）
  toggleBtn.addEventListener('click', () => {
    if (!physicsControl) return;
    if (toggleBtn.disabled) return;
    // 调用 API：若 backend 不可用会返回 false
    const ok = physicsControl.setPhysicsEnabled(true);
    if (ok) {
      toggleBtn.textContent = '已开启';
      toggleBtn.classList.add('active');
    } else {
      toggleBtn.textContent = '物理不可用';
      toggleBtn.disabled = true;
    }
  });
  container.appendChild(toggleBtn);

  return container;
}
