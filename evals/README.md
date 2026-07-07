# Skill Standardization Evals

This directory contains regression checks for the skill standardization contract.

- `contract/`: deterministic harness contract checks.
- `fixtures/mini-repo/`: small repository used by contract tests.
- `fixtures/coding-pool/`: datasource pool normalization fixtures for valid and rejected `AgentAnalysis` paths.
- `fixtures/golden/`: frozen expected contract literals.
- `behavioral/` and `triggering/`: reserved for later Wave 1/Wave 2 expansion.

The coding-pool golden is a characterization of the current shared `AgentAnalysis`
ingest/validation behavior after manual review. It does not prove equivalence with
private validator copies that were removed before this golden existed.
