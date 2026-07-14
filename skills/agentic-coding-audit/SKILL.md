---
name: agentic-coding-audit
version: 1.0.0
lastValidated: 2026-07-07
description: Fill the coding pool (datasource/pools/coding) with DETERMINISTIC static code evidence and agent analyses that carry evidence references, then export audit-data-compatible JSON. Use to populate the coding pool of a multi-repository workspace datasource including micro-frontend systems — this writes a datasource pool, not a single-repository understanding package (for that use repo-understanding). Invoked by agentic-datasource-orchestrator. Keywords - coding pool, 静态代码证据, deterministic tooling, evidenceRefs, audit-data 导出.
---

# Agentic Coding Audit Skill

输入是本地软件 workspace 或已有 datasource;产出是 `datasource/pools/coding` 中的 raw evidence、deterministic facts、agent analyses 和兼容性 export。

## 红线(HARD-GATE)

1. [HARD-GATE: validateAgentAnalyses] `analyses/` 记录必须带 `evidenceRefs`、`producedBy`、`rationale`、`confidence` 等字段,否则 normalizer 拒绝。
2. [HARD-GATE: assertExportGate] export 前会重跑 analyses schema 与 freshness 检查;`coding-pool.json` 落后于 facts/analyses 时拒绝导出。

## 约束(PRINCIPLE)

1. coding pool 是 coding 数据源;文档/wiki/runtime/security/business 等池不要混进来。
2. `raw/` 是 append-only evidence;不要为了让分析更好看而改 raw。
3. `facts/` 是确定性归一化结果;`analyses/` 是带证据引用的判断,不是事实。
4. 每个非显然 claim 至少引用一个 `evidenceRef`;缺证据时标 missing。
5. 不要声称未测量的 runtime、CI、SCA、monitoring、traffic 或 business metrics 存在。
6. 数据池 schema 见 `references/coding-data-pool-schema.md`;证据分类见 `references/evidence-taxonomy.md`;兼容 export 见 `references/output-compatibility.md`。

## 流程

1. 确定 workspace root 和 datasource/pool 目录。
2. 读取 `references/coding-data-pool-schema.md`。
3. 收集静态证据:

```bash
node scripts/collect-static.mjs --workspace <workspace> --datasource <datasource>
```

4. 只在 `analyses/` 下添加人工或 agent 判断,并携带 evidenceRefs、rationale 与 confidence。
5. 归一化并校验:

```bash
node scripts/normalize-coding-pool.mjs --datasource <datasource>
```

6. 如需 legacy board/report shape,先读 `references/output-compatibility.md`,再导出:

```bash
node scripts/export-audit-data.mjs --datasource <datasource>
```

## 返回给编排者

返回 coding pool 路径、normalizer 结果、repositories/relationships/findings/agentAnalyses 计数、export 路径和缺失证据列表。
