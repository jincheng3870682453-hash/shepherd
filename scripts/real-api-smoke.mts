/**
 * 真实 DeepSeek API 冒烟（P6 后续②）—— 机制在真模型下的最小验证 + 录制可回放样本。
 *
 * 验证面：
 *   1. CortexSession 三值判断（spinning 遥测 → 应判 spinning）
 *   2. Router 受理评估三态（任务→ACCEPT / 闲聊→REJECT / 模糊短句→CLARIFY）
 *   3. 全部轮次经 RecordingModel 录制为 TurnRecord JSONL（录制=回放格式，
 *      后续 ReplayModel 可直接回放——006 §3 流程纪律）
 *
 * 成本控制：共 4 次调用、max_tokens 受控；只报告 token 不计算价格（单价随官方调价）。
 * 密钥只读环境变量 DEEPSEEK_API_KEY，绝不落盘（005 §2 红线）。
 * 运行：DEEPSEEK_API_KEY=... node --experimental-strip-types scripts/real-api-smoke.mts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeepSeekModel, RecordingModel } from '../src/adapters/deepseek.ts';
import { CortexSession } from '../src/adapters/cortex.ts';
import type { TelemetrySignals } from '../src/core/events.ts';
import type { TurnRecord } from '../src/adapters/llm.ts';

const apiKey = process.env['DEEPSEEK_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  console.error('[real-api] DEEPSEEK_API_KEY 未设置');
  process.exit(1);
}

const recorder = new RecordingModel(new DeepSeekModel());
const cortex = new CortexSession(recorder);
const results: Array<{ check: string; ok: boolean; detail: string }> = [];
const t0 = Date.now();

// ── 1. 皮层三值判断：spinning 遥测 ─────────────────────────────────────
const spinning: TelemetrySignals = {
  reportGapMs: 1_800_000, sameErrorStreak: 5, fileEditRepeat: 2,
  tokenSlope: 800, hoohDenyStreak: 0, turnNoToolStreak: 0, handleOrphans: 0,
};
const cortexOut = await cortex.judge({
  sessionId: 'real-smoke',
  signals: spinning,
  mandate: '修复登录页面的空指针崩溃，并让回归测试全绿',
  history: [
    { ...spinning, sameErrorStreak: 1 },
    { ...spinning, sameErrorStreak: 3 },
  ],
});
console.log(`[1] 皮层判断: ${cortexOut.verdict} | evidence: ${cortexOut.evidence.slice(0, 80)}`);
results.push({ check: 'cortex-spinning', ok: cortexOut.verdict === 'spinning', detail: cortexOut.evidence.slice(0, 100) });

// ── 2. 受理评估三态（真实模型） ───────────────────────────────────────
async function assess(text: string, from: string): Promise<{ decision: string; reason: string }> {
  const req = {
    sessionId: `assess-${from}`,
    turnIndex: 0,
    messages: [
      {
        role: 'user' as const,
        content: [
          '# Role',
          'You are the intake assessor of a coding agent. Decide whether this message is a work request for the agent.',
          '# Rules',
          '- ACCEPT: a concrete task the agent should do (fix/implement/review etc.)',
          '- REJECT: chit-chat, noise, irrelevant, or not addressed to the agent',
          '- CLARIFY: looks like a request but too ambiguous to act on',
          '# Output (STRICT, one line)',
          'DECISION: ACCEPT|REJECT|CLARIFY',
          'REASON: <short>',
          '# Message',
          `from: ${from}`,
          text,
        ].join('\n'),
      },
    ],
    model: 'deepseek-chat',
  };
  const out = await recorder.turn(req);
  const m = /DECISION:\s*(ACCEPT|REJECT|CLARIFY)/i.exec(out.text ?? '');
  const decision = (m?.[1] ?? 'UNKNOWN').toUpperCase();
  const reason = /REASON:\s*(.+)/i.exec(out.text ?? '')?.[1]?.slice(0, 80) ?? '';
  return { decision, reason };
}

const a1 = await assess('登录页点击提交按钮后白屏，控制台报 Cannot read properties of undefined，请修复并补回归测试', 'alice');
console.log(`[2] 任务: ${a1.decision} (${a1.reason})`);
results.push({ check: 'assess-task-accept', ok: a1.decision === 'ACCEPT', detail: a1.reason });

const a2 = await assess('今天杭州天气不错，中午吃什么好呢', 'bob');
console.log(`[3] 闲聊: ${a2.decision} (${a2.reason})`);
results.push({ check: 'assess-noise-reject', ok: a2.decision === 'REJECT', detail: a2.reason });

const a3 = await assess('那个东西不太对', 'carol');
console.log(`[4] 模糊: ${a3.decision} (${a3.reason})`);
results.push({ check: 'assess-ambiguous-clarify', ok: a3.decision === 'CLARIFY', detail: a3.reason });

// ── 3. 录制落盘（可回放样本） ─────────────────────────────────────────
const totalMs = Date.now() - t0;
const tokensIn = recorder.records.reduce((s, r: TurnRecord) => s + (r.tokensIn ?? 0), 0);
const tokensOut = recorder.records.reduce((s, r: TurnRecord) => s + (r.tokensOut ?? 0), 0);
const outDir = join(process.cwd(), 'docs', 'recordings');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(outDir, `real-api-smoke-${stamp}.jsonl`);
writeFileSync(file, recorder.toLines() + '\n', 'utf-8');

console.log('---');
console.log(`[summary] calls=${recorder.records.length} tokensIn=${tokensIn} tokensOut=${tokensOut} elapsed=${totalMs}ms`);
console.log(`[summary] recordings -> ${file}`);
const passed = results.filter(r => r.ok).length;
console.log(`[summary] checks: ${passed}/${results.length} passed`);
for (const r of results) if (!r.ok) console.log(`[FAIL] ${r.check}: ${r.detail}`);
process.exit(passed === results.length ? 0 : 1);
