# Repo Understanding v3 session handoff

## Resume instruction

Continue the active objective: finish the remaining repo-understanding v3 design and implementation. Read this handoff, inspect the current worktree, and fix the known gates in the order below. Do not restart the migration or restore deleted v2 files.

## Session metadata

- Workspace: `/Users/c0007/Desktop/yeepay projects/agentic-workspace-intelligence-skills`
- Branch: `main`
- HEAD: `836aee6`
- Original Claude session: `claude --resume 09671123-60f4-4977-b3b9-b08dbb1e61f7`
- Handoff time: `2026-07-13T10:53:00Z`
- Active objective: 完成剩余部分的设计

## Resumed session completion update

Status: implementation complete; the original P0/P1 list below is retained as the pre-resume snapshot and has been resolved.

- Workflow/event boundaries now reject legacy or malformed v3 state, WorkItems, event types, payloads, and mixed event chains.
- Product Map projection now fails before writing artifacts or events unless contracts, active work, blocking failures, and the authoritative Journey Set closure gate are clear. The default Journey closure rate remains 100%.
- Explicit verification has a projection floor and advances by artifact presence to synthesis or complete; final verification no longer downgrades a completed package.
- Canonical Journey refs now drive synthesis. Strict bundled narrative validation applies both at ingest and in the standalone HTML renderer.
- HTML completion emits `run-completed` exactly once. A standalone renderer cannot move an active workflow to `done`.
- Application Map carries the actual support level; HTML surfaces it, enforces canonical Journey files/default closure, preserves XSS escaping, and has valid section `aria-labelledby` targets.
- The unimplemented `frame-refine` / `repo-scout` path has been removed from the active suite. The five repo skills use minimal frontmatter and an executable v3 status loop.
- Root/workspace tests, package export smoke tests, completion trajectory, eight eval pillars, and fresh-agent forward tests cover the repaired gates.
- Final verification: kernel 61/61, CLI 1/1, trajectory PASS with 15 completion checks, and `eval:all` 8/8 pillars PASS. Forced eval failure propagation, `git diff --check`, JSON Schema parsing, and syntax checks over package/eval/skill `.mjs` files also pass.
- Fresh package smoke: an open product-intent Journey returns `nextAction=blocked`, keeps `terminal=null`, records `journey-closure-incomplete`, and creates no Product Map manifest.
- No commit was created. Preserve the existing migration worktree.

## Worktree safety boundary

- The worktree currently has 88 modified, deleted, or untracked paths, including this handoff.
- These include user-owned and pre-existing migration changes. Preserve them.
- Do not use `git reset --hard`, `git checkout --`, or restore deleted v2 harness files.
- No commit was created in this session.
- `git diff --check` currently passes.

## Confirmed product and architecture decisions

1. Replace the old repo-understanding flow as a whole; land the frontend path first.
2. A deterministic parser/compiler builds the Static Program Graph.
3. The semantic research chain is `InvestigationFrame -> ResearchContract -> WorkItem v3 -> TaskOutcome -> WorkResult v3`.
4. Parser, compiler, import, resolution, and protected-file failures are deterministic diagnostics. They must never become agent tasks.
5. OpenQuestion is limited to:
   - true semantic ambiguity with competing hypotheses;
   - runtime/external blockers;
   - product intent.
6. Backend and unknown repositories fail closed. Fullstack repositories analyze only a deterministically isolated frontend subtree.
7. Consumer outputs are Application Map, Experience Map, Runtime Flow Map, and Change Map.
8. Preserve snapshot/protected-file policy, serial ingest, event hash chain, Join semantics, governed Evidence/Claim storage, Journey closure, retries, and usage accounting.
9. Remove the old coverage/gap-driven loop, generic backend fallback, raw analysis ingest, and legacy architecture/domain/flow/wiki projection chain from the active contract.

## Implemented in the current worktree

- Strict v3 schemas for WorkItem, WorkResult, SupportDecision, InvestigationFrame, ResearchContract, Hypothesis, TaskOutcome, OpenQuestion, JourneyDefinition, JourneyBinding, run events, and run state.
- Frontend support gate and InvestigationFrame generation.
- Compiler-backed Static Program Graph with deterministic provenance and diagnostics.
- Community and neighbor planning.
- ResearchContract planning restricted to qualified semantic ambiguity.
- WorkItem v3 dispatch and WorkResult v3 envelope validation.
- TaskOutcome runtime validation, governed Hypothesis ingestion, Evidence/Claim materialization, and lifecycle events.
- Journey candidate derivation, authoritative Journey store, and closure verification.
- Four deterministic Product Maps with projection keys and staleness checks.
- Synthesis WorkItem v3, narrative validation, human-readable HTML, and final package verification.
- Skills and protocol references updated to v3; obsolete design documents now carry explicit archived/superseded headers.
- Package exports expose the v3 kernel surfaces.

