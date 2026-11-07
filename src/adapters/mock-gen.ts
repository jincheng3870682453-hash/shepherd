/**
 * mock-gen 模拟源 —— S1 基线剧本生成器（adapters，docs/005 §2、docs/006 §3）。
 *
 * 剧本 = 触发器序列（消息/请求/噪音）+ 判分断言。无断言剧本不许进基准（910 §6）。
 * 事件全部经总线（source.trigger.received + 自然键），与真实 GitHub 源同一入口。
 */
import type { BusLike } from '../apps/runner.ts';

export interface ScriptMessage {
  readonly kind: 'request' | 'comment' | 'noise';
  readonly thread: string;
  readonly text: string;
}

export interface ScriptAssertion {
  /** 预期受理的请求数。 */
  readonly expectedAccepted: number;
  /** 预期完成的请求数（S1 全部完成）。 */
  readonly expectedDelivered: number;
  /** 预期被拒/过滤数。 */
  readonly expectedFiltered: number;
}

export interface Script {
  readonly name: string;
  readonly messages: readonly ScriptMessage[];
  readonly assertions: ScriptAssertion;
}

/** S1 基线剧本：对齐上游实验规模比例（300 消息/20 请求 → 1:15；此处缩放 1:10）。 */
export function s1Baseline(): Script {
  const messages: ScriptMessage[] = [];
  // 20 个请求（各自独立 Thread），穿插 200 条噪音（噪音走自己的 Thread：
  // 与请求同 Thread 会被订阅直通并入在办 Ticket —— 直通机制的正确行为）
  for (let i = 0; i < 20; i++) {
    messages.push({ kind: 'request', thread: `mock:req-${i}`, text: `任务${i}：实现并验证功能块 ${i}` });
    for (let j = 0; j < 10; j++) {
      messages.push({ kind: 'noise', thread: `mock:noise-${i}-${j}`, text: `闲聊 ${i}-${j}：今天天气不错` });
    }
  }
  return {
    name: 'S1-baseline',
    messages,
    assertions: { expectedAccepted: 20, expectedDelivered: 20, expectedFiltered: 0 },
  };
}

/** 播放剧本：所有 Trigger 入总线（真实源同路径）。返回 trigger seq/id 列表。 */
export function playScript(bus: BusLike, script: Script): Array<{ seq: number; id: string; msg: ScriptMessage }> {
  const out: Array<{ seq: number; id: string; msg: ScriptMessage }> = [];
  script.messages.forEach((msg, i) => {
    const naturalKey = `mock:${script.name}:${i}`;
    const r = bus.append(
      bus.root('source.trigger.received', 'mock-gen', { naturalKey, thread: msg.thread, kind: msg.kind, text: msg.text }, `trg_${script.name}_${i}`),
      naturalKey,
    );
    if (r.kind === 'stored') {
      out.push({ seq: r.event.seq, id: r.event.id, msg });
    }
    // duplicate 不重播（幂等铁律的天然表现）
  });
  return out;
}
