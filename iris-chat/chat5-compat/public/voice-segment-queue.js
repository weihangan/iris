/**
 * Shared voice segmentation and grouped scheduling helpers.
 * The browser and the ChatX2 server use the same rules:
 * - one reply is a group and its segments may run together;
 * - different replies remain FIFO;
 * - an ungrouped task is its own serial group.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceSegmentQueue = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function removeNonSpeech(value) {
    return String(value == null ? '' : value)
      // Stage directions/parenthetical asides are not spoken characters.
      .replace(/（[^）]*）/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
  }

  function getSpeakableLength(value) {
    return removeNonSpeech(value).length;
  }

  function getDefaultSegmentLimit(speakableLength) {
    if (speakableLength < 40) return 1;
    if (speakableLength < 70) return 2;
    if (speakableLength < 100) return 3;
    return 4;
  }

  function findEllipsisAnchoredSplit(text, ellipsis, speakableLength, minSegmentLength) {
    const beforeLength = getSpeakableLength(text.slice(0, ellipsis.index));
    const positionRatio = speakableLength > 0 ? beforeLength / speakableLength : 0;
    // An ellipsis is only a useful anchor when it appears around the middle;
    // otherwise it should not force an unnatural early/late split.
    if (positionRatio < 0.35 || positionRatio > 0.7) return null;
    const targetLength = Math.ceil(speakableLength * 0.45);
    const boundary = /[。！？!?；;，,]/gu;
    let fallback = null;
    let nearest = null;
    let match;
    while ((match = boundary.exec(text))) {
      if (match.index <= ellipsis.index) continue;
      const cut = match.index + match[0].length;
      const first = text.slice(0, cut).trim();
      const second = text.slice(cut).trim();
      const firstLength = getSpeakableLength(first);
      if (getSpeakableLength(second) < minSegmentLength) continue;
      const candidate = [first, second];
      if (!fallback) fallback = candidate;
      // Prefer the same 35%-50% first-segment window as ordinary replies.
      // The authored ellipsis remains a soft anchor, so only use a later
      // boundary when it is still inside the playable balance window.
      const minFirst = speakableLength >= 50 ? 23 : Math.ceil(speakableLength * 0.35);
      if (firstLength >= minFirst && firstLength <= speakableLength * 0.5) return candidate;
      if (!nearest || Math.abs(firstLength - targetLength) < nearest.score) {
        nearest = { value: candidate, score: Math.abs(firstLength - targetLength) };
      }
    }
    return nearest?.value || fallback;
  }

  function balanceTwoParts(parts, minSegmentLength) {
    if (!Array.isArray(parts) || parts.length < 2) return parts;
    const total = getSpeakableLength(parts.join(''));
    const lowerRatio = 0.35;
    const upperRatio = 0.5;
    const minFirst = total >= 50 ? 23 : Math.ceil(total * lowerRatio);
    const target = total >= 40 ? 23 : total * 0.45;
    let best = null;
    let minFirstCandidate = null;
    let fallback = null;
    for (let i = 1; i < parts.length; i++) {
      const first = parts.slice(0, i).join('');
      const second = parts.slice(i).join('');
      const firstLength = getSpeakableLength(first);
      const secondLength = getSpeakableLength(second);
      if (firstLength < minSegmentLength || secondLength < minSegmentLength) continue;
      const score = Math.abs(firstLength - target);
      if (!fallback || score < fallback.score) fallback = { first, second, score };
      if (total >= 40 && firstLength >= 23 && (!minFirstCandidate || score < minFirstCandidate.score)) {
        minFirstCandidate = { first, second, score };
      }
      const inWindow = firstLength >= minFirst && firstLength >= total * lowerRatio && firstLength <= total * upperRatio;
      if (inWindow && (!best || score < best.score)) best = { first, second, score };
    }
    // For 40-49 character replies, a 23-character first segment cannot also
    // always be <=50%. Prefer the useful 23+ natural split over an overly short
    // first clip when no strict-window boundary exists.
    const chosen = best || minFirstCandidate || fallback;
    return chosen ? [chosen.first, chosen.second] : parts;
  }

  function splitVoiceText(value, options) {
    const opts = options || {};
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const speakableLength = getSpeakableLength(text);
    const minTotalLength = Number.isFinite(opts.minTotalLength) ? opts.minTotalLength : 40;
    const maxSegments = Number.isFinite(opts.maxSegments)
      ? Math.max(1, Math.floor(opts.maxSegments))
      : getDefaultSegmentLimit(speakableLength);
    const minSegmentLength = Math.max(1, Math.floor(opts.minSegmentLength || 8));
    if (speakableLength < minTotalLength || maxSegments < 2) return [text];

    // An ellipsis is an authored pacing hint, not a hard boundary. Start
    // searching after it and cut at a later natural pause without forcing a
    // hard split exactly on the ellipsis.
    const ellipsis = /(?:……+|\.{2,}|．{2,})/u.exec(text);
    if (ellipsis && maxSegments >= 2) {
      const anchored = findEllipsisAnchoredSplit(text, ellipsis, speakableLength, minSegmentLength);
      if (anchored) return anchored;
    }

    let parts = text
      .split(/(?<=[。！？!?；;])\s*/u)
      .map(part => part.trim())
      .filter(Boolean);

    // A long sentence without a full stop can still be streamed at a comma.
    if (parts.length === 1 && parts[0].length > minTotalLength) {
      const source = parts[0];
      const commaParts = source
        .split(/(?<=[，、,])\s*/u)
        .map(part => part.trim())
        .filter(Boolean);
      if (commaParts.length > 1) parts = commaParts;
    }

    // Keep short fragments attached to their neighbour; isolated particles
    // create poor TTS prosody and should not become their own request.
    const merged = [];
    for (const part of parts) {
      if (merged.length && part.length < minSegmentLength) merged[merged.length - 1] += part;
      else merged.push(part);
    }
    if (merged.length > 1 && merged[0].length < minSegmentLength) {
      merged[1] = merged[0] + merged[1];
      merged.shift();
    }

    if (maxSegments === 2 && merged.length > 1) {
      let candidates = merged;
      const firstLength = getSpeakableLength(merged[0]);
      if (speakableLength >= 40 && (firstLength < 23 || firstLength > 28)) {
        candidates = text
          .split(/(?<=[。！？!?；;，、,])\s*/u)
          .map(part => part.trim())
          .filter(Boolean);
      }
      return balanceTwoParts(candidates, minSegmentLength);
    }

    // For 3/4-part replies, keep the first request small enough to start
    // promptly as well. Rebuild only from authored punctuation boundaries;
    // the remaining fragments are then merged back to the existing limit.
    if (speakableLength >= 40 && merged.length > 1 &&
      (getSpeakableLength(merged[0]) > 30 ||
       (merged.length > maxSegments && getSpeakableLength(merged[0]) + getSpeakableLength(merged[1]) > 30))) {
      const fineParts = text
        .split(/(?<=[。！？!?；;，、,])\s*/u)
        .map(part => part.trim())
        .filter(Boolean);
      let prefixEnd = -1;
      let bestDistance = Infinity;
      let running = 0;
      for (let i = 0; i < fineParts.length - 1; i++) {
        running += getSpeakableLength(fineParts[i]);
        if (running < 18 || running > 28) continue;
        const distance = Math.abs(running - 23);
        if (distance < bestDistance) { bestDistance = distance; prefixEnd = i; }
      }
      if (prefixEnd >= 0) {
        const capped = [fineParts.slice(0, prefixEnd + 1).join(''), ...fineParts.slice(prefixEnd + 1)];
        while (capped.length > maxSegments) {
          let best = 1;
          for (let i = 2; i < capped.length - 1; i++) {
            if (capped[i].length < capped[best].length) best = i;
          }
          capped[best] = capped[best] + capped[best + 1];
          capped.splice(best + 1, 1);
        }
        return capped;
      }
    }

    // Bound the number of requests while preserving order.
    while (merged.length > maxSegments) {
      let best = 0;
      for (let i = 1; i < merged.length - 1; i++) {
        if (merged[i].length < merged[best].length) best = i;
      }
      merged[best] = merged[best] + merged[best + 1];
      merged.splice(best + 1, 1);
    }
    return merged.length ? merged : [text];
  }

  function createGroupedTaskQueue(options) {
    const maxPending = Number.isFinite(options && options.maxPending)
      ? Math.max(0, Math.floor(options.maxPending))
      : Infinity;
    const queue = [];
    let activeGroup = null;
    let activeCount = 0;
    let nextId = 0;

    const cancelledResult = () => ({
      success: false,
      cancelled: true,
      errorCode: 'VOICE_CANCELLED',
      error: '已取消等待',
    });

    function finishGroupIfIdle() {
      if (activeCount === 0) activeGroup = null;
    }

    function start(item) {
      if (item.token && item.token.cancelled) {
        item.resolve(cancelledResult());
        return;
      }
      if (item.token) item.token.started = true;
      activeCount++;
      Promise.resolve().then(item.run).then(item.resolve, item.reject).finally(() => {
        activeCount--;
        finishGroupIfIdle();
        drain();
      });
    }

    function drain() {
      // Drop cancelled queued items before selecting the next group.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].token && queue[i].token.cancelled) {
          const item = queue.splice(i, 1)[0];
          item.resolve(cancelledResult());
        }
      }
      if (activeGroup === null) {
        const first = queue.shift();
        if (!first) return;
        activeGroup = first.groupKey;
        start(first);
      }
      // Start every queued segment belonging to this reply. Other replies
      // remain queued until the whole active group is complete.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].groupKey !== activeGroup) continue;
        const item = queue.splice(i, 1)[0];
        start(item);
      }
    }

    function enqueue(run, optionsForTask) {
      const opts = optionsForTask || {};
      if (queue.length >= maxPending) {
        return Promise.resolve({
          success: false,
          errorCode: 'VOICE_QUEUE_FULL',
          error: `等待中的语音最多 ${maxPending} 条`,
        });
      }
      const token = opts.token || { cancelled: false, started: false };
      const groupKey = opts.groupId || `__single_${++nextId}`;
      const item = { run, token, groupKey, resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => {
        item.resolve = resolve;
        item.reject = reject;
        queue.push(item);
        drain();
      });
      promise.cancel = () => {
        if (token.started) return false;
        token.cancelled = true;
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        item.resolve(cancelledResult());
        drain();
        return true;
      };
      token.cancel = promise.cancel;
      return promise;
    }

    return {
      enqueue,
      get busy() { return activeCount > 0 || queue.length > 0 || activeGroup !== null; },
      get pendingCount() { return queue.length; },
    };
  }

  function getContiguousReadyCount(states) {
    let count = 0;
    for (const state of states || []) {
      if (state !== 'ready' && state !== 'failed') break;
      if (state === 'ready') count++;
      else break;
    }
    return count;
  }

  function getSegmentProgressState(states) {
    const list = Array.isArray(states) ? states : [];
    if (!list.length || list.every(state => state === 'pending' || state === 'loading')) return 'idle';
    if (list.some(state => state === 'failed')) return 'failed';
    if (list.every(state => state === 'ready')) return 'complete';
    return getContiguousReadyCount(list) > 0 ? 'partial' : 'idle';
  }

  return { splitVoiceText, createGroupedTaskQueue, getContiguousReadyCount, getSegmentProgressState, getSpeakableLength };
});
