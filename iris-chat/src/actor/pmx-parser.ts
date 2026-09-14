// PMX 2.0 二进制解析器（纯 Node.js，不依赖 Three.js/DOM）
// 职责：解析 PMX 文件结构，返回 PmxModelInfo（模型签名、几何统计、骨骼、Morph、纹理）
// Phase 3 Task 3.1：用于模型审计和 Manifest 生成，以及 ActorRuntime 的 morph/bone 映射
//
// 重要约束（selena-model-contract.md）：
// - 模型只读，不得修改/上传/转换/分发
// - 解析器只读取 Buffer，不写入文件
// - SHA-256 必须匹配契约 C8636D99356C51D059B3FC38FFF062123C57D82164A00BBEB76B40674E503DF5
//
// PMX 2.0 格式参考：https://gist.github.com/felixjones/f8a06bd680a925c0dcf1
// 字节序：小端

export interface PmxMorph {
  readonly name: string;       // 日文名
  readonly nameEn: string;     // 英文名
  readonly type: number;       // 0=group,1=vertex,2=bone,3=uv,4=uv1,5=uv2,6=uv3,7=uv4,8=material
  readonly offsetCount: number;
  readonly vertexOffsets?: readonly PmxVertexMorphOffset[]; // 仅 type=1（vertex）morph 填充
}

/**
 * 顶点 morph 偏移（type 1 morph）。
 * vertexIndex：该偏移作用的顶点索引。
 * offsetX/Y/Z：加到该顶点 base position 上的偏移量（PMX 左手系）。
 */
export interface PmxVertexMorphOffset {
  readonly vertexIndex: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly offsetZ: number;
}

export interface PmxBone {
  readonly name: string;
  readonly nameEn: string;
  readonly position: readonly [number, number, number];
  readonly parentBoneIndex: number;
  readonly transformLevel: number;
  readonly flags: number;
}

export interface PmxTexture {
  readonly path: string;
}

export interface PmxMaterial {
  readonly name: string;
  readonly nameEn: string;
  readonly diffuse: readonly [number, number, number, number];
  readonly textureIndex: number;
}

/**
 * 单个材质在全局索引数组中的范围。
 * indexOffset：在 indices 数组中的起始位置（单位：索引数）。
 * indexCount：此材质覆盖的索引数（= 三角形数 * 3）。
 */
export interface PmxMaterialRange {
  readonly materialIndex: number;
  readonly indexOffset: number;
  readonly indexCount: number;
}

/**
 * 几何数据，供 Three.js BufferGeometry 直接使用。
 * positions/normals/uvs 按顶点顺序紧凑排列（无 interleaved）。
 * indices 为面顶点索引序列（每 3 个构成 1 个三角形）。
 */
export interface PmxGeometry {
  readonly positions: Float32Array;   // vertexCount * 3
  readonly normals: Float32Array;     // vertexCount * 3
  readonly uvs: Float32Array;         // vertexCount * 2
  readonly indices: Uint32Array;      // faceVertexCount
  readonly materialRanges: readonly PmxMaterialRange[];
}

export interface PmxRigidBody {
  readonly name: string;
  readonly nameEn: string;
  readonly boneIndex: number;
  readonly mode: number; // 0=static, 1=dynamic, 2=dynamicBone
}

export interface PmxModelInfo {
  readonly magic: string;          // "PMX "
  readonly version: number;        // 2.0
  readonly modelNameJp: string;
  readonly modelNameEn: string;
  readonly commentJp: string;
  readonly commentEn: string;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly textureCount: number;
  readonly materialCount: number;
  readonly boneCount: number;
  readonly morphCount: number;
  readonly morphs: readonly PmxMorph[];
  readonly bones: readonly PmxBone[];
  readonly textures: readonly PmxTexture[];
  readonly materials: readonly PmxMaterial[];
  readonly geometry: PmxGeometry;
  /** Phase 6 物理审计扩展：刚体段与 Joint 段统计。
   *  PMX 2.0 在 morphs 段之后还有 rigidBodies/joints 段，旧版未解析。
   *  这些字段为可选，确保旧调用不受影响。 */
  readonly rigidBodyCount?: number;
  readonly jointCount?: number;
  readonly rigidBodies?: readonly PmxRigidBody[];
}

