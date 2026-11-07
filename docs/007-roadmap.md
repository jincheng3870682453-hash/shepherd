# 007 路线图（Roadmap）

> 每期都有"验收"与"退路"——退路回答：砍到什么程度，这一期的核心论点仍然成立。

## P0 架构定稿（当前）

- [ ] 本文档套件评审通过（000..007 + ADR + 900/910）；
- [ ] 仓库初始化：MIT 协议、CI 骨架（typecheck+test）、目录结构（core/adapters/apps）；
- [ ] 事件 schema 的 TS 类型定稿（005 §1 的信封与类型命名空间）。
- 退路：无（文档就是本期产物）。

## P1 事件总线 + 异步会话内核 ✅（2026-11-07 完成）

**内容**：总线（SQLite 追加写、幂等、因果、HMAC 链、回放）+ 会话内核（事件驱动 ReAct、`start/stop` 异步工具、步间注入、取消竞态、归档）+ mock LLM 回放客户端。

**验收**（已完成，验证记录见 tests/bus.spec.ts、tests/session.spec.ts、tests/e2e.spec.ts）：
- [x] 单测全绿（21/21）；重放一致性测试进 CI（同剧本双跑逐字段相等——e2e 第 3 项）；
- [x] 演示：一个 mock 会话同时跑 3 个异步工具，结果乱序回、上下文不炸、取消竞态按 seq 裁决（e2e 第 1、2 项）。

**实现落点**：core（events/audit/canonical/bus/session）+ adapters（store/llm）+ apps/runner。
**commits**：`ead1f46`（总线）、`f4bd5ea`（内核）、`3da9422`（运行器+回放）。
**重放演示脚本**：即 e2e.spec.ts 全链路四项（3 工具乱序回→归档收敛→总线 6 事件全链完好；竞态端到端→superseded 落库；双跑重放逐字段相等；缺记录拒绝编造）。

**退路（未动用）**：乐观执行整块推迟到 P4 也不影响本期论点（内核已经全双工）。

## P2 Router/Worker 双层 + 模拟源 ✅（2026-11-08 完成）

**内容**：Router（轻模型受理评估+分派）、Worker 池（隔离会话+目录）、订阅直通、Ticket 生命周期、mock-gen 基线剧本（S1）。

**验收（已完成，commits `25f7b1c`→`005eada`，验证 tests/orchestrator+dual）**：
- [x] S1 剧本 mock LLM 下完整跑通：220 Trigger → 4 并发 Worker → 20/20 delivered；
- [x] 四张表第一版出数：p50/p95（seq 差代理）、打扰率（2 条/ticket：ack+result）、成本、交付率；
- [x] 并发上限真实生效（运行数≤4、FIFO 自动调度）；全链 HMAC 完好；
- [x] 对照口径冻结：S1 剧本+判分断言即 C 组（上游单 Session+Subagent）的对照基准，mock 模型保证可重复。
- 实战教训：噪音与请求共用 Thread 会被订阅直通并入在办 Ticket——直通的正确行为会放大剧本缺陷，模拟源的 Thread 语义必须与真实世界对齐。

**实现落点**：core（orchestrator/tickets/pool）+ adapters（mock-gen/deepseek）+ apps（dual）。
**注**：Router 受理评估 v1 用确定性规则 mock（Assessor 注入式），真轻模型接入推迟到 P3（与 HooH 一起做真源端到端时一并验证）。

**退路（未动用）**：订阅直通退化方案不需要。

## P3 HooH 接入 + 真实 GitHub 源 ✅（2026-11-08 完成）

**内容**：HooH-MCP 客户端适配（裁决/快照/拒绝计数遥测）、GitHub 轮询源、入口过滤管线（rule_gate/ambiguity 移植件）、真实仓库上的端到端任务（"修一个真 Issue → 开 PR"）。

**验收（已完成，commits `9ede472`→`b3ada6a`）**：
- [x] HooH-MCP 客户端（协议对接，HooH 一行不改）：真 server v1.2.1 联调全通；
- [x] GitHub 轮询源 + 本地 mock API 测试；
- [x] **真仓库端到端**（试验场 `shepherd-playground`）：第一幕 真轮询→受理→开单；
      第二幕 HooH 沙箱执行→真评论回写；第三幕 **真 PR 工作流**（授权令 mandate 写路径
      → Git API 开真 PR #11→评论回写，API-only 形态=跨机无本地 git 等价）；
