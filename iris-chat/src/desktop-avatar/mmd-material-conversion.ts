import * as THREE from 'three';

type MmdMaterialUserData = Record<string, unknown>;

/**
 * 桌宠透明窗口下的贴图半透明修复。
 *
 * 部分 PMX（如赛琳娜婚皮 `(袖)袖子本体`）的漫反射贴图自带大面积半透明
 * （婚纱纱质：Alpha03.png 约 30.9% 像素半透明、5.8% 全透明）。loader 按
 * MMD 真实行为走 alphaBlend 混合，帧缓冲 alpha 被压低后透明窗口直接透出
 * 桌面——视觉上呈现"手臂/手肘透明、没渲染"（2026-08 婚皮实测：弯臂时
 * 半透明白色像素从 5200 暴增至 9179，集中在袖口/手肘区域）。
 *
 * 2026-08 三轮实测演进：
 * 1) alpha 下限 0.72/0.85 → 残留透过率仍可见；
 * 2) alpha=1 + 保留镂空 discard → 静止正常，但动作中袖子甩起后，
 *    贴图全透明 texel 形成的蕾丝洞后面没有几何体，桌面从洞里透出，
 *    观感仍是"手臂透明"（用户实测：静止正常、动作中复发）。
 * 3) 最终方案：彻底不 discard，所有 texel 一律写满 alpha。蕾丝镂空
 *    细节牺牲掉，换取任何姿态下袖子/手臂都不透。
 *
 * 仅作用于"材质本体不透明（PMX diffuse alpha >= 1）且透明完全来自贴图"
 * 的 alphaBlend 材质；整体半透明材质（PMX diffuse alpha < 1，如 body+，
 * 作者本来就设定为隐形）不受影响。
 */
function isTextureDrivenAlphaBlendMaterial(
  mmdMaterial: MmdMaterialUserData,
  map: THREE.Texture | null
): boolean {
  if (mmdMaterial.transparencyMode !== 'alphaBlend' || !map) return false;
  const diffuse = mmdMaterial.diffuse;
  if (!Array.isArray(diffuse) || typeof diffuse[3] !== 'number') return false;
  return diffuse[3] >= 1;
}

function applyTransparentWindowAlphaFloor(
  converted: THREE.MeshStandardMaterial,
  mmdMaterial: MmdMaterialUserData
): void {
  if (!isTextureDrivenAlphaBlendMaterial(mmdMaterial, converted.map)) return;
  converted.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      // 透明窗口贴图半透明修复：不做镂空剔除（蕾丝洞会在动作中透出桌面），
      // 所有 texel 一律写满 alpha（详见 applyTransparentWindowAlphaFloor 注释）。
      diffuseColor.a = 1.00;`
    );
  };
}


function cloneMmdMaterialMetadata(material: THREE.Material): MmdMaterialUserData | undefined {
  const metadata = material.userData.mmdMaterial;
  if (!metadata || typeof metadata !== 'object') return undefined;
  return structuredClone(metadata as MmdMaterialUserData);
}

/**
 * Converts the loader's MeshToonMaterial to a shader-hook-free Standard material.
 *
 * The loader may classify a PMX material from the alpha actually used by its UVs.
 * Runtime material synchronization reads userData.mmdMaterial.transparencyMode, so
 * that safe metadata must survive the conversion. Shader state is intentionally
 * not copied because the MMD/SDEF hooks do not compile with Three.js 0.185.1.
 */
export function convertMmdMaterial(
  material: THREE.MeshToonMaterial
): THREE.MeshStandardMaterial {
  const converted = new THREE.MeshStandardMaterial({
    color: material.color.clone(),
    emissive: material.emissive.clone(),
    emissiveMap: material.emissiveMap,
    emissiveIntensity: 1.2, // 略微提升自发光，让眼睛/腮红等 emissive 更明显
    opacity: material.opacity,
    transparent: material.transparent,
    side: material.side,
    map: material.map,
    alphaMap: material.alphaMap,
    alphaTest: material.alphaTest,
    depthWrite: material.depthWrite,
    depthTest: material.depthTest,
    colorWrite: material.colorWrite,
    normalMap: material.normalMap,
    normalMapType: material.normalMapType,
    normalScale: material.normalScale.clone(),
    vertexColors: material.vertexColors,
    fog: material.fog,
    roughness: 0.5,  // 降低粗糙度，配合环境贴图产生更平滑的高光与反射
    metalness: 0     // 非金属（皮肤/衣物/头发均为电介质）
  });

  converted.name = material.name;
  converted.visible = material.visible;
  converted.blending = material.blending;
  converted.premultipliedAlpha = material.premultipliedAlpha;
  converted.dithering = material.dithering;
  converted.toneMapped = material.toneMapped;
  converted.shadowSide = material.shadowSide;

  const mmdMaterial = cloneMmdMaterialMetadata(material);
  if (mmdMaterial) {
    converted.userData.mmdMaterial = mmdMaterial;
    applyTransparentWindowAlphaFloor(converted, mmdMaterial);
  }

  return converted;
}

export function replaceMmdMaterialsWithStandard(mesh: THREE.SkinnedMesh): void {
  const original = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const converted = original.map(material =>
    convertMmdMaterial(material as THREE.MeshToonMaterial));
  mesh.material = converted.length === 1 ? converted[0] : converted;
}

/**
 * 透明窗口下的"隐形深度墙"修复。
 *
 * PMX 作者常用 diffuse alpha=0 + 投影标志的材质做隐形遮蔽层（如赛琳娜婚皮
 * 的 `body+` 身体包裹层、`后发渐变过渡` 后发渐变区）。loader 的每帧
 * syncMmdMaterialStates 会把它们设为 colorWrite=false（不写颜色）但
 * depthWrite=true（照常写深度）。结果：手臂合拢穿过 body+ 包裹区、手肘
 * 后弯进入后发渐变区时，手臂被这堵"看不见的墙"深度遮挡——不写颜色也
 * 不被画 → 帧缓冲 alpha 保持 0 → 桌面直接透出，表现为"弯臂/合拢时手臂
 * 透明"（2026-08 婚皮实测：关墙后弯臂画面恢复 4555 个可见像素）。
 *
 * 语义规则：不可见（colorWrite=false）的材质一律不得写深度——看不见的
 * 东西不应遮挡看得见的几何。需在每帧 onBeforeRender（晚于 loader 的
 * sync）调用，因为 syncMmdMaterialStates 每帧都会重置 depthWrite。
 *
 * @returns 本次实际修改 depthWrite 的材质数（诊断用）
 */
export function disableInvisibleMaterialDepthWrite(
  material: THREE.Material | THREE.Material[]
): number {
  let count = 0;
  const list = Array.isArray(material) ? material : [material];
  for (const m of list) {
    if (m.colorWrite === false && m.depthWrite !== false) {
      m.depthWrite = false;
      count += 1;
    }
  }
  return count;
}
