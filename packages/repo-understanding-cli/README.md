# Repo Understanding CLI v3

This CLI turns a supported frontend repository snapshot into a deterministic Static Program Graph, governed semantic knowledge, four product-facing maps, and a human-readable result.

Backend and unknown repositories fail closed. A full-stack repository is analyzed only inside its deterministically identified frontend roots.

## Pipeline

```text
frontend census
  -> SupportDecision
  -> compiler Static Program Graph
  -> CommunityMap + NeighborMap
  -> InvestigationFrame
  -> bounded node-semantic batches
  -> node-semantic Agent results -> independent semantic reviews
  -> serial semantic acceptance
  -> complete Node Semantic Catalog
  -> qualified semantic OpenQuestions
  -> ResearchContract -> WorkItem v3 -> TaskOutcome -> serial ingest
  -> authoritative JourneyDefinition/JourneyBinding closure
  -> Application / Experience / Runtime Flow / Change Maps
  -> synthesis narrative v3
  -> human-readable HTML
```

Parser, compiler, import-resolution, and file failures remain deterministic diagnostics. Runtime-only evidence and product intent remain explicitly blocked. Only semantic ambiguity with competing hypotheses can create a ResearchContract.

`repository-atlas.html` is the progressive deterministic surface. It is available after static analysis, remains valid when semantic research is blocked, and is refreshed by the CLI as later stages mutate package state. Its stage controls show the verified artifact delta at each step, while the dependency view starts with one top-down layer and expands on demand in either direction. It is intentionally separate from the Journey-gated `human-readable.html` delivery.

```bash
npm run --silent understanding:harness -- atlas --package /path/to/package
```

The CLI does not spawn an agent runtime. For Stage 6 it emits bounded node-semantic contexts; for Stage 7 and later it emits governed WorkItems. The host chooses workers and concurrency. A different Agent must review each Stage 6 result and bind its verdict to the exact catalog hash. Only `semantic-ingest` or `ingest` may mutate their corresponding authoritative stores.

## Commands

```bash
npm run understanding:harness -- scout --repo /path/to/repo --out /path/to/package
npm run understanding:harness -- analyze --repo /path/to/repo --out /path/to/package --mode fast
npm run understanding:harness -- status --package /path/to/package
npm run understanding:harness -- semantic-plan --package /path/to/package --max-files 8 --max-source-bytes 262144
npm run understanding:harness -- semantic-review-plan --package /path/to/package
npm run understanding:harness -- semantic-ingest --package /path/to/package
npm run understanding:harness -- journeys --package /path/to/package --definitions /path/to/definitions.json --bindings /path/to/bindings.json
npm run understanding:harness -- dispatch --package /path/to/package --max-tasks 8
npm run understanding:harness -- ingest --package /path/to/package --work-result /path/to/work-result.json
npm run understanding:harness -- retry --package /path/to/package --item work:id
npm run understanding:harness -- project --package /path/to/package --only maps
npm run understanding:harness -- synthesize --package /path/to/package
npm run understanding:harness -- html --package /path/to/package
npm run understanding:harness -- verify --package /path/to/package
npm run understanding:harness -- report --package /path/to/package
npm run understanding:harness -- debug --package /path/to/package
npm run understanding:harness -- serve --package /path/to/package --port 8787
```

Always follow `status.nextAction`. `blocked` is a real terminal gate until the named runtime evidence, product input, failed WorkItem, semantic question, or Journey closure issue is resolved.

## Authoritative artifacts

```text
package/
  static/
    inventory.json
    code-map.json
    repo-profile.json
    support-decision.json
    static-program-graph.json
    community-map.json
    neighbor-map.json
    investigation-frame.json
  planning/
    node-semantic-batches.json
    open-questions.json
    manifest.json
    contracts/*.json
  research/
    node-semantics/contexts/*.json
    node-semantics/results/*.json
    node-semantics/review-dispatch/*.review-dispatch.json
    node-semantics/reviews/*.review.json
    dispatch/*
  work/
    items/*.json
    results/*.json
  state/
    run-config.json
    run-state.json
  store/
    evidence.jsonl
    claims.jsonl
    semantic-store-manifest.json
    node-semantics.json
    run-events.jsonl
    journeys/
  projections/
    application-map.json
    experience-map.json
    runtime-flow-map.json
    change-map.json
    manifest.json
  synthesis/narrative.json
  verification/frontend-verification.json
  human-readable.html
```

`store/evidence.jsonl` and `store/claims.jsonl` are governed semantic knowledge. Journey truth lives under `store/journeys/`. The four Product Maps are the public structured interface; `human-readable.html` consumes those maps, Journey Store, and the accepted narrative only.

## Completion gates

- SupportDecision, snapshot, graph, semantic store, and InvestigationFrame agree.
- Node Semantic Catalog has accepted every eligible Vue/JavaScript/TypeScript/HTML file before Journey exploration starts.
- No blocking WorkItem is active, rejected without a retry, or partially accepted.
- Critical semantic questions are resolved; runtime and product-intent blockers are explicit.
- Every critical Journey is closed against the current graph and governed knowledge.
- All four Product Maps match their content hashes and projection key.
- The narrative references the current maps, accepted Claims, Evidence, Journeys, and limitations.
- HTML is generated from current governed artifacts and passes the complete verifier.
