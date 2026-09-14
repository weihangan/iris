import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationController } from '../../src/conversation/conversation-controller';
import { MockChatAdapter } from '../../src/conversation/mock-chat-adapter';
import { MockVoiceAdapter } from '../../src/conversation/mock-voice-adapter';
import { generateMockWav } from '../../src/conversation/mock-wav-generator';
import type {
  ConversationEvent,
  ChatAdapter,
  VoiceAdapter,
  AdapterResponse
} from '../../src/conversation/conversation-types';

// Phase 4 Task 3: ConversationController RED 测试
// 验证门禁：
// 1. Chat 提交后 Desktop 读取相同历史（共享历史）
// 2. Desktop 提交后返回 Chat 可看到完整记录（双向共享）
// 3. 同时只能有一个活动任务（pending 时拒绝新提交）
// 4. 取消后，迟到的 AI 回复不得写入历史（taskId 校验）
// 5. 不产生重复消息（ID 全局唯一）
// 6. 单例模式（getInstance 返回同一实例）
// 7. Mock Adapter 醒目标注 isMock=true

describe('ConversationController（Phase 4 Task 3）', () => {
  let controller: ConversationController;
  let mockAdapter: MockChatAdapter;
  let mockVoiceAdapter: MockVoiceAdapter;

  beforeEach(() => {
    // 测试模式：重置单例
    ConversationController.resetInstanceForTest();
    controller = ConversationController.getInstance();
    mockAdapter = new MockChatAdapter(50); // 50ms 延迟加速测试
    controller.setAdapter(mockAdapter);
    // Phase 5.1 修复（P0-D）：注入 MockVoiceAdapter 用于 regenerateAudio 测试
    mockVoiceAdapter = new MockVoiceAdapter(20); // 20ms 延迟加速测试
    controller.setVoiceAdapter(mockVoiceAdapter);
  });

  afterEach(() => {
    ConversationController.resetInstanceForTest();
  });

  describe('单例模式', () => {
    it('getInstance 返回同一实例', () => {
      const a = ConversationController.getInstance();
      const b = ConversationController.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstanceForTest 后返回新实例（仅测试模式）', () => {
      const a = ConversationController.getInstance();
      ConversationController.resetInstanceForTest();
      const b = ConversationController.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('TTS 表演语义元数据', () => {
    it('通过通用 VoiceAdapter 返回与 WAV 同次生成的实际情绪', async () => {
      const wavBytes = generateMockWav({ taskId: 'detailed-voice', userText: '普通回复内容' });
      controller.setVoiceAdapter({
        isMock: false,
        synthesize: async () => wavBytes,
        synthesizeDetailed: async () => ({ wavBytes, emotion: 'comfort', duration: 1.25 })
      } as VoiceAdapter & {
        synthesizeDetailed: () => Promise<{ wavBytes: ArrayBuffer; emotion: string; duration: number }>;
      });

      await expect(controller.synthesizeSpeechDetailed('普通回复内容')).resolves.toMatchObject({
        wavBytes,
        emotion: 'comfort',
        duration: 1.25
      });
    });

    it('重新生成语音后让缓存语义跟随新 WAV 的实际 TTS 情绪', async () => {
      const wavBytes = generateMockWav({ taskId: 'regen-emotion', userText: '普通回复内容' });
      controller.setAdapter({
        isMock: false,
        submit: async taskId => ({
          taskId,
          text: '普通回复内容',
          semantic: { emotion: 'serious', intent: 'explaining', intensity: 0.5, gaze: 'user' },
          audioError: 'initial TTS failed'
        })
      });
      controller.setVoiceAdapter({
        isMock: false,
        synthesize: async () => wavBytes,
        synthesizeDetailed: async () => ({ wavBytes, emotion: 'comfort' })
      } as VoiceAdapter & {
        synthesizeDetailed: () => Promise<{ wavBytes: ArrayBuffer; emotion: string }>;
      });

      const completion = waitForEvents(controller, ['task-completed']);
      const submitted = await controller.submit({ text: '测试', source: 'desktop' });
      await completion;
      const regenerated = await controller.regenerateAudio(submitted.taskId!);

      expect(regenerated.success).toBe(true);
      expect(controller.getWavSemantic(submitted.taskId!)).toMatchObject({
        emotion: 'concerned',
        intent: 'explaining',
        intensity: 0.45
      });
      const assistant = controller.getHistory().messages.find(message => message.taskId === submitted.taskId);
      expect(assistant?.semantic?.emotion).toBe('concerned');
    });
  });

  describe('Mock Adapter 醒目标注', () => {
    it('MockChatAdapter.isMock === true', () => {
      expect(mockAdapter.isMock).toBe(true);
    });

    it('Controller.isMockAdapter() 返回 true', () => {
      expect(controller.isMockAdapter()).toBe(true);
    });
  });

  describe('共享历史（Chat/Desktop 共用唯一历史）', () => {
    it('Chat 提交后 Desktop 读取相同历史', async () => {
      // Chat 窗口提交
      const result = await controller.submit({ text: '第一条', source: 'chat' });
      expect(result.accepted).toBe(true);

      // 等 Mock 回复
      await waitForEvents(controller, ['task-completed']);

      // Desktop 窗口读取历史
      const history = controller.getHistory();
      expect(history.messages.length).toBe(2); // user + assistant
      expect(history.messages[0].role).toBe('user');
      expect(history.messages[0].text).toBe('第一条');
      expect(history.messages[0].source).toBe('chat');
      expect(history.messages[1].role).toBe('assistant');
      expect(history.messages[1].isMock).toBe(true); // Mock 标注
    });

    it('Desktop 提交后返回 Chat 可看到完整记录', async () => {
      // Desktop 窗口提交
      const result = await controller.submit({ text: '第二条', source: 'desktop' });
      expect(result.accepted).toBe(true);

      await waitForEvents(controller, ['task-completed']);

      // Chat 窗口读取历史
      const history = controller.getHistory();
      expect(history.messages.length).toBe(2);
      expect(history.messages[0].text).toBe('第二条');
      expect(history.messages[0].source).toBe('desktop');
      expect(history.messages[1].role).toBe('assistant');
    });

    it('Chat 和 Desktop 交替提交后历史顺序正确', async () => {
      // 第一条来自 Chat
      await controller.submit({ text: '第一条', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      // 第二条来自 Desktop
      await controller.submit({ text: '第二条', source: 'desktop' });
      await waitForEvents(controller, ['task-completed']);

      const history = controller.getHistory();
      // 期望顺序：user1 / mock1 / user2 / mock2
      expect(history.messages.length).toBe(4);
      expect(history.messages[0].text).toBe('第一条');
      expect(history.messages[0].source).toBe('chat');
      expect(history.messages[1].role).toBe('assistant');
      expect(history.messages[2].text).toBe('第二条');
      expect(history.messages[2].source).toBe('desktop');
      expect(history.messages[3].role).toBe('assistant');
    });
  });

  describe('单活动任务（pending 时拒绝新提交）', () => {
    it('pending 时新提交被拒绝，reason=busy', async () => {
      // 第一次提交（pending）
      const r1 = await controller.submit({ text: '第一条', source: 'chat' });
      expect(r1.accepted).toBe(true);

      // Mock 延迟 50ms，立即再提交应被拒绝
      const r2 = await controller.submit({ text: '第二条', source: 'desktop' });
      expect(r2.accepted).toBe(false);
      expect(r2.reason).toBe('busy');

      // 等待第一次完成
      await waitForEvents(controller, ['task-completed']);

      // 完成后可以再次提交
      const r3 = await controller.submit({ text: '第三条', source: 'chat' });
      expect(r3.accepted).toBe(true);
    });

    it('空文本被拒绝，reason=empty-text', async () => {
      const r1 = await controller.submit({ text: '   ', source: 'chat' });
      expect(r1.accepted).toBe(false);
      expect(r1.reason).toBe('empty-text');
    });

    it('活动任务期间 getHistory().activeTask 反映 pending 状态', async () => {
      await controller.submit({ text: '测试', source: 'chat' });
      const history = controller.getHistory();
      expect(history.activeTask).not.toBeNull();
      expect(history.activeTask!.status).toBe('pending');
      expect(history.activeTask).toMatchObject({
        source: 'chat',
        inputText: '测试'
      });
    });

    it('活动任务期间拒绝替换 Adapter，避免取消和回复归属漂移', async () => {
      await controller.submit({ text: '测试', source: 'chat' });

      expect(() => controller.setAdapter(new MockChatAdapter(10))).toThrow(
        'Cannot replace adapter while a conversation task is pending'
      );
    });
  });

  describe('取消后迟到的 AI 回复不得写入历史', () => {
    it('取消后 Adapter 迟到回复被丢弃', async () => {
      // 提交任务（Mock 50ms 延迟）
      await controller.submit({ text: '将被取消', source: 'chat' });

      // 立即取消（在 Mock 延迟返回前）
      const cancelResult = controller.cancel();
      expect(cancelResult.cancelled).toBe(true);
      expect(cancelResult.taskId).toBeDefined();

      // 等 Mock 延迟结束（即使 Mock reject，也不应产生 assistant 消息）
      await new Promise(r => setTimeout(r, 100));

      const history = controller.getHistory();
      // 期望：只有 user 消息 + system 取消消息，无 assistant 消息
      expect(history.messages.length).toBe(2);
      expect(history.messages[0].role).toBe('user');
      expect(history.messages[0].text).toBe('将被取消');
      expect(history.messages[1].role).toBe('system');
      expect(history.messages[1].text).toBe('已取消');
      // 关键：无 assistant 消息
      const assistantMsgs = history.messages.filter(m => m.role === 'assistant');
      expect(assistantMsgs.length).toBe(0);
    });

    it('取消后活动任务清空（idle 状态）', async () => {
      await controller.submit({ text: '测试', source: 'chat' });
      controller.cancel();

      const history = controller.getHistory();
      expect(history.activeTask).toBeNull();
    });

    it('取消后可以立即提交新任务', async () => {
      await controller.submit({ text: '第一条', source: 'chat' });
      controller.cancel();

      // 立即提交新任务应被接受
      const r = await controller.submit({ text: '第二条', source: 'desktop' });
      expect(r.accepted).toBe(true);
    });

    it('无活动任务时取消返回 no-active-task', () => {
      const result = controller.cancel();
      expect(result.cancelled).toBe(false);
      expect(result.reason).toBe('no-active-task');
    });
  });

  describe('不产生重复消息', () => {
    it('所有消息 ID 全局唯一', async () => {
      await controller.submit({ text: '第一条', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      await controller.submit({ text: '第二条', source: 'desktop' });
      await waitForEvents(controller, ['task-completed']);

      const history = controller.getHistory();
      const ids = history.messages.map(m => m.id);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size); // 无重复
    });

    it('任务 ID 全局唯一', async () => {
      const r1 = await controller.submit({ text: '第一条', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);
      const r2 = await controller.submit({ text: '第二条', source: 'desktop' });
      await waitForEvents(controller, ['task-completed']);

      expect(r1.taskId).toBeDefined();
      expect(r2.taskId).toBeDefined();
      expect(r1.taskId).not.toBe(r2.taskId);
    });
  });

  describe('事件广播', () => {
    it('submit 触发 message-added（user）+ task-started + task-completed', async () => {
      const events: ConversationEvent[] = [];
      controller.on(e => events.push(e));

      await controller.submit({ text: '测试', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      // 期望事件顺序：message-added(user) → task-started → message-added(assistant) → task-completed
      const types = events.map(e => e.type);
      expect(types).toContain('message-added');
      expect(types).toContain('task-started');
      expect(types).toContain('task-completed');

      // 第一个 message-added 应该是 user 消息
      const firstMsgEvent = events.find(e => e.type === 'message-added');
      expect(firstMsgEvent?.message?.role).toBe('user');
    });

    it('cancel 触发 task-cancelled + message-added（system）', async () => {
      const events: ConversationEvent[] = [];
      controller.on(e => events.push(e));

      await controller.submit({ text: '测试', source: 'chat' });
      controller.cancel();

      const types = events.map(e => e.type);
      expect(types).toContain('task-cancelled');
      // system 消息
      const systemMsgEvent = events.find(
        e => e.type === 'message-added' && e.message?.role === 'system'
      );
      expect(systemMsgEvent).toBeDefined();
    });

    it('Adapter 失败触发 task-failed + system 错误消息', async () => {
      // 使用会失败的 Adapter
      const failingAdapter: ChatAdapter = {
        isMock: true,
        submit: (_taskId: string): Promise<AdapterResponse> =>
          Promise.reject(new Error('模拟失败'))
      };
      controller.setAdapter(failingAdapter);

      // 关键：在 submit 前注册 listener，否则 message-added 和 task-started 会错过
      const events: ConversationEvent[] = [];
      controller.on(e => events.push(e));

      const waitPromise = waitForEvents(controller, ['task-failed']);
      await controller.submit({ text: '测试', source: 'chat' });
      await waitPromise;

      const types = events.map(e => e.type);
      expect(types).toContain('task-failed');

      const errorMsg = events.find(
        e => e.type === 'message-added' && e.message?.role === 'system'
      );
      expect(errorMsg?.message?.text).toContain('模拟失败');
    });
  });

  describe('Adapter taskId 校验（防止迟到回复污染历史）', () => {
    it('Adapter 返回错误 taskId 时失败当前任务并恢复可提交状态', async () => {
      // 使用返回错误 taskId 的 Adapter
      const badAdapter: ChatAdapter = {
        isMock: true,
        submit: (taskId: string): Promise<AdapterResponse> =>
          new Promise(resolve => {
            setTimeout(() => {
              resolve({ taskId: 'wrong-task-id', text: '错误 taskId' });
            }, 10);
          })
      };
      controller.setAdapter(badAdapter);

      const events: ConversationEvent[] = [];
      controller.on(event => events.push(event));

      await controller.submit({ text: '测试', source: 'chat' });
      await new Promise(r => setTimeout(r, 50)); // 等延迟结束

      const history = controller.getHistory();
      const assistantMsgs = history.messages.filter(m => m.role === 'assistant');
      expect(assistantMsgs.length).toBe(0);
      expect(history.messages.at(-1)).toMatchObject({
        role: 'system',
        source: 'controller'
      });
      expect(history.messages.at(-1)?.text).toContain('taskId mismatch');
      expect(history.activeTask).toBeNull();
      expect(events.some(event => event.type === 'task-failed')).toBe(true);

      controller.setAdapter(new MockChatAdapter(10));
      const retry = await controller.submit({ text: '恢复后的消息', source: 'desktop' });
      expect(retry.accepted).toBe(true);
    });

    it('新任务提交后旧任务迟到回复被丢弃', async () => {
      // 使用可手动控制的 Adapter
      const oldResolveRef: { current: ((r: AdapterResponse) => void) | null } = { current: null };
      const slowAdapter: ChatAdapter = {
        isMock: true,
        submit: (taskId: string): Promise<AdapterResponse> =>
          new Promise(resolve => {
            oldResolveRef.current = resolve;
            // 不立即 resolve，等测试手动触发
            // taskId 用于日志（这里不使用，但保留参数）
            void taskId;
          })
      };
      controller.setAdapter(slowAdapter);

      // 提交旧任务（pending，永不自动完成）
      await controller.submit({ text: '旧任务', source: 'chat' });

      // 旧任务 pending，无法直接提交新任务（busy）
      // 但可以通过取消来结束旧任务，再提交新任务
      controller.cancel();

      // 切换到 Mock Adapter 提交新任务
      controller.setAdapter(new MockChatAdapter(10));
      const r2 = await controller.submit({ text: '新任务', source: 'desktop' });
      expect(r2.accepted).toBe(true);
      await waitForEvents(controller, ['task-completed']);

      // 现在手动 resolve 旧任务（模拟迟到回复）
      if (oldResolveRef.current) {
        oldResolveRef.current({ taskId: 'old-task-id-will-mismatch', text: '迟到回复' });
      }
      await new Promise(r => setTimeout(r, 50));

      const history = controller.getHistory();
      // 期望：user(旧任务) + system(取消) + user(新任务) + assistant(新任务 mock)
      // 不应有旧任务的 assistant 消息
      const texts = history.messages.map(m => m.text);
      expect(texts).not.toContain('迟到回复');
    });
  });

  describe('Phase 5.1：音频优先硬门（audioReady + WAV 校验）', () => {
    it('成功提交后 assistant 消息 audioReady=true', async () => {
      await controller.submit({ text: '测试音频', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      const history = controller.getHistory();
      const assistant = history.messages.find(m => m.role === 'assistant');
      expect(assistant).toBeDefined();
      expect(assistant!.audioReady).toBe(true);
    });

    it('user/system 消息 audioReady=false', async () => {
      await controller.submit({ text: '测试', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      const history = controller.getHistory();
      const user = history.messages.find(m => m.role === 'user');
      expect(user!.audioReady).toBe(false);
    });

    it('message-added(assistant) 事件附带 taskId', async () => {
      const events: ConversationEvent[] = [];
      controller.on(e => events.push(e));

      const submitResult = await controller.submit({ text: '测试 taskId', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      const assistantEvent = events.find(
        e => e.type === 'message-added' && e.message?.role === 'assistant'
      );
      expect(assistantEvent).toBeDefined();
      expect(assistantEvent!.taskId).toBe(submitResult.taskId);
    });

    it('getWavBytes(taskId) 返回缓存的 WAV 字节（通过校验）', async () => {
      const result = await controller.submit({ text: '获取 wav', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      const wavBytes = controller.getWavBytes(result.taskId!);
      expect(wavBytes).not.toBeNull();
      expect(wavBytes).toBeInstanceOf(ArrayBuffer);
      expect(wavBytes!.byteLength).toBeGreaterThan(44);
    });

    it('getWavBytes(未知 taskId) 返回 null', async () => {
      await controller.submit({ text: '测试', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      expect(controller.getWavBytes('nonexistent-task-id')).toBeNull();
    });

    it('新任务提交后保留旧 wavCache（P0-3 修复：不再在新任务提交时清空）', async () => {
      const r1 = await controller.submit({ text: '第一条', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);
      expect(controller.getWavBytes(r1.taskId!)).not.toBeNull();

      // 提交新任务，旧缓存保留（等播放会话结束/失败后由 releaseWav 清理）
      const r2 = await controller.submit({ text: '第二条', source: 'desktop' });
      await waitForEvents(controller, ['task-completed']);

      // 旧 taskId 的 wavBytes 仍可用（P0-3 修复：不再清空）
      expect(controller.getWavBytes(r1.taskId!)).not.toBeNull();
      // 新 taskId 的 wavBytes 也可用
      expect(controller.getWavBytes(r2.taskId!)).not.toBeNull();
    });

    it('getWavBytes 返回副本，修改不影响主进程缓存', async () => {
      const result = await controller.submit({ text: '副本测试', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      const a = controller.getWavBytes(result.taskId!);
      const b = controller.getWavBytes(result.taskId!);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      // 不同实例（slice(0) 副本）
      expect(a).not.toBe(b);

      // 修改 a 不影响 b
      const aView = new Uint8Array(a!);
      const originalByte = aView[44]; // 第一个 PCM 样本字节
      aView[44] = 0xFF;
      const bView = new Uint8Array(b!);
      expect(bView[44]).toBe(originalByte);
    });

    it('Phase 5.1 修复（P0-1）：Adapter 缺失 wavBytes → task-completed，assistant 正文保留 audioReady=false', async () => {
      const noWavAdapter: ChatAdapter = {
        isMock: true,
        submit: (taskId: string): Promise<AdapterResponse> =>
          Promise.resolve({ taskId, text: '无音频回复' })
      };
      controller.setAdapter(noWavAdapter);

      const events: ConversationEvent[] = [];
      controller.on(e => events.push(e));

      const waitPromise = waitForEvents(controller, ['task-completed']);
      await controller.submit({ text: '测试无音频', source: 'chat' });
      await waitPromise;

      const history = controller.getHistory();
      // P0-1 修复：assistant 消息必须保留（项目硬规则：TTS 失败保留文字）
      const assistantMsgs = history.messages.filter(m => m.role === 'assistant');
      expect(assistantMsgs.length).toBe(1);
      expect(assistantMsgs[0].text).toBe('无音频回复');
      expect(assistantMsgs[0].audioReady).toBe(false);
      expect(assistantMsgs[0].audioError).toContain('wavBytes');
      expect(assistantMsgs[0].taskId).toBeDefined();

      // task-completed（非 task-failed）：文本回复有效，仅音频失败
      expect(events.some(e => e.type === 'task-completed')).toBe(true);
      expect(events.some(e => e.type === 'task-failed')).toBe(false);

      // audioReady=false 时 wavCache 不应有该 taskId 的条目
      expect(controller.getWavBytes(assistantMsgs[0].taskId!)).toBeNull();
    });

    it('Phase 5.1 修复（P0-1）：Adapter 返回无效 WAV → task-completed，assistant 正文保留 audioReady=false', async () => {
      const badWavAdapter: ChatAdapter = {
        isMock: true,
        submit: (taskId: string): Promise<AdapterResponse> => {
          const badBytes = new ArrayBuffer(100); // 全零，非合法 WAV
          return Promise.resolve({ taskId, text: '坏音频', wavBytes: badBytes });
        }
      };
      controller.setAdapter(badWavAdapter);

      const events: ConversationEvent[] = [];
      controller.on(e => events.push(e));

      const waitPromise = waitForEvents(controller, ['task-completed']);
      await controller.submit({ text: '测试坏音频', source: 'chat' });
      await waitPromise;

      const history = controller.getHistory();
      // P0-1 修复：assistant 消息必须保留
      const assistantMsgs = history.messages.filter(m => m.role === 'assistant');
      expect(assistantMsgs.length).toBe(1);
      expect(assistantMsgs[0].text).toBe('坏音频');
      expect(assistantMsgs[0].audioReady).toBe(false);
      expect(assistantMsgs[0].audioError).toContain('WAV validation failed');
      expect(assistantMsgs[0].taskId).toBeDefined();

      // task-completed（非 task-failed）
      expect(events.some(e => e.type === 'task-completed')).toBe(true);
      expect(events.some(e => e.type === 'task-failed')).toBe(false);

      // audioReady=false 时 wavCache 不应有该 taskId 的条目
      expect(controller.getWavBytes(assistantMsgs[0].taskId!)).toBeNull();
    });

    it('_testGetWavCacheSize 反映缓存条目数（P0-3 修复：新任务不清空旧缓存）', async () => {
      expect(controller._testGetWavCacheSize()).toBe(0);

      const r1 = await controller.submit({ text: '第一条', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);
      expect(controller._testGetWavCacheSize()).toBe(1);

      // P0-3 修复：新任务不清空旧缓存，缓存条目累加
      await controller.submit({ text: '第二条', source: 'desktop' });
      await waitForEvents(controller, ['task-completed']);
      expect(controller._testGetWavCacheSize()).toBe(2);

      // 旧 taskId 仍在缓存（直到 renderer 调用 releaseWav）
      expect(controller.getWavBytes(r1.taskId!)).not.toBeNull();
    });

    it('Phase 5.1 修复（P0-3）：releaseWav(taskId) 释放对应缓存条目', async () => {
      const r1 = await controller.submit({ text: '第一条', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);
      const r2 = await controller.submit({ text: '第二条', source: 'desktop' });
      await waitForEvents(controller, ['task-completed']);
      expect(controller._testGetWavCacheSize()).toBe(2);

      // 释放 r1 的缓存条目（模拟 renderer 通知播放结束）
      controller.releaseWav(r1.taskId!);
      expect(controller._testGetWavCacheSize()).toBe(1);
      expect(controller.getWavBytes(r1.taskId!)).toBeNull();
      expect(controller.getWavBytes(r2.taskId!)).not.toBeNull();

      // 释放 r2 的缓存条目
      controller.releaseWav(r2.taskId!);
      expect(controller._testGetWavCacheSize()).toBe(0);
    });

    it('Phase 5.1 修复（P0-D）：regenerateAudio 成功后 emit message-updated，audioReady=true', async () => {
      // 使用先返回无 WAV 的 ChatAdapter（模拟首次 TTS 失败）
      const noWavAdapter: ChatAdapter = {
        isMock: true,
        submit: (taskId: string): Promise<AdapterResponse> =>
          Promise.resolve({ taskId, text: '需要重新生成的回复' })
      };
      controller.setAdapter(noWavAdapter);

      const events: ConversationEvent[] = [];
      controller.on(e => events.push(e));

      // 关键：在 submit 前注册 waitForEvents，否则同步 resolve 的 adapter 会错过事件
      const waitPromise = waitForEvents(controller, ['task-completed']);
      await controller.submit({ text: '触发失败', source: 'chat' });
      await waitPromise;

      // 第一次提交：audioReady=false
      const history1 = controller.getHistory();
      const assistant1 = history1.messages.find(m => m.role === 'assistant')!;
      expect(assistant1.audioReady).toBe(false);
      expect(assistant1.audioError).toContain('wavBytes');
      const taskId = assistant1.taskId!;

      // 重新生成语音：调用 voiceAdapter.synthesize(assistantText)，不调用 ChatAdapter.submit(userText)
      const regenResult = await controller.regenerateAudio(taskId);
      expect(regenResult.success).toBe(true);
      expect(regenResult.audioReady).toBe(true);
      expect(regenResult.audioError).toBeUndefined();

      // message-updated 事件应被触发
      const updateEvent = events.find(e => e.type === 'message-updated' && e.taskId === taskId);
      expect(updateEvent).toBeDefined();
      expect(updateEvent!.message!.audioReady).toBe(true);
      expect(updateEvent!.message!.audioError).toBeUndefined();

      // 历史中的 assistant 消息应已更新
      const history2 = controller.getHistory();
      const assistant2 = history2.messages.find(m => m.id === assistant1.id)!;
      expect(assistant2.audioReady).toBe(true);
      expect(assistant2.audioError).toBeUndefined();

      // 重新生成后 wavCache 应有该 taskId 的条目
      expect(controller.getWavBytes(taskId)).not.toBeNull();
    });

    it('Phase 5.1 修复（P0-D）：regenerateAudio 调用 voiceAdapter.synthesize，不调用 ChatAdapter.submit', async () => {
      // ChatAdapter.submit 调用计数器（绝不能被 regenerateAudio 调用）
      let chatSubmitCallCount = 0;
      const trackingAdapter: ChatAdapter = {
        isMock: true,
        submit: (taskId: string): Promise<AdapterResponse> => {
          chatSubmitCallCount++;
          return Promise.resolve({ taskId, text: '原始回复正文' });
        }
      };
      controller.setAdapter(trackingAdapter);

      // voiceAdapter.synthesize 调用计数器
      let voiceSynthesizeCallCount = 0;
      let capturedAssistantText: string | null = null;
      const trackingVoiceAdapter: VoiceAdapter = {
        isMock: true,
        synthesize: (assistantText: string): Promise<ArrayBuffer> => {
          voiceSynthesizeCallCount++;
          capturedAssistantText = assistantText;
          return Promise.resolve(generateMockWav({ taskId: 'voice-test', userText: assistantText }));
        }
      };
      controller.setVoiceAdapter(trackingVoiceAdapter);

      // 首次提交：ChatAdapter.submit 被调用 1 次（生成原始回复，无 WAV）
      // 关键：在 submit 前注册 waitForEvents，否则同步 resolve 的 adapter 会错过事件
      const waitPromise = waitForEvents(controller, ['task-completed']);
      await controller.submit({ text: '用户输入文本', source: 'chat' });
      await waitPromise;
      expect(chatSubmitCallCount).toBe(1);

      const history = controller.getHistory();
      const assistant = history.messages.find(m => m.role === 'assistant')!;
      const taskId = assistant.taskId!;
      const originalAssistantText = assistant.text;

      // 重新生成语音
      const regenResult = await controller.regenerateAudio(taskId);
      expect(regenResult.success).toBe(true);

      // 关键断言（P0-D 硬门）：
      // 1. ChatAdapter.submit 没有被再次调用（仍是 1）
      expect(chatSubmitCallCount).toBe(1);
      // 2. voiceAdapter.synthesize 被调用 1 次
      expect(voiceSynthesizeCallCount).toBe(1);
      // 3. synthesize 接收的是 assistant 正文，不是 userText
      expect(capturedAssistantText).toBe(originalAssistantText);
      expect(capturedAssistantText).not.toBe('用户输入文本');
    });

    it('重新生成语音后保留已授权的表演语义', async () => {
      const semantic = {
        state: 'speaking' as const,
        emotion: 'shy' as const,
        intent: 'affectionate',
        intensity: 0.55,
        gaze: 'side-down' as const,
        gestureFamily: 'open_hand_small'
      };
      controller.setAdapter({
        isMock: false,
        submit: (taskId: string): Promise<AdapterResponse> => Promise.resolve({
          taskId,
          text: '我会一直陪着你。',
          semantic,
          audioError: 'TTS_NOT_RUNNING'
        })
      });

      const waitPromise = waitForEvents(controller, ['task-completed']);
      const submitted = await controller.submit({ text: '陪陪我', source: 'desktop' });
      await waitPromise;
      expect(controller.getWavSemantic(submitted.taskId!)).toBeNull();

      const regenerated = await controller.regenerateAudio(submitted.taskId!);
      expect(regenerated.success).toBe(true);
      expect(controller.getWavSemantic(submitted.taskId!)).toEqual(semantic);
    });

    it('Phase 5.1 修复（P0-D）：regenerateAudio 对未知 taskId 返回失败', async () => {
      const result = await controller.regenerateAudio('nonexistent-task-id');
      expect(result.success).toBe(false);
      expect(result.audioReady).toBe(false);
      expect(result.audioError).toContain('not found');
    });

    it('Phase 5.1 修复（P0-D）：未注入 voiceAdapter 时 regenerateAudio 返回失败', async () => {
      // 创建一个没有注入 voiceAdapter 的 controller
      ConversationController.resetInstanceForTest();
      const controllerNoVoice = ConversationController.getInstance();
      controllerNoVoice.setAdapter(new MockChatAdapter(10));

      const result = await controllerNoVoice.regenerateAudio('any-task-id');
      expect(result.success).toBe(false);
      expect(result.audioReady).toBe(false);
      expect(result.audioError).toContain('no voiceAdapter available');

      expect(controllerNoVoice._testHasVoiceAdapter()).toBe(false);
    });

    it('Phase 5.1 修复（P0-D）：_testHasVoiceAdapter 反映 voiceAdapter 注入状态', () => {
      expect(controller._testHasVoiceAdapter()).toBe(true);
      expect(controller.isMockVoiceAdapter()).toBe(true);
    });

    it('Phase 5.1 修复（P1-F）：cleanupExpiredWav 清理过期条目，保留未过期条目', async () => {
      const r1 = await controller.submit({ text: '第一条', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);
      const r2 = await controller.submit({ text: '第二条', source: 'desktop' });
      await waitForEvents(controller, ['task-completed']);
      expect(controller._testGetWavCacheSize()).toBe(2);

      // 记录 r1 的 createdAt
      const r1CreatedAt = controller._testGetWavCacheCreatedAt(r1.taskId!);
      expect(r1CreatedAt).not.toBeNull();

      // 模拟时间前进：r1 已过期（createdAt - 1 ms before TTL），r2 未过期
      const TTL = 5 * 60 * 1000; // 5 分钟（与默认值一致）
      const now1 = r1CreatedAt! + TTL + 1; // r1 过期
      const removed1 = controller.cleanupExpiredWav(now1, TTL);
      expect(removed1).toBe(1);
      expect(controller._testGetWavCacheSize()).toBe(1);
      expect(controller.getWavBytes(r1.taskId!)).toBeNull(); // r1 已清理
      expect(controller.getWavBytes(r2.taskId!)).not.toBeNull(); // r2 保留

      // 再前进时间，r2 也过期
      const r2CreatedAt = controller._testGetWavCacheCreatedAt(r2.taskId!);
      const now2 = r2CreatedAt! + TTL + 1;
      const removed2 = controller.cleanupExpiredWav(now2, TTL);
      expect(removed2).toBe(1);
      expect(controller._testGetWavCacheSize()).toBe(0);
    });

    it('Phase 5.1 修复（P1-F）：cleanupExpiredWav 在无过期条目时返回 0', async () => {
      await controller.submit({ text: '第一条', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      // 立即清理（无过期）
      const removed = controller.cleanupExpiredWav();
      expect(removed).toBe(0);
      expect(controller._testGetWavCacheSize()).toBe(1);
    });

    it('Phase 5.1 修复（P1-F）：releaseAllWav 清空所有缓存条目', async () => {
      await controller.submit({ text: '第一条', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);
      await controller.submit({ text: '第二条', source: 'desktop' });
      await waitForEvents(controller, ['task-completed']);
      expect(controller._testGetWavCacheSize()).toBe(2);

      controller.releaseAllWav();
      expect(controller._testGetWavCacheSize()).toBe(0);
    });

    it('Phase 5.1 修复（P1-F）：cleanupExpiredWav 支持自定义 TTL', async () => {
      const r1 = await controller.submit({ text: '第一条', source: 'chat' });
      await waitForEvents(controller, ['task-completed']);

      // 自定义短 TTL=1000ms，模拟 1001ms 后清理
      const r1CreatedAt = controller._testGetWavCacheCreatedAt(r1.taskId!);
      const removed = controller.cleanupExpiredWav(r1CreatedAt! + 1001, 1000);
      expect(removed).toBe(1);
      expect(controller._testGetWavCacheSize()).toBe(0);
    });
  });
});

/**
 * 等待 Controller 触发指定事件类型
 * 用于异步测试同步
 */
function waitForEvents(
  controller: ConversationController,
  expectedTypes: string[],
  timeoutMs = 1000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const seen = new Set<string>();
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timeout waiting for events: ${expectedTypes.join(', ')}. Seen: ${[...seen].join(', ')}`));
    }, timeoutMs);

    const unsubscribe = controller.on(event => {
      seen.add(event.type);
      const allSeen = expectedTypes.every(t => seen.has(t));
      if (allSeen) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}
