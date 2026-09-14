import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const EVIDENCE_DIR = resolve(__dirname, '..', '..', 'docs', 'evidence', 'facial-performance-2026-07-28');

async function findWindow(app: ElectronApplication, titlePart: string): Promise<Page> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if ((await page.title().catch(() => '')).includes(titlePart)) return page;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`window not found: ${titlePart}`);
}

async function waitForFacialRuntime(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const runtime = (window as any).__chatx2Runtime;
    return Boolean(
      runtime?.actorRuntime
      && runtime?.morphControl
      && runtime?.previewSpeechExpression
      && runtime?.getFacialProfileValidation
    );
  }, undefined, { timeout: 45000 });
}

test('both real PMX models render compound happy expression during a full A viseme', async () => {
  test.setTimeout(180000);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const mainPath = resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js');
  const app = await _electron.launch({
    args: [mainPath],
    env: { ...process.env, NODE_ENV: 'test', CHAT6_PMX_RENDER_IN_TEST: '1' }
  });
  let userDataDir = '';

  try {
    const chat = await findWindow(app, '伊利斯 ChatX2');
    userDataDir = (await chat.evaluate(() => (window as any).chatx2.getIdentity())).userDataDir;
    const packs = await chat.evaluate(() => (window as any).chatx2.listModelPacks());
    const cases = [
      {
        id: 'selena-xisheng',
        mouthLeft: '口角上げ左', mouthRight: '口角上げ右', eye: '目尻下げ左',
        eyeWide: 'びっくり左', eyeSmile: '笑い', mouthFrown: '口角下げ左', pupil: '瞳大',
        expressions: {
          happy: ['目尻下げ左', '口角上げ左', '口角上げ右'],
          shy: ['困る左', '目尻下げ左', '口角上げ左', 'FaceRed'],
          concerned: ['困る左', '困る右', '口角下げ左'],
          sad: ['困る左', '困る右', '口角下げ左', '口角下げ右'],
          angry: ['怒り左', '怒り右', '口角下げ左'],
          surprised: ['困る左', 'にこり左', 'びっくり左'],
          thinking: ['にこり左', '目尻下げ左', '口横狭げ左'],
          gentle: ['目尻下げ左', '目尻下げ右', '口角上げ左'],
          delighted: ['にこり左', '目尻下げ左', '笑い', '口角上げ左'],
          shocked: ['困る左', 'にこり左', 'びっくり左', '口横広げ左'],
          furious: ['怒り左', '怒り右', '目尻下げ左', '口角下げ左'],
          heartbroken: ['困る左', '困る右', '目尻下げ左', '口角下げ左'],
          skeptical: ['にこり左', 'にこり右', '目尻下げ左', '口横狭げ左'],
          embarrassed: ['困る左', '目尻下げ左', '口角上げ左', 'FaceRed']
        }
      },
      {
        id: 'yyxuanling',
        mouthLeft: '左口角上げ', mouthRight: '右口角上げ', eye: '左笑い目',
        eyeWide: '左びっくり', eyeSmile: '笑い', mouthFrown: '左口角下げ', pupil: '瞳小',
        expressions: {
          happy: ['左笑い目', '左口角上げ', '右口角上げ'],
          shy: ['左困る', '左笑い目', '左口角上げ'],
          concerned: ['左困る', '右困る', '左口角下げ'],
          sad: ['左困る', '右困る', '左口角下げ', '右口角下げ'],
          angry: ['左怒り', '右怒り', '左口角下げ'],
          surprised: ['左困る', '左にこり2', '左びっくり'],
          thinking: ['左にこり2', '左笑い目', '口横狭め'],
          gentle: ['左笑い目', '右笑い目', '左口角上げ'],
          delighted: ['左にこり2', '左笑い目', '笑い', '左口角上げ'],
          shocked: ['左困る', '左にこり2', '左びっくり', '左口横広げ'],
          furious: ['左怒り', '右怒り', '左笑い目', '左口角下げ'],
          heartbroken: ['左困る', '右困る', '左笑い目', '左口角下げ'],
          skeptical: ['左にこり2', '右にこり2', '左笑い目', '口横狭め'],
          embarrassed: ['左困る', '左笑い目', '左口角上げ']
        }
      }
    ];

    for (const modelCase of cases) {
      const pack = packs.find((item: any) => String(item.packId).includes(modelCase.id));
      expect(pack, `model pack missing: ${modelCase.id}`).toBeTruthy();
      const result = await chat.evaluate((packId) =>
        (window as any).chatx2.switchModelPack(packId), pack.packId);
      expect(result.success, result.reason).toBe(true);

      const avatar = await findWindow(app, 'Avatar');
      await waitForFacialRuntime(avatar);
      const mode = await chat.evaluate(() => (window as any).chatx2.getMode());
      if (mode !== 'desktop') {
        const transition = await chat.evaluate(() => (window as any).chatx2.transition('desktop'));
        expect(transition.status).toBe('ok');
        await expect.poll(() => chat.evaluate(() => (window as any).chatx2.getMode()),
          { timeout: 5000 }).toBe('desktop');
      }
      // switchModelPack schedules an Avatar reload after 300ms. Wait for the
      // replacement renderer, not the soon-to-be-destroyed previous runtime.
      await avatar.waitForTimeout(450);
      await waitForFacialRuntime(avatar);
      await avatar.waitForTimeout(900);

      const idlePupilFirst = await avatar.evaluate((name) =>
        (window as any).__chatx2Runtime.morphControl.getRenderedWeight(name), modelCase.pupil);
      await avatar.waitForTimeout(1800);
      const idlePupilSecond = await avatar.evaluate((name) =>
        (window as any).__chatx2Runtime.morphControl.getRenderedWeight(name), modelCase.pupil);
      const pupilIsContractionOnly = modelCase.pupil === '瞳小';
      const idlePupilMinimum = pupilIsContractionOnly ? 0.004 : 0.02;
      const idlePupilMaximum = pupilIsContractionOnly ? 0.03 : 0.12;
      expect(idlePupilFirst).toBeGreaterThan(idlePupilMinimum);
      expect(idlePupilSecond).toBeGreaterThan(idlePupilMinimum);
      expect(idlePupilFirst).toBeLessThan(idlePupilMaximum);
      expect(idlePupilSecond).toBeLessThan(idlePupilMaximum);
      expect(Math.abs(idlePupilSecond - idlePupilFirst)).toBeGreaterThan(0.001);

      const previewSamples: Record<string, any> = {};
      for (const expressionId of ['surprised', 'sad', 'happy'] as const) {
        const preview = await chat.evaluate((id) =>
          (window as any).chatx2.setExpression(id), expressionId);
        expect(preview.success, preview.reason).toBe(true);
        await avatar.waitForTimeout(450);
        previewSamples[expressionId] = await avatar.evaluate((names) => {
          const runtime = (window as any).__chatx2Runtime;
          const control = runtime.morphControl;
          return {
            eyeWide: control.getRenderedWeight(names.eyeWide),
            eyeSmile: control.getRenderedWeight(names.eyeSmile),
            eyeLidClose: control.getRenderedWeight('まばたき'),
            mouthSmile: control.getRenderedWeight(names.mouthLeft),
            mouthFrown: control.getRenderedWeight(names.mouthFrown),
            pupil: control.getRenderedWeight(names.pupil),
            eyeBone: runtime.__getBoneState('両目')
          };
        }, modelCase);
        await avatar.screenshot({
          path: join(EVIDENCE_DIR, `${modelCase.id}-preview-${expressionId}.png`)
        });
      }
      expect(previewSamples.surprised.eyeWide).toBeGreaterThan(0.35);
      expect(previewSamples.sad.eyeLidClose).toBeGreaterThan(0.18);
      expect(previewSamples.sad.mouthFrown).toBeGreaterThan(0.25);
      expect(previewSamples.happy.eyeSmile).toBeGreaterThan(0.25);
      expect(previewSamples.happy.mouthSmile).toBeGreaterThan(0.35);
      if (modelCase.id === 'selena-xisheng') {
        expect(previewSamples.surprised.pupil).toBeGreaterThan(0.3);
      } else {
        expect(previewSamples.surprised.pupil).toBeLessThan(0.05);
      }
      await avatar.waitForTimeout(2300);

      const channelPreview = await chat.evaluate(() =>
        (window as any).chatx2.setExpression('neutral', 'mouthSmileLeft'));
      expect(channelPreview.success, channelPreview.reason).toBe(true);
      await avatar.waitForTimeout(120);
      const channelEntering = await avatar.evaluate((names) => {
        const runtime = (window as any).__chatx2Runtime;
        return {
          left: runtime.morphControl.getRenderedWeight(names.mouthLeft),
          right: runtime.morphControl.getRenderedWeight(names.mouthRight),
          eye: runtime.morphControl.getRenderedWeight(names.eye),
          current: runtime.getCurrentExpression()
        };
      }, modelCase);
      expect(channelEntering.left).toBeGreaterThan(0);
      expect(channelEntering.left).toBeLessThan(0.35);
      expect(channelEntering.right).toBeCloseTo(channelEntering.left, 5);
      expect(Math.abs(channelEntering.eye)).toBeLessThan(0.00001);
      expect(channelEntering.current).toBe('neutral:mouthSmileLeft');

      await avatar.waitForTimeout(320);
      const channelWeights = await avatar.evaluate((names) => {
        const runtime = (window as any).__chatx2Runtime;
        return {
          left: runtime.morphControl.getRenderedWeight(names.mouthLeft),
          right: runtime.morphControl.getRenderedWeight(names.mouthRight),
          eye: runtime.morphControl.getRenderedWeight(names.eye),
          current: runtime.getCurrentExpression()
        };
      }, modelCase);
      expect(channelWeights.left).toBeGreaterThanOrEqual(0.35);
      expect(channelWeights.right).toBeCloseTo(channelWeights.left, 5);
      expect(Math.abs(channelWeights.eye)).toBeLessThan(0.00001);
      expect(channelWeights.current).toBe('neutral:mouthSmileLeft');

      const blinkPreview = await chat.evaluate(() =>
        (window as any).chatx2.setExpression('sad', 'eyeLidClose'));
      expect(blinkPreview.success, blinkPreview.reason).toBe(true);
      await avatar.waitForTimeout(60);
      const blinkPeak = await avatar.evaluate(() =>
        (window as any).__chatx2Runtime.morphControl.getRenderedWeight('まばたき'));
      await avatar.waitForTimeout(220);
      const blinkTail = await avatar.evaluate(() =>
        (window as any).__chatx2Runtime.morphControl.getRenderedWeight('まばたき'));
      expect(blinkPeak).toBeGreaterThanOrEqual(0.5);
      expect(blinkTail).toBeLessThan(0.08);

      const initialState = await avatar.evaluate(() => {
        const runtime = (window as any).__chatx2Runtime;
        runtime.cameraControl?.setAngle('face');
        const panel = document.getElementById('morph-panel');
        if (panel) panel.hidden = true;
        runtime.actorRuntime.clearExpressionPreview();
        runtime.actorRuntime.stopSpeak();
        runtime.actorRuntime.speak('真实语音表情 E2E');
        runtime.actorRuntime.setEmotion('happy');
        runtime.actorRuntime.applyVisemeWeights({ A: 1, I: 0, U: 0, E: 0, O: 0 });
        runtime.avatarLoop?.renderOneFrame();
        return {
          actor: runtime.actorRuntime.getState(),
          profile: runtime.getFacialProfileValidation(),
          previewAcceptedDuringSpeech: runtime.previewSpeechExpression('shy', 'browInnerUp')
        };
      });
      await avatar.waitForTimeout(200);

      expect(initialState.actor.speaking).toBe(true);
      expect(initialState.profile.valid, initialState.profile.reasons?.join('; ')).toBe(true);
      expect(initialState.profile.lipEnabled).toBe(true);
      expect(initialState.previewAcceptedDuringSpeech).toBe(false);
      const ipcPreviewDuringSpeech = await chat.evaluate(() =>
        (window as any).chatx2.setExpression('shy', 'browInnerUp'));
      expect(ipcPreviewDuringSpeech.success).toBe(false);

      const pool = await chat.evaluate(() => (window as any).chatx2.getExpressionPresets());
      expect(pool.success).toBe(true);
      expect(pool.presets.length).toBeGreaterThanOrEqual(26);
      for (const id of ['delighted', 'shocked', 'furious', 'heartbroken', 'skeptical', 'embarrassed']) {
        expect(pool.presets.some((entry: any) => entry.id === id)).toBe(true);
      }
      expect(pool.presets.every((entry: any) => entry.previewOnly === false && entry.automatic === true)).toBe(true);
      expect(pool.presets.some((entry: any) => Array.isArray(entry.microAccents) && entry.microAccents.length > 0)).toBe(true);
      expect(pool.presets.some((entry: any) => entry.supported === true)).toBe(true);
      const neutralPool = pool.presets.find((entry: any) => entry.id === 'neutral');
      expect(neutralPool.channels).toHaveLength(3);
      expect(neutralPool.channels.every((entry: any) => entry.supported === true)).toBe(true);
      expect(neutralPool.channels.every((entry: any) => entry.weight >= 0.38)).toBe(true);

      const weights = await avatar.evaluate((names) => {
        const runtime = (window as any).__chatx2Runtime;
        const control = runtime.morphControl;
        const logical = runtime.actorRuntime.getMorphController();
        return {
          mouthLeft: control.getRenderedWeight(names.mouthLeft),
          mouthRight: control.getRenderedWeight(names.mouthRight),
          eye: control.getRenderedWeight(names.eye),
          visemeA: control.getRenderedWeight('あ'),
          logicalMouthLeft: logical.getWeight(names.mouthLeft),
          logicalEye: logical.getWeight(names.eye),
          logicalVisemeA: logical.getWeight('あ'),
          mouthOwner: runtime.morphOwnershipRegistry?.getOwner(names.mouthLeft) ?? null,
          visemeOwner: runtime.morphOwnershipRegistry?.getOwner('あ') ?? null
        };
      }, modelCase);

      expect(weights.eye).toBeGreaterThan(0);
      expect(weights.mouthLeft).toBeGreaterThan(0);
      expect(weights.mouthRight).toBeGreaterThan(0);
      expect(weights.visemeA).toBeCloseTo(1, 5);
      expect(weights.mouthLeft).toBeGreaterThanOrEqual(0.2);
      expect(weights.mouthLeft).toBeLessThan(0.4);
      expect(weights.logicalMouthLeft).toBeCloseTo(weights.mouthLeft, 5);
      expect(weights.logicalEye).toBeCloseTo(weights.eye, 5);
      expect(weights.logicalVisemeA).toBeCloseTo(weights.visemeA, 5);
      expect(weights.mouthOwner).not.toBe('vmd');
      expect(weights.visemeOwner).not.toBe('vmd');
      await avatar.screenshot({ path: join(EVIDENCE_DIR, `${modelCase.id}-happy-speaking.png`) });

      for (const [emotion, morphNames] of Object.entries(modelCase.expressions)) {
        const expressionWeights = await avatar.evaluate(({ selectedEmotion, names }) => {
          const runtime = (window as any).__chatx2Runtime;
          runtime.actorRuntime.applyVisemeWeights({ A: 0, I: 0, U: 0, E: 0, O: 0 });
          runtime.actorRuntime.setEmotion(selectedEmotion);
          runtime.avatarLoop?.renderOneFrame();
          const control = runtime.morphControl;
          return Object.fromEntries(names.map(name => [name, control.getRenderedWeight(name)]));
        }, { selectedEmotion: emotion, names: morphNames });
        expect(
          Object.values(expressionWeights).filter(weight => Number(weight) > 0).length,
          `${modelCase.id}/${emotion}: ${JSON.stringify(expressionWeights)}`
        ).toBeGreaterThanOrEqual(3);
        if (['happy', 'shy', 'sad', 'angry', 'delighted', 'shocked', 'furious', 'heartbroken', 'skeptical', 'embarrassed'].includes(emotion)) {
          await avatar.screenshot({ path: join(EVIDENCE_DIR, `${modelCase.id}-${emotion}.png`) });
        }
      }

      const cleanup = await avatar.evaluate((names) => {
        const runtime = (window as any).__chatx2Runtime;
        runtime.actorRuntime.stopSpeak();
        runtime.avatarLoop?.renderOneFrame();
        const control = runtime.morphControl;
        const watched = [names.mouthLeft, names.mouthRight, names.eye, 'あ', 'い', 'う', 'え', 'お'];
        return {
          actor: runtime.actorRuntime.getState(),
          rendered: Object.fromEntries(watched.map(name => [name, control.getRenderedWeight(name)])),
          logicalActive: runtime.actorRuntime.getMorphController().getActiveMorphs()
        };
      }, modelCase);
      expect(cleanup.actor.speaking).toBe(false);
      expect(cleanup.actor.emotion).toBe('neutral');
      expect(Object.values(cleanup.rendered).every(weight => Number(weight) === 0)).toBe(true);
      expect(cleanup.logicalActive.filter((entry: any) =>
        // Pupil life and a blink event are independent of speech cleanup and
        // intentionally remain active after visemes/expressions are cleared.
        !['瞳小', '瞳大', 'まばたき'].includes(entry.name))).toEqual([]);

      for (const expressionId of ['delighted', 'shocked', 'furious', 'heartbroken', 'skeptical', 'embarrassed']) {
        const preview = await chat.evaluate((id) =>
          (window as any).chatx2.setExpression(id), expressionId);
        expect(preview.success, preview.reason).toBe(true);
        await avatar.waitForTimeout(450);
        await expect.poll(() => avatar.evaluate(() =>
          (window as any).__chatx2Runtime.getCurrentExpression())).toBe(expressionId);
        await avatar.screenshot({
          path: join(EVIDENCE_DIR, `${modelCase.id}-preview-${expressionId}.png`)
        });
      }
    }
  } finally {
    await app.close().catch(() => undefined);
    if (userDataDir.includes('chat6-test-') && existsSync(userDataDir)) {
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});
