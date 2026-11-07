# 003 看门狗（Watchdog Protocol）

> 外部监督回路的完整设计。这是本项目旗舰特性一，也是上游文章只有一段定性描述、原型零实现的部分。

## 1. 定位与不变式

- **不变式 1（独立性）**：Watchdog 进程死亡不伤主系统；主系统死亡不伤 Watchdog。唯一的耦合点=总线（追加读）与介入执行器（投递事件/杀进程）。
- **不变式 2（无语义输入）**：皮层永不接触自由文本。它看到的每一条信息要么是数字、枚举、id，要么是 HooH 裁决的结构化记录。（注：Worker 的报告结论本身是自由文本，进皮层前压缩为枚举：`report.kind ∈ {ready, blocked, progress, failed}` + 数字。）
- **不变式 3（提议-裁决分离）**：皮层只产判断；一切动作经脊髓规则表。脊髓不理解语义但完全控制"什么条件下允许什么动作"。
- **不变式 4（可审计）**：每次介入必带 evidence[]；介入事件进 HMAC 链；人可回放审问"为什么咬"。

## 2. 遥测采集（内核侧，每会话）

内核为每个 Worker 会话维护遥测窗口（默认滚动 30min），全部为确定性可计算量：

| 信号 | 定义 | 来源 |
|------|------|------|
| `report_gap_ms` | 距上次实质报告的时间（实质=改变了可验证状态；**读类不算**，继承 STALL 规则） | 内核 |
| `same_error_streak` | 连续相同错误指纹（错误类型+参数哈希）次数 | 内核 |
| `file_edit_repeat` | 同一文件第 N 次往返编辑（A→B→A 计 2） | 内核 |
| `token_slope` | 每轮 token 消耗的斜率（上升而无产出=烧钱信号） | meter |
| `hooh_deny_streak` | HooH 连续拒绝计数（试探边界的信号） | hooh.decided |
| `turn_no_tool_streak` | 连续 N 轮零工具调用（空转思考） | 内核 |
| `handle_orphans` | 未决异步句柄数与最长滞留 | 内核 |

窗口以 `watchdog.observed{sessionId, signals}` 事件每 60s 快照入总线。

## 3. 脊髓层（确定性规则）

规则表 = YAML（学 jcf rule_gate：热更新、原子替换、加载失败保旧规则、SafeEvaluator 白名单字段禁 eval）。字段白名单=上表信号 + 信用 + 怒气 + 会话类型。规则产出**建议动作 + 命中证据**，动作受额度门控（§5）：

```
- id: same-error-loop
  when: "same_error_streak >= 3"
  propose: nudge
  evidence: ["same_error_streak", "last_error_fingerprint"]
- id: no-progress-long
  when: "report_gap_ms > credit_scaled(45min) AND turn_no_tool_streak >= 5"
  propose: nudge_then_restart
- id: thrash-edit
  when: "file_edit_repeat >= 4"
  propose: nudge
- id: boundary-probe
  when: "hooh_deny_streak >= 5"
  propose: escalate          # 试探边界不是技术故障，直接给人
- id: burn-rate
  when: "token_slope > 3x baseline AND handle_orphans == 0"
  propose: restart_after_nudge
```

`credit_scaled(x)`：阈值乘数 = f(信用)。高信用 ×1.5（更多耐心），低信用 ×0.6（快止损）——信用在此进入脊髓，但只进阈值常数，不进规则结构（规则结构热更新，阈值由数据驱动）。

## 4. 皮层层（模型判断）

- 独立 LLM 会话（轻模型档）。输入：当前窗口的遥测摘要 + 该 Ticket 的 Mandate 目标（一行）+ 最近 8 次 `watchdog.observed` 的差分。**输入 schema 强类型校验，超 schema 字段直接丢弃。**
- 输出三值 + 理由：`healthy | drifting | spinning`（正常/偏离目标/原地空转）+ 50 字内证据摘要（这份摘要是自由文本，但它是皮层的**输出**不是输入——输出进审计链给人看，不再回流给任何 LLM 作为输入，避免自我强化）。
- 频率：只在脊髓命中规则时被唤醒（皮层不是常驻心跳，省成本）+ 兜底低频巡检（每 15min 一轮，只看 top 风险会话）。
- 皮层判断记录为 `watchdog.observed{cortex: {...}}`，脊髓看到皮层判断后按规则表决定动作（例如 `drifting` + `no-progress-long` 已命中 → 升级 propose）。

## 5. 介入协议与怒气额度

分级：`observe`（只记录）→ `nudge`（向目标会话投递结构化提示事件："你可能偏离/空转，证据：…"）→ `restart`（杀会话进程 → HooH 快照回滚到最近检查点 → 带恢复说明重开）→ `escalate`（面板置顶、停新任务、等人）。

怒气状态机（继承 jcf GrudgeMode，参数 v1 原样）：

- 每次介入 `anger += 30`；每个正常衰减信号（实质进展/皮层 healthy）`anger -= 16`；时间衰减 `-10/30s`。
- 怒气门控：
  - `anger < 50`：nudge/restart 可自动执行；
  - `50 ≤ anger < 80`：restart 需两个独立证据（脊髓命中 + 皮层判断一致），否则降级为 nudge；
  - `anger ≥ 80`：一切介入只 observe + escalate——"这条狗咬怕了，先冷静"。
- **误杀保险**：restart 前若该 Ticket 有未交付成果，自动先打 HooH 快照标记；重启后 Worker 恢复说明中列明"上次进展锚点"。

## 6. 看住看门狗

- Watchdog 进程自身的心跳事件入总线；主系统发现 Watchdog 心跳缺失（>5min）→ 面板告警 + 自动拉起（拉起动作由 core 侧守护逻辑做，不是 Watchdog 自拉）。
- 介入统计仪表盘：nudge/restart/escalate 次数、误杀率（restart 后任务最终成功且恢复说明中未提同样问题=疑似误杀）、皮层与脊髓一致率。
- 人可用自然语言审问（面板输入 → 主会话读审计链代答），Watchdog 本身不直接对话。

## 7. 校准计划

基准试验台（006）注入故障类型与预期：
- 死循环（相同错误刷屏）→ 脊髓单层即可捕获，皮层无必要 → 验证漏放率≈0；
- 缓慢偏题（每步都成功但方向错）→ 脊髓不可见，皮层必须捕获 → 验证皮层检出率；
- 深思考（故意长时无输出但最终交付）→ **必须不咬** → 验证误杀率；
- 洪水（恶意刷事件）→ 入口过滤+meter 熔断，Watchdog 不参与。
