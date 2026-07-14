---
name: agentic-datasource-orchestrator
version: 1.0.0
lastValidated: 2026-07-07
description: Coordinate producer skills that progressively fill a MULTI-REPOSITORY workspace datasource, then merge their pools into exports/workspace-datasource.json. Use when you need to run coding/CE producer stages in order, track stage completeness and missing evidence, and assemble the workspace datasource — NOT to build a single-repository understanding package and Product Maps (use repo-understanding). Keywords - workspace datasource, pool 合并, 多仓协调, stage 完整度, exports/workspace-datasource.json.
---

# Agentic Datasource Orchestrator

输入是一个多仓 workspace 和 datasource 目录;产出是分阶段填充的 datasource pools 以及 `exports/workspace-datasource.json`。它只协调 producer skills,不直接拥有领域分析。

## 红线(HARD-GATE)

1. [HARD-GATE: assertExternalExecutionConfirmed] 外部 agent runtime 执行必须同时提供 `--run-ce --confirm-external` 和 `AGENTIC_CONFIRM_EXTERNAL=run-ce`;默认只 prepare。

## 约束(PRINCIPLE)

1. 最终 datasource 是 assembled,不是直接手改。producer 只写自己的 pool,orchestrator 更新状态并构建 export。
2. 每个 producer stage 的缺失证据要显式记录,不要把 incomplete 当 failure 或 success。
3. 不要把未验证的 producer 输出描述成已通过 datasource 总闸门;以各 producer gate 为准,coding 走 normalize/export gate,CE 走 shared ingest gate。
4. repo 单仓理解包与 Product Maps 应交给 `repo-understanding`,不要用 workspace datasource 代替。
5. 阶段契约见 `references/pipeline-contract.md`。

## 流程

1. 读取 `../../shared/references/workspace-datasource-schema.md` 与 `references/pipeline-contract.md`。
2. 初始化 datasource manifest:

```bash
node ../../shared/scripts/init-datasource.mjs --workspace <workspace> --datasource <datasource>
```

3. 运行 producer stages。常规 coding pipeline 使用:

```bash
node scripts/run-pipeline.mjs --workspace <workspace> --datasource <datasource> --max-files <n>
```

4. 若只准备外部分析请求,加 `--prepare-ce`;真正执行外部 runtime 需:

```bash
AGENTIC_CONFIRM_EXTERNAL=run-ce node scripts/run-pipeline.mjs --workspace <workspace> --datasource <datasource> --run-ce --confirm-external --ce-subject <repo:id>
```
5. 每个 stage 结束后更新 manifest,再构建 `exports/workspace-datasource.json`:

```bash
node ../../shared/scripts/build-workspace-datasource.mjs --datasource <datasource>
```

## 返回给编排者

返回 datasource 路径、已完成 stage、缺失证据列表、生成的 `exports/workspace-datasource.json` 路径,以及是否触发过外部执行。
