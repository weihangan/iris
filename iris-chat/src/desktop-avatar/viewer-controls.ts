// 查看器控制（Task 4）：相机视角、模型缩放、纹理诊断、物理开关
//
// 设计原则：
// - 相机视角用头骨定位 face 镜头（避免旧实现用包围盒顶部估算面部位置不准）
// - 缩放钳制 0.4-1.6，防止模型过大溢出或过小不可见
// - 纹理诊断开关：临时移除/恢复材质 map，用于排查渲染问题
// - 物理开关：默认关闭，用户开启时若 backend 不可用返回 false
// - 物理状态由调用方（renderer）实际应用到 model.update，本模块只记录意图
//
// 2026-07-24 新增：相机 zoom + 鼠标滚轮缩放 + 平移
// - zoom：调整相机距离（0.5x-2.5x），滚轮比例步长式缩放
// - pan：鼠标拖拽平移相机 lookAt 目标，使用实际 canvas 尺寸计算像素→世界坐标映射
// 2026-07-24 优化：比例步长替代固定步长，实际 canvas 高度替代硬编码 500px
// 2026-07-27 简化：移除 1/4身视角，仅保留全身/半身

import * as THREE from 'three';

export interface ViewerControls {
  resetCamera(): void;
  setAngle(angle: 'front' | 'side' | 'full' | 'face'): boolean;
  /** 设置视角模式：全身/半身；preservePosition=true 时保持当前模型位置 */
  setViewMode(mode: 'full' | 'half', preservePosition?: boolean): boolean;
  /** 将模型中心定位到指定屏幕像素位置（canvas 左上角原点） */
  setModelScreenPosition(canvasW: number, canvasH: number, sx: number, sy: number): void;
  setScale(scale: number): number;
  getScale(): number;
  setZoom(zoom: number): number;
  getZoom(): number;
  setPanOffset(x: number, y: number): void;
  getPanOffset(): { x: number; y: number };
  /** 更新基准距离（窗口 resize 后调用） */
  setBaseDistance(distance: number): void;
  setTexturesEnabled(enabled: boolean): void;
  setPhysicsEnabled(enabled: boolean): boolean;
  isPhysicsAvailable(): boolean;
  /** 处理鼠标滚轮事件（缩放），返回新 zoom 值 */
  handleWheel(deltaY: number): number;
  /** 处理鼠标拖拽（平移），delta 为屏幕像素偏移 */
  handlePan(deltaX: number, deltaY: number): void;
  /** 获取屏幕像素→世界坐标的转换系数 */
  getWorldPerPixel(): number;
  /** 获取模型中心在屏幕上的像素坐标（canvas 左上角为原点） */
  getModelScreenPosition(canvasWidth: number, canvasHeight: number): { x: number; y: number };
}

export interface ViewerControlOptions {
  root: THREE.Object3D;
  mesh: THREE.SkinnedMesh;
  camera: THREE.PerspectiveCamera;
  bounds: THREE.Box3;
  render: () => void;
  physicsAvailable: boolean;
  onPhysicsChanged: (enabled: boolean) => void;
  /** Canvas 像素高度，用于 handlePan 计算像素→世界坐标映射。默认 500。 */
  canvasHeight?: number;
}

/**
 * 创建查看器控制实例。
 * 相机视角基于包围盒和头骨位置；缩放钳制 0.4-1.6。
 */
