# Evidence Taxonomy

Use this reference to classify data before writing it to the pool.

## Classes

| Class | Location | Examples | Can derive scores directly? |
| --- | --- | --- | --- |
| Raw static evidence | `raw/` | `package.json`, git remote, source scan sample | no |
| Raw command evidence | `raw/` | ESLint JSON, test output, build log | no |
| Raw runtime evidence | `raw/` | browser audit, RUM export, monitoring snapshot | no |
| Normalized fact | `facts/` | repo entity, relationship edge, issue count | yes, if deterministic |
| Agent claim | `analyses/` | business criticality, architecture risk, recommendation | no, cite evidence |
| Compatibility export | `exports/` | `audit-data.json` for board rendering | no, derived view |

## Provenance Requirements

Each raw evidence file should be referenced by a stable `evidenceRef` with:

- `id`
- `layer`
- `path`
- `kind`
- `summary`

Each fact, finding, relationship, or agent analysis should carry `evidenceRefs`.

## Agent Participation

Codex or subagents participate in static analysis by reading deterministic facts and writing `AgentAnalysis` records. They may:

- classify business/domain intent from repo names, routes, and code context
- explain architecture risk from relationships and source references
- produce scoring rationale
- recommend remediation
- identify uncertainty and missing evidence

They must not:

- silently rewrite raw evidence
- present unmeasured runtime behavior as measured
- claim CI, SCA, monitoring, traffic, or SLA data exists without evidence
- overwrite script facts when the disagreement is only semantic

## Confidence

- `high`: claim is directly supported by multiple strong evidence refs or an explicit source file.
- `medium`: claim is supported by indirect but coherent evidence.
- `low`: claim is plausible but needs confirmation. Low-confidence claims must not drive hard score caps.
