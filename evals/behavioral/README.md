# Behavioral Evals

Executable workflow regressions for the frontend-first v3 protocol:

- blocking failed WorkResult cannot pass and a v3 retry creates a new attempt;
- completed TaskOutcome must pass orchestrator ingest before Product Map projection;
- unavailable usage remains explicit and is never estimated;
- snapshot mismatch is rejected;
- changed snapshots archive completed runs and reject transitions with in-flight WorkItems;
- append-only RunEvent tampering is detected.

Run with `npm run eval:behavioral`.
