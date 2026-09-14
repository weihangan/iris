import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelPackManager } from '../../src/model-pack/model-pack-manager';

const tempRoots: string[] = [];

function createFixture(): {
  manager: ModelPackManager;
  builtinRoot: string;
  packDir: string;
  sharedDir: string;
  voiceActionsPath: string;
  outsidePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'chatx2-vmd-resolution-'));
  tempRoots.push(root);
  const builtinRoot = join(root, 'models');
  const userRoot = join(root, 'user-models');
  const packDir = join(builtinRoot, 'fixture-pack');
  const sharedDir = join(builtinRoot, 'shared', 'motions');
  const voiceActionsPath = join(builtinRoot, 'shared', 'voice-actions.json');
  mkdirSync(join(packDir, 'motions'), { recursive: true });
  mkdirSync(sharedDir, { recursive: true });
  mkdirSync(userRoot, { recursive: true });

  const pmxBytes = Buffer.from('read-only-test-pmx');
  writeFileSync(join(packDir, 'model.pmx'), pmxBytes);
  const sha256 = createHash('sha256').update(pmxBytes).digest('hex').toUpperCase();
  writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    packId: 'fixture-pack',
    displayName: 'Fixture',
    internalName: 'Fixture',
    createdAt: '2026-07-27T00:00:00.000Z',
    model: {
      pmxFile: 'model.pmx', sha256, pmxVersion: 2.1,
      geometry: { vertices: 0, triangles: 0, materials: 0, bones: 0, morphs: 0, textures: 0 },
      credit: '', licenseStatus: 'test'
    },
    textures: [], morphs: {}, bones: {}, materialCompatibility: { rules: [] },
    motions: {
      idlePacks: [], gesturePacks: [], defaultIdle: '',
      customVmd: [
        'motions/local.vmd', 'motions/shared.vmd', 'motions/idle-3.vmd',
        'motions/idle-4.vmd', 'motions/idle-5.vmd'
      ],
      longActionVmd: []
    },
    capabilities: []
  }), 'utf8');
  writeFileSync(voiceActionsPath, JSON.stringify({
    schemaVersion: 1, description: 'test voice actions', entries: []
  }), 'utf8');

  const manager = new ModelPackManager({
    builtinPacksRoot: builtinRoot,
    userPacksRoot: userRoot,
    sharedMotionsRoot: sharedDir,
    voiceActionsPath
  });
  expect(manager.switchModel('fixture-pack').success).toBe(true);

  const outsidePath = join(root, 'outside.vmd');
  writeFileSync(outsidePath, 'outside');
  return { manager, builtinRoot, packDir, sharedDir, voiceActionsPath, outsidePath };
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('ModelPackManager.resolveCustomVmdPath', () => {
  it('does not rewrite model settings when the selected pack is unchanged', () => {
    const { builtinRoot, sharedDir, voiceActionsPath } = createFixture();
    const root = dirname(builtinRoot);
    const settingsPath = join(root, 'model-settings.json');
    const persisted = JSON.stringify({
      lastPackId: 'fixture-pack',
      updatedAt: '2026-08-08T00:00:00.000Z'
    }, null, 2);
    writeFileSync(settingsPath, persisted, 'utf8');
    const restored = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(root, 'user-models'),
      sharedMotionsRoot: sharedDir,
      voiceActionsPath,
      settingsPath
    });

    expect(restored.switchModel('fixture-pack').success).toBe(true);
    expect(readFileSync(settingsPath, 'utf8')).toBe(persisted);
  });

  it('persists the user default idle outside the packaged manifest and restores it after a refresh', () => {
    const { builtinRoot, packDir, sharedDir, voiceActionsPath } = createFixture();
    const root = dirname(builtinRoot);
    const settingsPath = join(root, 'user-data', 'model-settings.json');
    const manifestPath = join(packDir, 'manifest.json');
    const packagedManifest = readFileSync(manifestPath, 'utf8');
    const manager = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(root, 'user-models'),
      sharedMotionsRoot: sharedDir,
      voiceActionsPath,
      settingsPath
    });
    expect(manager.switchModel('fixture-pack').success).toBe(true);

    expect(manager.setDefaultIdle('fixture-pack', 'motions/local.vmd')).toBe(true);
    expect(readFileSync(manifestPath, 'utf8')).toBe(packagedManifest);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).motionSettingsByPack['fixture-pack'].defaultIdle)
      .toBe('motions/local.vmd');

    writeFileSync(manifestPath, packagedManifest, 'utf8');
    const restarted = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(root, 'user-models'),
      sharedMotionsRoot: sharedDir,
      voiceActionsPath,
      settingsPath
    });
    expect(restarted.switchModel('fixture-pack').success).toBe(true);
    expect(restarted.getCurrentPack()?.manifest.motions.defaultIdle).toBe('motions/local.vmd');
  });

  it('prefers an existing pack-local motion', () => {
    const { manager, packDir } = createFixture();
    const local = join(packDir, 'motions', 'local.vmd');
    writeFileSync(local, 'local');

    expect(manager.resolveCustomVmdPath('fixture-pack', 'motions/local.vmd')).toBe(local);
  });

  it('falls back to a shared motion with the same basename', () => {
    const { manager, sharedDir } = createFixture();
    const shared = join(sharedDir, 'shared.vmd');
    writeFileSync(shared, 'shared');

    expect(manager.resolveCustomVmdPath('fixture-pack', 'motions/shared.vmd')).toBe(shared);
  });

  it('accepts the manifest canonical ../shared/motions form', () => {
    const { manager, sharedDir } = createFixture();
    const shared = join(sharedDir, 'shared.vmd');
    writeFileSync(shared, 'shared');

    expect(manager.resolveCustomVmdPath('fixture-pack', '../shared/motions/shared.vmd')).toBe(shared);
  });

  it('accepts a canonical sibling model motions path used by the shared dual-model catalog', () => {
    const { manager, builtinRoot } = createFixture();
    const siblingMotionDir = join(builtinRoot, 'sibling-pack', 'motions');
    mkdirSync(siblingMotionDir, { recursive: true });
    const siblingMotion = join(siblingMotionDir, 'shared-pose.vmd');
    writeFileSync(siblingMotion, 'sibling');

    expect(manager.resolveCustomVmdPath('fixture-pack', '../sibling-pack/motions/shared-pose.vmd')).toBe(siblingMotion);
  });

  it('resolves a shared catalog sibling path for an imported pack nested under user models', () => {
    const { builtinRoot, sharedDir, voiceActionsPath } = createFixture();
    const root = dirname(builtinRoot);
    const siblingMotionDir = join(builtinRoot, 'selena-xisheng', 'motions');
    mkdirSync(siblingMotionDir, { recursive: true });
    const siblingMotion = join(siblingMotionDir, 'speech.vmd');
    writeFileSync(siblingMotion, 'builtin-sibling');

    const userRoot = join(root, 'user-models');
    const importedDir = join(userRoot, 'imported-model');
    mkdirSync(join(importedDir, 'motions'), { recursive: true });
    const pmxBytes = Buffer.from('imported-pmx');
    writeFileSync(join(importedDir, 'model.pmx'), pmxBytes);
    writeFileSync(join(importedDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      packId: 'imported-model',
      displayName: 'Imported',
      internalName: 'Imported',
      createdAt: '2026-08-21T00:00:00.000Z',
      model: {
        pmxFile: 'model.pmx',
        sha256: createHash('sha256').update(pmxBytes).digest('hex').toUpperCase(),
        pmxVersion: 2.1,
        geometry: { vertices: 0, triangles: 0, materials: 0, bones: 0, morphs: 0, textures: 0 },
        credit: '用户导入模型',
        licenseStatus: 'test'
      },
      textures: [], morphs: {}, bones: {}, materialCompatibility: { rules: [] },
      motions: {
        idlePacks: [], gesturePacks: [], defaultIdle: '',
        customVmd: ['../selena-xisheng/motions/speech.vmd'],
        longActionVmd: [], idleVmdPool: []
      },
      capabilities: ['visemes', 'blink']
    }), 'utf8');

    const importedManager = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: userRoot,
      sharedMotionsRoot: sharedDir,
      voiceActionsPath
    });
    expect(importedManager.switchModel('imported-model').success).toBe(true);
    expect(importedManager.resolveCustomVmdPath('imported-model', '../selena-xisheng/motions/speech.vmd'))
      .toBe(siblingMotion);
  });

  it('returns null for a missing motion', () => {
    const { manager } = createFixture();

    expect(manager.resolveCustomVmdPath('fixture-pack', 'motions/missing.vmd')).toBeNull();
  });

  it('rejects paths that escape the pack even when the target exists', () => {
    const { manager } = createFixture();

    expect(manager.resolveCustomVmdPath('fixture-pack', '../outside.vmd')).toBeNull();
  });
});

