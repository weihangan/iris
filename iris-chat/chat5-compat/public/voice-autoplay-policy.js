(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VoiceAutoplayPolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_LEDGER_LIMIT = 200;

  function normalizeKey(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || '').trim();
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function createVoiceMessageKey(characterId, messageIndex, text) {
    const character = normalizeKey(String(characterId ?? '')) || 'default';
    const index = Number.isFinite(Number(messageIndex)) ? Math.max(0, Math.trunc(Number(messageIndex))) : 0;
    return `${character}:${index}:${hashText(text)}`;
  }

  function normalizeHandledMessageKeys(values, limit = DEFAULT_LEDGER_LIMIT) {
    const safeLimit = Math.max(1, Math.trunc(Number(limit) || DEFAULT_LEDGER_LIMIT));
    const unique = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const key = normalizeKey(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(key);
    }
    return unique.slice(-safeLimit);
  }

  function parseHandledMessageKeys(raw, limit = DEFAULT_LEDGER_LIMIT) {
    if (!raw) return [];
    try {
      return normalizeHandledMessageKeys(JSON.parse(raw), limit);
    } catch {
      return [];
    }
  }

  function addHandledMessageKey(values, value, limit = DEFAULT_LEDGER_LIMIT) {
    const key = normalizeKey(value);
    const current = normalizeHandledMessageKeys(values, limit).filter(entry => entry !== key);
    if (key) current.push(key);
    return normalizeHandledMessageKeys(current, limit);
  }

  function shouldAutoPlayLatest(options = {}) {
    return Boolean(
      options.enabled
      && options.isLatest
      && options.hasAudio
      && options.voiceEnabled
      && !options.stopped
      && !options.playing
      && !options.alreadyHandled
    );
  }

  function shouldAutoPlaySynthesisResult(options = {}) {
    return Boolean(
      !options.alreadyHandled
      && (options.isRealtime || !options.cached)
    );
  }

  function getPreSynthesisCount(autoPlayEnabled, defaultCount) {
    if (autoPlayEnabled) return 1;
    return Math.max(0, Math.trunc(Number(defaultCount) || 0));
  }

  function createBoundedAudioPreloadCache(options = {}) {
    const limit = Math.max(1, Math.trunc(Number(options.limit) || 1));
    const createAudio = typeof options.createAudio === 'function'
      ? options.createAudio
      : (url) => new Audio(url);
    const entries = new Map();

    function dispose(audio) {
      if (!audio) return;
      try { if (typeof audio.pause === 'function') audio.pause(); } catch {}
      try { audio.src = ''; } catch {}
      try { if (typeof audio.load === 'function') audio.load(); } catch {}
    }

    function remove(url) {
      const audio = entries.get(url);
      if (!audio) return false;
      entries.delete(url);
      dispose(audio);
      return true;
    }

    return {
      get size() {
        return entries.size;
      },
      has(url) {
        return entries.has(String(url || ''));
      },
      preload(url) {
        const key = String(url || '').trim();
        if (!key) return null;
        if (entries.has(key)) return entries.get(key);
        let audio;
        try {
          audio = createAudio(key);
          audio.preload = 'auto';
        } catch {
          return null;
        }
        entries.set(key, audio);
        while (entries.size > limit) {
          const oldest = entries.keys().next().value;
          if (!oldest) break;
          remove(oldest);
        }
        return audio;
      },
      reconcile(urls) {
        const valid = new Set(Array.from(urls || [], value => String(value || '').trim()).filter(Boolean));
        let removed = 0;
        for (const url of Array.from(entries.keys())) {
          if (!valid.has(url) && remove(url)) removed++;
        }
        return removed;
      },
      clear() {
        const removed = entries.size;
        for (const url of Array.from(entries.keys())) remove(url);
        return removed;
      }
    };
  }

  return {
    shouldAutoPlayLatest,
    shouldAutoPlaySynthesisResult,
    getPreSynthesisCount,
    createVoiceMessageKey,
    parseHandledMessageKeys,
    addHandledMessageKey,
    createBoundedAudioPreloadCache
  };
}));
