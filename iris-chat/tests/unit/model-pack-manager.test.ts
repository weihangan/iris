import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelPackManager } from '../../src/model-pack/model-pack-manager';
import { resolveModelMotionTuning } from '../../src/model-pack/model-pack-types';
import { PROTECTED_HEAD_VOICE_ACTIONS } from '../../src/performance/protected-head-voice-actions';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

function makeManager(options: { tombstoneProtected?: boolean } = {}) {
  const root = join(tmpdir(), `chatx2-protected-head-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const builtinRoot = join(root, 'models');
  const userRoot = join(root, 'user-models');
  const dataRoot = join(root, 'user-data');
  const voiceActionsPath = join(dataRoot, 'voice-actions.json');
  const motionDeletionsPath = join(dataRoot, 'motion-deletions.json');
  mkdirSync(dirname(voiceActionsPath), { recursive: true });
  mkdirSync(builtinRoot, { recursive: true });
  mkdirSync(userRoot, { recursive: true });
  writeFileSync(voiceActionsPath, JSON.stringify({
    schemaVersion: 1,
    description: 'user-owned',
    entries: [{
      ...PROTECTED_HEAD_VOICE_ACTIONS[0],
      displayName: 'stale duplicate',
      protected: false
    }]
  }, null, 2), 'utf8');
  writeFileSync(motionDeletionsPath, JSON.stringify({
    schemaVersion: 1,
    paths: options.tombstoneProtected ? [PROTECTED_HEAD_VOICE_ACTIONS[1].vmdPath] : []
  }, null, 2), 'utf8');
  return {
    root,
    voiceActionsPath,
    motionDeletionsPath,
    overridesPath: join(dataRoot, 'protected-voice-action-overrides.json'),
    manager: new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: userRoot,
      voiceActionsPath,
      motionDeletionsPath
    })
  };
}

describe('per-model motion tuning', () => {
  it('falls back to global defaults when the manifest has no motionTuning', () => {
    expect(resolveModelMotionTuning(undefined)).toEqual({
      idleFadeInSeconds: 1.0,
      idleFadeOutSeconds: 1.0,
      actionFadeInSeconds: 0.35,
      actionFadeOutSeconds: 0.55
    });
    expect(resolveModelMotionTuning(null)).toEqual(resolveModelMotionTuning(undefined));
    expect(resolveModelMotionTuning({})).toEqual(resolveModelMotionTuning(undefined));
  });

  it('keeps authored per-model fade values within the safe range', () => {
    expect(resolveModelMotionTuning({
      idleFadeInSeconds: 1.5,
      idleFadeOutSeconds: 1.5,
      actionFadeInSeconds: 0.55,
      actionFadeOutSeconds: 0.85
    })).toEqual({
      idleFadeInSeconds: 1.5,
      idleFadeOutSeconds: 1.5,
      actionFadeInSeconds: 0.55,
      actionFadeOutSeconds: 0.85
    });
    // 越界值被钳制回安全范围，而不是被拒绝
    const clamped = resolveModelMotionTuning({
      idleFadeInSeconds: 99,
      idleFadeOutSeconds: 0.01,
      actionFadeInSeconds: -5,
      actionFadeOutSeconds: Number.NaN
    });
    expect(clamped.idleFadeInSeconds).toBe(3.0);
    expect(clamped.idleFadeOutSeconds).toBe(0.2);
    expect(clamped.actionFadeInSeconds).toBe(0.2);
    expect(clamped.actionFadeOutSeconds).toBe(0.55);
  });
});

describe('ModelPackManager protected head-only voice actions', () => {
  it('merges all three canonical entries despite duplicate user data and tombstones', () => {
    const { manager } = makeManager({ tombstoneProtected: true });

    const loaded = manager.loadSharedVoiceActions();

    expect(loaded.filter(entry => entry.protected)).toHaveLength(3);
    expect(loaded.map(entry => entry.headOverlayId)).toEqual([
      'curious-left-tilt',
      'concerned-down',
      'remember-inward-up'
    ]);
  });

  it('rejects every protected deletion path without changing catalog or tombstones', () => {
    const { manager, voiceActionsPath, motionDeletionsPath } = makeManager();
    const beforeVoice = hash(voiceActionsPath);
    const beforeTombstones = hash(motionDeletionsPath);
    const path = PROTECTED_HEAD_VOICE_ACTIONS[0].vmdPath;

    expect(manager.removeVoiceAction(path)).toBe(false);
    expect(manager.removeVoiceActionReference(path)).toBe(false);
    expect(manager.removeLibraryVmd(path)).toMatchObject({
      success: false,
      reason: 'protected-voice-action'
    });
    expect(hash(voiceActionsPath)).toBe(beforeVoice);
    expect(hash(motionDeletionsPath)).toBe(beforeTombstones);
  });

  it('persists only bounded protected preferences beside the catalog', () => {
    const { manager, voiceActionsPath, overridesPath } = makeManager();
    const beforeVoice = hash(voiceActionsPath);
    const path = PROTECTED_HEAD_VOICE_ACTIONS[2].vmdPath;

    expect(manager.updateVoiceAction(path, {
      starred: true,
      dialogueSafe: false,
      headTuning: { rotationScale: 5 }
    })).toBe(true);
    expect(hash(voiceActionsPath)).toBe(beforeVoice);
    expect(JSON.parse(readFileSync(overridesPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      overrides: {
        [path]: {
          starred: true,
          dialogueSafe: false,
          headTuning: { rotationScale: 1.2 }
        }
      }
    });
    expect(manager.loadSharedVoiceActions().find(entry => entry.vmdPath === path)).toMatchObject({
      starred: true,
      dialogueSafe: false,
      headTuning: { rotationScale: 1.2 }
    });
  });

  it('rejects protected identity edits and leaves both files untouched', () => {
    const { manager, voiceActionsPath, overridesPath } = makeManager();
    const beforeVoice = hash(voiceActionsPath);

    expect(manager.updateVoiceAction(PROTECTED_HEAD_VOICE_ACTIONS[0].vmdPath, {
      displayName: '伪装成普通动作'
    })).toBe(false);
    expect(hash(voiceActionsPath)).toBe(beforeVoice);
    expect(() => readFileSync(overridesPath)).toThrow();
  });
});

describe('ModelPackManager character avatar settings', () => {
  it('preserves character lighting when the selected model is persisted', () => {
    const root = join(tmpdir(), `chatx2-character-lighting-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const builtinRoot = join(root, 'models');
    const dataRoot = join(root, 'user-data');
    const packDir = join(builtinRoot, 'shared-pack');
    const characterDir = join(dataRoot, 'characters', 'A');
    mkdirSync(packDir, { recursive: true });
    mkdirSync(characterDir, { recursive: true });
    const pmxPath = join(packDir, 'avatar.pmx');
    writeFileSync(pmxPath, Buffer.from('pmx-lighting-test'), 'utf8');
    writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      packId: 'shared-pack',
      displayName: 'Shared',
      internalName: 'shared',
      capabilities: [],
      model: { pmxFile: 'avatar.pmx', sha256: hash(pmxPath) },
      motions: { idlePacks: [], gesturePacks: [], defaultIdle: '', customVmd: [], longActionVmd: [], idleVmdPool: [] }
    }), 'utf8');
    const lighting = {
      currentPreset: 'night-mood',
      dynamic: { keyIntensity: 1.7, keyX: -2, keyY: 4, keyZ: 3 }
    };
    writeFileSync(join(characterDir, 'avatar_settings.json'), JSON.stringify({
      schemaVersion: 1,
      lighting,
      customFutureField: { keep: true }
    }, null, 2), 'utf8');
    const manager = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(root, 'user-models'),
      settingsPath: join(dataRoot, 'model-settings.json'),
      characterSettingsRoot: join(dataRoot, 'characters')
    });

    manager.setActiveCharacterId('A');
    expect(manager.switchModel('shared-pack').success).toBe(true);

    const saved = JSON.parse(readFileSync(join(characterDir, 'avatar_settings.json'), 'utf8'));
    expect(saved.modelPackId).toBe('shared-pack');
    expect(saved.lighting).toEqual(lighting);
    expect(saved.customFutureField).toEqual({ keep: true });
  });

  it('derives a compatible common profile from imported Selena morph and bone names', () => {
    const root = join(tmpdir(), `chatx2-common-profile-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const builtinRoot = join(root, 'models');
    const userRoot = join(root, 'user-models');
    mkdirSync(join(builtinRoot, 'selena-xisheng'), { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    const reference = {
      schemaVersion: 1, packId: 'selena-xisheng-v1', displayName: 'Selena', internalName: 'selena', createdAt: '',
      model: { pmxFile: 'x.pmx', sha256: '', pmxVersion: 2, geometry: { vertices: 0, triangles: 0, materials: 0, bones: 0, morphs: 0, textures: 0 }, credit: '', licenseStatus: '' },
      textures: [],
      morphs: { visemes: { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お' }, blink: 'まばたき', emotions: { neutral: '', serious: '真面目', happy: '笑い', smile: 'にこり', surprised: 'びっくり', angry: '怒り', concerned: '困る' }, blush: { name: '照れ', safeRange: { min: 0, max: 1 } }, shy: '照れ', tears: '涙' },
      bones: { root: '全ての親', center: 'センター', head: '頭', neck: '首', bothEyes: '両目', leftEye: '左目', rightEye: '右目', upperBody: '上半身', lowerBody: '下半身', waist: '腰', leftShoulder: '左肩', rightShoulder: '右肩', leftArm: '左腕', rightArm: '右腕', leftElbow: '左ひじ', rightElbow: '右ひじ', leftHand: '左手首', rightHand: '右手首', leftLeg: '左足', rightLeg: '右足', leftKnee: '左ひざ', rightKnee: '右ひざ', leftFoot: '左足首', rightFoot: '右足首', leftFootIK: '左足ＩＫ', rightFootIK: '右足ＩＫ', leftToeIK: '左つま先ＩＫ', rightToeIK: '右つま先ＩＫ' },
      materialCompatibility: { rules: [] }, motions: { idlePacks: [], gesturePacks: [], defaultIdle: '', customVmd: [], longActionVmd: [], idleVmdPool: [] }, capabilities: []
    };
    const manifestPath = join(builtinRoot, 'selena-xisheng', 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(reference), 'utf8');
    const manager = new ModelPackManager({ builtinPacksRoot: builtinRoot, userPacksRoot: userRoot });
    const profile = manager.deriveCommonMmdProfileForTest(
      ['あ', 'い', 'う', 'え', 'お', 'まばたき', '笑い', '真面目', 'にこり', 'びっくり', '怒り', '困る', '照れ', '涙'],
      ['全ての親', 'センター', '頭', '首', '両目', '左目', '右目', '上半身', '下半身', '腰', '左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首', '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首', '左足ＩＫ', '右足ＩＫ', '左つま先ＩＫ', '右つま先ＩＫ']
    );
    expect(profile.capabilities).toEqual(expect.arrayContaining(['visemes', 'blink', 'emotions']));
    expect(profile.bones.root).toBe('全ての親');
    expect(profile.morphs.visemes.a).toBe('あ');
  });
  it('isolates idle pools for characters sharing one model pack', () => {
    const root = join(tmpdir(), `chatx2-character-settings-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const builtinRoot = join(root, 'models');
    const dataRoot = join(root, 'user-data');
    const packDir = join(builtinRoot, 'shared-pack');
    mkdirSync(packDir, { recursive: true });
    const pmxPath = join(packDir, 'avatar.pmx');
    writeFileSync(pmxPath, Buffer.from('pmx-test'), 'utf8');
    writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      packId: 'shared-pack',
      displayName: 'Shared',
      internalName: 'shared',
      capabilities: [],
      model: { pmxFile: 'avatar.pmx', sha256: hash(pmxPath) },
      motions: {
        idlePacks: [], gesturePacks: [], defaultIdle: 'a.vmd',
        customVmd: ['a.vmd', 'b.vmd'], longActionVmd: [], idleVmdPool: []
      }
    }, null, 2), 'utf8');
    const manager = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(root, 'user-models'),
      settingsPath: join(dataRoot, 'model-settings.json'),
      characterSettingsRoot: join(dataRoot, 'characters')
    });

    manager.setActiveCharacterId('A');
    expect(manager.switchModel('shared-pack').success).toBe(true);
    expect(manager.toggleIdleVmd('shared-pack', 'a.vmd', true)).toBe(true);
    expect(manager.toggleMotionPack('shared-pack', 'shared-gesture', true, 'gesture')).toBe(true);
    expect(JSON.parse(readFileSync(join(dataRoot, 'characters', 'A', 'avatar_settings.json'), 'utf8')).motion.idleVmdPool)
      .toEqual(['a.vmd']);

    manager.setActiveCharacterId('B');
    expect(manager.switchModel('shared-pack').success).toBe(true);
    expect(manager.getCurrentPack()?.manifest.motions.idleVmdPool).toEqual([]);
    expect(manager.getCurrentPack()?.manifest.motions.gesturePacks).toEqual(['shared-gesture']);
    expect(manager.toggleIdleVmd('shared-pack', 'b.vmd', true)).toBe(true);

    manager.setActiveCharacterId('A');
    expect(manager.switchModel('shared-pack').success).toBe(true);
    expect(manager.getCurrentPack()?.manifest.motions.idleVmdPool).toEqual(['a.vmd']);
  });

  it('discovers a loose PMX folder by creating a minimal manifest', () => {
    const root = join(tmpdir(), `chatx2-loose-model-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const builtinRoot = join(root, 'models');
    const looseDir = join(root, 'user-data', 'models', 'MyModel');
    mkdirSync(looseDir, { recursive: true });
    writeFileSync(join(looseDir, 'MyModel.pmx'), Buffer.from('pmx-loose'), 'utf8');
    const manager = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(root, 'user-data', 'models'),
      settingsPath: join(root, 'user-data', 'model-settings.json')
    });
    const packs = manager.discoverPacks();
    expect(packs).toHaveLength(1);
    expect(packs[0].displayName).toBe('MyModel');
    expect(manager.switchModel(packs[0].packId).success).toBe(true);
  });

  it('skips non-model resource folders and registers every PMX variant', () => {
    const root = join(tmpdir(), `chatx2-builtin-folders-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const builtinRoot = join(root, 'models');
    const userRoot = join(root, 'user-data', 'models');
    mkdirSync(join(builtinRoot, 'shared', 'motions'), { recursive: true });
    mkdirSync(join(builtinRoot, 'vmd+'), { recursive: true });
    mkdirSync(join(builtinRoot, '千面AI_samples'), { recursive: true });
    const variants = join(builtinRoot, 'downloaded-model');
    mkdirSync(variants, { recursive: true });
    writeFileSync(join(variants, 'normal.pmx'), Buffer.from('pmx-normal'), 'utf8');
    writeFileSync(join(variants, 'transform.pmx'), Buffer.from('pmx-transform'), 'utf8');
    writeFileSync(join(builtinRoot, 'vmd+','动作.vmd'), Buffer.from('Vocaloid Motion Data 0002'), 'utf8');

    const manager = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: userRoot
    });
    const packs = manager.discoverPacks();
    expect(packs).toHaveLength(2);
    expect(packs.map(pack => pack.displayName).sort()).toEqual([
      expect.stringContaining('downloaded-model'),
      expect.stringContaining('downloaded-model')
    ]);
    expect(packs.every(pack => manager.switchModel(pack.packId).success)).toBe(true);
  });

  it('deduplicates the same PMX imported from different source folders', () => {
    const root = join(tmpdir(), `chatx2-import-dedupe-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const builtinRoot = join(root, 'models');
    const userRoot = join(root, 'user-data', 'models');
    const sourceA = join(root, 'download-a');
    const sourceB = join(root, 'download-b');
    mkdirSync(builtinRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(sourceA, { recursive: true });
    mkdirSync(sourceB, { recursive: true });
    const bytes = Buffer.from('same-pmx-content');
    writeFileSync(join(sourceA, 'model-a.pmx'), bytes);
    writeFileSync(join(sourceB, 'model-b.pmx'), bytes);
    const manager = new ModelPackManager({ builtinPacksRoot: builtinRoot, userPacksRoot: userRoot });

    const first = manager.importExternalModel(join(sourceA, 'model-a.pmx'));
    const second = manager.importExternalModel(join(sourceB, 'model-b.pmx'));
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.packId).toBe(first.packId);
    expect(manager.discoverPacks().filter(pack => pack.packId === first.packId)).toHaveLength(1);
  });

  it('keeps multiple PMX variants in one source folder as separate clean packs', () => {
    const root = join(tmpdir(), `chatx2-import-variants-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const builtinRoot = join(root, 'models');
    const userRoot = join(root, 'user-data', 'models');
    const sourceDir = join(root, 'downloaded-model');
    mkdirSync(builtinRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'normal.pmx'), Buffer.from('normal-variant'));
    writeFileSync(join(sourceDir, 'transform.pmx'), Buffer.from('transform-variant'));
    const manager = new ModelPackManager({ builtinPacksRoot: builtinRoot, userPacksRoot: userRoot });

    const normal = manager.importExternalModel(join(sourceDir, 'normal.pmx'));
    const transform = manager.importExternalModel(join(sourceDir, 'transform.pmx'));
    expect(normal.packId).not.toBe(transform.packId);
    for (const result of [normal, transform]) {
      const pmxFiles = readdirSync(join(userRoot, 'imported', String(result.packId)))
        .filter(name => name.toLowerCase().endsWith('.pmx'));
      expect(pmxFiles).toHaveLength(1);
    }
  });
});