- [x] HooH 拒绝动作全部可见、可回滚：恢复演示（破坏→恢复闭环，归一化哈希一致，
      3 裁决全程留痕）——rollback/undo 非 MCP 工具（核实白名单），恢复协议=内容留痕
      + HooH 快照台账双通道；
- [x] 入口过滤管线移植件接进 Orchestrator（结构化源旁路语义）。
- 实战记录：手动 completeHandle 与真执行器回调竞速 → superseded（剧本侧等执行器
  自然结算）；C-1 here-string 中文乱码→ASCII 关键词；C-2 本机网络分流→API-only
  工作流（跨机等价形态）；C-3 行尾差异→归一化对拍。

**退路（未动用）**：GitHub 源退化方案不需要——真源已通。

## P4 Watchdog（旗舰一）▶（进行中：a/b/c 语义核心完成 2026-11-08）

**内容**：遥测采集、脊髓规则引擎（含 SafeEvaluator 移植）、皮层会话、怒气额度、介入执行器（nudge/restart+快照回滚/escalate）、看住看门狗（心跳+统计）。

**已完成（commit `2fb9e3c`）**：
- [x] 怒气状态机（origin: jcf GrudgeMode，参数原样）+ 门控表（<50 放行/50-79 restart
      需双证据/≥80 降级 observe——"咬怕了"）；
- [x] 脊髓规则引擎（SafeEvaluator 白名单求值、默认五规则、热更新失败保旧）；
- [x] WatchdogCore 编排回路（皮层唤醒判定/双证据/healthy 衰减/介入执行注入）；
- [x] 10 项剧本测试：死循环命中、偏题皮层兜底、**深思考不咬（S4 语义）**、怒气降级。
- 修复实录：SafeEvaluator 白名单扩展——遥测字段不在原版九字段白名单会被静默忽略
  （条件恒真），并入 EXTENDED 白名单。

**待做（d 剩余）**：
- [x] 遥测采集接入（TelemetryCollector 七信号、S2 剧本内核版端到端）；
- [x] 皮层会话（CortexSession：sanitize 收口/STRICT 输出/fail-close healthy）；
- [x] Watchdog 独立进程壳（watchdog-proc：独立总线/心跳/heartbeatHealthy）；
- [ ] 介入执行器落地收尾（nudge=事件投递已通；restart=杀+HooH 快照回滚+重开待接 DualLayerRuntime）；
- [ ] S2/S3/S4 剧本全量基准跑分（漏放=0、皮层检出率、误杀率）+ "自愈闭环"回放演示。

**验收（全项）**：S2/S3/S4 三个剧本出数：漏放=0、皮层检出率有数字、S4 误杀率达标；介入全链路回放演示一次"自愈闭环"。

**退路**：皮层可整体关闭只留脊髓（B 组实验本来就是这么做对照的）；怒气额度可退化为硬计数器（丑但能跑）。

## P5 信用×诱饵（旗舰二）+ 投机执行

**内容**：信用档案与预算函数、三类诱饵与后验采样、投机调度器（预算池、双通道触发、交付门槛、would-do 日志、命中率仪表盘）。

**验收**：S6 后验捕获率 100%、信用曲线出图；S7 命中率与打扰率有数字；20+ 投机机会的统计。

**退路**：投机可退化为 record-only（would-do 日志照记，命中率照出，只是不真执行——说服力打折但机制完整）。

## P6 基准报告 + 收尾

**内容**：全剧本全组跑满、真实 API 复跑、基准报告成文（四张表+结论）、README/演示脚本、（可选）同机双进程的存算分离模拟。

**验收**：000 §4 五条毕业条件逐条核对。

**退路**：存算分离模拟是全项目第一个可砍项（000 已列为非目标，进来只是彩蛋）。

## 里程碑依赖

```
P0 → P1 → P2 → P3 → P4 → P5 → P6
          └──────┴──── 基准试验台从 P2 起持续可用（不是最后才建）
```

## 规模预算（防蔓延）

| 包 | 目标行数（TS） | 上限 |
|----|--------------|------|
| core（总线/内核/过滤/信用/怒气/预算） | ~2500 | 3500 |
| adapters（sqlite/llm/hooh/github/mock） | ~1200 | 2000 |
| apps（runtime/watchdog/CLI） | ~800 | 1300 |
| tests + mock-gen | ~1500 | 2500 |

新增机制必须先补 ADR；超行数上限的模块要先讲清楚砍什么。
