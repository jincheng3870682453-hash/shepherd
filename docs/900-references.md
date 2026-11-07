# 900 参考索引（References）

> 所有设计输入的出处与部件映射。读 shepherd 代码遇到"这是从哪来的"，查本表。

## 外部参考

| 来源 | 用途 |
|------|------|
| DeepSeek《Exploring Super-agent Design: Towards a More Autonomous Agent System》（2026-10-31） | 架构骨架来源：双层、两级过滤、订阅直通、Inline&Spill、批处理实测数据 |
| [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（fork：`jincheng3870682453-hash/dsh-superagent-prototype`，基线 commit `8c32a9d`） | 对照实验的 C 组复刻来源；本地克隆 `G:\superagnet\dsh-superagent-prototype` |
| 上游文章报道存档：[智源社区](https://hub.baai.ac.cn/view/59263)、[智东西](https://m.163.com/dy/article/LAK152S2051180F7.html) | 文章细节回溯（原文页无法直链时） |

## 本方资产 → Shepherd 部件映射表

| 原件（仓库/文件） | 原职责 | 去向 | 方式 |
|------|--------|------|------|
| `jinchen-halfdup/jcf/rule_gate.py` | 确定性规则闸门：YAML 热更新、原子替换、失败保旧、SafeEvaluator | core/filter/rule-gate | TS 移植（ADR-004） |
| `jinchen-halfdup/jcf/ambiguity_router.py` | 三路分流（乱码/模糊/清晰） | core/filter/ambiguity | TS 移植 |
| `jinchen-halfdup/jcf/trust_tier.py` | 双层信用（base+session，v2.1 即时降权、时间衰减） | core/credit/tier | TS 移植（参数原样） |
| `jinchen-halfdup/jcf/middleware.py`（GrudgeMode 段） | 怒气衰减状态机（+30/-16/-10per30s） | core/watchdog/anger | TS 移植（参数原样） |
| `jinchen-halfdup/jcf/audit_log.py` | HMAC 链式审计 | adapters/bus（audit-hash 列） | 思想复用+重实现 |
| `jinchen-halfdup/jinchen_fd_kit/auto_tune.py` | feedback 日志 grid search | 006 基准的调参参考 | 思想复用（P5 后评估） |
| `jinchen-halfdup/jinchen_fd_kit/jinchen_fd_demo.py` | 半句抢答/口吃姿态 | ADR-003 乐观执行姿态 | 思想来源 |
| `ace/HooH（hooh-agent）` | 出口裁决链、写前快照回滚、沙箱、安全告警、MCP 包 | adapters/hooh-mcp 客户端 | **协议对接，一行不改** |
| `ace/execution_layer.py`（STALL 段） | "读类成功不算进展"、熔断计数 | core/telemetry（实质进展定义） | 规则移植 |
| `ace/ai_code.py`（STALL_ABORT_ROUNDS） | 防死循环中止 | 脊髓规则 `same-error-loop` 的先例 | 规则移植 |
| `ace/core/ace_ledgers.py`（H-21） | 事件必须指认生产者非症状 | 005 §1 铁律 2 | 教训继承 |
| `ace/docs/security/SECURITY-MODEL.md` | "被审计方自己可写记录等于没有记录" | 000/002 的状态写者规则、审计位置隔离 | 原则继承 |
| `aitoolkit/Toolkit/work.py`（V8.0） | BaitPool 诱饵、AST 结构签名比对、条件包裹检查 | P5 诱饵后验（core/bait + blob 工具） | 思想移植（Python 细节随目标语言重做） |
| `aitoolkit/Toolkit/guardian.py`（V4.0） | 物理快照回滚、乱码探针、阶梯降级 | HooH 快照的祖先；回滚编排参考 | 思想来源（能力用 HooH） |
| `aitoolkit/Toolkit/gateway.py` + `Nuwa.py` | 统一网关、启动模块健康检查 | apps/runtime（启动序列） | Nuwa assert_module_health 模式移植 |
| `aitoolkit/Toolkit/Archive.py` | SimHash 主题检测、回忆快照注入、urgency 信号（其需求文档=DSH 记忆方案 V1.7） | core/session/archive（上下文归档判重） | TS 移植（SimHash） |
| `aitoolkit/jinchen_v3/Toolkit/github_scout.py` | 仓库侦察→项目地图、搜不到→反问 | adapters/github 源的 Worker 工具设计参考 | 思想复用 |
| `aitoolkit/jinchen_v3/Toolkit/enhancements.py` | 适配器哲学：可选增强静默降级 | 002 §7 集成原则（与 fail-close 合并） | 原则继承 |
| `aitoolkit/jinchen_v3/Toolkit/shiyun.py` | 多 provider 抽象、线程池并行、SQLite 状态、逐项重试 | adapters/llm 客户端抽象、Worker 池参考 | 思想复用 |
| `aitoolkit/Toolkit/Word体系_完整公告.md` | "不依赖任何 AI 的诚实，只相信检测逻辑与人类终审权" | 004 §2 的体系原则、000 §6 角色定义 | 原则继承 |

## 上游原型 → Shepherd 对照表（同名概念的对齐与差异）

| 上游概念 | Shepherd 对应 | 差异 |
|----------|--------------|------|
| Engine（Trigger/Eval/Ticket/Assignment） | 总线 + Ticket 物化视图 | 状态藏于事件流，非聚合对象 |
| 两级过滤（程序策略/语义层） | rule_gate + Router 受理评估 | 多出 ambiguity 三路与源信用权重 |
| 订阅与直通 | 相同 | Worker 判定交回逻辑照抄 |
| Inline & Spill、链式召回 | 相同原则 | 链式召回 v1 取子集（005 §5） |
| Router 批处理 | 相同 | 实测口径复用上游（单决策成本 vs batch） |
| Outbox/Effects | adapters 内的投递器 | 语义对齐，实现简化 |
| Watchdog | **上游无** → core/watchdog + 独立进程 | 本项目旗舰一 |
| 投机执行 | **上游无** → core/speculation | 本项目旗舰二 |
| 异步 ReAct（start/stop） | session 内核 | 上游"已实现未默认开启"，我们默认开启 |
| 存算分离 | v1 仅协议预留 | 非目标（000 §3） |
