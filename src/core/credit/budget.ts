/**
 * 预算函数（core/credit/budget.ts）—— 信任是预算的函数（docs/004 §3）。
 *
 * 不可信用化的事项（写死）：写权限、审计豁免、熔断豁免——信用只调"耐心与预算"，
 * 永远不买"绕过边界"（对齐 HooH 哲学，004 §3 红线）。
 */
export interface BudgetSnapshot {
  /** 投机预算（每源每日 token）：50k × (credit/100)²。 */
  readonly speculationTokens: number;
  /** 后验采样率：1 - credit/120。 */
  readonly baitSamplingRate: number;
  /** Watchdog 阈值乘数：1.6 - 0.9×credit/100。 */
  readonly watchdogThresholdFactor: number;
  /** 直通资格：credit ≥ 60 才走直通，低信用强制回 Router 复审。 */
  readonly directRoutingAllowed: boolean;
}

export function budgetFor(credit: number): BudgetSnapshot {
  const c = Math.max(0, Math.min(100, credit));
  return {
    speculationTokens: Math.round(50_000 * (c / 100) ** 2),
    baitSamplingRate: Math.max(0, Math.min(1, 1 - c / 120)),
    watchdogThresholdFactor: 1.6 - 0.9 * (c / 100),
    directRoutingAllowed: c >= 60,
  };
}
