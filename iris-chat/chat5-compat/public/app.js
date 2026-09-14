(function () {
  const logicalCoreCount = Number(navigator.hardwareConcurrency || 0);
  const prefersReducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const isLowPerformanceDevice = prefersReducedMotion
    || (logicalCoreCount > 0 && logicalCoreCount <= 8);
  if (isLowPerformanceDevice) document.documentElement.classList.add('low-performance-mode');
  const AUTO_PRE_SYNTH_COUNT = isLowPerformanceDevice ? 0 : 1;
  const VOICE_PRELOAD_LIMIT = isLowPerformanceDevice ? 3 : 8;
  // Recovery is a local metadata lookup, not TTS synthesis. Cover the full
  // supported per-character retention window so stored voices return as green
  // playable buttons after restart.
  const VOICE_CACHE_RECOVERY_LIMIT = isLowPerformanceDevice ? 50 : 120;

  const pageChat = document.getElementById('page-chat');
  const pageSettings = document.getElementById('page-settings');
  const pageCharacters = document.getElementById('page-characters');
  const messagesEl = document.getElementById('messages');
  const chatArea = document.getElementById('chat-area');
  const chatContainer = document.querySelector('.chat-container');
  const msgInput = document.getElementById('msg-input');
  const btnSend = document.getElementById('btn-send');
  const btnVoiceInput = document.getElementById('btn-voice-input');
  const btnBack = document.getElementById('btn-back');
  const btnSettingsBack = document.getElementById('btn-settings-back');
  const btnCharsBack = document.getElementById('btn-chars-back');
  const btnCharSwitch = document.getElementById('btn-char-switch');
  const btnClear = document.getElementById('btn-clear');
  const confirmModal = document.getElementById('confirm-modal');
  const btnPlus = document.getElementById('btn-plus');
  const fileImage = document.getElementById('file-image');
  const imagePreviewBar = document.getElementById('image-preview-bar');
  const previewImg = document.getElementById('preview-img');
  const btnRemovePreview = document.getElementById('btn-remove-preview');
  const chatHeader = document.getElementById('chat-header');
  const headerTriggerZone = document.getElementById('header-trigger-zone');
  const btnVoiceToggle = document.getElementById('btn-voice-toggle');
  const btnVoiceAutoplay = document.getElementById('btn-voice-autoplay');
  // 颜文字面板元素
  const btnKaomoji = document.getElementById('btn-kaomoji');
  const kaomojiPanel = document.getElementById('kaomoji-panel');
  const kaomojiList = document.getElementById('kaomoji-list');

  // 正式聊天窗口的语音输入。音频只在内存中转写，不自动发送；30 秒后强制停止。
  function setupVoiceInput() {
    if (!btnVoiceInput || !msgInput) return;

    const MAX_RECORDING_MS = 30_000;
    const bridgeReady = window.chatx2 && typeof window.chatx2.transcribeVoiceInput === 'function';
    const recordingReady = navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function'
      && typeof window.MediaRecorder === 'function';
    if (!bridgeReady || !recordingReady) {
      btnVoiceInput.disabled = true;
      btnVoiceInput.title = !bridgeReady ? '当前窗口不支持语音转写' : '当前系统不支持麦克风录音';
      btnVoiceInput.setAttribute('aria-label', btnVoiceInput.title);
      return;
    }

    let state = 'idle';
    let stream = null;
    let recorder = null;
    let chunks = [];
    let stopTimer = null;
    let operationId = 0;

    function releaseStream() {
      if (!stream) return;
      stream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (_) { /* 已释放 */ }
      });
      stream = null;
    }

    function clearStopTimer() {
      if (stopTimer !== null) clearTimeout(stopTimer);
      stopTimer = null;
    }

    function renderState(nextState) {
      state = nextState;
      btnVoiceInput.classList.toggle('recording', state === 'recording');
      btnVoiceInput.classList.toggle('transcribing', state === 'transcribing');
      btnVoiceInput.disabled = state === 'requesting' || state === 'transcribing';
      btnVoiceInput.setAttribute('aria-pressed', state === 'recording' ? 'true' : 'false');
      btnVoiceInput.setAttribute('aria-busy', state === 'requesting' || state === 'transcribing' ? 'true' : 'false');
      if (state === 'recording') {
        btnVoiceInput.title = '停止录音（最长30秒）';
        btnVoiceInput.setAttribute('aria-label', '停止录音');
      } else if (state === 'transcribing') {
        btnVoiceInput.title = '正在本地识别语音…';
        btnVoiceInput.setAttribute('aria-label', '正在本地识别语音');
      } else if (state === 'requesting') {
        btnVoiceInput.title = '正在请求麦克风权限…';
        btnVoiceInput.setAttribute('aria-label', '正在请求麦克风权限');
      } else {
        btnVoiceInput.title = '开始本地语音输入（最长30秒）';
        btnVoiceInput.setAttribute('aria-label', '开始本地语音输入（最长30秒）');
      }
    }

    function describeRecordingError(error) {
      const name = error && error.name ? String(error.name) : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return '麦克风权限被拒绝，请在系统设置中允许 ChatX2 使用麦克风。';
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '未检测到可用的麦克风。';
      if (name === 'NotReadableError' || name === 'TrackStartError') return '麦克风正被其他程序占用，请关闭占用后重试。';
      return error && error.message ? String(error.message) : '无法开始录音，请检查麦克风。';
    }

    function pickMimeType() {
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
      if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
      return candidates.find(function (type) { return MediaRecorder.isTypeSupported(type); }) || '';
    }

    async function transcribe(stoppedRecorder, currentOperation) {
      if (currentOperation !== operationId) return;
      const mimeType = (stoppedRecorder && stoppedRecorder.mimeType) || 'audio/webm';
      const audio = new Blob(chunks, { type: mimeType });
      chunks = [];
      recorder = null;
      if (!audio.size) {
        renderState('idle');
        showToast('没有录到声音，请重试', 3000);
        return;
      }

      renderState('transcribing');
      try {
        const result = await window.chatx2.transcribeVoiceInput(await audio.arrayBuffer(), mimeType);
        if (currentOperation !== operationId) return;
        const text = result && typeof result.text === 'string' ? result.text.trim() : '';
        if (!result || result.success !== true || !text) {
          throw new Error(result && result.error ? result.error : '没有识别到清晰的语音，请重试。');
        }
        msgInput.value = msgInput.value.trim() ? `${msgInput.value.trim()} ${text}` : text;
        msgInput.dispatchEvent(new Event('input', { bubbles: true }));
        msgInput.focus();
        showToast('语音已转成文字，请确认后发送', 2400);
      } catch (error) {
        if (currentOperation === operationId) showToast(`语音输入失败：${error && error.message ? error.message : '转写失败'}`, 5000);
      } finally {
        if (currentOperation === operationId) renderState('idle');
      }
    }

    function stopRecording(reachedLimit) {
      if (state !== 'recording' || !recorder) return;
      clearStopTimer();
      const stoppedRecorder = recorder;
      renderState('transcribing');
      try {
        if (stoppedRecorder.state !== 'inactive') stoppedRecorder.stop();
      } catch (error) {
        operationId++;
        recorder = null;
        chunks = [];
        renderState('idle');
        showToast(`语音输入失败：${describeRecordingError(error)}`, 5000);
      } finally {
        releaseStream();
      }
      if (reachedLimit) showToast('已达到30秒上限，正在本地识别…', 2600);
    }

    async function startRecording() {
      if (state !== 'idle') return;
      const currentOperation = ++operationId;
      chunks = [];
      renderState('requesting');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (currentOperation !== operationId) {
          releaseStream();
          return;
        }
        const mimeType = pickMimeType();
        recorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
        const activeRecorder = recorder;
        activeRecorder.ondataavailable = function (event) {
          if (currentOperation === operationId && event.data && event.data.size > 0) chunks.push(event.data);
        };
        activeRecorder.onerror = function (event) {
          if (currentOperation !== operationId) return;
          operationId++;
          clearStopTimer();
          releaseStream();
          recorder = null;
          chunks = [];
          renderState('idle');
          showToast(`语音输入失败：${describeRecordingError(event.error || event)}`, 5000);
        };
        activeRecorder.onstop = function () { void transcribe(activeRecorder, currentOperation); };
        activeRecorder.start(250);
        renderState('recording');
        stopTimer = setTimeout(function () { stopRecording(true); }, MAX_RECORDING_MS);
        showToast('正在录音，再次点击可停止（最长30秒）', 2400);
      } catch (error) {
        if (currentOperation !== operationId) return;
        clearStopTimer();
        releaseStream();
        recorder = null;
        chunks = [];
        renderState('idle');
        showToast(`语音输入失败：${describeRecordingError(error)}`, 5000);
      }
    }

    btnVoiceInput.addEventListener('click', function () {
      if (state === 'recording') stopRecording(false);
      else if (state === 'idle') void startRecording();
    });

    window.addEventListener('beforeunload', function () {
      operationId++;
      clearStopTimer();
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch (_) { /* 页面正在关闭 */ }
      }
      releaseStream();
    }, { once: true });
  }

  setupVoiceInput();

  // Do not steal focus from model/voice configuration editors. Chat startup
  // and an asynchronous reply can finish several seconds after the user has
  // already opened the voice-action modal; the former unconditional focus()
  // moved every keystroke back to the message box and made the metadata fields
  // appear read-only.
  function isTextEditingControl(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.isContentEditable) return true;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']
      .includes((element.type || 'text').toLowerCase());
  }

  function focusMessageInputIfAppropriate() {
    if (!msgInput || document.getElementById('chatx2-voice-editor-overlay')) return false;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement
      && active !== msgInput && isTextEditingControl(active)) return false;
    msgInput.focus();
    return document.activeElement === msgInput;
  }

  // 语音克隆训练工具入口
  const btnOpenVoiceTrain = document.getElementById('btn-open-voice-train');
  // ★ 标记：刚打开过克隆窗口，用于 focus 事件中触发 TTS 状态恢复
  let _voiceTrainOpenedAt = 0;
  function openVoiceTrainWindow() {
    _voiceTrainOpenedAt = Date.now();
    window.open('/voice-train', '_blank');
  }
  if (btnOpenVoiceTrain) {
    btnOpenVoiceTrain.addEventListener('click', openVoiceTrainWindow);
  }
  // 头部语音克隆按钮（收缩框内）
  const btnVoiceClone = document.getElementById('btn-voice-clone');
  if (btnVoiceClone) {
    btnVoiceClone.addEventListener('click', openVoiceTrainWindow);
  }
  // ★ 克隆窗口关闭后主窗口重新获得焦点 → 重新检查并恢复 TTS
  window.addEventListener('focus', () => {
    if (!_voiceTrainOpenedAt) return;
    if (Date.now() - _voiceTrainOpenedAt < 30000) {
      _voiceTrainOpenedAt = 0;
      console.log('[Voice] 从克隆窗口返回，重新检查 TTS 状态');
      (async () => {
        await checkVoiceAvailability();
      })();
    }
  });

  // 头部字体颜色按钮（收缩框内，语音克隆旁）
  const btnTextColor = document.getElementById('btn-text-color');
  const textColorPopover = document.getElementById('text-color-popover');
  const textColorCurrentName = document.getElementById('text-color-current-name');
  const textColorSwatches = document.querySelectorAll('.text-color-swatch');
  const btnTextColorReset = document.getElementById('btn-text-color-reset');
  const TEXT_COLOR_STORAGE_KEY = 'chat-text-color';
  const TEXT_COLOR_NAME_KEY = 'chat-text-color-name';

  // 应用颜色到 .chat-container（通过 CSS 变量级联，覆盖 --text-primary）
  function applyChatTextColor(color, name) {
    const chatContainerEl = document.querySelector('.chat-container');
    if (!chatContainerEl) return;
    if (color) {
      chatContainerEl.style.setProperty('--chat-text-color', color);
    } else {
      // 重置：移除自定义变量，回退到默认
      chatContainerEl.style.removeProperty('--chat-text-color');
    }
    // 更新当前颜色名显示
    if (textColorCurrentName) textColorCurrentName.textContent = name || (color ? '自定义' : '经典白');
    // 更新色块选中态
    textColorSwatches.forEach(s => {
      const swatchColor = s.getAttribute('data-color');
      const swatchName = s.getAttribute('data-name');
      if (color && swatchColor === color) {
        s.classList.add('active');
      } else if (!color && swatchName === '经典白') {
        s.classList.add('active');
      } else {
        s.classList.remove('active');
      }
    });
  }

  // 初始化：从 localStorage 读取用户上次选择的颜色
  function initChatTextColor() {
    const savedColor = localStorage.getItem(TEXT_COLOR_STORAGE_KEY);
    const savedName = localStorage.getItem(TEXT_COLOR_NAME_KEY);
    if (savedColor) {
      applyChatTextColor(savedColor, savedName);
    } else {
      applyChatTextColor(null, '经典白');
    }
  }

  if (btnTextColor && textColorPopover) {
    // 点击按钮：切换显示浮层，定位到按钮下方
    btnTextColor.addEventListener('click', (e) => {
      e.stopPropagation();
      if (textColorPopover.style.display === 'none' || !textColorPopover.style.display) {
        const rect = btnTextColor.getBoundingClientRect();
        textColorPopover.style.display = 'block';
        // 定位到按钮下方，左对齐
        let left = rect.left;
        const popoverWidth = 260;
        if (left + popoverWidth > window.innerWidth - 8) {
          left = window.innerWidth - popoverWidth - 8;
        }
        textColorPopover.style.left = left + 'px';
        textColorPopover.style.top = (rect.bottom + 6) + 'px';
      } else {
        textColorPopover.style.display = 'none';
      }
    });

    // 点击色块：选择颜色
    textColorSwatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        const color = swatch.getAttribute('data-color');
        const name = swatch.getAttribute('data-name');
        applyChatTextColor(color, name);
        localStorage.setItem(TEXT_COLOR_STORAGE_KEY, color);
        localStorage.setItem(TEXT_COLOR_NAME_KEY, name);
      });
    });

    // 重置按钮
    if (btnTextColorReset) {
      btnTextColorReset.addEventListener('click', () => {
        applyChatTextColor(null, '经典白');
        localStorage.removeItem(TEXT_COLOR_STORAGE_KEY);
        localStorage.removeItem(TEXT_COLOR_NAME_KEY);
      });
    }

    // 点击浮层外部关闭
    document.addEventListener('click', (e) => {
      if (textColorPopover.style.display === 'none' || !textColorPopover.style.display) return;
      if (textColorPopover.contains(e.target) || btnTextColor.contains(e.target)) return;
      textColorPopover.style.display = 'none';
    });

    // 滚动时关闭浮层（避免定位错乱）
    document.querySelector('.chat-area')?.addEventListener('scroll', () => {
      if (textColorPopover.style.display === 'block') textColorPopover.style.display = 'none';
    });

    // 初始化加载
    initChatTextColor();
  }

  // 头部语音切换按钮（收缩框内）— 为当前角色选择已克隆的语音
  const btnVoiceSwitch = document.getElementById('btn-voice-switch');
  const voiceSwitchModal = document.getElementById('voice-switch-modal');
  const btnCloseVoiceSwitch = document.getElementById('btn-close-voice-switch');
  const voiceSwitchListEl = document.getElementById('voice-switch-list');
  const voiceSwitchEmptyEl = document.getElementById('voice-switch-empty');
  const voiceSwitchCharInfoEl = document.getElementById('voice-switch-char-info');
  const voiceRenameModal = document.getElementById('voice-rename-modal');
  const btnCloseVoiceRename = document.getElementById('btn-close-voice-rename');
  const voiceRenameInput = document.getElementById('voice-rename-input');
  const voiceRenameStatus = document.getElementById('voice-rename-status');
  const btnVoiceRenameCancel = document.getElementById('btn-voice-rename-cancel');
  const btnVoiceRenameConfirm = document.getElementById('btn-voice-rename-confirm');
  let voiceSwitchCurrentCharId = null;
  let voiceRenameTarget = null; // 当前正在重命名的语音名
  const voiceDeleteModal = document.getElementById('voice-delete-modal');
  const btnCloseVoiceDelete = document.getElementById('btn-close-voice-delete');
  const voiceDeleteNameEl = document.getElementById('voice-delete-name');
  const voiceDeleteStatusEl = document.getElementById('voice-delete-status');
  const btnVoiceDeleteCancel = document.getElementById('btn-voice-delete-cancel');
  const btnVoiceDeleteConfirm = document.getElementById('btn-voice-delete-confirm');
  let voiceDeleteTarget = null; // 当前待删除的语音名
  let voiceDeleteArmed = false; // 二次确认状态：首次点击后置 true，再次点击才执行删除

  function closeVoiceSwitchModal() {
    if (voiceSwitchModal) voiceSwitchModal.style.display = 'none';
  }
  function closeVoiceRenameModal() {
    if (voiceRenameModal) voiceRenameModal.style.display = 'none';
    voiceRenameTarget = null;
    if (voiceRenameInput) voiceRenameInput.value = '';
    if (voiceRenameStatus) voiceRenameStatus.textContent = '';
  }
  function resetVoiceDeleteConfirmState() {
    voiceDeleteArmed = false;
    if (btnVoiceDeleteConfirm) {
      btnVoiceDeleteConfirm.disabled = false;
      btnVoiceDeleteConfirm.classList.remove('armed');
      btnVoiceDeleteConfirm.textContent = '删除';
    }
    if (voiceDeleteStatusEl) voiceDeleteStatusEl.textContent = '';
  }
  function closeVoiceDeleteModal() {
    if (voiceDeleteModal) voiceDeleteModal.style.display = 'none';
    voiceDeleteTarget = null;
    resetVoiceDeleteConfirmState();
  }
  function openVoiceDeleteModal(name) {
    if (!voiceDeleteModal) return;
    voiceDeleteTarget = name;
    if (voiceDeleteNameEl) voiceDeleteNameEl.textContent = name;
    resetVoiceDeleteConfirmState();
    voiceDeleteModal.style.display = 'flex';
  }
  function showVoiceSwitchToast(msg, isError) {
    if (typeof window.showInfoModal === 'function') {
      window.showInfoModal(msg);
    } else {
      alert(msg);
    }
  }

  function renderVoiceSwitchList(voices, currentVoiceName, charId) {
    if (!voices || voices.length === 0) {
      voiceSwitchListEl.innerHTML = '';
      voiceSwitchEmptyEl.style.display = 'block';
      return;
    }
    voiceSwitchEmptyEl.style.display = 'none';
    voiceSwitchListEl.innerHTML = voices.map(v => {
      const isCurrent = (v.name === currentVoiceName);
      const sourceLabel = v.source === 'bundled' ? '内置基础' : (v.source === 'legacy' ? '旧架构' : '用户克隆');
      const metaText = `${sourceLabel} · ${v.emotion_count || 0} 情感`;
      const canRename = v.canRename === true;
      const canDelete = v.canDelete === true;
      const deleteBtn = canDelete
        ? `<button class="voice-switch-action-btn danger" data-action="delete" data-name="${encodeURIComponent(v.name)}">删除</button>`
        : '';
      const actions = isCurrent
        ? `<div class="voice-switch-item-actions">
             ${canRename ? `<button class="voice-switch-action-btn" data-action="rename" data-name="${encodeURIComponent(v.name)}">重命名</button>` : ''}
             ${deleteBtn}
           </div>`
        : `<div class="voice-switch-item-actions">
             ${canRename ? `<button class="voice-switch-action-btn" data-action="rename" data-name="${encodeURIComponent(v.name)}">重命名</button>` : ''}
             ${deleteBtn}
             <button class="voice-switch-action-btn primary" data-action="use" data-name="${encodeURIComponent(v.name)}">使用</button>
           </div>`;
      return `<div class="voice-switch-item ${isCurrent ? 'current' : ''}" data-name="${encodeURIComponent(v.name)}">
        <div class="voice-switch-item-main">
          <div class="voice-switch-item-name">${v.name}${isCurrent ? '<span class="voice-switch-item-current-tag">当前</span>' : ''}</div>
          <div class="voice-switch-item-meta">${metaText}</div>
        </div>
        ${actions}
      </div>`;
    }).join('');
    // 绑定按钮
    voiceSwitchListEl.querySelectorAll('.voice-switch-action-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const name = decodeURIComponent(btn.dataset.name);
        if (action === 'use') {
          try {
            const r = await fetch(`/api/characters/${charId}/voice`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ voiceName: name }),
            });
            const d = await r.json();
            if (d.success) {
              showVoiceSwitchToast(`已切换语音为「${name}」`);
              closeVoiceSwitchModal();
              // 切换后预加载新语音的 2 条样本（提前缓存，下次播放秒播）
              preSynthesizeRecent(getVoiceAutoPreSynthCount());
            } else {
              showVoiceSwitchToast(d.error || '切换失败', true);
            }
          } catch (err) {
            showVoiceSwitchToast('切换失败: ' + err.message, true);
          }
        } else if (action === 'rename') {
          voiceRenameTarget = name;
          voiceRenameInput.value = name;
          voiceRenameStatus.textContent = '';
          voiceRenameModal.style.display = 'flex';
          setTimeout(() => voiceRenameInput.focus(), 50);
        } else if (action === 'delete') {
          // 打开二次确认弹窗：首次点击"删除"进入待确认状态，再次点击才真正执行
          openVoiceDeleteModal(name);
        }
      });
    });
  }

  async function openVoiceSwitchModal() {
    if (!voiceSwitchModal) return;
    voiceSwitchModal.style.display = 'flex';
    voiceSwitchListEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-secondary,rgba(220,220,255,0.5));font-size:13px;">加载中...</div>';
    voiceSwitchEmptyEl.style.display = 'none';
    try {
      const [charRes, voiceRes] = await Promise.all([
        fetch('/api/current-character').then(r => r.json()),
        fetch('/api/voices').then(r => r.json()),
      ]);
      const charId = charRes.success ? charRes.characterId : '?';
      const charName = charRes.success ? (charRes.name || charId) : '?';
      voiceSwitchCurrentCharId = charId;
      let currentVoiceName = null;
      try {
        const curRes = await fetch(`/api/characters/${charId}/voice`).then(r => r.json());
        if (curRes.success) currentVoiceName = curRes.voiceName;
      } catch (e) {}
      voiceSwitchCharInfoEl.textContent = `当前角色：${charName}（ID: ${charId}）`;
      const voices = (voiceRes.success && voiceRes.voices) ? voiceRes.voices : [];
      renderVoiceSwitchList(voices, currentVoiceName, charId);
    } catch (e) {
      voiceSwitchListEl.innerHTML = `<div style="text-align:center;padding:24px;color:#f87171;font-size:13px;">加载失败: ${e.message}</div>`;
    }
  }

  async function confirmVoiceRename() {
    if (!voiceRenameTarget) return;
    const newName = voiceRenameInput.value.trim();
    if (!newName) {
      voiceRenameStatus.innerHTML = '<span style="color:#f87171;">请输入新名称</span>';
      return;
    }
    if (newName === voiceRenameTarget) {
      voiceRenameStatus.innerHTML = '<span style="color:#f87171;">新名称与原名称相同</span>';
      return;
    }
    btnVoiceRenameConfirm.disabled = true;
    btnVoiceRenameConfirm.textContent = '处理中...';
    try {
      const r = await fetch(`/api/voices/${encodeURIComponent(voiceRenameTarget)}/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName }),
      });
      const d = await r.json();
      if (d.success) {
        closeVoiceRenameModal();
        showVoiceSwitchToast(`已重命名为「${d.newName}」`);
        // 刷新列表
        await openVoiceSwitchModal();
      } else {
        voiceRenameStatus.innerHTML = `<span style="color:#f87171;">${d.error || '重命名失败'}</span>`;
      }
    } catch (e) {
      voiceRenameStatus.innerHTML = `<span style="color:#f87171;">重命名失败: ${e.message}</span>`;
    } finally {
      btnVoiceRenameConfirm.disabled = false;
      btnVoiceRenameConfirm.textContent = '确认重命名';
    }
  }

  if (btnVoiceSwitch) btnVoiceSwitch.addEventListener('click', openVoiceSwitchModal);
  if (btnCloseVoiceSwitch) btnCloseVoiceSwitch.addEventListener('click', closeVoiceSwitchModal);
  if (voiceSwitchModal) {
    voiceSwitchModal.addEventListener('click', (e) => {
      if (e.target === voiceSwitchModal) closeVoiceSwitchModal();
    });
  }
  if (btnCloseVoiceRename) btnCloseVoiceRename.addEventListener('click', closeVoiceRenameModal);
  if (btnVoiceRenameCancel) btnVoiceRenameCancel.addEventListener('click', closeVoiceRenameModal);
  if (voiceRenameModal) {
    voiceRenameModal.addEventListener('click', (e) => {
      if (e.target === voiceRenameModal) closeVoiceRenameModal();
    });
  }
  if (btnCloseVoiceDelete) btnCloseVoiceDelete.addEventListener('click', closeVoiceDeleteModal);
  if (btnVoiceDeleteCancel) btnVoiceDeleteCancel.addEventListener('click', closeVoiceDeleteModal);
  if (voiceDeleteModal) {
    voiceDeleteModal.addEventListener('click', (e) => {
      if (e.target === voiceDeleteModal) closeVoiceDeleteModal();
    });
  }
  if (btnVoiceDeleteConfirm) btnVoiceDeleteConfirm.addEventListener('click', async () => {
    if (!voiceDeleteTarget) return;
    // 二次确认：首次点击进入待确认状态，再次点击才执行删除
    if (!voiceDeleteArmed) {
      voiceDeleteArmed = true;
      btnVoiceDeleteConfirm.classList.add('armed');
      btnVoiceDeleteConfirm.textContent = '确认删除';
      if (voiceDeleteStatusEl) {
        voiceDeleteStatusEl.textContent = '请再次点击「确认删除」，语音将移入系统回收站';
      }
      return;
    }
    const name = voiceDeleteTarget;
    btnVoiceDeleteConfirm.disabled = true;
    btnVoiceDeleteConfirm.textContent = '删除中...';
    if (voiceDeleteStatusEl) voiceDeleteStatusEl.textContent = '';
    try {
      const r = await fetch(`/api/voices/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const d = await r.json();
      if (d.success) {
        closeVoiceDeleteModal();
        showVoiceSwitchToast(`已删除语音「${name}」（已移入回收站）`);
        await openVoiceSwitchModal();
      } else {
        btnVoiceDeleteConfirm.disabled = false;
        btnVoiceDeleteConfirm.textContent = '删除';
        voiceDeleteArmed = false;
        btnVoiceDeleteConfirm.classList.remove('armed');
        if (voiceDeleteStatusEl) {
          voiceDeleteStatusEl.textContent = d.error || '删除失败';
        }
      }
    } catch (err) {
      btnVoiceDeleteConfirm.disabled = false;
      btnVoiceDeleteConfirm.textContent = '删除';
      voiceDeleteArmed = false;
      btnVoiceDeleteConfirm.classList.remove('armed');
      if (voiceDeleteStatusEl) {
        voiceDeleteStatusEl.textContent = '删除失败: ' + err.message;
      }
    }
  });
  if (btnVoiceRenameConfirm) btnVoiceRenameConfirm.addEventListener('click', confirmVoiceRename);
  if (voiceRenameInput) {
    voiceRenameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmVoiceRename(); }
    });
  }

  // ========== Header 自动隐藏逻辑 ==========
  // 默认缩回顶部，触摸上端出现，双击固定/取消固定
  let headerHideTimer = null;
  let headerPinned = false; // 是否固定显示
  const HEADER_HIDE_DELAY = 2500; // 非固定状态下，2.5秒后自动隐藏
  const HEADER_LEAVE_DELAY = 1000; // 鼠标离开后延迟收起，给移动到按钮/菜单留缓冲
  let _hasShownInitialHint = false; // 是否已显示过首次提示
  let headerPointerX = -1;
  let headerPointerY = -1;

  function isTouchHeaderMode() {
    return window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }

  document.addEventListener('mousemove', (e) => {
    headerPointerX = e.clientX;
    headerPointerY = e.clientY;
  }, { passive: true });

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    headerPointerX = touch.clientX;
    headerPointerY = touch.clientY;
  }, { passive: true });

  function isPointerInHeaderArea() {
    if (headerPointerX < 0 || headerPointerY < 0) return false;
    if (chatHeader && (chatHeader.classList.contains('header-visible') || chatHeader.classList.contains('header-pinned'))) {
      const rect = chatHeader.getBoundingClientRect();
      if (
        headerPointerX >= rect.left &&
        headerPointerX <= rect.right &&
        headerPointerY >= rect.top &&
        headerPointerY <= rect.bottom
      ) {
        return true;
      }
    }
    if (headerTriggerZone) {
      const rect = headerTriggerZone.getBoundingClientRect();
      if (
        headerPointerX >= rect.left &&
        headerPointerX <= rect.right &&
        headerPointerY >= rect.top &&
        headerPointerY <= rect.bottom
      ) {
        return true;
      }
    }
    return false;
  }

  function scheduleHeaderHide(delay = HEADER_HIDE_DELAY) {
    if (!chatHeader) return;
    clearTimeout(headerHideTimer);
    if (!headerPinned) {
      headerHideTimer = setTimeout(() => {
        if (!isTouchHeaderMode() && isPointerInHeaderArea()) {
          clearTimeout(headerHideTimer);
          return;
        }
        if (!headerPinned) {
          chatHeader.classList.remove('header-visible');
          if (headerTriggerZone) headerTriggerZone.classList.remove('header-active');
        }
      }, delay);
    }
  }

  function showHeader(autoHide = false) {
    if (!chatHeader) return;
    chatHeader.classList.add('header-visible');
    if (headerTriggerZone) headerTriggerZone.classList.add('header-active');
    clearTimeout(headerHideTimer);
    if (autoHide) scheduleHeaderHide(HEADER_HIDE_DELAY);
  }

  function hideHeaderImmediate() {
    if (!chatHeader) return;
    clearTimeout(headerHideTimer);
    chatHeader.classList.remove('header-visible');
    if (headerTriggerZone) headerTriggerZone.classList.remove('header-active');
  }

  // 首次进入聊天页面时，短暂显示header一次，让用户看到语音开关位置
  function showHeaderInitialHint() {
    if (_hasShownInitialHint || !chatHeader) return;
    _hasShownInitialHint = true;
    chatHeader.classList.add('header-visible');
    if (headerTriggerZone) headerTriggerZone.classList.add('header-active');
    clearTimeout(headerHideTimer);
    headerHideTimer = setTimeout(() => {
      if (!headerPinned) {
        chatHeader.classList.remove('header-visible');
        if (headerTriggerZone) headerTriggerZone.classList.remove('header-active');
      }
    }, 5000); // 显示5秒后自动隐藏，让用户看清语音开关位置
  }

  // 触摸/鼠标移到顶部触发区
  if (headerTriggerZone) {
    headerTriggerZone.addEventListener('mouseenter', () => {
      if (!isTouchHeaderMode()) showHeader(false);
    });
    headerTriggerZone.addEventListener('mouseleave', () => {
      if (!isTouchHeaderMode()) scheduleHeaderHide(HEADER_LEAVE_DELAY);
    });
    headerTriggerZone.addEventListener('click', (e) => {
      if (!isTouchHeaderMode()) return;
      e.stopPropagation();
      showHeader(false);
    });
  }

  // 鼠标移到header上时保持显示
  if (chatHeader) {
    chatHeader.addEventListener('mouseenter', () => {
      if (isTouchHeaderMode()) return;
      clearTimeout(headerHideTimer);
      chatHeader.classList.add('header-visible');
      if (headerTriggerZone) headerTriggerZone.classList.add('header-active');
    });
    chatHeader.addEventListener('mouseleave', () => {
      if (!isTouchHeaderMode()) scheduleHeaderHide(HEADER_LEAVE_DELAY);
    });

    // 双击 header 切换固定/取消固定
    chatHeader.addEventListener('dblclick', (e) => {
      // 避免按钮上的双击触发
      if (e.target.closest('button')) return;
      headerPinned = !headerPinned;
      if (headerPinned) {
        chatHeader.classList.add('header-pinned');
        clearTimeout(headerHideTimer);
        showToast('已固定显示', 1200);
      } else {
        chatHeader.classList.remove('header-pinned');
        showToast('已取消固定', 1200);
        // 取消固定后延迟隐藏
        headerHideTimer = setTimeout(() => {
          if (!headerPinned) {
            chatHeader.classList.remove('header-visible');
            if (headerTriggerZone) headerTriggerZone.classList.remove('header-active');
          }
        }, HEADER_HIDE_DELAY);
      }
    });

    // 单击header按钮时，重新启动隐藏计时
    chatHeader.addEventListener('click', (e) => {
      if (e.target.closest('button')) {
        // 点击按钮后保持显示一段时间
        clearTimeout(headerHideTimer);
        if (!isTouchHeaderMode()) scheduleHeaderHide(HEADER_HIDE_DELAY);
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (!isTouchHeaderMode() || !chatHeader || headerPinned) return;
    if (!chatHeader.classList.contains('header-visible')) return;
    if (chatHeader.contains(e.target) || (headerTriggerZone && headerTriggerZone.contains(e.target))) return;
    hideHeaderImmediate();
  });

  // 语音相关
  let voiceEnabled = false;       // 当前角色是否有语音
  let ttsAvailable = false;       // TTS服务是否可用
  let voiceEmotions = [];         // 当前角色支持的情感
  const VOICE_USER_DISABLED_KEY = 'chat5.voice.userDisabled';
  const VOICE_START_MAX_ATTEMPTS = 2;
  const VOICE_SYNTHESIS_MAX_ATTEMPTS = 3;
  const VOICE_RETRY_DELAYS_MS = [0, 1500];
  const VOICE_START_FATAL_CODES = new Set([
    'GPU_UNAVAILABLE', 'GPU_DRIVER_UNAVAILABLE',
    'CUDA_UNAVAILABLE', 'CUDA_PYTORCH_MISMATCH', 'TORCH_IMPORT_TIMEOUT',
    'TORCH_IMPORT_FAILED', 'DEVICE_MISMATCH', 'PORT_IN_USE',
    'TTS_SCRIPT_MISSING', 'PYTHON_MISSING', 'VOICE_ASSET_MISSING', 'USER_DISABLED',
  ]);
  let voiceStartPromise = null;
  let voiceStoppedByUserThisSession = false;
  const VOICE_AUTOPLAY_STORAGE_KEY = 'chat5.voice.autoPlayLatest';
  const VOICE_AUTOPLAY_HANDLED_STORAGE_KEY = 'chat5.voice.autoPlayHandled.v1';
  // 用户明确移除过的语音消息。该标记只阻止后台预合成/缓存恢复，
  // 用户再次点击语音或“重新合成”时会清除并允许主动生成。
  const VOICE_DELETED_STORAGE_KEY = 'chat5.voice.deleted.v1';
  let autoPlayLatestVoice = localStorage.getItem(VOICE_AUTOPLAY_STORAGE_KEY) === '1';
  let handledVoiceMessageKeys = VoiceAutoplayPolicy.parseHandledMessageKeys(
    localStorage.getItem(VOICE_AUTOPLAY_HANDLED_STORAGE_KEY)
  );
  let deletedVoiceMessageKeys = VoiceAutoplayPolicy.parseHandledMessageKeys(
    localStorage.getItem(VOICE_DELETED_STORAGE_KEY)
  );
  let latestRealtimeVoiceToken = 0;
  let lastVoiceFailureNotice = { signature: '', at: 0 };
  const voiceSynthesisInflight = new Map();
  // 同一条回复的片段共享一个分组，可同时提交；不同回复仍严格 FIFO。
  const voiceGenerationQueue = VoiceSegmentQueue.createGroupedTaskQueue({ maxPending: 8 });

  function enqueueVoiceGeneration(run, token, groupId) {
    return voiceGenerationQueue.enqueue(run, { token, groupId });
  }

  function isVoiceGenerationBusy() {
    return voiceGenerationQueue.busy;
  }
  // 页面初始化、TTS 启动回调和历史恢复可能同时触发预合成。
  // TTS worker 本身是串行推理；同一批任务并发会把一次语音排队数次，
  // 表现为“语音很慢/没有输出”。整个批次只允许一个预合成循环。
  let recentPreSynthesisInFlight = false;

  function getVoiceAutoPreSynthCount() {
    return VoiceAutoplayPolicy.getPreSynthesisCount(autoPlayLatestVoice, AUTO_PRE_SYNTH_COUNT);
  }

  function getLatestAssistantRow() {
    const rows = messagesEl.querySelectorAll('.message-row.assistant');
    return rows.length ? rows[rows.length - 1] : null;
  }

  function getVoiceMessageKey(target) {
    const row = target?.closest?.('.message-row.assistant');
    return String(target?.dataset?.voiceMessageKey || row?.dataset?.voiceMessageKey || '');
  }

  function isVoiceMessageHandled(target) {
    const key = typeof target === 'string' ? target : getVoiceMessageKey(target);
    return Boolean(key && handledVoiceMessageKeys.includes(key));
  }

  function markVoiceMessageHandled(target) {
    const key = typeof target === 'string' ? target : getVoiceMessageKey(target);
    if (!key) return;
    handledVoiceMessageKeys = VoiceAutoplayPolicy.addHandledMessageKey(handledVoiceMessageKeys, key);
    try {
      localStorage.setItem(VOICE_AUTOPLAY_HANDLED_STORAGE_KEY, JSON.stringify(handledVoiceMessageKeys));
    } catch (error) {
      console.warn('[Voice] 无法保存自动播放记录:', error);
    }
  }

  function isVoiceMessageDeleted(target) {
    const key = typeof target === 'string' ? target : getVoiceMessageKey(target);
    return Boolean(key && deletedVoiceMessageKeys.includes(key));
  }

  // 被清理/删除的历史语音只是没有缓存，不应显示为仍在合成。
  // 仅重置显示状态，不触发任何语音请求；用户仍可通过刷新按钮手动生成。
  function resetMissingVoiceDisplay(btn) {
    if (!btn) return;
    btn.classList.remove('loading', 'ready', 'partial', 'failed', 'cancelled', 'playing');
    btn.dataset.cachedUrl = '';
    btn.dataset.cachedEmotion = '';
    const row = btn.closest('.msg-voice-row');
    const label = row && row.querySelector('.msg-voice-label');
    const refresh = row && row.querySelector('.msg-voice-refresh');
    if (label) label.textContent = '语音';
    if (refresh) refresh.style.display = 'none';
  }

  function clearVoiceMessageDeleted(target) {
    const key = typeof target === 'string' ? target : getVoiceMessageKey(target);
    if (!key) return;
    deletedVoiceMessageKeys = deletedVoiceMessageKeys.filter(item => item !== key);
    try { localStorage.setItem(VOICE_DELETED_STORAGE_KEY, JSON.stringify(deletedVoiceMessageKeys)); } catch (error) {}
  }

  function markVoiceMessageDeleted(target) {
    const key = typeof target === 'string' ? target : getVoiceMessageKey(target);
    if (!key || deletedVoiceMessageKeys.includes(key)) return;
    deletedVoiceMessageKeys = [...deletedVoiceMessageKeys, key].slice(-500);
    try { localStorage.setItem(VOICE_DELETED_STORAGE_KEY, JSON.stringify(deletedVoiceMessageKeys)); } catch (error) {}
  }

  // ============================================================
  // Avatar 同步扩展：Chat 窗口播放语音时，通知 Avatar 窗口静音同步口型/动作
  // Avatar 收到 wavBytes 后以 mute=true 模式播放（不发声），仅驱动桌宠口型和动作
  // ============================================================
  let _avatarSyncTaskId = null;
  let _avatarSyncCounter = 0;

  async function notifyAvatarSyncPlay(audioUrl, speechText, emotion, performance) {
    if (!window.chatx2 || typeof window.chatx2.avatarSyncVoice !== 'function') return;
    // 先停止旧的同步
    await notifyAvatarSyncStop('interrupted');
    try {
      const resp = await fetch(audioUrl);
      if (!resp.ok) return;
      const wavBytes = await resp.arrayBuffer();
      _avatarSyncTaskId = 'chat-sync-' + (++_avatarSyncCounter) + '-' + Date.now();
      const semantic = performance && typeof performance === 'object'
        ? { ...performance }
        : undefined;
      if (semantic && emotion && !semantic.voiceEmotion) semantic.voiceEmotion = emotion;
      await window.chatx2.avatarSyncVoice(
        _avatarSyncTaskId,
        wavBytes,
        semantic,
        normalizeTtsTextForRequest(speechText)
      );
    } catch (e) {
      console.warn('[avatar-sync] play failed:', e);
    }
  }

  async function notifyAvatarSyncStop(reason = 'cancel') {
    if (!window.chatx2 || typeof window.chatx2.avatarSyncStop !== 'function') return;
    if (!_avatarSyncTaskId) return;
    const taskId = _avatarSyncTaskId;
    _avatarSyncTaskId = null;
    try {
      await window.chatx2.avatarSyncStop(taskId, reason);
    } catch (e) {
      console.warn('[avatar-sync] stop failed:', e);
    }
  }

  function requestLatestVoiceAutoplay(btn) {
    const row = btn ? btn.closest('.message-row.assistant') : null;
    const autoplayPending = Boolean(btn && btn.dataset.autoplayPending === '1');
    const allowed = VoiceAutoplayPolicy.shouldAutoPlayLatest({
      enabled: autoPlayLatestVoice,
      isLatest: Boolean(row && row === getLatestAssistantRow()),
      hasAudio: Boolean(btn && btn.dataset.cachedUrl),
      voiceEnabled,
      stopped: voiceStoppedByUserThisSession,
      playing: Boolean(btn && (btn.classList.contains('playing') || autoplayPending)),
      alreadyHandled: isVoiceMessageHandled(btn),
    });
    if (allowed) {
      btn.dataset.autoplayPending = '1';
      btn.click();
    }
  }

  function updateVoiceAutoplayUI() {
    if (!btnVoiceAutoplay) return;
    btnVoiceAutoplay.classList.toggle('voice-autoplay-on', autoPlayLatestVoice);
    btnVoiceAutoplay.classList.toggle('voice-autoplay-off', !autoPlayLatestVoice);
    btnVoiceAutoplay.setAttribute('aria-pressed', autoPlayLatestVoice ? 'true' : 'false');
    btnVoiceAutoplay.title = autoPlayLatestVoice
      ? '自动播放最新语音：开启'
      : '自动播放最新语音：关闭';
  }

  updateVoiceAutoplayUI();

  if (btnVoiceAutoplay) {
    btnVoiceAutoplay.addEventListener('click', (e) => {
      e.stopPropagation();
      autoPlayLatestVoice = !autoPlayLatestVoice;
      localStorage.setItem(VOICE_AUTOPLAY_STORAGE_KEY, autoPlayLatestVoice ? '1' : '0');
      updateVoiceAutoplayUI();
      showToast(autoPlayLatestVoice ? '已开启：只自动播放最新一条语音' : '已关闭自动播放', 1800);
      if (autoPlayLatestVoice) {
        preSynthesizeRecent(1);
      }
    });
  }

  const waitVoiceRetry = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function readJsonResponse(response) {
    const raw = await response.text();
    if (!raw) return {};
    try { return JSON.parse(raw); }
    catch { return { success: false, error: `服务返回了无法识别的响应（HTTP ${response.status}）` }; }
  }

  function stripModelControlTokens(value) {
    return String(value || '')
      .replace(/<\|\s*(?:assistant|user|system|end|im_start|im_end)\s*\|>/gi, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function normalizeTtsTextForRequest(value) {
    return stripModelControlTokens(value)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[表情包:[^\]]*\]/g, ' ')
      .replace(/\[图片\s*:[^\]]*\]/g, ' ')
      .replace(/^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s+\d{1,2}:\d{2})\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function voiceResourceDetails(data) {
    const summary = String(data?.resourceSummary || '').trim();
    if (!summary) return '';
    const lines = summary.split(/\r?\n/);
    const visibleLines = data?.memoryDiagnostic
      ? lines
      : lines.filter(line => !line.startsWith('系统内存(RAM)'));
    return visibleLines.length ? `\n\n${visibleLines.join('\n')}` : '';
  }

  function notifyVoiceStartFailure(data) {
    const code = String(data?.errorCode || 'TTS_START_FAILED');
    const message = data?.error || '未知错误';
    const details = voiceResourceDetails(data);
    const signature = `${code}:${message}`;
    const now = Date.now();
    if (lastVoiceFailureNotice.signature === signature && now - lastVoiceFailureNotice.at < 10000) return;
    lastVoiceFailureNotice = { signature, at: now };

    if (data?.memoryDiagnostic) {
      const attempts = Number(data?.startupFailures || data?.attempts || VOICE_START_MAX_ATTEMPTS);
      showInfoModal(`语音服务连续启动 ${attempts} 次仍失败：${message}${details}\n\n内存信息仅用于排查，不再作为启动限制。Windows缓存、待机内存和分页文件仍可能提供可提交内存；失败也可能来自模型、驱动或安全软件。`);
    } else if (code === 'PORT_IN_USE' || code === 'DEVICE_MISMATCH') {
      showInfoModal(`${message}${details}\n\n应用不会强制结束未知程序，请先处理端口或版本冲突。`);
    } else if (code === 'GPU_DRIVER_UNAVAILABLE' || code === 'GPU_UNAVAILABLE') {
      showInfoModal(`${message}${details}\n\n请检查NVIDIA驱动和显卡状态；GPU专用版不会回退到CPU。`);
    } else if (code === 'CUDA_UNAVAILABLE' || code === 'CUDA_PYTORCH_MISMATCH') {
      showInfoModal(`${message}${details}\n\n请检查CUDA驱动兼容性及发布包内PyTorch是否为CUDA版本。`);
    } else if (code === 'TORCH_IMPORT_TIMEOUT') {
      showInfoModal(`${message}${details}\n\n请检查安全软件是否正在扫描包内Python文件。`);
    } else if (code === 'TORCH_IMPORT_FAILED') {
      showInfoModal(`${message}${details}\n\n发布包内Python/PyTorch可能损坏或不完整，请重新解压完整ZIP。`);
    } else if (['TTS_SCRIPT_MISSING', 'PYTHON_MISSING', 'VOICE_ASSET_MISSING'].includes(code)) {
      showInfoModal(`${message}${details}\n\n发布包可能不完整，请重新解压完整 ZIP，并避免单独移动 exe。`);
    } else {
      const attempts = Number(data?.attempts || VOICE_START_MAX_ATTEMPTS);
      showToast(`语音服务未能启动（已尝试 ${attempts} 次）：${message}`, 6000);
    }
  }

  async function ensureVoiceServiceStarted({ notify = true, force = false } = {}) {
    if (voiceStoppedByUserThisSession && !force) {
      return { success: false, errorCode: 'USER_DISABLED', error: '语音服务已由用户在本次运行中关闭' };
    }
    if (ttsAvailable) return { success: true, ttsAvailable: true, reused: true };
    if (voiceStartPromise) return voiceStartPromise;

    voiceStartPromise = (async () => {
      let lastFailure = { success: false, errorCode: 'TTS_START_FAILED', error: '语音服务未就绪' };
      updateVoiceToggleUI('loading');
      if (notify) showToast('正在自动启动语音服务，首次加载可能需要一些时间…', 4000);
      for (let attempt = 1; attempt <= VOICE_START_MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) await waitVoiceRetry(VOICE_RETRY_DELAYS_MS[attempt - 1]);
        try {
          const statusData = await readJsonResponse(await fetch('/api/voice/status', { cache: 'no-store' }));
          if (statusData.ttsAvailable) {
            lastFailure = { success: true, ...statusData, reused: true, attempts: attempt };
            break;
          }
          console.log(`[Voice] 启动尝试 ${attempt}/${VOICE_START_MAX_ATTEMPTS}`);
          const data = await readJsonResponse(await fetch('/api/voice/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ attempt }),
          }));
          if (data.success && data.ttsAvailable !== false) {
            lastFailure = { ...data, success: true, attempts: attempt };
            break;
          }
          lastFailure = { ...data, success: false, attempts: attempt };
          if (VOICE_START_FATAL_CODES.has(String(lastFailure.errorCode || ''))) break;
        } catch (error) {
          lastFailure = {
            success: false,
            errorCode: 'TTS_START_NETWORK_ERROR',
            error: error?.message || '无法连接本地语音启动接口',
            attempts: attempt,
          };
        }
      }
      if (lastFailure.success) {
        ttsAvailable = true;
        voiceStoppedByUserThisSession = false;
        if (lastFailure.device) selectedDevice = lastFailure.device;
        localStorage.removeItem(VOICE_USER_DISABLED_KEY);
        updateVoiceToggleUI('on');
        const deviceName = lastFailure.device ? `（${String(lastFailure.device).toUpperCase()}）` : '';
        if (notify) showToast(`语音服务已启动${deviceName}`, 2500);
        setTimeout(() => {
          if (typeof checkVoiceAvailability === 'function') checkVoiceAvailability();
          // 启动只恢复已有 WAV；不要把历史消息再次送入 TTS，避免启动后长期显示“处理中”。
          const latestBtn = getLatestAssistantRow()?.querySelector('.msg-voice-btn');
          if (latestBtn) requestLatestVoiceAutoplay(latestBtn);
        }, 0);
        return lastFailure;
      }
      ttsAvailable = false;
      updateVoiceToggleUI('off');
      if (notify) notifyVoiceStartFailure(lastFailure);
      return lastFailure;
    })();
    try { return await voiceStartPromise; }
    finally { voiceStartPromise = null; }
  }

  function isRetryableSynthesisFailure(data) {
    if (!data || data.success) return false;
    if (data.retryable === true) return true;
    return ['TTS_NOT_RUNNING', 'TTS_CONNECTION_FAILED', 'INVALID_AUDIO', 'AUDIO_DOWNLOAD_FAILED']
      .includes(String(data.errorCode || ''));
  }

  async function requestVoiceSynthesis(payload, { notify = true, allowStart = true, maxAttempts = VOICE_SYNTHESIS_MAX_ATTEMPTS, cancelToken = null, groupId = null } = {}) {
    const cleanText = normalizeTtsTextForRequest(payload?.text);
    if (cleanText.length < 2) {
      return { success: false, errorCode: 'TEXT_TOO_SHORT', error: '可朗读文本不足2个字符' };
    }
    const requestPayload = {
      ...payload,
      text: cleanText,
      ...(groupId ? { replyGroupId: groupId } : {}),
      requestId: payload?.requestId || `voice_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    };
    const inflightKey = JSON.stringify([
      currentCharacterId || '', cleanText, requestPayload.emotion || 'auto',
      requestPayload.preview ? 'preview' : 'chat',
      // force 只控制“是否跳过已完成缓存”，不应让并发的两次刷新各自占用
      // 一个 TTS 推理槽；串行刷新在上一轮完成后仍会正常重新合成。
      requestPayload.emotion && requestPayload.emotion !== 'auto'
        ? ''
        : normalizeTtsTextForRequest(requestPayload.userMessage || ''),
      requestPayload.performanceEmotion || '',
      requestPayload.intent || '',
      requestPayload.intensity ?? '',
      requestPayload.confidence ?? '',
      JSON.stringify(requestPayload.emphasis || []),
      JSON.stringify(requestPayload.segments || []),
    ]);
    if (voiceSynthesisInflight.has(inflightKey)) return voiceSynthesisInflight.get(inflightKey);

    const task = enqueueVoiceGeneration(async () => {
      if (cancelToken?.cancelled) {
        return { success: false, cancelled: true, errorCode: 'VOICE_CANCELLED', error: '已取消等待' };
      }
      if (allowStart && !ttsAvailable) {
        const started = await ensureVoiceServiceStarted({ notify, force: false });
        if (!started.success) return started;
      }
      let lastFailure = { success: false, errorCode: 'TTS_SYNTHESIS_FAILED', error: '语音合成失败' };
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) await waitVoiceRetry(VOICE_RETRY_DELAYS_MS[attempt - 1]);
        try {
          const data = await readJsonResponse(await fetch('/api/voice/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload),
          }));
          if (data.success && data.audioUrl) return { ...data, requestAttempts: attempt };
          lastFailure = { ...data, success: false, requestAttempts: attempt };
          if (data.errorCode === 'TTS_NOT_RUNNING' && allowStart && !voiceStoppedByUserThisSession) {
            ttsAvailable = false;
            const started = await ensureVoiceServiceStarted({ notify: false, force: false });
            if (!started.success) { lastFailure = started; break; }
          } else if (!isRetryableSynthesisFailure(data)) {
            break;
          }
        } catch (error) {
          lastFailure = {
            success: false,
            errorCode: 'TTS_CONNECTION_FAILED',
            error: error?.message || '无法连接本地语音合成接口',
            retryable: true,
            requestAttempts: attempt,
          };
        }
      }
      if (notify && lastFailure.errorCode !== 'USER_DISABLED') {
        showToast(`语音合成失败：${lastFailure.error || '请稍后点击语音按钮重试'}`, 5000);
      }
      return lastFailure;
    }, cancelToken, groupId);
    voiceSynthesisInflight.set(inflightKey, task);
    try { return await task; }
    finally { voiceSynthesisInflight.delete(inflightKey); }
  }

  // ========== 语音开关按钮逻辑（点击弹出 popover，不再直接启停）==========
  // 通用包由 Electron 在启动时自动选择 GPU/CPU；前端只显示真实结果。
  let selectedDevice = 'cpu';
  let availableDevices = ['cpu'];
  let allowDeviceSwitch = false;
  let ttsServiceReachable = false;
  let popoverOpen = false;

  function updateVoiceToggleUI(state) {
    if (!btnVoiceToggle) return;
    btnVoiceToggle.classList.remove('voice-on', 'voice-off', 'voice-loading');
    if (state === 'on') {
      btnVoiceToggle.classList.add('voice-on');
      btnVoiceToggle.title = '语音服务已开启（点击打开控制面板）';
    } else if (state === 'loading') {
      btnVoiceToggle.classList.add('voice-loading');
      btnVoiceToggle.title = '正在处理...';
    } else {
      btnVoiceToggle.classList.add('voice-off');
      btnVoiceToggle.title = '语音服务已关闭（点击打开控制面板）';
    }
    // 同步 popover 状态标签
    const tag = document.getElementById('voice-popover-status');
    if (tag) {
      tag.classList.remove('on', 'off', 'loading');
      if (state === 'on') { tag.classList.add('on'); tag.textContent = '运行中'; }
      else if (state === 'loading') { tag.classList.add('loading'); tag.textContent = '处理中'; }
      else { tag.classList.add('off'); tag.textContent = '已停止'; }
    }
    // 同步设备按钮选中状态
    updateDeviceBtns();
  }

  function updateHeaderDeviceButtons() {
    const hGpuBtn = document.getElementById('header-device-gpu');
    const hCpuBtn = document.getElementById('header-device-cpu');
    const hSwitch = document.getElementById('header-device-switch');
    if (hGpuBtn) hGpuBtn.classList.toggle('active', selectedDevice === 'gpu');
    if (hCpuBtn) hCpuBtn.classList.toggle('active', selectedDevice === 'cpu');
    // 允许切换时启用按钮，TTS运行中时锁定
    const canSwitch = allowDeviceSwitch && !ttsAvailable;
    if (hGpuBtn) hGpuBtn.disabled = !canSwitch || selectedDevice === 'gpu';
    if (hCpuBtn) hCpuBtn.disabled = !canSwitch || selectedDevice === 'cpu';
    // 不允许切换设备时，隐藏伸缩框设备切换区域
    const numDevices = Array.isArray(availableDevices) ? availableDevices.length : 2;
    if (hSwitch) hSwitch.style.display = numDevices <= 1 ? 'none' : '';
  }

  function updateDeviceBtns() {
    const gpuBtn = document.getElementById('voice-device-gpu');
    const cpuBtn = document.getElementById('voice-device-cpu');
    const deviceSection = document.querySelector('.voice-popover-device');
    const deviceLabel = document.querySelector('.voice-popover-label');
    if (gpuBtn) gpuBtn.classList.toggle('active', selectedDevice === 'gpu');
    if (cpuBtn) cpuBtn.classList.toggle('active', selectedDevice === 'cpu');
    // 允许切换时启用按钮，TTS运行中时锁定
    const canSwitch = allowDeviceSwitch && !ttsAvailable;
    if (gpuBtn) gpuBtn.disabled = !canSwitch || selectedDevice === 'gpu';
    if (cpuBtn) cpuBtn.disabled = !canSwitch || selectedDevice === 'cpu';
    // 同步伸缩框设备按钮
    updateHeaderDeviceButtons();
    // 不允许切换设备时，隐藏设备选择区域（单设备发布包）
    const numDevices = Array.isArray(availableDevices) ? availableDevices.length : 2;
    const hideDeviceSection = numDevices <= 1;
    if (hideDeviceSection) {
      if (deviceSection) deviceSection.style.display = 'none';
      if (deviceLabel) deviceLabel.style.display = 'none';
      if (gpuBtn) gpuBtn.style.display = 'none';
      if (cpuBtn) cpuBtn.style.display = 'none';
    } else {
      if (deviceSection) deviceSection.style.display = '';
      if (deviceLabel) deviceLabel.style.display = '';
      if (gpuBtn) gpuBtn.style.display = '';
      if (cpuBtn) cpuBtn.style.display = '';
    }
    // 更新提示
    const tip = document.getElementById('voice-popover-tip');
    if (tip) {
      if (hideDeviceSection) {
        tip.textContent = '语音服务使用 ' + selectedDevice.toUpperCase() + ' 设备';
      } else if (ttsAvailable) {
        tip.textContent = '语音服务运行中（' + selectedDevice.toUpperCase() + '），停止后可切换设备';
      } else {
        tip.textContent = '选择合成设备：GPU 快（约2-5秒），CPU 稳定（约30秒+）';
      }
    }
    // 同步启停按钮
    const startBtn = document.getElementById('voice-action-start');
    const stopBtn = document.getElementById('voice-action-stop');
    if (startBtn) startBtn.disabled = ttsAvailable;
    if (stopBtn) stopBtn.disabled = !ttsServiceReachable;
  }

  function togglePopover(force) {
    const pop = document.getElementById('voice-control-popover');
    if (!pop) return;
    popoverOpen = (typeof force === 'boolean') ? force : !popoverOpen;
    pop.style.display = popoverOpen ? 'block' : 'none';
    if (popoverOpen) updateDeviceBtns();
  }

  // ★ 语音可用性检查
  async function checkVoiceAvailability() {
    try {
      const r = await fetch('/api/voice/status');
      const d = await r.json();
      if (d.device) selectedDevice = d.device;
      if (Array.isArray(d.availableDevices)) availableDevices = d.availableDevices;
      if (typeof d.allowDeviceSwitch === 'boolean') allowDeviceSwitch = d.allowDeviceSwitch;
      ttsServiceReachable = d.serviceReachable === true;
      if (d.ttsAvailable) {
        if (!ttsAvailable) {
          ttsAvailable = true;
          updateVoiceToggleUI('on');
        }
      } else {
        ttsAvailable = false;
        updateVoiceToggleUI('off');
      }
      return d.ttsAvailable;
    } catch (e) {
      return false;
    }
  }

  // 初始化：页面打开即自动启动 TTS；连续失败2次后附带内存占用诊断。
  async function initVoiceToggle() {
    if (!btnVoiceToggle) return;
    try {
      const r = await fetch('/api/voice/status');
      const d = await readJsonResponse(r);
      if (d.device) selectedDevice = d.device;
      if (Array.isArray(d.availableDevices)) availableDevices = d.availableDevices;
      if (typeof d.allowDeviceSwitch === 'boolean') allowDeviceSwitch = d.allowDeviceSwitch;
      ttsServiceReachable = d.serviceReachable === true;
      if (d.ttsAvailable) {
        ttsAvailable = true;
        voiceStoppedByUserThisSession = false;
        localStorage.removeItem(VOICE_USER_DISABLED_KEY);
        // 同步服务端实际设备
        if (d.device) selectedDevice = d.device;
        updateVoiceToggleUI('on');
      } else if (ttsServiceReachable) {
        ttsAvailable = false;
        updateVoiceToggleUI('off');
        if (d.deviceMismatch) showToast(`检测到残留的 ${String(d.device || '').toUpperCase()} 语音服务，请先停止后再启动`, 5000);
      } else {
        ttsAvailable = false;
        await ensureVoiceServiceStarted({ notify: true, force: true });
      }
    } catch (e) {
      ttsAvailable = false;
      await ensureVoiceServiceStarted({ notify: true, force: true });
    }
  }

  if (btnVoiceToggle) {
    // 点击小喇叭 → 切换 popover（不再直接启停）
    btnVoiceToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover();
    });
    // 点击页面其他位置关闭 popover
    document.addEventListener('click', (e) => {
      const pop = document.getElementById('voice-control-popover');
      if (popoverOpen && pop && !pop.contains(e.target) && !btnVoiceToggle.contains(e.target)) {
        togglePopover(false);
      }
    });

    // 设备切换按钮：切换 GPU/CPU 合成设备
    document.getElementById('voice-device-gpu')?.addEventListener('click', async () => {
      if (ttsAvailable) { showToast('请先停止语音服务再切换设备', 2000); return; }
      if (selectedDevice === 'gpu') return;
      try {
        const r = await fetch('/api/voice/switch-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'gpu' }) });
        const d = await r.json();
        if (d.success) {
          selectedDevice = d.device;
          updateDeviceBtns();
          showToast('已切换至 GPU 设备', 2000);
        } else {
          showToast(d.error || '切换失败', 2000);
        }
      } catch (e) { showToast('切换失败', 2000); }
    });
    document.getElementById('voice-device-cpu')?.addEventListener('click', async () => {
      if (ttsAvailable) { showToast('请先停止语音服务再切换设备', 2000); return; }
      if (selectedDevice === 'cpu') return;
      try {
        const r = await fetch('/api/voice/switch-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'cpu' }) });
        const d = await r.json();
        if (d.success) {
          selectedDevice = d.device;
          updateDeviceBtns();
          showToast('已切换至 CPU 设备', 2000);
        } else {
          showToast(d.error || '切换失败', 2000);
        }
      } catch (e) { showToast('切换失败', 2000); }
    });

    // 伸缩框 GPU/CPU 切换按钮事件
    document.getElementById('header-device-gpu')?.addEventListener('click', async () => {
      if (ttsAvailable) { showToast('请先停止语音服务再切换设备', 2000); return; }
      if (selectedDevice === 'gpu') return;
      try {
        const r = await fetch('/api/voice/switch-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'gpu' }) });
        const d = await r.json();
        if (d.success) {
          selectedDevice = d.device;
          updateDeviceBtns();
          showToast('已切换至 GPU 设备', 2000);
        } else {
          showToast(d.error || '切换失败', 2000);
        }
      } catch (e) { showToast('切换失败', 2000); }
    });
    document.getElementById('header-device-cpu')?.addEventListener('click', async () => {
      if (ttsAvailable) { showToast('请先停止语音服务再切换设备', 2000); return; }
      if (selectedDevice === 'cpu') return;
      try {
        const r = await fetch('/api/voice/switch-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'cpu' }) });
        const d = await r.json();
        if (d.success) {
          selectedDevice = d.device;
          updateDeviceBtns();
          showToast('已切换至 CPU 设备', 2000);
        } else {
          showToast(d.error || '切换失败', 2000);
        }
      } catch (e) { showToast('切换失败', 2000); }
    });

    // 启动按钮
    document.getElementById('voice-action-start')?.addEventListener('click', async () => {
      voiceStoppedByUserThisSession = false;
      await ensureVoiceServiceStarted({ notify: true, force: true });
    });

    // 停止按钮
    document.getElementById('voice-action-stop')?.addEventListener('click', async () => {
      updateVoiceToggleUI('loading');
      showToast('正在停止语音服务...', 2000);
      try {
        const r = await fetch('/api/voice/stop', { method: 'POST' });
        const d = await r.json();
        if (d.success) {
          ttsAvailable = false;
          ttsServiceReachable = false;
          voiceEnabled = false;
          voiceStoppedByUserThisSession = true;
          localStorage.setItem(VOICE_USER_DISABLED_KEY, '1');
          updateVoiceToggleUI('off');
          showToast('语音服务已停止', 2000);
          if (typeof checkVoiceAvailability === 'function') {
            setTimeout(checkVoiceAvailability, 500);
          }
        } else {
          updateVoiceToggleUI('on');
          showToast('停止失败: ' + (d.error || '未知错误'), 3000);
        }
      } catch (e) {
        updateVoiceToggleUI('on');
        showToast('停止失败，请检查网络', 3000);
      }
    });

  }

  // 页面首次加载完成后，短暂显示header提示用户语音开关位置
  setTimeout(() => {
    showHeaderInitialHint();
  }, 800);

  let pendingImageBase64 = null;
  const confirmText = document.getElementById('confirm-text');
  const btnConfirmYes = document.getElementById('btn-confirm-yes');
  const btnConfirmNo = document.getElementById('btn-confirm-no');

  const setProvider = document.getElementById('set-provider');
  const setSubmodel = document.getElementById('set-submodel');
  const setApikey = document.getElementById('set-apikey');
  const setBaseurl = { value: '', placeholder: '' }; // 已移除UI，用隐藏对象替代
  const setModel = { value: '', placeholder: '' };
  const setCapability = document.getElementById('set-capability');
  const setReasoning = document.getElementById('set-reasoning');
  const btnSaveApi = document.getElementById('btn-save-api');
  const apiStatus = document.getElementById('api-status');
  const providerWebsite = document.getElementById('provider-website');
  const conversationModeInputs = document.querySelectorAll('input[name="conversation-mode"]');
  const btnSaveConversationMode = document.getElementById('btn-save-conversation-mode');
  const conversationModeStatus = document.getElementById('conversation-mode-status');

  const btnSyncModels = document.getElementById('btn-sync-models');
  const syncStatus = document.getElementById('sync-status');
  const btnEditModels = document.getElementById('btn-edit-models');
  const btnResetRegistry = document.getElementById('btn-reset-registry');
  const editModelsPanel = document.getElementById('edit-models-panel');
  const editWebsite = document.getElementById('edit-website');
  const editBaseurl = document.getElementById('edit-baseurl');
  const editDefaultModel = document.getElementById('edit-default-model');
  const editModelsList = document.getElementById('edit-models-list');
  const btnSaveModels = document.getElementById('btn-save-models');
  const btnCancelModels = document.getElementById('btn-cancel-models');

  const setOpacity = document.getElementById('set-opacity');
  const setBrightness = document.getElementById('set-brightness');
  const setFontsize = document.getElementById('set-fontsize');
  const setFontfamily = document.getElementById('set-fontfamily');
  const setRadius = document.getElementById('set-radius');
  const setTheme = document.getElementById('set-theme');
  const setBreathSpeed = document.getElementById('set-breath-speed');
  const setTouchIntensity = document.getElementById('set-touch-intensity');
  const setRippleFreq = document.getElementById('set-ripple-freq');
  const setRippleStyle = document.getElementById('set-ripple-style');
  // 设置页底色透明度滑块（顶部"设置"字样旁）
  const setSettingsBgOpacity = document.getElementById('set-settings-bg-opacity');
  const valSettingsBgOpacity = document.getElementById('val-settings-bg-opacity');
  const valOpacity = document.getElementById('val-opacity');
  const valBrightness = document.getElementById('val-brightness');
  const valFontsize = document.getElementById('val-fontsize');
  const valRadius = document.getElementById('val-radius');

  const btnGenerateSkill = null; // 已合并到 btnDistillWeb
  const btnRollbackSkill = document.getElementById('btn-rollback-skill');
  const skillStatus = document.getElementById('distill-web-status');
  const setSkill = document.getElementById('set-skill');
  const btnSaveSkill = document.getElementById('btn-save-skill');
  const skillUrlsList = document.getElementById('skill-urls-list');
  const addSkillUrlType = document.getElementById('add-skill-url-type');
  const addSkillUrlTitle = document.getElementById('add-skill-url-title');
  const addSkillUrlValue = document.getElementById('add-skill-url-value');
  const btnAddSkillUrl = document.getElementById('btn-add-skill-url');
  const btnClearHistory = document.getElementById('btn-clear-history');
  const btnClearImageCache = document.getElementById('btn-clear-image-cache');
  const btnClearVoiceCache = document.getElementById('btn-clear-voice-cache');
  const btnRebuildIndex = document.getElementById('btn-rebuild-index');

  // Toast 提示（轻量级通知）
  function showToast(message, duration = 2500) {
    let toast = document.getElementById('app-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast';
      toast.style.cssText = 'position:fixed;top:20%;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:99999;pointer-events:none;opacity:0;transition:opacity 0.3s;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);max-width:80vw;text-align:center;';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
  }

  // 通用信息弹窗（符合页面UI风格的模态框，替代alert）
  const infoModal = document.getElementById('info-modal');
  const infoText = document.getElementById('info-text');
  const btnInfoOk = document.getElementById('btn-info-ok');

  function showInfoModal(message) {
    if (!infoModal) { showToast(message, 4000); return; }
    infoText.textContent = message;
    infoModal.style.display = 'flex';
  }

  function closeInfoModal() {
    if (infoModal) infoModal.style.display = 'none';
  }

  if (btnInfoOk) {
    btnInfoOk.addEventListener('click', closeInfoModal);
    // 点击遮罩层关闭
    if (infoModal) {
      infoModal.addEventListener('click', (e) => {
        if (e.target === infoModal) closeInfoModal();
      });
    }
  }

  // 人物蒸馏相关元素
  const tabDistillWeb = document.getElementById('tab-distill-web');
  const tabDistillCustom = document.getElementById('tab-distill-custom');
  const panelDistillWeb = document.getElementById('panel-distill-web');
  const panelDistillCustom = document.getElementById('panel-distill-custom');
  const distillManifestInfo = document.getElementById('distill-manifest-info');
  const distillWebName = document.getElementById('distill-web-name');
  const distillWebType = document.getElementById('distill-web-type');
  const distillWebHints = document.getElementById('distill-web-hints');
  const distillWebStatus = document.getElementById('distill-web-status');
  const btnDistillWeb = document.getElementById('btn-distill-web');
  const distillCustomName = document.getElementById('distill-custom-name');
  const distillCustomRelationship = document.getElementById('distill-custom-relationship');
  const distillCustomPurpose = document.getElementById('distill-custom-purpose');
  const distillCustomPersonality = document.getElementById('distill-custom-personality');
  const distillCustomChat = document.getElementById('distill-custom-chat');
  const distillCustomMoments = document.getElementById('distill-custom-moments');
  const distillCustomNotes = document.getElementById('distill-custom-notes');
  const distillCustomStatus = document.getElementById('distill-custom-status');
  const btnDistillCustom = document.getElementById('btn-distill-custom');

  const setSupplementary = document.getElementById('set-supplementary');
  const btnSaveSupplementary = document.getElementById('btn-save-supplementary');
  const setConversationSkills = document.getElementById('set-conversation-skills');
  const btnSaveConversationSkills = document.getElementById('btn-save-conversation-skills');
  const knowledgeUrlsList = document.getElementById('knowledge-urls-list');
  const addUrlType = document.getElementById('add-url-type');
  const addUrlWiki = document.getElementById('add-url-wiki');
  const addUrlLabel = document.getElementById('add-url-label');
  const addUrlValue = document.getElementById('add-url-value');
  const btnAddUrl = document.getElementById('btn-add-url');

  addUrlType.addEventListener('change', () => {
    addUrlWiki.style.display = addUrlType.value === 'bwiki' ? 'inline-block' : 'none';
    // 根据类型更新placeholder
    const valueInput = addUrlValue;
    if (addUrlType.value === 'bwiki') {
      valueInput.placeholder = '角色在BWIKI上的页面名（如：露西亚），可用|加前缀';
    } else if (addUrlType.value === 'search') {
      valueInput.placeholder = '搜索页主URL（如 https://www.douyin.com/search/）';
    } else if (addUrlType.value === 'api') {
      valueInput.placeholder = 'API接口URL（返回JSON）';
    } else {
      valueInput.placeholder = '网页URL（如 https://wiki.kurobbs.com/pns/露西亚）';
    }
    updateAddUrlBtnState();
  });

  // 实时校验：输入为空时禁用添加按钮
  function updateAddUrlBtnState() {
    const value = addUrlValue.value.trim();
    const valid = !!value;
    btnAddUrl.disabled = !valid;
    if (!valid) {
      btnAddUrl.style.opacity = '0.5';
      btnAddUrl.style.cursor = 'not-allowed';
      btnAddUrl.style.pointerEvents = 'none';
    } else {
      btnAddUrl.style.opacity = '1';
      btnAddUrl.style.cursor = 'pointer';
      btnAddUrl.style.pointerEvents = 'auto';
    }
  }
  addUrlValue.addEventListener('input', updateAddUrlBtnState);
  addUrlLabel.addEventListener('input', updateAddUrlBtnState);
  // 切换类型时也更新（因为placeholder可能变）
  addUrlType.addEventListener('change', updateAddUrlBtnState);
  updateAddUrlBtnState();

  const permanentFactsList = document.getElementById('permanent-facts-list');
  const addFactInput = document.getElementById('add-fact-input');
  const btnAddFact = document.getElementById('btn-add-fact');

  // ============================================================
  // 库洛Wiki登录
  // ============================================================
  const kuroStatus = document.getElementById('kuro-status');
  const kuroLoginPanel = document.getElementById('kuro-login-panel');
  const kuroLoggedInPanel = document.getElementById('kuro-logged-in-panel');
  const kuroTokenInput = document.getElementById('kuro-token-input');
  const btnKuroSetToken = document.getElementById('btn-kuro-set-token');
  const btnKuroTest = document.getElementById('btn-kuro-test');
  const btnKuroLogout = document.getElementById('btn-kuro-logout');
  const kuroTestResult = document.getElementById('kuro-test-result');
  const kuroEnabledCheckbox = document.getElementById('kuro-enabled');
  const kuroGameTypeSelect = document.getElementById('kuro-game-type');

  async function loadKuroStatus() {
    if (!kuroStatus) return;
    try {
      const res = await fetch('/api/kuro/status');
      const data = await res.json();
      // 更新开关和游戏选择
      if (kuroEnabledCheckbox) kuroEnabledCheckbox.checked = data.enabled !== false;
      if (kuroGameTypeSelect) kuroGameTypeSelect.value = data.gameType || 'pns';
      if (data.success && data.loggedIn) {
        kuroStatus.textContent = '已登录 (Token: ' + data.tokenPreview + ')';
        kuroStatus.style.color = '#07c160';
        kuroLoginPanel.style.display = 'none';
        kuroLoggedInPanel.style.display = 'block';
      } else {
        kuroStatus.textContent = '未登录 — 登录后可获取库洛Wiki角色资料';
        kuroStatus.style.color = '#999';
        kuroLoginPanel.style.display = 'block';
        kuroLoggedInPanel.style.display = 'none';
      }
    } catch (e) {
      kuroStatus.textContent = '检测失败';
      kuroStatus.style.color = '#ff4d4f';
    }
  }

  // 库洛Wiki开关和游戏选择变化时保存
  function saveKuroSettings() {
    const enabled = kuroEnabledCheckbox ? kuroEnabledCheckbox.checked : true;
    const gameType = kuroGameTypeSelect ? kuroGameTypeSelect.value : 'pns';
    fetch('/api/kuro/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, gameType }),
    }).catch(() => {});
  }

  if (kuroEnabledCheckbox) {
    kuroEnabledCheckbox.addEventListener('change', saveKuroSettings);
  }
  if (kuroGameTypeSelect) {
    kuroGameTypeSelect.addEventListener('change', saveKuroSettings);
  }

  if (btnKuroSetToken) {
    btnKuroSetToken.addEventListener('click', async () => {
      const token = kuroTokenInput.value.trim();
      if (!token) return;
      btnKuroSetToken.disabled = true;
      try {
        const res = await fetch('/api/kuro/set-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (data.success) {
          kuroTokenInput.value = '';
          loadKuroStatus();
        } else {
          showInfoModal(data.error || '保存失败');
        }
      } catch (e) {
        showInfoModal('保存失败');
      }
      btnKuroSetToken.disabled = false;
    });
  }

  if (btnKuroTest) {
    btnKuroTest.addEventListener('click', async () => {
      kuroTestResult.textContent = '正在测试API...';
      kuroTestResult.style.color = '#999';
      btnKuroTest.disabled = true;
      try {
        const res = await fetch('/api/kuro/test-api', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          const entryCount = data.data && data.data.list ? data.data.list.length : 0;
          kuroTestResult.textContent = `API可用！搜索"露西亚"返回 ${entryCount} 条结果`;
          kuroTestResult.style.color = '#07c160';
        } else {
          kuroTestResult.textContent = data.error || 'API不可用';
          kuroTestResult.style.color = '#ff4d4f';
        }
      } catch (e) {
        kuroTestResult.textContent = '测试失败';
        kuroTestResult.style.color = '#ff4d4f';
      }
      btnKuroTest.disabled = false;
    });
  }

  if (btnKuroLogout) {
    btnKuroLogout.addEventListener('click', async () => {
      try {
        await fetch('/api/kuro/logout', { method: 'POST' });
        loadKuroStatus();
      } catch (e) {}
    });
  }

  // ============================================================
  // 对话技能（角色专属，通用自动注入不显示）
  // ============================================================
  const conversationSkillsEditor = document.getElementById('conversation-skills-editor');
  const btnDeleteCharSkills = document.getElementById('btn-delete-char-skills');
  const skillsSaveHint = document.getElementById('skills-save-hint');

  async function loadConversationSkills() {
    try {
      const res = await fetch('/api/conversation-skills');
      const data = await res.json();
      if (data.success) {
        // 只显示角色专属技能内容
        conversationSkillsEditor.value = data.hasCharSkills ? (data.charSkills || '') : '';
        btnDeleteCharSkills.style.display = data.hasCharSkills ? 'inline-block' : 'none';
      }
    } catch (e) {}
  }

  if (btnSaveConversationSkills) {
    btnSaveConversationSkills.addEventListener('click', async () => {
      const content = conversationSkillsEditor.value;
      btnSaveConversationSkills.disabled = true;
      try {
        const res = await fetch('/api/conversation-skills/character', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        const data = await res.json();
        if (data.success) {
          skillsSaveHint.textContent = '已保存';
          skillsSaveHint.style.color = '#07c160';
          setTimeout(() => { skillsSaveHint.textContent = ''; }, 2000);
          loadConversationSkills();
        } else {
          skillsSaveHint.textContent = data.error || '保存失败';
          skillsSaveHint.style.color = '#ff4d4f';
        }
      } catch (e) {
        skillsSaveHint.textContent = '保存失败';
        skillsSaveHint.style.color = '#ff4d4f';
      }
      btnSaveConversationSkills.disabled = false;
    });
  }

  if (btnDeleteCharSkills) {
    btnDeleteCharSkills.addEventListener('click', async () => {
      if (!confirm('确定删除角色专属对话技能？删除后该角色将不再有对话技能规则。')) return;
      try {
        await fetch('/api/conversation-skills/character', { method: 'DELETE' });
        loadConversationSkills();
      } catch (e) {}
    });
  }

  const setCharName = document.getElementById('set-char-name');
  const setCharRole = document.getElementById('set-char-role');
  const setCharTitle = document.getElementById('set-char-title');
  const setCharUserCognition = document.getElementById('set-char-user-cognition');
  const setCharStyle = document.getElementById('set-char-style');
  const setCharSearchHints = document.getElementById('set-char-search-hints'); // 已从UI移除，保留兼容
  const setCharBackground = document.getElementById('set-char-background');
  const setCharPersonality = document.getElementById('set-char-personality');
  const setCharSpeaking = document.getElementById('set-char-speaking');
  const setCharLikes = document.getElementById('set-char-likes');
  const setCharStory = document.getElementById('set-char-story');
  const btnSaveCharacter = document.getElementById('btn-save-character');
  const currentCharLabel = document.getElementById('current-char-label');

  const btnAddCharacter = document.getElementById('btn-add-character');
  const charactersListEl = document.getElementById('characters-list');
  const createCharModal = document.getElementById('create-character-modal');
  const btnCloseCreateChar = document.getElementById('btn-close-create-char');
  const btnCancelCreateChar = document.getElementById('btn-cancel-create-char');
  const btnConfirmCreateChar = document.getElementById('btn-confirm-create-char');
  const btnBackCreateChar = document.getElementById('btn-back-create-char');
  const btnNextCreateChar = document.getElementById('btn-next-create-char');
  const btnFinishCreateChar = document.getElementById('btn-finish-create-char');
  const createStep1 = document.getElementById('create-step-1');
  const createStepWeb = document.getElementById('create-step-web');
  const createStepCustom = document.getElementById('create-step-custom');
  const createStepProgress = document.getElementById('create-step-progress');
  const createStepImages = document.getElementById('create-step-images');
  const createMethodWeb = document.getElementById('create-method-web');
  const createMethodCustom = document.getElementById('create-method-custom');
  const createModalTitle = document.getElementById('create-modal-title');
  const createWebUrlsList = document.getElementById('create-web-urls-list');
  const btnCreateWebAddUrl = document.getElementById('btn-create-web-add-url');
  const createProgressStatus = document.getElementById('create-progress-status');
  const createProgressDetail = document.getElementById('create-progress-detail');
  let createMethod = null;
  let createStep = 1;
  let createWebUrls = []; // 创建角色时的自定义网址
  let createdCharId = null; // 已创建的角色ID（用于自定义流程的图片上传步骤）

  let providerRegistry = {};
  let knowledgeUrls = [];
  let skillUrls = [];
  let currentCharacterId = 'default';
  let currentCharacterName = '赛琳娜';

  let isSending = false;
  let lastTimeDivider = '';

  let longPressTimer = null;
  let longPressTarget = null;

  const msgContextMenu = document.getElementById('msg-context-menu');
  const btnDeleteMsg = document.getElementById('btn-delete-msg');

  function getCharacterImageUrl(type) {
    return `/api/character-image/${currentCharacterId}/${type}?t=${Date.now()}`;
  }

  function hideContextMenu() {
    if (msgContextMenu) {
      msgContextMenu.style.display = 'none';
    }
  }

  function showContextMenu(x, y, msgRow) {
    if (!msgContextMenu) return;
    longPressTarget = msgRow;
    msgContextMenu.style.display = 'block';
    const menuWidth = 100;
    const menuHeight = 40;
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;
    if (x + menuWidth > winWidth) x = winWidth - menuWidth - 8;
    if (y + menuHeight > winHeight) y = winHeight - menuHeight - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    msgContextMenu.style.left = x + 'px';
    msgContextMenu.style.top = y + 'px';
  }

  messagesEl.addEventListener('contextmenu', (e) => {
    const msgRow = e.target.closest('.message-row');
    if (!msgRow || msgRow.id === 'typing-row') return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, msgRow);
  });

  messagesEl.addEventListener('touchstart', (e) => {
    const msgRow = e.target.closest('.message-row');
    if (!msgRow || msgRow.id === 'typing-row') return;
    longPressTimer = setTimeout(() => {
      const touch = e.touches[0];
      showContextMenu(touch.clientX, touch.clientY, msgRow);
    }, 500);
  }, { passive: true });

  messagesEl.addEventListener('touchend', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  messagesEl.addEventListener('touchmove', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });

  document.addEventListener('click', (e) => {
    if (msgContextMenu && !msgContextMenu.contains(e.target)) {
      hideContextMenu();
    }
  });

  if (btnDeleteMsg) {
    btnDeleteMsg.addEventListener('click', async () => {
      if (!longPressTarget) return;
      const idx = parseInt(longPressTarget.dataset.msgIndex);
      if (isNaN(idx)) { hideContextMenu(); return; }
      showConfirm('确定要删除这条消息吗？', async () => {
        try {
          const res = await fetch('/api/delete-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: idx }),
          });
          const data = await res.json();
          if (data.success) {
            longPressTarget.style.transition = 'opacity 0.25s, transform 0.25s';
            longPressTarget.style.opacity = '0';
            longPressTarget.style.transform = 'scale(0.9)';
            setTimeout(() => { loadHistory(); }, 260);
          }
        } catch (error) { console.error('[Delete] Failed:', error); }
      });
      hideContextMenu();
    });
  }

  let greetingTimer = null;
  let idleTimer = null;
  let lastUserMsgTime = null;
  let greetingSentThisSession = false;
  let consecutiveProactiveCount = 0;

  // 主动消息按“上一条成功送达消息”增量计时：
  // 角色直接回复用户后按约 0.5h/6h/12h/24h/36h/48h 的克制阶梯跟进，之后每天最多一条。
  // 使用增量间隔避免应用重新打开时把错过的多个阶段追赶式连发。
  const PROACTIVE_SCHEDULE = [
    { waitMin: 30, type: 'idle' },
    { waitMin: 330, type: 'idle' },
    { waitMin: 360, type: 'long-absence' },
    { waitMin: 720, type: 'long-absence' },
    { waitMin: 720, type: 'long-absence' },
    { waitMin: 720, type: 'long-absence' },
  ];
  const PROACTIVE_REPEAT_MIN = 1440;

  function getMessageTimeMs(message) {
    if (!message?.time) return NaN;
    return new Date(String(message.time).replace(' ', 'T')).getTime();
  }

  // 只有角色已经成功直接回答最后一条用户消息时才启动主动链。
  // 每一阶段都从上一条实际写入历史的主动消息重新计时，避免重开应用后追赶式连发。
  function shouldSendProactive(history) {
    const lastUserIndex = history.map(m => m.role).lastIndexOf('user');
    if (lastUserIndex < 0) return null;

    const afterLastUser = history.slice(lastUserIndex + 1);
    const directReply = afterLastUser.find(m => m.role === 'assistant' && !m.proactive);
    const directReplyTime = getMessageTimeMs(directReply);
    if (!Number.isFinite(directReplyTime)) return null;

    const sentProactives = afterLastUser.filter(m => m.role === 'assistant' && m.proactive);
    const stage = PROACTIVE_SCHEDULE[sentProactives.length];
    const anchor = sentProactives.length > 0
      ? sentProactives[sentProactives.length - 1]
      : directReply;
    const anchorTime = getMessageTimeMs(anchor);
    if (!Number.isFinite(anchorTime)) return null;

    const elapsedMin = Math.max(0, (Date.now() - anchorTime) / (1000 * 60));
    if (stage) return elapsedMin >= stage.waitMin ? stage.type : null;
    return elapsedMin >= PROACTIVE_REPEAT_MIN ? 'long-absence' : null;
  }

  function navigateTo(target) {
    if (target === 'settings') {
      pageChat.className = 'page left';
      pageSettings.className = 'page active';
      pageCharacters.className = 'page right';
      loadCharacterProfile();
      loadSkill();
      loadSkillUrls();
      loadKnowledgeUrls();
      loadPermanentFacts();
      loadSupplementary();
      loadConversationSkills();
      loadCharacterImages();
      loadDistillManifest();
      loadKuroStatus();
      void loadDailyPerformanceCandidates();
    } else if (target === 'characters') {
      pageChat.className = 'page left';
      pageSettings.className = 'page right';
      pageCharacters.className = 'page active';
      loadCharactersList();
    } else {
      pageChat.className = 'page active';
      pageSettings.className = 'page right';
      pageCharacters.className = 'page right';
      // 切换回聊天页面时，如果尚未显示过首次提示，则短暂显示header
      showHeaderInitialHint();
    }
  }

  const DAILY_CANDIDATE_EMOTION_NAMES = {
    gentle: '温柔', happy: '开心', explaining: '解释', curious: '疑惑',
    thinking: '思考', grateful: '感谢', apologetic: '道歉'
  };

  function candidateText(value) {
    return value == null ? '' : String(value);
  }

  function createReleaseCandidateButton(label, handler, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.className = className || 'settings-action-btn';
    button.style.cssText = 'padding:4px 8px;font-size:11px;white-space:nowrap;';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await handler(); } catch (error) {
        console.error('[daily-candidates] action failed:', label, error);
        alert(label + '失败：' + (error && error.message ? error.message : String(error)));
      } finally { button.disabled = false; }
    });
    return button;
  }

  function renderReleaseCandidateMeta(candidate, pair) {
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:#718096;line-height:1.5;white-space:pre-line;margin:4px 0 6px;';
    meta.textContent = [
      '情感：' + (DAILY_CANDIDATE_EMOTION_NAMES[candidate.emotion] || candidate.emotion),
      '时长：' + Number(candidate.durationSeconds).toFixed(2) + ' 秒',
      '来源：' + candidateText(candidate.source && candidate.source.sourceType) + ' / ' + candidateText(candidate.source && candidate.source.author),
      '条款：' + candidateText(candidate.source && candidate.source.statedTerms),
      '审计：通过 / SHA：' + candidateText(candidate.source && candidate.source.sha256).slice(0, 12) + '…',
      '原配：' + (pair ? candidateText(pair.displayName) : '无')
    ].join('\n');
    return meta;
  }

  function renderReleaseCandidateRow(candidate, allCandidates) {
    const row = document.createElement('div');
    row.style.cssText = 'border:1px solid rgba(120,150,180,.28);border-radius:7px;padding:8px;margin:6px 0;background:rgba(255,255,255,.58);';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;font-weight:600;color:#31445b;';
    title.textContent = candidateText(candidate.displayName);
    const pair = candidate.pairId ? allCandidates.find(entry => entry.id === candidate.pairId) : null;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;';
    const isMotion = candidate.kind === 'motion';
    actions.appendChild(createReleaseCandidateButton(isMotion ? '仅动作预览' : '仅表情预览', async () => {
      if (isMotion) await window.chatx2.previewMotionCandidate(candidate.id);
      else await window.chatx2.previewExpressionCandidate(candidate.id);
    }));
    if (pair && pair.kind !== candidate.kind) {
      actions.appendChild(createReleaseCandidateButton('动作+原配表情', async () => {
        await window.chatx2.previewCombinedCandidate(candidate.id);
      }));
    }
    actions.appendChild(createReleaseCandidateButton(isMotion ? '加入语音动作池' : '加入表情池', async () => {
      const accepted = confirm('只接受这一侧“' + candidateText(candidate.displayName) + '”？原配' + (isMotion ? '表情' : '动作') + '不会同时加入。');
      if (!accepted) return;
      if (isMotion) await window.chatx2.acceptMotionCandidate(candidate.id);
      else await window.chatx2.acceptExpressionCandidate(candidate.id);
      await loadDailyPerformanceCandidates();
    }, 'settings-save-btn'));
    actions.appendChild(createReleaseCandidateButton('删除候选', async () => {
      if (!confirm('只删除候选“' + candidateText(candidate.displayName) + '”？原配和源文件不会删除。')) return;
      await window.chatx2.deletePerformanceCandidate(candidate.id);
      await loadDailyPerformanceCandidates();
    }, 'settings-action-btn'));
    row.append(title, renderReleaseCandidateMeta(candidate, pair), actions);
    return row;
  }

  async function loadDailyPerformanceCandidates() {
    const motionRoot = document.getElementById('release-motion-candidate-review');
    const expressionRoot = document.getElementById('release-expression-candidate-review');
    if (!motionRoot || !expressionRoot || !window.chatx2 || typeof window.chatx2.listPerformanceCandidates !== 'function') return;
    motionRoot.textContent = '候选加载中…';
    expressionRoot.textContent = '候选加载中…';
    try {
      const candidates = await window.chatx2.listPerformanceCandidates();
      const motions = candidates.filter(entry => entry && entry.kind === 'motion');
      const expressions = candidates.filter(entry => entry && entry.kind === 'expression');
      motionRoot.textContent = '';
      expressionRoot.textContent = '';
      if (!motions.length) motionRoot.textContent = '（暂无动作候选）';
      if (!expressions.length) expressionRoot.textContent = '（暂无表情候选）';
      motions.forEach(candidate => motionRoot.appendChild(renderReleaseCandidateRow(candidate, candidates)));
      expressions.forEach(candidate => expressionRoot.appendChild(renderReleaseCandidateRow(candidate, candidates)));
    } catch (error) {
      console.error('[daily-candidates] load failed:', error);
      motionRoot.textContent = '候选加载失败';
      expressionRoot.textContent = '候选加载失败';
    }
  }

  btnBack.addEventListener('click', () => navigateTo('settings'));
  btnSettingsBack.addEventListener('click', () => navigateTo('chat'));
  btnCharsBack.addEventListener('click', () => navigateTo('chat'));
  btnCharSwitch.addEventListener('click', () => navigateTo('characters'));

  function loadUISettings() {
    const saved = localStorage.getItem('ui_settings');
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (s.opacity !== undefined) setOpacity.value = s.opacity;
        if (s.brightness !== undefined) setBrightness.value = s.brightness;
        if (s.fontsize !== undefined) setFontsize.value = s.fontsize;
        if (s.fontfamily !== undefined) setFontfamily.value = s.fontfamily;
        if (s.radius !== undefined) setRadius.value = s.radius;
        if (s.theme !== undefined) setTheme.value = s.theme;
        if (s.breathSpeed !== undefined) setBreathSpeed.value = s.breathSpeed;
        if (s.touchIntensity !== undefined) setTouchIntensity.value = s.touchIntensity;
        if (s.rippleFreq !== undefined) setRippleFreq.value = s.rippleFreq;
        if (s.rippleStyle !== undefined) setRippleStyle.value = s.rippleStyle;

        // 一次性迁移：旧默认值组合（normal/normal/normal/ripple）→ 新默认值（slow/light/sparse/note）
        // 仅在四项均为旧默认值时触发，避免覆盖用户手动选择
        if (s.breathSpeed === 'normal' && s.touchIntensity === 'normal'
            && s.rippleFreq === 'normal' && s.rippleStyle === 'ripple') {
          setBreathSpeed.value = 'slow';
          setTouchIntensity.value = 'light';
          setRippleFreq.value = 'sparse';
          setRippleStyle.value = 'note';
          saveUISettings(); // 持久化新默认值，避免重复迁移
        }
      } catch (e) {}
    }
    applyUISettings();
    updateChatBackground();
  }

  function saveUISettings() {
    const s = {
      opacity: parseInt(setOpacity.value),
      brightness: parseInt(setBrightness.value),
      fontsize: parseInt(setFontsize.value),
      fontfamily: setFontfamily.value,
      radius: parseInt(setRadius.value),
      theme: setTheme.value,
      breathSpeed: setBreathSpeed.value,
      touchIntensity: setTouchIntensity.value,
      rippleFreq: setRippleFreq.value,
      rippleStyle: setRippleStyle.value,
    };
    localStorage.setItem('ui_settings', JSON.stringify(s));
  }

  function applyUISettings() {
    const opacity = parseInt(setOpacity.value);
    const brightness = parseInt(setBrightness.value);
    const fontsize = parseInt(setFontsize.value);
    const fontfamily = setFontfamily.value;
    const radius = parseInt(setRadius.value);
    const theme = setTheme.value;

    valOpacity.textContent = opacity + '%';
    valBrightness.textContent = brightness + '%';
    valFontsize.textContent = fontsize + 'px';
    valRadius.textContent = radius + 'px';

    // 亮度作用于背景层（default-bg），不影响消息气泡
    const defaultBg = document.getElementById('default-bg');
    if (defaultBg) {
      defaultBg.style.filter = `brightness(${brightness / 100})`;
    }
    // 透明度通过背景层 opacity 实现（数值越低背景越暗）
    if (defaultBg) {
      defaultBg.style.opacity = Math.max(0.3, opacity / 100);
    }
    // 自定义背景也应用亮度和透明度
    if (chatContainer && chatContainer.classList.contains('has-custom-bg')) {
      chatContainer.style.setProperty('--bg-opacity', opacity / 100);
      chatContainer.style.setProperty('--bg-brightness', brightness / 100);
    }
    document.documentElement.style.setProperty('--chat-brightness', brightness / 100);
    document.documentElement.style.setProperty('--bubble-font-size', fontsize + 'px');
    document.documentElement.style.setProperty('--bubble-radius', radius + 'px');

    const fontMap = {
      system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "微软雅黑", sans-serif',
      serif: '"Songti SC", "SimSun", "宋体", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, "Times New Roman", serif',
      mono: '"SF Mono", "Menlo", "Consolas", "Courier New", "等线", monospace',
      rounded: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "微软雅黑", "Nunito", "圆体", sans-serif',
      cute: '"ZCOOL KuaiLe", "站酷快乐体", "Ma Shan Zheng", "马善政毛笔楷书", "PingFang SC", "Microsoft YaHei", cursive',
      kawaii: '"ZCOOL XiaoWei", "站酷小薇LOGO体", "Nunito", "Quicksand", "PingFang SC", "Microsoft YaHei", sans-serif',
    };
    const selectedFont = fontMap[fontfamily] || fontMap.system;
    document.documentElement.style.setProperty('--bubble-font-family', selectedFont);
    document.body.style.fontFamily = selectedFont;

    // 应用主题
    applyTheme(theme);

    // 应用呼吸频率和触屏强度
    if (typeof applyBreathSpeed === 'function') applyBreathSpeed(setBreathSpeed.value);
    if (typeof applyTouchIntensity === 'function') applyTouchIntensity(setTouchIntensity.value);
    if (typeof applyRippleFreq === 'function') applyRippleFreq(setRippleFreq.value);
    if (typeof applyRippleStyle === 'function') applyRippleStyle(setRippleStyle.value);
  }

  function applyTheme(theme) {
    const app = document.getElementById('app');
    app.classList.remove('theme-aurora', 'theme-sakura', 'theme-ocean', 'theme-nebula', 'theme-sunset', 'theme-midnight', 'theme-dark-tech', 'theme-light-wechat', 'theme-warm-paper');
    // 默认主题aurora不需要额外class（CSS变量定义在#app上）
    if (theme && theme !== 'aurora') {
      app.classList.add('theme-' + theme);
    }
  }

  // 滑块填充百分比更新函数（科技感滑块视觉反馈）
  function updateRangeFill(slider) {
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const v = parseFloat(slider.value);
    const pct = ((v - min) / (max - min)) * 100;
    slider.style.setProperty('--range-fill', pct + '%');
  }
  // 初始化所有设置页滑块的填充
  [setOpacity, setBrightness, setFontsize, setRadius].forEach(s => { if (s) updateRangeFill(s); });

  // 设置页底色透明度滑块逻辑（顶部"设置"字样旁，独立持久化）
  function applySettingsBgOpacity(opacity) {
    const app = document.getElementById('app');
    app.style.setProperty('--settings-bg-opacity', opacity);
    if (valSettingsBgOpacity) valSettingsBgOpacity.textContent = Math.round(opacity * 100) + '%';
  }
  if (setSettingsBgOpacity) {
    const savedOpacity = parseFloat(localStorage.getItem('settings-bg-opacity') || '0.78');
    setSettingsBgOpacity.value = savedOpacity;
    const fillPct = ((savedOpacity - 0.2) / (1 - 0.2)) * 100;
    setSettingsBgOpacity.style.setProperty('--fill', fillPct + '%');
    applySettingsBgOpacity(savedOpacity);
    setSettingsBgOpacity.addEventListener('input', () => {
      const v = parseFloat(setSettingsBgOpacity.value);
      const pct = ((v - 0.2) / (1 - 0.2)) * 100;
      setSettingsBgOpacity.style.setProperty('--fill', pct + '%');
      applySettingsBgOpacity(v);
      localStorage.setItem('settings-bg-opacity', v);
    });
  }

  setOpacity.addEventListener('input', () => { updateRangeFill(setOpacity); applyUISettings(); saveUISettings(); });
  setBrightness.addEventListener('input', () => { updateRangeFill(setBrightness); applyUISettings(); saveUISettings(); });
  setFontsize.addEventListener('input', () => { updateRangeFill(setFontsize); applyUISettings(); saveUISettings(); });
  setFontfamily.addEventListener('change', () => { applyUISettings(); saveUISettings(); });
  setRadius.addEventListener('input', () => { updateRangeFill(setRadius); applyUISettings(); saveUISettings(); });
  setTheme.addEventListener('change', () => { applyUISettings(); saveUISettings(); });
  setBreathSpeed.addEventListener('change', () => { applyUISettings(); saveUISettings(); });
  setTouchIntensity.addEventListener('change', () => { applyUISettings(); saveUISettings(); });
  setRippleFreq.addEventListener('change', () => { applyUISettings(); saveUISettings(); });
  setRippleStyle.addEventListener('change', () => { applyUISettings(); saveUISettings(); });

  // 自定义背景图（按角色隔离：每个角色独立存储背景设置）
  const setCustomBg = document.getElementById('set-custom-bg');
  const btnUploadBg = document.getElementById('btn-upload-bg');
  const btnClearBg = document.getElementById('btn-clear-bg');
  const fileCustomBg = document.getElementById('file-custom-bg');
  const setBgMode = document.getElementById('set-bg-mode');

  // 角色专属背景 localStorage 键名
  function bgKey(suffix) {
    return `custom-bg-${suffix}-${currentCharacterId || 'default'}`;
  }

  // 重新加载背景设置UI（切换角色时调用，让设置面板显示当前角色的背景）
  function reloadBgSettingsUI() {
    if (setCustomBg) {
      const savedBg = localStorage.getItem(bgKey('url'));
      if (savedBg && savedBg.startsWith('data:')) {
        setCustomBg.value = savedBg.substring(0, 50) + '...';
      } else {
        setCustomBg.value = savedBg || '';
      }
    }
    if (setBgMode) {
      const savedMode = localStorage.getItem(bgKey('mode'));
      setBgMode.value = savedMode || 'cover';
    }
  }

  if (setCustomBg) {
    // URL 输入
    setCustomBg.addEventListener('change', () => {
      const url = setCustomBg.value.trim();
      if (url) {
        localStorage.setItem(bgKey('url'), url);
      } else {
        localStorage.removeItem(bgKey('url'));
      }
      updateChatBackground();
    });
  }
  if (btnUploadBg && fileCustomBg) {
    btnUploadBg.addEventListener('click', () => fileCustomBg.click());
    fileCustomBg.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        localStorage.setItem(bgKey('url'), dataUrl);
        if (setCustomBg) setCustomBg.value = dataUrl.substring(0, 50) + '...';
        updateChatBackground();
      };
      reader.readAsDataURL(file);
      fileCustomBg.value = '';
    });
  }
  if (btnClearBg) {
    btnClearBg.addEventListener('click', () => {
      localStorage.removeItem(bgKey('url'));
      if (setCustomBg) setCustomBg.value = '';
      updateChatBackground();
    });
  }
  if (setBgMode) {
    setBgMode.addEventListener('change', () => {
      localStorage.setItem(bgKey('mode'), setBgMode.value);
      updateChatBackground();
    });
  }
  // 初始加载当前角色的背景设置到UI
  reloadBgSettingsUI();

  async function loadProviderRegistry() {
    try {
      const res = await fetch('/api/provider-registry');
      const data = await res.json();
      if (data.success) { providerRegistry = data.registry; }
    } catch (e) { console.error('[ProviderRegistry] Failed:', e); }
  }

  function updateSubmodelOptions() {
    const provider = setProvider.value;
    const info = providerRegistry[provider];
    setSubmodel.innerHTML = '<option value="">手动输入 / 使用默认</option>';
    if (info && info.models && info.models.length > 0) {
      for (const model of info.models) {
        const opt = document.createElement('option');
        opt.value = model;
        opt.textContent = model;
        setSubmodel.appendChild(opt);
      }
    }
    if (info) {
      providerWebsite.innerHTML = info.website
        ? `<a href="${info.website}" target="_blank" rel="noopener" style="color:#07c160;">${info.website}</a>`
        : '';
    } else { providerWebsite.textContent = ''; }
  }

  setProvider.addEventListener('change', () => {
    updateSubmodelOptions();
  });

  setSubmodel.addEventListener('change', () => {
    // 子模型选择变化时自动更新
  });

  btnSyncModels.addEventListener('click', async () => {
    const provider = setProvider.value;
    const apiKey = setApikey.value;
    const info = providerRegistry[provider];
    const baseUrl = setBaseurl.value || (info ? info.defaultBaseUrl : '');
    syncStatus.textContent = '正在同步模型列表...';
    syncStatus.className = 'api-status';
    btnSyncModels.disabled = true;
    try {
      const res = await fetch('/api/sync-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey, baseUrl }),
      });
      const data = await res.json();
      if (data.success) {
        providerRegistry[provider].models = data.models;
        updateSubmodelOptions();
        syncStatus.textContent = `同步成功！获取到 ${data.count} 个模型`;
        syncStatus.className = 'api-status success';
      } else {
        syncStatus.textContent = data.error || '同步失败';
        syncStatus.className = 'api-status error';
      }
    } catch (e) {
      syncStatus.textContent = '同步失败，请检查网络';
      syncStatus.className = 'api-status error';
    }
    btnSyncModels.disabled = false;
  });

  btnEditModels.addEventListener('click', () => {
    const provider = setProvider.value;
    const info = providerRegistry[provider];
    if (!info) return;
    if (editModelsPanel.style.display === 'none') {
      editWebsite.value = info.website || '';
      editBaseurl.value = info.defaultBaseUrl || '';
      editDefaultModel.value = info.defaultModel || '';
      editModelsList.value = (info.models || []).join('\n');
      editModelsPanel.style.display = 'block';
      btnEditModels.textContent = '收起';
    } else {
      editModelsPanel.style.display = 'none';
      btnEditModels.textContent = '编辑模型';
    }
  });

  btnCancelModels.addEventListener('click', () => {
    editModelsPanel.style.display = 'none';
    btnEditModels.textContent = '编辑模型';
  });

  btnSaveModels.addEventListener('click', async () => {
    const provider = setProvider.value;
    const models = editModelsList.value.split('\n').map(m => m.trim()).filter(m => m.length > 0);
    const updates = {
      website: editWebsite.value.trim(),
      defaultBaseUrl: editBaseurl.value.trim(),
      defaultModel: editDefaultModel.value.trim(),
      models: models,
    };
    try {
      const res = await fetch('/api/provider-registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: provider, updates }),
      });
      const data = await res.json();
      if (data.success) {
        providerRegistry = data.registry;
        updateSubmodelOptions();
        editModelsPanel.style.display = 'none';
        btnEditModels.textContent = '编辑模型';
        apiStatus.textContent = '模型列表已更新';
        apiStatus.className = 'api-status success';
      } else {
        apiStatus.textContent = data.error || '更新失败';
        apiStatus.className = 'api-status error';
      }
    } catch (e) {
      apiStatus.textContent = '更新失败';
      apiStatus.className = 'api-status error';
    }
  });

  btnResetRegistry.addEventListener('click', async () => {
    showConfirm('确定要重置所有Provider为默认配置吗？', async () => {
      try {
        const res = await fetch('/api/provider-registry/reset', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          providerRegistry = data.registry;
          updateSubmodelOptions();
          apiStatus.textContent = '已重置为默认配置';
          apiStatus.className = 'api-status success';
        }
      } catch (e) {
        apiStatus.textContent = '重置失败';
        apiStatus.className = 'api-status error';
      }
    });
  });

  async function loadApiConfig() {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.success) {
        setProvider.value = data.settings.provider || 'custom';
        setApikey.value = data.settings.apiKey || '';
        setBaseurl.value = data.settings.baseUrl || '';
        setModel.value = data.settings.model || '';
        if (setCapability) setCapability.value = data.settings.capability || '';
        if (setReasoning) setReasoning.value = data.settings.reasoning || '';
        const conversationMode = data.settings.conversationMode === 'remote_chat' ? 'remote_chat' : 'immersive';
        conversationModeInputs.forEach(input => { input.checked = input.value === conversationMode; });
        apiStatus.textContent = data.settings.apiKey ? 'API Key 已配置' : 'API Key 未配置';
        apiStatus.className = 'api-status ' + (data.settings.apiKey ? 'success' : 'error');
        updateSubmodelOptions();
      }
    } catch (e) {
      apiStatus.textContent = '无法加载配置';
      apiStatus.className = 'api-status error';
    }
  }

  btnSaveApi.addEventListener('click', async () => {
    const info = providerRegistry[setProvider.value];
    const config = {
      provider: setProvider.value,
      apiKey: setApikey.value,
      baseUrl: setBaseurl.value || (info ? info.defaultBaseUrl : ''),
      model: setSubmodel.value || (info ? info.defaultModel : ''),
      capability: setCapability ? setCapability.value : '',
      reasoning: setReasoning ? setReasoning.value : '',
    };
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.success) {
        apiStatus.textContent = '保存成功，配置已生效';
        apiStatus.className = 'api-status success';
      } else {
        apiStatus.textContent = data.error || '保存失败';
        apiStatus.className = 'api-status error';
      }
    } catch (e) {
      apiStatus.textContent = '保存失败，请检查服务';
      apiStatus.className = 'api-status error';
    }
  });

  if (btnSaveConversationMode) {
    btnSaveConversationMode.addEventListener('click', async () => {
      const selected = document.querySelector('input[name="conversation-mode"]:checked');
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationMode: selected ? selected.value : 'immersive' }),
        });
        const data = await res.json();
        conversationModeStatus.textContent = data.success ? '聊天方式已生效' : (data.error || '保存失败');
        conversationModeStatus.className = 'api-status ' + (data.success ? 'success' : 'error');
      } catch (e) {
        conversationModeStatus.textContent = '保存失败，请检查服务';
        conversationModeStatus.className = 'api-status error';
      }
    });
  }

  async function loadCurrentCharacter() {
    try {
      const res = await fetch('/api/current-character');
      const data = await res.json();
      if (data.success) {
        currentCharacterId = data.characterId;
        currentCharacterName = data.name;
        document.getElementById('char-name').textContent = currentCharacterName;
        document.title = currentCharacterName;
        // API 配置与角色一起切换；设置面板显示当前角色自己的 provider/key/model。
        // 后端也会在切换接口中立即激活该配置，聊天不会继续使用上一角色的 key。
        if (typeof loadApiConfig === 'function') await loadApiConfig();
        // 检查语音状态（必须await，否则loadHistory时voiceEnabled还是false，小喇叭不显示）
        await checkVoiceStatus();
        // 角色切换后刷新背景图片和设置面板（按角色隔离）
        if (typeof reloadBgSettingsUI === 'function') reloadBgSettingsUI();
        if (typeof updateChatBackground === 'function') updateChatBackground();
        // 角色切换后刷新语音缓存上限（按角色独立）
        if (typeof loadVoiceCacheLimit === 'function') loadVoiceCacheLimit();
        // 切换角色时同步切换 3D 模型包（模型/待机/动作配置随角色切换）
        let avatarRestoredByElectron = false;
        if (window.chatx2 && window.chatx2.setActiveCharacter) {
          try {
            const activeResult = await window.chatx2.setActiveCharacter(data.characterId);
            avatarRestoredByElectron = Boolean(activeResult && activeResult.success);
            if (!activeResult || !activeResult.success) {
              console.warn('[Character] 激活角色 Avatar 设置失败:', activeResult?.reason);
            } else {
              if (typeof loadModelList === 'function') await loadModelList();
              if (typeof loadLightingPresets === 'function') await loadLightingPresets();
            }
          } catch (e) {
            console.warn('[Character] setActiveCharacter 异常:', e);
          }
        }
        // 仅兼容没有角色激活 IPC 的旧壳；当前 Electron 已从角色
        // avatar_settings.json 恢复模型，禁止再用旧 profile 值覆盖。
        if (!avatarRestoredByElectron && data.modelPackId && window.chatx2 && window.chatx2.switchModelPack) {
          try {
            const result = await window.chatx2.switchModelPack(data.modelPackId);
            if (result.success) {
              console.log('[Character] 模型包已切换:', data.modelPackId);
              // 刷新动作面板（长时间动作、自定义VMD等会随模型包切换更新）
              if (typeof loadMotionPacks === 'function') loadMotionPacks();
            } else {
              console.warn('[Character] 模型包切换失败:', result.reason);
            }
          } catch (e) {
            console.warn('[Character] switchModelPack 异常:', e);
          }
        }
      }
    } catch (e) {
      console.error('[CurrentCharacter] Load failed:', e);
    }
  }

  // ============================================================
  // 语音功能 — 微信风格：每条AI消息后有语音按钮
  // ============================================================

  // 检查当前角色的语音状态
  async function checkVoiceStatus() {
    try {
      const res = await fetch('/api/voice/status');
      const data = await res.json();
      if (data.success) {
        voiceEnabled = data.hasVoice;
        ttsAvailable = data.ttsAvailable;
        voiceEmotions = data.emotions || [];
        // 加载语音微调面板
        loadVoiceTuning();
      }
    } catch (e) {
      voiceEnabled = false;
    }
  }

  // ============================================================
  // 语音微调面板
  // ============================================================
  let voiceTuningData = null; // 当前微调配置

  async function loadVoiceTuning() {
    const section = document.getElementById('voice-tuning-section');
    if (!voiceEnabled) { section.style.display = 'none'; return; }

    section.style.display = '';
    try {
      const res = await fetch('/api/voice/tuning');
      const data = await res.json();
      if (!data.success) return;
      voiceTuningData = data.tuning;
      renderVoiceTuningPanel();
    } catch (e) {
      console.error('[VoiceTuning] 加载失败:', e);
    }
  }

  function renderVoiceTuningPanel() {
    if (!voiceTuningData) return;
    const t = voiceTuningData;

    // 默认情感下拉
    const defaultSel = document.getElementById('vt-default-emotion');
    defaultSel.innerHTML = '<option value="auto">自动识别</option>';
    for (const id of Object.keys(t.profiles)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = t.profiles[id].desc || id;
      if (id === t.defaultEmotion) opt.selected = true;
      defaultSel.appendChild(opt);
    }

    // 试听情感下拉
    const testSel = document.getElementById('vt-test-emotion');
    testSel.innerHTML = '<option value="auto">自动</option>';
    for (const id of Object.keys(t.profiles)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = t.profiles[id].desc || id;
      testSel.appendChild(opt);
    }

    // 情感参数卡片
    const cards = document.getElementById('vt-emotion-cards');
    cards.innerHTML = '';
    const PAUSE_STYLES = [
      ['medium', '日常(1×)'],
      ['comfort', '安慰(3×)'],
      ['heavy', '悲伤(3×)'],
      ['heavy_whisper', '轻声问(3×)'],
      ['gentle_ask', '温柔问(3×)'],
      ['firm', '坚定(3×)'],
      ['light', '激动(1×)'],
      ['shy', '害羞(3×)'],
    ];
    const INTENSITY_OPTS = [
      ['low', 'low'], ['medium', 'medium'], ['high', 'high'],
    ];
    for (const [id, p] of Object.entries(t.profiles)) {
      const card = document.createElement('div');
      card.className = 'vt-emotion-card';
      const pauseOpts = PAUSE_STYLES.map(([v, label]) =>
        `<option value="${v}" ${p.pauseStyle === v ? 'selected' : ''}>${label}</option>`).join('');
      const intOpts = INTENSITY_OPTS.map(([v, label]) =>
        `<option value="${v}" ${(p.intensity || 'medium') === v ? 'selected' : ''}>${label}</option>`).join('');
      card.innerHTML = `
        <div class="vt-emotion-title">
          <span class="name">${p.desc || id}</span>
          <span class="note">${p.characterNote || ''}</span>
        </div>
        <div class="vt-row">
          <span class="vt-label">温度</span>
          <input type="range" class="vt-slider" data-emotion="${id}" data-param="temperature" min="0.6" max="0.65" step="0.01" value="${p.temperature}" disabled title="声纹身份锁定：所有情绪共用采样温度">
          <span class="vt-val">${p.temperature}</span>
        </div>
        <div class="vt-row">
          <span class="vt-label">top_p</span>
          <input type="range" class="vt-slider" data-emotion="${id}" data-param="topP" min="0.8" max="0.85" step="0.01" value="${p.topP}" disabled title="声纹身份锁定：所有情绪共用 top_p">
          <span class="vt-val">${p.topP}</span>
        </div>
        <div class="vt-row">
          <span class="vt-label">语速</span>
          <input type="range" class="vt-slider" data-emotion="${id}" data-param="speed" min="0.92" max="1.08" step="0.01" value="${p.speed}">
          <span class="vt-val">${p.speed}</span>
        </div>
        <div class="vt-row">
          <span class="vt-label">强度</span>
          <select data-emotion="${id}" data-param="intensity" class="vt-select">${intOpts}</select>
        </div>
        <div class="vt-row">
          <span class="vt-label">停顿</span>
          <select data-emotion="${id}" data-param="pauseStyle" class="vt-select">${pauseOpts}</select>
        </div>
      `;
      cards.appendChild(card);

      // 滑块填充初始化 + 实时更新
      card.querySelectorAll('input[type="range"]').forEach(slider => {
        const updateFill = () => {
          const min = parseFloat(slider.min);
          const max = parseFloat(slider.max);
          const v = parseFloat(slider.value);
          const pct = ((v - min) / (max - min)) * 100;
          slider.style.setProperty('--fill', pct + '%');
        };
        updateFill();
        slider.addEventListener('input', () => {
          slider.nextElementSibling.textContent = slider.value;
          updateFill();
          slider.nextElementSibling.classList.add('active');
          clearTimeout(slider._t);
          slider._t = setTimeout(() => slider.nextElementSibling.classList.remove('active'), 800);
        });
      });
    }

    // 全局偏移
    document.getElementById('vt-global-speed').value = t.globalSpeedOffset || 0;
    document.getElementById('vt-global-speed-val').textContent = t.globalSpeedOffset || 0;
    document.getElementById('vt-global-pitch').value = t.globalPitchOffset || 0;
    document.getElementById('vt-global-pitch-val').textContent = t.globalPitchOffset || 0;
    document.getElementById('vt-global-temp').value = t.globalTempOffset || 0;
    document.getElementById('vt-global-temp-val').textContent = t.globalTempOffset || 0;
    document.getElementById('vt-global-pause').value = t.globalPauseOffset || 0;
    document.getElementById('vt-global-pause-val').textContent = t.globalPauseOffset || 0;
    document.getElementById('vt-global-soft').value = t.globalSoftOffset !== undefined ? t.globalSoftOffset : 0;
    document.getElementById('vt-global-soft-val').textContent = t.globalSoftOffset !== undefined ? t.globalSoftOffset : 0;
    document.getElementById('vt-global-volume').value = t.globalVolumeOffset !== undefined ? t.globalVolumeOffset : 0;
    document.getElementById('vt-global-volume-val').textContent = t.globalVolumeOffset !== undefined ? t.globalVolumeOffset : 0;
    document.getElementById('vt-global-fadein').value = t.globalFadeIn !== undefined ? t.globalFadeIn : 0.015;
    document.getElementById('vt-global-fadein-val').textContent = t.globalFadeIn !== undefined ? t.globalFadeIn : 0.015;

    // 全局偏移滑块实时更新 + 填充百分比 + 数值高亮
    function bindSlider(sliderId, valId) {
      const slider = document.getElementById(sliderId);
      const val = document.getElementById(valId);
      if (!slider || !val) return;
      const updateFill = () => {
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        const v = parseFloat(slider.value);
        const pct = ((v - min) / (max - min)) * 100;
        slider.style.setProperty('--fill', pct + '%');
      };
      updateFill();
      slider.addEventListener('input', () => {
        val.textContent = slider.value;
        updateFill();
        val.classList.add('active');
        clearTimeout(slider._t);
        slider._t = setTimeout(() => val.classList.remove('active'), 800);
      });
    }
    bindSlider('vt-global-speed', 'vt-global-speed-val');
    bindSlider('vt-global-pitch', 'vt-global-pitch-val');
    bindSlider('vt-global-temp', 'vt-global-temp-val');
    bindSlider('vt-global-pause', 'vt-global-pause-val');
    bindSlider('vt-global-soft', 'vt-global-soft-val');
    bindSlider('vt-global-volume', 'vt-global-volume-val');
    bindSlider('vt-global-fadein', 'vt-global-fadein-val');
    // 情感卡片滑块也要绑定填充
    document.querySelectorAll('#vt-emotion-cards input[type="range"]').forEach(slider => {
      const updateFill = () => {
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        const v = parseFloat(slider.value);
        const pct = ((v - min) / (max - min)) * 100;
        slider.style.setProperty('--fill', pct + '%');
      };
      updateFill();
      slider.addEventListener('input', () => {
        slider.nextElementSibling.textContent = slider.value;
        updateFill();
      });
    });
  }

  // 收集当前面板的参数
  function collectVoiceTuningParams() {
    const profiles = {};
    // 收集滑块（range）
    document.querySelectorAll('#vt-emotion-cards input[type="range"]').forEach(slider => {
      const emotion = slider.dataset.emotion;
      const param = slider.dataset.param;
      if (!profiles[emotion]) profiles[emotion] = {};
      profiles[emotion][param] = parseFloat(slider.value);
    });
    // 收集下拉（select: intensity, pauseStyle）
    document.querySelectorAll('#vt-emotion-cards select').forEach(sel => {
      const emotion = sel.dataset.emotion;
      const param = sel.dataset.param;
      if (!profiles[emotion]) profiles[emotion] = {};
      profiles[emotion][param] = sel.value;
    });

    return {
      defaultEmotion: document.getElementById('vt-default-emotion').value,
      globalSpeedOffset: parseFloat(document.getElementById('vt-global-speed').value),
      globalPitchOffset: parseFloat(document.getElementById('vt-global-pitch').value),
      globalTempOffset: parseFloat(document.getElementById('vt-global-temp').value),
      globalPauseOffset: parseFloat(document.getElementById('vt-global-pause').value),
      globalSoftOffset: parseFloat(document.getElementById('vt-global-soft').value),
      globalVolumeOffset: parseFloat(document.getElementById('vt-global-volume').value),
      globalFadeIn: parseFloat(document.getElementById('vt-global-fadein').value),
      profiles,
    };
  }

  // 保存语音配置
  document.getElementById('btn-save-voice-tuning')?.addEventListener('click', async () => {
    const params = collectVoiceTuningParams();
    try {
      const res = await fetch('/api/voice/tuning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      const hint = document.getElementById('vt-save-hint');
      if (data.success) {
        hint.textContent = '已保存';
        setTimeout(() => hint.textContent = '', 2000);
      } else {
        hint.textContent = '保存失败: ' + (data.error || '');
        hint.style.color = '#ff4d4f';
      }
    } catch (e) {
      document.getElementById('vt-save-hint').textContent = '网络错误';
    }
  });

  // 重置语音配置
  document.getElementById('btn-reset-voice-tuning')?.addEventListener('click', async () => {
    if (!confirm('确定重置所有语音参数为默认值？')) return;
    try {
      const res = await fetch('/api/voice/tuning/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.success) {
        await loadVoiceTuning();
        document.getElementById('vt-save-hint').textContent = '已重置';
        setTimeout(() => document.getElementById('vt-save-hint').textContent = '', 2000);
      }
    } catch (e) {}
  });

  // ★ 试听历史最多保留3个；这些文件只属于设置页试听，不写入角色目录。
  const previewHistory = []; // [{ url, text, emotion, duration, temperature, topP }]
  // ★ 删除音频文件（从 url 提取 filename，调 DELETE 端点真删磁盘文件，不留孤儿）
  async function deleteAudioFileByUrl(url) {
    try {
      const match = url.match(/\/api\/voice\/audio\/(.+)$/);
      if (match) {
        const response = await fetch(`/api/voice/audio/${match[1]}`, { method: 'DELETE' });
        const result = await readJsonResponse(response);
        return result.success === true;
      }
    } catch (e) {}
    return false;
  }
  function renderPreviewHistory() {
    const container = document.getElementById('vt-preview-history');
    if (!container) return;
    container.innerHTML = '';
    // ★ 超出3个直接删除最旧的（同步删除磁盘 wav 文件，不再留存等批量清理）
    while (previewHistory.length > 3) {
      const removed = previewHistory.shift();
      if (removed && removed.url) deleteAudioFileByUrl(removed.url);
    }
    previewHistory.forEach((p, idx) => {
      const label = idx === previewHistory.length - 1 ? '上一轮试听' : '上上轮试听';
      const btn = document.createElement('button');
      btn.className = 'settings-action-btn';
      btn.style.cssText = 'padding:4px 10px;font-size:11px;border-radius:14px;display:flex;align-items:center;gap:4px;';
      btn.innerHTML = `<span style="color:#888;">${label}:</span><span>${p.duration ? p.duration + 's' : '?'}</span><span style="color:#888;margin-left:4px;">${p.emotion || ''}</span>`;
      btn.title = `点击重新播放 | temp=${p.temperature} top_p=${p.topP}`;
      btn.addEventListener('click', () => {
        const audio = new Audio(p.url);
        audio.play().catch(() => {});
        const resultDiv = document.getElementById('vt-test-result');
        resultDiv.innerHTML = `<span style="color:#07c160;">重播${label}</span> | 情感: ${p.emotion} | 时长: ${p.duration}s | temp=${p.temperature} top_p=${p.topP}`;
        audio.addEventListener('ended', () => {
          resultDiv.innerHTML = resultDiv.innerHTML.replace('重播' + label, '已重播' + label);
        });
      });
      container.appendChild(btn);
    });
  }

  // 试听按钮
  document.getElementById('btn-vt-test')?.addEventListener('click', async () => {
    const text = document.getElementById('vt-test-text').value.trim();
    const emotion = document.getElementById('vt-test-emotion').value;
    if (!text) return;

    const resultDiv = document.getElementById('vt-test-result');
    resultDiv.textContent = '合成中...';

    // 收集当前面板的所有调参，让试听实时反映滑块变化
    const tuningParams = collectVoiceTuningParams();

    try {
      // ★★ force: true 跳过L3缓存，强制重新合成（应用最新VOICE CONTROL参数，否则命中缓存返回null）
      const data = await requestVoiceSynthesis({
        text,
        emotion: emotion === 'auto' ? undefined : emotion,
        preview: true,
        speed_offset: tuningParams.globalSpeedOffset,
        pitch_offset: tuningParams.globalPitchOffset,
        temp_offset: tuningParams.globalTempOffset,
        pause_offset: tuningParams.globalPauseOffset,
        ending_offset: tuningParams.globalEndingOffset,
        soft_offset: tuningParams.globalSoftOffset,
        volume_offset: tuningParams.globalVolumeOffset,
        fadein: tuningParams.globalFadeIn,
        force: true,
      }, { notify: true });
      if (data.success && data.audioUrl) {
        const audio = new Audio(data.audioUrl);
        audio.play();
        resultDiv.innerHTML = `<span style="color:#07c160;">播放中</span> | 情感: ${data.desc || data.emotion} | 时长: ${data.duration}s | temp=${data.temperature} top_p=${data.topP}`;
        audio.addEventListener('ended', () => {
          resultDiv.innerHTML = resultDiv.innerHTML.replace('播放中', '已播放');
        });
        // ★ 加入试听历史（最多3个，超出删最旧）
        previewHistory.push({
          url: data.audioUrl,
          text: text,
          emotion: data.desc || data.emotion,
          duration: data.duration,
          temperature: data.temperature,
          topP: data.topP,
        });
        renderPreviewHistory();
        // 试听后刷新预加载缓存（包含刚保存的新文件）
        preloadRecentVoice();
      } else {
        resultDiv.textContent = '合成失败: ' + (data.error || '');
      }
    } catch (e) {
      resultDiv.textContent = '网络错误';
    }
  });

  // 给AI消息气泡添加语音按钮（新消息自动后台预合成，历史消息点播）
  // userMessage: 触发本条 AI 回复的用户消息（用于智能情感检测，可选）
  function addVoiceButtonToBubble(bubbleWrap, text, autoSynthesize = false, userMessage, performance) {
    if (!voiceEnabled || !text) return;
    // 统一清理表情包、图片、代码块和错误时间戳，缓存键与实际朗读文本保持一致。
    text = normalizeTtsTextForRequest(text);
    if (!text) return;
    // Use the plan returned by the exact TTS request as the per-bubble
    // semantic source. A cached WAV may resolve `auto` to a concrete emotion;
    // Avatar must receive that same result instead of re-inferring it.
    let currentPerformance = performance && typeof performance === 'object'
      ? { ...performance }
      : null;
    const getCurrentPerformance = () => voiceBtn?._performance || currentPerformance;
    const buildVoiceRequest = (overrides = {}) => {
      const plan = getCurrentPerformance();
      return ({
      text,
      emotion: plan?.voiceEmotion || 'auto',
      intensity: plan?.intensity,
      performanceEmotion: plan?.emotion,
      intent: plan?.intent,
      confidence: plan?.confidence,
      emphasis: plan?.emphasis || [],
      segments: plan?.segments || [],
      userMessage,
      ...overrides,
      });
    };
    const voiceSegments = VoiceSegmentQueue.splitVoiceText(text);
    const segmentedVoice = voiceSegments.length > 1;
    const voiceGroupId = `reply_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const realtimeVoiceToken = autoSynthesize ? ++latestRealtimeVoiceToken : 0;

    const maybeAutoPlay = (synthesisResult = {}) => {
      if (!autoPlayLatestVoice || !realtimeVoiceToken || realtimeVoiceToken !== latestRealtimeVoiceToken) return;
      if (!VoiceAutoplayPolicy.shouldAutoPlaySynthesisResult({
        isRealtime: autoSynthesize,
        cached: synthesisResult.cached === true,
        alreadyHandled: isVoiceMessageHandled(voiceBtn)
      })) return;
      requestLatestVoiceAutoplay(voiceBtn);
    };

    // 创建语音按钮行
    const voiceRow = document.createElement('div');
    voiceRow.className = 'msg-voice-row';

    const voiceBtn = document.createElement('button');
    voiceBtn.className = 'msg-voice-btn';
    voiceBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="voice-progress-gradient" x1="0" x2="1"><stop offset="0" stop-color="#07c160"/><stop offset="0.5" stop-color="#07c160"/><stop offset="0.5" stop-color="#9aa5b6"/><stop offset="1" stop-color="#9aa5b6"/></linearGradient></defs><path d="M11 5L6 9H2v6h4l5 5V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
    voiceBtn.title = '点击播放语音';
    // 存储已剥离标记的纯文本，供 preSynthesizeRecent / recoverCachedVoices 恢复缓存用
    voiceBtn.dataset.ttsText = text;
    voiceBtn.dataset.voiceMessageKey = getVoiceMessageKey(bubbleWrap);
    voiceBtn.dataset.voiceSegmentCount = String(voiceSegments.length);
    voiceBtn.dataset.voiceGroupId = voiceGroupId;
    voiceBtn._performance = currentPerformance;

    const adoptSynthesisPerformance = (data) => {
      if (data && data.performance && typeof data.performance === 'object') {
        currentPerformance = { ...(currentPerformance || {}), ...data.performance };
      } else if (data && data.emotion && currentPerformance
        && !currentPerformance.voiceEmotion) {
        // Compatibility with an older server response that has no plan yet.
        currentPerformance = { ...currentPerformance, voiceEmotion: data.emotion };
      }
      voiceBtn._performance = currentPerformance;
    };

    const voiceLabel = document.createElement('span');
    voiceLabel.className = 'msg-voice-label';
    voiceLabel.textContent = autoSynthesize ? '准备中…' : '语音';

    voiceRow.appendChild(voiceBtn);
    voiceRow.appendChild(voiceLabel);

    // 刷新按钮（合成完成后出现，点后替代旧语音）
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'msg-voice-refresh';
    refreshBtn.innerHTML = '↻';
    refreshBtn.title = '重新合成';
    refreshBtn.style.display = 'none';

    voiceRow.appendChild(refreshBtn);
    bubbleWrap.appendChild(voiceRow);
    // 暴露刷新按钮引用，供 switchCharacter 自动触发最新消息刷新
    bubbleWrap._voiceRefreshBtn = refreshBtn;

    // 旧语音容器（刷新后旧语音保留在此，灰色横排显示，最多2条）
    const oldVoicesContainer = document.createElement('div');
    oldVoicesContainer.className = 'msg-voice-old-container';
    bubbleWrap.appendChild(oldVoicesContainer);

    // ★ oldVoices 持久化到 localStorage：刷新页面后仍能恢复显示和播放
    // key 用文本 hash，value 为 [{url, duration}, ...]
    let _h = 0; for (let i = 0; i < text.length; i++) { _h = ((_h << 5) - _h + text.charCodeAt(i)) | 0; }
    const oldVoicesKey = `voice_old_${Math.abs(_h).toString(36)}`;
    function loadOldVoices() {
      try {
        const saved = localStorage.getItem(oldVoicesKey);
        if (saved) { const arr = JSON.parse(saved); if (Array.isArray(arr)) return arr; }
      } catch (e) {}
      return [];
    }
    function saveOldVoices() {
      try { localStorage.setItem(oldVoicesKey, JSON.stringify(oldVoices)); } catch (e) {}
    }
    // 旧语音列表：[{ url, duration }] —— 从 localStorage 恢复
    const oldVoices = loadOldVoices();

    // 渲染旧语音行（横排，灰色，×移除）
    function renderOldVoices() {
      oldVoicesContainer.innerHTML = '';
      // ★ 同一回复最多3个语音（1新+2旧），超出3条的旧语音直接删除（同步删除磁盘 wav 文件）
      while (oldVoices.length > 2) {
        const removed = oldVoices.shift();
        if (removed && removed.url) deleteAudioFileByUrl(removed.url);
      }
      saveOldVoices();
      const toShow = oldVoices.slice();  // 全部显示（已限制最多2条）
      for (const ov of toShow) {
        const oldRow = document.createElement('div');
        oldRow.className = 'msg-voice-old-row';
        const oldBtn = document.createElement('button');
        oldBtn.className = 'msg-voice-btn old';
        oldBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 5V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
        oldBtn.title = '点击播放/暂停旧语音';
        oldBtn.dataset.cachedUrl = ov.url;
        const oldLabel = document.createElement('span');
        oldLabel.className = 'msg-voice-label';
        oldLabel.textContent = ov.duration ? `${ov.duration}s` : '旧';
        // × 移除按钮
        const removeBtn = document.createElement('button');
        removeBtn.className = 'msg-voice-remove';
        removeBtn.innerHTML = '×';
        removeBtn.title = '移除旧语音';
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // 如果正在播放这条，先停止
          if (oldBtn.classList.contains('playing') && player) { player.stop(); isPlaying = false; player = null; void notifyAvatarSyncStop('cancel'); }
          const idx = oldVoices.indexOf(ov);
          if (idx >= 0) {
            oldVoices.splice(idx, 1);
            // 用户点击 × 明确删除该回复的语音后，后台不得再次为它预合成。
            markVoiceMessageDeleted(voiceBtn);
            // ★ 同步删除磁盘 wav 文件（不再留存等批量清理）
            if (ov && ov.url) await deleteAudioFileByUrl(ov.url);
          }
          saveOldVoices();
          renderOldVoices();
        });
        // ★ 旧语音点击：播放/暂停切换 + 404自动清理
        oldBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          // 正在播放这条旧语音 → 暂停（再点一次停止）
          if (oldBtn.classList.contains('playing') && player) {
            player.stop();
            isPlaying = false;
            oldBtn.classList.remove('playing');
            player = null;
            void notifyAvatarSyncStop('cancel');
            return;
          }
          // 停止当前其他播放
          if (player) { player.stop(); isPlaying = false; voiceBtn.classList.remove('playing'); }
          await notifyAvatarSyncStop('interrupted');
          // 先检查文件是否还存在（避免404静默失败）
          fetch(ov.url, { method: 'HEAD' }).then(r => {
            if (!r.ok) throw new Error('文件不存在');
            const audio = new Audio(ov.url);
            audio.play().then(() => {
              voiceBtn.classList.remove('playing');
              oldBtn.classList.add('playing');
              isPlaying = true;
              player = { stop: () => { audio.pause(); audio.currentTime = 0; } };
              // 播放时获取真实 duration 更新 label（缓存命中时 server 返回 duration:null）
              if (!ov.duration && audio.duration && isFinite(audio.duration)) {
                ov.duration = Math.round(audio.duration * 10) / 10;
                oldLabel.textContent = `${ov.duration}s`;
                saveOldVoices();
              }
              // 通知 Avatar 同步播放（静音模式，驱动桌宠口型/动作）
              notifyAvatarSyncPlay(
                ov.url,
                ov.text || text,
                ov.emotion || voiceBtn.dataset.cachedEmotion || '',
                ov.performance || getCurrentPerformance()
              );
            }).catch(() => {
              oldBtn.classList.remove('playing');
              showToast('播放失败', 2000);
            });
            audio.addEventListener('ended', () => {
              isPlaying = false;
              oldBtn.classList.remove('playing');
              player = null;
              void notifyAvatarSyncStop('ended');
            });
          }).catch(() => {
            // 文件已被清理：从 oldVoices 移除并更新
            const idx = oldVoices.indexOf(ov);
            if (idx >= 0) { oldVoices.splice(idx, 1); saveOldVoices(); renderOldVoices(); }
            showToast('该语音文件已被清理', 2000);
          });
        });
        oldRow.appendChild(oldBtn);
        oldRow.appendChild(oldLabel);
        oldRow.appendChild(removeBtn);
        oldVoicesContainer.appendChild(oldRow);
      }
      saveOldVoices();
    }

    let player = null;
    let isPlaying = false;
    let cachedAudioUrl = null;
    let preSynthesisDone = false;
    let preSynthesisPromise = null;
    let voiceCancelToken = null;
    const beginVoiceGeneration = () => {
      voiceCancelToken = { cancelled: false, started: false };
      voiceBtn._voiceCancelToken = voiceCancelToken;
      voiceBtn.classList.remove('cancelled');
      return voiceCancelToken;
    };

    // ★ 初始化时恢复旧语音显示（从 localStorage）
    if (oldVoices.length > 0) renderOldVoices();

    // 长回复按句拆分：同一回复共享一个分组，片段可并行合成；
    // 第一段解码完成即可播放，后续片段由无缝时间线按序接播。
    if (voiceSegments.length > 1) {
      const segmentStates = voiceSegments.map(() => 'pending');
      const segmentData = voiceSegments.map(() => null);
      const segmentTokens = voiceSegments.map(() => null);
      const segmentedPlayer = new GaplessVoicePlayer({
        prebuffer: 1,
        autoStart: false,
        // Same-reply segments remain independently synthesizable, but the
        // audible handoff gets a short natural pause instead of sounding rushed.
        segmentGapSeconds: 0.4,
      });
      segmentedPlayer.setTotal(voiceSegments.length);
      let synthesisStarted = false;
      let playRequested = false;
      let segmentPromises = [];
      let scheduledPlayback = false;
      let playbackGeneration = 0;
      let synthesisGeneration = 0;
      let synthesisForce = false;

      voiceBtn._voiceSegments = voiceSegments.slice();
      voiceBtn.dataset.voiceSegmentCount = String(voiceSegments.length);
      voiceBtn._segmentStates = segmentStates;

      const countReady = () => segmentStates.filter(state => state === 'ready').length;
      const countFinished = () => segmentStates.filter(state => state === 'ready' || state === 'failed').length;
      const updateSegmentButton = () => {
        const readyCount = countReady();
        const finishedCount = countFinished();
        const allReady = readyCount === voiceSegments.length;
        const allFinished = finishedCount === voiceSegments.length;
        // 只有首段（或其静音失败占位）就绪后才允许起播；后段提前完成
        // 只更新进度，不让按钮误显示为可播放。
        const firstPlayable = segmentStates[0] === 'ready' || segmentStates[0] === 'failed';
        const hasPartial = firstPlayable && !allReady;
        voiceBtn.classList.remove('loading', 'ready', 'partial', 'failed', 'cancelled');
        if (isPlaying) {
          voiceBtn.classList.add('playing');
        } else if (allReady) {
          voiceBtn.classList.add('ready');
        } else if (hasPartial) {
          voiceBtn.classList.add('partial');
        } else if (segmentStates[0] === 'failed') {
          voiceBtn.classList.add('failed');
        } else if (synthesisStarted) {
          voiceBtn.classList.add('loading');
        }
        if (finishedCount < voiceSegments.length) {
          voiceLabel.textContent = readyCount > 0
            ? `已就绪 ${readyCount}/${voiceSegments.length}`
            : '合成中…';
        } else if (readyCount === voiceSegments.length) {
          const duration = segmentData.reduce((sum, item) => sum + Number(item?.duration || 0), 0);
          voiceLabel.textContent = duration > 0 ? `${duration.toFixed(1)}s` : '语音';
        } else {
          voiceLabel.textContent = `部分失败 ${readyCount}/${voiceSegments.length}`;
        }
        voiceBtn.title = allReady
          ? '点击播放/暂停语音'
          : hasPartial
            ? `已完成 ${finishedCount}/${voiceSegments.length} 段，点击即可播放`
            : '语音合成中…';
        // Long replies keep the same refresh affordance as the original
        // single-file path; hide it only while a segment batch is incomplete.
        refreshBtn.style.display = allFinished ? '' : 'none';
      };

      const stopSegmentedPlayback = (reason = 'cancel') => {
        playbackGeneration++;
        segmentedPlayer.stop();
        playRequested = false;
        scheduledPlayback = false;
        isPlaying = false;
        player = null;
        voiceBtn.classList.remove('playing');
        updateSegmentButton();
        void notifyAvatarSyncStop(reason);
      };

      segmentedPlayer.onSegmentStart = (seq) => {
        const current = segmentData[seq];
        if (!current) return;
        isPlaying = true;
        voiceBtn.classList.remove('partial', 'ready', 'loading');
        voiceBtn.classList.add('playing');
        voiceLabel.textContent = `播放 ${seq + 1}/${voiceSegments.length}`;
        // 每段实际开始播放时再同步 Avatar，避免动作提前于声音。
        void notifyAvatarSyncPlay(
          current.audioUrl,
          current.text || voiceSegments[seq],
          current.emotion || '',
          current.performance || getCurrentPerformance(),
        );
      };
      segmentedPlayer.onAllScheduled = () => {
        scheduledPlayback = true;
        updateSegmentButton();
      };
      segmentedPlayer.onEnded = () => {
        if (!playRequested) return;
        playRequested = false;
        isPlaying = false;
        player = null;
        voiceBtn.classList.remove('playing');
        updateSegmentButton();
        void notifyAvatarSyncStop('ended');
      };
      player = {
        stop: () => stopSegmentedPlayback('cancel'),
        _gapless: segmentedPlayer,
      };

      const maybeStartSegmentedPlayback = () => {
        if (!playRequested) return;
        segmentedPlayer.start();
      };

      const fetchSegmentAudio = async (index, data) => {
        const response = await fetch(data.audioUrl);
        if (!response.ok) throw new Error(`音频下载失败（${response.status}）`);
        const bytes = await response.arrayBuffer();
        await segmentedPlayer.addSegment(index, bytes);
      };

      const synthesizeSegment = async (index, token, generation) => {
        const segmentText = voiceSegments[index];
        segmentStates[index] = 'loading';
        updateSegmentButton();
        try {
          const data = await requestVoiceSynthesis(
            buildVoiceRequest({ text: segmentText, replyGroupId: voiceGroupId, force: synthesisForce }),
            { notify: true, cancelToken: token, groupId: voiceGroupId },
          );
          // A refresh starts a new batch. Discard late results from the old
          // batch so they cannot resurrect stale audio or button state.
          if (generation !== synthesisGeneration) return { success: false, cancelled: true };
          if (data.cancelled) {
            segmentStates[index] = 'failed';
            segmentedPlayer.markFailed(index);
            return data;
          }
          if (!data.success || !data.audioUrl) {
            segmentStates[index] = 'failed';
            segmentedPlayer.markFailed(index);
            return data;
          }
          adoptSynthesisPerformance(data);
          segmentData[index] = {
            ...data,
            text: segmentText,
            audioUrl: data.audioUrl,
            performance: data.performance || getCurrentPerformance(),
          };
          // 首段 URL 作为按钮的可播放标志；完整进度由 segmentStates 决定。
          if (index === 0) {
            cachedAudioUrl = data.audioUrl;
            voiceBtn.dataset.cachedUrl = data.audioUrl;
            voiceBtn.dataset.cachedEmotion = data.emotion || data.desc || '';
          }
          await fetchSegmentAudio(index, data);
          segmentStates[index] = 'ready';
          _voicePreloadCache.preload(data.audioUrl);
          updateSegmentButton();
          if (index === 0) {
            maybeAutoPlay(data);
            maybeStartSegmentedPlayback();
          }
          return data;
        } catch (error) {
          if (generation !== synthesisGeneration) return { success: false, cancelled: true };
          segmentStates[index] = 'failed';
          segmentedPlayer.markFailed(index);
          updateSegmentButton();
          return { success: false, error: error?.message || '分段合成失败' };
        }
      };

      const startSegmentedSynthesis = () => {
        if (synthesisStarted) return Promise.all(segmentPromises);
        synthesisStarted = true;
        const generation = synthesisGeneration;
        voiceCancelToken = beginVoiceGeneration();
        // 每段拥有自己的取消令牌；分组调度器会让同组请求并行。
        segmentPromises = voiceSegments.map((_, index) => {
          const token = { cancelled: false, started: false };
          segmentTokens[index] = token;
          return synthesizeSegment(index, token, generation);
        });
        updateSegmentButton();
        return Promise.all(segmentPromises);
      };
      voiceBtn._startSegmentedSynthesis = startSegmentedSynthesis;

      if (autoSynthesize && !voiceStoppedByUserThisSession) {
        void startSegmentedSynthesis();
      }

      voiceBtn.addEventListener('click', async () => {
        if (isPlaying || playRequested) {
          stopSegmentedPlayback('cancel');
          return;
        }
        if (!synthesisStarted) {
          // Do not wait for every segment. The first decoded segment starts
          // playback as soon as it is ready; later segments keep synthesizing
          // in the background and are appended in order.
          void startSegmentedSynthesis();
        }
        playRequested = true;
        isPlaying = true;
        player = { stop: () => stopSegmentedPlayback('cancel'), _gapless: segmentedPlayer };
        segmentedPlayer.start();
        updateSegmentButton();
      });

      // Keep refresh available for completed segmented replies. The old
      // single-file cache cannot represent a segment list, so refresh simply
      // starts a new group and replaces the current playable batch.
      refreshBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!ttsAvailable) {
          showToast('请先启动语音服务才能刷新语音', 2500);
          return;
        }
        if (isPlaying || playRequested) stopSegmentedPlayback('cancel');
        for (const token of segmentTokens) if (token) token.cancelled = true;
        synthesisGeneration++;
        synthesisStarted = false;
        segmentPromises = [];
        segmentStates.fill('pending');
        segmentData.fill(null);
        segmentTokens.fill(null);
        segmentedPlayer.stop();
        segmentedPlayer.setTotal(voiceSegments.length);
        cachedAudioUrl = null;
        voiceBtn.dataset.cachedUrl = '';
        voiceBtn.dataset.cachedEmotion = '';
        voiceBtn.classList.remove('ready', 'partial', 'playing', 'failed', 'cancelled');
        voiceBtn.classList.add('loading');
        voiceLabel.textContent = '重新合成…';
        refreshBtn.style.display = 'none';
        synthesisForce = true;
        try {
          await startSegmentedSynthesis();
        } finally {
          synthesisForce = false;
        }
      });
      updateSegmentButton();
      return;
    }

    // ===== 只有新消息才后台预合成，历史消息点播 =====
    if (autoSynthesize && !voiceStoppedByUserThisSession) {
      voiceBtn.classList.add('loading');
      const cancelToken = beginVoiceGeneration();
      voiceLabel.textContent = isVoiceGenerationBusy() ? '等待中…' : '合成中…';
      preSynthesisPromise = (async () => {
        try {
          const data = await requestVoiceSynthesis(
            buildVoiceRequest(),
            { notify: true, cancelToken }
          );
          if (data.cancelled) {
            voiceBtn.classList.remove('loading');
            voiceLabel.textContent = '语音';
            return false;
          }
          if (data.success && data.audioUrl) {
            adoptSynthesisPerformance(data);
            cachedAudioUrl = data.audioUrl;
            voiceBtn.dataset.cachedUrl = data.audioUrl;
            voiceBtn.dataset.cachedEmotion = data.emotion || data.desc || '';
            preSynthesisDone = true;
            voiceBtn.classList.remove('loading');
            voiceBtn.classList.add('ready');
            voiceLabel.textContent = data.duration ? `${data.duration}s` : '语音';
            refreshBtn.style.display = '';
            // 放入预加载缓存，下次翻历史秒播
            _voicePreloadCache.preload(cachedAudioUrl);
            maybeAutoPlay(data);
            return true;
          } else {
            voiceBtn.classList.remove('loading');
            voiceBtn.classList.add('failed');
            voiceLabel.textContent = data.errorCode === 'VOICE_QUEUE_FULL'
              ? '等待已满（最多3条）'
              : '合成失败，点击重试';
            refreshBtn.style.display = '';
            return false;
          }
        } catch (e) {
          voiceBtn.classList.remove('loading');
          voiceBtn.classList.add('failed');
          voiceLabel.textContent = '网络错误';
          refreshBtn.style.display = '';
          return false;
        }
      })();
    }

    // ===== 点击播放 =====
      voiceBtn.addEventListener('click', async () => {
      // 点击语音属于用户主动操作：解除此前的删除抑制，允许重新生成。
      clearVoiceMessageDeleted(voiceBtn);
      // 排队尚未开始的语音再次点击即可取消，不向 TTS 发送请求。
      if (voiceBtn.classList.contains('loading') && voiceCancelToken && !voiceCancelToken.started) {
        if (typeof voiceCancelToken.cancel === 'function') voiceCancelToken.cancel();
        else voiceCancelToken.cancelled = true;
        preSynthesisPromise = null;
        voiceBtn.classList.remove('loading');
        voiceBtn.classList.add('cancelled');
        voiceLabel.textContent = '已取消等待';
        return;
      }
      // 正在播放 → 停止
      if (isPlaying && player) {
        player.stop();
        isPlaying = false;
        player = null;
        voiceBtn.classList.remove('playing');
        voiceBtn.classList.add('ready');
        refreshBtn.style.display = '';
        void notifyAvatarSyncStop('cancel');
        return;
      }

      // 预合成已完成 → 秒播缓存（TTS 关闭也能播）
      let url = cachedAudioUrl || voiceBtn.dataset.cachedUrl;
      if (url) {
        if (!cachedAudioUrl && voiceBtn.dataset.cachedUrl) {
          cachedAudioUrl = voiceBtn.dataset.cachedUrl;
          preSynthesisDone = true;
        }
        const audio = new Audio(url);
        audio.play().then(() => {
          delete voiceBtn.dataset.autoplayPending;
          markVoiceMessageHandled(voiceBtn);
          voiceBtn.classList.remove('ready');
          voiceBtn.classList.add('playing');
          refreshBtn.style.display = 'none';
          isPlaying = true;
          // ★ player 必须有 stop() 方法（pause + currentTime 重置），否则点击暂停时 audio.stop() 不存在
          player = {
            stop: () => { audio.pause(); audio.currentTime = 0; },
            _audio: audio
          };
          // ★ 播放时获取真实 duration 更新 label（缓存命中时 server 返回 duration:null）
          if (audio.duration && isFinite(audio.duration)) {
            const dur = Math.round(audio.duration * 10) / 10;
            if (voiceLabel.textContent === '语音' || voiceLabel.textContent === '旧') {
              voiceLabel.textContent = `${dur}s`;
            }
          }
          // 通知 Avatar 同步播放（静音模式，驱动桌宠口型/动作）
          notifyAvatarSyncPlay(url, text, voiceBtn.dataset.cachedEmotion || '', getCurrentPerformance());
          audio.addEventListener('ended', () => {
            isPlaying = false;
            voiceBtn.classList.remove('playing');
            voiceBtn.classList.add('ready');
            refreshBtn.style.display = '';
            void notifyAvatarSyncStop('ended');
          });
        }).catch(() => {
          delete voiceBtn.dataset.autoplayPending;
          voiceLabel.textContent = '播放失败';
          voiceBtn.classList.remove('playing');
          voiceBtn.classList.add('ready');
          refreshBtn.style.display = '';
        });
        return;
      }

      // 以下都需要 TTS 服务运行
      if (!ttsAvailable) {
        const started = await ensureVoiceServiceStarted({ notify: true, force: true });
        if (!started.success) { voiceLabel.textContent = '服务未启动'; return; }
      }

      // 预合成失败 → 重新调用
      if (voiceBtn.classList.contains('failed')) {
        voiceBtn.classList.remove('failed');
        voiceBtn.classList.add('loading');
        const cancelToken = beginVoiceGeneration();
        voiceLabel.textContent = isVoiceGenerationBusy() ? '等待中…' : '重新合成…';
        preSynthesisPromise = (async () => {
          try {
            const data = await requestVoiceSynthesis(
              buildVoiceRequest({ force: false }),
              { notify: true, cancelToken }
            );
            if (data.cancelled) {
              voiceBtn.classList.remove('loading');
              voiceLabel.textContent = '语音';
              return false;
            }
            if (data.success && data.audioUrl) {
              adoptSynthesisPerformance(data);
              cachedAudioUrl = data.audioUrl;
              voiceBtn.dataset.cachedUrl = data.audioUrl;
            voiceBtn.dataset.cachedEmotion = data.emotion || data.desc || '';
              preSynthesisDone = true;
              voiceBtn.classList.remove('loading');
              voiceBtn.classList.add('ready');
              voiceLabel.textContent = data.duration ? `${data.duration}s` : '语音';
              refreshBtn.style.display = '';
              return true;
            }
          } catch (e) {}
          voiceBtn.classList.remove('loading');
          voiceBtn.classList.add('failed');
          voiceLabel.textContent = '合成失败';
          refreshBtn.style.display = '';
          return false;
        })().then(ok => {
          if (!ok && !cancelToken.cancelled) {
            voiceBtn.classList.remove('loading');
            voiceBtn.classList.add('failed');
            refreshBtn.style.display = '';
          }
        });
        return;
      }

      // 预合成进行中 → 等待
      if (preSynthesisPromise) {
        voiceBtn.classList.add('loading');
        voiceLabel.textContent = '生成中…';
        const ok = await preSynthesisPromise;
        if (ok && cachedAudioUrl) {
          voiceBtn.classList.remove('loading');
          voiceBtn.classList.add('ready');
          refreshBtn.style.display = '';
        } else {
          voiceBtn.classList.remove('loading');
          voiceLabel.textContent = '合成失败';
        }
        return;
      }

      // 历史消息：第一次点击，现场合成（不自动播放，只显示已就绪）
      voiceBtn.classList.add('loading');
      const cancelToken = beginVoiceGeneration();
      voiceLabel.textContent = isVoiceGenerationBusy() ? '等待中…' : '合成中…';
      preSynthesisPromise = (async () => {
        try {
          const data = await requestVoiceSynthesis(
            buildVoiceRequest(),
            { notify: true, cancelToken }
          );
          if (data.cancelled) {
            voiceBtn.classList.remove('loading');
            voiceLabel.textContent = '语音';
            return false;
          }
          if (data.success && data.audioUrl) {
            adoptSynthesisPerformance(data);
            cachedAudioUrl = data.audioUrl;
            voiceBtn.dataset.cachedUrl = data.audioUrl;
            voiceBtn.dataset.cachedEmotion = data.emotion || data.desc || '';
            preSynthesisDone = true;
            voiceBtn.classList.remove('loading');
            voiceBtn.classList.add('ready');
            voiceLabel.textContent = data.duration ? `${data.duration}s` : '语音';
            refreshBtn.style.display = '';
            maybeAutoPlay(data);
            return true;
          }
        } catch (e) {}
        voiceBtn.classList.remove('loading');
        voiceBtn.classList.add('failed');
        voiceLabel.textContent = '合成失败';
        refreshBtn.style.display = '';
        return false;
      })();
    });

    // ===== 刷新符号：点后合成新语音，旧语音保留为灰色（不管有没有修改VOICE CONTROL都可重新加载）=====
    refreshBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // “重新合成”是明确的用户请求，删除标记在这里解除。
      clearVoiceMessageDeleted(voiceBtn);
      if (!ttsAvailable) {
        showToast('请先启动语音服务才能刷新语音', 2500);
        return;
      }
      if (isPlaying && player) {
        player.stop(); isPlaying = false; player = null;
        voiceBtn.classList.remove('playing');
        void notifyAvatarSyncStop('cancel');
      }
      // 保留旧语音（当前语音推入oldVoices，最多2条）
      // 优先用闭包 cachedAudioUrl；历史消息恢复路径只写了 dataset.cachedUrl，需回退读取
      const currentCachedUrl = cachedAudioUrl || voiceBtn.dataset.cachedUrl;
      if (currentCachedUrl) {
        const oldDuration = voiceLabel.textContent.replace(/s$/, '');
        oldVoices.push({
          url: currentCachedUrl,
          duration: parseFloat(oldDuration) || null,
          text,
          emotion: voiceBtn.dataset.cachedEmotion || '',
          performance: getCurrentPerformance()
        });
        if (oldVoices.length > 2) {
          const removed = oldVoices.shift();
          if (removed?.url) void deleteAudioFileByUrl(removed.url);
        }
        renderOldVoices();
      }
      cachedAudioUrl = null;
      voiceBtn.dataset.cachedUrl = '';
      preSynthesisDone = false;
      voiceBtn.classList.remove('ready', 'playing');
      voiceBtn.classList.add('loading');
      const cancelToken = beginVoiceGeneration();
      voiceLabel.textContent = isVoiceGenerationBusy() ? '等待中…' : '准备中…';
      refreshBtn.style.display = 'none';
      preSynthesisPromise = (async () => {
        try {
          // ★ force: true 跳过L3缓存，强制重新合成（应用最新VOICE CONTROL参数）
          const data = await requestVoiceSynthesis(
            buildVoiceRequest({ force: true }),
            { notify: true, cancelToken }
          );
          if (data.cancelled) {
            voiceBtn.classList.remove('loading');
            voiceLabel.textContent = '语音';
            return false;
          }
          if (data.success && data.audioUrl) {
            adoptSynthesisPerformance(data);
            cachedAudioUrl = data.audioUrl;
            voiceBtn.dataset.cachedUrl = data.audioUrl;
            voiceBtn.dataset.cachedEmotion = data.emotion || data.desc || '';
            preSynthesisDone = true;
            voiceBtn.classList.remove('loading');
            voiceBtn.classList.add('ready');
            voiceLabel.textContent = data.duration ? `${data.duration}s` : '语音';
            refreshBtn.style.display = '';
            maybeAutoPlay(data);
            return true;
          }
        } catch (e) {}
        voiceBtn.classList.remove('loading');
        voiceBtn.classList.add('failed');
        voiceLabel.textContent = '合成失败';
        refreshBtn.style.display = '';
        return false;
      })();
    });
  }

  async function switchCharacter(characterId) {
    try {
      if (greetingTimer) { clearTimeout(greetingTimer); greetingTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      greetingSentThisSession = false;
      idleMessageSent = false;

      const res = await fetch('/api/current-character', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId }),
      });
      const data = await res.json();
      if (data.success) {
        _voicePreloadCache.clear();
        currentCharacterId = characterId;
        await loadCurrentCharacter();
        await loadHistory();
        updateChatImages();
        navigateTo('chat');
        scheduleGreeting();
        // 切换角色后自动刷新最新1条语音（用新角色语音重新合成，旧语音保留为灰色）
        // 轮询等待预合成完成（refreshBtn 变可见后再点击），最多等待 ~8 秒
        if (ttsAvailable) {
          const tryRefreshLatest = (attemptsLeft) => {
            setTimeout(() => {
              const allRows = document.querySelectorAll('.message-row.assistant');
              const lastRow = allRows[allRows.length - 1];
              const refreshBtn = lastRow?.querySelector('.msg-voice-refresh');
              if (refreshBtn && refreshBtn.style.display !== 'none') {
                refreshBtn.click();
                console.log('[Voice] 切换角色后自动刷新最新1条语音');
              } else if (attemptsLeft > 0) {
                tryRefreshLatest(attemptsLeft - 1);
              } else {
                console.log('[Voice] 切换角色后最新1条仍未合成，跳过自动刷新');
              }
            }, 1000);
          };
          tryRefreshLatest(7);
        }
      }
    } catch (e) {
      console.error('[SwitchCharacter] Failed:', e);
    }
  }

  async function loadCharactersList() {
    try {
      const res = await fetch('/api/characters');
      const data = await res.json();
      if (data.success) {
        renderCharactersList(data.characters);
      }
    } catch (e) {
      console.error('[CharactersList] Load failed:', e);
    }
  }

  function renderCharactersList(characters) {
    charactersListEl.innerHTML = '';
    if (!characters || characters.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'char-empty';
      empty.innerHTML = '<div class="char-empty-icon">+</div><div class="char-empty-text">还没有角色</div><div class="char-empty-hint">点击右上角 + 创建第一个角色</div>';
      charactersListEl.appendChild(empty);
      return;
    }
    for (const char of characters) {
      const isActive = char.id === currentCharacterId;
      const card = document.createElement('div');
      card.className = 'char-card' + (isActive ? ' active' : '');

      const avatarWrap = document.createElement('div');
      avatarWrap.className = 'char-avatar-wrap';
      const avatar = document.createElement('img');
      avatar.className = 'char-avatar';
      avatar.src = `/api/character-image/${char.id}/character?t=${Date.now()}`;
      avatar.alt = char.name;
      avatar.onerror = function () { this.style.display = 'none'; this.parentNode.classList.add('fallback'); };
      avatarWrap.appendChild(avatar);

      // 头像占位符（图片加载失败时显示首字）
      const placeholder = document.createElement('div');
      placeholder.className = 'char-avatar-placeholder';
      placeholder.textContent = (char.name || '?').charAt(0);
      avatarWrap.appendChild(placeholder);

      const info = document.createElement('div');
      info.className = 'char-info';

      const nameRow = document.createElement('div');
      nameRow.className = 'char-name-row';
      const nameEl = document.createElement('div');
      nameEl.className = 'char-name';
      nameEl.textContent = char.name;
      nameRow.appendChild(nameEl);
      if (isActive) {
        const badge = document.createElement('span');
        badge.className = 'char-badge active';
        badge.textContent = '当前';
        nameRow.appendChild(badge);
      }
      info.appendChild(nameRow);

      const metaEl = document.createElement('div');
      metaEl.className = 'char-meta';
      metaEl.textContent = 'ID: ' + char.id;
      info.appendChild(metaEl);

      const actions = document.createElement('div');
      actions.className = 'char-actions';

      if (!isActive) {
        const switchBtn = document.createElement('button');
        switchBtn.className = 'char-btn primary';
        switchBtn.textContent = '切换';
        switchBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          switchCharacter(char.id);
        });
        actions.appendChild(switchBtn);
      } else {
        const switchBtn = document.createElement('button');
        switchBtn.className = 'char-btn current';
        switchBtn.textContent = '使用中';
        switchBtn.disabled = true;
        actions.appendChild(switchBtn);
      }

      if (char.id !== 'default') {
        const delBtn = document.createElement('button');
        delBtn.className = 'char-btn danger';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showConfirm(`确定要删除角色"${char.name}"吗？该角色的所有数据将被清除。`, async () => {
            try {
              const res = await fetch(`/api/characters/${char.id}`, { method: 'DELETE' });
              const data = await res.json();
              if (data.success) {
                // 后端已自动切换到第一个可用角色，前端同步刷新
                if (data.currentCharacterId) {
                  await switchCharacter(data.currentCharacterId);
                }
                loadCharactersList();
              } else {
                showInfoModal(data.error || '删除失败');
              }
            } catch (e) { showInfoModal('删除失败'); }
          });
        });
        actions.appendChild(delBtn);
      }

      card.appendChild(avatarWrap);
      card.appendChild(info);
      card.appendChild(actions);

      // 点击卡片切换角色
      if (!isActive) {
        card.addEventListener('click', () => switchCharacter(char.id));
      }

      charactersListEl.appendChild(card);
    }
  }

  // 重置创建角色弹窗到步骤1
  function resetCreateCharModal() {
    createStep = 1;
    createMethod = null;
    createWebUrls = [];
    createdCharId = null;
    createStep1.style.display = 'block';
    createStepWeb.style.display = 'none';
    createStepCustom.style.display = 'none';
    createStepProgress.style.display = 'none';
    createStepImages.style.display = 'none';
    btnBackCreateChar.style.display = 'none';
    btnNextCreateChar.style.display = 'none';
    btnConfirmCreateChar.style.display = 'none';
    btnFinishCreateChar.style.display = 'none';
    createMethodWeb.classList.remove('selected');
    createMethodCustom.classList.remove('selected');
    createModalTitle.textContent = '创建新角色';
    // 清空所有输入
    ['web-char-id','web-char-name','web-char-hints','web-char-supplementary',
     'custom-char-id','custom-char-name','custom-char-relationship','custom-char-personality',
     'custom-char-chat','custom-char-moments','custom-char-notes',
     'create-web-url-title','create-web-url-value'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    ['web-char-type','custom-char-purpose','create-web-url-type'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.selectedIndex = 0;
    });
    ['custom-upload-txt','custom-upload-images','custom-upload-audios','final-char-avatar'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    renderCreateWebUrls();
  }

  // 渲染创建角色时的网址列表
  function renderCreateWebUrls() {
    if (!createWebUrlsList) return;
    if (createWebUrls.length === 0) {
      createWebUrlsList.innerHTML = '<div style="font-size:12px;color:#999;padding:4px 0;">暂无自定义网址（将使用默认搜索源：萌娘百科/Wikipedia/BWIKI/DuckDuckGo/百度百科/知乎/微博）</div>';
      return;
    }
    createWebUrlsList.innerHTML = createWebUrls.map((u, i) => {
      const typeTag = u.type === 'bwiki' ? '[BWIKI]' : u.type === 'api' ? '[API]' : u.type === 'search' ? '[搜索页]' : '[网页]';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;margin-bottom:4px;background:#f5f5f5;border-radius:6px;font-size:12px;gap:8px;">
        <span style="flex:1;word-break:break-all;line-height:1.4;">${typeTag} ${u.title || u.value}</span>
        <button onclick="window._removeCreateWebUrl(${i})" style="color:#e74c3c;border:none;background:none;font-size:11px;cursor:pointer;padding:2px 6px;border-radius:4px;flex-shrink:0;">删除</button>
      </div>`;
    }).join('');
  }

  window._removeCreateWebUrl = function(i) {
    createWebUrls.splice(i, 1);
    renderCreateWebUrls();
  };

  btnAddCharacter.addEventListener('click', () => {
    resetCreateCharModal();
    createCharModal.style.display = 'flex';
  });

  btnCloseCreateChar.addEventListener('click', () => { createCharModal.style.display = 'none'; });
  btnCancelCreateChar.addEventListener('click', () => { createCharModal.style.display = 'none'; });

  createCharModal.addEventListener('click', (e) => {
    if (e.target === createCharModal) createCharModal.style.display = 'none';
  });

  // 步骤1：选择创建方式
  createMethodWeb.addEventListener('click', () => {
    createMethod = 'web';
    createMethodWeb.classList.add('selected');
    createMethodCustom.classList.remove('selected');
    btnNextCreateChar.style.display = 'inline-block';
    btnNextCreateChar.textContent = '下一步';
  });

  createMethodCustom.addEventListener('click', () => {
    createMethod = 'custom';
    createMethodCustom.classList.add('selected');
    createMethodWeb.classList.remove('selected');
    btnNextCreateChar.style.display = 'inline-block';
    btnNextCreateChar.textContent = '下一步';
  });

  // 添加自定义网址（创建角色弹窗）
  // 实时校验：输入为空时禁用添加按钮
  const createWebUrlValue = document.getElementById('create-web-url-value');
  function updateCreateWebUrlBtnState() {
    const value = createWebUrlValue ? createWebUrlValue.value.trim() : '';
    const valid = !!value;
    if (btnCreateWebAddUrl) {
      btnCreateWebAddUrl.disabled = !valid;
      if (!valid) {
        btnCreateWebAddUrl.style.opacity = '0.5';
        btnCreateWebAddUrl.style.cursor = 'not-allowed';
        btnCreateWebAddUrl.style.pointerEvents = 'none';
      } else {
        btnCreateWebAddUrl.style.opacity = '1';
        btnCreateWebAddUrl.style.cursor = 'pointer';
        btnCreateWebAddUrl.style.pointerEvents = 'auto';
      }
    }
  }
  if (createWebUrlValue) {
    createWebUrlValue.addEventListener('input', updateCreateWebUrlBtnState);
    updateCreateWebUrlBtnState();
  }

  if (btnCreateWebAddUrl) {
    btnCreateWebAddUrl.addEventListener('click', () => {
      const type = document.getElementById('create-web-url-type').value;
      const title = document.getElementById('create-web-url-title').value.trim();
      const value = document.getElementById('create-web-url-value').value.trim();
      if (!value) {
        // 二次防护：空输入不允许添加
        return;
      }
      // BWIKI: value是页面标题，wiki前缀默认zspms（用户可在标题中用"|"分隔填写，如"露西亚|zspms"）
      let wiki = '';
      let pageTitle = value;
      if (type === 'bwiki') {
        if (value.includes('|')) {
          const parts = value.split('|');
          pageTitle = parts[0].trim();
          wiki = parts[1].trim() || 'zspms';
        } else {
          wiki = 'zspms'; // 默认战双帕弥什
        }
      }
      createWebUrls.push({ type, title: title || pageTitle, value: pageTitle, wiki, url: type !== 'bwiki' ? value : '' });
      document.getElementById('create-web-url-title').value = '';
      document.getElementById('create-web-url-value').value = '';
      renderCreateWebUrls();
      // 重置按钮状态为禁用
      updateCreateWebUrlBtnState();
    });
  }

  // 下一步按钮
  btnNextCreateChar.addEventListener('click', () => {
    if (createStep === 1) {
      if (!createMethod) { showInfoModal('请选择创建方式'); return; }
      createStep = 2;
      createStep1.style.display = 'none';
      btnBackCreateChar.style.display = 'inline-block';
      btnNextCreateChar.style.display = 'none';
      btnConfirmCreateChar.style.display = 'inline-block';
      if (createMethod === 'web') {
        createStepWeb.style.display = 'block';
        createModalTitle.textContent = '基于网络内容创建';
        btnConfirmCreateChar.textContent = '创建并网络蒸馏';
        renderCreateWebUrls();
      } else {
        createStepCustom.style.display = 'block';
        createModalTitle.textContent = '基于自定义内容创建';
        btnConfirmCreateChar.textContent = '创建并自定义蒸馏';
      }
    }
  });

  // 上一步按钮
  btnBackCreateChar.addEventListener('click', () => {
    if (createStep === 2) {
      createStep = 1;
      createStepWeb.style.display = 'none';
      createStepCustom.style.display = 'none';
      createStep1.style.display = 'block';
      btnBackCreateChar.style.display = 'none';
      btnConfirmCreateChar.style.display = 'none';
      btnNextCreateChar.style.display = createMethod ? 'inline-block' : 'none';
      createModalTitle.textContent = '创建新角色';
    }
  });

  // 创建并蒸馏
  btnConfirmCreateChar.addEventListener('click', async () => {
    let id, name;
    if (createMethod === 'web') {
      id = document.getElementById('web-char-id').value.trim();
      name = document.getElementById('web-char-name').value.trim();
    } else {
      id = document.getElementById('custom-char-id').value.trim();
      name = document.getElementById('custom-char-name').value.trim();
    }

    if (!id) { showInfoModal('请输入角色ID'); return; }
    if (!/^[a-zA-Z0-9_\-]+$/.test(id)) { showInfoModal('角色ID只能包含英文、数字、下划线和横线'); return; }

    // 先创建角色基础信息
    const userCognitionEl = createMethod === 'web'
      ? document.getElementById('web-char-user-cognition')
      : document.getElementById('custom-char-user-cognition');
    const userCognitionValue = userCognitionEl ? userCognitionEl.value.trim() : '';
    if (!userCognitionValue) {
      showInfoModal('请填写"角色对用户认知"（必填，第一优先人物设定）');
      return;
    }
    const payload = {
      id: id,
      name: name || id,
      role: '',
      user_title: '',
      user_cognition: userCognitionValue,
      style: '',
      background: '',
      personality: '',
      speaking_style: '',
      likes: '',
      story: '',
      supplementary: createMethod === 'web' ? document.getElementById('web-char-supplementary').value.trim() : '',
    };

    btnConfirmCreateChar.disabled = true;
    btnBackCreateChar.disabled = true;
    const originalText = btnConfirmCreateChar.textContent;

    try {
      const res = await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.success) {
        showInfoModal(data.error || '创建失败');
        btnConfirmCreateChar.disabled = false;
        btnBackCreateChar.disabled = false;
        btnConfirmCreateChar.textContent = originalText;
        return;
      }

      // 切换到新角色
      await switchCharacter(id);
      loadCharactersList();
      createdCharId = id;

      // 保存自定义网址到新角色
      if (createMethod === 'web' && createWebUrls.length > 0) {
        const knowledgeUrls = createWebUrls.map(u => ({
          type: u.type,
          title: u.type === 'bwiki' ? (u.value || u.title) : (u.title || u.value),
          wiki: u.type === 'bwiki' ? (u.wiki || 'zspms') : '',
          url: u.type !== 'bwiki' ? u.value : '',
          label: u.title || u.value,
        }));
        await fetch('/api/knowledge-urls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: knowledgeUrls }),
        });
      }

      // 保存补充设定
      if (createMethod === 'web') {
        const supp = document.getElementById('web-char-supplementary').value.trim();
        if (supp) {
          await fetch('/api/supplementary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ supplementary: supp }),
          });
        }
      }

      if (createMethod === 'web') {
        // 网络蒸馏
        btnConfirmCreateChar.textContent = '网络蒸馏中...';
        const characterType = document.getElementById('web-char-type').value;
        const hintsStr = document.getElementById('web-char-hints').value.trim();
        const searchHints = hintsStr ? hintsStr.split(/\s+/) : [];

        const distillRes = await fetch('/api/distill/web', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            characterName: name || id,
            characterType,
            searchHints,
            wikiPrefix: '',
          }),
        });
        const distillData = await distillRes.json();
        if (distillData.success && distillData.taskId) {
          // 异步任务，轮询直到完成
          btnConfirmCreateChar.textContent = '网络蒸馏中...';
          await new Promise((resolve) => {
            const dots = ['.', '..', '...', '....'];
            let dotIdx = 0;
            const pollInterval = setInterval(async () => {
              try {
                const sRes = await fetch(`/api/distill/status/${distillData.taskId}`);
                const sData = await sRes.json();
                if (!sData.success || sData.status === 'failed') {
                  clearInterval(pollInterval);
                  showInfoModal(`角色已创建，但网络蒸馏失败：${(sData.result && sData.result.error) || sData.progress || '未知错误'}。可在设置中手动生成Skill。`);
                  resolve(false);
                } else if (sData.status === 'completed') {
                  clearInterval(pollInterval);
                  const successCount = sData.result && sData.result.sources ? sData.result.sources.filter(s => s.status === 'success').length : 0;
                  const totalCount = sData.result && sData.result.sources ? sData.result.sources.length : 0;
                  showInfoModal(`角色创建成功！网络蒸馏完成（${successCount}/${totalCount}个资料源成功）。可在设置中查看和编辑Skill。`);
                  loadCharacterProfile();
                  resolve(true);
                } else {
                  dotIdx = (dotIdx + 1) % dots.length;
                  btnConfirmCreateChar.textContent = '网络蒸馏中' + dots[dotIdx];
                }
              } catch (e) { /* 网络抖动继续轮询 */ }
            }, 3000);
          });
        } else {
          showInfoModal(`角色已创建，但网络蒸馏失败：${distillData.error}。可在设置中手动生成Skill。`);
        }
        createCharModal.style.display = 'none';
      } else {
        // 自定义蒸馏（支持文件上传）
        btnConfirmCreateChar.textContent = '自定义蒸馏中...';
        createStepWeb.style.display = 'none';
        createStepCustom.style.display = 'none';
        createStepProgress.style.display = 'block';
        btnBackCreateChar.style.display = 'none';
        btnConfirmCreateChar.style.display = 'none';
        createProgressStatus.textContent = '正在分析素材并蒸馏人物特征...';
        createProgressDetail.textContent = '可能需要1-2分钟，请耐心等待';

        const formData = new FormData();
        formData.append('characterName', name || id);
        formData.append('relationship', document.getElementById('custom-char-relationship').value.trim());
        formData.append('purpose', document.getElementById('custom-char-purpose').value);
        formData.append('personalityDesc', document.getElementById('custom-char-personality').value.trim());
        formData.append('chatRecords', document.getElementById('custom-char-chat').value.trim());
        formData.append('momentsPosts', document.getElementById('custom-char-moments').value.trim());
        formData.append('otherNotes', document.getElementById('custom-char-notes').value.trim());

        // 添加TXT文件内容
        const txtInput = document.getElementById('custom-upload-txt');
        if (txtInput.files && txtInput.files.length > 0) {
          for (const file of txtInput.files) {
            const text = await file.text();
            formData.append('txtContents', text);
            formData.append('txtNames', file.name);
          }
        }

        const imageInput = document.getElementById('custom-upload-images');
        const audioInput = document.getElementById('custom-upload-audios');
        if (imageInput.files) {
          for (const file of imageInput.files) formData.append('images', file);
        }
        if (audioInput.files) {
          for (const file of audioInput.files) formData.append('audios', file);
        }

        createProgressStatus.textContent = '正在识别图片/语音并蒸馏...';
        const distillRes = await fetch('/api/distill/custom', {
          method: 'POST',
          body: formData,
        });
        const distillData = await distillRes.json();
        if (distillData.success && distillData.taskId) {
          // 异步任务，需要轮询直到完成
          await new Promise((resolve) => {
            const dots = ['.', '..', '...', '....'];
            let dotIdx = 0;
            const pollInterval = setInterval(async () => {
              try {
                const sRes = await fetch(`/api/distill/status/${distillData.taskId}`);
                const sData = await sRes.json();
                if (!sData.success || sData.status === 'failed') {
                  clearInterval(pollInterval);
                  createProgressStatus.textContent = '蒸馏失败';
                  createProgressDetail.textContent = (sData.result && sData.result.error) || sData.progress || '未知错误';
                  resolve(false);
                } else if (sData.status === 'completed') {
                  clearInterval(pollInterval);
                  createProgressStatus.textContent = '蒸馏完成！';
                  createProgressDetail.textContent = '人物特征已生成，历史记录已保存';
                  loadCharacterProfile();
                  resolve(true);
                } else {
                  dotIdx = (dotIdx + 1) % dots.length;
                  createProgressStatus.textContent = (sData.progress || '蒸馏中') + dots[dotIdx];
                }
              } catch (e) { /* 网络抖动继续轮询 */ }
            }, 3000);
          });
          // 进入图片上传步骤
          setTimeout(() => {
            createStepProgress.style.display = 'none';
            createStepImages.style.display = 'block';
            btnFinishCreateChar.style.display = 'inline-block';
            createModalTitle.textContent = '自定义角色图片';
          }, 1500);
        } else {
          createProgressStatus.textContent = '蒸馏失败';
          createProgressDetail.textContent = distillData.error || '未知错误';
          showInfoModal(`角色已创建，但自定义蒸馏失败：${distillData.error}。可在设置中手动生成Skill。`);
          createCharModal.style.display = 'none';
        }
      }
    } catch (e) {
      showInfoModal('创建失败: ' + e.message);
    }
    btnConfirmCreateChar.disabled = false;
    btnBackCreateChar.disabled = false;
    btnConfirmCreateChar.textContent = originalText;
  });

  // 完成按钮（自定义流程的图片上传步骤）
  btnFinishCreateChar.addEventListener('click', async () => {
    const avatarInput = document.getElementById('final-char-avatar');
    // ★ 修复：原代码用了不存在的 /api/upload-image 端点（FormData），改为 /api/upload-character-image/:id（JSON+base64）
    if (avatarInput.files && avatarInput.files[0] && createdCharId) {
      const file = avatarInput.files[0];
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        await fetch(`/api/upload-character-image/${createdCharId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'character', data }),
        });
      } catch (e) { console.error('[CreateChar] 头像上传失败:', e); }
    }

    createCharModal.style.display = 'none';
    showInfoModal('角色创建完成！');
  });

  async function loadCharacterProfile() {
    try {
      const res = await fetch('/api/character-profile');
      const data = await res.json();
      if (data.success) {
        setCharName.value = data.profile.name || '';
        setCharRole.value = data.profile.role || '';
        setCharTitle.value = data.profile.user_title || '';
        if (setCharUserCognition) setCharUserCognition.value = data.profile.user_cognition || '';
        setCharStyle.value = data.profile.style || '';
        if (setCharSearchHints) setCharSearchHints.value = (data.profile.skill_search_hints || []).join(', ');
        setCharBackground.value = data.background || '';
        setCharPersonality.value = data.personality || '';
        setCharSpeaking.value = data.speakingStyle || '';
        setCharLikes.value = data.likes || '';
        setCharStory.value = data.story || '';

        currentCharLabel.textContent = `当前角色: ${data.profile.name || data.characterId} (ID: ${data.characterId})`;

        const charNameEl = document.getElementById('char-name');
        if (charNameEl && data.profile.name) {
          charNameEl.textContent = data.profile.name;
          currentCharacterName = data.profile.name;
        }
      }
    } catch (e) { console.error('[CharacterProfile] Load failed:', e); }
  }

  btnSaveCharacter.addEventListener('click', async () => {
    const searchHints = setCharSearchHints ? setCharSearchHints.value.split(/[,，]/).map(s => s.trim()).filter(s => s) : [];
    const payload = {
      profile: {
        name: setCharName.value,
        role: setCharRole.value,
        user_title: setCharTitle.value,
        user_cognition: setCharUserCognition ? setCharUserCognition.value : '',
        style: setCharStyle.value,
        skill_search_hints: searchHints,
      },
      background: setCharBackground.value,
      personality: setCharPersonality.value,
      speakingStyle: setCharSpeaking.value,
      likes: setCharLikes.value,
      story: setCharStory.value,
    };
    try {
      const res = await fetch('/api/character-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success) {
        const charNameEl = document.getElementById('char-name');
        if (charNameEl) charNameEl.textContent = setCharName.value || 'AI';
        currentCharacterName = setCharName.value || 'AI';
        document.title = currentCharacterName;
        showInfoModal('角色信息已保存');
      } else {
        showInfoModal(data.error || '保存失败');
      }
    } catch (e) { showInfoModal('保存失败'); }
  });

  function setupToggleBtn(btnId, textareaId) {
    const btn = document.getElementById(btnId);
    const textarea = document.getElementById(textareaId);
    if (!btn || !textarea) return;
    btn.addEventListener('click', () => {
      if (textarea.style.display === 'none') {
        textarea.style.display = 'block';
        btn.textContent = '收起';
      } else {
        textarea.style.display = 'none';
        btn.textContent = '展开编辑';
      }
    });
  }

  setupToggleBtn('btn-toggle-bg', 'set-char-background');
  setupToggleBtn('btn-toggle-personality', 'set-char-personality');
  setupToggleBtn('btn-toggle-speaking', 'set-char-speaking');
  setupToggleBtn('btn-toggle-likes', 'set-char-likes');
  setupToggleBtn('btn-toggle-story', 'set-char-story');

  async function loadSupplementary() {
    try {
      const res = await fetch('/api/supplementary');
      const data = await res.json();
      if (data.success) { setSupplementary.value = data.content || ''; }
    } catch (e) {}
  }

  btnSaveSupplementary.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/supplementary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: setSupplementary.value }),
      });
      const data = await res.json();
      if (data.success) { showInfoModal('补充设定已保存'); }
      else { showInfoModal(data.error || '保存失败'); }
    } catch (e) { showInfoModal('保存失败'); }
  });

  // btnSaveConversationSkills 的事件监听已在对话技能模块中处理

  async function loadSkill() {
    try {
      const res = await fetch('/api/skill');
      const data = await res.json();
      if (data.success) { setSkill.value = data.skill || ''; }
    } catch (e) {}
  }

  btnSaveSkill.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/save-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: setSkill.value }),
      });
      const data = await res.json();
      if (data.success) {
        skillStatus.textContent = 'Skill已保存';
        skillStatus.className = 'api-status success';
      } else {
        skillStatus.textContent = data.error || '保存失败';
        skillStatus.className = 'api-status error';
      }
    } catch (e) {
      skillStatus.textContent = '保存失败';
      skillStatus.className = 'api-status error';
    }
  });

  if (btnRollbackSkill) {
    btnRollbackSkill.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/rollback-skill', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          setSkill.value = data.skill || '';
          skillStatus.textContent = '已回退到上一个备份';
          skillStatus.className = 'api-status success';
        } else {
          skillStatus.textContent = data.error || '回退失败';
          skillStatus.className = 'api-status error';
        }
      } catch (e) {
        skillStatus.textContent = '回退失败';
        skillStatus.className = 'api-status error';
      }
    });
  }

  // ============================================================
  // 人物蒸馏功能
  // ============================================================

  // 蒸馏面板切换
  if (tabDistillWeb) {
    tabDistillWeb.addEventListener('click', () => {
      panelDistillWeb.style.display = 'block';
      panelDistillCustom.style.display = 'none';
      tabDistillWeb.classList.add('active');
      tabDistillCustom.classList.remove('active');
      tabDistillWeb.style.background = '#4a90d9';
      tabDistillWeb.style.color = '#fff';
      tabDistillCustom.style.background = '';
      tabDistillCustom.style.color = '';
    });
  }

  if (tabDistillCustom) {
    tabDistillCustom.addEventListener('click', () => {
      panelDistillWeb.style.display = 'none';
      panelDistillCustom.style.display = 'block';
      tabDistillCustom.classList.add('active');
      tabDistillWeb.classList.remove('active');
      tabDistillCustom.style.background = '#27ae60';
      tabDistillCustom.style.color = '#fff';
      tabDistillWeb.style.background = '';
      tabDistillWeb.style.color = '';
    });
  }

  // 加载蒸馏 manifest 信息
  async function loadDistillManifest() {
    if (!distillManifestInfo) return;
    try {
      const res = await fetch('/api/distill/manifest');
      const data = await res.json();
      if (data.success && data.manifest && data.manifest.generated_at) {
        const m = data.manifest;
        const methodText = m.distill_method === 'web' ? '网络搜索蒸馏' : (m.distill_method === 'custom' ? '自定义导入蒸馏' : '未知');
        const typeText = {
          game: '游戏角色',
          anime: '动漫角色',
          real: '现实人物',
          memorial: '纪念人物',
          custom: '自定义人物',
          unknown: '未知',
        }[m.character_type] || m.character_type || '未知';
        const sourceCount = m.sources ? m.sources.length : 0;
        const successCount = m.sources ? m.sources.filter(s => s.status === 'success').length : 0;
        distillManifestInfo.style.display = 'block';
        distillManifestInfo.innerHTML = `上次蒸馏: <strong>${methodText}</strong> | 类型: ${typeText} | 生成日期: ${m.generated_at} | 最后更新: ${m.last_updated_at} | 资料源: ${successCount}/${sourceCount}`;
      } else {
        distillManifestInfo.style.display = 'none';
      }
    } catch (e) {
      distillManifestInfo.style.display = 'none';
    }
  }

  // 网络搜索蒸馏
  if (btnDistillWeb) {
    btnDistillWeb.addEventListener('click', async () => {
      btnDistillWeb.disabled = true;
      distillWebStatus.textContent = '正在启动蒸馏任务...';
      distillWebStatus.className = 'api-status';

      try {
        const body = {
          characterName: distillWebName.value.trim(),
          characterType: distillWebType.value,
          searchHints: distillWebHints.value.trim() ? distillWebHints.value.trim().split(/\s+/) : [],
        };

        const res = await fetch('/api/distill/web', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.success && data.taskId) {
          // 异步轮询任务状态
          pollDistillTask(data.taskId, distillWebStatus, btnDistillWeb, () => {
            if (typeof loadCharacterProfile === 'function') loadCharacterProfile();
            loadDistillManifest();
          });
        } else {
          distillWebStatus.textContent = data.error || '蒸馏启动失败';
          distillWebStatus.className = 'api-status error';
          btnDistillWeb.disabled = false;
        }
      } catch (e) {
        distillWebStatus.textContent = '蒸馏启动失败，请检查网络';
        distillWebStatus.className = 'api-status error';
        btnDistillWeb.disabled = false;
      }
    });
  }

  // 蒸馏任务轮询（通用，web和custom共用）
  function pollDistillTask(taskId, statusEl, btnEl, onComplete) {
    const dots = ['.', '..', '...', '....'];
    let dotIdx = 0;
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/distill/status/${taskId}`);
        const data = await res.json();
        if (!data.success) {
          clearInterval(pollInterval);
          statusEl.textContent = '任务不存在或已过期';
          statusEl.className = 'api-status error';
          if (btnEl) btnEl.disabled = false;
          return;
        }
        if (data.status === 'running') {
          dotIdx = (dotIdx + 1) % dots.length;
          statusEl.textContent = data.progress + dots[dotIdx];
          statusEl.className = 'api-status';
        } else if (data.status === 'completed') {
          clearInterval(pollInterval);
          const result = data.result;
          if (result && result.success) {
            const warnings = Array.isArray(result.warnings) ? result.warnings : [];
            statusEl.textContent = data.progress + (warnings.length ? `；${warnings.slice(0, 2).join('；')}` : '');
            statusEl.className = result.partialResult ? 'api-status' : 'api-status success';
            if (result.partialResult) showToast('角色蒸馏已保存部分结果，请查看覆盖警告后补充资料', 5000);
            setSkill.value = result.skill || '';
            if (onComplete) onComplete();
          } else {
            statusEl.textContent = (result && result.error) || '蒸馏完成但结果异常';
            statusEl.className = 'api-status error';
          }
          if (btnEl) btnEl.disabled = false;
        } else if (data.status === 'failed') {
          clearInterval(pollInterval);
          statusEl.textContent = data.progress || '蒸馏失败';
          statusEl.className = 'api-status error';
          if (btnEl) btnEl.disabled = false;
        }
      } catch (e) {
        // 网络抖动不中断轮询
      }
    }, 3000); // 每3秒轮询一次
  }

  // 自定义导入蒸馏
  if (btnDistillCustom) {
    btnDistillCustom.addEventListener('click', async () => {
      const personality = distillCustomPersonality.value.trim();
      const chat = distillCustomChat.value.trim();
      const moments = distillCustomMoments.value.trim();
      const notes = distillCustomNotes.value.trim();
      const imageInput = document.getElementById('custom-upload-images');
      const audioInput = document.getElementById('custom-upload-audios');
      const hasImages = imageInput && imageInput.files && imageInput.files.length > 0;
      const hasAudios = audioInput && audioInput.files && audioInput.files.length > 0;

      if (!personality && !chat && !moments && !notes && !hasImages && !hasAudios) {
        distillCustomStatus.textContent = '请至少提供一项素材（文字/图片/语音）';
        distillCustomStatus.className = 'api-status error';
        return;
      }

      // 检查多模态能力
      if (hasImages || hasAudios) {
        try {
          const infoRes = await fetch('/api/provider-info');
          const info = await infoRes.json();
          const warnings = [];
          if (hasImages && !info.supportsImage) {
            warnings.push('当前模型不支持图片识别，图片将保存但无法提取文字内容');
          }
          if (hasAudios && !info.supportsAudio) {
            warnings.push('当前模型不支持语音转文字，语音将保存但无法转写');
          }
          if (warnings.length > 0) {
            distillCustomStatus.innerHTML = warnings.join('；') + '。建议切换到 OpenAI/GLM/Qwen 等支持多模态的模型。<br>仍要继续？<button id="btn-continue-distill" style="margin-left:8px;padding:2px 8px;">继续蒸馏</button> <button id="btn-cancel-distill" style="margin-left:4px;padding:2px 8px;">取消</button>';
            distillCustomStatus.className = 'api-status error';
            return new Promise((resolve) => {
              const continueBtn = document.getElementById('btn-continue-distill');
              const cancelBtn = document.getElementById('btn-cancel-distill');
              if (continueBtn) {
                continueBtn.addEventListener('click', () => {
                  distillCustomStatus.textContent = '正在分析素材并蒸馏人物特征...';
                  distillCustomStatus.className = 'api-status';
                  resolve(true);
                });
              }
              if (cancelBtn) {
                cancelBtn.addEventListener('click', () => {
                  distillCustomStatus.textContent = '';
                  distillCustomStatus.className = 'api-status';
                  resolve(false);
                });
              }
            }).then((shouldContinue) => {
              if (!shouldContinue) return;
              doCustomDistill();
            });
          }
        } catch (e) {}
      }

      async function doCustomDistill() {
        btnDistillCustom.disabled = true;
        distillCustomStatus.textContent = '正在启动蒸馏任务...';
        distillCustomStatus.className = 'api-status';

        try {
          const hasFiles = hasImages || hasAudios;
          let res;
          if (hasFiles) {
            const formData = new FormData();
            formData.append('characterName', distillCustomName.value.trim());
            formData.append('relationship', distillCustomRelationship.value.trim());
            formData.append('purpose', distillCustomPurpose.value);
            formData.append('personalityDesc', personality);
            formData.append('chatRecords', chat);
            formData.append('momentsPosts', moments);
            formData.append('otherNotes', notes);
            if (hasImages) {
              for (const file of imageInput.files) formData.append('images', file);
            }
            if (hasAudios) {
              for (const file of audioInput.files) formData.append('audios', file);
            }
            res = await fetch('/api/distill/custom', { method: 'POST', body: formData });
          } else {
            const body = {
              characterName: distillCustomName.value.trim(),
              relationship: distillCustomRelationship.value.trim(),
              purpose: distillCustomPurpose.value,
              personalityDesc: personality,
              chatRecords: chat,
              momentsPosts: moments,
              otherNotes: notes,
            };
            res = await fetch('/api/distill/custom', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          }
          const data = await res.json();
          if (data.success && data.taskId) {
            pollDistillTask(data.taskId, distillCustomStatus, btnDistillCustom, () => {
              loadDistillManifest();
              loadCharacterProfile();
            });
          } else {
            distillCustomStatus.textContent = data.error || '蒸馏启动失败';
            distillCustomStatus.className = 'api-status error';
            btnDistillCustom.disabled = false;
          }
        } catch (e) {
          distillCustomStatus.textContent = '蒸馏启动失败，请检查网络';
          distillCustomStatus.className = 'api-status error';
          btnDistillCustom.disabled = false;
        }
      }

      if (!hasImages && !hasAudios) {
        doCustomDistill();
      }
    });
  }

  async function loadSkillUrls() {
    try {
      const res = await fetch('/api/skill-urls');
      const data = await res.json();
      if (data.success) { skillUrls = data.urls || []; renderSkillUrls(); }
    } catch (e) {}
  }

  function renderSkillUrls() {
    if (!skillUrlsList) return;
    skillUrlsList.innerHTML = '';
    if (skillUrls.length === 0) {
      skillUrlsList.innerHTML = '<div style="font-size:12px;color:#999;padding:4px 0;">暂无Skill专用网址</div>';
      return;
    }
    for (let i = 0; i < skillUrls.length; i++) {
      const entry = skillUrls[i];
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 10px;margin-bottom:4px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.06);border-radius:6px;font-size:12px;color:rgba(255,255,255,0.85);';
      const label = document.createElement('span');
      label.style.cssText = 'flex:1;word-break:break-all;';
      const typeTag = entry.type === 'api' ? '[API]' : '[网页]';
      label.textContent = `${typeTag} ${entry.title || ''}: ${entry.url || ''}`;
      const delBtn = document.createElement('button');
      delBtn.textContent = '删除';
      delBtn.style.cssText = 'color:#e74c3c;border:none;background:none;font-size:11px;cursor:pointer;';
      delBtn.addEventListener('click', async () => {
        skillUrls.splice(i, 1);
        await saveSkillUrls();
        renderSkillUrls();
      });
      div.appendChild(label);
      div.appendChild(delBtn);
      skillUrlsList.appendChild(div);
    }
  }

  async function saveSkillUrls() {
    try {
      await fetch('/api/skill-urls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: skillUrls }),
      });
    } catch (e) {}
  }

  if (btnAddSkillUrl) {
    btnAddSkillUrl.addEventListener('click', async () => {
      const type = addSkillUrlType.value;
      const title = addSkillUrlTitle.value.trim();
      const url = addSkillUrlValue.value.trim();
      if (!url) return;
      if (type === 'api') {
        skillUrls.push({ type: 'api', url: url, title: title || url });
      } else {
        skillUrls.push({ type: 'web', url: url, title: title || url });
      }
      await saveSkillUrls();
      renderSkillUrls();
      addSkillUrlTitle.value = '';
      addSkillUrlValue.value = '';
    });
  }

  async function loadKnowledgeUrls() {
    try {
      const res = await fetch('/api/knowledge-urls');
      const data = await res.json();
      if (data.success) { knowledgeUrls = data.urls || []; renderKnowledgeUrls(); }
    } catch (e) {}
  }

  function renderKnowledgeUrls() {
    if (!knowledgeUrlsList) return;
    knowledgeUrlsList.innerHTML = '';
    if (knowledgeUrls.length === 0) {
      knowledgeUrlsList.innerHTML = '<div style="font-size:12px;color:#999;padding:8px 0;line-height:1.5;">暂无自定义资料网址。蒸馏时会自动使用默认搜索源（萌娘百科/Wikipedia/BWIKI/DuckDuckGo/百度百科/知乎/微博），无需手动添加。</div>';
      return;
    }
    for (let i = 0; i < knowledgeUrls.length; i++) {
      const entry = knowledgeUrls[i];
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 10px;margin-bottom:4px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.06);border-radius:6px;font-size:12px;gap:8px;color:rgba(255,255,255,0.85);';
      const label = document.createElement('span');
      label.style.cssText = 'flex:1;word-break:break-all;line-height:1.4;';
      let typeTag = '[网页]';
      if (entry.type === 'bwiki') typeTag = `[BWIKI${entry.wiki ? '/' + entry.wiki : ''}]`;
      else if (entry.type === 'api') typeTag = '[API]';
      else if (entry.type === 'search') typeTag = '[搜索页]';
      label.textContent = `${typeTag} ${entry.label || ''}: ${entry.title || entry.url || ''}`;
      const delBtn = document.createElement('button');
      delBtn.textContent = '删除';
      delBtn.style.cssText = 'color:#e74c3c;border:none;background:none;font-size:11px;cursor:pointer;padding:2px 6px;border-radius:4px;flex-shrink:0;';
      delBtn.addEventListener('mouseenter', () => { delBtn.style.background = 'rgba(231,76,60,0.1)'; });
      delBtn.addEventListener('mouseleave', () => { delBtn.style.background = 'none'; });
      delBtn.addEventListener('click', async () => {
        knowledgeUrls.splice(i, 1);
        await saveKnowledgeUrls();
        renderKnowledgeUrls();
      });
      div.appendChild(label);
      div.appendChild(delBtn);
      knowledgeUrlsList.appendChild(div);
    }
  }

  async function saveKnowledgeUrls() {
    try {
      await fetch('/api/knowledge-urls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: knowledgeUrls }),
      });
    } catch (e) {}
  }

  btnAddUrl.addEventListener('click', async () => {
    const type = addUrlType.value;
    const label = addUrlLabel.value.trim();
    const value = addUrlValue.value.trim();
    if (!value) {
      // 二次防护：空输入不允许添加
      return;
    }
    if (type === 'bwiki') {
      const wiki = addUrlWiki.value.trim() || 'zspms';
      knowledgeUrls.push({ type: 'bwiki', title: value, label: label || value, wiki: wiki });
    } else if (type === 'api') {
      knowledgeUrls.push({ type: 'api', url: value, label: label || value });
    } else if (type === 'search') {
      // 搜索页类型：存储主URL，蒸馏时自动拼接角色名
      knowledgeUrls.push({ type: 'search', url: value, label: label || value });
    } else {
      knowledgeUrls.push({ type: 'web', url: value, label: label || value });
    }
    await saveKnowledgeUrls();
    renderKnowledgeUrls();
    addUrlLabel.value = '';
    addUrlValue.value = '';
    addUrlWiki.value = '';
    // 重置按钮状态为禁用
    updateAddUrlBtnState();
  });

  async function loadPermanentFacts() {
    try {
      const res = await fetch('/api/memory');
      const data = await res.json();
      if (data.success && data.memory) {
        renderPermanentFacts(data.memory.permanent_facts || [], data.memory.important_events || []);
      }
    } catch (e) {}
  }

  function renderPermanentFacts(facts, events = []) {
    if (!permanentFactsList) return;
    permanentFactsList.innerHTML = '';
    const rows = [
      ...(facts || []).map((item, index) => ({ kind: 'fact', item, index })),
      ...(events || []).map((item, index) => ({ kind: 'event', item, index })),
    ];
    if (rows.length === 0) {
      permanentFactsList.innerHTML = '<div style="font-size:12px;color:rgba(200,195,225,0.42);padding:4px 0;">暂无永久记忆</div>';
      return;
    }
    for (const row of rows) {
      const fact = row.item;
      const factText = typeof fact === 'string' ? fact : (row.kind === 'event' ? fact.event : fact.fact);
      const isImportant = row.kind === 'event'
        ? !(typeof fact === 'object' && fact.important === false)
        : typeof fact === 'object' && fact.important === true;
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 10px;margin-bottom:4px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.06);border-radius:6px;font-size:12px;color:rgba(255,255,255,0.85);';
      const label = document.createElement('span');
      label.style.cssText = 'flex:1;word-break:break-all;';
      label.textContent = factText;
      const starBtn = document.createElement('button');
      starBtn.type = 'button';
      starBtn.textContent = isImportant ? '★' : '☆';
      starBtn.title = isImportant ? '取消重要标记' : '标记为重要事件';
      starBtn.setAttribute('aria-label', starBtn.title);
      starBtn.style.cssText = `color:${isImportant ? '#f6c945' : 'rgba(255,255,255,0.45)'};border:none;background:none;font-size:18px;cursor:pointer;padding:0 6px;line-height:1;`;
      starBtn.addEventListener('click', async () => {
        try {
          const res = await fetch(row.kind === 'event' ? '/api/toggle-important-event' : '/api/toggle-permanent-fact-important', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: row.index, important: !isImportant }),
          });
          const data = await res.json();
          if (data.success) loadPermanentFacts();
        } catch (e) {}
      });
      const delBtn = document.createElement('button');
      delBtn.textContent = '删除';
      delBtn.style.cssText = 'color:#e74c3c;border:none;background:none;font-size:11px;cursor:pointer;';
      delBtn.addEventListener('click', async () => {
        try {
          await fetch(row.kind === 'event' ? '/api/delete-important-event' : '/api/delete-permanent-fact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: row.index }),
          });
          loadPermanentFacts();
        } catch (e) {}
      });
      div.appendChild(label);
      div.appendChild(starBtn);
      div.appendChild(delBtn);
      permanentFactsList.appendChild(div);
    }
  }

  btnAddFact.addEventListener('click', async () => {
    const fact = addFactInput.value.trim();
    if (!fact) return;
    try {
      const res = await fetch('/api/permanent-fact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact }),
      });
      const data = await res.json();
      if (data.success) { addFactInput.value = ''; loadPermanentFacts(); }
      else { showInfoModal(data.error || '添加失败'); }
    } catch (e) { showInfoModal('添加失败'); }
  });

  // Controller IPC uses epoch milliseconds while /api/history uses the
  // legacy "YYYY-MM-DD HH:mm:ss" string.  Keep both forms on the same
  // rendering path; a numeric timestamp must never abort message rendering.
  function toDisplayDate(timeValue) {
    if (timeValue instanceof Date) {
      return Number.isNaN(timeValue.getTime()) ? null : timeValue;
    }
    if (typeof timeValue === 'number' && Number.isFinite(timeValue)) {
      const date = new Date(timeValue);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof timeValue !== 'string') return null;
    const raw = timeValue.trim();
    if (!raw) return null;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(raw)) {
      const date = new Date(numeric);
      if (!Number.isNaN(date.getTime())) return date;
    }
    const date = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatTime(timeStr) {
    const date = toDisplayDate(timeStr);
    if (!date) return '';
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();
    const hours = date.getHours().toString().padStart(2, '0');
    const mins = date.getMinutes().toString().padStart(2, '0');
    const time = `${hours}:${mins}`;
    if (isToday) return time;
    if (isYesterday) return `昨天 ${time}`;
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}/${day} ${time}`;
  }

  function shouldShowTimeDivider(timeStr) {
    const date = toDisplayDate(timeStr);
    if (!date) return false;
    const dateKey = date.toDateString();
    if (dateKey !== lastTimeDivider) {
      lastTimeDivider = dateKey;
      return true;
    }
    return false;
  }

  // 把文本中的中文引号引用段（“……”）渲染为小一号的 .inline-quote。
  // 角色引用用户原话时只应引关键短语（prompt 已约束），渲染层统一降一号
  // 显示，未匹配引号的文本按普通文本节点输出，不改变原有语义。
  function appendQuotedText(container, text) {
    const value = String(text || '');
    const quoteRe = /“([^”]{1,40})”/g;
    let lastIdx = 0;
    let m;
    let matched = false;
    quoteRe.lastIndex = 0;
    while ((m = quoteRe.exec(value)) !== null) {
      matched = true;
      if (m.index > lastIdx) {
        container.appendChild(document.createTextNode(value.slice(lastIdx, m.index)));
      }
      const quoteSpan = document.createElement('span');
      quoteSpan.className = 'inline-quote';
      quoteSpan.textContent = m[0];
      container.appendChild(quoteSpan);
      lastIdx = m.index + m[0].length;
    }
    if (!matched) {
      container.textContent = value;
      return;
    }
    if (lastIdx < value.length) {
      container.appendChild(document.createTextNode(value.slice(lastIdx)));
    }
  }

  function addMessageToUI(role, content, time, animate, msgIndex, userMessage, performance, syncMeta) {
    // 显示用文本：剥离局部语气标记 [语气:xx] 和 [/语气]，保留包裹的文字
    // TTS 用原始 content（含标记），由 addVoiceButtonToBubble 传给后端解析
    const safeContent = stripModelControlTokens(content);
    const ttsContent = safeContent;  // 保留含语气标记的文本给 TTS
    const displayContent = safeContent.replace(/\[语气:[^\]]*\]/g, '').replace(/\[\/语气\]/g, '');
    content = displayContent;

    const row = document.createElement('div');
    row.className = `message-row ${role}`;
    if (animate) { row.style.animation = 'fadeIn 0.3s ease'; }
    if (msgIndex !== undefined) { row.dataset.msgIndex = msgIndex; }
    // Keep a renderer-side identity for every row.  The persisted HTTP
    // history has no Controller message ID, so role/text/time is the fallback
    // when an IPC event races the history poll.  Rows created by the normal
    // Chat sender also receive this marker, preventing the fallback poll from
    // appending the same message a second time.
    if (syncMeta && typeof syncMeta === 'object' && syncMeta.id) {
      row.dataset.conversationId = String(syncMeta.id);
    }
    row.dataset.syncRole = String((syncMeta && syncMeta.role) || role);
    row.dataset.syncText = stripModelControlTokens(String(
      (syncMeta && syncMeta.text) ?? content
    ))
      .replace(/\[语气:[^\]]*\]/g, '')
      .replace(/\[\/语气\]/g, '')
      .replace(/\s+/g, ' ').trim();
    const syncDate = toDisplayDate((syncMeta && syncMeta.timestamp) ?? time);
    if (syncDate) row.dataset.syncTimestamp = String(syncDate.getTime());
    if (role === 'assistant') {
      const stableIndex = msgIndex !== undefined
        ? Number(msgIndex)
        : messagesEl.querySelectorAll('.message-row').length;
      row.dataset.voiceMessageKey = VoiceAutoplayPolicy.createVoiceMessageKey(
        currentCharacterId,
        stableIndex,
        normalizeTtsTextForRequest(ttsContent)
      );
    }
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = role === 'user' ? getCharacterImageUrl('user') : getCharacterImageUrl('character');
    avatar.alt = role === 'user' ? '用户' : currentCharacterName;
    avatar.onerror = function () {
      this.style.background = role === 'user' ? '#95ec69' : '#07c160';
      this.style.display = 'block';
    };

    const bubbleWrap = document.createElement('div');
    bubbleWrap.className = 'bubble-wrap';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (isStandaloneKaomoji(content)) {
      bubble.classList.add('kaomoji-message');
      bubbleWrap.classList.add('kaomoji-bubble-wrap');
    }

    const imgMatch = content.match(/\[图片: (uploads\/[^\]]+)\]/);
    let textOnly = content.replace(/\[图片: [^\]]+\]/g, '').trim();
    // 兼容旧数据：剥离图片标记后若只剩 [图片] 占位文字，清空避免显示
    if (textOnly === '[图片]') textOnly = '';

    if (imgMatch) {
      if (textOnly) {
        const textNode = document.createElement('div');
        appendQuotedText(textNode, textOnly);
        bubble.appendChild(textNode);
      }
      const imgEl = document.createElement('img');
      imgEl.className = 'msg-image';
      imgEl.src = imgMatch[1];
      imgEl.alt = '图片';
      imgEl.loading = 'lazy';
      imgEl.addEventListener('click', () => viewImage(imgMatch[1]));
      bubble.appendChild(imgEl);
    } else {
      // 表情包标记 [表情包:大范围-细分] 渲染为图片
      // 先剥离标记得到纯文本，再逐段插入文本与表情包图片
      const stickerRe = /\[表情包:([^\]]+)\]/g;
      if (stickerRe.test(content) && currentCharacterId) {
        const parts = [];
        let lastIdx = 0;
        stickerRe.lastIndex = 0;
        let m;
        while ((m = stickerRe.exec(content)) !== null) {
          if (m.index > lastIdx) {
            parts.push({ type: 'text', value: content.slice(lastIdx, m.index) });
          }
          parts.push({ type: 'sticker', value: m[1].trim() });
          lastIdx = m.index + m[0].length;
        }
        if (lastIdx < content.length) {
          parts.push({ type: 'text', value: content.slice(lastIdx) });
        }
        for (const part of parts) {
          if (part.type === 'text') {
            const t = part.value.trim();
            if (!t) continue;
            const textNode = document.createElement('div');
            appendQuotedText(textNode, t);
            bubble.appendChild(textNode);
          } else {
            const sImg = document.createElement('img');
            sImg.className = 'msg-sticker';
            sImg.src = `/api/character-sticker-by-name/${encodeURIComponent(currentCharacterId)}/${encodeURIComponent(part.value)}`;
            sImg.alt = `表情包:${part.value}`;
            sImg.loading = 'lazy';
            sImg.onerror = function () { this.style.display = 'none'; };
            bubble.appendChild(sImg);
          }
        }
      } else {
        appendQuotedText(bubble, content);
      }
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    if (time) { timeEl.textContent = formatTime(time); }
    else {
      const now = new Date();
      const h = now.getHours().toString().padStart(2, '0');
      const m = now.getMinutes().toString().padStart(2, '0');
      timeEl.textContent = `${h}:${m}`;
    }

    bubbleWrap.appendChild(bubble);
    bubbleWrap.appendChild(timeEl);

    row.appendChild(avatar);
    row.appendChild(bubbleWrap);
    messagesEl.appendChild(row);

    // AI消息自动添加语音按钮（新消息自动后台合成）
    if (role === 'assistant' && voiceEnabled) {
      addVoiceButtonToBubble(bubbleWrap, ttsContent, animate, userMessage, performance);
    }

    scrollToBottom();
    return row;
  }

  function addTypingIndicator() {
    const row = document.createElement('div');
    row.className = 'message-row assistant';
    row.id = 'typing-row';

    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = getCharacterImageUrl('character');
    avatar.alt = currentCharacterName;
    avatar.onerror = function () {
      this.style.background = '#07c160';
      this.style.display = 'block';
    };

    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';

    row.appendChild(avatar);
    row.appendChild(indicator);
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    const typingRow = document.getElementById('typing-row');
    if (typingRow) { typingRow.remove(); }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; });
  }

  function viewImage(src) {
    const viewer = document.createElement('div');
    viewer.className = 'image-viewer';
    const img = document.createElement('img');
    img.src = src;
    viewer.appendChild(img);
    viewer.addEventListener('click', () => viewer.remove());
    document.body.appendChild(viewer);
  }

  btnPlus.addEventListener('click', () => {
    fileImage.value = ''; // 清空上次选择，确保change事件能再次触发
    fileImage.click();
  });

  fileImage.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('请选择图片文件');
      fileImage.value = '';
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      showToast('图片大小不能超过20MB');
      fileImage.value = '';
      return;
    }
    showToast('正在读取图片...', 1500);
    const reader = new FileReader();
    reader.onload = (ev) => {
      pendingImageBase64 = ev.target.result;
      previewImg.src = pendingImageBase64;
      imagePreviewBar.style.display = 'flex';
      showToast('图片已选择，输入文字后点发送', 2000);
      imagePreviewBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    reader.onerror = () => {
      showToast('图片读取失败，请重试');
    };
    reader.readAsDataURL(file);
  });

  btnRemovePreview.addEventListener('click', () => {
    pendingImageBase64 = null;
    previewImg.src = '';
    imagePreviewBar.style.display = 'none';
  });

  async function loadHistory() {
    try {
      const response = await fetch('/api/history');
      const data = await response.json();
      if (data.success && data.history && data.history.length > 0) {
        messagesEl.innerHTML = '';
        lastTimeDivider = '';
        for (let i = 0; i < data.history.length; i++) {
          const msg = data.history[i];
          addMessageToUI(msg.role, msg.content, msg.time, false, i, undefined, msg.performance, {
            role: msg.role,
            text: msg.content,
            timestamp: msg.time,
          });
        }
        scrollToBottom();
        // 刷新页面后恢复所有已缓存语音（仅查缓存，不调TTS，不自动播放）
        await recoverCachedVoices();
      } else {
        messagesEl.innerHTML = '';
        lastTimeDivider = '';
      }
    } catch (error) {
      console.error('[LoadHistory] Failed:', error);
    }
  }

  async function sendMessage() {
    const message = msgInput.value.trim();
    const imageBase64 = pendingImageBase64;
    if ((!message && !imageBase64) || isSending) return;

    isSending = true;
    btnSend.disabled = true;
    msgInput.value = '';
    autoResizeInput();

    pendingImageBase64 = null;
    previewImg.src = '';
    imagePreviewBar.style.display = 'none';

    lastUserMsgTime = Date.now();
    consecutiveProactiveCount = 0;
    lastProactiveTime = 0; // 用户发了消息，重置主动消息节流

    if (greetingTimer) { clearTimeout(greetingTimer); greetingTimer = null; }

    // 上传、渲染和请求都放进同一保护区；任何早期异常都必须释放
    // isSending，否则下一次界面输入会被静默拦截。
    try {
      let uploadedImageUrl = null;
      if (imageBase64) {
        try {
          showToast('正在上传图片...', 2000);
          const uploadRes = await fetch('/api/upload-chat-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: imageBase64 }),
          });
          const uploadData = await uploadRes.json();
          if (uploadData.success) {
            uploadedImageUrl = uploadData.url;
            showToast('图片上传成功', 1500);
          } else {
            showToast('图片上传失败: ' + (uploadData.error || '未知错误'), 3000);
          }
        } catch (e) {
          showToast('图片上传失败，请检查网络', 3000);
        }
      }

      const currentCount = messagesEl.querySelectorAll('.message-row').length;
      if (uploadedImageUrl) {
        const displayContent = message ? `${message}\n[图片: ${uploadedImageUrl}]` : `[图片: ${uploadedImageUrl}]`;
        addMessageToUI('user', displayContent, null, true, currentCount);
      } else {
        addMessageToUI('user', message, null, true, currentCount);
      }

      addTypingIndicator();

      try {
        const body = { message: message || '' };
        if (imageBase64) { body.imageBase64 = imageBase64; }

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const data = await response.json();

        removeTypingIndicator();

        if (data.success) {
          const assistantReply = stripModelControlTokens(data.reply);
          const newCount = messagesEl.querySelectorAll('.message-row').length;
          addMessageToUI('assistant', assistantReply, null, true, newCount, message, data.performance);
          // ChatX2 双向同步：通知 Controller 注入外部消息，Composer 收到后实时显示
          if (window.chatx2 && typeof window.chatx2.conversationInjectExternal === 'function') {
            try {
              void window.chatx2.conversationInjectExternal(message || '', assistantReply, Date.now(), Date.now(), data.performance)
                .catch(e => console.warn('[chatx2-sync] injectExternal failed:', e));
            } catch (e) {
              console.warn('[chatx2-sync] injectExternal failed:', e);
            }
          }
        } else {
          addErrorBubble(data.error || '出了点问题，请稍后再试');
        }
      } catch (error) {
        removeTypingIndicator();
        addErrorBubble('网络连接失败，请检查服务是否启动');
      }
    } catch (error) {
      console.error('[chat5] sendMessage preflight failed:', error);
      removeTypingIndicator();
      addErrorBubble('消息发送失败，请重试');
    } finally {
      isSending = false;
      btnSend.disabled = false;
      focusMessageInputIfAppropriate();
    }
  }

  function addErrorBubble(text) {
    const currentCount = messagesEl.querySelectorAll('.message-row').length;
    const row = document.createElement('div');
    row.className = 'message-row assistant';
    row.dataset.msgIndex = currentCount;
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = getCharacterImageUrl('character');
    avatar.alt = currentCharacterName;
    avatar.onerror = function () {
      this.style.background = '#07c160';
      this.style.display = 'block';
    };
    const bubble = document.createElement('div');
    bubble.className = 'bubble error-bubble';
    bubble.textContent = text;
    row.appendChild(avatar);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  function autoResizeInput() {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
  }

  function showConfirm(text, onConfirm) {
    confirmText.textContent = text;
    confirmModal.style.display = 'flex';
    const handleYes = () => {
      confirmModal.style.display = 'none';
      btnConfirmYes.removeEventListener('click', handleYes);
      btnConfirmNo.removeEventListener('click', handleNo);
      onConfirm();
    };
    const handleNo = () => {
      confirmModal.style.display = 'none';
      btnConfirmYes.removeEventListener('click', handleYes);
      btnConfirmNo.removeEventListener('click', handleNo);
    };
    btnConfirmYes.addEventListener('click', handleYes);
    btnConfirmNo.addEventListener('click', handleNo);
  }

  async function clearHistory() {
    showConfirm('确定要清空所有聊天记录吗？', async () => {
      try {
        void notifyAvatarSyncStop('cancel');
        await fetch('/api/clear-history', { method: 'POST' });
        messagesEl.innerHTML = '';
        lastTimeDivider = '';
      } catch (error) { console.error('[ClearHistory] Failed:', error); }
    });
  }

  // 清空聊天框中已发送的图片缓存（仅删除当前角色的 uploads/char<id>_img_* 文件）
  async function clearImageCache() {
    showConfirm('确定要清空当前角色的图片缓存吗？聊天记录中的图片将无法再显示，但不影响其他角色。', async () => {
      try {
        const res = await fetch('/api/clear-image-cache', { method: 'POST' });
        const data = await res.json();
        showToast(data.message || '已清空当前角色的图片缓存');
      } catch (error) { console.error('[ClearImageCache] Failed:', error); showToast('清空失败'); }
    });
  }

  // 清空语音合成临时输出缓存（仅删除当前角色的 voice_engine/output/char<id>_*.wav 文件）
  async function clearVoiceCache() {
    showConfirm('确定要清空当前角色的历史语音文件吗？将删除该角色过往 AI 回复生成的临时 wav 文件（释放磁盘空间），不影响其他角色，不影响语音克隆训练数据，也不影响后续语音合成。历史语音消息将无法再播放。', async () => {
      try {
        const res = await fetch('/api/clear-voice-cache', { method: 'POST' });
        const data = await res.json();
        showToast(data.message || '已清空当前角色的语音缓存');
      } catch (error) { console.error('[ClearVoiceCache] Failed:', error); showToast('清空失败'); }
    });
  }

  // 重建历史索引：从 messages.jsonl 重建 search_index.json（RAG 索引）
  // 用于清理删除对话后残留的污染数据，保证 AI 检索到的历史与当前对话一致
  async function rebuildSearchIndex() {
    showConfirm('确定要重建历史索引吗？将从归档重新构建 RAG 检索索引，清理已删除对话残留的污染数据。', async () => {
      try {
        showToast('正在重建索引...', 4000);
        const res = await fetch('/api/rebuild-search-index', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast(`索引重建完成，共 ${data.count} 条`);
        } else {
          showToast(data.error || '重建失败');
        }
      } catch (error) { console.error('[RebuildIndex] Failed:', error); showToast('重建失败'); }
    });
  }

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  msgInput.addEventListener('input', autoResizeInput);
  btnSend.addEventListener('click', sendMessage);
  btnClear.addEventListener('click', clearHistory);
  btnClearHistory.addEventListener('click', clearHistory);
  if (btnClearImageCache) btnClearImageCache.addEventListener('click', clearImageCache);
  if (btnClearVoiceCache) btnClearVoiceCache.addEventListener('click', clearVoiceCache);
  if (btnRebuildIndex) btnRebuildIndex.addEventListener('click', rebuildSearchIndex);

  // ===== 语音缓存上限自定义设置（数据管理界面，按角色独立）=====
  const setVoiceCacheLimit = document.getElementById('set-voice-cache-limit');
  const btnSaveVoiceCacheLimit = document.getElementById('btn-save-voice-cache-limit');
  // 加载当前角色的缓存上限设置（切换角色后需重新加载）
  function loadVoiceCacheLimit() {
    if (!setVoiceCacheLimit) return;
    const charId = currentCharacterId || 'default';
    fetch(`/api/voice/cache-limit?charId=${encodeURIComponent(charId)}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) setVoiceCacheLimit.value = String(data.limit);
      })
      .catch(() => {});
  }
  if (setVoiceCacheLimit && btnSaveVoiceCacheLimit) {
    // 初次加载
    loadVoiceCacheLimit();
    // 保存设置（带角色ID，仅影响当前角色）
    btnSaveVoiceCacheLimit.addEventListener('click', async () => {
      const limit = Number(setVoiceCacheLimit.value);
      const charId = currentCharacterId || 'default';
      try {
        const res = await fetch('/api/voice/cache-limit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit, charId }),
        });
        const data = await res.json();
        if (data.success) showToast(data.message, 2500);
        else showToast('保存失败: ' + (data.error || '未知错误'), 3000);
      } catch (e) {
        showToast('保存失败: ' + e.message, 3000);
      }
    });
  }

  // 聊天页 header 重建索引快捷按钮（复用 rebuildSearchIndex 函数）
  const btnRebuildIndexQuick = document.getElementById('btn-rebuild-index-quick');
  if (btnRebuildIndexQuick) btnRebuildIndexQuick.addEventListener('click', rebuildSearchIndex);

  // 设置页大项折叠：为每个 .section-title 注入折叠箭头 + 点击切换
  document.querySelectorAll('.settings-section .section-title').forEach(t => {
    if (t.querySelector('.section-collapse-arrow')) return; // 避免重复注入
    const arrow = document.createElement('span');
    arrow.className = 'section-collapse-arrow';
    arrow.textContent = '▼';
    t.appendChild(arrow);
    t.addEventListener('click', (e) => {
      // 标题内的按钮（如展开编辑开关）不触发折叠
      if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      const section = t.closest('.settings-section');
      if (!section) return;
      section.classList.toggle('collapsed');
      arrow.classList.toggle('rotated', section.classList.contains('collapsed'));
    });
    // ★ 默认收起所有设置分区（点击标题展开）
    const section = t.closest('.settings-section');
    if (section) {
      section.classList.add('collapsed');
      arrow.classList.add('rotated');
    }
  });

  confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) confirmModal.style.display = 'none'; });

  function loadCharacterImages() {
    const charImg = document.getElementById('preview-character');
    const userImg = document.getElementById('preview-user');
    if (charImg) charImg.src = getCharacterImageUrl('character');
    if (userImg) userImg.src = getCharacterImageUrl('user');
  }

  function updateChatImages() {
    document.querySelectorAll('.message-row.assistant .avatar').forEach(img => {
      img.src = getCharacterImageUrl('character');
    });
    document.querySelectorAll('.message-row.user .avatar').forEach(img => {
      img.src = getCharacterImageUrl('user');
    });
  }

  function updateChatBackground() {
    const charId = currentCharacterId || 'default';
    const customBg = localStorage.getItem(`custom-bg-url-${charId}`);
    const bgMode = localStorage.getItem(`custom-bg-mode-${charId}`) || 'cover';
    const bgOpacity = localStorage.getItem('bg-opacity') || '100';
    const bgBrightness = localStorage.getItem('bg-brightness') || '100';
    if (customBg && chatContainer) {
      chatContainer.classList.add('has-custom-bg');
      chatContainer.style.backgroundImage = `url(${customBg})`;
      chatContainer.style.backgroundSize = bgMode === 'repeat' ? 'auto' : bgMode;
      chatContainer.style.backgroundRepeat = bgMode === 'repeat' ? 'repeat' : 'no-repeat';
      chatContainer.style.backgroundPosition = 'center';
      chatContainer.style.setProperty('--bg-opacity', bgOpacity / 100);
      chatContainer.style.setProperty('--bg-brightness', bgBrightness / 100);
      if (chatArea) chatArea.classList.add('has-custom-bg');
      // ripple-layer 已移到 chat-container 内，不再依赖 default-bg，
      // 可以安全地隐藏 default-bg 整体（包括其装饰光晕），避免与自定义背景叠加
      const defaultBg = document.getElementById('default-bg');
      if (defaultBg) defaultBg.style.display = 'none';
    } else {
      if (chatContainer) {
        chatContainer.classList.remove('has-custom-bg');
        chatContainer.style.backgroundImage = 'none';
        chatContainer.style.setProperty('--bg-opacity', 1);
        chatContainer.style.setProperty('--bg-brightness', 1);
      }
      if (chatArea) chatArea.classList.remove('has-custom-bg');
      const defaultBg = document.getElementById('default-bg');
      if (defaultBg) defaultBg.style.display = '';
    }
  }

  function setupImageUpload(inputId, previewId, imageType) {
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const data = ev.target.result;
        preview.src = data;
        try {
          const res = await fetch(`/api/upload-character-image/${currentCharacterId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: imageType, data: data }),
          });
          const result = await res.json();
          if (result.success) {
            updateChatImages();
          }
        } catch (err) { console.error('[ImageUpload] Failed:', err); }
      };
      reader.readAsDataURL(file);
      input.value = '';
    });
  }

  setupImageUpload('file-character', 'preview-character', 'character');
  setupImageUpload('file-user', 'preview-user', 'user');

  let lastProactiveTime = 0; // 上次主动消息的时间戳
  const PROACTIVE_MIN_INTERVAL = 5 * 60 * 1000; // 防抖：两次主动消息至少间隔5分钟（避免短时间内多条重复）
  let proactiveSending = false; // 防止并发触发
  let proactiveSchedulerTimer = null;

  async function sendProactiveMessage(type, options = {}) {
    // 防止并发
    if (proactiveSending) return false;
    // 防抖：两次主动消息至少间隔4分钟
    const now = Date.now();
    if (now - lastProactiveTime < PROACTIVE_MIN_INTERVAL) return false;

    proactiveSending = true;
    try {
      const res = await fetch('/api/proactive-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          greetingReservationId: options.greetingReservationId || null,
          midnightCareReservationId: options.midnightCareReservationId || null,
        }),
      });
      const data = await res.json();
      if (data.success && data.reply) {
        lastProactiveTime = Date.now();
        consecutiveProactiveCount++;
        const newCount = messagesEl.querySelectorAll('.message-row').length;
        addMessageToUI('assistant', data.reply, null, true, newCount, undefined, data.performance);
        return data;
      }
      return false;
    } catch (err) {
      console.error('[ProactiveMsg] Failed:', err);
      return false;
    } finally {
      proactiveSending = false;
    }
  }

  // 打开聊天后检查当天首次问候；是否需要问候只能由后端持久化状态决定，不能用 DOM 历史判断。
  function scheduleGreeting(delay = 10000) {
    if (greetingSentThisSession || greetingTimer) return;
    greetingTimer = setTimeout(async () => {
      greetingTimer = null;
      if (greetingSentThisSession) return;
      try {
        // 询问后端今天是否需要发问候
        const checkRes = await fetch('/api/greeting/check').then(r => r.json());
        if (checkRes.shouldGreet && checkRes.type) {
          const result = await sendProactiveMessage(checkRes.type, {
            greetingReservationId: checkRes.reservationId,
          });
          if (result && result.greetingCommitted) {
            greetingSentThisSession = true;
          } else if (checkRes.reservationId) {
            await fetch('/api/greeting/release', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reservationId: checkRes.reservationId }),
            });
            scheduleGreeting(60 * 1000);
          }
        } else if (checkRes.reason === 'already_sent_today') {
          greetingSentThisSession = true;
        } else {
          // 后端预留中、短暂网络错误等情况不应让当天问候永久丢失。
          scheduleGreeting(60 * 1000);
        }
      } catch (e) {
        console.error('[Greeting] check failed:', e);
        scheduleGreeting(60 * 1000);
      }
    }, delay);
  }

  // 阶梯调度器：每分钟检查一次，按约 0.5h/6h/12h/24h/36h/48h/每天触发
  async function proactiveTick() {
    if (proactiveSending) return;
    const now = Date.now();
    if (now - lastProactiveTime < PROACTIVE_MIN_INTERVAL) return;
    try {
      // 凌晨深夜关心检查（每天最多一次）
      const hour = new Date().getHours();
      if (hour >= 0 && hour < 6) {
        try {
          const midnightRes = await fetch('/api/greeting/midnight-check').then(r => r.json());
          if (midnightRes.shouldSend) {
            await sendProactiveMessage('late_night_care', {
              midnightCareReservationId: midnightRes.reservationId,
            });
            return;
          }
        } catch (e) {}
      }
      const histRes = await fetch('/api/history').then(r => r.json()).catch(() => ({ history: [] }));
      const history = histRes.history || [];
      const type = shouldSendProactive(history);
      if (type) {
        await sendProactiveMessage(type);
      }
    } catch (e) {}
  }

  function initProactiveSystem() {
    scheduleGreeting();
    if (proactiveSchedulerTimer) clearInterval(proactiveSchedulerTimer);
    proactiveSchedulerTimer = setInterval(proactiveTick, 60 * 1000); // 每分钟检查一次
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // 页面重新可见时立即检查一次
      proactiveTick();
    }
  });

  // ========== 语音预读取（按设备性能限制浏览器音频预加载） ==========
  const PRELOAD_LIMIT = VOICE_PRELOAD_LIMIT;
  const _voicePreloadCache = VoiceAutoplayPolicy.createBoundedAudioPreloadCache({
    limit: PRELOAD_LIMIT,
    createAudio: (url) => new Audio(url),
  });
  async function preloadRecentVoice() {
    try {
      const resp = await fetch(`/api/voice/recent?limit=${PRELOAD_LIMIT}`);
      const data = await resp.json();
      if (!data.success || !data.audios) return;
      const validUrls = new Set();
      for (const audio of data.audios) {
        validUrls.add(audio.url);
        _voicePreloadCache.preload(audio.url);
      }
      // 清理缓存中已不存在的旧条目（配合后端超30删15逻辑）
      _voicePreloadCache.reconcile(validUrls);
    } catch (e) {
      console.log('[Voice] 预加载失败:', e.message);
    }
  }

  // 预合成最近 N 条 AI 消息（进入聊天 / 启动TTS / 切换语音时调用）
  // 直接调 /api/voice/speak，服务端优先走 text+voice 缓存（秒返，不消耗 TTS 资源）
  async function preSynthesizeRecent(count = AUTO_PRE_SYNTH_COUNT) {
    if (recentPreSynthesisInFlight) return;
    recentPreSynthesisInFlight = true;
    try {
    count = Math.max(0, Math.floor(Number(count) || 0));
    if (count === 0) return;
    const allRows = document.querySelectorAll('.message-row.assistant');
    const recentRows = Array.from(allRows).slice(-count);
    let done = 0;
    let failed = 0;
    for (const row of recentRows) {
      const btn = row.querySelector('.msg-voice-btn');
      if (!btn) continue;
      if (isVoiceMessageDeleted(btn)) {
        resetMissingVoiceDisplay(btn);
        continue;
      }
      if (btn.classList.contains('ready') || btn.classList.contains('loading')) continue;
      const voiceLabel = row.querySelector('.msg-voice-label');
      const voiceRow = row.querySelector('.msg-voice-row');
      const refreshBtn = voiceRow ? voiceRow.querySelector('.msg-voice-refresh') : null;
      // 从按钮 dataset 获取已剥离标记的纯文本（与合成时传的文本完全一致，保证L3缓存命中）
      const cleanText = btn.dataset.ttsText || '';
      if (!cleanText || cleanText.length < 2) continue;

      // 长回复已经在按钮内部建立分段播放器。让它启动整组任务，
      // 不再额外请求一份“整段 WAV”，否则会重复占用 TTS 队列。
      if (typeof btn._startSegmentedSynthesis === 'function') {
        try {
          await btn._startSegmentedSynthesis();
          const states = Array.isArray(btn._segmentStates) ? btn._segmentStates : [];
          if (states.length && states.every(state => state === 'ready')) done++;
          else if (states.some(state => state === 'failed')) failed++;
        } catch (e) {
          failed++;
        }
        continue;
      }

      btn.classList.add('loading');
      if (voiceLabel) voiceLabel.textContent = '检查缓存…';
      try {
        const data = await requestVoiceSynthesis(
          {
            text: cleanText,
            emotion: btn._performance?.voiceEmotion || 'auto',
            intensity: btn._performance?.intensity,
            performanceEmotion: btn._performance?.emotion,
            intent: btn._performance?.intent,
            confidence: btn._performance?.confidence,
            emphasis: btn._performance?.emphasis || [],
            segments: btn._performance?.segments || [],
          },
          { notify: false }
        );
        if (data.success && data.audioUrl) {
          if (data.performance && typeof data.performance === 'object') {
            btn._performance = { ...(btn._performance || {}), ...data.performance };
          } else if (data.emotion && btn._performance && !btn._performance.voiceEmotion) {
            btn._performance = { ...btn._performance, voiceEmotion: data.emotion };
          }
          btn.classList.remove('loading');
          btn.classList.add('ready');
          btn.dataset.cachedUrl = data.audioUrl;
          btn.dataset.cachedEmotion = data.emotion || data.desc || '';
          if (voiceLabel) voiceLabel.textContent = data.duration ? `${data.duration}s` : '语音';
          if (refreshBtn) refreshBtn.style.display = '';
          // 放入全局浏览器缓存
          _voicePreloadCache.preload(data.audioUrl);
          const shouldPlayHistoryResult = VoiceAutoplayPolicy.shouldAutoPlaySynthesisResult({
            isRealtime: false,
            cached: data.cached === true,
            alreadyHandled: isVoiceMessageHandled(btn)
          });
          if (data.cached === true) {
            markVoiceMessageHandled(btn);
          } else if (shouldPlayHistoryResult && row === getLatestAssistantRow()) {
            requestLatestVoiceAutoplay(btn);
          }
          done++;
        } else {
          // 缓存不存在不等于合成失败；历史语音保持普通“语音”状态。
          resetMissingVoiceDisplay(btn);
        }
      } catch (e) {
        resetMissingVoiceDisplay(btn);
      }
    }
    if (done > 0) console.log(`[Voice] 缓存命中 ${done} 条消息`);
    if (failed > 0) showToast(`${failed} 条语音自动合成失败，可点击语音按钮重试`, 5000);
    } finally {
      recentPreSynthesisInFlight = false;
    }
  }

  // F5刷新/进入页面后恢复最近一段历史的已缓存语音（仅查L3缓存，不调TTS）
  // 关闭语音后已加载的语音也可直接点击播放，刷新页面后同样恢复
  async function recoverCachedVoices() {
    const allRows = Array.from(document.querySelectorAll('.message-row.assistant'))
      .slice(-VOICE_CACHE_RECOVERY_LIMIT);
    if (allRows.length === 0) return;
    const items = [];
    const rowRefs = [];
    for (const row of allRows) {
      const btn = row.querySelector('.msg-voice-btn');
      if (!btn) continue;
      if (isVoiceMessageDeleted(btn)) {
        resetMissingVoiceDisplay(btn);
        continue;
      }
      // 跳过已经 ready / loading 的
      if (btn.classList.contains('ready') || btn.classList.contains('loading')) continue;
      // 从按钮 dataset 获取已剥离标记的纯文本（与合成时一致，保证L3缓存命中）
      const cleanText = btn.dataset.ttsText || '';
      if (!cleanText || cleanText.length < 2) continue;
      items.push({
        text: cleanText,
        performance: btn._performance && typeof btn._performance === 'object'
          ? btn._performance
          : undefined,
      });
      rowRefs.push({ row, btn });
    }
    if (items.length === 0) return;
    try {
      const res = await fetch('/api/voice/batch-cache-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: items, charId: currentCharacterId || undefined }),
      });
      const data = await res.json();
      if (!data.success || !data.results) return;
      let recovered = 0;
      for (let i = 0; i < rowRefs.length && i < data.results.length; i++) {
        const r = data.results[i];
        if (!r || !r.audioUrl) continue;
        const { row, btn } = rowRefs[i];
        const voiceLabel = row.querySelector('.msg-voice-label');
        const voiceRow = row.querySelector('.msg-voice-row');
        const refreshBtn = voiceRow ? voiceRow.querySelector('.msg-voice-refresh') : null;
        btn.classList.remove('loading', 'failed');
        btn.classList.add('ready');
        btn.dataset.cachedUrl = r.audioUrl;
        if (r.emotion) btn.dataset.cachedEmotion = r.emotion;
        markVoiceMessageHandled(btn);
        if (voiceLabel) voiceLabel.textContent = '语音';
        // 刷新符号：加载完成后即显示（不管有没有修改VOICE CONTROL）
        if (refreshBtn) refreshBtn.style.display = '';
        // 放入浏览器预加载缓存
        _voicePreloadCache.preload(r.audioUrl);
        recovered++;
      }
      // 未命中缓存的历史消息保持普通“语音”显示，不遗留 loading 状态。
      for (let i = 0; i < rowRefs.length && i < data.results.length; i++) {
        const r = data.results[i];
        if (!r || !r.audioUrl) resetMissingVoiceDisplay(rowRefs[i].btn);
      }
      if (recovered > 0) console.log(`[Voice] 恢复 ${recovered} 条已缓存语音（无需重新加载）`);
    } catch (e) {
      console.log('[Voice] 恢复缓存失败:', e.message);
    }
  }

  async function init() {
    // ========== ChatX2 桌宠模式聊天记录同步 ==========
    // 尽早订阅，避免后续 await 步骤失败导致同步失效
    // 监听桌宠（Composer）通过 IPC 发送的消息，实时同步到聊天页面
    // ChatX2 双向同步状态。事件可能在页面的历史记录加载完成前到达，
    // 因此先保持“未就绪”，加载完后以 Controller 快照建立基线；否则
    // 重启/切换模式时会把旧消息重复插入，后续消息又被错误的 DOM 计数跳过。
    var syncPollTimer = null;
    var syncRetryCount = 0;
    var syncReady = false;
    var syncPending = []; // 同步未就绪期间缓冲的桌宠消息，就绪后按 ID 去重补渲染
    var syncedMessageIds = Object.create(null);
    var syncInFlight = false;
    var persistedSyncInFlight = false;
    var MAX_SYNC_RETRIES = 10;

    function syncText(value) {
      return stripModelControlTokens(String(value ?? ''))
        .replace(/\[语气:[^\]]*\]/g, '')
        .replace(/\[\/语气\]/g, '')
        .replace(/\s+/g, ' ').trim();
    }

    function findRenderedSyncRow(msg) {
      if (!msg || !messagesEl) return null;
      const role = String(msg.role || '');
      const text = syncText(msg.text);
      const date = toDisplayDate(msg.timestamp);
      const timestamp = date ? date.getTime() : 0;
      const rows = messagesEl.querySelectorAll('.message-row');
      for (var ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        if (msg.id && row.dataset.conversationId === String(msg.id)) return row;
        if (row.dataset.syncRole !== role || row.dataset.syncText !== text) continue;
        const rowTimestamp = Number(row.dataset.syncTimestamp || 0);
        // HTTP history and Controller timestamps are produced by different
        // layers, so allow the small request/response clock gap when matching.
        if (!timestamp || !rowTimestamp || Math.abs(timestamp - rowTimestamp) <= 30_000) {
          return row;
        }
      }
      return null;
    }

    function renderSyncedMessage(msg) {
      // 跳过 Chat 页面自己渲染的消息（source='chat' 或系统消息）
      if (msg.source === 'chat' || msg.role === 'system') return;
      if (msg.id && syncedMessageIds[msg.id]) return;
      const existingRow = findRenderedSyncRow(msg);
      if (existingRow) {
        if (msg.id) {
          syncedMessageIds[msg.id] = true;
          existingRow.dataset.conversationId = String(msg.id);
        }
        return;
      }
      if (msg.id) syncedMessageIds[msg.id] = true;
      var currentCount = messagesEl.querySelectorAll('.message-row').length;
      if (msg.role === 'user') {
        addMessageToUI('user', msg.text, msg.timestamp, true, currentCount, undefined, undefined, msg);
        scrollToBottom();
        addTypingIndicator();
      } else if (msg.role === 'assistant') {
        removeTypingIndicator();
        // 桌宠/持久化同步只是补齐历史显示，不是新回复；禁止因此触发自动 TTS。
        addMessageToUI('assistant', msg.text, msg.timestamp, false, currentCount, undefined, msg.semantic, msg);
        scrollToBottom();
      }
    }

    function syncDesktopMessages() {
      if (!syncReady) return;
      // Always scan the complete snapshot.  A length cursor can move
      // backwards when an IPC event and an older poll resolve out of order;
      // ID/fingerprint de-duplication makes a full scan cheap and lossless.
      if (!syncInFlight && window.chatx2 && typeof window.chatx2.conversationHistory === 'function') {
        syncInFlight = true;
        window.chatx2.conversationHistory().then(function(history) {
          if (!history || !Array.isArray(history.messages)) return;
          history.messages.forEach(renderSyncedMessage);
        }).catch(function(e) {
          console.warn('[chatx2-sync] Controller poll failed:', e);
        }).finally(function() {
          syncInFlight = false;
        });
      }
      // Disk history is a low-frequency fallback for missed IPC events and
      // for an already-running Express instance. It is also de-duplicated by
      // the same row fingerprint, so it cannot duplicate visible messages.
      if (!persistedSyncInFlight) {
        persistedSyncInFlight = true;
        fetch('/api/history', { cache: 'no-store' }).then(function(response) {
          return response.ok ? response.json() : null;
        }).then(function(data) {
          if (!data || !Array.isArray(data.history)) return;
          data.history.forEach(function(item) {
            if (!item || (item.role !== 'user' && item.role !== 'assistant')) return;
            renderSyncedMessage({
              id: `history:${item.role}:${item.time || ''}:${syncText(item.content)}`,
              role: item.role,
              text: item.content,
              source: 'persisted',
              timestamp: item.time,
              isMock: false,
              audioReady: false,
              semantic: item.performance,
            });
          });
        }).catch(function(e) {
          console.warn('[chatx2-sync] persisted history poll failed:', e);
        }).finally(function() {
          persistedSyncInFlight = false;
        });
      }
    }

    function setupSyncSubscription() {
      if (!window.chatx2 || typeof window.chatx2.onConversationEvent !== 'function') {
        syncRetryCount++;
        if (syncRetryCount < MAX_SYNC_RETRIES) {
          console.log('[chatx2-sync] window.chatx2 not ready, retry ' + syncRetryCount + '/' + MAX_SYNC_RETRIES);
          setTimeout(setupSyncSubscription, 500);
        } else {
          console.warn('[chatx2-sync] window.chatx2.onConversationEvent not available after retries');
          // 降级：仅使用轮询
          syncPollTimer = setInterval(syncDesktopMessages, 1000);
        }
        return;
      }
      console.log('[chatx2-sync] Subscribing to desktop pet conversation events');
      window.chatx2.onConversationEvent(function (event) {
        if (!event || event.type !== 'message-added' || !event.message) return;
        var msg = event.message;
        if (msg.source !== 'desktop' && msg.source !== 'controller') return;
        // loadHistory 尚未完成时不直接写 DOM；先缓冲到 syncPending，
        // 就绪后按 ID 去重补渲染，避免“先显示、后被 loadHistory 清空”的丢消息竞态。
        if (!syncReady) {
          syncPending.push(msg);
          return;
        }
        console.log('[chatx2-sync] Received message from desktop:', msg.role, msg.source);
        renderSyncedMessage(msg);
      });
      // 启动备用轮询（每1秒检查一次，确保IPC事件丢失时也能同步）
      syncPollTimer = setInterval(syncDesktopMessages, 1000);
    }

    setupSyncSubscription();

    await loadCurrentCharacter();
    loadUISettings();
    await loadHistory();
    // 历史记录加载完成后建立 Controller 基线。桌宠输入与界面输入共用
    // 同一份消息流；这里不再用 DOM 行数作为 Controller 游标。
    if (window.chatx2 && typeof window.chatx2.conversationHistory === 'function') {
      try {
        var initialConversation = await window.chatx2.conversationHistory();
        var initialMessages = initialConversation && Array.isArray(initialConversation.messages)
          ? initialConversation.messages
          : [];
        // 事件订阅在 loadHistory 完成前会暂存为“未就绪”。如果桌宠消息
        // 恰好在这段窗口到达，不能只把游标跳到末尾，否则消息会永久漏掉。
        // 先补渲染非 chat 来源；消息 ID/内容指纹去重保证不会重复。
        for (var ci = 0; ci < initialMessages.length; ci++) {
          var initialMessage = initialMessages[ci];
          if (initialMessage && initialMessage.source !== 'chat' && initialMessage.role !== 'system') {
            renderSyncedMessage(initialMessage);
          }
        }
      } catch (e) {
        console.warn('[chatx2-sync] initial conversation snapshot failed:', e);
      }
    }
    syncReady = true;
    // 处理缓冲消息（按 ID 去重补渲染），确保启动初期到达的桌宠消息不丢失
    syncPending.forEach(function (msg) { renderSyncedMessage(msg); });
    syncPending = [];
    syncDesktopMessages();
    loadApiConfig();
    loadProviderRegistry();
    loadConversationSkills();
    updateChatImages();
    initProactiveSystem();
    initEmojiPanels();
    await initVoiceToggle(); // 自动启动TTS；连续失败2次后给出资源诊断
    preloadRecentVoice(); // 预加载最新5个语音到浏览器缓存
    focusMessageInputIfAppropriate();
  }

  // ========== 颜文字 & Emoji 面板 ==========
  const KAOMOJI_DATA = {
    happy: ['(≧▽≦)', '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧', '(｡◕‿◕｡)', '(*^▽^*)', '(✧ω✧)', '(≧◡≦)', '(⌒‿⌒)', 'ヽ(>∀<☆)ノ', '(●\'◡\'●)', '(◕‿◕✿)', '(❁´◡`❁)', '(★ω★)', 'o(*≧▽≦)ツ', '(✿◡‿◡)', '(≧∇≦)/', 'ヾ(≧▽≦*)o', '(๑•̀ㅂ•́)و✧', '(๑˃̵ᴗ˂̵)و', '٩(๑❛ᴗ❛๑)۶'],
    sad: ['(╥_╥)', '(；ω；)', '(Ｔ▽Ｔ)', '(ಥ_ಥ)', '(╥﹏╥)', '(；д；)', '(T_T)', '(ಥ﹏ಥ)', '(╯_╰)', '(´;ω;`)', '(ＴＴ)', '(⋟﹏⋞)', '(´•̥̥̥ω•̥̥̥`)', '(っ˘̩╭╮˘̩)っ', '(｡•́︿•̀｡)', '(ノД`)・゜・。', '(；へ：)', '(つ﹏⊂)'],
    love: ['(♡ω♡)', '(❁´◡`❁)', '(♥ω♥*)', '(◕‿◕✿)', '(●\'◡\'●)♡', '(っ˘̩╭╮˘̩)っ♡', '(*˘︶˘*).｡.:*♡', '(灬♥ω♥灬)', '(◕ᴗ◕✿)', '(❤ω❤)', '(｡♥‿♥｡)', '♡(ŐωŐ人)', '(づ￣ ³￣)づ', '(つ≧▽≦)つ', '(｡・ω・｡)ﾉ♡', '♡(˃͈ દ ˂͈ ༶ )'],
    angry: ['(╬ Ò ‸ Ó)', '(ノಠ益ಠ)ノ彡┻━┻', '(ꐦ°᷄д°᷅)', '(╬◣д◢)', '(╬￣皿￣)', '(＃°Д°)', '(ꐦಠ□ಠ)', '(╬ﾟ◥益◤ﾟ)', '凸(｀0´)凸', '(ノ｀Д)ノ', '(╬▔皿▔)╯', '(ง •̀_•́)ง', '(╯°□°）╯︵ ┻━┻', '(‡▼益▼)', '(¬▂¬)'],
    shy: ['(⁄ ⁄•⁄ω⁄•⁄ ⁄)', '(///ω///)', '(⁄ ⁄>⁄ ▽ ⁄<⁄ ⁄)', '(〃ω〃)', '(⁄ ⁄•⁄ω⁄•⁄ ⁄)', '(⁄⁄>⁄▽⁄<⁄⁄)', '(⁄⁄⁄ω⁄⁄⁄)', '(⁄ ⁄•⁄ω⁄•⁄ ⁄)♡', '(///▽///)', '(〃∀〃)', '(⁄ ⁄•⁄ロ⁄•⁄ ⁄)', '(*/ω＼*)', '(//▽//)', '(｡･･｡)'],
    greeting: ['(｡･∀･)ﾉﾞ', 'ヾ(•ω•`)o', '( ´ ▽ ` )ﾉ', 'ヾ(＾-＾)ノ', 'ヽ(・∀・)ﾉ', '(｡･ω･｡)ﾉ♡', 'ヾ(￣▽￣)Bye~Bye~', '(o´ω`o)ﾉ', '(*´∀`)~♥'],
    comfort: ['(づ｡◕‿‿◕｡)づ', '(っ´ω`)ﾉ(╥ω╥)', '(｡･ω･)ﾉﾞ', '(ノωヽ)', '(つ´∀`)つ', '(っ・ω・)っ', '(｡•́︿•̀｡)ヾ(･ω･`)', '(￣▽￣)ノ'],
    confused: ['(⊙_⊙)?', '(・・ ) ?', '(´･ω･`)?', '(｡ŏ﹏ŏ)', '(￣ω￣;)', 'Σ(°ロ°)', '(•ิ_•ิ)?', '(・・;)ゞ', 'ヽ(。_°)ノ'],
    other: ['(￣▽￣)', '╮(╯▽╰)╭', '(¬_¬)', '(ー_ー)!!', '(￣ー￣)', '(⊙_⊙)', '(°ロ°)', '(°▽°)', '(・_・;)', '(￣ω￣;)', 'Σ(°ロ°)', '( ˘ω˘ )', '(・∀・)', '(ーー;)', '┐(￣ヮ￣)┌', '(´・ω・`)', '(；一_一)', 'orz', 'OTL'],
  };

  const KNOWN_KAOMOJI = new Set(Object.values(KAOMOJI_DATA).flat());

  function isStandaloneKaomoji(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 80 || /[\r\n]/.test(text)) return false;
    if (KNOWN_KAOMOJI.has(text)) return true;
    return /^[\s()（）\[\]{}<>＜＞\/\\|_*~～^＾;；:：,.，。!?！？'"`´°♡♥❤☆★✧✦♪♬＋+－=＿—・…╥ಥＴω▽ヮ◕◡⌒ಠ益╬皿дДロ∀¬ー⊙˘‿｡•︿ﾉヽヾ╮╭┐└┌┘┻━凸งづつっノΣᕙᕗ]+$/u.test(text);
  }


  let activeKaomojiCat = 'happy';

  function initEmojiPanels() {
    // 颜文字按钮
    btnKaomoji.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = kaomojiPanel.style.display !== 'none';
      closeEmojiPanels();
      if (!isOpen) {
        kaomojiPanel.style.display = 'block';
        btnKaomoji.classList.add('active');
        renderKaomoji(activeKaomojiCat);
      }
    });

    // 颜文字分类切换
    kaomojiPanel.querySelectorAll('.emoji-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        kaomojiPanel.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeKaomojiCat = tab.dataset.cat;
        renderKaomoji(activeKaomojiCat);
      });
    });

    // 点击其他地方关闭面板
    document.addEventListener('click', (e) => {
      if (!kaomojiPanel.contains(e.target) && e.target !== btnKaomoji
          && !btnKaomoji.contains(e.target)) {
        closeEmojiPanels();
      }
    });

    // 初始渲染
    renderKaomoji('happy');
  }

  function closeEmojiPanels() {
    kaomojiPanel.style.display = 'none';
    btnKaomoji.classList.remove('active');
  }

  function renderKaomoji(cat) {
    const items = KAOMOJI_DATA[cat] || [];
    kaomojiList.innerHTML = '';
    items.forEach(k => {
      const btn = document.createElement('button');
      btn.className = 'emoji-item kaomoji';
      btn.textContent = k;
      btn.addEventListener('click', () => insertToInput(k));
      kaomojiList.appendChild(btn);
    });
  }


  function insertToInput(text) {
    const start = msgInput.selectionStart;
    const end = msgInput.selectionEnd;
    const value = msgInput.value;
    msgInput.value = value.substring(0, start) + text + value.substring(end);
    msgInput.selectionStart = msgInput.selectionEnd = start + text.length;
    msgInput.focus();
    autoResizeInput();
  }

  // ============================================================
  // 触屏涟漪：轻微触摸水面的感觉（不是持续亮斑）
  // ============================================================
  // 注意：ripple-layer 已从 default-bg 移到 chat-container 内部，
  // 这样启用自定义背景时不会被 chat-container::before 背景层遮挡。
  const chatContainerEl = document.querySelector('.chat-container');
  const rippleLayer = chatContainerEl ? chatContainerEl.querySelector('.touch-ripple-layer') : null;

  // 涟漪强度配置（由设置控制）
  let touchIntensity = 'light'; // off / light / normal / strong
  let rippleFreq = 'sparse'; // sparse / normal / dense
  let rippleStyle = 'note'; // ripple / petal / sparkle / note
  const INTENSITY_CONFIG = {
    off: { peak: 0, scale: 0, size: 0 },
    light: { peak: 0.18, scale: 6, size: 40 },
    normal: { peak: 0.35, scale: 8, size: 60 },
    strong: { peak: 0.55, scale: 10, size: 80 }
  };
  // 频率配置：距离阈值（px）+ 节流时间（ms）——整体下降一个等级，更舒缓
  const FREQ_CONFIG = {
    sparse: { dist: 220, throttle: 450 },
    normal: { dist: 150, throttle: 300 },
    dense: { dist: 80, throttle: 150 }
  };

  // 鼠标移动时生成涟漪（节流，避免密集）
  let lastRippleTime = 0;
  let lastRippleX = 0;
  let lastRippleY = 0;

  function createRipple(x, y) {
    if (!rippleLayer) return;
    if (rippleStyle === 'off') return; // 触屏效果关闭
    const config = INTENSITY_CONFIG[touchIntensity] || INTENSITY_CONFIG.normal;
    if (config.peak === 0) return;

    if (rippleStyle === 'petal') {
      // 花瓣飘落效果：生成2-3片花瓣，自然飘落，缓缓消失
      const petalCount = 2 + Math.floor(Math.random() * 2);
      for (let p = 0; p < petalCount; p++) {
        const petal = document.createElement('div');
        petal.className = 'touch-petal';
        const size = config.size * (0.5 + Math.random() * 0.3);
        petal.style.left = (x + (Math.random() - 0.5) * 20) + 'px';
        petal.style.top = (y + (Math.random() - 0.5) * 20) + 'px';
        petal.style.width = size + 'px';
        petal.style.height = size + 'px';
        petal.style.setProperty('--ripple-peak', config.peak);
        // 摇摆幅度（左右摆动）
        petal.style.setProperty('--sway-x', (20 + Math.random() * 30) + 'px');
        // 最终漂移方向
        petal.style.setProperty('--drift-x', (Math.random() * 80 - 40) + 'px');
        // 每片花瓣动画时长略有差异，缓缓消失
        const duration = 3.5 + Math.random() * 1.5;
        petal.style.animation = `petalFall ${duration}s ease-in-out forwards`;
        rippleLayer.appendChild(petal);
        setTimeout(() => { if (petal.parentNode) petal.parentNode.removeChild(petal); }, (duration + 0.3) * 1000);
      }
    } else if (rippleStyle === 'sparkle') {
      // 光点粒子爆发效果：多个光点向四周弧形扩散，缓缓消失
      const count = 6 + Math.floor(config.scale / 2);
      for (let i = 0; i < count; i++) {
        const sparkle = document.createElement('div');
        sparkle.className = 'touch-sparkle';
        sparkle.style.left = x + 'px';
        sparkle.style.top = y + 'px';
        sparkle.style.setProperty('--ripple-peak', config.peak);
        // 均匀分布角度 + 随机偏移
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
        const dist = 30 + Math.random() * config.size * 0.8;
        sparkle.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
        sparkle.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
        // 光点大小随机微调
        const sparkleSize = 5 + Math.random() * 4;
        sparkle.style.width = sparkleSize + 'px';
        sparkle.style.height = sparkleSize + 'px';
        // 动画时长略有差异，缓缓消失
        const duration = 1.8 + Math.random() * 0.8;
        sparkle.style.animation = `sparkleBurst ${duration}s ease-out forwards`;
        rippleLayer.appendChild(sparkle);
        setTimeout(() => { if (sparkle.parentNode) sparkle.parentNode.removeChild(sparkle); }, (duration + 0.3) * 1000);
      }
    } else if (rippleStyle === 'note') {
      // 音符飘升效果：1-2个音符从触点向上飘升，缓缓旋转消失
      const noteCount = 1 + Math.floor(Math.random() * 2);
      const noteChars = ['♪', '♫', '♬', '♩', '♭', '♮'];
      for (let n = 0; n < noteCount; n++) {
        const note = document.createElement('div');
        note.className = 'touch-note';
        note.textContent = noteChars[Math.floor(Math.random() * noteChars.length)];
        const noteSize = 16 + Math.random() * 12;
        note.style.left = (x + (Math.random() - 0.5) * 30) + 'px';
        note.style.top = (y + (Math.random() - 0.5) * 10) + 'px';
        note.style.fontSize = noteSize + 'px';
        note.style.setProperty('--ripple-peak', config.peak);
        // 水平摇摆幅度
        note.style.setProperty('--sway-x', (30 + Math.random() * 40) + 'px');
        // 向上飘升距离
        note.style.setProperty('--rise-y', -(80 + Math.random() * 60) + 'px');
        // 随机旋转方向
        note.style.setProperty('--note-rotate', (Math.random() > 0.5 ? '' : '-') + (180 + Math.random() * 180) + 'deg');
        // 缓缓消失的动画时长
        const duration = 2.8 + Math.random() * 1.2;
        note.style.animation = `noteFloat ${duration}s ease-out forwards`;
        rippleLayer.appendChild(note);
        setTimeout(() => { if (note.parentNode) note.parentNode.removeChild(note); }, (duration + 0.3) * 1000);
      }
    } else {
      // 默认水面涟漪效果，缓缓扩散消失
      const ripple = document.createElement('div');
      ripple.className = 'touch-ripple';
      ripple.style.left = x + 'px';
      ripple.style.top = y + 'px';
      ripple.style.width = config.size + 'px';
      ripple.style.height = config.size + 'px';
      ripple.style.setProperty('--ripple-peak', config.peak);
      ripple.style.setProperty('--ripple-scale', config.scale);
      ripple.style.animation = 'touchRipple 1.8s ease-out forwards';
      rippleLayer.appendChild(ripple);
      setTimeout(() => { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 1900);
    }
  }

  // 鼠标移动：节流生成涟漪（移动距离够远或时间够久才生成）
  if (rippleLayer && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    document.addEventListener('mousemove', (e) => {
      const config = INTENSITY_CONFIG[touchIntensity] || INTENSITY_CONFIG.normal;
      if (config.peak === 0) return;
      const freq = FREQ_CONFIG[rippleFreq] || FREQ_CONFIG.normal;

      const now = Date.now();
      const dx = e.clientX - lastRippleX;
      const dy = e.clientY - lastRippleY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // 距离超过阈值或时间超过节流才生成新涟漪
      if (dist > freq.dist || now - lastRippleTime > freq.throttle) {
        createRipple(e.clientX, e.clientY);
        lastRippleTime = now;
        lastRippleX = e.clientX;
        lastRippleY = e.clientY;
      }
    }, { passive: true });

    // 点击时生成稍大的涟漪
    document.addEventListener('click', (e) => {
      const config = INTENSITY_CONFIG[touchIntensity] || INTENSITY_CONFIG.normal;
      if (config.peak === 0) return;
      createRipple(e.clientX, e.clientY);
    }, { passive: true });
  }

  // 触屏支持：touchmove生成涟漪
  if (rippleLayer) {
    document.addEventListener('touchmove', (e) => {
      const config = INTENSITY_CONFIG[touchIntensity] || INTENSITY_CONFIG.normal;
      if (config.peak === 0) return;
      const freq = FREQ_CONFIG[rippleFreq] || FREQ_CONFIG.normal;
      const touch = e.touches[0];
      if (!touch) return;
      const now = Date.now();
      if (now - lastRippleTime > freq.throttle) {
        createRipple(touch.clientX, touch.clientY);
        lastRippleTime = now;
        lastRippleX = touch.clientX;
        lastRippleY = touch.clientY;
      }
    }, { passive: true });

    document.addEventListener('touchstart', (e) => {
      const config = INTENSITY_CONFIG[touchIntensity] || INTENSITY_CONFIG.normal;
      if (config.peak === 0) return;
      const touch = e.touches[0];
      if (!touch) return;
      createRipple(touch.clientX, touch.clientY);
    }, { passive: true });
  }

  // 设置：呼吸频率
  function applyBreathSpeed(speed) {
    const defaultBg = document.getElementById('default-bg');
    if (!defaultBg) return;
    if (speed === 'normal') {
      defaultBg.removeAttribute('data-breath');
    } else {
      defaultBg.setAttribute('data-breath', speed);
    }
  }

  // 设置：触屏强度
  function applyTouchIntensity(intensity) {
    touchIntensity = intensity || 'normal';
  }

  // 设置：涟漪频率
  function applyRippleFreq(freq) {
    rippleFreq = freq || 'normal';
  }

  // 设置：涟漪样式
  function applyRippleStyle(style) {
    rippleStyle = style || 'ripple';
  }

  // 点击涟漪效果：在ripple-container元素点击时产生能量扩散
  document.addEventListener('click', (e) => {
    const target = e.target.closest('.ripple-container');
    if (!target) return;

    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const size = Math.max(rect.width, rect.height) * 0.6;

    const ripple = document.createElement('span');
    ripple.className = 'ripple-wave';
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    ripple.style.width = size + 'px';
    ripple.style.height = size + 'px';

    target.appendChild(ripple);

    // 动画结束后移除元素
    setTimeout(() => {
      if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
    }, 700);
  });

  // 鼠标位置追踪：让光从鼠标方向扩散（设置CSS变量--mx/--my）
  // 事件委托方式，支持动态创建的元素
  document.addEventListener('mousemove', (e) => {
    if (!e.target || typeof e.target.closest !== 'function') return;
    const target = e.target.closest('.ripple-container, .header-btn');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    target.style.setProperty('--mx', x + '%');
    target.style.setProperty('--my', y + '%');
  });

  // 消息气泡进入时的流光扫过
  // 通过MutationObserver监听新消息添加
  const messagesObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1 && node.classList && node.classList.contains('message-row')) {
          node.classList.add('entering');
          setTimeout(() => {
            node.classList.remove('entering');
          }, 1300);
        }
      });
    });
  });
  if (messagesEl) {
    messagesObserver.observe(messagesEl, { childList: true });
  }

  init();
})();
