# Workspace Datasource Schema

This is the shared contract for the skill family. Each skill progressively fills one pool under a common datasource. The final datasource is assembled from pools and exports.

## Directory Layout

```text
datasource/
├── manifest.json
├── pools/
│   ├── coding/
│   ├── docs/
│   ├── runtime/
│   ├── delivery/
│   ├── security/
│   └── business/
└── exports/
    ├── audit-board/
    ├── reports/
    └── workspace-datasource.json
```

## Manifest

```ts
type WorkspaceDatasourceManifest = {
  schemaVersion: "workspace-datasource/v1";
  generatedAt: string;
  workspace: {
    root: string;
    name: string;
    detectedAt: string;
  };
  stages: DatasourceStage[];
  completeness: Record<string, number>;
  pools: Record<string, { path: string; status: string }>;
  exports: Record<string, string>;
};

type DatasourceStage = {
  id:
    | "coding"
    | "ce-bridge"
    | "docs"
    | "runtime"
    | "delivery"
    | "security"
    | "business"
    | "synthesis";
  status: "pending" | "running" | "partial" | "complete" | "failed";
  producedBy: string;
  outputRef?: string;
  missingEvidence: string[];
  updatedAt: string;
};
```

## Stage Ownership

| Stage | First implementation | Output |
| --- | --- | --- |
| `coding` | `agentic-coding-audit` | `pools/coding/facts/coding-pool.json` |
| `ce-bridge` | `agentic-ce-bridge` | `pools/*/analyses/*.json` plus CE raw runs |
| `docs` | future docs skill | document/wiki pool |
| `runtime` | future runtime skill | browser/RUM/monitoring pool |
| `delivery` | future delivery skill | CI/CD/build/release pool |
| `security` | future security skill | SCA/secrets/authz pool |
| `business` | future business skill | domain/SLA/traffic/impact pool |
| `synthesis` | `agentic-datasource-orchestrator` | `exports/workspace-datasource.json` |

## Completion Rule

Complete means the stage has either produced evidence-backed data or explicitly recorded missing evidence. It does not mean every possible field is filled.
