---
name: repo-understanding
version: 1.0.0
harnessContract:
  status: repo-harness-status/v1
  dispatch: repo-explorer-dispatch/v1
  ingestResult: repo-harness-ingest-result/v1
  writeSubagentResult: repo-harness-write-subagent-result/v1
  validation: repo-understanding-validation/v1
lastValidated: 2026-07-07
description: Orchestrate end-to-end understanding of a SINGLE repository into an evidence-backed fact-graph, narrative wiki, and knowledge index. Use when the user asks to understand/analyze one codebase, build a repo wiki, or produce a repo knowledge graph — NOT to build a multi-repo workspace datasource (use agentic-datasource-orchestrator). Keywords - 理解仓库, 分析单个代码库, repo wiki, fact-graph, 架构分析.
---

# Repo Understanding(编排 skill)

把一个代码仓库转成带证据的结构化知识资产,并**闭环到给人看的呈现**:fact-graph、render-graph、knowledge-index、wiki、report,以及一张自包含的 human-readable HTML 页面。你是编排者,只通过 harness CLI 原语驱动流程,不直接产出事实,也不手改任何 package 产物。

**闭环原则(ADK 式)**:LLM 判断只在叶子节点出现——探索(L2)产出带证据的事实、综合(L4)产出业务解读(含 `businessDomains`);编排、验证、渲染全是确定性 CLI。流程**必须走到人可消费的 HTML**,不能停在"落一堆数据没人消费"。

## 红线(HARD-GATE)

1. [HARD-GATE: validateUnderstandingPackage] `verify` 不通过时不得进入最终综合或交付。
2. [HARD-GATE: withPackageWriteLock] `ingest` 写 package 前必须取得 `.repo-understanding-ingest.lock`;并发写直接拒绝。

## 约束(PRINCIPLE)

1. `fact-graph.json` 是唯一事实源;不要创建计划外事实文件或手写 JSONL/wiki 产物。
2. 目标仓库只读;protected 文件永远 metadata-only。
3. 循环决策只依据 `status.nextAction`,不要自行解读 coverage 或臆断“应该够了”。
4. [PRINCIPLE] 记录未决问题优先用 `ingest --open-question` 原语,避免手搓 analysis JSON。
5. `ingest` 必须由编排者串行执行;不要让多个 worker 同时写同一个 package。
6. 探索和验证写回只走 `ingest`;schema 拒绝时按 `issues[]` 修正,不得绕过。
7. 最终综合写回只走 `write-subagent`,不得直接编辑 `analyses/repo-understanding.json`。
8. 若运行时支持并行子代理,可以并行处理 dispatch bundles;否则顺序执行同一文件契约。

## 流程

所有命令在本 skill 所在仓库根目录执行:

```bash
npm run --silent understanding:harness -- <command> ...
```

1. 静态扫描:

```bash
npm run --silent understanding:harness -- analyze --repo <repo-path> --out <package-dir>
```

2. 读取状态:

```bash
npm run --silent understanding:harness -- status --package <package-dir>
```

3. 按 `nextAction` 分支:
   - `dispatch`:执行 `dispatch`,读取 manifest,让每个 bundle 按 `repo-explorer` 或 `repo-fact-verifier` 流程写出 output,再按 manifest 顺序串行 `ingest`。
   - `synthesize`:退出探索循环,先执行 `verify`,通过后进入 `repo-synthesizer`。
   - `done`:终止循环,进入报告与交付。
4. 每次 `ingest` 返回 `{merged:false, issues:[...]}` 时,把 issues 原样交回对应 worker 修正,最多 2 次;仍失败时用 open-question 原语留痕并上报 rejected:

```bash
npm run --silent understanding:harness -- ingest --package <package-dir> --open-question "<question>" --tasks "<task-id>,<node-id>"
```
5. 最终综合(L4):按 `repo-synthesizer` skill 写入 `analyses/repo-understanding.json`。综合**必须包含 `businessDomains`**(按业务而非 router 文件分组的域),它是人读页面的业务分类来源。
6. 呈现(闭环收尾,确定性渲染):综合写回后,渲染人可消费的 HTML 页面。它是消费投影,确定性读取 fact-graph 与综合结果,不做 LLM 即兴生成。**这一步不可跳过——流程必须闭环到人能打开的页面。**

```bash
npm run --silent understanding:harness -- html --package <package-dir>
```

7. 报告与复核:

```bash
npm run --silent understanding:harness -- report --package <package-dir>
npm run --silent understanding:harness -- verify --package <package-dir>
```

## 返回给编排者

**首要交付 human-readable HTML 页面路径**(`<package-dir>/human-readable.html`,人直接打开的东西),外加 report 路径、package 路径、nodes/edges/coverage、动态边数、verifier 拦截数、validation 结果、是否写入最终综合与 businessDomains 数量。指标必须来自命令输出或 package 产物,不得美化。