// 全局头各字段尺寸（globals[0] 编码方式决定字符串读取）
// globals 字节布局（PMX 2.0）：
// 0: textEncoding (0=UTF-16LE, 1=UTF-8)
// 1: additionalVec4Count
// 2: vertexIndexSize (1/2/4)
// 3: textureIndexSize (1/2/4)
// 4: materialIndexSize (1/2/4)
// 5: boneIndexSize (1/2/4)
// 6: morphIndexSize (1/2/4)
// 7: rigidbodyIndexSize (1/2/4)

class PmxReader {
  private offset = 0;
  private readonly view: DataView;
  private readonly decoder: TextDecoder;
  private readonly bytes: Uint8Array;
  readonly textEncoding: 0 | 1;
  readonly additionalVec4Count: number;
  readonly vertexIndexSize: number;
  readonly textureIndexSize: number;
  readonly materialIndexSize: number;
  readonly boneIndexSize: number;
  readonly morphIndexSize: number;
  /** Phase 6 物理审计扩展：rigidbodyIndexSize（globals 头第 8 字节）。 */
  readonly rigidbodyIndexSize: number;

  constructor(buffer: Uint8Array) {
    this.bytes = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    // magic "PMX " (4 bytes) + version (4 bytes float, PMX 2.0 = 2.0)
    this.offset = 8;
    // globals count (1 byte, PMX 2.0 = 8)
    const globalsCount = this.readUint8();
    if (globalsCount !== 8) {
      throw new Error(`Unexpected PMX globals count: ${globalsCount} (expected 8 for PMX 2.0)`);
    }
    this.textEncoding = this.readUint8() as 0 | 1;
    this.decoder = this.textEncoding === 0
      ? new TextDecoder('utf-16le')
      : new TextDecoder('utf-8');
    this.additionalVec4Count = this.readUint8();
    this.vertexIndexSize = this.readUint8();
    this.textureIndexSize = this.readUint8();
    this.materialIndexSize = this.readUint8();
    this.boneIndexSize = this.readUint8();
    this.morphIndexSize = this.readUint8();
    // rigidbodyIndexSize
    this.rigidbodyIndexSize = this.readUint8();
    // 现在位置应在 8 + 1 + 8 = 17
  }

  get currentOffset(): number { return this.offset; }

