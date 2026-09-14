import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

describe('roleplayDistillationContract', () => {
  const contract = () => require('../../chat5-compat/services/roleplayDistillationContract.js');

  it('requires six evidence-oriented roleplay sections', () => {
    const { ROLEPLAY_SECTIONS, buildRoleplayDistillationRequirements } = contract();
    expect(ROLEPLAY_SECTIONS.map((section: { id: string }) => section.id)).toEqual([
      'identity_world',
      'personality_values',
      'speech_style',
      'relationships',
      'emotional_patterns',
      'daily_interaction',
    ]);
    const prompt = buildRoleplayDistillationRequirements();
    for (const section of ROLEPLAY_SECTIONS) expect(prompt).toContain(section.title);
    expect(prompt).toContain('已确认事实');
    expect(prompt).toContain('待确认信息');
  });

  it('detects missing coverage and unsupported multiple-identity claims', () => {
    const { analyzeRoleplaySkillCoverage } = contract();
    const result = analyzeRoleplaySkillCoverage('# 角色\n## 身份与世界\n她有三重身份并会切换人格。');
    expect(result.missingSections).toContain('speech_style');
    expect(result.warnings.join('\n')).toContain('多形态');
  });

  it('validates citations and per-section evidence metadata', () => {
    const { validateRoleplayDistillationManifest } = contract();
    const invalid = validateRoleplayDistillationManifest({
      schema_version: '1.2',
      citations: [],
      coverage_by_section: {},
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('citations'),
      expect.stringContaining('speech_style'),
      expect.stringContaining('relationships'),
    ]));
  });

  it('wires schema 1.2 and the roleplay contract into both distillation paths', () => {
    const source = readFileSync(join(process.cwd(), 'chat5-compat', 'services', 'distillService.js'), 'utf8');
    expect(source).toContain("require('./roleplayDistillationContract')");
    expect(source).toContain('buildRoleplayDistillationRequirements()');
    expect(source).toContain('analyzeRoleplaySkillCoverage(skillContent)');
    expect(source).toContain("schema_version: '1.2'");
    expect(source).not.toContain("schema_version: '1.1'");
  });
});
