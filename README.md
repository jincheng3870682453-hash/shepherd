# Shepherd

> 事件驱动的超智能体编排层原型 —— **P0-P6 全里程碑达成**（mock LLM 版基准报告已出，真实 API 复跑归后续）。

**一句话**：为"一直在岗、并行推进、主动找活、出事自愈"的多 Agent 舰队造编排层。入口过滤与出口裁决复用既有轮子（jcf / HooH·互），中间编排层自己焊。

## 它解决什么

DeepSeek 于 2026-10-31 公开了 Super-agent 架构并开源原型（[fork](https://github.com/jincheng3870682453-hash/dsh-superagent-prototype)）。该原型未实现的部分——**外部 Watchdog、信用×诱饵、投机执行、异步 ReAct 默认开启**——正是本项目的空白区与旗舰特性：

| 旗舰 | 一句话 | 实测 |
|------|--------|------|
| 看门狗 | 独立外部回路：确定性脊髓（规则/额度/怒气）+ 模型皮层（只吃结构化遥测），提议-裁决分离 | S2 漏放 0 / S4 误杀 0 / 自愈闭环 14 事件回放 |
| 信用×诱饵 | 信用档案 + 诱饵后验给"报告为真"不依赖自报的锚点，信用驱动一切预算 | S6 后验捕获率 100%、信用分化 |
| 投机执行 | 带预算的后台抢跑，交付门槛=诱饵/复现验证，would-do 日志出命中率仪表盘 | S7 命中率 0.50、低信用静默 |
| 乐观执行 | 只读白名单可抢跑，猜错口吃修正（继承 jinchen-fd 全双工姿态） | S1 双层 220 Trigger → 20/20 delivered |

## 文档（按序阅读）

1. [000 立项章程](docs/000-charter.md) —— 论点、范围、成功判据、风险
2. [001 术语表](docs/001-glossary.md)
3. [002 架构总纲](docs/002-architecture.md) —— 事件总线、会话内核、双层、依赖规则
4. [003 看门狗](docs/003-watchdog.md)
5. [004 信用与诱饵](docs/004-credit-bait.md)
6. [005 事件源与 Schema](docs/005-event-sources.md)
7. [006 成本与基准](docs/006-cost-benchmark.md)
8. [007 路线图](docs/007-roadmap.md) —— P0..P6 **全部达成**，每期有验收记录
9. [900 参考索引](docs/900-references.md) —— 全部设计输入的部件映射表
10. [910 工程约定](docs/910-conventions.md)
11. [ADR](docs/ADR.md) —— 6 个已定决策（事件溯源 / 看门狗输入收口 / 乐观执行分级 / 跨语言边界 / strip-types 运行形态）
12. [基准报告 P6](docs/announcements/benchmark-p6.md) —— 四张表 + 毕业条件核对（4 ✅ 1 ⏸）

## 真联调脚本（scripts/）

| 脚本 | 验证 |
|------|------|
| `hooh-smoke.mts` | 真 HooH-MCP v1.2.1 握手 + allow/asked 裁决 |
| `hooh-rollback-demo.mts` | 破坏→恢复闭环（行尾归一化） |
| `gh-e2e.mts` | 真 GitHub 轮询 → 受理 → 开单 |
| `gh-act2.mts` | HooH 沙箱执行 → 真评论回写 |
| `gh-act3.mts` | 真 PR 工作流（API-only，mandate 写权限） |
| `self-heal-demo.mts` | 自愈闭环：nudge 阶梯 → 门控 → restart → 交付 |
| `benchmark-report.mts` | 四张表汇总 + 毕业条件核对 |

## 谱系

```
jinchen-halfdup (入口层: 过滤/信用/审计/全双工姿态)  ← 移植进 core/filter + core/credit
        │
HooH·互 (出口层: 裁决/快照/回滚/沙箱)                ← 协议对接，一行不改
        │
Shepherd (编排层: 总线/内核/双层/看门狗/投机)         ← 本仓库，P0-P6 达成
        │
dsh-superagent-prototype (上游对照基线)              ← fork 只读
```

## License

MIT（对齐上游 fork 与本方仓库惯例）
