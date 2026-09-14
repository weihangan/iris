import { ConversationEventBus, type ConversationEventListener } from './event-bus';
import type { ConversationJob } from './conversation-job';
import type {
  AdapterResponse,
  AudioRegenerateResult,
  ChatAdapter,
  ConversationEvent,
  ConversationHistory,
  ConversationMessage,
  ConversationSubmit,
  ConversationSubmitResult,
  VoiceAdapter,
  VoiceSynthesisResult
} from './conversation-types';
import { validateWav } from './wav-validator';
import { derivePerformanceSemantic, type PerformanceSemantic } from '../performance/semantic-performance';

/**
 * Phase 5.1 修复（P0-D / P1-F）：WAV 缓存条目。
 *
 * 关键变更：
 * - 存 assistantText（不再存 userText）：regenerateAudio 用 VoiceAdapter.synthesize(assistantText)
 * - 存 createdAt：支持 TTL 过期清理（P1-F：Chat 模式不主动释放，需 TTL 兜底）
 * - 不再存 adapter 引用：regenerateAudio 改用独立的 voiceAdapter
 */
interface WavCacheEntry {
  readonly taskId: string;
  readonly wavBytes: ArrayBuffer;
  readonly assistantMessageId: string;
  readonly assistantText: string;
  readonly createdAt: number;
  readonly semantic?: PerformanceSemantic;
}

/**
 * Phase 5.1 修复（P1-F）：WAV 缓存默认 TTL（5 分钟）。
 *
 * Chat 模式不调用 audio:play，缓存条目不会被 performance:ended 主动释放。
 * TTL 兜底确保 Chat 模式下未请求播放的 WAV 不会无限增长。
 * 主进程可通过 setInterval 定期调用 cleanupExpiredWav() 触发清理。
 */
const WAV_CACHE_DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Chat 和 Desktop 共用的唯一主进程对话控制器。 */
export class ConversationController {
  private static instance: ConversationController | null = null;

  private readonly messages: ConversationMessage[] = [];
  private readonly eventBus = new ConversationEventBus();
  /**
   * Phase 5.1 修复（P0-D / P1-F）：WAV 字节缓存（taskId → WavCacheEntry）。
   * - 写入：assistant 消息写入后，WAV 校验通过后
   * - 读取：audio:play IPC handler 调用 getWavBytes(taskId) 返回副本
   * - 清理：
   *   1. performance:ended('ended' | 'failed' | 'interrupted') 时由 releaseWav(taskId) 释放
   *   2. cleanupExpiredWav(now, ttlMs) 定期清理过期条目（P1-F）
   *   3. releaseAllWav() 在模式切换/Avatar 崩溃/应用退出时释放全部（P1-F）
   *
   * 不再在新任务提交时清空所有条目：那会导致快速连续消息竞态（前一条消息的 audio:play
   * 还未到达时缓存就被清空，返回 null）。
   */
  private readonly wavCache = new Map<string, WavCacheEntry>();
  /**
   * Phase 5.1 修复（P0-A）：Avatar Runtime 是唯一 AudioContext/解码器/播放时钟所有者。
   * Composer 不再拥有 AudioContext，无法在解码完成前调用 audioSpeak。
   * 因此主进程不再需要 currentSpeakTaskId 授权字段——audio:play IPC 本身就是授权入口，
   * 主进程通过 getWavBytes(taskId) 校验 taskId 在缓存中才转发 avatar:play。
   * Avatar 在 ctx.state === 'running' && decodeAudioData 成功 && sourceNode.start 调度后
   * 才发送 performance:started，Composer 收到后才显示字幕——这是新的硬门。
   */
  private activeTask: ConversationJob | null = null;
  private activeAdapter: ChatAdapter | null = null;
  private adapter: ChatAdapter | null = null;
  /**
   * Phase 5.1 修复（P0-D）：独立 VoiceAdapter，用于 regenerateAudio()。
   * 必须通过 setVoiceAdapter() 显式注入。未注入时 regenerateAudio 返回失败。
   */
  private voiceAdapter: VoiceAdapter | null = null;
  private messageIdCounter = 0;
  private taskIdCounter = 0;

