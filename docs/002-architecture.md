# 002 架构总纲（Architecture）

> Shepherd 的分层、数据流与依赖规则。读法：先看图，再逐节；细节留到对应编号文档。

## 1. 全景图

```
   事件源（真实 + 模拟）                    审计链（HMAC，追加写）
   GitHub轮询源 / mock-gen              ↑ 只进不改
        │ trigger.*                            │
        ▼                                      │
┌──────────────────────────────────────────────────────────┐
│  入口过滤（jcf 移植，进程内热路径）                            │
│  rule_gate（Fast Path）→ ambiguity_router（三路）           │
│  → trust_tier 查信用（ Slow Path 的权重）                    │
└──────────────┬───────────────────────────────────────────┘
               │ 合格事件（全序入总线）
┌──────────────▼───────────── 审计链写入 ──┐
│  Router（轻模型常驻会话）                  │
│  · 接收过滤后事件，批处理                  │
│  · 分派/订阅管理/对外发言                 │
│  · MasterAssessor：受理决策（轻模型）      │
└──────┬──────────────────────┬──────────┘
       │ dispatch(ticket)      │ reply/attention
┌──────▼───────────┐   ┌──────▼─────────┐        ┌──────────────────┐
│ Worker 池         │   │ 面板/CLI 看板    │        │ Watchdog（独立回路）│
│ 强模型·隔离会话    │   │ 最简读视图       │        │ 脊髓规则(移植rule_ │
│ 异步ReAct内核      │   └────────────────┘        │ gate)→皮层(独立LLM │
│ 乐观执行(ADR-003) │                             │ 会话)→介入裁决(脊髓)│
└──┬───────────────┘                             │ →怒气额度→执行     │
   │ 每次工具调用                                  └────────┬─────────┘
   ▼                                                      │ 介入事件
┌──────────────────┐    拒绝/放行/快照    ┌────────────────▼─────────┐
│ HooH-MCP（不动）   │───────────────────▶│ 总线（ticket.event.*）     │
│ 裁决·快照·回滚·沙箱│                     └─────────────────────────┘
└──────────────────┘
```

三层谱系（继承自既有项目）：**入口层**（jcf 移植件管"什么值得进"）→ **编排层**（Shepherd 内核管"进来后怎么调度、谁盯谁"）→ **出口层**（HooH 管"什么允许碰到真实世界"）。Shepherd 是中间层，两端不是它的职责，是它的边界条件。

## 2. 事件总线（ADR-001）

**单一事实来源。一切状态由事件推导；会话状态、Ticket 状态、信用、怒气都是总线上事件的物化视图。**

- **存储**：SQLite 单库，`events` 表追加写；`seq`（全序号）、`id`（幂等键）、`type`、`ts`、`producer`、`caused_by`（因果父事件）、`payload(JSON)`、`audit_hash`（HMAC 链）。
- **全序与因果**：`seq` 给全序；`caused_by` 给因果森林。任何事件必须能回答"谁生成了你、哪件事引起了你"（H-21 教训：指认生产者，不指认症状）。
- **物化视图**：内存中维护 Ticket/Session/Credit/Anger 视图，崩溃后从总线重放重建（重放是启动路径的一部分，不是调试工具专属）。
- **回放语义**：同输入同输出要求所有非确定性（LLM 调用、时钟）以事件形式记录在案（`llm.request/response`、`clock.tick` 也进总线），重放时用记录值。
- **不进总线的东西**：大负载（文件内容、diff）存 blob 表，事件里只留引用与哈希——窗口管理（Inline & Spill）在会话层做，总线只管事实。

事件类型命名空间：

```
source.trigger.received        # 原始事件入站（含 producer、幂等键）
intake.accepted / filtered     # 入口过滤的结果（filtered 必带 reason）
ticket.opened / resumed / ended
ticket.subscribed / unsubscribed
router.dispatched              # Router 分派决策（含模型、耗时、token）
session.started / ended / restarted（重启必带 caused_by=watchdog.intervention 或人）
session.turn.started / ended   # 遥测源
tool.started / tool.result     # 异步工具生命周期（含 handle、乐观标记）
hooh.decided                   # HooH 裁决记录（allow/deny/sandboxed + reason）
watchdog.observed / intervened / escalated
credit.changed                 # 信用变化（caused_by 指向触发它的证据事件）
bait.planted / bait.verified / bait.missed
speculation.proposed / started / delivered / dropped
meter.charge / meter.tripped
clock.tick / llm.request / llm.response   # 非确定性记录
```

## 3. 会话内核（异步 ReAct + 乐观执行）

会话 = 事件驱动的状态机。一轮 = "取一批事件 → 一次 LLM 调用 → 执行工具 → 产出新事件"。

