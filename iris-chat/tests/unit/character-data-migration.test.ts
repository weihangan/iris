import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('characterDataMigration', () => {
  it('repairs only known generated clauses and is idempotent', () => {
    const { runCharacterDataMigrations } = require('../../chat5-compat/services/characterDataMigration.js');
    const root = mkdtempSync(join(tmpdir(), 'chatx2-migration-'));
    const bundledCharacterDir = join(root, 'bundled');
    const characterDir = join(root, 'characters');
    const dataDir = join(root, 'data');
    mkdirSync(join(characterDir, '1'), { recursive: true });
    mkdirSync(bundledCharacterDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const staleSkill = [
      '# 用户自己的标题',
      '### 三重身份（不可分割，三者共存）',
      '1. **先共情，后表达**：回应前先理解对方情绪，用"我能明白……"开头，而非直接给建议。',
      '2. **用音乐说话**：语言无法表达时，用哼唱、演奏或引用诗句代替。',
      '这句用户文字必须保留。',
    ].join('\n');
    const profile = '{"user_title":"指挥","user_cognition":"用户自己的设定"}';
    const memory = '{"permanent_facts":["不能丢"]}';
    writeFileSync(join(characterDir, '1', 'SKILL.md'), staleSkill, 'utf8');
    writeFileSync(join(characterDir, '1', 'profile.json'), profile, 'utf8');
    writeFileSync(join(dataDir, '1_memory.json'), memory, 'utf8');

    const first = runCharacterDataMigrations({ bundledCharacterDir, characterDir, dataDir });
    const migrated = readFileSync(join(characterDir, '1', 'SKILL.md'), 'utf8');
    const second = runCharacterDataMigrations({ bundledCharacterDir, characterDir, dataDir });

    expect(first.changedFiles).toHaveLength(1);
    expect(migrated).toContain('连续经历阶段');
    expect(migrated).toContain('只有用户明确表达强烈情绪时');
    expect(migrated).toContain('音乐是低频角色意象');
    expect(migrated).toContain('这句用户文字必须保留。');
    expect(readFileSync(join(characterDir, '1', 'profile.json'), 'utf8')).toBe(profile);
    expect(readFileSync(join(dataDir, '1_memory.json'), 'utf8')).toBe(memory);
    expect(second.changedFiles).toHaveLength(0);
    const marker = JSON.parse(readFileSync(join(dataDir, 'character_data_migrations.json'), 'utf8'));
    expect(marker.applied['roleplay-chat-rules-v1'].changedFiles).toEqual(['1\\SKILL.md']);
  });

  it('runs the migration only after the external userData layout exists', () => {
    const source = readFileSync(join(process.cwd(), 'chat5-compat', 'services', 'appPaths.js'), 'utf8');
    const ensureIndex = source.indexOf('ensureUserDataLayout();');
    const migrationIndex = source.indexOf('runCharacterDataMigrations({');

    expect(source).toContain("require('./characterDataMigration')");
    expect(migrationIndex).toBeGreaterThan(ensureIndex);
    expect(source.slice(migrationIndex - 120, migrationIndex)).toContain('HAS_EXTERNAL_USER_DATA');
  });

  it('merges newly bundled character folders without overwriting existing user characters', () => {
    const source = readFileSync(join(process.cwd(), 'chat5-compat', 'services', 'appPaths.js'), 'utf8');
    expect(source).toContain('readdirSync(BUNDLED_CHARACTER_DIR');
    expect(source).toContain('if (!fs.existsSync(target)) fs.cpSync(source, target');
  });
});
