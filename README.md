<div align="center">

# Agentic Workspace Intelligence Skills

Evidence-backed repository understanding, runtime-neutral skill orchestration, and deterministic quality gates.

![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-2f6f4e?style=flat-square)
![Contract Eval](https://img.shields.io/badge/eval:contract-pass-1f7a4d?style=flat-square)
![Behavioral Eval](https://img.shields.io/badge/behavioral-pending-b7791f?style=flat-square)
![FactGraph](https://img.shields.io/badge/source%20of%20truth-fact--graph.json-2b6cb0?style=flat-square)

</div>

---

## What This Repo Is

This repository is a local intelligence workbench for turning a codebase into a verified understanding package. It combines a deterministic repo-understanding harness, a set of runtime-neutral skills, and contract evals that keep generated facts tied to source evidence.

The core rule is simple: `fact-graph.json` is the semantic source of truth. Human reports, HTML pages, render graphs, knowledge indexes, and wiki pages are projections from that graph.

<table>
  <tr>
    <td><strong>Harness</strong></td>
    <td>Scans one repository, builds static facts, dispatches exploration work, ingests structured discoveries, verifies evidence, and projects final artifacts.</td>
  </tr>
  <tr>
    <td><strong>Skills</strong></td>
    <td>Describe how an agent runtime should operate the harness without hand-editing generated JSON or bypassing gates.</td>
  </tr>
  <tr>
    <td><strong>Datasource tools</strong></td>
    <td>Collect deterministic coding evidence and external agent analyses into workspace datasource pools.</td>
  </tr>
  <tr>
    <td><strong>Evals</strong></td>
    <td>Lock the important contracts: schema versions, trusted verifier boundaries, coding-pool normalization, write gates, and status transitions.</td>
  </tr>
</table>

## System Shape

```mermaid
flowchart LR
  repo["Target repository"] --> scanner["L1 scanner<br/>inventory + static facts"]
  scanner --> queue["Gap queue<br/>coverage gaps + semantic hints"]
  queue --> dispatch["dispatch<br/>runtime-neutral work bundles"]
  dispatch --> explorer["L2 explorer<br/>read-only evidence gathering"]
  explorer --> ingest["ingest<br/>schema + evidence binding"]
  ingest --> graph["FactGraph<br/>single source of truth"]
  graph --> verifier["L3 verifier<br/>adversarial evidence checks"]
  verifier --> graph
  graph --> projector["L4 projector"]
  projector --> html["human-readable.html"]
  projector --> wiki["wiki / README"]
  projector --> render["render-graph.json"]
  projector --> knowledge["knowledge-index.jsonl"]
```

## Quick Start

```bash
npm run eval:contract
```

Analyze a repository:

```bash
npm run understanding:harness -- analyze \
  --repo /path/to/repo \
  --out outputs/code-understanding/repo-name
```

Check the package state:

```bash
npm run understanding:harness -- status \
  --package outputs/code-understanding/repo-name
```

Dispatch targeted exploration work:

```bash
npm run understanding:harness -- dispatch \
  --package outputs/code-understanding/repo-name \
  --max-tasks 8
```

Generate the human-readable HTML projection:

```bash
npm run understanding:harness -- html \
  --package outputs/code-understanding/repo-name
```

Run the full local eval suite:

```bash
npm run eval:all
```

Current eval semantics are deliberately honest: contract evals are asserted; behavioral and triggering evals are marked `PENDING` until their real test suites exist.

## Directory Map

```text
.
├── docs/                         design notes, remediation plans, and skill standardization records
├── evals/                        contract fixtures and regression checks
├── harnesses/repo-understanding/ deterministic CLI for repo understanding packages
├── scripts/                      legacy analyzer entrypoints
├── shared/                       single-source implementation logic used by harnesses and thin skill wrappers
├── skills/                       runtime-neutral skills and producer bridges
└── outputs/                      local generated packages, not source-of-truth code
```

## Important Commands

| Command | Purpose |
|---|---|
| `npm run understanding:harness -- analyze --repo <repo> --out <pkg>` | Build or refresh a repo-understanding package. |
| `npm run understanding:harness -- status --package <pkg>` | Return the next deterministic action: `dispatch`, `synthesize`, or `done`. |
| `npm run understanding:harness -- dispatch --package <pkg>` | Produce exploration bundles from the current gap queue. |
| `npm run understanding:harness -- ingest --package <pkg> --analysis <file>` | Merge a validated exploration result into the FactGraph. |
| `npm run understanding:harness -- verify --package <pkg>` | Validate graph, projections, evidence refs, and package integrity. |
| `npm run understanding:harness -- html --package <pkg>` | Render the self-contained human-readable HTML page. |
| `npm run coding:collect` | Collect deterministic coding evidence into a datasource pool. |
| `npm run coding:normalize` | Normalize and validate coding-pool analysis records. |
| `npm run datasource:pipeline` | Orchestrate datasource producer stages. |
| `npm run eval:contract` | Run contract-level regression checks. |
| `npm run eval:all` | Run the asserted contract suite and show deferred eval pillars explicitly. |

## Skills At A Glance

| Skill | Role | Writes through |
|---|---|---|
| `repo-understanding` | End-to-end orchestration for one repository. | `understanding:harness` verbs |
| `repo-explorer` | Read-only L2 evidence gathering for one dispatch bundle. | `ingest` |
| `repo-fact-verifier` | Attempts to refute existing low-confidence or inferred edges. | `ingest` verdict path |
| `repo-synthesizer` | Writes evidence-backed human synthesis after verification. | `write-subagent` |
| `repo-human-readable` | Renders a completed package into HTML. | read-only projection |
| `agentic-coding-audit` | Fills coding datasource pools from deterministic static evidence. | shared coding-pool gates |
| `agentic-ce-bridge` | Captures an external agent runtime and converts conclusions into pool analyses. | shared coding-pool ingest |
| `agentic-datasource-orchestrator` | Coordinates multi-repository datasource producer stages. | datasource pipeline |

## Quality Gates

The repository treats generated understanding as software, not prose. These gates are enforced by code and covered by contract checks:

- Protected files are metadata-only.
- Exploration output must pass schema validation before it can enter a package.
- Evidence line ranges must point to real source lines.
- Low-confidence and inferred edges are checked by deterministic verifier logic.
- External verifier tags cannot spoof deterministic verification.
- `producedBy` values stay inside the current coding-pool enum.
- Coding-pool exports fail when normalized facts are stale.
- CE parse failures preserve raw output and exit non-zero instead of fabricating analysis.
- Package writes use lock discipline.
- Human-readable projections consume completed packages; they do not edit source artifacts.

## Output Package

A completed package is shaped for both humans and machines:

```text
outputs/code-understanding/<repo>/
├── fact-graph.json
├── gap-queue.json
├── verification.json
├── render-graph.json
├── knowledge-index.json
├── knowledge-index.jsonl
├── human-readable.html
├── wiki/
└── static/
    ├── inventory.json
    ├── code-map.json
    ├── render-graph.json
    └── knowledge-index.json
```

`static/` is kept for compatibility with older consumers. New consumers should prefer the top-level products unless a downstream contract says otherwise.

## Development Notes

- Keep deterministic logic in `shared/` or `harnesses/`; skills should stay thin.
- Do not hand-edit generated package JSON. Use `dispatch`, `ingest`, `write-subagent`, `project`, and `verify`.
- Keep runtime-specific names out of general skill instructions unless the skill is explicitly a bridge to that runtime.
- Treat `outputs/` as local build output unless a specific package is intentionally being reviewed.
- When a new gate is added, pair it with a contract fixture.

## Reference Trail

- [Repo Understanding Harness](harnesses/repo-understanding/README.md)
- [Harness Skill Plan](docs/harness-skill-plan.md)
- [Skill Standardization Design](docs/skill-standardization-design.md)
- [Skill Standardization Remediation](docs/skill-standardization-remediation.md)
- [Human Readable Layer Design](docs/human-readable-layer-design.md)
- [Contract Evals](evals/README.md)
