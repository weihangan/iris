import * as THREE from 'three';
import { syncMmdMaterialStates } from '@yohawing/three-mmd-loader/three';
import { describe, expect, it } from 'vitest';
import {
  convertMmdMaterial,
  disableInvisibleMaterialDepthWrite,
  replaceMmdMaterialsWithStandard
} from '../../src/desktop-avatar/mmd-material-conversion';

function createMmdToonMaterial(transparencyMode: 'opaque' | 'alphaTest' | 'alphaBlend' = 'alphaBlend') {
  const map = new THREE.Texture();
  map.name = 'face+.png';
  map.flipY = false;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;

  const alphaMap = new THREE.Texture();
  const normalMap = new THREE.Texture();
  const emissiveMap = new THREE.Texture();
  const material = new THREE.MeshToonMaterial({
    color: new THREE.Color(0.8, 0.7, 0.6),
    emissive: new THREE.Color(0.1, 0.2, 0.3),
    opacity: 0.9,
    transparent: transparencyMode === 'alphaBlend',
    side: THREE.DoubleSide,
    map,
    alphaMap,
    alphaTest: transparencyMode === 'opaque' ? 0 : 0.01,
    depthWrite: true,
    normalMap,
    normalScale: new THREE.Vector2(0.4, 0.6)
  });
  material.name = 'Face_2+';
  material.emissiveMap = emissiveMap;
  material.userData.mmdMaterial = {
    materialIndex: 7,
    transparencyMode,
    flags: {
      doubleSided: true,
      edge: false,
      groundShadow: true,
      lineDraw: false,
      pointDraw: false,
      selfShadow: true,
      selfShadowMap: true,
      vertexColor: false
    }
  };
  material.userData.mmdMaterialFactors = { shaderApplied: true };
  material.onBeforeCompile = () => {
    throw new Error('SDEF/MMD shader hook must not be copied');
  };
  return { material, map, alphaMap, normalMap, emissiveMap };
}

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

