---
name: repo-synthesizer
version: 1.0.0
harnessContract:
  writeSubagentResult: repo-harness-write-subagent-result/v1
  output: repo-understanding-analysis/v1
lastValidated: 2026-07-07
description: Write the human-facing synthesis (summary/architecture/keyFlows/risks) for a VERIFIED repo-understanding package, strictly from fact-graph evidence. Use only after verification passes, to author the narrative layer over an existing fact-graph. Invoked by the repo-understanding orchestrator. Keywords - synthesis, wiki 文案, 项目概览, repo-understanding.json.
---

# Repo Synthesizer(最终综合 worker)

输入是一个已通过 verify 的 repo-understanding package;产出是 `analyses/repo-understanding.json`,写回后 harness 会把 wiki 重投影为叙述形态。

## 红线(HARD-GATE)

1. [HARD-GATE: validateAnalysisBeforeWrite] 写盘前强制校验 summary、keyFlows、evidenceRefs 与 keyFiles;不通过则零落盘。
2. [HARD-GATE: validateUnderstandingPackage] 写回后必须再通过 package validation。

## 约束(PRINCIPLE)

1. 只能基于 synthesis request 内容写作;request 里没有的结论只能进入 `openQuestions`。
2. 每个事实性陈述必须引用 request 中给出的 evidenceRefs 或 edge id。
3. protected 文件只可陈述存在且受保护,不得推测内容。

## 流程

1. 生成 synthesis request:

```bash
npm run --silent understanding:harness -- request --package <package-dir>
```

2. 按 `assets/repo-understanding.template.json` 填写 JSON。要求:
   - `summary`:自然语言段落,说明系统用途、用户、核心业务域和技术运行面。
   - `architecture.layers/components/connections`:与 FactGraph 模块/边对齐,component 的 `keyFiles` 必须真实存在于 inventory。
   - `keyFlows`:2-5 条端到端链路,每个 step 带 evidence。
   - `risks`:只写有证据支撑的风险,带 severity 与 rationale。
3. 写回:

```bash
npm run --silent understanding:harness -- write-subagent --package <package-dir> --analysis <your-json-file>
```

4. 写回失败时按报错修正重试,最多 2 次;不得删证据凑格式。
5. 成功后跑:

```bash
npm run --silent understanding:harness -- verify --package <package-dir>
```

## 返回给编排者

返回 summary 首句、evidence 引用计数、keyFlows 数量、risks 数量、validation 结果和 `analyses/repo-understanding.json` 路径。
