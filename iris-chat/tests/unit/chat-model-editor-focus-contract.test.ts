import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ChatX2 voice-action editor focus contract', () => {
  const appSource = readFileSync(resolve('chat5-compat/public/app.js'), 'utf8');
  const htmlSource = readFileSync(resolve('chat5-compat/public/index.html'), 'utf8');

  it('does not let asynchronous chat completion steal focus from an editor', () => {
    expect(appSource).toContain("document.getElementById('chatx2-voice-editor-overlay')");
    expect(appSource).toContain('isTextEditingControl(active)');
    expect(appSource.match(/focusMessageInputIfAppropriate\(\);/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('creates one editable modal and focuses its metadata input after insertion', () => {
    expect(htmlSource).toContain('staleOverlay.parentNode.removeChild(staleOverlay)');
    expect(htmlSource.match(/gestureInput\.focus\(\{ preventScroll: true \}\)/g)?.length)
      .toBeGreaterThanOrEqual(2);
    expect(htmlSource).toContain("input.style.webkitAppRegion = 'no-drag'");
    expect(htmlSource).toContain('var newGesture = gestureInput.value.trim()');
    expect(htmlSource).toContain('var newIntent = intentInput.value.trim()');
    expect(htmlSource).toContain('var newDesc = descriptionInput.value.trim()');
  });
});

describe('ChatX2 daily performance candidate panel contract', () => {
  const rendererSource = readFileSync(resolve('src/renderer.ts'), 'utf8');
  const htmlSource = readFileSync(resolve('src/index.html'), 'utf8');

  it('keeps motion and expression candidates in two explicit debug panels', () => {
    expect(htmlSource).toContain('id="motion-candidate-review"');
    expect(htmlSource).toContain('id="motion-candidate-list"');
    expect(htmlSource).toContain('新添加 调试用—语音动作');
    expect(htmlSource).toContain('id="expression-candidate-review"');
    expect(htmlSource).toContain('id="expression-candidate-list"');
    expect(htmlSource).toContain('新添加 调试用—表情');
  });

  it('wires independent acceptance and pair-gated combined preview', () => {
    expect(rendererSource).toContain('window.chatx2.acceptMotionCandidate(candidate.id)');
    expect(rendererSource).toContain('window.chatx2.acceptExpressionCandidate(candidate.id)');
    expect(rendererSource).toContain('if (candidate.pairId)');
    expect(rendererSource).toContain('window.chatx2.previewCombinedCandidate(candidate.id)');
    expect(rendererSource).not.toMatch(/renderMotionCandidate[\s\S]{0,2500}acceptExpressionCandidate/);
    expect(rendererSource).not.toMatch(/renderExpressionCandidate[\s\S]{0,2500}acceptMotionCandidate/);
  });
});
