import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ActorRuntime, type AvatarManifest } from '../../src/actor/actor-runtime';
import {
  createAvatarMorphControl,
  createMeshMorphSink
} from '../../src/actor/three-morph-bridge';
import manifestJson from '../../src/actor/selena/avatar-manifest.json';

const manifest = manifestJson as AvatarManifest;

function createRealMorphMesh(): THREE.SkinnedMesh {
  const mesh = new THREE.SkinnedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial()
  );
  mesh.morphTargetDictionary = {
    '怒り': 0,
    '笑い': 1,
    '照れ': 2,
    'FaceRed': 3,
    'あ': 4
  };
  mesh.morphTargetInfluences = [0, 0, 0, 0, 0];
  return mesh;
}

describe('Three morph bridge（Task 2）', () => {
  it('ActorRuntime.setEmotion 写入真实 mesh influences', () => {
    const mesh = createRealMorphMesh();
    const actor = new ActorRuntime(
      manifest,
      Object.keys(mesh.morphTargetDictionary ?? {})
    );
    actor.bindMorphSink(createMeshMorphSink(mesh, () => undefined));
    actor.markLoaded();

    actor.setEmotion('angry');

    // 怒り 在 dictionary 中是 index 0
    expect(mesh.morphTargetInfluences?.[0]).toBe(1);
  });

  it('面板 API 经过 MorphController 限制 FaceRed 到 0.35', () => {
    const mesh = createRealMorphMesh();
    const actor = new ActorRuntime(
      manifest,
      Object.keys(mesh.morphTargetDictionary ?? {})
    );
    actor.bindMorphSink(createMeshMorphSink(mesh, () => undefined));
    actor.markLoaded();
    const api = createAvatarMorphControl(actor, mesh);

    expect(api.setWeight('FaceRed', 1)).toBe(true);
    expect(api.getWeight('FaceRed')).toBe(0.35);
    expect(api.getRenderedWeight('FaceRed')).toBe(0.35);
  });

  it('getRenderedWeight 对未知 morph 返回 -1', () => {
    const mesh = createRealMorphMesh();
    const actor = new ActorRuntime(
      manifest,
      Object.keys(mesh.morphTargetDictionary ?? {})
    );
    actor.bindMorphSink(createMeshMorphSink(mesh, () => undefined));
    actor.markLoaded();
    const api = createAvatarMorphControl(actor, mesh);

    expect(api.getRenderedWeight('不存在')).toBe(-1);
  });

  it('setWeight 对未知 morph 返回 false 且不抛错', () => {
    const mesh = createRealMorphMesh();
    const actor = new ActorRuntime(
      manifest,
      Object.keys(mesh.morphTargetDictionary ?? {})
    );
    actor.bindMorphSink(createMeshMorphSink(mesh, () => undefined));
    actor.markLoaded();
    const api = createAvatarMorphControl(actor, mesh);

    expect(api.setWeight('未知 morph', 0.5)).toBe(false);
  });

  it('reset 通过 MorphController 同步清零真实 mesh', () => {
    const mesh = createRealMorphMesh();
    const actor = new ActorRuntime(
      manifest,
      Object.keys(mesh.morphTargetDictionary ?? {})
    );
    actor.bindMorphSink(createMeshMorphSink(mesh, () => undefined));
    actor.markLoaded();
    const api = createAvatarMorphControl(actor, mesh);

    api.setWeight('FaceRed', 0.2);
    expect(api.getRenderedWeight('FaceRed')).toBe(0.2);

    api.reset();
    expect(api.getRenderedWeight('FaceRed')).toBe(0);
    expect(api.getRenderedWeight('怒り')).toBe(0);
  });

  it('shy 切换到 angry 时真实 mesh 的照れ和 FaceRed 都清零', () => {
    const mesh = createRealMorphMesh();
    const actor = new ActorRuntime(
      manifest,
      Object.keys(mesh.morphTargetDictionary ?? {})
    );
    actor.bindMorphSink(createMeshMorphSink(mesh, () => undefined));
    actor.markLoaded();
    const api = createAvatarMorphControl(actor, mesh);

    actor.setEmotion('shy');
    expect(api.getRenderedWeight('照れ')).toBe(1);
    expect(api.getRenderedWeight('FaceRed')).toBeCloseTo(0.15, 6);

    actor.setEmotion('angry');
    expect(api.getRenderedWeight('照れ')).toBe(0);
    expect(api.getRenderedWeight('FaceRed')).toBe(0);
    expect(api.getRenderedWeight('怒り')).toBe(1);
  });

  it('createMeshMorphSink 对无 morph 的 mesh 抛错', () => {
    const mesh = new THREE.SkinnedMesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial()
    );
    // 不设置 morphTargetDictionary 和 morphTargetInfluences
    expect(() => createMeshMorphSink(mesh, () => undefined)).toThrow(/morph targets/);
  });

  it('getAvailableMorphs 返回 MorphController 的 knownMorphs', () => {
    const mesh = createRealMorphMesh();
    const actor = new ActorRuntime(
      manifest,
      Object.keys(mesh.morphTargetDictionary ?? {})
    );
    actor.bindMorphSink(createMeshMorphSink(mesh, () => undefined));
    actor.markLoaded();
    const api = createAvatarMorphControl(actor, mesh);

    const available = api.getAvailableMorphs();
    expect(available).toContain('怒り');
    expect(available).toContain('笑い');
    expect(available).toContain('照れ');
    expect(available).toContain('FaceRed');
  });
});
