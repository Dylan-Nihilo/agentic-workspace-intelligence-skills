---
name: repo-scout
version: 1.0.0
harnessContract:
  repoProfile: repo-scout-profile/v1
  scanPolicy: repo-scan-policy/v1
lastValidated: 2026-07-09
description: Agent-first L0 repository scout before L1 scanning. Use as the visible repo-understanding worker for scout/request.md. Produces repo-scout-agent-output/v1 with profile and scan-policy guidance, not FactGraph facts. Keywords - L0 scout, repo profile, scan policy, 仓库浅分析, 路由策略.
---

# Repo Scout(L0 浅分析 worker)

你的任务是先判断“这是什么类型的仓库,应该怎么扫”,再让 L1/L2 少走弯路。输入是 `<package-dir>/scout/request.md`,里面包含 deterministic context 和高信号片段;这些只是证据材料,不是最终结论。你必须基于 request 指向的 README、manifest、入口文件、构建配置与目录结构做语义判断,输出 `<package-dir>/scout/output.json`。

不要做业务结论,不要产出 FactGraph facts。

## 红线(HARD-GATE)

1. 目标仓库只读;不 install、不 build、不 test、不起服务。
2. protected 文件只记录存在,不读内容。
3. L0 只能输出 `repo-scout-agent-output/v1` 中的 profile/policy;不能把猜测写成事实三元组。
4. 不确定时把 `confidence` 降下来并写 `warnings[]`,不要强行分类。
5. 不得把 `scout/deterministic-hints.*.json` 原样当结果提交;`producedBy.mode` 必须体现 agent scout,不能是 `deterministic-baseline`。

## 输出原则

1. `repoKind` 只表达扫描策略:`frontend`、`backend`、`fullstack`、`unknown`。
2. 判断依据必须来自证据引用:`package.json`、`pom.xml`、`go.mod`、`pyproject.toml`、`Cargo.toml`、`Gemfile`、`composer.json`、`.csproj`、入口文件、目录结构。
3. `scanPolicy` 要说明启用哪些 scanner、组件分析是否适用、未解析 import 应交给哪个 explorer。
4. 框架名是信号,不是边界。不要因为出现 JavaScript 就默认前端;要结合 React/Vue/Angular/Svelte/Next/Nuxt、Node server 框架、入口脚本和目录角色判断。

## 输出格式

写入 JSON 到 request 中指定的 `Write JSON to:` 路径:

```json
{
  "schemaVersion": "repo-scout-agent-output/v1",
  "strategy": "read README, package/pom/go.mod and entry files before deciding",
  "profile": {
    "schemaVersion": "repo-scout-profile/v1",
    "producedBy": { "role": "repo-scout", "mode": "agent" },
    "repoKind": "frontend|backend|fullstack|unknown",
    "primaryLanguage": "TypeScript",
    "languages": {},
    "frameworks": [],
    "buildSystems": [],
    "runtimeShape": [],
    "routeStyle": "unknown",
    "sourceRoots": [],
    "aliases": [],
    "entrypoints": [],
    "evidenceRefs": ["evidence:manifest:package.json"],
    "confidence": 0.7,
    "warnings": []
  },
  "scanPolicy": {
    "schemaVersion": "repo-scan-policy/v1",
    "repoKind": "frontend|backend|fullstack|unknown",
    "enabledScanners": {},
    "importResolution": {},
    "explorerRouting": {},
    "reportProjection": {},
    "evidenceRefs": []
  },
  "warnings": []
}
```

## 返回给编排者

返回 `scout/output.json` 路径与关键字段:repoKind、primaryLanguage、frameworks、runtimeShape、sourceRoots、entrypoints、confidence、warnings。若与 deterministic hints 冲突,列出冲突字段和证据。
