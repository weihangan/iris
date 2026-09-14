import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 验证 ChatX2 身份独立于 Chat5/Chat6
describe('ChatX2 identity', () => {
  const pkgPath = resolve(__dirname, '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

  it('package name 包含 chatx2 标识', () => {
    expect(pkg.name.toLowerCase()).toMatch(/chatx2|selena-chatx2/);
  });

  it('version 为 2.0.0', () => {
    expect(pkg.version).toBe('2.0.0');
  });

  it('appId 为 com.wha1999.chatx2.selena（独立于 Chat5/Chat6）', () => {
    const appId = pkg.appId || pkg.build?.appId;
    expect(appId).toBeTruthy();
    expect(appId).not.toBe('com.wha1999.chat5.universal');
    expect(appId).not.toBe('com.wha1999.chat6.selena');
    expect(appId).toBe('com.wha1999.chatx2.selena');
  });

  it('productName 为 伊利斯 ChatX2', () => {
    const productName = pkg.productName || pkg.build?.productName;
    expect(productName).toBe('伊利斯 ChatX2');
  });

  it('Express 端口默认为 3003（非 3002/3001）', () => {
    // Chat5 使用 3002；Chat6 使用 3001；ChatX2 不得占用
    const port = pkg.chatx2?.expressPort ?? 3003;
    expect(port).toBe(3003);
  });

  it('TTS 端口预留为 9882（非 9880/9881）', () => {
    const ttsPort = pkg.chatx2?.ttsPort ?? 9882;
    expect(ttsPort).toBe(9882);
  });

  it('必要的 npm scripts 存在', () => {
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts.check).toBeDefined();
    expect(pkg.scripts.test).toBeDefined();
    expect(pkg.scripts['test:e2e']).toBeDefined();
    expect(pkg.scripts['audit:bootstrap']).toBeDefined();
  });
});
