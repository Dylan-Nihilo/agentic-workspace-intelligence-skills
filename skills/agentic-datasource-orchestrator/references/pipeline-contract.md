# Pipeline Contract

The orchestrator treats every producer skill as a stage that fills one datasource pool.

## Stages

```text
coding      deterministic code evidence and coding analyses
ce-bridge   external CE agent analyses written into pools
docs        future documentation/wiki evidence
runtime     future browser/runtime/RUM evidence
delivery    future CI/CD/release evidence
security    future SCA/secrets/auth evidence
business    future business impact evidence
synthesis   final assembled datasource and exports
```

## Producer Contract

Each producer must:

1. Write under `datasource/pools/<pool>`.
2. Preserve raw evidence under `raw/`.
3. Write deterministic facts under `facts/`.
4. Write agent claims under `analyses/`.
5. Leave final cross-pool assembly to the orchestrator.

## External Runtime Strategy

When an external runtime is enabled through `agentic-ce-bridge`, its output must be captured as `AgentAnalysis` records. Later native or provider-specific implementations can replace that runtime while preserving the same datasource contract.
