---
name: repo-understanding
version: 1.0.0
harnessContract:
  status: repo-harness-status/v1
  repoProfile: repo-scout-profile/v1
  scanPolicy: repo-scan-policy/v1
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
9. 档位地板(不可裁量):`adversarial-verify` bundle 与最终综合(repo-synthesizer)不得派给低于主线程默认档的子代理——裁决与综合的错误没有下游门禁兜底,此条不在第 3 步的调整授权范围内。
10. 失败升档:低档 bundle 连续 2 次 `merged:false` 或 `factsAccepted=0` 时,建议以更高档重派该 bundle 一次,并在轮次简报中记录"升档重试"。

## 流程

所有命令在本 skill 所在仓库根目录执行:

```bash
npm run --silent understanding:harness -- <command> ...
```

1. L0 scout + L1 静态扫描:

```bash
npm run --silent understanding:harness -- analyze --repo <repo-path> --out <package-dir>
```

`analyze` 会先落 `repo-profile.json` 与 `scan-policy.json`,再生成 `inventory/code-map/fact-graph/gap-queue`。进入 dispatch 前必须检查 L0 识别:若 `repoKind`、`primaryLanguage`、`frameworks` 与仓库明显冲突,先停下修 profile/routing 问题,不要把后端仓库按前端默认继续扫。运行时支持可见 L0 worker 时,按 `repo-scout` skill 做浅分析复核;当前 harness 的确定性 baseline 仍是可执行兜底。

2. 读取状态:

```bash
npm run --silent understanding:harness -- status --package <package-dir>
```

3. 按 `nextAction` 分支:
   - `dispatch`:执行 `dispatch`,读取 manifest,让每个 bundle 按 `repo-explorer` 或 `repo-fact-verifier` 流程写出 output,再按 manifest 顺序串行 `ingest`。
   - `synthesize`:退出探索循环,先执行 `verify`,通过后进入 `repo-synthesizer`。
   - `done`:终止循环,进入报告与交付。

**子代理档位**:manifest 每个 bundle 带 `effort`(low/medium/high)。它是**默认先验,不是指令**——最终派什么档由你决定。**若你的运行时支持为子代理指定模型或推理档位**(如子代理调用参数、按次 CLI 覆盖、agent 定义文件等你运行时自己的机制),以 effort 为起点派遣:`low` → 你可用的最经济模型;`medium` → 默认;`high` → 与主线程同级或你可用的最高推理档;**并允许你基于自己掌握的信号上下调整**——bundle 任务量异常大或小、仓库明显复杂或简单、上一轮该 explorer 的接受率、剩余预算。调整时在轮次简报中说明一句理由。**唯一不可调整的是档位地板(约束第 9 条)**。若运行时不支持,忽略 effort,全部用默认——行为与不分档完全一致。

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