## Original verification evidence (pre-resume)

- Manual end-to-end package: `/tmp/nova-v3-dispatch.LFYmIx`
  - qualified semantic ambiguity -> ResearchContract -> WorkItem v3;
  - valid WorkResult/TaskOutcome ingest;
  - 1 accepted Claim and 1 refuted Claim;
  - 2/2 Journeys closed;
  - four Product Maps generated;
  - synthesis accepted;
  - HTML generated;
  - final status `done` with `all-contracts-journeys-and-projections-closed`.
- Kernel tests:
  - `rg --files packages | rg '\.test\.mjs$' | xargs node --test`
  - Result: 31/31 passed.
- Current authoritative failing check:
  - `node evals/trajectory/run-trajectory.mjs`
  - Failure: `project --only maps` exits 0 while a WorkItem is still active; the eval expected rejection.
- Therefore `npm run eval:all` must not be reported green until the trajectory gate is fixed and rerun.

## Original known remaining gaps (resolved)

### P0: enforce workflow boundaries

1. `project()` currently bypasses Join and can publish Product Maps while WorkItems are `issued` or `result-produced`.
   - Fix with an explicit projection gate for active work, pending contracts, and unresolved blocking failures.
   - Preserve legitimate re-projection after accepted research or Journey updates.
2. `verify()` selects the `analysis` phase when maps are missing, so an incomplete package can return exit 0.
   - Explicit verify should require the projection phase when Product Maps are expected.
3. `ensureWorkflow()`, `materializeRunState()`, and `verifyEventChain()` do not reject legacy `repo-run-event/v2` streams.
   - Fail closed before materializing or appending v3 events.
4. `planAndIssueWorkItem()` does not call the strict WorkItem v3 validator.
   - Validate again at the kernel boundary; do not rely only on `createWorkItem()`.
5. `appendRunEvent()` accepts arbitrary event types/payloads, allowing a legacy WorkItem to enter through `work-planned`.
   - Enforce the v3 event enum and critical payload invariants.
6. Analyze currently reaches workflow state before legacy-package isolation and cleanup.
   - Detect a v2 package before `ensureWorkflow`; fail closed or require a fresh output directory rather than creating a mixed event chain.

### P1: close the v3 completion path

1. A rejected non-blocking contract is treated as no longer pending because status checks only test whether any item exists.
   - A contract is complete only when accepted or explicitly waived; partial/rejected work remains pending, deferred, or blocking according to policy.
2. Synthesis still reads old Journey JSONL paths.
   - Use `store/journeys/manifest.json` and its canonical definition, binding, and closure report refs.
3. `project --only html` silently returns `html: null` when narrative is absent and does not call final completion logic when successful.
   - Fail clearly or route to the guarded `html` command; ensure `run-completed` is emitted exactly once.
4. Synthesis narrative validation is partial and does not apply the strict bundled schema.
5. Add a completion eval covering `synthesize -> synthesis ingest -> html -> run-completed -> status done`.
6. Add a package-export smoke test and root/workspace `test` scripts so `npm test` is meaningful.
7. `frame-refine` is allowed by the workflow kind enum but has no CLI creator/ingest/retry path. Remove it until implemented or complete the path before exposing it.

## Original recommended next sequence (completed)

1. Add fail-closed v3 validation in `workflow-store.mjs` for event streams and `planAndIssueWorkItem()`.
2. Add the projection Join gate and correct explicit `verify` phase behavior.
3. Fix contract completion state for rejected/partial non-blocking work.
4. Replace synthesis Journey refs with canonical Journey store refs.
5. Fix HTML completion semantics and strict synthesis schema validation.
6. Add export/completion tests and package `test` scripts.
7. Run:

```bash
git diff --check
rg --files packages | rg '\.test\.mjs$' | xargs node --test
node evals/trajectory/run-trajectory.mjs
npm run eval:all
```

8. Only mark the goal complete when all checks pass and the legacy v2 injection cases are explicitly rejected.

## Communication preference for the resumed session

Dylan has experienced repeated UI stalls today. Use short tool calls and report after each closed checkpoint. Do not leave a long command or large file dump without a progress update.
