# Verifier Protocol

Use this reference when producing `repo-adversarial-verification/v1` output for `repo-fact-verifier`.

## Verdicts

- `refuted`: the evidence file or line range does not match the triple; the evidence text does not support the predicate; the code semantics contradict the edge; the import/route/guard/call is commented out, dead, or points elsewhere.
- `not-refuted`: you reopened the evidence location and the code supports the edge.
- `skipped`: the evidence is insufficient or runtime-only information is required. This is not confirmation.

## Load-Bearing Fields

Only `verdicts[]` carries the verifier decision. Harness code recalculates summary counts.

Each verdict needs:

- `edgeId`
- `verdict`
- `reason`
- `evidenceChecked`

## Independence Rule

Do not use the producer's reasoning. Reopen the evidence and try to disprove the edge from the evidence itself.
