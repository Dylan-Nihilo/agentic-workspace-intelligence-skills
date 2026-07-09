# Repo Understanding Harness

This harness turns one local repository into one evidence-backed FactGraph and projects that graph into three consumer surfaces:

- human/wiki: `wiki/`
- human/html: `human-readable.html`
- mp micro rendering: `render-graph.json`
- agent/RAG retrieval: `knowledge-index.jsonl`

The rule is: facts are unified, consumers are projections. New output must be derived from `fact-graph.json`, not from ad hoc JSON files.

## Flow

```text
repo
  -> L0 scout: repo-profile + scan-policy from manifests, language mix, entrypoints, runtime signals
  -> L1 scanner: inventory + code-map + static facts + gap queue routed by scan-policy
  -> L2 explorer: structured facts[] + openQuestions[] from gap tasks
  -> L3 merger: schema checks + entity alignment + confidence merge + adversarial verification
  -> L4 projector: wiki/ + human-readable.html + render-graph.json + knowledge-index.jsonl
```

The harness keeps Codex as the runtime for L2. It does not silently spawn agents. It generates an exploration request, accepts structured JSON back, fetches safe evidence, and merges facts into the graph.

## Commands

```bash
npm run understanding:harness -- analyze --repo /path/to/repo --out outputs/code-understanding/repo-name
npm run understanding:harness -- analyze --repo /path/to/repo --out outputs/code-understanding/repo-name --incremental --base HEAD
npm run understanding:harness -- project --package outputs/code-understanding/repo-name --only all
npm run understanding:harness -- html --package outputs/code-understanding/repo-name
npm run understanding:harness -- verify --package outputs/code-understanding/repo-name
npm run understanding:harness -- serve --package outputs/code-understanding/repo-name --port 8787
```

Incremental analyze reuses the previous `fact-graph.json`, invalidates changed file nodes and their related edges, rescans only the changed file set, then regenerates all projections.

Compatibility scripts still work:

```bash
npm run understanding:run -- --repo /path/to/repo --out outputs/code-understanding/repo-name
npm run understanding:explore-request -- --package outputs/code-understanding/repo-name
npm run understanding:explore-dispatch -- --package outputs/code-understanding/repo-name
node harnesses/repo-understanding/scripts/write-exploration-analysis.mjs --package outputs/code-understanding/repo-name --analysis /path/to/exploration.json --session optional-session-id
npm run understanding:collect-exploration -- --package outputs/code-understanding/repo-name
npm run understanding:request -- --package outputs/code-understanding/repo-name
node harnesses/repo-understanding/scripts/write-subagent-analysis.mjs --package outputs/code-understanding/repo-name --analysis /path/to/subagent-output.json --session optional-session-id
npm run understanding:validate -- --package outputs/code-understanding/repo-name
```

## Output Contract

```text
out/<repo>/
  inventory.json
  repo-profile.json
  scan-policy.json
  gap-queue.json
  verification.json
  fact-graph.json
  store/
  render-graph.json
  knowledge-index.json
  knowledge-index.jsonl
  human-readable.html
  wiki/
  static/
    inventory.json
    code-map.json
    repo-profile.json
    scan-policy.json
    render-graph.json
    knowledge-index.json
```

`static/` is kept for older consumers. The authoritative products are the top-level files.

## Explorer Contract

The exploration request expects JSON shaped around `facts[]`:

```json
{
  "schemaVersion": "repo-exploration-analysis/v1",
  "facts": [
    {
      "subject": "file:src/router/index.ts",
      "predicate": "routes-to",
      "object": { "type": "route", "label": "/orders", "path": "src/router/index.ts" },
      "source": "dynamic",
      "confidence": 0.7,
      "explorer": "route-binding",
      "evidence": [
        { "file": "src/router/index.ts", "line": 42, "endLine": 44, "tool": "repo-explorer", "rawConfidence": 0.7 }
      ]
    }
  ],
  "openQuestions": []
}
```

Free-text observations are accepted for backward compatibility, but only `facts[]` can enter `fact-graph.json`.

## Quality Gates

- protected files are metadata-only.
- FactGraph edges must have evidence and confidence >= 0.5.
- gap queue tasks must resolve to FactGraph node or edge ids.
- low-confidence and inferred edges must be checked by `verification.json`; refuted edges must not remain in FactGraph.
- render graph must have no dangling references.
- knowledge-index JSONL `graphRefs` must resolve to FactGraph nodes or edges.
- wiki pages must carry evidence marks like `[e:edge-id -> file:line]`.
