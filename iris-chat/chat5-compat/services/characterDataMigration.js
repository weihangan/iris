// owner-trace: wha1999/core/character-data-migration
const fs = require('fs');
const path = require('path');
const { writeUtf8Atomic, writeJsonAtomic } = require('./atomic-persistence');

const MIGRATION_ID = 'roleplay-chat-rules-v1';

const KNOWN_GENERATED_REPLACEMENTS = Object.freeze({
  'character.md': [
    [
      '她并非官方角色，这是一场非官方的同人角色模拟。她不声称自己代表游戏官方设定，也不编造官方剧情结论。',
      '她是原作角色赛琳娜。对话以用户设定和有证据的角色资料为准；不确定的剧情信息明确标为不确定，不伪造官方结论。',
    ],
    [
      '句式多温柔设问、轻声感叹，习惯先共情对方再表达观点：“我能明白这份煎熬，倘若换作是我，也会心生迷茫”。',
      '句式温和克制，先回应用户实际内容；只有用户明确表达强烈情绪时才简短共情，不把共情写成固定开场。',
    ],
  ],
  'SKILL.md': [
    ['涵盖三重身份（歌剧家→考古队员→塞壬）的核心心智、情感触发点、关系网络和表达DNA。', '涵盖连续经历阶段（歌剧家→考古队员→受红潮影响时期）的核心心智、情感触发点、关系网络和表达DNA。'],
    ['### 三重身份（不可分割，三者共存）', '### 连续经历阶段（同一人物、同一记忆）'],
    ['1. **先共情，后表达**：回应前先理解对方情绪，用"我能明白……"开头，而非直接给建议。', '1. **先回应当前内容**：直接接住用户的问题或信息；只有用户明确表达强烈情绪时才简短共情，不使用固定开场。'],
    ['2. **用音乐说话**：语言无法表达时，用哼唱、演奏或引用诗句代替。', '2. **音乐是低频角色意象**：仅在用户谈到音乐、演出、创作或共同回忆时自然使用，不替代日常回答。'],
    ['- **日常口语**：先共情铺垫（1-2句），再表达观点（1-2句），最后留白', '- **日常口语**：直接回应当前内容，再按需要表达观点；不固定共情铺垫，结尾自然留白'],
    ['- **非官方设定**：赛琳娜并非官方角色，这是一个基于游戏内碎片信息、玩家共识和同人创作整合的深度演绎版本。不声称代表游戏官方设定，也不编造官方剧情结论。', '- **资料边界**：赛琳娜是原作角色；本Skill区分官方资料、用户设定与推断，不确定内容明确标注，不伪造官方剧情结论。'],
  ],
});

function readMarker(dataDir) {
  const markerPath = path.join(dataDir, 'character_data_migrations.json');
  try {
    return { markerPath, exists: true, data: JSON.parse(fs.readFileSync(markerPath, 'utf8')) };
  } catch {
    // A present-but-invalid marker is still treated as user-owned state. Do
    // not run generated replacements over character files and destroy edits.
    return { markerPath, exists: fs.existsSync(markerPath), data: { applied: {} }, invalid: fs.existsSync(markerPath) };
  }
}

function migrateFile(filePath, replacements) {
  if (!fs.existsSync(filePath)) return false;
  const original = fs.readFileSync(filePath, 'utf8');
  let updated = original;
  for (const [stale, replacement] of replacements) updated = updated.split(stale).join(replacement);
  if (updated === original) return false;
  const backupPath = `${filePath}.before-${MIGRATION_ID}.bak`;
  if (!fs.existsSync(backupPath)) writeUtf8Atomic(backupPath, original);
  writeUtf8Atomic(filePath, updated);
  return true;
}

function runCharacterDataMigrations(options = {}) {
  const characterDir = options.characterDir;
  const dataDir = options.dataDir;
  if (!characterDir || !dataDir) return { migrationId: MIGRATION_ID, changedFiles: [], skipped: true };
  fs.mkdirSync(characterDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const marker = readMarker(dataDir);
  const previous = marker.data.applied?.[MIGRATION_ID];
  // Migrations are one-time transformations. Once the marker exists, the
  // user's character files are authoritative forever; checking/replacing
  // generated phrases on every startup was silently undoing edits.
  if (marker.exists && (marker.invalid || previous)) {
    return {
      migrationId: MIGRATION_ID,
      changedFiles: [],
      skipped: true,
      reason: marker.invalid ? 'invalid-marker-preserve-user-data' : 'already-applied'
    };
  }
  const changedFiles = [];
  const backedUpFiles = [];

  for (const entry of fs.readdirSync(characterDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const [filename, replacements] of Object.entries(KNOWN_GENERATED_REPLACEMENTS)) {
      const filePath = path.join(characterDir, entry.name, filename);
      if (migrateFile(filePath, replacements)) changedFiles.push(filePath);
      if (fs.existsSync(`${filePath}.before-${MIGRATION_ID}.bak`)) backedUpFiles.push(filePath);
    }
  }

  marker.data.applied = marker.data.applied || {};
  const applied = marker.data.applied[MIGRATION_ID] || {};
  const currentRelativeFiles = changedFiles.map(file => path.relative(characterDir, file));
  const historicalRelativeFiles = backedUpFiles.map(file => path.relative(characterDir, file));
  marker.data.applied[MIGRATION_ID] = {
    appliedAt: applied.appliedAt || new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    changedFiles: currentRelativeFiles.length > 0
      ? currentRelativeFiles
      : (applied.changedFiles?.length ? applied.changedFiles : historicalRelativeFiles),
  };
  writeJsonAtomic(marker.markerPath, marker.data);
  return { migrationId: MIGRATION_ID, changedFiles, skipped: false };
}

module.exports = {
  MIGRATION_ID,
  KNOWN_GENERATED_REPLACEMENTS,
  runCharacterDataMigrations,
};
