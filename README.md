# Shepherd

[![CI](https://github.com/jincheng3870682453-hash/shepherd/actions/workflows/ci.yml/badge.svg)](https://github.com/jincheng3870682453-hash/shepherd/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-zero-orange.svg)](package.json)
[![Node](https://img.shields.io/badge/Node-24-339933.svg)](package.json)

> **基于 DeepSeek 开源的 Super-agent 项目做的微型 demo**：把"一直在岗、并行推进、主动找活、出事自愈"做成可运行、可测试的最小实现。
>
> 定位：跟着 DeepSeek《Super-agent》文章与开源原型做的一个**微型 demo**——把它原型里标注为"未来方向"的四块（外部看门狗、投机执行、信用×诱饵验证、异步 ReAct 默认开启）做成可跑的最小闭环。独立实现（未复制上游代码）；MIT，零第三方运行时依赖。

## 30 秒看懂它想证明什么

多 Agent 系统的单任务能力已经够用，瓶颈转移到了**人的注意力**：一个人同时只能跟进 3~5 个活跃会话。Shepherd 的论点：**把会话管理、上下文同步、监督、验证从人手里拿走，人只做决策与验收**——而且这些机制必须**可测量**（误杀率/漏放率/命中率/成本/打扰率），不能靠感觉。

一句话：**看门狗解决"Agent 跑偏了怎么办"，信用×诱饵解决"Agent 说它做完了，我凭什么信"。**

## 四块空白，逐块对账

| 空白（上游文章明说"未来方向"、原型未实现） | Shepherd 的做法 | 实测（mock LLM + 真 API 冒烟） |
|------|------|------|
| **外部看门狗** | 独立进程：确定性"脊髓"规则（同错连击/报告间隔/边界试探）+ 模型"皮层"（**只吃结构化遥测，永不接触自由文本**）；介入按"怒气"状态机分级（observe→nudge→restart→escalate，≥80 自动降级"咬怕了"）；介入全部带 evidence 进 HMAC 审计链 | S2 死循环：漏放 0；S4 深思考：误杀 0；自愈闭环 14 事件可回放 |
| **信用 × 诱饵验证** | 双层信用（慢变 base + 敏感会话分）+ **诱饵后验**：埋已知缺陷/探针任务，报告"全过"却没过诱饵 = 谎报；改断言文件 = 逃逸（哈希比对抓"删测试"）；信用驱动一切预算（投机池/阈值/抽查率） | S6：谎报捕获率 100%，诚实 vs 谎报信用分化；谎报者 -25×3 打穿 |
| **投机执行** | 带预算的后台抢跑：双通道触发（显式规则+评估提议）、三重门控（预算/并发/池干涸即静默）、交付门槛=诱饵/复现验证、would-do 日志 + 命中率仪表盘 | S7 命中率 0.50；低信用源 0 打扰 |
| **异步 ReAct 默认开启** | `start()/stop()` 句柄、步间注入、取消竞态按事件 seq 裁决、只读白名单乐观执行（猜错"口吃"修正） | 3 工具乱序回/竞态端到端；重放一致性进 CI |

## 三组对照：双层到底值不值

同一 S1 剧本（220 Trigger / 20 请求）、同判分、mock LLM：

| 组 | p95（seq 差代理） | 打扰 | 说明 |
|----|------|------|------|
| **A 双层 4 Worker** | **16** | 40 | 2 条/Ticket（ack+result） |
| C 上游复刻 self | 5 | **220** | 中性提示 0/5 委派：串行阻塞 + 全打断 |
| C 上游复刻 delegate | **249** | 240 | 每条消息绕主会话的"委派税" |

**A 组 p95 显著优于 C 组两态**——与上游实验方向一致。完整数据：[基准报告](docs/announcements/benchmark-p6.md)。

## 30 秒跑起来

```bash
pnpm install
pnpm run check                    # typecheck + 108 项测试（Node 内置 test runner，零测试依赖）
node --experimental-strip-types scripts/self-heal-demo.mts   # 自愈闭环演示（纯本地，无 API 成本）
node --experimental-strip-types scripts/c-baseline.mts       # 三组对照跑分
```

真模型（需要密钥，只读环境变量、永不落盘）：

```bash
DEEPSEEK_API_KEY=... node --experimental-strip-types scripts/real-api-smoke.mts
```

## 能证明什么 / 不能证明什么

**能证明**：机制成立且可测量——看门狗漏放/误杀、诱饵捕获率、投机命中率、三组对照差异、审计链完整性、重放一致性，全部有测试或脚本复现。

**不能证明**：真实模型下的效果分布。基准是 mock LLM（可重复、零成本），真 API 只做了 4 项冒烟（皮层判断 + 受理三态全过）。全量真实 API 复跑与 20+ 投机机会统计尚未做——报告里明确标注。

**边界声明**：研究原型，不是产品；单机三进程拓扑；存算分离只留协议；C 组是行为级复刻而非逐行源码复刻。

## 谱系

```
jinchen-halfdup (入口层: 过滤/信用/审计/全双工姿态)  ← 移植进 core/filter + core/credit
        │
HooH·互 (出口层: 裁决/快照/回滚/沙箱)                ← MCP 协议对接，一行不改
        │
Shepherd (编排层: 总线/内核/双层/看门狗/投机)         ← 本仓库
        │
dsh-superagent-prototype (参考架构，fork 只读)       ← 上游
```

## 文档（按序阅读）

1. [000 立项章程](docs/000-charter.md) —— 论点、范围、成功判据、风险
2. [001 术语表](docs/001-glossary.md)
3. [002 架构总纲](docs/002-architecture.md) —— 事件总线、会话内核、双层、依赖规则
4. [003 看门狗](docs/003-watchdog.md)
5. [004 信用与诱饵](docs/004-credit-bait.md)
6. [005 事件源与 Schema](docs/005-event-sources.md)
7. [006 成本与基准](docs/006-cost-benchmark.md)
8. [007 路线图](docs/007-roadmap.md) —— P0..P6 全部达成，每期有验收记录
9. [900 参考索引](docs/900-references.md) —— 全部设计输入的部件映射表
10. [910 工程约定](docs/910-conventions.md)
11. [ADR](docs/ADR.md) —— 7 个已定决策
12. [基准报告 P6](docs/announcements/benchmark-p6.md) —— 四张表 + 毕业条件 5/5 ✅

## 真联调脚本（scripts/）

| 脚本 | 验证 |
|------|------|
| `hooh-smoke.mts` | 真 HooH-MCP v1.2.1 握手 + allow/asked 裁决 |
| `hooh-rollback-demo.mts` | 破坏→恢复闭环（行尾归一化） |
| `gh-e2e.mts` | 真 GitHub 轮询 → 受理 → 开单 |
| `gh-act2.mts` | HooH 沙箱执行 → 真评论回写 |
| `gh-act3.mts` | 真 PR 工作流（API-only，mandate 写权限） |
| `self-heal-demo.mts` | 自愈闭环：nudge 阶梯 → 门控 → restart → 交付 |
| `c-baseline.mts` | 三组对照（双层 vs 上游复刻两态） |
| `real-api-smoke.mts` | 真 DeepSeek API 冒烟 4/4 + 录制可回放样本 |
| `benchmark-report.mts` | 四张表汇总 + 毕业条件核对 |

## License

MIT（对齐上游 fork 与本方仓库惯例）
