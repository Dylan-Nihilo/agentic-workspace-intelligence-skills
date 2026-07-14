# Repo Understanding Evals

This directory contains regression checks for the skill standardization contract.

- `contract/`: frontend-first v3 acceptance checks for support scope, Static Program Graph provenance, ResearchContract routing, TaskOutcome acceptance, Journey closure, Product Maps, stale hashes, and removal of gap/coverage artifacts.
- `datasource/`: preserved coding-pool, audit export, external-runtime confirmation, and CE bridge contract gates.
- `fixtures/react-mini-repo/`, `fixtures/journey-react-mini-repo/`, `fixtures/node-api-mini-repo/`, and `fixtures/fullstack-mini-repo/`: frontend, closed-Journey, backend, and mixed-repository support fixtures used by the contract eval.
- `fixtures/coding-pool/`: datasource pool normalization fixtures for valid and rejected `AgentAnalysis` paths.
- `fixtures/golden/`: frozen datasource coding-pool characterization only; v3 repo-understanding acceptance is executable rather than snapshot-based.
- `behavioral/`: executable workflow trajectory, retry, snapshot, event-integrity, and usage-reporting checks.
- `triggering/`: executable routing and runtime-neutral skill prose checks.
- `knowledge/`: governed Claim/Evidence integrity, accepted/refuted semantics, WorkItem provenance, and Product Map support checks.
- `retrieval/`: four-map retrieval Hit@2/MRR, Evidence resolution, shared projection key, and output-size checks.
- `trajectory/`: event order, hash continuity, Join, and gate-bypass checks.
- `cost/`: exact host-reported usage and accepted agent Claim efficiency checks.
- `real-repos/`: caller-provided fast/deep v3 benchmark for support scope, Static Program Graph, semantic store, ResearchContracts, Journey closure, Product Maps, verification, and package size.

Run every pillar with `npm run eval:all`.

The coding-pool golden is a characterization of the current shared `AgentAnalysis`
ingest/validation behavior after manual review. It does not prove equivalence with
private validator copies that were removed before this golden existed.
