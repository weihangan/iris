import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateMockWav } from '../../src/conversation/mock-wav-generator';

const OUTPUT_BASE = resolve('docs', 'evidence', 'transition-visual-2026-08-11');
const DEFAULT_IDLE = '../shared/motions/待机 双手后背.vmd';
const POSE_NAMES = [
  '上半身', '上半身2', '左肩', '右肩', '左腕', '右腕',
  '左腕捩', '右腕捩', '左ひじ', '右ひじ', '左手捩', '右手捩',
  '左手首', '右手首', '下半身', '左足', '右足', '左ひざ', '右ひざ'
];

const SPEECH_CASES = [
  {
    id: 'shy',
    vmdPath: '../shared/motions/害羞_低头看左下后回正.vmd',
    displayName: '害羞 低头看左下后回正',
    semantic: { emotion: 'shy', intent: 'general' },
    text: '指挥，这么晚了还在忙吗？我有些担心，也有一点害羞。'
  },
  {
    id: 'serious',
    vmdPath: 'motions/前倾 锐利.vmd',
    displayName: '前倾 锐利',
    semantic: { emotion: 'serious', intent: 'general' },
    text: '请认真听我说明今天的安排，我们会一步一步完成。'
  },
  {
    id: 'thinking',
    vmdPath: 'motions/思考B 循环.vmd',
    displayName: '思考B 循环',
    semantic: { emotion: 'thinking', intent: 'general' },
    text: '让我仔细想一想接下来该怎么做，我很快给你答案。'
  }
] as const;

async function findWindow(app: ElectronApplication, titlePart: string): Promise<Page> {
  await expect.poll(async () => {
    const titles = await Promise.all(app.windows().map(page => page.title().catch(() => '')));
    return titles.some(title => title.includes(titlePart));
  }, { timeout: 30_000 }).toBe(true);
  for (const page of app.windows()) {
    if ((await page.title().catch(() => '')).includes(titlePart)) return page;
  }
  throw new Error(`window not found: ${titlePart}`);
}

