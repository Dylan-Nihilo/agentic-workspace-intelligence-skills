# Coding Data Pool Schema

This reference defines the coding-only data pool. It is inspired by LLM wiki layering, but adapted for code audits rather than documents. In the skill family, this pool normally lives at `datasource/pools/coding`.

## Layer Model

| Layer | Directory | Owner | Mutability | Purpose |
| --- | --- | --- | --- | --- |
| Raw evidence | `raw/` | scripts/tools | append-only | Original tool output, package metadata, source scan samples |
| Normalized facts | `facts/` | scripts/tools | reproducible | Deterministic entities, relationships, metrics, findings |
| Agent analysis | `analyses/` | Codex/agents/humans | replaceable with provenance | Judgments, explanations, risk calls, recommendations |
| Exports | `exports/` | scripts | reproducible | Board/report-specific view models |
| Index | `index.json` | scripts | reproducible | Pool manifest, generation metadata, counts, schema version |

Do not mix documentation/wiki data into this pool. A documentation pool can reference this pool by IDs, but should have its own schema.

## Pool Manifest

`index.json`:

```ts
type CodingPoolIndex = {
  schemaVersion: "coding-pool/v1";
  generatedAt: string;
  workspace: WorkspaceMeta;
  layers: {
    raw: LayerSummary;
    facts: LayerSummary;
    analyses: LayerSummary;
    exports: LayerSummary;
  };
  counts: {
    repositories: number;
    relationships: number;
    findings: number;
    agentAnalyses: number;
  };
  files: string[];
};
```

## Consolidated Pool

`facts/coding-pool.json`:

```ts
type CodingPool = {
  schemaVersion: "coding-pool/v1";
  generatedAt: string;
  workspace: WorkspaceMeta;
  runs: AnalysisRun[];
  repositories: RepositoryFact[];
  relationships: RelationshipFact[];
  findings: Finding[];
  agentAnalyses: AgentAnalysis[];
};
```

## Core Types

```ts
type WorkspaceMeta = {
  root: string;
  name: string;
  detectedAt: string;
};

type AnalysisRun = {
  id: string;
  startedAt: string;
  completedAt: string;
  producedBy: "script" | "codex" | "subagent" | "human";
  command?: string;
  inputRefs: string[];
  outputRefs: string[];
};

type EvidenceRef = {
  id: string;
  layer: "raw" | "facts" | "analyses";
  path: string;
  kind:
    | "package-json"
    | "git"
    | "source-scan"
    | "tool-output"
    | "eslint"
    | "runtime"
    | "agent-claim";
  summary: string;
};

type RepositoryFact = {
  id: string;
  name: string;
  path: string;
  local: boolean;
  gitRemote?: string;
  packageName?: string;
  version?: string;
  stack: string[];
  scripts: Record<string, string>;
  deps: Record<string, string>;
  devDeps: Record<string, string>;
  lockFiles: string[];
  sourceStats: SourceStats;
  qualitySignals: QualitySignals;
  evidenceRefs: string[];
};

type SourceStats = {
  filesScanned: number;
  extensionCounts: Record<string, number>;
  routeCount: number;
  testFileCount: number;
};

type QualitySignals = {
  issueCounts: Record<string, number>;
  issueExamples: IssueExample[];
  lint?: ToolRunSummary;
  build?: ToolRunSummary;
  test?: ToolRunSummary;
};

type IssueExample = {
  ruleId: string;
  file: string;
  line: number;
  snippet: string;
};

type ToolRunSummary = {
  status: "passed" | "failed" | "skipped" | "missing";
  command?: string;
  errors?: number;
  warnings?: number;
  outputRef?: string;
};

type RelationshipFact = {
  id: string;
  type:
    | "micro-frontend-register"
    | "route-rewrite"
    | "source-reference"
    | "package-dependency"
    | "runtime-call";
  from: string;
  to: string;
  label: string;
  evidenceRefs: string[];
};

type Finding = {
  id: string;
  subject: { type: "repo" | "workspace" | "relationship"; id: string };
  category: "architecture" | "engineering" | "security" | "stability" | "experience" | "business";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  evidenceRefs: string[];
};

type AgentAnalysis = {
  id: string;
  subject: { type: "repo" | "workspace" | "relationship"; id: string };
  producedBy: "codex" | "subagent" | "human";
  promptRef?: string;
  evidenceRefs: string[];
  claim: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
  createdAt: string;
};
```

## Static and Dynamic Coding Data

Use these meanings consistently:

- Static data: repo inventory, package metadata, source scan results, route scan, dependency scan, git metadata.
- Dynamic command data: ESLint, build, test, typecheck, SCA, or CI command output.
- Runtime data: browser checks, RUM, monitoring, SLI/SLO, deployed route health, network calls.
- Agent data: Codex or subagent interpretations based on cited evidence.

The first version may only collect static and dynamic command data. Runtime data must be marked missing unless actually measured.
