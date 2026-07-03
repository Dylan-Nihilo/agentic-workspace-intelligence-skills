---
name: repo-understanding
description: Orchestrate the repo-understanding harness end to end - static scan, multi-round gap-directed exploration, fact verification, synthesis, and human-readable report. Use when the user asks to understand/analyze a repository, build a repo wiki, render graph, or knowledge index. Keywords - 理解仓库, 分析代码库, repo wiki, 知识图谱, fact graph, 架构分析.
---

# Repo Understanding(编排 skill)

把一个代码仓库转成"带证据的结构化知识资产"(fact-graph / render-graph / knowledge-index / wiki / report)。你是编排者:**只通过 harness CLI 原语驱动流程,自己不直接产出事实,也绝不手改任何产物文件。**

依赖 CLI 原语:`analyze / status / dispatch / ingest / verify / project / report`(见 `docs/harness-skill-plan.md` H 章)。所有命令在本 skill 所在仓库根目录执行:

```bash
npm run --silent understanding:harness -- <command> ...
```

## 红线(违反任何一条即失败)

1. 禁止直接编辑 package 内任何 JSON / JSONL / wiki 文件;一切写入走 `ingest` 或 `harness write-subagent`。
2. `fact-graph.json` 是唯一事实源;不创建任何计划外产物文件。
3. 对目标仓库只读;protected 文件永远 metadata-only。
4. 循环决策只依据 `status` 输出的 `nextAction`,不要自行解读 coverage 或臆断"应该够了"。

## 流程

### 1. 静态扫描(L1)

```bash
npm run --silent understanding:harness -- analyze --repo <repo-path> --out <package-dir>
```

失败(exit≠0)时把 validation issues 原样报给用户,停止。

### 2. 探索循环(L2/L3)

重复以下步骤,直到 `status` 返回 `nextAction: "synthesize"` 或达到配置轮数上限(`harness.config.json` 的 `maxExplorerRounds`):

1. `status --package <package-dir>` → 读 `nextAction`。
2. 若为 `dispatch`:执行 `dispatch --package <package-dir>`,解析 stdout 的 manifest JSON,得到本轮 explorer bundle 列表。
3. 处理 bundles:
   - **若你的运行时支持并行子代理**:为每个 bundle 派一个子代理,子代理加载 `repo-explorer` skill,输入为 bundle 路径。等全部子代理返回。
   - **否则**:自己按顺序对每个 bundle 执行 `repo-explorer` skill 的流程。
   - bundle 中 explorer 为 `adversarial-verify` 的,改用 `repo-fact-verifier` skill(独立性要求见该 skill)。
4. **ingest 必须由编排者串行执行**:无论探索是否并行,等每个 worker 写完 manifest 指定的 `outputPath` 后,按 manifest 顺序逐个执行 `ingest`。不要让多个 worker 同时写回同一个 package。
5. ingest 返回 `{merged: false, issues: [...]}` 时,把 issues 原样交回对应 worker 修正,最多 2 次;仍失败则写 openQuestion-only analysis 再 ingest。
6. 每轮结束向用户简报:本轮 merged/rejected 数、coverage 变化、剩余 open 任务数。

### 3. 验证

```bash
npm run --silent understanding:harness -- verify --package <package-dir>
```

不通过时:读 issues,判断是探索数据问题(回到探索循环补一轮)还是 harness 缺陷(报告用户,附 issues 原文),不要压制或绕过门禁。

### 4. 综合(L4 人读层)

按 `repo-synthesizer` skill 流程产出 `analyses/repo-understanding.json`(触发 wiki 叙述化重投影)。

### 5. 报告

```bash
npm run --silent understanding:harness -- report --package <package-dir>
npm run --silent understanding:harness -- verify --package <package-dir>
```

最终交付给用户:report 路径 + 关键指标(nodes/edges/coverage/动态边数/verifier 拦截数/validation 结果)。指标必须照抄命令输出,不得美化。