- **异步工具**：`tool.start(name,args)` → 立即返回 `{handle}`；内核注册句柄并继续本轮；完成事件 `tool.result{handle,...}` 入总线、路由到该会话队列；**步间注入**——只在该会话取下一批事件时合并进上下文。
- **取消竞态规则**：`stop(handle)` 与 `tool.result` 竞争时，**先到总线的算数**（按 seq 判定），后到的事件标记 `superseded` 仍入总线（事实不丢弃）。
- **孤儿清理**：会话结束/重启时，未决句柄进入宽限期（默认 60s），到点 `tool.cancelled`。
- **上下文膨胀**：每轮结束后跑归档检查——已完成句柄的"启动消息"压缩为一行摘要（句柄 id + 意图），原文在总线。SimHash 判重防重复注入（Archive.py 移植）。
- **乐观执行（ADR-003）**：只读白名单工具可乐观并发；写工具必须等依赖落定。猜错 → 口吃回合。
- **批量与节流**：同会话积压事件合并为一轮（学上游 Router 批处理实测：单决策成本随批量摊薄）。

## 4. Router/Worker 双层

- **Router**：轻模型（DeepSeek chat 档）、无写工具、只分派与对外发言。输入永远是过滤后事件；输出是 `router.dispatched` / `reply` 事件。受理决策复用上游 MasterAssessor 模式但模型换轻档。
- **Worker**：强模型（DeepSeek reasoner 档）、隔离上下文 + 独立工作目录（`work/ticket-<id>/`）、每次工具调用过 HooH。
- **订阅直通**：Worker 创建后 `ticket.subscribed`；同 Thread 后续事件直达，不回 Router。Worker 判定事件超出 Mandate → `unsubscribed` + 交回。
- **冲突自见**：两个 Worker 同盯一个 Thread → 双双收到同事件 → 各自决定让路或协调；跨任务协调走 Router。规则写在 Worker 提示词（学上游"订阅同一 Thread 自行发现冲突"）。

## 5. Watchdog（独立回路）

完整协议见 003。架构位置要点：

- **独立进程 + 独立会话**：不与主系统共享 LLM 上下文；主系统整体死亡时它仍存活（进程级分离）。
- **输入只有两种**：总线上的遥测事件（结构化）、HooH 裁决记录。**永不读自由文本**（消息内容、网页、diff 一律不进皮层——ADR-002 的注入面收口）。
- **输出只有一种**：`watchdog.intervened{level, target, evidence[]}` 事件，由脊髓执行器落实（nudge=向目标会话队列投递提示事件；restart=杀会话进程+快照回滚+重开；escalate=面板置顶+停新任务）。
- **自身约束**：怒气额度（003 §5）；每次介入带 evidence[]（脊髓命中规则 id 或皮层证据摘要）；介入本身进审计链。

## 6. 信用与诱饵

见 004。架构位置：`credit.changed` 由脊髓在收到后验证据时计算；信用视图是总线的物化视图；预算函数在投机调度器与 Watchdog 脊髓里被读取，不在 LLM 手里。

## 7. 依赖规则（编译器强制的分层）

```
core/        领域逻辑：总线、会话内核、过滤移植件、信用、怒气、预算函数
             —— 零 I/O，纯 TS，全部可单测（学上游 core 零依赖纪律）
adapters/    I/O：SQLite、LLM 客户端（provider 抽象）、HooH-MCP 客户端、GitHub 源、mock 源
apps/        组合根：runtime（学 Nuwa assert_module_health 启动健康检查）、watchdog 进程、CLI/面板
```

- `core` 不 import `adapters`；`adapters` 不 import `apps`。
- 每个模块收窄接口（学上游 `Pick<Role>` 风格 + jcf 的 SafeEvaluator 白名单风格）。
- 集成原则（合并 enhancements.py 与 HooH 两条哲学）：**可选增强允许静默降级并留痕；安全边界（HooH、审计链、熔断）绝不静默降级，fail-close。**
- 一处状态一个写者：信用=脊髓写；怒气=脊髓写；Ticket=Router 写；遥测=内核写。

## 8. 技术栈与进程拓扑

- TypeScript/Node（内核），Python（HooH/jcf/aitoolkit 原件）只在协议边界外。
- v1 单机三进程：`shepherd-core`（总线+Router+Worker 池）、`shepherd-watchdog`、`hooh-mcp`（现有 Python 包，stdio）。进程间只走事件/协议，不共享内存。协议为跨机预留（ADR-005 预占，v1 不实现）。
- LLM 客户端 provider 抽象（学 shiyun 的 10 家 provider 表），v1 只接 DeepSeek，测试全走 mock 回放。
