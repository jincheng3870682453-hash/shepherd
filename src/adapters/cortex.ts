/**
 * 皮层会话（adapters/watchdog）—— Watchdog 的模型判断层（docs/003 §4）。
 *
 * ADR-002 不变式的实现点：
 *   - 输入：强类型 TelemetrySignals + Mandate 一行 + 近 8 次 observed 差分——
 *     schema 外字段直接丢弃（强类型校验在这里，LLM 看不到任何自由文本）；
 *   - 输出：三值 + 50 字内证据摘要；摘要只进审计链（给人看），
 *     永不回流为任何 LLM 输入。
 * 使用 DeepSeekModel（chat 档）；prompt 内嵌硬约束（只许输出枚举）。
 */
import type { TelemetrySignals } from '../core/events.ts';
import type { ModelClient, TurnRequest } from './llm.ts';

export interface CortexInput {
  readonly sessionId: string;
  readonly signals: TelemetrySignals;
  /** 该 Ticket 的 Mandate 目标（一行，结构化字段——非自由文本对话）。 */
  readonly mandate: string;
  /** 最近 8 次 observed 的信号差分（数字）。 */
  readonly history: ReadonlyArray<TelemetrySignals>;
}

export interface CortexOutput {
  readonly verdict: 'healthy' | 'drifting' | 'spinning';
  readonly evidence: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

const SCHEMA_FIELDS = [
  'reportGapMs', 'sameErrorStreak', 'fileEditRepeat', 'tokenSlope',
  'hoohDenyStreak', 'turnNoToolStreak', 'handleOrphans',
] as const;

/** 强类型化：丢弃 schema 外一切字段（ADR-002 收口）。 */
export function sanitizeSignals(signals: Record<string, unknown>): TelemetrySignals {
  const rec: Record<string, number> = {};
  for (const f of SCHEMA_FIELDS) {
    const v = signals[f];
    rec[f] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }
  return rec as unknown as TelemetrySignals;
}

export class CortexSession {
  private readonly model: ModelClient;
  private readonly modelName: string;

  constructor(model: ModelClient, modelName: string = 'watchdog-cortex') {
    this.model = model;
    this.modelName = modelName;
  }

  /** 三值判断。模型输出解析失败 → fail-close 返回 healthy+标注（皮层失能不放咬）。 */
  async judge(input: CortexInput): Promise<CortexOutput> {
    const clean = sanitizeSignals(input.signals as unknown as Record<string, unknown>);
    const historyClean = input.history.slice(-8).map(h => sanitizeSignals(h as unknown as Record<string, unknown>));
    const prompt = [
      '# Role',
      'You are a watchdog cortex. Judge ONE worker session from structured telemetry only.',
      '# Input schema (all numeric)',
      JSON.stringify(Object.keys(clean)),
      '# Current signals',
      JSON.stringify(clean),
      '# Recent history (oldest first)',
      JSON.stringify(historyClean),
      '# Task goal (one line)',
      input.mandate,
      '# Verdict rules',
      '- spinning: repeated identical failures, zero substantive progress, thrashing edits',
      '- drifting: steps succeed but output diverges from the goal',
      '- healthy: progress consistent with the goal (long silence alone is NOT spinning)',
      '# Output format (STRICT)',
      'VERDICT: healthy|drifting|spinning',
      'EVIDENCE: <one line, max 50 words, cite numbers>',
    ].join('\n');

    const req: TurnRequest = {
      sessionId: `cortex-${input.sessionId}`,
      turnIndex: 0,
      messages: [{ role: 'user', content: prompt }],
      model: this.modelName,
    };
    try {
      const out = await this.model.turn(req);
      const text = out.text ?? '';
      const m = /VERDICT:\s*(healthy|drifting|spinning)/i.exec(text);
      const verdict = (m?.[1]?.toLowerCase() ?? 'healthy') as CortexOutput['verdict'];
      const ev = /EVIDENCE:\s*(.+)/i.exec(text)?.[1]?.slice(0, 300) ?? '';
      const rec = out as unknown as { tokensIn?: number; tokensOut?: number };
      const result: CortexOutput = {
        verdict,
        evidence: ev,
        tokensIn: rec.tokensIn ?? 0,
        tokensOut: rec.tokensOut ?? 0,
      };
      return result;
    } catch (e) {
      // 皮层失能 → fail-close：healthy（不放咬）+ 失能标注进证据
      return { verdict: 'healthy', evidence: `cortex unavailable: ${String(e).slice(0, 100)}`, tokensIn: 0, tokensOut: 0 };
    }
  }
}
