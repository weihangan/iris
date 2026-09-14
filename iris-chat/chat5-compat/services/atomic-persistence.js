// User-data persistence helpers.
// Every mutable character/settings file is written as UTF-8 without a BOM,
// flushed, and atomically replaced in the same directory.  This keeps a
// crash, antivirus scan, or application restart from exposing a half-written
// file and prevents the packaged defaults from winning a race with user data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Mutable user data must be recoverable even if a test, migration, or manual
// cleanup accidentally writes an older snapshot over it.  Keep an append-only
// copy immediately before replacing the live file.  This is deliberately
// limited to user-facing configuration/history names so ordinary cache and
// audio writes do not create an unbounded journal.
const JOURNALED_BASENAMES = new Set([
  'voice-actions.json', 'model-settings.json', 'motion-deletions.json',
  'settings.json', 'character-voice-map.json', 'current-character.txt',
  'character.md', 'SKILL.md', 'profile.json', 'lore.json', 'api_settings.json',
  '1_memory.json', '1_chat_history.json', '1_compressed_history.json'
]);

function journalTarget(target) {
  if (!JOURNALED_BASENAMES.has(path.basename(target))) return;
  if (!fs.existsSync(target)) return;
  const bytes = fs.readFileSync(target);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const journalDir = path.join(path.dirname(target), '.chatx2-history');
  fs.mkdirSync(journalDir, { recursive: true });
  const prefix = `${path.basename(target)}.${new Date().toISOString().replace(/[:.]/g, '-')}.${digest.slice(0, 16)}`;
  const temporary = path.join(journalDir, `.${prefix}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const snapshot = path.join(journalDir, `${prefix}.bak`);
  try {
    fs.copyFileSync(target, temporary);
    const handle = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, snapshot);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) { /* best effort */ }
  }
}

function assertStrictUtf8Text(value) {
  const text = String(value ?? '');
  if (text.includes('\uFFFD')) throw new Error('replacement character is not valid user data');
  // Buffer.from silently replaces an unpaired surrogate. Reject it instead.
  if (/[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) {
    throw new Error('unpaired UTF-16 surrogate is not valid user data');
  }
  return text;
}

function writeUtf8Atomic(filePath, value) {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const text = assertStrictUtf8Text(value);
  const bytes = Buffer.from(text, 'utf8');
  const temporary = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let handle = null;
  try {
    handle = fs.openSync(temporary, 'wx');
    fs.writeSync(handle, bytes, 0, bytes.length, 0);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    // A failed journal must abort the replacement; silently losing the last
    // known-good user configuration is worse than surfacing the write error.
    journalTarget(target);
    fs.renameSync(temporary, target);
    const persisted = fs.readFileSync(target);
    if (!persisted.equals(bytes)) {
      throw new Error(`atomic persistence verification failed: ${target}`);
    }
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch (_) { /* best effort */ }
    }
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) { /* best effort */ }
  }
  return true;
}

function writeJsonAtomic(filePath, value) {
  const text = JSON.stringify(value, null, 2);
  const result = writeUtf8Atomic(filePath, text);
  const verified = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  if (JSON.stringify(verified) !== JSON.stringify(value)) {
    throw new Error(`JSON persistence verification failed: ${path.resolve(filePath)}`);
  }
  return result;
}

module.exports = { writeUtf8Atomic, writeJsonAtomic, assertStrictUtf8Text };
