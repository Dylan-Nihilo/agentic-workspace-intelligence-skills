---
name: agentic-coding-audit
description: Fill the coding pool inside a progressive workspace datasource for multi-repository software workspaces, especially micro-frontend systems. Use when Codex must collect static code evidence, run or incorporate deterministic tooling results, preserve Codex or agent analyses with evidence references, or export audit-data-compatible JSON from datasource/pools/coding.
---

# Agentic Coding Audit Skill

## Purpose

Use this skill to fill `datasource/pools/coding` for a local software workspace. The pool separates deterministic code evidence from Codex or agent analysis, then optionally exports a view-model compatible with an existing audit board.

Keep documentation/wiki knowledge pools separate. This skill owns coding evidence, coding facts, coding analyses, and coding exports only.

## Workflow

1. Identify the workspace root and datasource directory.
2. Read `references/coding-data-pool-schema.md` before changing or creating a data pool.
3. Run `scripts/collect-static.mjs --datasource <datasource>` or equivalent local commands to collect deterministic evidence.
4. Add Codex or agent analysis only under `analyses/`, with `evidenceRefs`, `producedBy`, `rationale`, and `confidence`.
5. Run `scripts/normalize-coding-pool.mjs --datasource <datasource>` to build a consolidated pool file and catch schema problems.
6. If a board or report needs the legacy shape, read `references/output-compatibility.md`, then run `scripts/export-audit-data.mjs`.

## Evidence Rules

- Treat `raw/` as immutable evidence. Do not edit raw evidence to make later analysis look cleaner.
- Treat `facts/` as deterministic normalization from raw evidence and tool output.
- Treat `analyses/` as human, Codex, or subagent judgment. Agent claims are not facts.
- Every non-obvious claim must cite at least one `evidenceRef`.
- Mark missing evidence as missing. Do not invent runtime, CI, SCA, monitoring, traffic, or business metrics.
- Prefer preserving existing useful output fields, but move provenance and agent reasoning upstream into the pool.

Read `references/evidence-taxonomy.md` when deciding whether something belongs in `raw/`, `facts/`, or `analyses/`.

## Script Usage

Collect static evidence:

```bash
node scripts/collect-static.mjs --workspace /path/to/workspace --out /path/to/coding-pool
node scripts/collect-static.mjs --workspace /path/to/workspace --datasource /path/to/datasource
```

Normalize the pool:

```bash
node scripts/normalize-coding-pool.mjs --pool /path/to/coding-pool
node scripts/normalize-coding-pool.mjs --datasource /path/to/datasource
```

Export audit-board-compatible JSON:

```bash
node scripts/export-audit-data.mjs --pool /path/to/coding-pool --out /path/to/audit-data.json
node scripts/export-audit-data.mjs --datasource /path/to/datasource
```

## Output Contract

Use the coding pool as the source of truth for coding data:

```text
datasource/pools/coding/
├── raw/
├── facts/
├── analyses/
├── exports/
└── index.json
```

The compatibility export may keep legacy fields such as `repos`, `referenceEdges`, `eslintRun`, `dimensionScores`, `score`, `grade`, and `risk`. It must not become the only source of truth.
