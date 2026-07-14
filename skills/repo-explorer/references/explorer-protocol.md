# Repo Explorer Execution Protocol

Select exactly one mode from the dispatched artifact. Never combine outputs from the two modes.

## Shared boundary

- Keep the target repository read-only. Do not install dependencies, run builds/tests/servers, or read protected content.
- Stay inside the exact allowed source files, graph neighborhood, and line budget. Stop instead of widening scope.
- Treat parser/compiler failures, unresolved imports, protected access, unsupported syntax, and missing static bindings as deterministic diagnostics. Do not accept them as agent objectives or guess replacements.
- Every semantic assertion must cite at least one real source range with `sourcePath`, `startLine`, and `endLine`. The range must exist, remain inside the allowed files, and support the assertion directly.
- Write only the exact output artifact path or paths named by the dispatch. Never create alternate analysis files, edit authoritative stores, or invoke ingest.

# Mode A: Semantic ResearchContract

Use this mode only when executing `repo-research-contract/v1` as `repo-explorer` through a `kind=semantic-research` `repo-work-item/v3`.

## Accept the contract

Require all of the following before reading source:

- WorkItem kind is `semantic-research` and role is `repo-explorer`.
- WorkItem `contractRef` resolves to the same snapshot and InvestigationFrame.
- Questions, hypotheses, target maps/journeys, scope and acceptance criteria are explicit.
- Scope names allowed files or communities, entry entities and a finite neighbor depth.
- The objective is a semantic ambiguity, not a deterministic diagnostic.

Reject the task to the orchestrator when any condition fails. Do not repair the contract locally.

## Respect the deterministic boundary

Treat StaticProgramGraph records as deterministic context. Do not recreate or guess:

- parser/compiler results;
- import/export or module resolution;
- symbol declarations;
- route/render/state/API/auth static bindings;
- protected-file contents;
- unsupported syntax handling.

Use agent research only for business responsibility, product meaning, experience ownership, cross-segment flow meaning, feedback/outcome meaning and conflicts between plausible semantic explanations.

## Evaluate Hypotheses

For every `repo-hypothesis/v1`:

1. Reopen the allowed source evidence.
2. Record file, valid line range, stable evidence reference and a minimal snippet.
3. Search for counter-evidence as deliberately as supporting evidence.
4. Preserve qualifiers and boundary conditions.
5. Set exactly one status:
   - `supported`: evidence supports the statement and no material counter-evidence survives.
   - `refuted`: evidence contradicts the statement.
   - `inconclusive`: evidence is insufficient or competing explanations remain.
   - `proposed`: use only for a newly discovered candidate that still needs governance.

Never turn a Hypothesis directly into a Claim. Ingest owns that transition.

## Complete questions

Write one question outcome for every contract question. Use:

- `satisfied`: all blocking criteria are met or the premise is explicitly refuted.
- `partially-satisfied`: useful evidence exists, but one or more criteria remain unmet.
- `blocked`: runtime/external/product information is required.
- `failed`: protocol or execution failed.

Set the TaskOutcome status from the contract as a whole. A completed WorkResult only means the output files were produced.

## Route OpenQuestions

Use only:

- `semantic-ambiguity`
- `runtime-external-blocked`
- `product-intent`

Only `semantic-ambiguity` may be planned for another agent. Do not create OpenQuestions for parser failure, unresolved import, protected access, unsupported syntax, missing static binding or file coverage.

## Report scope and provenance

- Record every actually read file and SHA-256 content fingerprint in `readSet`.
- For repository source files, copy the current `static/static-program-graph.json` `files[].structureFingerprint` for that path. For the graph artifact itself, use its top-level `structureFingerprint`; use `null` only for deterministic artifacts without a governed structure fingerprint.
- Record any out-of-contract access attempt in `scopeViolations` and stop expanding.
- Hash the TaskOutcome artifact and report it in `artifactHashes`.
- Set `usage.status=reported` only for host-provided usage; otherwise set `unavailable`.
- Never omit negative results, counter-evidence or unmet criteria to make the outcome look satisfied.

# Mode B: Stage 6 Node Semantic Enrichment

Use this mode only for one bounded Stage 5 semantic batch. The batch must explicitly provide:

- snapshot and WorkItem identity;
- one or more target file paths with graph entity IDs;
- allowed source files and the necessary direct graph neighbors;
- deterministic AST/graph context references;
- a finite source-line or read budget;
- one exact output artifact path;
- `repo-node-semantic-catalog/v1` as the required output schema.

Reject an incomplete, free-text, whole-repository, coverage-driven, or mixed-mode batch before reading source.

## Inspect the bounded neighborhood

1. Confirm every target file and entity ID against the batch and Static Program Graph.
2. Start with the main target and read only enough allowed lines to explain its local semantics.
3. Read direct neighbors only when required to evidence an input, output, condition, or collaborator role.
4. Do not create entries for neighbor files unless the batch independently lists them as targets.
5. Stop when the line/read budget is reached. Preserve unresolved meaning as `unknowns`; do not request broader repository access implicitly.

AST summaries and graph edges are routing context, not substitutes for source-line evidence. Copy structural identity (`filePath`, `entityIds`, eligible `semanticKind`) from governed inputs rather than inferring it from directory names.

This mode never infers a Journey, cross-page business path, user role/goal, product intent, or route order. It never produces an API request/response parameter table.

## Build catalog entries

Write a valid `repo-node-semantic-catalog/v1` object with the batch snapshot, `status=partial`, the batch entries, and `generatedAt`.

For each target entry:

- `filePath` and `entityIds` must match the batch/graph.
- `scopeFiles` must include the target and only source files actually used from the allowed scope.
- `semanticKind` must be one of `page|view|component|route|state|service|shared-utility|config|other` and come from governed context.
- `title` must reuse a governed target label or evidenced source symbol, not an invented business label.
- `responsibility.summary` must describe only the file's local responsibility and must have source-line evidence.
- Every item in `inputs`, `actions`, `state`, `outputs`, `conditions`, and `boundaries` must contain `name`, `description`, honest confidence, and non-empty source-line evidence.
- Every `collaborators` role must refer to a directly scoped file and have non-empty source-line evidence.
- `unknowns` may only classify unresolved questions as `runtime|product-intent|out-of-scope`; they are questions, not factual claims.
- `producer.kind` is `agent`; `producer.workItemId` matches the dispatched identity.
- Use `status=draft` for agent-produced entries. Use `blocked` only when the entry still has a line-evidenced minimal responsibility but a required local meaning cannot be resolved. Deterministic acceptance owns promotion to `accepted`.

Evidence records contain paths and line ranges only. Do not embed source snippets. A local request call may be listed as an evidenced action/output, but do not enumerate API parameters, response fields, or an endpoint contract.

## Finish the batch

- Omit an entry rather than fabricate a responsibility when no valid source-line evidence exists; report the unprocessed target to the orchestrator.
- Never set the catalog to `complete`; one bounded worker cannot establish completion for all eligible nodes.
- Serialize only the catalog JSON at the exact output path supplied by the batch.
- Return the processed target count, draft/blocked counts, omitted target IDs, actual scoped reads, and budget status. Do not invoke merge, ingest, projection, or Journey synthesis.