describe('MMD material conversion', () => {
  it('preserves texture, alpha, color, and safe MMD transparency metadata', () => {
    const { material, map, alphaMap, normalMap, emissiveMap } = createMmdToonMaterial('alphaBlend');

    const converted = convertMmdMaterial(material);

    expect(converted).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(converted.name).toBe('Face_2+');
    expect(converted.map).toBe(map);
    expect(converted.alphaMap).toBe(alphaMap);
    expect(converted.normalMap).toBe(normalMap);
    expect(converted.emissiveMap).toBe(emissiveMap);
    expect(converted.color.getHex()).toBe(material.color.getHex());
    expect(converted.emissive.getHex()).toBe(material.emissive.getHex());
    expect(converted.opacity).toBe(0.9);
    expect(converted.transparent).toBe(true);
    expect(converted.side).toBe(THREE.DoubleSide);
    expect(converted.alphaTest).toBe(0.01);
    expect(converted.depthWrite).toBe(true);
    expect(converted.normalScale.toArray()).toEqual([0.4, 0.6]);
    expect(converted.userData.mmdMaterial).toEqual(material.userData.mmdMaterial);
    expect(converted.userData.mmdMaterial).not.toBe(material.userData.mmdMaterial);
    expect(converted.userData.mmdMaterial.flags).not.toBe(material.userData.mmdMaterial.flags);
  });

  it('does not copy MMD shader hooks or material-factor shader state', () => {
    const { material } = createMmdToonMaterial('alphaBlend');

    const converted = convertMmdMaterial(material);

    expect(converted.onBeforeCompile).not.toBe(material.onBeforeCompile);
    expect(converted.userData.mmdMaterialFactors).toBeUndefined();
    expect(converted.userData.mmdSphereShader).toBeUndefined();
    expect(converted.userData.mmdMaterialFactorShader).toBeUndefined();
  });

  it('keeps alphaBlend enabled when runtime material state is synchronized', () => {
    const { material } = createMmdToonMaterial('alphaBlend');
    const converted = convertMmdMaterial(material);

    syncMmdMaterialStates(converted, [runtimeState as any]);

    expect(converted.transparent).toBe(true);
    expect(converted.alphaTest).toBe(0.01);
    expect(converted.visible).toBe(true);
    expect(converted.colorWrite).toBe(true);
  });

  it('injects a transparent-window alpha floor into texture-driven alphaBlend materials', () => {
    // 婚皮 `(袖)袖子本体`：材质本体不透明（diffuse alpha=1），透明完全来自
    // 贴图半透明（Alpha03.png）。转换后必须注入 alpha 下限 shader，否则
    // 透明窗口下纱质袖子直接透出桌面（"手臂透明"）。
    const { material } = createMmdToonMaterial('alphaBlend');
    material.userData.mmdMaterial.diffuse = [1, 1, 1, 1];

    const converted = convertMmdMaterial(material);

    expect(typeof converted.onBeforeCompile).toBe('function');
    const shader = { fragmentShader: '#include <map_fragment>\n' };
    converted.onBeforeCompile(shader as any, undefined as any);
    // 不 discard：蕾丝洞会在动作中透出桌面（2026-08 三轮实测的最终结论）。
    expect(shader.fragmentShader).not.toContain('discard');
    expect(shader.fragmentShader).toContain('diffuseColor.a = 1.00');
    expect(shader.fragmentShader).toContain('#include <map_fragment>');
  });

  it('keeps authored semi-transparent materials free of the alpha floor', () => {
    // 整体半透明材质（PMX diffuse alpha < 1，如 body+）：半透明是作者设定，
    // 不注入 alpha 下限，保持 MMD 原生 alphaBlend 行为。
    const { material } = createMmdToonMaterial('alphaBlend');
    material.userData.mmdMaterial.diffuse = [1, 1, 1, 0.5];

    const converted = convertMmdMaterial(material);
    const shader = { fragmentShader: '#include <map_fragment>\n' };
    converted.onBeforeCompile(shader as any, undefined as any);

    expect(shader.fragmentShader).toBe('#include <map_fragment>\n');
  });

  it('keeps opaque and alphaTest materials free of the alpha floor', () => {
    const opaque = createMmdToonMaterial('opaque');
    opaque.material.userData.mmdMaterial.diffuse = [1, 1, 1, 1];
    const alphaTest = createMmdToonMaterial('alphaTest');
    alphaTest.material.userData.mmdMaterial.diffuse = [1, 1, 1, 1];

    for (const source of [opaque.material, alphaTest.material]) {
      const converted = convertMmdMaterial(source);
      const shader = { fragmentShader: '#include <map_fragment>\n' };
      converted.onBeforeCompile(shader as any, undefined as any);
      expect(shader.fragmentShader).toBe('#include <map_fragment>\n');
    }
  });

  it('replaces every mesh material without changing numeric array order', () => {
    const first = createMmdToonMaterial('opaque').material;
    first.name = 'material-0';
    const second = createMmdToonMaterial('alphaTest').material;
    second.name = 'material-1';
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), [first, second]);

    replaceMmdMaterialsWithStandard(mesh);

    expect(Array.isArray(mesh.material)).toBe(true);
    const materials = mesh.material as THREE.Material[];
    expect(materials).toHaveLength(2);
    expect(materials.map(item => item.name)).toEqual(['material-0', 'material-1']);
    expect(materials.every(item => item instanceof THREE.MeshStandardMaterial)).toBe(true);
  });

  it('disables depth write on invisible colorWrite=false materials after loader sync resets them', () => {
    // 婚皮弯臂透明根因：body+/后发渐变过渡 等隐形材质（colorWrite=false）
    // 每帧被 loader 的 syncMmdMaterialStates 重置为 depthWrite=true，
    // 手臂穿过其覆盖区时被深度遮挡 → 桌面透出。
    // simulate: loader sync writes colorWrite=false + depthWrite=true
    const wall = new THREE.MeshStandardMaterial();
    wall.name = 'body+';
    wall.colorWrite = false;
    wall.depthWrite = true;

    const visible = new THREE.MeshStandardMaterial();
    visible.name = 'body';
    visible.colorWrite = true;
    visible.depthWrite = true;

    const changed = disableInvisibleMaterialDepthWrite([wall, visible]);

    expect(changed).toBe(1);
    expect(wall.depthWrite).toBe(false);
    expect(wall.colorWrite).toBe(false);
    expect(visible.depthWrite).toBe(true);

    // 幂等：重复调用不再修改
    expect(disableInvisibleMaterialDepthWrite([wall, visible])).toBe(0);
  });
});
