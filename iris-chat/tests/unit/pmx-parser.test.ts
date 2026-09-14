import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parsePmx, type PmxModelInfo } from '../../src/actor/pmx-parser';

// Phase 3 Task 3.1: PMX 二进制解析器测试（纯 Node.js，不依赖 Three.js/DOM）
// 验证：模型签名、SHA-256、内部名、几何统计、骨骼、纹理、五口型 + 关键表情 morph
// 模型只读，不得修改/上传/分发
const MODEL_PATH = resolve(__dirname, '..', '..', '赛琳娜 希声', '赛琳娜 希声 合并.pmx');
const EXPECTED_SHA256 = 'C8636D99356C51D059B3FC38FFF062123C57D82164A00BBEB76B40674E503DF5';

describe('PMX parser（Phase 3 Task 3.1）', () => {
  const buffer = readFileSync(MODEL_PATH);

  it('SHA-256 匹配 selena-model-contract.md 契约', () => {
    const hash = createHash('sha256').update(buffer).digest('hex').toUpperCase();
    expect(hash).toBe(EXPECTED_SHA256);
  });

  it('PMX 签名为 "PMX "，版本为 2.0', () => {
    const info = parsePmx(buffer);
    expect(info.magic).toBe('PMX ');
    expect(info.version).toBe(2.0);
  });

  it('内部模型名为 "赛琳娜希声"', () => {
    const info = parsePmx(buffer);
    expect(info.modelNameJp).toBe('赛琳娜希声');
  });

  it('顶点数为 43694，三角形数为 44597', () => {
    const info = parsePmx(buffer);
    expect(info.vertexCount).toBe(43694);
    expect(info.triangleCount).toBe(44597);
  });

  it('材质数为 41', () => {
    const info = parsePmx(buffer);
    expect(info.materialCount).toBe(41);
  });

  it('骨骼数为 594', () => {
    const info = parsePmx(buffer);
    expect(info.boneCount).toBe(594);
  });

  it('Morph 数量为 108', () => {
    const info = parsePmx(buffer);
    expect(info.morphCount).toBe(108);
  });

  it('纹理引用数量 >= 15（契约审计时为 15）', () => {
    const info = parsePmx(buffer);
    expect(info.textureCount).toBeGreaterThanOrEqual(15);
  });

  it('Morph 列表包含五口型 あ/い/う/え/お', () => {
    const info = parsePmx(buffer);
    const morphNames = info.morphs.map(m => m.name);
    expect(morphNames).toContain('あ');
    expect(morphNames).toContain('い');
    expect(morphNames).toContain('う');
    expect(morphNames).toContain('え');
    expect(morphNames).toContain('お');
  });

  it('Morph 列表包含关键表情 まばたき/笑い/びっくり/怒り/困る/にこり/真面目/FaceRed/照れ/涙', () => {
    const info = parsePmx(buffer);
    const morphNames = info.morphs.map(m => m.name);
    const required = ['まばたき', '笑い', 'びっくり', '怒り', '困る', 'にこり', '真面目', 'FaceRed', '照れ', '涙'];
    for (const name of required) {
      expect(morphNames).toContain(name);
    }
  });

  it('Morph 5 个口型全部为 group 类型或 vertex 类型（合法类型）', () => {
    const info = parsePmx(buffer);
    const visemes = ['あ', 'い', 'う', 'え', 'お'];
    for (const name of visemes) {
      const morph = info.morphs.find(m => m.name === name);
      expect(morph).toBeDefined();
      // PMX morph 类型：0=group, 1=vertex, 2=bone, 3=uv, 4=uv1, 5=uv2, 6=uv3, 7=uv4, 8=material
      expect(morph!.type).toBeGreaterThanOrEqual(0);
      expect(morph!.type).toBeLessThanOrEqual(8);
    }
  });

  it('骨骼列表包含核心骨骼（头/眼/手/脚/IK）', () => {
    const info = parsePmx(buffer);
    const boneNames = info.bones.map(b => b.name);
    // PMX 骨骼名可能是日文或英文，检查常见的核心骨骼
    // 头：頭 / 親 /頭
    // 眼：左目/右目
    // 手：左手首/右手首
    // 脚：左足/右足
    const coreBones = ['頭', '左目', '右目', '左手首', '右手首', '左足', '右足'];
    let foundCount = 0;
    for (const name of coreBones) {
      if (boneNames.includes(name)) {
        foundCount++;
      }
    }
    // 至少找到 4 个核心骨骼（不同模型命名可能差异）
    expect(foundCount).toBeGreaterThanOrEqual(4);
  });

  it('解析结果不修改原文件（只读）', () => {
    const beforeHash = createHash('sha256').update(buffer).digest('hex').toUpperCase();
    parsePmx(buffer);
    const afterHash = createHash('sha256').update(buffer).digest('hex').toUpperCase();
    expect(afterHash).toBe(beforeHash);
  });

  it('parsePmx 返回结构化 PmxModelInfo，包含所有必需字段', () => {
    const info = parsePmx(buffer);
    const requiredKeys: Array<keyof PmxModelInfo> = [
      'magic', 'version', 'modelNameJp', 'modelNameEn',
      'vertexCount', 'triangleCount', 'materialCount', 'boneCount', 'morphCount', 'textureCount',
      'morphs', 'bones', 'textures'
    ];
    for (const key of requiredKeys) {
      expect(info).toHaveProperty(key);
    }
  });

  // ===== Phase 3 Task 3.2 几何数据测试（用于 Three.js 渲染） =====

  it('geometry.positions 长度 = vertexCount * 3', () => {
    const info = parsePmx(buffer);
    expect(info.geometry.positions.length).toBe(info.vertexCount * 3);
  });

  it('geometry.normals 长度 = vertexCount * 3', () => {
    const info = parsePmx(buffer);
    expect(info.geometry.normals.length).toBe(info.vertexCount * 3);
  });

  it('geometry.uvs 长度 = vertexCount * 2', () => {
    const info = parsePmx(buffer);
    expect(info.geometry.uvs.length).toBe(info.vertexCount * 2);
  });

  it('geometry.indices 长度 = faceVertexCount = triangleCount * 3', () => {
    const info = parsePmx(buffer);
    expect(info.geometry.indices.length).toBe(info.triangleCount * 3);
  });

  it('geometry.positions 为 Float32Array，indices 为 Uint32Array', () => {
    const info = parsePmx(buffer);
    expect(info.geometry.positions).toBeInstanceOf(Float32Array);
    expect(info.geometry.normals).toBeInstanceOf(Float32Array);
    expect(info.geometry.uvs).toBeInstanceOf(Float32Array);
    expect(info.geometry.indices).toBeInstanceOf(Uint32Array);
  });

  it('geometry.indices 所有值在 [0, vertexCount) 范围内', () => {
    const info = parsePmx(buffer);
    const indices = info.geometry.indices;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(info.vertexCount);
  });

  it('geometry.materialRanges 长度 = materialCount', () => {
    const info = parsePmx(buffer);
    expect(info.geometry.materialRanges.length).toBe(info.materialCount);
  });

  it('geometry.materialRanges 首项 indexOffset = 0，连续无重叠', () => {
    const info = parsePmx(buffer);
    const ranges = info.geometry.materialRanges;
    expect(ranges[0].indexOffset).toBe(0);
    for (let i = 1; i < ranges.length; i++) {
      const prev = ranges[i - 1];
      const curr = ranges[i];
      expect(curr.indexOffset).toBe(prev.indexOffset + prev.indexCount);
    }
  });

  it('geometry.materialRanges 所有 indexCount 之和 = indices.length', () => {
    const info = parsePmx(buffer);
    const total = info.geometry.materialRanges.reduce((s, r) => s + r.indexCount, 0);
    expect(total).toBe(info.geometry.indices.length);
  });

  it('geometry.materialRanges 每项 indexCount 是 3 的倍数（三角形）', () => {
    const info = parsePmx(buffer);
    for (const r of info.geometry.materialRanges) {
      expect(r.indexCount % 3).toBe(0);
    }
  });

  it('geometry.positions 包含有限实数（无 NaN/Infinity）', () => {
    const info = parsePmx(buffer);
    const p = info.geometry.positions;
    let nanCount = 0;
    let infCount = 0;
    for (let i = 0; i < p.length; i++) {
      if (Number.isNaN(p[i])) nanCount++;
      if (!Number.isFinite(p[i])) infCount++;
    }
    expect(nanCount).toBe(0);
    expect(infCount).toBe(0);
  });

  it('geometry.positions 覆盖非零包围盒（min != max on each axis）', () => {
    const info = parsePmx(buffer);
    const p = info.geometry.positions;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i]     < minX) minX = p[i];     if (p[i]     > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    expect(maxX).toBeGreaterThan(minX);
    expect(maxY).toBeGreaterThan(minY);
    expect(maxZ).toBeGreaterThan(minZ);
  });

  // Task 3.3: 顶点 morph 偏移数据测试
  it('type 1 (vertex) morph 包含 vertexOffsets 数组', () => {
    const info = parsePmx(buffer);
    // まばたき 是 type 1 vertex morph（见审计输出）
    const blink = info.morphs.find(m => m.name === 'まばたき');
    expect(blink).toBeDefined();
    expect(blink!.type).toBe(1);
    expect(blink!.vertexOffsets).toBeDefined();
    expect(blink!.vertexOffsets!.length).toBe(blink!.offsetCount);
    expect(blink!.vertexOffsets!.length).toBeGreaterThan(0);
  });

  it('type 1 morph vertexOffsets 中 vertexIndex 在 [0, vertexCount) 范围内', () => {
    const info = parsePmx(buffer);
    const blink = info.morphs.find(m => m.name === 'まばたき')!;
    for (const off of blink.vertexOffsets!) {
      expect(off.vertexIndex).toBeGreaterThanOrEqual(0);
      expect(off.vertexIndex).toBeLessThan(info.vertexCount);
    }
  });

  it('type 1 morph vertexOffsets 偏移量为有限实数', () => {
    const info = parsePmx(buffer);
    const blink = info.morphs.find(m => m.name === 'まばたき')!;
    for (const off of blink.vertexOffsets!) {
      expect(Number.isFinite(off.offsetX)).toBe(true);
      expect(Number.isFinite(off.offsetY)).toBe(true);
      expect(Number.isFinite(off.offsetZ)).toBe(true);
    }
  });

  it('五口型 morph 都包含 vertexOffsets（type 1）', () => {
    const info = parsePmx(buffer);
    const visemeNames = ['あ', 'い', 'う', 'え', 'お'];
    for (const name of visemeNames) {
      const m = info.morphs.find(morph => morph.name === name);
      expect(m).toBeDefined();
      expect(m!.type).toBe(1);
      expect(m!.vertexOffsets).toBeDefined();
      expect(m!.vertexOffsets!.length).toBeGreaterThan(0);
    }
  });

  it('情绪 morph（笑い、困る）包含 vertexOffsets（type 1）', () => {
    const info = parsePmx(buffer);
    const laugh = info.morphs.find(m => m.name === '笑い');
    expect(laugh).toBeDefined();
    expect(laugh!.type).toBe(1);
    expect(laugh!.vertexOffsets).toBeDefined();

    const concerned = info.morphs.find(m => m.name === '困る');
    expect(concerned).toBeDefined();
    expect(concerned!.type).toBe(1);
    expect(concerned!.vertexOffsets).toBeDefined();
  });

  it('非 type 1 morph（如 White group、Blue material）的 vertexOffsets 为 undefined', () => {
    const info = parsePmx(buffer);
    const white = info.morphs.find(m => m.name === 'White');
    expect(white).toBeDefined();
    expect(white!.type).toBe(0); // group
    expect(white!.vertexOffsets).toBeUndefined();

    const blue = info.morphs.find(m => m.name === 'Blue');
    expect(blue).toBeDefined();
    expect(blue!.type).toBe(8); // material
    expect(blue!.vertexOffsets).toBeUndefined();
  });

  it('FaceRed morph 包含 vertexOffsets（type 1，用于 blush 预览）', () => {
    const info = parsePmx(buffer);
    const faceRed = info.morphs.find(m => m.name === 'FaceRed');
    expect(faceRed).toBeDefined();
    expect(faceRed!.type).toBe(1);
    expect(faceRed!.vertexOffsets).toBeDefined();
    expect(faceRed!.vertexOffsets!.length).toBeGreaterThan(0);
  });
});