  readUint8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readUint16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readInt32(): number {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readFloat32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readIndex(size: number): number {
    switch (size) {
      case 1: {
        const v = this.view.getUint8(this.offset);
        this.offset += 1;
        return v;
      }
      case 2: {
        const v = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return v;
      }
      case 4: {
        const v = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return v;
      }
      default:
        throw new Error(`Unsupported index size: ${size}`);
    }
  }

  readText(): string {
    const length = this.readInt32();
    if (length < 0 || length > 65536) {
      throw new Error(`Invalid PMX text length ${length} at offset ${this.offset - 4} (buffer size=${this.bytes.length})`);
    }
    const bytes = new Uint8Array(this.bytes.buffer, this.bytes.byteOffset + this.offset, length);
    this.offset += length;
    return this.decoder.decode(bytes);
  }

  readBytes(count: number): Uint8Array {
    const slice = new Uint8Array(this.bytes.buffer, this.bytes.byteOffset + this.offset, count);
    this.offset += count;
    return slice;
  }

  seek(o: number): void { this.offset = o; }
}

/**
 * 解析 PMX 2.0 二进制数据，返回结构化模型信息。
 * 只读：不修改输入 buffer，不写入文件。
 * 接受 Uint8Array（Buffer 是 Uint8Array 的子类，所以 Node.js readFileSync 返回的 Buffer 也可直接传入）。
 * 不依赖 Node.js Buffer API，可在浏览器/Electron renderer 中使用。
 */
export function parsePmx(buffer: Uint8Array): PmxModelInfo {
  // 校验 magic "PMX "（4 字节 ASCII）
  const magicBytes = buffer.subarray(0, 4);
  let magic = '';
  for (let i = 0; i < 4; i++) {
    magic += String.fromCharCode(magicBytes[i]);
  }
  if (magic !== 'PMX ') {
    throw new Error(`Invalid PMX magic: ${JSON.stringify(magic)}`);
  }
  // 版本：前 4 字节 float（实际只用 major.minor），PMX 2.0 = 0x00 0x00 0x02 0x00 (LE float = 2.0)
  const version = new DataView(buffer.buffer, buffer.byteOffset + 4, 4).getFloat32(0, true);

  const reader = new PmxReader(buffer);

  // 模型名 / 注释
  const modelNameJp = reader.readText();
  const modelNameEn = reader.readText();
  const commentJp = reader.readText();
  const commentEn = reader.readText();

  // 顶点
  const vertexCount = reader.readInt32();
  // 预分配几何数据数组（供渲染器直接使用）
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  // 每顶点：position(12) + normal(12) + uv(8) + additionalVec4 * 16 + weightType(1) + weight + edgeScale(4)
  for (let i = 0; i < vertexCount; i++) {
    // position (3 floats)
    positions[i * 3]     = reader.readFloat32();
    positions[i * 3 + 1] = reader.readFloat32();
    positions[i * 3 + 2] = reader.readFloat32();
    // normal (3 floats)
    normals[i * 3]     = reader.readFloat32();
    normals[i * 3 + 1] = reader.readFloat32();
    normals[i * 3 + 2] = reader.readFloat32();
    // uv (2 floats)
    uvs[i * 2]     = reader.readFloat32();
    uvs[i * 2 + 1] = reader.readFloat32();
    reader.readBytes(reader.additionalVec4Count * 16); // additional UVs
    const weightType = reader.readUint8();
    switch (weightType) {
      case 0: // BDEF1: 1 bone index
        reader.readIndex(reader.boneIndexSize);
        break;
      case 1: // BDEF2: 2 bone indices + 1 float
        reader.readIndex(reader.boneIndexSize);
        reader.readIndex(reader.boneIndexSize);
        reader.readBytes(4);
        break;
      case 2: // BDEF4: 4 bone indices + 4 floats
        reader.readIndex(reader.boneIndexSize);
        reader.readIndex(reader.boneIndexSize);
        reader.readIndex(reader.boneIndexSize);
        reader.readIndex(reader.boneIndexSize);
        reader.readBytes(16);
        break;
      case 3: // SDEF: 2 bone indices + 1 float + 3 vec3 (C, R0, R1)
        reader.readIndex(reader.boneIndexSize);
        reader.readIndex(reader.boneIndexSize);
        reader.readBytes(4);
        reader.readBytes(36);
        break;
      case 4: // QDEF: 4 bone indices + 4 floats
        reader.readIndex(reader.boneIndexSize);
        reader.readIndex(reader.boneIndexSize);
        reader.readIndex(reader.boneIndexSize);
        reader.readIndex(reader.boneIndexSize);
        reader.readBytes(16);
        break;
      default:
        throw new Error(`Unknown weight type: ${weightType}`);
    }
    reader.readBytes(4); // edge scale
  }

  // 面（顶点索引数，每 3 个索引构成 1 个三角形）
  const faceVertexCount = reader.readInt32();
  const triangleCount = faceVertexCount / 3;
  const indices = new Uint32Array(faceVertexCount);
  for (let i = 0; i < faceVertexCount; i++) {
    indices[i] = reader.readIndex(reader.vertexIndexSize);
  }

  // 纹理
  const textureCount = reader.readInt32();
  const textures: PmxTexture[] = [];
  for (let i = 0; i < textureCount; i++) {
    const path = reader.readText();
    textures.push({ path });
  }

  // 材质
  const materialCount = reader.readInt32();
  const materials: PmxMaterial[] = [];
  const materialRanges: PmxMaterialRange[] = [];
  let materialIndexCursor = 0; // 在 indices 数组中的运行游标
  for (let i = 0; i < materialCount; i++) {
    const name = reader.readText();
    const nameEn = reader.readText();
    // diffuse (RGBA = 4 floats)
    const dr = reader.readFloat32();
    const dg = reader.readFloat32();
    const db = reader.readFloat32();
    const da = reader.readFloat32();
    // specular (3 floats) + specular power (1 float)
    reader.readBytes(12);
    reader.readBytes(4);
    // ambient (3 floats)
    reader.readBytes(12);
    // draw flags (1 byte)
    reader.readUint8();
    // edge color (4 floats)
    reader.readBytes(16);
    // edge size (1 float)
    reader.readBytes(4);
    // texture index
    const textureIndex = reader.readIndex(reader.textureIndexSize);
    // sphere texture index
    reader.readIndex(reader.textureIndexSize);
    // sphere mode (1 byte)
    reader.readUint8();
    // shared toon flag (1 byte)
    const toonFlag = reader.readUint8();
    if (toonFlag === 0) {
      // toon texture index
      reader.readIndex(reader.textureIndexSize);
    } else {
      // toon index (1 byte)
      reader.readUint8();
    }
    // memo (text)
    reader.readText();
    // face count：PMX 2.0 实际惯例是"该材质使用的**顶点索引数**"（每三角形 3 个索引），
    // 不是三角形数。参考 three.js MMDLoader 与 mmd-parser 实现。
    const indexCount = reader.readInt32();
    materialRanges.push({
      materialIndex: i,
      indexOffset: materialIndexCursor,
      indexCount
    });
    materialIndexCursor += indexCount;
    materials.push({
      name, nameEn,
      diffuse: [dr, dg, db, da],
      textureIndex
    });
  }

  // 骨骼
  const boneCount = reader.readInt32();
  const bones: PmxBone[] = [];
  for (let i = 0; i < boneCount; i++) {
    const name = reader.readText();
    const nameEn = reader.readText();
    const px = reader.readFloat32();
    const py = reader.readFloat32();
    const pz = reader.readFloat32();
    const parentBoneIndex = reader.readIndex(reader.boneIndexSize);
    const transformLevel = reader.readInt32();
    const flags = reader.readUint16();
    // 后续字段依赖 flags（PMX 2.0 正确位分配，依据 PMXEditor 规范）：
    //   bit 0  (0x0001): indexed tail position (0 = offset vec3, 1 = bone index)
    //   bit 1  (0x0002): rotatable
    //   bit 2  (0x0004): translatable
    //   bit 3  (0x0008): visible
    //   bit 4  (0x0010): enabled
    //   bit 5  (0x0020): IK
    //   bit 8  (0x0100): inherit rotation（旋转+）
    //   bit 9  (0x0200): inherit translation（移动+）
    //   bit 10 (0x0400): fixed axis（轴限制）
    //   bit 11 (0x0800): local axis（Local 轴）
    //   bit 12 (0x1000): physics after deform（仅标志，无数据）
    //   bit 13 (0x2000): external parent（外部亲）
    // 字段读取顺序（标准 PMX 2.0）：
    //   tail → inherit (bit 8|9) → fixed axis (bit 10) → local axis (bit 11) → external parent (bit 13) → IK (bit 5)
    // tail position（offset 12 字节或 bone index）
    if ((flags & 0x0001) === 0) {
      reader.readBytes(12); // tail offset (vec3)
    } else {
      reader.readIndex(reader.boneIndexSize); // tail bone index
    }
    // inherit rotation/translation (bit 8 或 bit 9 触发同一块：bone index + influence)
    if ((flags & 0x0100) !== 0 || (flags & 0x0200) !== 0) {
      reader.readIndex(reader.boneIndexSize);
      reader.readBytes(4); // influence
    }
    // fixed axis (bit 10)
    if ((flags & 0x0400) !== 0) {
      reader.readBytes(12); // axis vec3
    }
    // local axis (bit 11)
    if ((flags & 0x0800) != 0) {
      reader.readBytes(12); // local X
      reader.readBytes(12); // local Z
    }
    // external parent (bit 13)
    if ((flags & 0x2000) != 0) {
      reader.readInt32(); // external parent key
    }
    // IK (bit 5)
    if ((flags & 0x0020) != 0) {
      // IK 数据（PMX 2.0）：
      //   ikBoneIndex (index) + loopCount (int32) + limitRadian (single float32)
      //   + chainLength (int32) + per-chain: boneIndex + angleLimitEnable(1 byte)
      //     if angleLimitEnable: limitMin(vec3, 12) + limitMax(vec3, 12)
      reader.readIndex(reader.boneIndexSize); // ik target
      reader.readInt32(); // loop count
      reader.readFloat32(); // limitRadian (single float, not vec3)
      const chainLength = reader.readInt32();
      for (let c = 0; c < chainLength; c++) {
        reader.readIndex(reader.boneIndexSize); // chain bone
        const angleLimitEnable = reader.readUint8();
        if (angleLimitEnable !== 0) {
          reader.readBytes(12); // limitMin (vec3)
          reader.readBytes(12); // limitMax (vec3)
        }
      }
    }
    bones.push({
      name, nameEn,
      position: [px, py, pz],
      parentBoneIndex,
      transformLevel,
      flags
    });
  }

  // Morph
  const morphCount = reader.readInt32();
  const morphs: PmxMorph[] = [];
  for (let i = 0; i < morphCount; i++) {
    const name = reader.readText();
    const nameEn = reader.readText();
    // offset (1 byte): 操作方式（0=加算等）
    reader.readUint8();
    const type = reader.readUint8();
    const offsetCount = reader.readInt32();
    let vertexOffsets: PmxVertexMorphOffset[] | undefined;
    // 跳过 offset 数据（尺寸依赖 type）
    switch (type) {
      case 0: { // group: morphIndex + float
        for (let j = 0; j < offsetCount; j++) {
          reader.readIndex(reader.morphIndexSize);
          reader.readBytes(4);
        }
        break;
      }
      case 1: { // vertex: vertexIndex + vec3
        // Task 3.3: 捕获顶点偏移数据，供渲染器构建 morphAttributes
        vertexOffsets = [];
        for (let j = 0; j < offsetCount; j++) {
          const vertexIndex = reader.readIndex(reader.vertexIndexSize);
          const offsetX = reader.readFloat32();
          const offsetY = reader.readFloat32();
          const offsetZ = reader.readFloat32();
          vertexOffsets.push({ vertexIndex, offsetX, offsetY, offsetZ });
        }
        break;
      }
      case 2: { // bone morph: boneIndex + position(vec3,12) + rotation(quat,16)
        // PMX 2.0 spec: bone_idx + distance[3] + turning[4] = index + 28 bytes
        for (let j = 0; j < offsetCount; j++) {
          reader.readIndex(reader.boneIndexSize);
          reader.readBytes(12); // position vec3
          reader.readBytes(16); // rotation quaternion
        }
        break;
      }
      case 3: case 4: case 5: case 6: case 7: { // UV / UV1-4: vertexIndex + vec4
        for (let j = 0; j < offsetCount; j++) {
          reader.readIndex(reader.vertexIndexSize);
          reader.readBytes(16);
        }
        break;
      }
      case 8: { // material morph: full material override block
        // PMX 2.0 spec per offset:
        //   materialIndex + offsetType(1) + diffuse(16) + specular(12) + specularPower(4)
        //   + ambient(12) + edgeColor(16) + edgeSize(4) + textureTint(16)
        //   + sphereTint(16) + toonTint(16) = index + 113 bytes
        for (let j = 0; j < offsetCount; j++) {
          reader.readIndex(reader.materialIndexSize);
          reader.readUint8(); // offset type
          reader.readBytes(16); // diffuse (RGBA)
          reader.readBytes(12); // specular (RGB)
          reader.readBytes(4);  // specular power
          reader.readBytes(12); // ambient (RGB)
          reader.readBytes(16); // edge color (RGBA)
          reader.readBytes(4);  // edge size
          reader.readBytes(16); // texture tint (RGBA)
          reader.readBytes(16); // sphere tint (RGBA)
          reader.readBytes(16); // toon tint (RGBA)
        }
        break;
      }
      default:
        throw new Error(`Unknown morph type: ${type}`);
    }
    morphs.push({ name, nameEn, type, offsetCount, vertexOffsets });
  }

  // Phase 6 物理审计扩展：继续读取 rigidBodies 段与 joints 段。
  // 旧 parsePmx 在 morphs 段后直接 return，物理数据被丢弃；此处补齐。
  // PMX 2.0 段顺序：vertices → faces → textures → materials → bones → morphs → rigidBodies → joints
  // 现已读完 morphs 段，reader.currentOffset 应位于 rigidBodies 段起始。
  // 参考: https://gist.github.com/felixjones/f8a06bd680a925c0dcf1
  let rigidBodyCount = 0;
  let jointCount = 0;
  let rigidBodies: PmxRigidBody[] | undefined;
  try {
    rigidBodyCount = reader.readInt32();
    if (rigidBodyCount > 0) {
      rigidBodies = [];
      for (let i = 0; i < rigidBodyCount; i++) {
        const name = reader.readText();
        const nameEn = reader.readText();
        const boneIndex = reader.readIndex(reader.boneIndexSize);
        reader.readUint8();           // collision group
        reader.readUint16();          // collision mask
        const shape = reader.readUint8(); // 0=sphere, 1=box, 2=capsule
        // size 字段依赖 shape：sphere=1 float(4), box=3 floats(12), capsule=2 floats(8)
        if (shape === 0) reader.readBytes(4);
        else if (shape === 1) reader.readBytes(12);
        else if (shape === 2) reader.readBytes(8);
        else reader.readBytes(12);    // fallback（不应触发）
        reader.readBytes(12);          // position (vec3)
        reader.readBytes(12);          // rotation (vec3)
        reader.readFloat32();          // mass
        reader.readFloat32();          // linear damping
        reader.readFloat32();          // angular damping
        reader.readFloat32();          // restitution (bounciness)
        reader.readFloat32();          // friction
        const mode = reader.readUint8(); // 0=static, 1=dynamic, 2=dynamicBone
        rigidBodies.push({ name, nameEn, boneIndex, mode });
      }
    }
    // Joint 段：int32 count + 每条记录（固定布局）
    // PMX 2.0 Joint 字段：
    //   name(text) + name_en(text) + rbA(rigidbodyIndex) + rbB(rigidbodyIndex)
    //   + boneIndex(boneIndexSize, 0xFFFF 表示无) + collision(1 byte)
    //   + pos(vec3,12) + rot(vec3,12)
    //   + pos_min(vec3,12) + pos_max(vec3,12)
    //   + rot_min(vec3,12) + rot_max(vec3,12)
    //   + spring_linear(vec3,12) + spring_angular(vec3,12)
    //   = 1 + 1 + 2*rigidbodyIndexSize + boneIndexSize + 1 + 8*12 bytes
    jointCount = reader.readInt32();
    if (jointCount > 0) {
      for (let i = 0; i < jointCount; i++) {
        reader.readText(); reader.readText();
        reader.readIndex(reader.rigidbodyIndexSize); // rbA
        reader.readIndex(reader.rigidbodyIndexSize); // rbB
        reader.readIndex(reader.boneIndexSize);       // 限制 boneIndex
        reader.readUint8();                           // collision
        reader.readBytes(12);                          // pos vec3
        reader.readBytes(12);                          // rot vec3
        // 8 个 vec3 = 96 bytes（pos_min, pos_max, rot_min, rot_max, spring_linear, spring_angular 各 2 个 vec3, 共 6 个 vec3）
        // PMX spec 实际：pos_min(12) + pos_max(12) + rot_min(12) + rot_max(12) + spring_linear(12) + spring_angular(12) = 6 * 12 = 72 bytes
        reader.readBytes(72);
      }
    }
  } catch (e) {
    // 物理 段解析失败时记录但不抛错，保持兼容
    console.warn('[pmx-parser] rigidBodies/joints 段解析失败（不影响基础解析）:', e instanceof Error ? e.message : e);
  }

  return {
    magic,
    version,
    modelNameJp,
    modelNameEn,
    commentJp,
    commentEn,
    vertexCount,
    triangleCount,
    textureCount,
    materialCount,
    boneCount,
    morphCount,
    morphs,
    bones,
    textures,
    materials,
    geometry: {
      positions,
      normals,
      uvs,
      indices,
      materialRanges
    },
    rigidBodyCount,
    jointCount,
    rigidBodies
  };
}