test('captures real rear-hand idle speech transitions for visual clipping review', async () => {
  test.setTimeout(300_000);
  const buildIdentity = JSON.parse(readFileSync(resolve('dist', 'build-identity.json'), 'utf8'));
  const outputRoot = join(OUTPUT_BASE, buildIdentity.buildId);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const userDataDir = mkdtempSync(join(tmpdir(), 'chatx2-transition-visual-'));
  writeFileSync(join(userDataDir, 'voice-actions.json'), JSON.stringify({
    schemaVersion: 1,
    description: 'Visual audit copy of the three enabled user voice actions',
    entries: SPEECH_CASES.map(item => ({
      vmdPath: item.vmdPath,
      displayName: item.displayName,
      type: 'voice',
      gestureFamily: 'general',
      intent: 'general',
      emotions: [item.semantic.emotion],
      description: item.displayName,
      dialogueSafe: true
    }))
  }, null, 2), 'utf8');
  writeFileSync(join(userDataDir, 'model-settings.json'), JSON.stringify({
    schemaVersion: 1,
    lastPackId: 'selena-xisheng-v1',
    motionSettingsByPack: {
      'selena-xisheng-v1': { defaultIdle: DEFAULT_IDLE }
    }
  }, null, 2), 'utf8');
  writeFileSync(join(userDataDir, 'avatar-motion-settings.json'), JSON.stringify({
    schemaVersion: 1,
    transitionSpeed: 0.6
  }, null, 2), 'utf8');

  const app = await _electron.launch({
    args: [resolve('dist', 'electron', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT6_PMX_RENDER_IN_TEST: '1',
      CHAT6_TEST_USER_DATA: userDataDir,
      CHATX2_SHARED_DATA_DIR: userDataDir
    }
  });

  const report: Record<string, unknown> = {
    buildIdentity,
    defaultIdle: DEFAULT_IDLE,
    transitionSpeed: 0.6,
    cases: []
  };

  try {
    const chat = await findWindow(app, '伊利斯 ChatX2');
    await expect.poll(() => chat.evaluate(() => (window as any).chatx2.hasAvatarReady()),
      { timeout: 45_000 }).toBe(true);
    if (await chat.evaluate(() => (window as any).chatx2.getMode()) !== 'desktop') {
      const result = await chat.evaluate(() => (window as any).chatx2.transition('desktop'));
      expect(result.status).toBe('ok');
    }
    const avatar = await findWindow(app, 'Avatar');
    avatar.on('console', message => console.log('[avatar-console]', message.type(), message.text()));
    await avatar.addStyleTag({ content: 'html,body{background:#d9dde4!important;}' });

    for (const speechCase of SPEECH_CASES) {
      const caseDir = join(outputRoot, speechCase.id);
      mkdirSync(caseDir, { recursive: true });
      // Keep exactly one automatic voice action admitted for each visual case.
      // This makes the screenshot evidence about the requested VMD, not about
      // the planner's semantic tie-break between several eligible entries.
      const configured = await chat.evaluate(() => (window as any).chatx2.listVoiceActions());
      for (const entry of configured.entries ?? []) {
        await chat.evaluate(path => (window as any).chatx2.removeVoiceAction(path), entry.vmdPath);
      }
      await chat.evaluate(entry => (window as any).chatx2.addVoiceAction(entry), {
        vmdPath: speechCase.vmdPath,
        displayName: speechCase.displayName,
        type: 'voice',
        gestureFamily: 'general',
        intent: 'general',
        emotions: [speechCase.semantic.emotion],
        description: speechCase.displayName,
        dialogueSafe: true
      });
      await avatar.waitForTimeout(250);
      await expect.poll(() => avatar.evaluate(idle => {
        const runtime = (window as any).__chatx2Runtime;
        return runtime?.motionPlayer?.getCurrentPackId?.() === idle
          && runtime?.motionPlayer?.getState?.() === 'playing';
      }, DEFAULT_IDLE), { timeout: 20_000 }).toBe(true);
      await avatar.waitForTimeout(1_200);
      await avatar.screenshot({ path: join(caseDir, '000-idle-before.png') });

      const before = await avatar.evaluate(names => ({
        pose: (window as any).__chatx2Runtime.__getBoneStates(names),
        world: (window as any).__chatx2Runtime.__getBoneWorldPositions(names)
      }), POSE_NAMES);
      const taskId = `transition-visual-${speechCase.id}-${Date.now()}`;
      const wav = Array.from(new Uint8Array(generateMockWav({
        taskId,
        userText: `${speechCase.text} 这段音频用于观察从背手待机进入语音动作的完整手臂路径，并为动作缓慢进入、充分展示和平稳回正预留足够时间。`
      })));
      const sync = await chat.evaluate(async payload => (window as any).chatx2.avatarSyncVoice(
        payload.taskId,
        new Uint8Array(payload.wav).buffer,
        payload.semantic,
        payload.text
      ), { taskId, wav, semantic: speechCase.semantic, text: speechCase.text });
      expect(sync.success).toBe(true);
      console.log('[speech-transition-debug]', speechCase.id, await avatar.evaluate(() => {
        const runtime = (window as any).__chatx2Runtime;
        return {
          syncState: runtime?.performanceSession?.getState?.(),
          motion: runtime?.__debugMotionPlayerState?.(),
          speech: runtime?.__debugSpeechMotionSelection?.(),
          build: (window as any).__CHATX2_BUILD_ID__
        };
      }));

      // `lastSelection` intentionally remains available after a reply. Wait
      // for this task's new cue before sampling, otherwise the next case can
      // accidentally assert and record the preceding reply's selection.
      await expect.poll(() => avatar.evaluate(expectedPath => {
        const runtime = (window as any).__chatx2Runtime;
        const debug = runtime?.__debugSpeechMotionSelection?.();
        return debug?.performanceState === 'performing'
          && debug?.lastSelection?.selectedVmdPath === expectedPath
          && String(runtime?.motionPlayer?.getCurrentPackId?.() ?? '').startsWith('speech-cue:');
      }, speechCase.vmdPath), { timeout: 15_000 }).toBe(true);

      const samples: Array<Record<string, unknown>> = [];
      const captureStart = Date.now();
      for (let frame = 1; frame <= 24; frame += 1) {
        const sample = await avatar.evaluate(names => {
          const runtime = (window as any).__chatx2Runtime;
          return {
            motion: runtime.__debugMotionPlayerState(),
            speech: runtime.__debugSpeechMotionSelection(),
            pose: runtime.__getBoneStates(names),
            world: runtime.__getBoneWorldPositions(names)
          };
        }, POSE_NAMES);
        samples.push({ elapsedMs: Date.now() - captureStart, ...sample });
        await avatar.screenshot({
          path: join(caseDir, `${String(frame).padStart(3, '0')}-${String(Date.now() - captureStart).padStart(4, '0')}ms.png`)
        });
        await avatar.waitForTimeout(50);
      }

      await expect.poll(() => avatar.evaluate(() =>
        (window as any).__chatx2Runtime?.performanceSession?.getState()),
      { timeout: 30_000 }).toBe('idle');
      await expect.poll(() => avatar.evaluate(idle => {
        const runtime = (window as any).__chatx2Runtime;
        return runtime?.motionPlayer?.getCurrentPackId?.() === idle
          && runtime?.motionPlayer?.getState?.() === 'playing';
      }, DEFAULT_IDLE), { timeout: 20_000 }).toBe(true);
      await avatar.waitForTimeout(800);
      await avatar.screenshot({ path: join(caseDir, '999-idle-recovered.png') });

      const selected = samples.map(sample => (sample.speech as any)?.lastSelection)
        .find(selection => selection?.selectedVmdPath);
      expect(selected?.selectedFromVoiceActionPool).toBe(true);
      expect(selected?.selectedVmdPath).toBe(speechCase.vmdPath);
      (report.cases as Array<unknown>).push({
        id: speechCase.id,
        expectedVmdPath: speechCase.vmdPath,
        sync,
        selected,
        before,
        samples
      });
      writeFileSync(join(outputRoot, 'transition-report.json'), JSON.stringify(report, null, 2), 'utf8');
    }
  } finally {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
