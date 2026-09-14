function createTtsWarmupController({ synthesize, cleanup, logger = console }) {
  if (typeof synthesize !== 'function') throw new TypeError('synthesize must be a function');
  if (typeof cleanup !== 'function') throw new TypeError('cleanup must be a function');
  const attempts = new Map();

  async function warm({ device, instanceId, voiceName, serviceStatus }) {
    if (String(device || '').toLowerCase() !== 'gpu') {
      return { skipped: true, reason: 'cpu-device' };
    }
    const key = String(instanceId || '').trim();
    if (!key) return { skipped: true, reason: 'missing-instance-id' };

    // The Python service performs one warmup during startup.  Do not immediately
    // synthesize the same greeting again from Node when that warmup used the
    // voice currently requested by the character.  A missing/older status field
    // deliberately falls through so older services retain the safe behavior.
    const warmedVoice = String(serviceStatus?.warmup_voice || '').trim();
    if (serviceStatus?.warmup_complete === true && warmedVoice &&
        (!voiceName || warmedVoice === String(voiceName).trim())) {
      attempts.set(key, Promise.resolve({ skipped: true, reason: 'already-warm' }));
      return { skipped: true, reason: 'already-warm' };
    }
    if (attempts.has(key)) return { skipped: true, reason: 'already-attempted' };

    const task = (async () => {
      let localPath = null;
      try {
        const result = await synthesize({
          text: '你好，准备好了。',
          emotion: 'gentle',
          ...(voiceName ? { voice_name: voiceName } : {})
        });
        localPath = typeof result?.local_path === 'string' ? result.local_path : null;
        return { success: true };
      } catch (error) {
        logger.warn?.('[TTS warmup] failed:', error?.message || error);
        return { success: false, error: error?.message || String(error) };
      } finally {
        if (localPath) {
          try { await cleanup(localPath); }
          catch (error) { logger.warn?.('[TTS warmup] cleanup failed:', error?.message || error); }
        }
      }
    })();
    attempts.set(key, task);
    return task;
  }

  return { warm };
}

module.exports = { createTtsWarmupController };
