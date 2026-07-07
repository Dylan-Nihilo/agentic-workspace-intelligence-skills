---
name: agentic-ce-bridge
version: 1.0.0
lastValidated: 2026-07-07
description: Run an EXTERNAL agent runtime over a workspace datasource, capture its raw run output, and convert its conclusions into pool analyses/*.json with evidence references. Use to bridge an external code-understanding agent into a datasource pool — this produces external-subagent analyses (for deterministic static evidence use agentic-coding-audit). Invoked by agentic-datasource-orchestrator. Keywords - external agent runtime, CE bridge, raw run 捕获, pool analyses, subagent analysis.
---

# Agentic CE Bridge

输入是已有 workspace datasource 和目标 pool;产出是保留 raw run 的外部 agent analysis,写入 `pools/<pool>/analyses/*.json`。

## 红线(HARD-GATE)

1. [HARD-GATE: ingestAgentAnalyses] 写入 `pools/<pool>/analyses/*.json` 必须走 shared datasource ingest 原语,并通过 schema/证据 gate。
2. [HARD-GATE: assertCeParsed] CE 输出 parse 失败时只保留 raw 与 `ce-run-failed.json`,不得合成伪 analysis,并以非零退出。

## 约束(PRINCIPLE)

1. 外部 agent output 是 analysis,不是 raw fact;不能覆盖 `raw/` 或 `facts/`。
2. 外部 agent 输出不是 deterministic facts;只能作为带证据引用的 `agentAnalyses`。
3. 外部 runtime 结果必须保留 raw;parse 失败只上报失败标记。
4. 默认 prepare/dry-run;只有明确授权时才真正执行外部 runtime。
5. CLI 与 raw output 契约见 `references/ce-cli-contract.md`。

## 流程

1. 读取 `references/ce-cli-contract.md`。
2. 检测本地外部 agent CLI:

```bash
node scripts/detect-ce-cli.mjs
```

3. 确认 datasource 存在且目标 pool 已有 facts。
4. 默认只准备请求:

```bash
node scripts/run-ce-analysis.mjs --datasource <datasource> --pool <pool> --subject <subject> --task <task> --message <message> --dry-run
```

5. 去掉 `--dry-run` 只在外部执行被明确授权时使用。
6. 执行后保存 raw run,把可解析结论写入 `pools/<pool>/analyses/*.json`,再运行对应 producer normalizer;parse 失败时查看 raw run 下的 `ce-run-failed.json`。

## 返回给编排者

返回 raw run 目录、analysis 文件路径、normalizer 结果、parse 是否成功、是否执行了外部 runtime,以及任何缺失证据。
