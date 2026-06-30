# Output Compatibility

Use this reference when exporting a coding pool into an existing audit board shape.

## Keep Existing Useful Fields

The legacy micro-frontend board shape is useful for visualization and can be preserved as an export:

```ts
type AuditDataExport = {
  generatedAt: string;
  workspace: string;
  root: string;
  evaluationFramework: unknown[];
  microApps?: unknown[];
  v3Rewrites?: unknown[];
  referenceEdges: LegacyEdge[];
  eslintRun?: unknown;
  tooling?: unknown;
  navigationModel?: unknown;
  repos: LegacyRepo[];
};
```

Preserve these repo fields when available:

- `name`, `path`, `gitRemote`, `local`
- `business`, `businessCriticality`, `domain`
- `entry`, `container`, `prefixPath`, `registered`
- `packageName`, `version`, `stack`, `ui`, `deps`, `lockFiles`
- `eslint`, `scripts`, `routeCount`, `tests`
- `issueCounts`, `issueExamples`, `scoreSignals`, `issues`
- `relations`, `dimensionScores`, `rawScore`, `scoreCaps`, `score`, `grade`, `risk`
- `evidenceConfidence`

## Mapping From Coding Pool

| Coding pool | Audit export |
| --- | --- |
| `repositories[]` | `repos[]` |
| `relationships[]` | `referenceEdges[]` |
| `findings[]` | `repos[].issues` or workspace issue sections |
| `agentAnalyses[]` | scoring rationale, business/domain labels, recommendations |
| `qualitySignals.lint` | `eslintRun` and repo lint fields |

## Compatibility Rule

The export is allowed to be lossy. It exists for rendering and reporting. Do not use it as the upstream source of truth once a coding pool exists.

If a legacy field cannot be produced from evidence, set a neutral value and include an agent analysis or finding that marks the missing evidence.
