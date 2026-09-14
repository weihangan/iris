import { describe, expect, it } from 'vitest';
import {
  isAutomaticVoiceAction,
  isExactAutomaticVoiceSelection,
  isVoiceActionPoolEntry
} from '../../src/performance/voice-action-pool';

describe('voice action pool admission', () => {
  it('treats only explicit voice entries as members of the user voice pool', () => {
    expect(isVoiceActionPoolEntry({ type: 'voice', dialogueSafe: false })).toBe(true);
    // Older catalog rows used type=gesture even though the user had already
    // placed them in this shared pool. They must remain visible/editable.
    expect(isVoiceActionPoolEntry({ type: 'gesture', dialogueSafe: true })).toBe(true);
    expect(isVoiceActionPoolEntry({ type: 'gesture', dialogueSafe: false })).toBe(true);
    expect(isVoiceActionPoolEntry({ type: 'idle', dialogueSafe: true })).toBe(false);
  });

  it('automatically selects only enabled members of the user voice pool', () => {
    expect(isAutomaticVoiceAction({ type: 'voice', dialogueSafe: true })).toBe(true);
    expect(isAutomaticVoiceAction({ type: 'voice', dialogueSafe: false })).toBe(false);
    expect(isAutomaticVoiceAction({ type: 'voice' })).toBe(false);
    expect(isAutomaticVoiceAction({ type: 'gesture', dialogueSafe: true })).toBe(false);
  });

  it('admits playback only when the exact normalized pool path matches', () => {
    const entry = {
      type: 'voice',
      dialogueSafe: true,
      vmdPath: '../shared/motions/害羞.vmd'
    };
    expect(isExactAutomaticVoiceSelection(entry, '..\\shared\\motions\\害羞.vmd')).toBe(true);
    expect(isExactAutomaticVoiceSelection(entry, '../shared/motions/思考.vmd')).toBe(false);
    expect(isExactAutomaticVoiceSelection({ ...entry, type: 'gesture' }, entry.vmdPath)).toBe(false);
    expect(isExactAutomaticVoiceSelection({ ...entry, dialogueSafe: false }, entry.vmdPath)).toBe(false);
  });
});
