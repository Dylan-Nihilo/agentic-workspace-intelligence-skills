---
name: repo-explorer
version: 1.0.0
harnessContract:
  dispatch: repo-explorer-dispatch/v1
  ingestResult: repo-harness-ingest-result/v1
  output: repo-exploration-analysis/v1
lastValidated: 2026-07-07
description: Produce new evidence-backed fact triples by read-only, targeted exploration of one dispatch bundle. Use for an L2 exploration task in the repo-understanding harness; produces facts (not verifies them — for refutation use repo-fact-verifier). Invoked by the repo-understanding orchestrator. Keywords - explorer bundle, gap task, 定向探索, fact 三元组, evidence, read-only.
---

# Repo Explorer(L2 探索 worker)

输入是一个 dispatch bundle 路径(`<package>/exploration/dispatch/round-<n>/<explorer>.md`);产出是可合并进 fact-graph 的 `repo-exploration-analysis/v1` JSON。谓词判定标准与反例见 `references/explorer-protocol.md`,动笔前先读。

## 红线(HARD-GATE)

1. [HARD-GATE: validateExplorerAnalysis] `predicate`、`source`、`confidence`、必填字段、非空 evidence、snippet 长度、inventory 文件存在性和 evidence 行号范围由 ingest 强制校验。

## 约束(PRINCIPLE)

1. 对目标仓库只读;不运行 install/build/test/server,不改任何文件。
2. 只处理 bundle 任务清单内的目标;探索中发现的新缺口写入 `openQuestions[]`,不扩围。
3. 每条 fact 必须有 file + line 范围 + snippet;没有行级证据支撑的判断是 openQuestion,不是 fact。
4. protected / metadata-only 文件不读内容、不引用、不推测其中的值。
5. evidence 行号必须真实存在;行号越界或 range 无效会被 ingest 拒绝。
6. 接近 bundle 标注 token 预算时停止扩展,提交已完成部分,剩余任务写 openQuestion。
7. ingest 返回 `{merged:false, issues:[...]}` 时必须按 issues 修正重试,不得把被拒绝的 JSON 当作已完成。

## 流程

1. 读 bundle,列出任务;按 `suggestedSearches` 与 relatedNodes 定位代码,小范围读行,不要整读大文件。
2. 按 bundle 内嵌 `## Output Schema` 逐项自检,补齐全部必填顶层字段:`schemaVersion`、`strategy`、`facts`、`openQuestions`、`observations`、`requestedEvidence`、`gaps`。
3. 把 JSON 写到 manifest 指定的 output 路径。
4. 若你是并行 worker,写完 output 后返回给编排者,由编排者串行 ingest。若你是在单会话顺序模式中代编排者执行,再回写:

```bash
npm run --silent understanding:harness -- ingest --package <package-dir> --analysis <output-file> --explorer <name> --round <n>
```

5. 处理返回:
   - `{merged:true, ...}`:完成,向编排者返回统计。
   - `{merged:false, issues:[...]}`:逐条修正 JSON,最多重试 2 次;仍失败时把失败原因整理成 openQuestion-only analysis 再 ingest 一次并如实上报 rejected。
6. 禁止为了通过校验而删除证据、编造行号或调高 confidence。

## 返回给编排者

返回处理任务数、facts 提交/接受数、openQuestions 数、是否触及预算上限、未覆盖任务列表。不要复述 facts 内容,它们已经落在 package output 里。