export function createViewerControls(
  options: ViewerControlOptions
): ViewerControls {
  const center = options.bounds.getCenter(new THREE.Vector3());
  const size = options.bounds.getSize(new THREE.Vector3());

  // 查找头骨用于 face 镜头定位
  const headBone = options.mesh.skeleton?.bones?.find(
    bone => bone.name === '頭'
  );

  // 保存材质的 map 用于纹理诊断开关
  const materials = Array.isArray(options.mesh.material)
    ? options.mesh.material
    : [options.mesh.material];
  const originalMaps = new Map<THREE.Material, THREE.Texture | null>();
  for (const material of materials) {
    const standard = material as THREE.MeshStandardMaterial;
    originalMaps.set(material, standard.map ?? null);
  }

  let physicsEnabled = false;
  let currentScale = 1.0;
  const initialRootPosition = options.root.position.clone();

  // 基准距离（resetCamera 时计算的值）
  let baseDistance = 0;
  // 当前 zoom 级别（1.0 = 基准距离）
  let currentZoom = 1.0;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2.5;
  // 平移偏移（世界坐标）
  let panX = 0;
  let panY = 0;

  // 根据模型高度和 FOV 计算合适的距离，margin 控制留白
  const fitDistance = (height: number, margin = 1.15): number => {
    const fov = THREE.MathUtils.degToRad(options.camera.fov);
    return (height * margin) / (2 * Math.tan(fov / 2));
  };

  const applyCamera = (target: THREE.Vector3, distance: number): void => {
    const panTarget = target.clone();
    panTarget.x += panX;
    panTarget.y += panY;
    const effectiveDistance = distance / currentZoom;
    options.camera.position.set(panTarget.x, panTarget.y, panTarget.z + effectiveDistance);
    options.camera.lookAt(panTarget);
    options.camera.updateProjectionMatrix();
    options.render();
  };

  const lookFromFront = (target: THREE.Vector3, distance: number): void => {
    applyCamera(target, distance);
  };

  /** Position a chosen local model anchor at a screen point without scaling PMX. */
  const placeLocalPointOnScreen = (
    localPoint: THREE.Vector3,
    canvasW: number,
    canvasH: number,
    sx: number,
    sy: number
  ): void => {
    if (!canvasW || !canvasH) return;
    const ndcX = (sx / canvasW) * 2 - 1;
    const ndcY = -(sy / canvasH) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), options.camera);
    const currentWorldPoint = options.root.localToWorld(localPoint.clone());
    if (Math.abs(raycaster.ray.direction.z) < 1e-6) return;
    const t = (currentWorldPoint.z - raycaster.ray.origin.z) / raycaster.ray.direction.z;
    const targetWorldPoint = raycaster.ray.at(t, new THREE.Vector3());
    options.root.position.add(targetWorldPoint.sub(currentWorldPoint));
    options.render();
  };

  // 初始化基准距离
  baseDistance = fitDistance(size.y);

  return {
    resetCamera() {
      currentZoom = 1.0;
      panX = 0;
      panY = 0;
      lookFromFront(center, baseDistance);
    },

    setAngle(angle) {
      if (angle === 'face') {
        if (!headBone) return false;
        const headPos = headBone.getWorldPosition(new THREE.Vector3());
        const headHeight = size.y / 6;
        const fov = THREE.MathUtils.degToRad(options.camera.fov);
        const distance = headHeight / (0.6 * 2 * Math.tan(fov / 2));
        lookFromFront(headPos, distance);
        return true;
      }
      if (angle === 'side') {
        const distance = baseDistance;
        const panTarget = center.clone();
        panTarget.x += panX;
        panTarget.y += panY;
        const effectiveDistance = distance / currentZoom;
        options.camera.position.set(panTarget.x + effectiveDistance, panTarget.y, panTarget.z);
        options.camera.lookAt(panTarget);
        options.camera.updateProjectionMatrix();
        options.render();
        return true;
      }
      if (angle === 'front') {
        lookFromFront(center, fitDistance(size.y, 1.1));
        return true;
      }
      if (angle === 'full') {
        const fov = THREE.MathUtils.degToRad(options.camera.fov);
        const aspect = options.camera.aspect;
        const distForHeight = (size.y * 1.15) / (2 * Math.tan(fov / 2));
        const distForWidth = (size.x * 1.15) / (2 * Math.tan(fov / 2) * aspect);
        const distance = Math.max(distForHeight, distForWidth);
        lookFromFront(center, distance);
        return true;
      }
      return false;
    },

    setViewMode(mode, preservePosition = false) {
      const canvasW = typeof window !== 'undefined' ? window.innerWidth : 1920;
      const canvasH = typeof window !== 'undefined' ? window.innerHeight : 1080;
      if (mode === 'full') {
        // 全身：基于包围盒完整高度计算距离，与首次加载 padding=1.15 保持一致
        const fov = THREE.MathUtils.degToRad(options.camera.fov);
        const aspect = options.camera.aspect;
        const distForHeight = (size.y * 1.15) / (2 * Math.tan(fov / 2));
        const distForWidth = (size.x * 1.15) / (2 * Math.tan(fov / 2) * aspect);
        const distance = Math.max(distForHeight, distForWidth);
        lookFromFront(center, distance);
        // 默认居中；resize 时 preservePosition 保持用户拖动位置
        if (!preservePosition) {
          currentZoom = 1.0;
          options.root.position.copy(initialRootPosition);
          lookFromFront(center, distance);
          panX = 0;
          panY = 0;
          placeLocalPointOnScreen(center, canvasW, canvasH, canvasW * 0.5, canvasH * 0.5);
        }
        return true;
      }
      if (mode === 'half') {
        // 半身：从头到腰，焦点在头部与中心之间
        const headTop = headBone
          ? headBone.getWorldPosition(new THREE.Vector3())
          : new THREE.Vector3(center.x, center.y + size.y * 0.3, center.z);
        const target = new THREE.Vector3(
          center.x,
          (headTop.y + center.y) / 2,
          center.z
        );
        const halfHeight = size.y * 0.55;
        const distance = fitDistance(halfHeight, 1.2);
        // 半身默认比原先后退三档（1.0 -> 0.78），使头到腰留有余量。
        // 不能缩放 root：MMD 物理骨骼、飘带和服装会因此失真。
        if (!preservePosition) {
          currentZoom = 0.78;
          options.root.position.copy(initialRootPosition);
          panX = 0;
          panY = 0;
          lookFromFront(target, distance);
          // 从原右下位置向左移动约三分之一屏幕，保留底部安全边距。
          placeLocalPointOnScreen(target, canvasW, canvasH, canvasW * 0.43, canvasH * 0.62);
        } else {
          lookFromFront(target, distance);
        }
        return true;
      }
      return false;
    },

    setModelScreenPosition(canvasW, canvasH, sx, sy) {
      placeLocalPointOnScreen(center, canvasW, canvasH, sx, sy);
    },

    setScale(value) {
      const scale = THREE.MathUtils.clamp(value, 0.4, 1.6);
      currentScale = scale;
      options.root.scale.setScalar(scale);
      options.render();
      return scale;
    },

    getScale() {
      return currentScale;
    },

    setZoom(zoom) {
      currentZoom = THREE.MathUtils.clamp(zoom, ZOOM_MIN, ZOOM_MAX);
      applyCamera(center, baseDistance);
      return currentZoom;
    },

    getZoom() {
      return currentZoom;
    },

    setPanOffset(x, y) {
      panX = x;
      panY = y;
      applyCamera(center, baseDistance);
    },

    getPanOffset() {
      return { x: panX, y: panY };
    },

    setBaseDistance(distance: number) {
      baseDistance = Math.max(distance, 5);
      applyCamera(center, baseDistance);
    },

    handleWheel(deltaY) {
      // 滚轮 deltaY > 0 = 缩小，< 0 = 放大
      // 比例步长：当前 zoom 的 8%，放大时步长更小、缩小时步长更大，手感更自然
      const zoomStep = currentZoom * 0.08;
      const newZoom = deltaY > 0
        ? currentZoom - zoomStep
        : currentZoom + zoomStep;
      return this.setZoom(newZoom);
    },

    handlePan(deltaX, deltaY) {
      // 屏幕像素偏移 → 世界坐标偏移（考虑相机距离和 FOV）
      const fov = THREE.MathUtils.degToRad(options.camera.fov);
      const effectiveDistance = baseDistance / currentZoom;
      const worldHeight = 2 * Math.tan(fov / 2) * effectiveDistance;
      // 使用实际 canvas 高度（默认 500px 兜底）
      const canvasH = options.canvasHeight ?? 500;
      const worldPerPixel = worldHeight / canvasH;
      panX += deltaX * worldPerPixel;
      panY += deltaY * worldPerPixel; // 屏幕 Y 轴与 3D Y 轴方向相反，取反以匹配拖拽直觉
      // 不限制平移范围，模型可拖到全屏任意位置
      applyCamera(center, baseDistance);
    },

    setTexturesEnabled(enabled) {
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        if (enabled) {
          standard.map = originalMaps.get(material) ?? null;
        } else {
          standard.map = null;
        }
        standard.needsUpdate = true;
      }
      options.render();
    },

    getWorldPerPixel() {
      const fov = THREE.MathUtils.degToRad(options.camera.fov);
      const effectiveDistance = baseDistance / currentZoom;
      const worldHeight = 2 * Math.tan(fov / 2) * effectiveDistance;
      const canvasH = options.canvasHeight ?? 500;
      return worldHeight / canvasH;
    },

    getModelScreenPosition(canvasW, canvasH) {
      // 使用 model.root 当前世界位置投影到屏幕坐标，跟随拖拽实时更新
      const pos = options.root.position.clone().project(options.camera);
      // NDC → 屏幕像素（canvas 左上角原点）
      const sx = (pos.x * 0.5 + 0.5) * canvasW;
      const sy = (-pos.y * 0.5 + 0.5) * canvasH;
      return { x: sx, y: sy };
    },

    setPhysicsEnabled(enabled) {
      if (enabled && !options.physicsAvailable) return false;
      physicsEnabled = enabled;
      options.onPhysicsChanged(physicsEnabled);
      return true;
    },

    isPhysicsAvailable() {
      return options.physicsAvailable;
    }
  };
}
