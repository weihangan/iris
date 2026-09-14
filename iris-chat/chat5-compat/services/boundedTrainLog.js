'use strict';

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Buffer.byteLength(String(value || ''), 'utf8');
  }
}

function fitEntryToBytes(entry, maxBytes) {
  if (byteLength(entry) <= maxBytes || !entry || typeof entry !== 'object') return entry;
  const fitted = { ...entry };
  if (typeof fitted.msg === 'string') {
    const suffix = '\n…（过长日志已截断）';
    let low = 0;
    let high = fitted.msg.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (byteLength({ ...fitted, msg: fitted.msg.slice(-mid) + suffix }) <= maxBytes) low = mid;
      else high = mid - 1;
    }
    fitted.msg = fitted.msg.slice(-low) + suffix;
  }
  return byteLength(fitted) <= maxBytes
    ? fitted
    : { stage: fitted.stage || 'log', status: fitted.status || 'running', msg: '…（过长日志已截断）' };
}

function ensureTrainLogState(job) {
  if (!job || typeof job !== 'object') throw new TypeError('job must be an object');
  if (!Array.isArray(job.logs)) job.logs = [];
  if (!Array.isArray(job.logEntryBytes) || job.logEntryBytes.length !== job.logs.length) {
    job.logEntryBytes = job.logs.map(byteLength);
  }
  if (!Number.isFinite(job.logBaseIndex) || job.logBaseIndex < 0) job.logBaseIndex = 0;
  job.logBytes = job.logEntryBytes.reduce((sum, size) => sum + size, 0);
  return job;
}

function appendTrainLog(job, entry, options = {}) {
  ensureTrainLogState(job);
  const maxEntries = Math.max(1, Math.trunc(Number(options.maxEntries) || DEFAULT_MAX_ENTRIES));
  const maxBytes = Math.max(1, Math.trunc(Number(options.maxBytes) || DEFAULT_MAX_BYTES));
  const retainedEntry = fitEntryToBytes(entry, maxBytes);
  const entryBytes = byteLength(retainedEntry);
  job.logs.push(retainedEntry);
  job.logEntryBytes.push(entryBytes);
  job.logBytes += entryBytes;

  while (job.logs.length > 1 && (job.logs.length > maxEntries || job.logBytes > maxBytes)) {
    job.logs.shift();
    job.logBytes -= job.logEntryBytes.shift() || 0;
    job.logBaseIndex++;
  }
}

function readTrainLogsSince(job, cursor = 0) {
  ensureTrainLogState(job);
  const baseIndex = job.logBaseIndex;
  const tailIndex = baseIndex + job.logs.length;
  const requested = Math.max(0, Math.trunc(Number(cursor) || 0));
  const safeCursor = Math.max(baseIndex, Math.min(requested, tailIndex));
  return {
    entries: job.logs.slice(safeCursor - baseIndex),
    nextCursor: tailIndex,
    droppedBeforeCursor: requested < baseIndex,
  };
}

function resetTrainLogs(job) {
  if (!job || typeof job !== 'object') throw new TypeError('job must be an object');
  job.logs = [];
  job.logEntryBytes = [];
  job.logBaseIndex = 0;
  job.logBytes = 0;
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_BYTES,
  appendTrainLog,
  readTrainLogsSince,
  resetTrainLogs,
};
