/**
 * 模型客户端抽象（adapters/llm）—— provider-agnostic（学 shiyun 的多厂商表），v1 两个实现：
 *   ReplayModel  —— 回放录制样本（测试/基准用：零成本、可重复；006 §3）
 *   DeepSeekModel —— 真实 API（OpenAI 兼容；P2 端到端时启用）
 *
 * 回放文件格式（JSONL）：每行一个 TurnRecord，按 (sessionId, turnIndex) 寻址。
 * 录制格式即回放格式——录制器在 DeepSeekModel 上包一层即可（P2 实现）。
 */
import type { TurnOutput } from '../core/session.ts';

export interface TurnRequest {
  readonly sessionId: string;
  readonly turnIndex: number;
  /** 组装好的上下文（消息数组形状由 provider 决定；回放模式下不校验内容）。 */
  readonly messages: readonly unknown[];
  readonly model: string;
}

export interface TurnRecord {
  readonly sessionId: string;
  readonly turnIndex: number;
  text?: string;
  toolStarts?: TurnOutput['toolStarts'];
  toolStops?: TurnOutput['toolStops'];
  /** 计量（meter.charge 事件的数据源）。 */
  tokensIn?: number;
  tokensOut?: number;
}

export interface ModelClient {
  /** 产出这一轮的模型输出。实现必须确定性（同输入同输出）。 */
  turn(req: TurnRequest): Promise<TurnOutput>;
}

/** 回放模型：从内存记录寻址；缺行 = 报错（回放完整性是硬约束，不静默 improvising）。 */
export class ReplayModel implements ModelClient {
  private readonly byKey = new Map<string, TurnRecord>();

  constructor(records: readonly TurnRecord[]) {
    for (const r of records) {
      this.byKey.set(replayKey(r.sessionId, r.turnIndex), r);
    }
  }

  async turn(req: TurnRequest): Promise<TurnRecord> {
    const rec = this.byKey.get(replayKey(req.sessionId, req.turnIndex));
    if (rec === undefined) {
      throw new Error(`[replay] 缺少回放记录: ${req.sessionId}#${req.turnIndex}（回放完整性失败，不静默编造）`);
    }
    // 返回记录本身（TurnRecord 是 TurnOutput 的超集；只读字段不复制）
    return rec;
  }

  has(sessionId: string, turnIndex: number): boolean {
    return this.byKey.has(replayKey(sessionId, turnIndex));
  }
}

function replayKey(sessionId: string, turnIndex: number): string {
  return `${sessionId}#${turnIndex}`;
}
