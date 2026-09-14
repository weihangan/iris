// Chat5Adapter：TypeScript Adapter 包裹 Chat5 JavaScript 兼容服务
// 职责：通过 HTTP 调用 chat5-compat/server.js（端口 3003，ChatX2 独立端口）
// B1 决策：复制源码，不复制运行数据和权重；B5 决策：默认 127.0.0.1:3003

export interface ConversationInput {
  text: string;
  characterId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ChatReply {
  success: boolean;
  reply?: string;
  emotion?: string;
  usage?: { total_tokens?: number };
  error?: string;
}

export interface HealthStatus {
  ok: boolean;
  tts: boolean;
  flavor?: string;
  owner?: string;
  error?: string;
}

export interface Chat5AdapterOptions {
  baseUrl?: string;
}

export class Chat5Adapter {
  readonly baseUrl: string;

  constructor(options: Chat5AdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:3003';
  }

  async submit(input: ConversationInput): Promise<ChatReply> {
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: input.text,
          charId: input.characterId,
          history: input.history
        })
      });
      const data = await response.json();
      return data as ChatReply;
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      // chat5-compat/server.js 使用 /api/runtime 作为运行时身份端点（非 /api/health）
      const response = await fetch(`${this.baseUrl}/api/runtime`);
      const data = await response.json();
      return {
        ok: Boolean(data.success),
        tts: false, // 兼容服务的 runtime 端点不暴露 TTS 状态；TTS 检测由调用方单独处理
        flavor: data.flavor,
        owner: data.owner
      };
    } catch (e) {
      return {
        ok: false,
        tts: false,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }
}
