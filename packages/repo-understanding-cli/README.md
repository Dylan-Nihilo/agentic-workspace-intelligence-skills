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
  -> Domain Agent context (no preclassification)
  -> Domain Agent proposal -> independent Agent review -> serial acceptance
  -> progressive Repository Atlas regions over the current S6 expansion
  -> Stage 7 delivery boundary
  -> Domain interpreter summaries -> independent Agent review -> serial acceptance
  -> Stage 8 responsibility / entry / core / boundary projection on the same tree
  -> optional governed Journey research (separate follow-up)
  -> qualified semantic OpenQuestions
  -> ResearchContract -> WorkItem v3 -> TaskOutcome -> serial ingest
  -> authoritative JourneyDefinition/JourneyBinding closure
  -> Application / Experience / Runtime Flow / Change Maps
  -> synthesis narrative v3
  -> human-readable HTML
```

Parser, compiler, import-resolution, and file failures remain deterministic diagnostics. Runtime-only evidence and product intent remain explicitly blocked. Only semantic ambiguity with competing hypotheses can create a ResearchContract.

`repository-atlas.html` is the progressive deterministic surface. It is available after static analysis, remains valid when semantic research is blocked, and is refreshed by the CLI as later stages mutate package state. Its stage controls show the verified artifact delta at each step, while the dependency view starts with one top-down layer and expands on demand in either direction. Stage 7 reuses that exact visible-node set, expansion state, and top-down tree. It may stably cluster the already-selected siblings by semantic region, then paints non-rectangular low-contrast territories behind the visible branches as expansion changes. Stage 8 keeps that tree and those positions, adds entry/core/boundary badges, and lets a domain title focus the relevant cards while a companion panel explains responsibility, collaborations, outputs, and unknowns. Every file keeps one canonical full card: ordinary reuse becomes a shared reference, while an ancestor cycle becomes a compact event-loop reference back to that card. It never eagerly renders the whole repository or replaces the tree with a second graph. It is intentionally separate from the Journey-gated `human-readable.html` delivery.

```bash
npm run --silent understanding:harness -- atlas --package /path/to/package
```

The CLI does not spawn an agent runtime. For Stage 6 it emits bounded node-semantic contexts. For Stage 7, `zone-plan` emits an Agent-only domain-analysis contract and context; it creates no domains or memberships. A `repo-domain-analyzer` proposes repository-specific domains from accepted S6 semantics and graph relations, a different `repo-domain-verifier` reviews the exact proposal hash, and only `zone-ingest` can publish `planning/repository-zones.json`. For Stage 8, `domain-summary-plan` freezes those reviewed memberships and emits evidence-rich per-domain context. A `repo-domain-interpreter` explains every reviewed domain, a separate `repo-domain-summary-verifier` reviews the exact draft hash, and only `domain-summary-ingest` publishes `store/repository-domain-summaries.json`. The kernel neither classifies domains nor invents their responsibilities. Later governed Journey research still uses WorkItems.

## Commands

```bash
npm run understanding:harness -- scout --repo /path/to/repo --out /path/to/package
npm run understanding:harness -- analyze --repo /path/to/repo --out /path/to/package --mode fast
npm run understanding:harness -- status --package /path/to/package
npm run understanding:harness -- semantic-plan --package /path/to/package --max-files 8 --max-source-bytes 262144
npm run understanding:harness -- semantic-review-plan --package /path/to/package
npm run understanding:harness -- semantic-ingest --package /path/to/package
npm run understanding:harness -- zone-plan --package /path/to/package
npm run understanding:harness -- zone-review-plan --package /path/to/package
npm run understanding:harness -- zone-ingest --package /path/to/package
npm run understanding:harness -- domain-summary-plan --package /path/to/package
npm run understanding:harness -- domain-summary-review-plan --package /path/to/package
npm run understanding:harness -- domain-summary-ingest --package /path/to/package
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
    repository-zone-agent-plan.json
    repository-domain-summary-agent-plan.json
    repository-zones.json
    open-questions.json
    manifest.json
    contracts/*.json
  research/
    node-semantics/contexts/*.json
    node-semantics/results/*.json
    node-semantics/review-dispatch/*.review-dispatch.json
    node-semantics/reviews/*.review.json
    repository-zones/context.json
    repository-zones/result.json
    repository-zones/review.json
    repository-domain-summaries/context.json
    repository-domain-summaries/result.json
    repository-domain-summaries/review.json
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
    repository-domain-summaries.json
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
- Node Semantic Catalog has accepted every eligible Vue/JavaScript/TypeScript/HTML file before Stage 7 domain zoning starts.
- Repository zones come from the Domain Agent, cover every inventory file once, and pass an independent review bound to the exact proposal hash.
- Repository domain summaries preserve the reviewed Stage 7 titles and memberships, cover every domain once, ground positive claims in accepted semantics or real directed graph relations, and pass an independent review bound to the exact draft hash.
- No blocking WorkItem is active, rejected without a retry, or partially accepted.
- Critical semantic questions are resolved; runtime and product-intent blockers are explicit.
- Every critical Journey is closed against the current graph and governed knowledge.
- All four Product Maps match their content hashes and projection key.
- The narrative references the current maps, accepted Claims, Evidence, Journeys, and limitations.
- HTML is generated from current governed artifacts and passes the complete verifier.
