import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AvatarPerformanceSession } from '../../src/performance/avatar-performance-session';
import { PerformancePlanner, type VmdEmotionEntry } from '../../src/performance/performance-planner';
import { derivePerformanceSemantic } from '../../src/performance/semantic-performance';
import {
  coordinateSpeechMotionSemantic,
  resolveSpeechGazeSemantic
} from '../../src/performance/speech-performance-timeline';

function mockWav(seconds = 6): ArrayBuffer {
  const sampleRate = 8_000;
  const dataSize = Math.trunc(sampleRate * seconds * 2);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, dataSize, true);
  return buffer;
}

const catalog = JSON.parse(
  readFileSync(resolve('models/shared/voice-actions.json'), 'utf8')
).entries as VmdEmotionEntry[];
const manifest = JSON.parse(readFileSync(resolve('models/selena-xisheng/manifest.json'), 'utf8'));
const profile = JSON.parse(readFileSync(resolve('models/selena-xisheng/performance-profile.json'), 'utf8'));
const safePaths = new Set(catalog
  .filter(entry => entry.type === 'voice' && entry.dialogueSafe === true)
  .map(entry => entry.vmdPath.toLowerCase()));

describe('dialogue -> actual TTS semantic -> avatar performance', () => {
  it('forwards validated phrase segments into the audio-clock performance session', () => {
    const rendererSource = readFileSync(resolve('src/desktop-avatar-renderer.ts'), 'utf8');

    expect(rendererSource).toMatch(/beginPerformance\([\s\S]*?\{\s*\.\.\.playbackSemantic,/);
  });

  it('wires each speech cue emotion into restrained motion limits and playback rate', () => {
    const rendererSource = readFileSync(resolve('src/desktop-avatar-renderer.ts'), 'utf8');

    expect(rendererSource).toContain(
      'resolveSpeechMotionStyle(coordinated.emotion, cue.intensity)'
    );
    expect(rendererSource).toContain('amplitudeLimits: motionStyle.amplitudeLimits');
    expect(rendererSource).toContain('playbackRate: motionStyle.playbackRate');
  });

  it('routes the reported calm night reply to the user daily pool instead of legacy distress clips', () => {
    const text = '指挥，夜深了，你还没休息吗？我有些担心……（轻轻走到窗边）若觉得孤单或难以入眠，不妨听听我的歌声。我愿为你奏一曲安眠的乐章，伴你度过这漫长的黑夜。';
    const session = new AvatarPerformanceSession(() => 100);
    session.setComputeLevel('ultra');
    session.setFacialPersonality(profile.facialPersonality);
    const semantic = derivePerformanceSemantic(text, 'sad_question');
    session.beginPerformance('reported-night-reply', 100, mockWav(21.58746875), text,
      semantic.emotion, semantic.intensity, semantic);
    const dailyExplain = '../shared/motions/解释_右手轻摊一次后回正.vmd';
    const dailyEmphasis = '../shared/motions/解释强调_左手轻摊两次后回正.vmd';
    const nightCatalog: VmdEmotionEntry[] = [
      {
        vmdPath: '../selena-xisheng/motions/烦恼.vmd', displayName: '烦恼', type: 'gesture',
        gestureFamily: 'concerned', intent: 'worry', emotions: ['concerned'], description: '',
        dialogueSafe: true
      },
      {
        vmdPath: '../selena-xisheng/motions/尴尬.vmd', displayName: '尴尬', type: 'gesture',
        gestureFamily: 'sad', intent: 'concern', emotions: ['concerned'], description: '',
        dialogueSafe: true
      },
      {
        vmdPath: dailyExplain, displayName: '日常解释', type: 'voice',
        gestureFamily: 'explaining', intent: 'explaining', emotions: ['neutral'], description: '',
        dialogueSafe: true, starred: true
      },
      {
        vmdPath: dailyEmphasis, displayName: '日常解释强调', type: 'voice',
        gestureFamily: 'explaining', intent: 'explaining', emotions: ['neutral'], description: '',
        dialogueSafe: true
      }
    ];
    const planner = new PerformancePlanner();
    planner.updateVmdEmotionMap(nightCatalog);
    const selected: string[] = [];
    for (const cue of session.getPerformanceCues().filter(cue => cue.gestureEligible)) {
      const coordinated = coordinateSpeechMotionSemantic(cue, cue.facialEmotion);
      const plan = planner.plan({
        emotion: coordinated.emotion,
        intent: coordinated.intent,
        gestureFamily: coordinated.gestureFamily,
        intensity: cue.intensity,
        speaking: true,
        enabledVmdPaths: nightCatalog.map(entry => entry.vmdPath),
        excludedVmdPaths: selected
      });
      if (plan.speakingVmdPath) selected.push(plan.speakingVmdPath);
      if (selected.length === 2) break;
    }

    expect(selected).toEqual([dailyExplain, dailyEmphasis]);
    expect(selected.some(path => /烦恼|尴尬|垂头丧气/.test(path))).toBe(false);
  });

  it.each([
    ['温柔关心', '夜深了，我有些担心。请慢慢休息，我会陪着你。', 'gentle'],
    ['思考', '让我认真想一想，这里也许还有一种办法。', 'gentle'],
    ['感谢', '谢谢你一直陪着我，我真的很感激。', 'gentle'],
    ['害羞', '这样说有点不好意思，不过我很开心。', 'shy'],
    ['担心', '你看起来很疲惫，我有些担心。', 'comfort'],
    ['惊讶', '没想到居然会这样！', 'surprised'],
    ['生气', '这件事太过分了，我不能接受。', 'angry']
  ])('%s keeps face, gaze, pupil semantic and body selection coordinated', (_label, text, ttsEmotion) => {
    const semantic = derivePerformanceSemantic(text, ttsEmotion);
    const session = new AvatarPerformanceSession(() => 100);
    session.setFacialPersonality(profile.facialPersonality);
    session.beginPerformance('same-wav-task', 100, mockWav(), text, semantic.emotion, semantic.intensity, semantic);
    const planner = new PerformancePlanner();
    planner.updateVmdEmotionMap(catalog);

    for (const cue of session.getPerformanceCues()) {
      expect(cue.facialEmotion).toBeTruthy();
      expect(resolveSpeechGazeSemantic(cue)).toBeTruthy();
      const coordinated = coordinateSpeechMotionSemantic(cue, cue.facialEmotion);
      const selected = planner.plan({
        emotion: coordinated.emotion,
        intent: coordinated.intent,
        gestureFamily: coordinated.gestureFamily,
        intensity: cue.intensity,
        speaking: true,
        enabledVmdPaths: manifest.motions.customVmd
      }).speakingVmdPath;
      if (selected) {
        const selectedEntry = catalog.find(entry => entry.vmdPath.toLowerCase() === selected.toLowerCase());
        expect(selectedEntry).toBeDefined();
        expect(selectedEntry?.type).toBe('voice');
        expect(selectedEntry?.dialogueSafe).toBe(true);
        expect(safePaths.has(selected.toLowerCase())).toBe(true);
      }
    }
  });
});
