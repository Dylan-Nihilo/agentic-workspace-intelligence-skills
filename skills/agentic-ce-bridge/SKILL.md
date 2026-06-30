---
name: agentic-ce-bridge
description: Use RepoPrompt CE CLI or MCP as the first agent runtime for workspace datasource analysis. Use when Codex must call CE agent_run, capture CE raw output, convert CE conclusions into datasource pool analyses, or bridge CE-produced codebase understanding into analyses/*.json before later replacing CE with a native implementation.
---

# Agentic CE Bridge

## Purpose

Use this skill to run RepoPrompt CE as an external agent runtime and write its output into an existing datasource pool. CE output is agent analysis, not deterministic fact.

## Workflow

1. Read `references/ce-cli-contract.md`.
2. Detect the CE CLI with `scripts/detect-ce-cli.mjs`.
3. Ensure the target datasource exists and the target pool has facts.
4. Run CE with `scripts/run-ce-analysis.mjs`, or manually call CE MCP/CLI and save the raw run under `pools/<pool>/raw/ce-runs/`.
5. Write parsed CE conclusions into `pools/<pool>/analyses/*.json` as `AgentAnalysis` records.
6. Re-run the producing pool normalizer, such as `agentic-coding-audit/scripts/normalize-coding-pool.mjs`.

## Boundaries

- Use CE for semantic analysis, architecture explanation, risk interpretation, and context exploration.
- Do not use CE output as raw facts unless CE is only relaying deterministic tool output.
- Do not overwrite `raw/` or `facts/` based on a CE conclusion.
- If CE cannot produce strict JSON, preserve the raw output and create a low-confidence analysis that points to the raw run.

## Commands

Detect CE:

```bash
node scripts/detect-ce-cli.mjs
```

Prepare or run CE analysis:

```bash
node scripts/run-ce-analysis.mjs \
  --datasource /path/to/datasource \
  --pool coding \
  --subject repo:mp-galaxy \
  --task architecture-risk \
  --message "Analyze this repository using the coding pool facts." \
  --dry-run
```

Remove `--dry-run` only when CE is running and agent execution is intended.
