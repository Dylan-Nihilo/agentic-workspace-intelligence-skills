# CE CLI Contract

RepoPrompt CE is the first agent runtime for this skill family. The local debug CLI can be reached through either a PATH link or the direct fallback:

```text
/usr/local/bin/rpce-cli-debug
$HOME/Library/Application Support/RepoPrompt CE/repoprompt_ce_cli_debug
```

The CE repo documents this smoke flow:

```bash
rpce-cli-debug -e 'windows'
rpce-cli-debug -w 1 -e 'workspace switch <workspace-name>'
rpce-cli-debug -w 1 -c agent_manage -j '{"op":"list_agents","roles_only":true}'
rpce-cli-debug -w 1 -c agent_run -j '{"op":"start","model_id":"explore","session_name":"...","message":"...","detach":true}'
rpce-cli-debug -w 1 -c agent_run -j '{"op":"wait","session_id":"<session_id>","timeout":120}'
```

## Expected Agent Output

Ask CE agents to return only JSON matching `AgentAnalysis[]`:

```json
[
  {
    "id": "analysis:repo:mp-galaxy:architecture-risk",
    "subject": { "type": "repo", "id": "repo:mp-galaxy" },
    "producedBy": "subagent",
    "provider": "repoprompt-ce",
    "evidenceRefs": ["evidence:raw:raw/repositories/mp-galaxy/package.json"],
    "claim": "Short claim.",
    "rationale": "Evidence-backed rationale.",
    "confidence": "medium",
    "createdAt": "2026-06-30T00:00:00.000Z"
  }
]
```

`producedBy` remains `subagent` because the datasource schema treats CE as an external agent runtime. Use `provider: "repoprompt-ce"` as an extra field.

## Raw Output Policy

Always preserve CE raw request and response under:

```text
pools/<pool>/raw/ce-runs/<run-id>/
├── request.json
├── start.stdout.txt
├── start.stderr.txt
├── wait.stdout.txt
└── wait.stderr.txt
```

Then write parsed analyses to:

```text
pools/<pool>/analyses/<run-id>.json
```