describe('ModelPackManager idle quick slots', () => {
  it('keeps at most four idle pool entries', () => {
    const { manager } = createFixture();
    const paths = [
      'motions/local.vmd', 'motions/shared.vmd', 'motions/idle-3.vmd',
      'motions/idle-4.vmd', 'motions/idle-5.vmd'
    ];

    for (const path of paths.slice(0, 4)) {
      expect(manager.toggleIdleVmd('fixture-pack', path, true)).toBe(true);
    }
    expect(manager.toggleIdleVmd('fixture-pack', paths[4], true)).toBe(false);
    expect(manager.getCurrentPack()?.manifest.motions.idleVmdPool).toEqual(paths.slice(0, 4));
  });
});

describe('ModelPackManager.removeLibraryVmd', () => {
  it('permanently removes every manifest and shared voice reference and deletes the VMD', () => {
    const { manager, packDir } = createFixture();
    const vmdPath = 'motions/local.vmd';
    const physicalPath = join(packDir, vmdPath);
    writeFileSync(physicalPath, 'keep me');
    const pack = manager.getCurrentPack()!;
    pack.manifest.motions.customVmd = ['motions\\LOCAL.vmd', 'motions/shared.vmd'];
    pack.manifest.motions.longActionVmd = [' motions/local.vmd '];
    pack.manifest.motions.idleVmdPool = ['MOTIONS/LOCAL.VMD'];
    pack.manifest.motions.defaultIdle = 'motions\\local.vmd';
    pack.manifest.motions.vmdEmotionMap = [{
      vmdPath: 'MOTIONS/LOCAL.vmd', displayName: 'legacy local', type: 'gesture', gestureFamily: 'neutral',
      intent: 'explaining', emotions: ['neutral'], description: '', dialogueSafe: true
    }];
    writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(pack.manifest, null, 2), 'utf8');
    manager.addVoiceAction({
      vmdPath, displayName: 'local', type: 'gesture', gestureFamily: 'neutral',
      intent: 'explaining', emotions: ['neutral'], description: '', dialogueSafe: true
    });

    expect((manager as any).removeLibraryVmd(vmdPath)).toMatchObject({ success: true });
    const saved = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
    expect(saved.motions.customVmd).not.toContain(vmdPath);
    expect(saved.motions.longActionVmd).not.toContain(vmdPath);
    expect(saved.motions.idleVmdPool).not.toContain(vmdPath);
    expect(saved.motions.defaultIdle).not.toMatch(/local\.vmd/i);
    expect(saved.motions.vmdEmotionMap).toEqual([]);
    expect(manager.loadSharedVoiceActions().some(entry => entry.vmdPath === vmdPath)).toBe(false);
    expect(existsSync(physicalPath)).toBe(false);
  });

  it('truthfully reports when no library reference existed', () => {
    const { manager } = createFixture();
    expect((manager as any).removeLibraryVmd('motions/missing.vmd')).toMatchObject({ success: true });
  });

  it('keeps a deleted motion hidden after restart and a packaged manifest refresh', () => {
    const { manager, builtinRoot, packDir, sharedDir, voiceActionsPath } = createFixture();
    const vmdPath = 'motions/local.vmd';
    const originalManifest = readFileSync(join(packDir, 'manifest.json'), 'utf8');
    const oldVoiceEntry = {
      vmdPath, displayName: 'local', type: 'gesture' as const, gestureFamily: 'neutral',
      intent: 'explaining', emotions: ['neutral'], description: '', dialogueSafe: true
    };
    manager.addVoiceAction(oldVoiceEntry);

    expect(manager.removeLibraryVmd(vmdPath).success).toBe(true);
    expect(JSON.parse(readFileSync(join(dirname(voiceActionsPath), 'motion-deletions.json'), 'utf8')).paths)
      .toContain(vmdPath);

    // Simulate an app update restoring both packaged indexes. The user-owned
    // deletion tombstone must remain authoritative after a new manager starts.
    writeFileSync(join(packDir, 'manifest.json'), originalManifest, 'utf8');
    writeFileSync(voiceActionsPath, JSON.stringify({
      schemaVersion: 1, description: 'restored release defaults', entries: [oldVoiceEntry]
    }), 'utf8');
    const restarted = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(dirname(builtinRoot), 'user-models'),
      sharedMotionsRoot: sharedDir,
      voiceActionsPath
    });
    expect(restarted.switchModel('fixture-pack').success).toBe(true);
    expect(restarted.getCurrentPack()!.manifest.motions.customVmd).not.toContain(vmdPath);
    expect(restarted.loadSharedVoiceActions().filter(entry => !entry.protected)).toEqual([]);
  });

  it('keeps an explicit shared path distinct from a pack-local path with the same basename', () => {
    const { manager, builtinRoot, packDir, sharedDir, voiceActionsPath } = createFixture();
    const localAlias = 'motions/shared.vmd';
    const sharedAlias = '../shared/motions/shared.vmd';
    const originalManifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
    writeFileSync(join(sharedDir, 'shared.vmd'), 'shared motion');

    expect(manager.removeLibraryVmd(localAlias).success).toBe(true);
    const tombstones = JSON.parse(
      readFileSync(join(dirname(voiceActionsPath), 'motion-deletions.json'), 'utf8')
    ).paths;
    expect(tombstones).toContain(localAlias);

    originalManifest.motions.customVmd = [sharedAlias];
    writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(originalManifest), 'utf8');
    const restarted = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(dirname(builtinRoot), 'user-models'),
      sharedMotionsRoot: sharedDir,
      voiceActionsPath
    });
    expect(restarted.switchModel('fixture-pack').success).toBe(true);
    expect(restarted.getCurrentPack()!.manifest.motions.customVmd).toEqual([sharedAlias]);
  });

  it('does not apply a shared basename tombstone to an explicit sibling-model motion', () => {
    const { manager, builtinRoot, packDir, sharedDir, voiceActionsPath } = createFixture();
    const siblingDir = join(builtinRoot, 'sibling-pack', 'motions');
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(siblingDir, 'same-name.vmd'), 'sibling motion');
    writeFileSync(join(sharedDir, 'same-name.vmd'), 'shared motion');
    expect(manager.removeLibraryVmd('../shared/motions/same-name.vmd').success).toBe(true);

    const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));
    manifest.motions.customVmd = ['../sibling-pack/motions/same-name.vmd'];
    writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    const restarted = new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(dirname(builtinRoot), 'user-models'),
      sharedMotionsRoot: sharedDir,
      voiceActionsPath
    });
    expect(restarted.switchModel('fixture-pack').success).toBe(true);
    expect(restarted.getCurrentPack()!.manifest.motions.customVmd)
      .toEqual(['../sibling-pack/motions/same-name.vmd']);
  });
});

