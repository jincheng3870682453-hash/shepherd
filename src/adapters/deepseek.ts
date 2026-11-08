/**
 * DeepSeek 真实模型客户端（OpenAI 兼容接口）+ 录制器。
 *
 * 录制格式 = 回放格式（TurnRecord JSONL）：DeepSeekRecorder 包住任意 ModelClient，
 * 产出可直接喂 ReplayModel 的记录 —— 测试与基准的数据来自真实 API 会话（006 §3 流程纪律）。
 *
 * 网络：Node 24 内置 fetch，零第三方依赖。密钥从环境变量 DEEPSEEK_API_KEY 读，不落盘。
 */
import type { ModelClient, TurnRecord, TurnRequest } from './llm.ts';

export interface DeepSeekOptions {
  readonly apiKey?: string; // 缺省读 DEEPSEEK_API_KEY
  readonly baseUrl?: string; // 缺省 https://api.deepseek.com
  readonly model?: string; // 缺省 deepseek-chat
  readonly timeoutMs?: number;
}

interface ChatResponse {
  choices?: ReadonlyArray<{ message?: { content?: string; tool_calls?: ReadonlyArray<{ function?: { name?: string; arguments?: string } }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class DeepSeekModel implements ModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: DeepSeekOptions = {}) {
    const key = opts.apiKey ?? process.env['DEEPSEEK_API_KEY'];
    if (key === undefined || key === '') {
      throw new Error('[deepseek] DEEPSEEK_API_KEY 未设置（密钥不落盘，走环境变量）');
    }
    this.apiKey = key;
    this.baseUrl = opts.baseUrl ?? 'https://api.deepseek.com';
    this.model = opts.model ?? 'deepseek-chat';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async turn(req: TurnRequest): Promise<TurnRecord> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // 逻辑角色名（mock/router/worker/watchdog-cortex）→ 真实模型名（role-models 映射的简化版）
      const logical = new Set(['mock', 'router', 'worker', 'watchdog-cortex', 'assessor']);
      const modelName = logical.has(req.model) ? this.model : req.model;
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: modelName,
          messages: req.messages,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`[deepseek] HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as ChatResponse;
      const choice = data.choices?.[0]?.message;
      const text = choice?.content ?? '';
      const usage = data.usage;
      const rec: TurnRecord = { sessionId: req.sessionId, turnIndex: req.turnIndex };
      if (text !== '') rec.text = text;
      if (usage?.prompt_tokens !== undefined) rec.tokensIn = usage.prompt_tokens;
      if (usage?.completion_tokens !== undefined) rec.tokensOut = usage.completion_tokens;
      return rec;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 录制器：包住任何 ModelClient，把每轮输出存为可回放记录。 */
export class RecordingModel implements ModelClient {
  readonly records: TurnRecord[] = [];
  private readonly inner: ModelClient;

  constructor(inner: ModelClient) {
    this.inner = inner;
  }

  async turn(req: TurnRequest): Promise<TurnRecord> {
    const out = await this.inner.turn(req);
    const usage = out as unknown as { tokensIn?: number; tokensOut?: number };
    const rec: TurnRecord = { sessionId: req.sessionId, turnIndex: req.turnIndex };
    if (out.text !== undefined) rec.text = out.text;
    if (out.toolStarts !== undefined) rec.toolStarts = out.toolStarts;
    if (out.toolStops !== undefined) rec.toolStops = out.toolStops;
    // 计量透传（meter.charge 数据源——原实现漏了这两个字段）
    if (usage.tokensIn !== undefined) rec.tokensIn = usage.tokensIn;
    if (usage.tokensOut !== undefined) rec.tokensOut = usage.tokensOut;
    this.records.push(rec);
    const returned: TurnRecord = { sessionId: req.sessionId, turnIndex: req.turnIndex };
    if (out.text !== undefined) returned.text = out.text;
    if (out.toolStarts !== undefined) returned.toolStarts = out.toolStarts;
    if (out.toolStops !== undefined) returned.toolStops = out.toolStops;
    if (usage.tokensIn !== undefined) returned.tokensIn = usage.tokensIn;
    if (usage.tokensOut !== undefined) returned.tokensOut = usage.tokensOut;
    return returned;
  }

  /** 导出 JSONL（一行一 TurnRecord）。 */
  toLines(): string {
    return this.records.map(r => JSON.stringify(r)).join('\n');
  }
}
