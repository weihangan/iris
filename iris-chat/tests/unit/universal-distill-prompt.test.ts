import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

describe('universal character distillation prompt', () => {
  it('exposes a reusable evidence-to-behavior prompt for every character type', () => {
    const { buildUniversalDistillPrompt } = require('../../chat5-compat/services/distillPrompt.js');
    const prompt = buildUniversalDistillPrompt({
      name: '测试角色',
      typeHint: '游戏角色',
      charInfo: '角色信息',
      researchData: '研究资料',
      existingSkill: '',
      today: '2026-08-29',
    });

    expect(prompt).toContain('情境 → 行为 → 动机');
    expect(prompt).toContain('用户明确设定');
    expect(prompt).toContain('确认事实');
    expect(prompt).toContain('待确认');
    expect(prompt).toContain('防重复');
    expect(prompt).toContain('不同角色');
    expect(prompt).toContain('台词参考');
    expect(prompt).toContain('好感度（信赖度）类台词优先');
    expect(prompt).toContain('世界观速览');
    expect(prompt).toContain('日常习惯与感官细节');
    expect(prompt).toContain('亲密与触碰反应');
    expect(prompt).toContain('场景反应速查');
    expect(prompt).toContain('重要日期与纪念日');
    expect(prompt).toContain('禁止编造具体日期');
    expect(prompt).toContain('不要输出其他内容');
  });

  it('routes web distillation through the universal prompt instead of the legacy template', () => {
    const source = readFileSync(join(process.cwd(), 'chat5-compat', 'services', 'distillService.js'), 'utf8');
    expect(source).toContain('buildUniversalDistillPrompt');
    expect(source).toContain('UNIVERSAL_DISTILL_SYSTEM_PROMPT');
    expect(source).not.toContain('buildWebDistillPrompt(');
    expect(source).not.toContain('女娲·Skill造人术');
  });

  it('uses the same behavior framework for user-provided custom material', () => {
    const { buildUniversalCustomDistillPrompt } = require('../../chat5-compat/services/distillPrompt.js');
    const prompt = buildUniversalCustomDistillPrompt({
      name: '真实人物',
      relationship: '朋友',
      purpose: 'neutral',
      inputData: '聊天记录：今天先这样，明天再说。',
      existingSkill: '',
      today: '2026-08-29',
    });
    expect(prompt).toContain('情境 → 行为 → 动机');
    expect(prompt).toContain('用户提供的一手素材');
    expect(prompt).toContain('聊天习惯');
    expect(prompt).toContain('不要编造');
    expect(prompt).toContain('不要输出其他内容');
  });

  it('routes custom distillation through the shared custom prompt', () => {
    const source = readFileSync(join(process.cwd(), 'chat5-compat', 'services', 'distillService.js'), 'utf8');
    expect(source).toContain('buildUniversalCustomDistillPrompt');
    expect(source).not.toContain('buildCustomDistillPrompt(');
  });

  it('keeps the independently registered Selena 1.0 character available', () => {
    const profile = JSON.parse(readFileSync(join(process.cwd(), 'chat5-compat', 'character', '3', 'profile.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'chat5-compat', 'character', '3', 'manifest.json'), 'utf8'));
    expect(profile.name).toBe('赛琳娜1.0');
    expect(manifest.character_id).toBe('3');
  });
});
