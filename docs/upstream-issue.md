## Context

First of all, thanks for publishing the prototype — the article's framing ("the bottleneck moves from model capability to human attention") matched something we had been building independently, and the four gaps the article calls future work (external watchdog, speculative execution, async ReAct by default, credit/verification) were exactly where our own experiments were heading.

## What we built

**Shepherd** — an independent, event-sourced orchestration-layer prototype (TypeScript, zero third-party runtime dependencies), built to cover those four gaps. It is not a modification of this repository; we did not copy its code, and it is MIT-compatible.

- **Watchdog**: separate process, two layers — deterministic "spinal cord" rules (same-error streaks, report gaps, boundary probes) and an LLM "cortex" that only ever sees strongly-typed telemetry (numbers/enums/ids, never free text). Interventions are evidence-carrying events, gated by an "anger" state machine (intervene → anger up → decays on healthy signals; ≥80 demotes destructive actions to observe+escalate). Includes a self-healing closed loop demo.
- **Credit × bait verification**: credit profiles for workers/sources (double-layer: slow base + sensitive session score, parameters lifted from our earlier project), and *bait verification* — post-hoc checks with honeypot assertions to verify "the report was true" without trusting the worker's self-report (catches fake "all tests pass" and test-deletion escapes via content-hash checks on assertion files). Credit drives all budgets: speculation token pool, watchdog thresholds, sampling rate.
- **Speculative execution**: budgeted background tasks with dual trigger channels (explicit rules + assessor proposals), delivery gate = bait/reproduction verification, would-do log and hit-rate dashboard; pool exhaustion silences speculation instead of crowding real work.
- **Async ReAct + optimistic execution**: `start()/stop()` handles, inter-step injection, cancellation race settled by event sequence order, read-only whitelist for optimistic execution.

The execution boundary is delegated to a separate MCP server (our own project, [HooH](https://github.com/ace-code-engine/hooh-agent)) via its MCP mode — unchanged, per its own philosophy ("the model proposes, code adjudicates").

## What's been verified (and what hasn't)

- Mock-LLM benchmark, three groups (see [benchmark report](https://github.com/jincheng3870682453-hash/shepherd/blob/main/docs/announcements/benchmark-p6.md)):
  - Our dual-layer: p95 = 16 (seq-unit proxy) for the S1 script (220 triggers / 20 requests)
  - Upstream-style single session, self-handling: p95 = 5 but 220 interruptions
  - Upstream-style single session, delegating: p95 = 249
- Real DeepSeek API smoke: 4/4 checks passed (cortex spinning judgment + accept/reject/clarify intake), turns recorded in replay format.
- All interventions/adjudications/credit changes are HMAC-chained; replay consistency is in CI.
- **Not yet done**: full real-API rerun of all scenarios (cost), and the 20+ speculation-opportunity statistics. So these numbers prove the mechanisms and the architecture comparison, not the effect distribution under a real model.

## The ask

1. Would a **Watchdog example PR** (adapted to this bundle's conventions, as a small self-contained addition) be welcome? If yes, in what shape — a new entry under `examples/`, or integrated into the existing Source/Executor pipeline?
2. If maintaining the prototype doesn't include community additions (which would be completely understandable — the README frames it as reference code), just let us know; we'll keep Shepherd independent and simply link back to this repo as the reference architecture.

Either way, thanks — the article gave the field a useful vocabulary.

Links: [Shepherd](https://github.com/jincheng3870682453-hash/shepherd) · [Benchmark](https://github.com/jincheng3870682453-hash/shepherd/blob/main/docs/announcements/benchmark-p6.md) · [HooH](https://github.com/ace-code-engine/hooh-agent)
