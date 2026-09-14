import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { generateMockWav } from '../../src/conversation/mock-wav-generator';

async function startChat5ContractServer(): Promise<{ server: Server; baseUrl: string; requests: Array<{ url: string; body: unknown }> }> {
  const requests: Array<{ url: string; body: unknown }> = [];
  const reply = '让我想一想……这样说有点害羞，不过我会认真陪你把事情慢慢理清。';
  const wavBuffer = generateMockWav({ taskId: 'chat5-real-contract', userText: reply });
  // Chat5.2 GPT-SoVITS 实机输出为 32000Hz；契约 E2E 必须覆盖该采样率，
  // 不能只用 Phase 5.1 的 44100Hz Mock 逃过 Controller WAV 硬门。
  const wavView = new DataView(wavBuffer);
  wavView.setUint32(24, 32000, true);
  wavView.setUint32(28, 64000, true);
  const wav = Buffer.from(wavBuffer);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ url: request.url ?? '', body });

    if (request.url === '/api/runtime') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, owner: 'wha1999', flavor: 'cpu' }));
      return;
    }
    if (request.url === '/api/chat' && request.method === 'POST') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, reply }));
      return;
    }
    if (request.url === '/api/voice/speak' && request.method === 'POST') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        audioUrl: '/api/voice/audio/contract.wav',
        emotion: 'shy'
      }));
      return;
    }
    if (request.url === '/api/voice/audio/contract.wav') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'audio/wav');
      response.end(wav);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('contract server did not bind TCP');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function findWindow(app: ElectronApplication, titlePart: string): Promise<Page> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      const title = await page.title().catch(() => '');
      if (title.includes(titlePart)) return page;
      if (titlePart === '伊利斯 ChatX2') {
        const isChatWindow = await page.evaluate(() =>
          typeof (window as any).chatx2?.transition === 'function').catch(() => false);
        if (isChatWindow) return page;
      }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`window not found: ${titlePart}`);
}