  private constructor() {}

  static getInstance(): ConversationController {
    if (!ConversationController.instance) {
      ConversationController.instance = new ConversationController();
    }
    return ConversationController.instance;
  }

  static resetInstanceForTest(): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('resetInstanceForTest only available in test mode');
    }
    ConversationController.instance = null;
  }

  setAdapter(adapter: ChatAdapter): void {
    if (this.activeTask?.status === 'pending') {
      throw new Error('Cannot replace adapter while a conversation task is pending');
    }
    this.adapter = adapter;
  }

  /**
   * Phase 5.1 修复（P0-D）：注入独立 VoiceAdapter。
   * regenerateAudio() 只调用 voiceAdapter.synthesize(assistantText)，不调用 ChatAdapter.submit(userText)。
   * 这避免了"语音重试重新请求聊天 API"的 P0 硬门失败。
   */
  setVoiceAdapter(voiceAdapter: VoiceAdapter): void {
    this.voiceAdapter = voiceAdapter;
  }

  isMockAdapter(): boolean {
    return this.adapter?.isMock ?? false;
  }

  isMockVoiceAdapter(): boolean {
    return this.voiceAdapter?.isMock ?? false;
  }

  /**
   * 合成语音（供主进程 IPC handler 使用）。
   * 用于外部消息（如 Chat 页面）的异步 TTS 合成。
   */
  async synthesizeSpeech(text: string): Promise<ArrayBuffer | null> {
    const result = await this.synthesizeSpeechDetailed(text);
    return result?.wavBytes ?? null;
  }

  async synthesizeSpeechDetailed(
    text: string,
    performance?: PerformanceSemantic,
    userMessage?: string,
  ): Promise<VoiceSynthesisResult | null> {
    if (!this.voiceAdapter) return null;
    try {
      if (this.voiceAdapter.synthesizeDetailed) {
        return await this.voiceAdapter.synthesizeDetailed(text, undefined, { performance, userMessage });
      }
      return { wavBytes: await this.voiceAdapter.synthesize(text, undefined, { performance, userMessage }) };
    } catch (e) {
      console.warn('[conversation] synthesizeSpeechDetailed failed:', e);
      return null;
    }
  }

  on(listener: ConversationEventListener): () => void {
    return this.eventBus.on(listener);
  }

  getHistory(): ConversationHistory {
    return {
      messages: [...this.messages],
      activeTask: this.activeTask ? { ...this.activeTask } : null
    };
  }

  async submit(submit: ConversationSubmit): Promise<ConversationSubmitResult> {
    const text = typeof submit?.text === 'string' ? submit.text.trim() : '';
    if (!text) {
      return { accepted: false, reason: 'empty-text' };
    }
    if (this.activeTask?.status === 'pending') {
      return { accepted: false, reason: 'busy' };
    }
    if (!this.adapter) {
      throw new Error('No adapter set. Call setAdapter() before submit().');
    }

    const now = Date.now();
    const userMessage: ConversationMessage = {
      id: this.generateMessageId(),
      role: 'user',
      text,
      source: submit.source,
      timestamp: now,
      isMock: false,
      audioReady: false
    };
    this.messages.push(userMessage);
    this.emit({ type: 'message-added', message: userMessage });

    const task: ConversationJob = {
      taskId: this.generateTaskId(),
      status: 'pending',
      userMessageId: userMessage.id,
      source: submit.source,
      inputText: text,
      startedAt: now
    };
    const taskAdapter = this.adapter;
    this.activeTask = task;
    this.activeAdapter = taskAdapter;
    this.emit({ type: 'task-started', taskId: task.taskId });

    void this.invokeAdapter(task, text, taskAdapter).catch((error) => {
      console.error('[conversation] invokeAdapter unexpected error:', error);
    });

    return { accepted: true, taskId: task.taskId, userMessage };
  }

  cancel(): { cancelled: boolean; taskId?: string; reason?: string } {
    if (!this.activeTask || this.activeTask.status !== 'pending') {
      return { cancelled: false, reason: 'no-active-task' };
    }

    const task = this.activeTask;
    const taskAdapter = this.activeAdapter;
    task.status = 'cancelled';
    task.finishedAt = Date.now();
    this.clearActiveTask(task.taskId);

    if (taskAdapter?.cancel) {
      try {
        taskAdapter.cancel(task.taskId);
      } catch (error) {
        console.error('[conversation] adapter.cancel error:', error);
      }
    }

    this.emit({ type: 'task-cancelled', taskId: task.taskId });
    this.appendSystemMessage('已取消');
    return { cancelled: true, taskId: task.taskId };
  }

  private async invokeAdapter(task: ConversationJob, userText: string, adapter: ChatAdapter): Promise<void> {
    let response: AdapterResponse;
    try {
      response = await adapter.submit(task.taskId, userText);
    } catch (error) {
      if (!this.isActiveTask(task.taskId)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.failActiveTask(task, message);
      return;
    }

    if (!this.isActiveTask(task.taskId)) {
      return;
    }
    if (response.taskId !== task.taskId) {
      this.failActiveTask(task, `Adapter taskId mismatch: received ${response.taskId}, expected ${task.taskId}`);
      return;
    }
    if (typeof response.text !== 'string') {
      this.failActiveTask(task, 'Adapter response text must be a string');
      return;
    }

    // Phase 5.1 修复（P0-1）：TTS/WAV 失败时仍保留 assistant 正文。
    let wavBytes: ArrayBuffer | null = null;
    let audioError: string | undefined = response.audioError;
    if (!response.wavBytes) {
      audioError ??= 'Adapter response missing wavBytes';
    } else {
      const wavResult = validateWav(response.wavBytes);
      if (!wavResult.valid) {
        audioError = `WAV validation failed: ${wavResult.reason}`;
      } else {
        wavBytes = response.wavBytes;
      }
    }

    const audioReady = wavBytes !== null;

    const assistantMessage: ConversationMessage = {
      id: this.generateMessageId(),
      role: 'assistant',
      text: response.text,
      source: 'controller',
      timestamp: Date.now(),
      isMock: adapter.isMock,
      audioReady,
      audioError,
      taskId: task.taskId,
      semantic: response.semantic
    };
    this.messages.push(assistantMessage);

    if (audioReady && wavBytes) {
      // Phase 5.1 修复（P0-D / P1-F）：缓存 assistantText（不再缓存 userText/adapter）。
      // regenerateAudio 用 voiceAdapter.synthesize(assistantText) 重新合成，不调用 ChatAdapter。
      // createdAt 用于 TTL 过期清理（P1-F）。
      this.wavCache.set(task.taskId, {
        taskId: task.taskId,
        wavBytes,
        assistantMessageId: assistantMessage.id,
        assistantText: response.text,
        createdAt: Date.now(),
        semantic: response.semantic
      });
    }

    task.status = 'completed';
    task.finishedAt = Date.now();
    this.emit({ type: 'message-added', message: assistantMessage, taskId: task.taskId });
    this.clearActiveTask(task.taskId);
    this.emit({ type: 'task-completed', taskId: task.taskId });

    if (!audioReady && audioError) {
      console.warn(`[conversation] assistant text preserved but audio failed (taskId=${task.taskId}): ${audioError}`);
    }
  }

  /**
   * Phase 5.1：供 audio:play IPC handler 调用。
   * 返回 wavBytes 副本（slice(0)），防止 renderer 修改主进程内存。
   * task 不在缓存返回 null（防止回放旧音频或伪造 taskId）。
   *
   * Phase 5.1 修复（P0-A）：这是新的硬门入口。Composer 调用 audio:play(taskId) 时，
   * 主进程通过此方法校验 taskId 在缓存中。校验通过后转发 avatar:play(taskId, wavBytes) 给 Avatar。
   * Avatar 是唯一 AudioContext 所有者，自然保证"解码完成前不张嘴"。
   */
  getWavBytes(taskId: string): ArrayBuffer | null {
    const entry = this.wavCache.get(taskId);
    if (!entry) {
      return null;
    }
    return entry.wavBytes.slice(0);
  }

  /**
   * Return the text that produced an already-authorized cached WAV.
   * This is used only to build local pronunciation hints for PMX visemes.
   */
  getWavAssistantText(taskId: string): string | null {
    const entry = this.wavCache.get(taskId);
    return entry?.assistantText ?? null;
  }

  getWavSemantic(taskId: string): PerformanceSemantic | null {
    return this.wavCache.get(taskId)?.semantic ?? null;
  }

  /**
   * Phase 5.1 修复（P0-3 / P0-A）：释放 WAV 缓存条目。
   * Avatar 在 performance:ended('ended' | 'failed' | 'interrupted') 时通过主进程调用此方法。
   */
  releaseWav(taskId: string): void {
    this.wavCache.delete(taskId);
  }

  /**
   * Phase 5.1 修复（P1-F）：释放所有 WAV 缓存条目。
   * 在以下场景由主进程主动调用（不能完全信任 Renderer 主动通知）：
   * - 模式切换离开 Desktop（avatar:stop-play 'mode-change' 后 Avatar 可能未及时响应）
   * - Avatar 窗口崩溃/关闭（无法发送 performance:ended）
   * - 应用退出（before-quit）
   * - 用户主动取消任务
   */
  releaseAllWav(): void {
    this.wavCache.clear();
  }

  /**
   * Phase 5.1 修复（P1-F）：清理过期的 WAV 缓存条目。
   * 主进程通过 setInterval 定期调用（例如每 60 秒）。
   * Chat 模式不调用 audio:play，缓存条目不会被 performance:ended 释放，
   * TTL 兜底确保 Chat 模式下未请求播放的 WAV 不会无限增长。
   */
  cleanupExpiredWav(now: number = Date.now(), ttlMs: number = WAV_CACHE_DEFAULT_TTL_MS): number {
    let removed = 0;
    for (const [taskId, entry] of this.wavCache) {
      if (now - entry.createdAt > ttlMs) {
        this.wavCache.delete(taskId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Phase 5.1 修复（P0-D）：重新生成语音。
   *
   * 关键变更（P0-D 硬门）：不再调用 ChatAdapter.submit(userText)，避免：
   * - 再次请求聊天 API
   * - 生成不同回复
   * - 重复触发记忆/RAG
   * - 用 userText 而非 assistantText 合成语音
   *
   * 新流程：调用 voiceAdapter.synthesize(assistantText) 只做 TTS 合成。
   * assistantText 从 wavCache 条目或历史 assistant 消息中获取，不允许使用 userText。
   */
  async regenerateAudio(taskId: string): Promise<AudioRegenerateResult> {
    // 必须先注入 voiceAdapter
    if (!this.voiceAdapter) {
      return {
        success: false, taskId, audioReady: false,
        audioError: 'no voiceAdapter available (call setVoiceAdapter first)'
      };
    }

    // 从 wavCache 或历史中查找 assistantText（禁止使用 userText）
    let assistantText: string | undefined;
    let assistantMsg = this.findAssistantMessageByTaskId(taskId);
    const cacheEntry = this.wavCache.get(taskId);
    if (cacheEntry) {
      assistantText = cacheEntry.assistantText;
      if (!assistantMsg) {
        assistantMsg = this.messages.find(m => m.id === cacheEntry.assistantMessageId);
      }
    } else if (assistantMsg) {
      assistantText = assistantMsg.text;
    }

    if (!assistantMsg) {
      return { success: false, taskId, audioReady: false, audioError: 'assistant message not found' };
    }
    if (!assistantText || assistantText.trim().length === 0) {
      return { success: false, taskId, audioReady: false, audioError: 'assistant text is empty' };
    }

    // P0-D 核心：调用 voiceAdapter.synthesize(assistantText)，不调用 ChatAdapter.submit(userText)
    let voiceResult: VoiceSynthesisResult;
    try {
      voiceResult = this.voiceAdapter.synthesizeDetailed
        ? await this.voiceAdapter.synthesizeDetailed(assistantText, undefined, { performance: assistantMsg.semantic })
        : { wavBytes: await this.voiceAdapter.synthesize(assistantText, undefined, { performance: assistantMsg.semantic }) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { success: false, taskId, audioReady: false, audioError: `voiceAdapter.synthesize failed: ${reason}` };
    }
    const wavBytes = voiceResult.wavBytes;
    const semantic = assistantMsg.semantic?.source === 'model'
      ? assistantMsg.semantic
      : (voiceResult.emotion
        ? derivePerformanceSemantic(assistantText, voiceResult.emotion)
        : assistantMsg.semantic);

    // 校验新 WAV
    let audioError: string | undefined;
    const wavResult = validateWav(wavBytes);
    if (!wavResult.valid) {
      audioError = `WAV validation failed: ${wavResult.reason}`;
      const updatedMessage: ConversationMessage = {
        ...assistantMsg,
        audioReady: false,
        audioError
      };
      this.replaceAssistantMessage(assistantMsg.id, updatedMessage);
      this.emit({ type: 'message-updated', message: updatedMessage, taskId });
      return { success: false, taskId, audioReady: false, audioError };
    }

    // 更新历史中的 assistant 消息
    const updatedMessage: ConversationMessage = {
      ...assistantMsg,
      audioReady: true,
      audioError: undefined,
      semantic
    };
    this.replaceAssistantMessage(assistantMsg.id, updatedMessage);

    // 更新 wavCache（保留或创建条目）
    this.wavCache.set(taskId, {
      taskId,
      wavBytes,
      assistantMessageId: assistantMsg.id,
      assistantText,
      createdAt: Date.now(),
      semantic
    });

    this.emit({ type: 'message-updated', message: updatedMessage, taskId });
    return { success: true, taskId, audioReady: true };
  }

  private replaceAssistantMessage(id: string, updated: ConversationMessage): void {
    const index = this.messages.findIndex(m => m.id === id);
    if (index >= 0) {
      this.messages[index] = updated;
    }
  }

  private findAssistantMessageByTaskId(taskId: string): ConversationMessage | undefined {
    return this.messages.find(m => m.role === 'assistant' && m.taskId === taskId);
  }

  private failActiveTask(task: ConversationJob, reason: string): void {
    if (!this.isActiveTask(task.taskId)) {
      return;
    }
    console.error('[conversation] adapter failed:', reason);
    this.appendSystemMessage(`错误：${reason}`);
    task.status = 'failed';
    task.finishedAt = Date.now();
    this.clearActiveTask(task.taskId);
    this.emit({ type: 'task-failed', taskId: task.taskId, reason });
  }

  private appendSystemMessage(text: string): void {
    const message: ConversationMessage = {
      id: this.generateMessageId(),
      role: 'system',
      text,
      source: 'controller',
      timestamp: Date.now(),
      isMock: false,
      audioReady: false
    };
    this.messages.push(message);
    this.emit({ type: 'message-added', message });
  }

  /**
   * 注入外部消息（Chat 页面通过 HTTP /api/chat 发送的消息）。
   * 不创建 task，不调用 adapter，只更新内存 + 广播 conversation:event。
   * Composer 收到后能实时看到 Chat 页面的消息，实现双向同步。
   * 消息已由 /api/chat 端点写入磁盘，此处不重复持久化。
   *
   * 返回 assistant 消息的 taskId，供调用方后续注入音频。
   */
  injectExternalMessage(payload: {
    userText: string;
    assistantText: string;
    performance?: PerformanceSemantic;
    userTimestamp?: number;
    assistantTimestamp?: number;
  }): { taskId: string; assistantMessageId: string } | null {
    if (typeof payload?.userText !== 'string' || typeof payload?.assistantText !== 'string') {
      return null;
    }
    const now = Date.now();
    const userTs = payload.userTimestamp ?? now;
    const assistantTs = payload.assistantTimestamp ?? now;

    const userMessage: ConversationMessage = {
      id: this.generateMessageId(),
      role: 'user',
      text: payload.userText,
      source: 'chat',
      timestamp: userTs,
      isMock: false,
      audioReady: false
    };
    this.messages.push(userMessage);
    this.emit({ type: 'message-added', message: userMessage });

    const taskId = this.generateTaskId();
    const assistantMessage: ConversationMessage = {
      id: this.generateMessageId(),
      role: 'assistant',
      text: payload.assistantText,
      source: 'chat',
      timestamp: assistantTs,
      isMock: false,
      audioReady: false,
      taskId,
      semantic: payload.performance
    };
    this.messages.push(assistantMessage);
    this.emit({ type: 'message-added', message: assistantMessage, taskId });

    return { taskId, assistantMessageId: assistantMessage.id };
  }

  /**
   * 为已注入的外部消息添加音频（异步生成）。
   * 调用方（主进程 IPC handler）在 TTS 合成完成后调用此方法。
   * 将 WAV 存入 wavCache，更新 assistant 消息的 audioReady 字段，
   * 并广播 message-updated 事件通知 Composer 触发 avatar:play。
   */
  injectExternalAudio(taskId: string, wavBytes: ArrayBuffer, semantic?: PerformanceSemantic): boolean {
    const assistantMsg = this.messages.find(
      m => m.role === 'assistant' && m.taskId === taskId
    );
    if (!assistantMsg) {
      console.warn('[conversation] injectExternalAudio: assistant message not found for taskId=', taskId);
      return false;
    }

    const wavResult = validateWav(wavBytes);
    if (!wavResult.valid) {
      console.warn('[conversation] injectExternalAudio: WAV validation failed:', wavResult.reason);
      // 更新消息为 audioError 状态
      const updatedMessage: ConversationMessage = {
        ...assistantMsg,
        audioReady: false,
        audioError: `WAV validation failed: ${wavResult.reason}`
      };
      this.replaceAssistantMessage(assistantMsg.id, updatedMessage);
      this.emit({ type: 'message-updated', message: updatedMessage, taskId });
      return false;
    }

    this.wavCache.set(taskId, {
      taskId,
      wavBytes,
      assistantMessageId: assistantMsg.id,
      assistantText: assistantMsg.text,
      createdAt: Date.now(),
      semantic
    });

    const updatedMessage: ConversationMessage = {
      ...assistantMsg,
      audioReady: true,
      audioError: undefined,
      semantic
    };
    this.replaceAssistantMessage(assistantMsg.id, updatedMessage);
    this.emit({ type: 'message-updated', message: updatedMessage, taskId });
    return true;
  }

  private clearActiveTask(taskId: string): void {
    if (this.activeTask?.taskId === taskId) {
      this.activeTask = null;
      this.activeAdapter = null;
    }
  }

  private isActiveTask(taskId: string): boolean {
    return this.activeTask?.taskId === taskId && this.activeTask.status === 'pending';
  }

  private generateMessageId(): string {
    this.messageIdCounter += 1;
    return `msg-${this.messageIdCounter}-${Date.now()}`;
  }

  private generateTaskId(): string {
    this.taskIdCounter += 1;
    return `task-${this.taskIdCounter}-${Date.now()}`;
  }

  private emit(event: ConversationEvent): void {
    this.eventBus.emit(event);
  }

  _testGetMessageCount(): number {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('_testGetMessageCount only available in test mode');
    }
    return this.messages.length;
  }

  _testGetActiveTask(): ConversationJob | null {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('_testGetActiveTask only available in test mode');
    }
    return this.activeTask;
  }

  _testGetWavCacheSize(): number {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('_testGetWavCacheSize only available in test mode');
    }
    return this.wavCache.size;
  }

  /**
   * Phase 5.1 修复（P1-F）：测试辅助方法，获取缓存条目的 createdAt（用于 TTL 测试）。
   */
  _testGetWavCacheCreatedAt(taskId: string): number | null {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('_testGetWavCacheCreatedAt only available in test mode');
    }
    return this.wavCache.get(taskId)?.createdAt ?? null;
  }

  /**
   * Phase 5.1 修复（P0-D）：测试辅助方法，检查 voiceAdapter 是否已注入。
   */
  _testHasVoiceAdapter(): boolean {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('_testHasVoiceAdapter only available in test mode');
    }
    return this.voiceAdapter !== null;
  }
}
