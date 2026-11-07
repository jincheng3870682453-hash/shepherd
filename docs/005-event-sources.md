# 005 事件源与 Schema

> 事件从哪来、长什么样、怎么保证语义严谨。本篇是对 ADR-001 的展开。

## 1. 事件信封（所有事件的公共部分）

```jsonc
{
  "seq": 1042,                      // 全序号（总线分配，单调）
  "id": "evt_01HXYZ...",            // 幂等键（ULID）
  "type": "source.trigger.received",
  "ts": "2026-11-07T15:04:05.123Z", // 事件时间（生产者时钟）
  "ingested_at": "...",             // 入总线时间
  "producer": "github:acme/widget#pr-42",  // 真实来源（H-21：指认生产者不指认症状）
  "caused_by": "evt_01HXYW...",     // 因果父事件（根事件为 null）
  "payload": { ... },               // 按 type 定义
  "audit_hash": "hmac:..."          // 链式 HMAC（前序 hash + 本事件规范化 JSON）
}
```

**三条铁律**：
1. **幂等**：同一外部事实重复到达（GitHub webhook 重发、轮询窗口重叠）必须被 `producer` + 自然键去重。每个源为每种事实定义自然键（如 `github.comment:{repo}#{n}:{comment_id}`），重复事件标记 `duplicate` 入库不入流。
2. **因果**：每个事件必须填 `caused_by`（"我不知道谁引起我"=根事件，要显式声明）。禁止症状事件——`tool.result` 必须挂在 `tool.started` 下，重启必挂在介入或人命下。
3. **全序**：所有消费按 `seq` 处理；同轮积压合并时保留 seq 列表，重放可还原。

## 2. 事件源

### GitHub 轮询源（v1 真实源）

- 轮询而非 webhook（零公网部署成本，对齐上游原型的做法）；轮询周期 30s，带 `POLL_HORIZON` 防漏（学上游 poll.ts）。
- 监听面（v1）：目标仓库的 Issue/PR 评论、PR 状态（CI 结果）、新 Issue。自然键齐全。
- 输出 Trigger：`{kind: comment|ci|issue, thread: "gh:repo#42", sender, text_ref, url}`。
- 大内容（评论全文、diff）入 blob 表，Trigger 带引用——总线不放大对象。
- 凭据：GitHub token 只进源适配器进程，事件里永不出现。

### 模拟源（mock-gen，临床试验的病人）

脚本化生成合成事件流，能力：
- 基线剧本：N 条消息、M 个工作请求（对齐上游实验规模：约 300 消息、20 请求）；
- **故障注入**（与 006 基准联动）：
  - `flood`：洪水噪音（检验入口过滤与熔断）；
  - `poison`：带提示注入的评论（检验 ADR-002 收口）；
  - `lure`：环境诱饵（已知 Bug 报告，带标准答案）；
  - `churn`：话题漂移序列（同 Thread 反复改需求，检验 Router 上下文连续性）。
- 每个剧本带**判分器断言**：预期哪些 Ticket 被受理、预期结果、预期时限——没有断言的剧本不能进基准。

### 未来源（v1 不做，schema 预留）

飞书/IM 源：上游原型有完整实现可移植；本地文件/git 事件源：等 Worker 执行真实仓库工作后再接。

## 3. 入口过滤管线（进程内，jcf 移植件）

```
Trigger → rule_gate（Fast Path：确定性规则，YAML 热更新）
        → ambiguity_router（三路：乱码→零成本模板回复/直接静默；模糊→轻量澄清；
                            清晰→继续）
        → credit 查源信用（低信用源阈值收紧）
        → 交 Router（Slow Path：受理评估，轻模型）
        → intake.accepted / intake.filtered{reason}
```

- 过滤结果（含被滤原因）全部入总线（`intake.filtered` 也是事实，仪表盘要用）。
- rule_gate 规则来源两处：静态 YAML（团队手写）+ 源信用驱动的自动收紧（004 §4）。
- 与上游两级过滤的对应：上游程序层=rule_gate；上游语义层=Router 受理评估；我们多出的是 ambiguity 三路与信用权重。

## 4. 会话消费语义

- 每个会话（Router/Worker/皮层）有自己的游标（已消费 seq），事件按序投递；
- Worker 的直通事件不落 Router 游标（订阅关系表决定投递目标集合）；
- **重放**：清空物化视图 → 从 seq=0 顺序重放（LLM 调用走记录值）→ 视图应与崩溃前一致。重放测试进 CI。

## 5. Blob 与窗口管理

- 大对象策略：事件载荷上限 2KB；超出部分入 `blobs` 表（内容+SHA256），事件带 `{blob_ref, size, sha}`。
- 会话上下文注入遵循 Inline & Spill：近期/高相关 Inline；超限 Spill 为引用（学上游 + Archive.py SimHash 判重防重复注入）。
- 链式召回 v1 简化版：从当前事件沿 `caused_by`/Thread 引用逐跳取（每跳 Inline 下一跳 id）——上游完整形态的子集，够用即可。
