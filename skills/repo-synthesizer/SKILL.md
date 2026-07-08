---
name: repo-synthesizer
version: 1.0.0
effort: high
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
4. **一律用简体中文书写**所有自然语言字段(`summary`、各 `responsibility`、`keyFlows[].name` 与 `steps`、`risks[].rationale`、`openQuestions`);文件路径、标识符、代码符号、专有名词保持原文。目标读者是中文使用者,人读层出现整段英文即不合格。

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
   - `businessDomains`(人读投影的业务分类,必填):**按业务功能而非 router/源码文件分组**。读 FactGraph 里的每个 `route` 节点及其 `routes-to` 证据中的中文注释,判断每条路由属于哪个业务,把它的顶层路径段归入某个域的 `prefixes`。每个域给 `name`(读者语言) + `description`(一句话业务作用) + `prefixes`(顶层路径段数组)。**杂糅型 router 必须拆开**(如银行、薪酬、记账路由不得挂在"发票"域下);每个顶层路径段只归一个域,入口/工具类路由归入一个"通用/其他"域。
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
