'use strict';

const SOURCE_FIELDS = Object.freeze([
  'id', 'source', 'title', 'url', 'status', 'warnings', 'source_tier',
  'retrieved_at', 'char_count', 'page_count',
]);

function compactSource(source) {
  const compact = {};
  for (const field of SOURCE_FIELDS) {
    if (source && source[field] !== undefined && source[field] !== null) compact[field] = source[field];
  }
  return compact;
}

function createCompletedDistillTask(characterId, progress, result = {}) {
  const sources = Array.isArray(result.sources) ? result.sources.map(compactSource) : [];
  return {
    status: 'completed',
    characterId: String(characterId),
    progress: String(progress || '蒸馏完成'),
    result: {
      success: true,
      sources,
      sourceCount: Number.isFinite(result.sourceCount) ? result.sourceCount : sources.length,
      successCount: Number.isFinite(result.successCount)
        ? result.successCount
        : sources.filter(source => source.status === 'success').length,
      partialResult: Boolean(result.partialResult),
      warnings: Array.isArray(result.warnings) ? result.warnings.map(String).slice(0, 20) : [],
      coverageBySection: result.coverageBySection && typeof result.coverageBySection === 'object'
        ? result.coverageBySection
        : {},
    },
    error: null,
  };
}

function toPublicDistillTask(task, readSkill) {
  if (!task || task.status !== 'completed' || !task.result?.success) return task;
  let skill = '';
  try {
    skill = String(readSkill(task.characterId) || '');
  } catch {}
  return {
    ...task,
    result: {
      ...task.result,
      skill,
    },
  };
}

module.exports = {
  createCompletedDistillTask,
  toPublicDistillTask,
};
