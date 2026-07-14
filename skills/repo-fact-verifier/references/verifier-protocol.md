# Independent Semantic Verification Protocol

## Mode A: Node semantic review

Accept only a bounded Stage 6 review dispatch containing plan/batch identity, allowed files, the exact draft catalog path, catalog hash target and one review output path.

- Reopen the source; do not trust worker confidence or prose.
- For each material responsibility clause, require directly supporting line ranges.
- Reject generic evidence that proves only an import, export, request wrapper or component name.
- Check semanticKind against actual local role and incoming render/import relations.
- A collaborator target may remain outside allowedFiles when its role is proven entirely by an import/render/call in an allowed source file. Require the target in scope only if the review opens it or claims its internal behavior.
- Reject business meaning inferred only from directory, route or component names.
- Do not edit the catalog. Write only `repo-node-semantic-review/v1`.
- Mark the overall review `accepted` only when every entry passes responsibility evidence, semantic kind and unsupported-claim checks.
- Bind the review to the exact catalog with its SHA-256 hash.

## Mode B: Semantic adjudication

Use this protocol for `kind=adjudicate` ResearchContracts.

## Establish independence

- Reopen every cited source location.
- Ignore the producer's chain of thought and confidence label.
- Search for counter-evidence and competing semantic explanations.
- Stay inside allowed files, communities and neighbor depth.
- Record the actual readSet and fingerprints.

## Adjudicate Hypotheses

Set one `repo-hypothesis/v1` status:

- `supported`: direct evidence supports the semantic statement and material counter-evidence is resolved.
- `refuted`: direct evidence contradicts the statement or binds it to a different entity/Journey.
- `inconclusive`: evidence cannot distinguish the competing explanations.
- `proposed`: reserve for a follow-up candidate; never treat it as an adjudication win.

Do not create a Claim. Serial ingest governs Hypothesis-to-Claim conversion.

## Adjudicate Journey bindings

Check ordered steps and branches, not isolated text similarity. Inspect the relevant binding types:

- `page`
- `ui-element`
- `event`
- `handler`
- `effect`
- `state-transition`
- `request`
- `endpoint`
- `feedback`
- `outcome`

Treat `candidate`, `conflicted` and `missing` bindings as unresolved until evidence establishes the requested semantic connection. Never infer feedback or outcome merely because a request exists.

## Preserve the deterministic boundary

Do not adjudicate parser failures, unresolved imports, protected files, unsupported syntax, static graph integrity, artifact hashes or stale fingerprints. Return those to deterministic verification.

## Complete the outcome

- Use `satisfied` only when every blocking criterion is resolved.
- Use `partially-satisfied` when some adjudications are valid but blocking work remains.
- Use `blocked` when runtime/external or product information is required.
- Use `failed` for protocol or execution failure.

Classify unresolved questions only as `semantic-ambiguity`, `runtime-external-blocked` or `product-intent`. Only the first may enter agent planning.

Write a WorkResult v3 envelope with matching `contractId`, artifact hashes, readSet, scope violations and host-reported or unavailable usage. A completed envelope does not override an inconclusive TaskOutcome.