describe('ModelPackManager shared voice actions', () => {
  it('removes all path-equivalent entries and persists the result', () => {
    const { manager, builtinRoot } = createFixture();
    const canonicalPath = '../shared/motions/Gentle Talk.vmd';
    manager.addVoiceAction({
      vmdPath: canonicalPath, displayName: 'gentle', type: 'gesture', gestureFamily: 'neutral',
      intent: 'explaining', emotions: ['neutral'], description: '', dialogueSafe: true
    });
    // Simulate legacy duplicates that differ only by path separator and case.
    const voiceActionsPath = join(builtinRoot, 'shared', 'voice-actions.json');
    const stored = JSON.parse(readFileSync(voiceActionsPath, 'utf8'));
    stored.entries.push({ ...stored.entries[0], vmdPath: '..\\shared\\motions\\gentle talk.vmd' });
    writeFileSync(voiceActionsPath, JSON.stringify(stored, null, 2), 'utf8');
    (manager as any).sharedVoiceActions = null;

    expect(manager.removeVoiceAction(' ../SHARED/motions/GENTLE TALK.vmd ')).toBe(true);
    expect(manager.loadSharedVoiceActions().filter(entry => !entry.protected)).toHaveLength(0);
    expect(JSON.parse(readFileSync(voiceActionsPath, 'utf8')).entries).toHaveLength(0);
  });

  it('can remove a candidate voice reference without tombstoning its source VMD', () => {
    const { manager, builtinRoot } = createFixture();
    const candidatePath = '../shared/motions/candidate-gentle.vmd';
    expect(manager.addVoiceAction({
      vmdPath: candidatePath, displayName: 'candidate gentle', type: 'voice',
      gestureFamily: 'daily-gentle', intent: 'comforting', emotions: ['gentle'],
      description: '', dialogueSafe: true
    })).toBe(true);

    expect(manager.removeVoiceActionReference(candidatePath)).toBe(true);
    expect(manager.loadSharedVoiceActions().filter(entry => !entry.protected)).toEqual([]);
    const tombstonePath = join(dirname(join(builtinRoot, 'shared', 'voice-actions.json')), 'motion-deletions.json');
    const tombstones = existsSync(tombstonePath)
      ? JSON.parse(readFileSync(tombstonePath, 'utf8')).paths
      : [];
    expect(tombstones).not.toContain(candidatePath.toLowerCase());
  });

  it('uses a writable user catalog seeded from immutable defaults and keeps deletion after restart', () => {
    const { builtinRoot, sharedDir, voiceActionsPath: defaultVoiceActionsPath } = createFixture();
    const root = dirname(builtinRoot);
    const userRoot = join(root, 'user-models');
    const userVoiceActionsPath = join(root, 'user-data', 'voice-actions.json');
    const entry = {
      vmdPath: '../shared/motions/Gentle Talk.vmd', displayName: 'gentle', type: 'gesture',
      gestureFamily: 'neutral', intent: 'explaining', emotions: ['neutral'], description: '', dialogueSafe: true
    };
    writeFileSync(defaultVoiceActionsPath, JSON.stringify({
      schemaVersion: 1, description: 'immutable defaults', entries: [entry]
    }), 'utf8');

    const createManager = () => new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: userRoot,
      sharedMotionsRoot: sharedDir,
      voiceActionsPath: userVoiceActionsPath,
      defaultVoiceActionsPath
    });
    const first = createManager();
    expect(first.loadSharedVoiceActions().filter(item => !item.protected)).toHaveLength(1);
    expect(first.removeVoiceAction(entry.vmdPath)).toBe(true);
    expect(JSON.parse(readFileSync(userVoiceActionsPath, 'utf8')).entries).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, 'user-data', 'motion-deletions.json'), 'utf8')).paths)
      .toContain(entry.vmdPath.toLowerCase());

    const restarted = createManager();
    expect(restarted.loadSharedVoiceActions().filter(item => !item.protected)).toEqual([]);
    expect(JSON.parse(readFileSync(defaultVoiceActionsPath, 'utf8')).entries).toHaveLength(1);
  });

  it('re-reads the user catalog so a stale manager cannot undo a newer edit', () => {
    const { builtinRoot, sharedDir, voiceActionsPath: defaultVoiceActionsPath } = createFixture();
    const root = dirname(builtinRoot);
    const userVoiceActionsPath = join(root, 'user-data', 'voice-actions.json');
    mkdirSync(dirname(userVoiceActionsPath), { recursive: true });
    const entry = {
      vmdPath: '../shared/motions/Gentle Talk.vmd', displayName: 'original', type: 'voice' as const,
      gestureFamily: 'neutral', intent: 'explaining', emotions: ['neutral'], description: '', dialogueSafe: true
    };
    writeFileSync(userVoiceActionsPath, JSON.stringify({
      schemaVersion: 1, description: 'user', entries: [entry]
    }), { encoding: 'utf8', flag: 'w' });
    const createManager = () => new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(root, 'user-models'),
      sharedMotionsRoot: sharedDir,
      voiceActionsPath: userVoiceActionsPath,
      defaultVoiceActionsPath
    });
    const stale = createManager();
    const current = createManager();
    stale.loadSharedVoiceActions();
    expect(current.updateVoiceAction(entry.vmdPath, { displayName: 'edited' })).toBe(true);
    expect(stale.updateVoiceAction(entry.vmdPath, { starred: true })).toBe(true);

    const saved = JSON.parse(readFileSync(userVoiceActionsPath, 'utf8'));
    expect(saved.entries[0]).toMatchObject({ displayName: 'edited', starred: true });
  });

  it('persists all editable voice metadata exactly across manager restart', () => {
    const { builtinRoot, sharedDir, voiceActionsPath: defaultVoiceActionsPath } = createFixture();
    const root = dirname(builtinRoot);
    const userVoiceActionsPath = join(root, 'user-data', 'voice-actions.json');
    const entry = {
      vmdPath: '../shared/motions/Editable.vmd', displayName: 'editable', type: 'voice' as const,
      gestureFamily: 'general', intent: 'general', emotions: ['neutral'],
      description: 'before', dialogueSafe: true
    };
    const createManager = () => new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(root, 'user-models'),
      sharedMotionsRoot: sharedDir,
      voiceActionsPath: userVoiceActionsPath,
      defaultVoiceActionsPath
    });

    const current = createManager();
    expect(current.addVoiceAction(entry)).toBe(true);
    expect(current.updateVoiceAction(entry.vmdPath, {
      gestureFamily: 'wave',
      intent: 'greeting',
      description: '中文动作描述',
      dialogueSafe: false,
      emotions: ['happy', 'neutral']
    })).toBe(true);

    const restarted = createManager();
    expect(restarted.loadSharedVoiceActions()).toContainEqual({
      ...entry,
      gestureFamily: 'wave',
      intent: 'greeting',
      description: '中文动作描述',
      dialogueSafe: false,
      emotions: ['happy', 'neutral']
    });
  });

  it('re-reads tombstones so concurrent deletions are accumulated, never replaced', () => {
    const { builtinRoot, sharedDir, voiceActionsPath: defaultVoiceActionsPath } = createFixture();
    const root = dirname(builtinRoot);
    const userData = join(root, 'user-data');
    const userVoiceActionsPath = join(userData, 'voice-actions.json');
    const createManager = () => new ModelPackManager({
      builtinPacksRoot: builtinRoot,
      userPacksRoot: join(root, 'user-models'),
      sharedMotionsRoot: sharedDir,
      voiceActionsPath: userVoiceActionsPath,
      defaultVoiceActionsPath
    });
    const first = createManager();
    const second = createManager();
    expect(first.removeVoiceAction('motions/first.vmd')).toBe(true);
    expect(second.removeVoiceAction('motions/second.vmd')).toBe(true);

    const paths = JSON.parse(readFileSync(join(userData, 'motion-deletions.json'), 'utf8')).paths;
    expect(paths).toEqual(expect.arrayContaining(['motions/first.vmd', 'motions/second.vmd']));
  });

  it('does not merge obsolete model-local mappings back into the shared catalog', () => {
    const { manager } = createFixture();
    const pack = manager.getCurrentPack()!;
    pack.manifest.motions.vmdEmotionMap = [{
      vmdPath: 'motions/old.vmd', displayName: 'old', type: 'gesture', gestureFamily: 'neutral',
      intent: 'explaining', emotions: ['neutral'], description: '', dialogueSafe: true
    }];

    expect(manager.getMergedVmdEmotionMap(pack.manifest.packId)
      .filter(entry => !entry.protected)).toEqual([]);
  });
});
