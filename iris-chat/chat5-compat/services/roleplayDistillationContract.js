// owner-trace: wha1999/core/roleplay-distillation-contract

const ROLEPLAY_SECTIONS = Object.freeze([
  { id: 'identity_world', title: '身份、背景与世界' },
  { id: 'personality_values', title: '性格、价值观与内在矛盾' },
  { id: 'speech_style', title: '说话方式、语气与词汇边界' },
  { id: 'relationships', title: '关系网络与互动差异' },
  { id: 'emotional_patterns', title: '情绪触发与行为反应' },
  { id: 'daily_interaction', title: '日常互动与主动关怀方式' },
]);

const SECTION_PATTERNS = Object.freeze({
  identity_world: /身份|背景|世界观|世界/,
  personality_values: /性格|价值观|矛盾|心智模型/,
  speech_style: /说话|表达|语气|词汇|语言.*DNA|表达DNA/,
  relationships: /关系|重要人物|相关人物|人际/,
  emotional_patterns: /情绪|触发|行为模式|反应/,
  daily_interaction: /日常互动|日常行为|主动关怀|聊天习惯|生活互动/,
});

function buildRoleplayDistillationRequirements() {
  return [
    '【角色扮演蒸馏契约 v1.2】只保留会影响对话选择、语气、关系和情绪反应的资料。',
    ...ROLEPLAY_SECTIONS.map((section, index) => `${index + 1}. ## ${section.title}：给出可执行的角色扮演规则，并附证据来源或“待确认”标记。`),
    '重要陈述分为“已确认事实”和“待确认信息”；两条独立可靠来源支持后才能标为已确认。',
    '人物不同机体、服装或战斗形态默认属于同一人物的连续阶段，不得据此编造多重身份或人格切换。',
    '说话方式必须包含：句长与节奏、常用词的适用场景、不会使用的表达、关心/拒绝/解释时的差异。',
    '关系网络必须说明对用户及重要人物的称呼、距离、信任和冲突处理，不能只有人物名单。',
    '日常互动必须避免固定开场、固定意象和每轮括号动作；角色特征体现为选择偏向而非强制模板。',
  ].join('\n');
}

function analyzeRoleplaySkillCoverage(content) {
  const text = String(content || '');
  const coverageBySection = {};
  const missingSections = [];
  for (const section of ROLEPLAY_SECTIONS) {
    const covered = SECTION_PATTERNS[section.id].test(text);
    coverageBySection[section.id] = covered;
    if (!covered) missingSections.push(section.id);
  }
  const warnings = [];
  if (/(?:三重|多重|多个)身份|人格切换|不同机体.{0,12}(?:身份|人格)/.test(text)) {
    warnings.push('检测到把多形态误写为多重身份/人格；应改为同一人物的连续阶段。');
  }
  if (!/已确认事实/.test(text)) warnings.push('缺少“已确认事实”分区。');
  if (!/待确认信息|待确认/.test(text)) warnings.push('缺少“待确认信息”分区。');
  return { coverageBySection, missingSections, warnings };
}

function validateRoleplayDistillationManifest(manifest = {}) {
  const errors = [];
  const citations = Array.isArray(manifest.citations) ? manifest.citations : [];
  if (citations.length === 0) errors.push('citations must include at least one evidence record');
  const coverage = manifest.coverage_by_section || {};
  for (const section of ROLEPLAY_SECTIONS) {
    const value = coverage[section.id];
    const covered = value === true || (value && typeof value === 'object' && (value.covered || value.source_count > 0));
    if (!covered) errors.push(`${section.id} coverage is missing`);
  }
  if (manifest.schema_version && Number.parseFloat(manifest.schema_version) < 1.2) {
    errors.push('schema_version must be at least 1.2');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  ROLEPLAY_SECTIONS,
  buildRoleplayDistillationRequirements,
  analyzeRoleplaySkillCoverage,
  validateRoleplayDistillationManifest,
};
