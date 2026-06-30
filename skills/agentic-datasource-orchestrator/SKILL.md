---
name: agentic-datasource-orchestrator
description: Coordinate a family of lightweight skills that progressively fill a complete workspace datasource. Use when Codex must initialize datasource manifests, run coding and CE bridge stages in order, track stage completeness and missing evidence, merge pools into exports/workspace-datasource.json, or plan later docs, runtime, delivery, security, and business analysis stages.
---

# Agentic Datasource Orchestrator

## Purpose

Use this skill as the top-level coordinator for progressive datasource builds. It does not own domain analysis; it runs producer skills and merges their pool outputs.

## Skill Family

- `agentic-coding-audit`: fills `pools/coding` with static code facts, findings, and audit-board exports.
- `agentic-ce-bridge`: uses RepoPrompt CE CLI/MCP as the first external agent runtime and writes CE conclusions into `analyses/`.
- Future skills should fill `pools/docs`, `pools/runtime`, `pools/delivery`, `pools/security`, and `pools/business`.

## Workflow

1. Read `../../shared/references/workspace-datasource-schema.md`.
2. Initialize the datasource manifest with `../../shared/scripts/init-datasource.mjs`.
3. Run producer skills in stages. Each stage writes only its pool.
4. Update `manifest.json` after each stage with `../../shared/scripts/update-stage.mjs`.
5. Build `exports/workspace-datasource.json` with `../../shared/scripts/build-workspace-datasource.mjs`.
6. Treat incomplete stages as explicit missing evidence, not failure.

## Quick Pipeline

Run a static coding pipeline:

```bash
node scripts/run-pipeline.mjs \
  --workspace /path/to/workspace \
  --datasource /path/to/datasource \
  --max-files 8000
```

Prepare a CE analysis request without executing CE:

```bash
node scripts/run-pipeline.mjs \
  --workspace /path/to/workspace \
  --datasource /path/to/datasource \
  --prepare-ce \
  --ce-subject repo:mp-galaxy \
  --ce-task architecture-risk
```

Run CE only when explicitly intended:

```bash
node scripts/run-pipeline.mjs \
  --workspace /path/to/workspace \
  --datasource /path/to/datasource \
  --run-ce \
  --ce-subject repo:mp-galaxy \
  --ce-task architecture-risk
```

## Design Rule

The final datasource is assembled, not directly edited. Producers write pool data; the orchestrator updates status and builds exports.
