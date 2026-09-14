import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '..', '..');

function source(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8');
}

describe('avatar sync stop production wiring', () => {
  it('passes a normalized stop reason from Chat through main to Avatar', () => {
    const preload = source('electron/preloads/chat-preload.ts');
    const main = source('electron/main.ts');
    const avatar = source('src/desktop-avatar-renderer.ts');

    expect(preload).toContain("avatarSyncStop: (taskId: string, reason: AvatarSyncStopReason = 'cancel')");
    expect(preload).toContain("ipcRenderer.invoke('avatar:sync-stop', taskId, reason)");
    expect(main).toContain('const stopReason = normalizeAvatarSyncStopReason(reason);');
    expect(main).toContain("avatarWindow.webContents.send('avatar:stop-play', stopReason, taskId)");
    expect(avatar).toContain('if (taskId && taskId !== currentPlaybackTaskId) return;');
    expect(avatar).toContain('performanceStopReasonForAvatarSignal(normalizedReason, currentPlaybackMute)');
  });

  it('distinguishes replacement, user cancellation and natural completion in Chat', () => {
    const app = source('chat5-compat/public/app.js');

    expect(app).toContain("await notifyAvatarSyncStop('interrupted')");
    expect(app).toContain("notifyAvatarSyncStop('cancel')");
    expect(app).toContain("notifyAvatarSyncStop('ended')");
  });
});