test('Chat5.2 自动情绪驱动真实 PMX 五口型、表情、视线和语义动作', async () => {
  test.setTimeout(120_000);
  const contract = await startChat5ContractServer();
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({
      args: [resolve(__dirname, '..', '..', 'dist', 'electron', 'main.js')],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CHAT6_PMX_RENDER_IN_TEST: '1',
        CHAT6_USE_REAL_CHAT5: '1',
        CHAT6_REAL_ADAPTER_IN_TEST: '1',
        CHAT6_CHAT5_BASE_URL: contract.baseUrl
      }
    });
    const chat = await findWindow(app, '伊利斯 ChatX2');
    const avatar = await findWindow(app, 'Avatar');
    const composer = await findWindow(app, 'Composer');
    avatar.on('console', message => {
      if (message.type() === 'warning' || message.type() === 'error') {
        console.log(`[avatar:${message.type()}] ${message.text()}`);
      }
    });
    await expect.poll(() => chat.evaluate(() => (window as any).chatx2.hasAvatarReady()),
      { timeout: 30_000 }).toBe(true);

    const identity = await chat.evaluate(() => (window as any).chatx2.getIdentity());
    expect(identity.conversationAdapterMode).toBe('real');
    expect(identity.conversationIsMock).toBe(false);
    expect(identity.conversationVoiceIsMock).toBe(false);

    await chat.evaluate(() => (window as any).chatx2.transition('desktop'));
    await expect.poll(() => chat.evaluate(() => (window as any).chatx2.getMode())).toBe('desktop');
    const neutralEye = await avatar.evaluate(() => (window as any).__chatx2Runtime.__getBoneState('両目'));

    const result = await composer.evaluate(() =>
      (window as any).chatx2.conversationSubmit('我现在有点乱，你能陪我想一想吗？'));
    expect(result.accepted).toBe(true);

    await expect.poll(() => composer.evaluate(async () =>
      (await (window as any).chatx2.conversationHistory()).messages.length), { timeout: 10_000 }).toBe(2);
    const history = await composer.evaluate(async () =>
      (await (window as any).chatx2.conversationHistory()).messages);
    expect(history[1].semantic).toMatchObject({ emotion: 'shy', intent: 'thinking' });
    await expect.poll(() => avatar.evaluate(() =>
      (window as any).__chatx2Runtime.performanceSession.getState()), { timeout: 10_000 }).toBe('performing');
    const planned = await avatar.evaluate(() =>
      (window as any).__chatx2Runtime.performanceSession.plan({
        emotion: 'shy', intent: 'thinking', speaking: true
      }));
    expect(planned.speakingVmdPath).toBeUndefined();

    const observedVisemes = new Set<string>();
    const observedPackIds = new Set<string>();
    let observedThinkingExpression = false;
    let observedRestrainedLowerBody = false;
    for (let index = 0; index < 20; index++) {
      const sample = await avatar.evaluate(() => {
        const runtime = (window as any).__chatx2Runtime;
        const names = ['あ', 'い', 'う', 'え', 'お'];
        return {
          mouth: names.map(name => runtime.morphControl.getRenderedWeight(name)),
          thinking: runtime.morphControl.getRenderedWeight('真面目'),
          faceRed: runtime.morphControl.getRenderedWeight('FaceRed'),
          eye: runtime.__getBoneState('両目'),
          packId: runtime.motionPlayer.getCurrentPackId(),
          playerState: runtime.motionPlayer.state,
          boneNames: runtime.__debugMotionPlayerState().currentBoneNames,
          expression: runtime.performanceSession.getCurrentExpression()
        };
      });
      sample.mouth.forEach((weight: number, channel: number) => {
        if (weight > 0.01) observedVisemes.add(['A', 'I', 'U', 'E', 'O'][channel]);
      });
      if (sample.packId) observedPackIds.add(sample.packId);
      if (sample.playerState) observedPackIds.add(`state:${sample.playerState}`);
      expect(sample.mouth.reduce((sum: number, value: number) => sum + value, 0)).toBeLessThanOrEqual(1.001);
      if (sample.expression.emotion === 'thinking'
        && String(sample.packId ?? '').startsWith('speech-background:')) {
        observedThinkingExpression = true;
        observedRestrainedLowerBody ||= sample.boneNames.includes('下半身');
        expect(sample.expression.emotion).toBe('thinking');
        expect(sample.faceRed).toBeLessThan(0.001);
        expect(sample.faceRed).toBeLessThanOrEqual(0.351);
        expect(sample.eye.quaternion).not.toEqual(neutralEye.quaternion);
      }
      if (observedThinkingExpression && observedVisemes.size >= 2) break;
      await avatar.waitForTimeout(75);
    }
    expect(observedVisemes.size).toBeGreaterThanOrEqual(2);
    expect([...observedPackIds].some(id => id.startsWith('speech-background:'))).toBe(true);
    expect([...observedPackIds].some(id => id.startsWith('candidate-review:'))).toBe(false);
    expect(observedThinkingExpression).toBe(true);
    expect(observedRestrainedLowerBody).toBe(true);

    expect(contract.requests.find(entry => entry.url === '/api/chat')?.body).toEqual({
      message: '我现在有点乱，你能陪我想一想吗？'
    });
    expect(contract.requests.find(entry => entry.url === '/api/voice/speak')?.body).toMatchObject({
      emotion: 'auto',
      charId: '2'
    });

    await chat.evaluate(() => (window as any).chatx2.transition('chat'));
    await expect.poll(() => avatar.evaluate(() => (window as any).__avatarSpeaking)).toBe(false);
    const cleaned = await avatar.evaluate(() => {
      const runtime = (window as any).__chatx2Runtime;
      return ['あ', 'い', 'う', 'え', 'お', '照れ', 'FaceRed']
        .map(name => runtime.morphControl.getRenderedWeight(name));
    });
    expect(Math.max(...cleaned)).toBeLessThan(0.001);
  } finally {
    if (app) await app.close().catch(() => undefined);
    await new Promise<void>(resolveClose => contract.server.close(() => resolveClose()));
  }
});
