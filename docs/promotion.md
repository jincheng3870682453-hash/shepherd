# 宣传物料（发布用，2026-11-08）

> 背景：上游 `dsh-superagent-prototype` 的 issues/discussions **均被关闭**（实测：`has_issues:false, has_discussions:false`，仓库未归档、11-03 有推送）——官方反馈通道不存在，按 B 计划执行：改介绍文件 + 备宣传。

## 一、一句话介绍

**中文**：基于 DeepSeek 开源的 Super-agent 项目思路，做了一个**微型 demo**：把他们标注为"未来方向"的四块（看门狗/投机执行/信用验证/全双工）焊成能跑、能测、能回放的最小实现——零第三方依赖，108 项测试。

**English**: A micro demo based on DeepSeek's open-sourced Super-agent prototype: implements the four pieces the article lists as future work — external watchdog, speculative execution, credit × bait verification, async ReAct — as a runnable, testable, replayable minimal demo. Zero runtime deps, 108 tests, MIT.

## 二、长文导语（GitHub/博客开头）

> 2026-10-31，DeepSeek 公开了 Super-agent 架构，也开源了原型。但原型里留了四块空白：看门狗只有一段描述，投机执行、信用×诱饵、异步 ReAct 默认开启都还在"未来方向"里。
>
> 我们花了 17 轮迭代把它补成了可运行的原型 Shepherd：事件溯源总线 + 异步会话内核 + 双层调度 + 外部看门狗 + 诱饵后验信用 + 预算化投机。三组对照实验里，双层架构 p95=16，上游复刻的两种单会话形态分别是 220 次打扰和 p95=249；真 DeepSeek API 冒烟 4/4 全过。
>
> 更重要的是方法论：**监督要可测量**。看门狗的误杀率、诱饵的捕获率、投机的命中率、每个任务的成本与打扰数——全部有数字，全部可复现，全部进 HMAC 审计链。

## 三、短推文（发布用，可直接复制）

**中文版（≤280 字）**：
> 写了个原型致敬 DeepSeek 的 Super-agent 文章：它说看门狗/投机执行/信用验证/全双工是"未来方向"，我全做了。
>
> 亮点：
> 🔍 看门狗 = 确定性的"脊髓" + 只吃数字的模型"皮层"，误杀 0/漏放 0
> 🎯 诱饵后验：Agent 说"全过了"？埋个已知 bug 验一下——谎报捕获率 100%
> 💰 投机执行三重门控，命中率 0.50，低信用源直接静默
>
> 零依赖、108 测试、三组对照都有数。研究原型，不是产品 👇
> github.com/jincheng3870682453-hash/shepherd

**English version (≤280 chars)**:
> Shipped a prototype honoring DeepSeek's Super-agent paper: its "future work" — external watchdog, speculative execution, credit-based bait verification, async ReAct — all implemented.
>
> Watchdog: deterministic spinal + numeric-only cortex (0 false kills). Bait verification: 100% catch on lying workers. Speculation: budgeted, 0.50 hit rate.
>
> Zero deps, 108 tests, A-vs-C benchmarks. Research prototype 👇
> github.com/jincheng3870682453-hash/shepherd

## 四、数据卡（配图用）

| 指标 | 数字 | 复现命令 |
|------|------|---------|
| 测试 | 108/108 | `pnpm check` |
| S2 死循环漏放 | 0 | `tests/watchdog-telemetry.spec.ts` |
| S4 深思考误杀 | 0 | `tests/watchdog.spec.ts` |
| S6 谎报捕获率 | 100% | `tests/s6-s7.spec.ts` |
| S7 投机命中率 | 0.50 | `tests/s6-s7.spec.ts` |
| 三组对照 p95 | A=16 / C-self=5(220 打扰) / C-delegate=249 | `scripts/c-baseline.mts` |
| 真 API 冒烟 | 4/4（750+113 tokens，~3s） | `scripts/real-api-smoke.mts` |

## 五、awesome-deepseek-integration PR 草稿（备用官方入口）

该列表有 issues（194 open）且接受社区条目，分类：**AI Agent frameworks**。PR 内容 = 一行表格 + 可选 docs 子目录。建议提交前先开 issue 询问格式（该仓库无 CONTRIBUTING.md）。

**表格行（待提交时按当时格式微调）**：

```html
<tr>
    <td><img src="https://github.com/jincheng3870682453-hash/shepherd/raw/main/assets/logo.svg" alt="Icon" width="64" height="auto" /></td>
    <td><a href="https://github.com/jincheng3870682453-hash/shepherd">Shepherd</a></td>
    <td>Event-sourced orchestration layer for autonomous multi-agent fleets: external watchdog (deterministic + numeric-only LLM cortex), credit × bait verification for worker reports, budgeted speculative execution, async ReAct by default. TypeScript, zero runtime deps, 108 tests.</td>
</tr>
```

（注：`assets/logo.svg` 尚未创建——提交 PR 时需补一个 64px logo，或在 issue 里问是否可省略图标。）

## 六、发布检查清单

- [x] 仓库公开：github.com/jincheng3870682453-hash/shepherd（CI 绿）
- [x] README 宣传版（本文件配套）
- [ ] 社交发布（推特/X、即刻、V2EX、掘金、Reddit r/LocalLLaMA）——按平台裁剪上文
- [ ] awesome-list issue 探路（可选）
- [ ] 若官方后续开放通道：再把 issue 正文（docs/upstream-issue.md）转投
