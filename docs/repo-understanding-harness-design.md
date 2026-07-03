# Repo Understanding Harness Implementation Contract

This repo implements the design in `/Users/c0007/Desktop/yeepay projects/repo-understanding-harness-design.md`.

## Core Rule

Facts are unified, consumers are projections. `fact-graph.json` is the only semantic source of truth. `render-graph.json`, `knowledge-index.jsonl`, and `wiki/` are deterministic projections from the same graph.

## Pipeline

```text
repo
  -> L1 Scanner: inventory, code map, static facts, gap queue
  -> L2 Explorer: structured facts[] and openQuestions[] from gap tasks
  -> L3 Merger: schema validation, entity alignment, evidence binding, confidence merge, adversarial verification
  -> L4 Projector: render graph, knowledge index, wiki
```

## Output Layout

```text
out/<repo>/
  inventory.json
  gap-queue.json
  verification.json
  fact-graph.json
  store/
  render-graph.json
  knowledge-index.json
  knowledge-index.jsonl
  wiki/
  static/
    inventory.json
    code-map.json
    render-graph.json
    knowledge-index.json
```

`static/` exists for compatibility. New consumers should read top-level products.

## Commands

```bash
npm run understanding:harness -- analyze --repo /path/to/repo --out outputs/code-understanding/repo-name
npm run understanding:harness -- analyze --repo /path/to/repo --out outputs/code-understanding/repo-name --incremental --base HEAD
npm run understanding:harness -- project --package outputs/code-understanding/repo-name --only all
npm run understanding:harness -- verify --package outputs/code-understanding/repo-name
npm run understanding:harness -- serve --package outputs/code-understanding/repo-name --port 8787
```

Legacy entrypoints remain wired to the same core:

```bash
npm run understanding:run -- --repo /path/to/repo --out outputs/code-understanding/repo-name
npm run understanding:explore-request -- --package outputs/code-understanding/repo-name
npm run understanding:explore-dispatch -- --package outputs/code-understanding/repo-name
npm run understanding:collect-exploration -- --package outputs/code-understanding/repo-name
npm run understanding:request -- --package outputs/code-understanding/repo-name
npm run understanding:validate -- --package outputs/code-understanding/repo-name
```

## Gates

- Protected files are metadata-only.
- FactGraph edges must have evidence and confidence >= 0.5.
- Duplicate edges merge confidence with `1 - product(1 - c_i)`.
- Gap queue tasks are generated from coverage, unresolved import, low-confidence, and open-question signals.
- Low-confidence and inferred edges are checked by `verification.json`; refuted edges must not remain in FactGraph.
- Incremental mode writes `incremental.json`, reuses the previous FactGraph, invalidates changed file nodes and related edges, rescans only the changed file set, then regenerates projections.
- Render graph references must resolve.
- Knowledge JSONL `graphRefs` must resolve to FactGraph node or edge ids.
- Wiki fact lines must carry evidence marks.
