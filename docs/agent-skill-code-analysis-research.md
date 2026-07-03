# Agent Skill Code Analysis Research

调研时间: 2026-07-01

## 结论

代码分析和代码理解类 agent skill 的主流方向已经比较稳定: `Skill` 负责封装工作流和判断边界, 代码理解能力本身来自几类底座:

1. `repo map` / `code map`: 用 AST、符号表、调用关系和 import graph 给 agent 一个紧凑的全局视图。
2. `semantic index` / `codebase retrieval`: 对大仓库做 chunk、embedding、检索和增量索引。
3. `deterministic static analysis`: ESLint、Semgrep、CodeQL、SCA、test、build 等工具输出事实证据。
4. `knowledge graph`: 把文件、函数、配置、文档、路由、CI、数据表等抽成节点和边, 支撑问答、影响面分析和 dashboard。
5. `PR/diff review agent`: 面向变更而不是全仓, 结合 diff、issue、CI、代码库上下文和团队规则输出 review findings。
6. `local context orchestrator`: 典型是 RepoPrompt CE, 负责本地上下文选择、CodeMap、MCP/CLI agent harness 和多仓工作区。

对当前仓库而言, 最有价值的路线不是马上做一个纯聊天型 code understanding bot, 而是继续强化已有 `datasource/pools/coding` 契约: 确定性事实进 `raw/` 和 `facts/`, agent 判断进 `analyses/`, 所有结论都带 `evidenceRefs`。这个方向是对的。

## 当前仓库基线

当前仓库已经有三个核心 skill:

- `agentic-coding-audit`: 采集静态代码证据, 生成 `datasource/pools/coding`, 并导出 audit-board 兼容 JSON。
- `agentic-datasource-orchestrator`: 初始化 datasource, 编排 coding 和 CE bridge 阶段, 最终组装 `exports/workspace-datasource.json`。
- `agentic-ce-bridge`: 通过 RepoPrompt CE CLI/MCP 调用外部 agent, 把 CE 输出保存为 `AgentAnalysis`。

本仓库的关键设计优点:

- 已经区分 `raw`、`facts`、`analyses`、`exports`, 避免把 agent claim 当事实。
- CE 输出被定义为 `producedBy: "subagent"` 的分析记录, 并保留原始请求/响应。
- `manifest.json` 记录 stage completeness 和 missing evidence, 适合渐进式补全。

当前短板:

- 静态扫描仍偏正则和文件级统计, 还没有 AST symbol graph、call graph、route graph、SARIF import。
- `coding` pool 还没有专门的 code understanding 视图, 比如 architecture layers、guided tour、impact graph。
- CE bridge 已有契约, 但还没有形成可复用的 prompt templates 和验收脚本。
- `security`、`delivery`、`runtime`、`docs`、`business` 还没有实际 producer skill。

## 主流生态观察

### 1. Agent Skills 标准和 Codex/Claude 实现

`Agent Skill` 的共识形态是一个包含 `SKILL.md` 的目录, 可附带 `scripts/`、`references/`、`assets/` 等资源。OpenAI Codex 文档明确说明 skill 用于封装 task-specific capabilities, 支持 progressive disclosure, 先加载 name、description、path, 触发后才读取完整 `SKILL.md`。Claude Code docs 也采用相同思路, 并把 `/code-review`、`/debug`、`/run`、`/verify` 这类开发工作流做成 bundled skills。

启发:

- `description` 是触发器, 必须写清 “什么时候用, 什么时候不用”。
- `SKILL.md` 应该是 runbook, 不是长篇背景文档。
- 确定性逻辑放脚本, 判断性逻辑放 agent analysis。
- 一个 skill 只做一个 stage, 多 stage 由 orchestrator 编排。

### 2. Repo Map 和 Code Map

Aider 的 repository map 是代码理解工具里最值得学习的模式之一: 它把全仓的重要 classes、functions、types、call signatures 和关键定义行压缩成 token-efficient map, 让模型知道代码怎么连接。Aider 后续用 tree-sitter 构建 AST, 再用图排序在 token budget 内挑选最相关的符号。

RepoPrompt CE 也走类似方向, 但更强调 native macOS context engineering: 文件树、选中文件、line slices、CodeMaps、Git diffs、Context Builder、MCP/CLI agent orchestration、多 root workspace。

启发:

- 当前 `collect-static.mjs` 可以升级为 AST-backed collector。
- `RepositoryFact` 可以增加 `symbols`、`exports`、`imports`、`entrypoints`、`routes`。
- `RelationshipFact` 可以扩展 `calls`、`exports`、`imports`、`route-to-component`。
- 大仓库必须有 token budget 和 ranking, 不能把所有文件都塞给 agent。

### 3. Semantic Index 和 Codebase Retrieval

Cursor、Sourcegraph Cody、Continue 代表了另一条路线: 先建立代码库索引, 再让 agent 在问题发生时检索相关上下文。

- Cursor 公开描述了使用 Merkle tree 检测变更、对 syntactic chunks 生成 embeddings、缓存 unchanged chunks, 解决大仓库增量索引成本问题。
- Sourcegraph 强调 code search、code intelligence、Deep Search、Cody 这种跨仓上下文。
- Continue 提供 `@Codebase`、`@Folder`、`@Search`、`@Repository Map`、`@Git Diff` 等 context providers, 说明 agent 最需要的是可组合上下文入口。

启发:

- 当前仓库可以先不做 embedding, 先做 `repo map + rg search + static facts`。
- 如果后续做本地检索, 应先定义 `raw/index-manifest.json` 和 `facts/retrieval-index.json`, 不要把向量库当唯一事实源。
- 对内部多仓库, `workspace datasource` 比单仓 embedding 更重要, 因为业务关系和路由关系常跨 repo。

### 4. Deterministic Static Analysis

CodeQL 和 Semgrep 是 agent 代码审计必须接入的事实源:

- CodeQL 把代码视为可查询数据, 用 semantic code analysis 发现漏洞变体。
- GitHub code scanning 支持 CodeQL 和第三方 SARIF 工具, SARIF 是通用交换格式。
- Semgrep 是快速静态分析工具, 支持多语言, 规则像代码本身, 可在 IDE、pre-commit、CI/CD 中运行。

启发:

- 新增 `agentic-security-audit` 时, 不应该让 LLM 直接“看代码找漏洞”作为事实源。
- 正确做法是导入 Semgrep/CodeQL/SARIF 作为 `raw/tool-output`, 规范化为 `facts/findings`, 再让 agent 做 triage、影响面和修复建议。
- `severity`、`confidence`、`evidenceRefs` 要分离: 工具 severity 是事实字段, agent confidence 是判断字段。

### 5. PR Review 和 Diff Understanding

PR-Agent/Qodo 代表了成熟的 PR review agent 形态: `describe`、`review`、`improve`、`ask`、`add docs`、`labels` 等工具围绕 Pull Request 生命周期工作。Qodo v2 强调 multi-agent review、rule enforcement、context-aware feedback、full repository context、PR history 和 organization standards。

启发:

- 当前仓库可以新增 `agentic-diff-audit`:
  - 输入: git diff / PR diff / changed files。
  - 事实: changed files、changed symbols、test/build/lint output、相关 issue。
  - 分析: blast radius、affected repos、risk、review checklist。
  - 输出: `pools/coding/analyses/diff-*.json` 和 board/report view。
- Diff skill 必须只评论可证据支撑的问题, 不要生成“风格建议噪音”。

### 6. Knowledge Graph

本机已安装的 `understand-anything` skill 很有参考价值。它把 codebase understanding 拆成完整阶段:

1. scan project files。
2. compute semantic batches。
3. 并发 file analyzer 生成 GraphNode / GraphEdge。
4. merge and normalize。
5. architecture layers。
6. guided tour。
7. deterministic validation。
8. 保存 `.understand-anything/knowledge-graph.json`。

它的后续 skills, 如 `understand-chat`、`understand-diff`、`understand-explain`, 都复用同一个 graph, 只按需读取相关节点和一跳边。这是正确的形态: 先构建可验证结构, 再在结构上做问答和解释。

启发:

- 当前仓库可以做一个轻量版 `agentic-code-understanding`:
  - `facts/code-graph.json`: file、symbol、route、config、package、dependency nodes。
  - `facts/architecture-layers.json`: layer 和 nodeIds。
  - `analyses/tours/*.json`: agent 生成的新手 tour。
  - `analyses/explanations/*.json`: 针对模块/仓库的解释。
- 不必一开始就做 dashboard, 先把 schema 做稳。

## 本机 CE 状态

已验证本机 RepoPrompt CE CLI 存在:

```text
selected path: /Users/c0007/Library/Application Support/RepoPrompt CE/repoprompt_ce_cli_debug
PATH link: /Users/c0007/.local/bin/rpce-cli-debug
version: repoprompt_ce_cli_debug (repoprompt-mcp) 1.0.22
```

只读 smoke check:

```bash
rpce-cli-debug -e 'windows'
```

结果:

```text
Error: Cannot connect to RepoPrompt
The RepoPrompt app is not running or MCP is disabled.
```

判断:

- CLI 安装正常。
- 当前不可直接调用 workspace, 因为 RepoPrompt app 未运行或 MCP 未启用。
- `agentic-ce-bridge` 的 `detect-ce-cli.mjs` 可用。
- 真正跑 CE agent 前, 需要启动 RepoPrompt CE 并启用 Settings > MCP。

CE 可用能力来自 CLI help:

- `tree`: 文件树。
- `search`: 代码搜索。
- `read`: 文件读取。
- `structure`: code structure / codemap。
- `context_builder`: 自动构建上下文。
- `chat` / `plan` / `review`: oracle conversation。
- `agent_run`: start / wait / poll / steer / respond / cancel。
- `agent_manage`: list agents / sessions / logs / handoff。

这说明 CE 很适合作为当前仓库的外部 semantic analysis runtime, 但不应该替代 datasource 的事实层。

## 推荐的 Skill 分层

### A. `agentic-coding-audit`

定位: deterministic coding evidence collector。

下一步增强:

- 用 tree-sitter 或语言专用解析器提取 symbols/imports/exports。
- 支持 SARIF import。
- 支持 package manager graph。
- 支持 route scanner, 特别是 Vue/React router 和 micro-frontend 注册。
- 输出 `facts/code-map.json` 或合并进 `coding-pool.json`。

### B. `agentic-code-understanding`

定位: architecture understanding and code graph synthesis。

输入:

- `pools/coding/facts/coding-pool.json`
- `facts/code-map.json`
- 可选 README/docs/routes/package graph

输出:

- `pools/coding/facts/code-graph.json`
- `pools/coding/analyses/architecture-summary.json`
- `pools/coding/analyses/repo-tours/*.json`

规则:

- graph edges 必须来自 facts 或明确标注为 analysis。
- architecture layer 可以是 agent analysis, 但 `nodeIds` 必须引用已有事实节点。

### C. `agentic-ce-bridge`

定位: local CE semantic analysis provider。

下一步增强:

- 增加 CE prompt templates:
  - `architecture-risk`
  - `module-explain`
  - `cross-repo-impact`
  - `migration-risk`
  - `security-triage`
- 增加 `--dry-run` preview 输出检查。
- 增加 raw run replay 和 parse validator。
- CE 输出解析失败时, 保留 raw 并写低置信度 analysis。

### D. `agentic-diff-audit`

定位: PR/diff impact analysis。

输入:

- git diff / PR diff。
- existing coding pool。
- test/lint/build/SARIF output。

输出:

- changed components。
- affected components。
- risk assessment。
- review findings。
- suggested verification commands。

### E. `agentic-security-audit`

定位: security evidence and triage。

输入:

- Semgrep JSON。
- CodeQL/SARIF。
- dependency audit。
- secret scan。

输出:

- normalized security findings。
- false-positive triage analysis。
- remediation plan with evidenceRefs。

## 建议路线图

### Phase 1: 先把代码事实层做厚

1. 在 `agentic-coding-audit` 增加 AST-backed `code-map` collector。
2. 增加 SARIF import schema。
3. 把 `RelationshipFact.type` 扩展到 imports/exports/calls/routes。
4. 给 `export-audit-data.mjs` 保持向后兼容。

### Phase 2: 做轻量 code understanding

1. 新增 `agentic-code-understanding` skill。
2. 从 coding facts 构建 `code-graph.json`。
3. 生成 `architecture-summary`、`repo-tour`、`module-explain`。
4. 学 `understand-anything`: graph 先验证, chat/explain/diff 后复用。

### Phase 3: CE 作为外部 agent runtime

1. 保持 `agentic-ce-bridge` 只写 `analyses/`。
2. 增加 CE request templates 和 response validator。
3. 本地 CE 可用时才运行 `agent_run`; 不可用时生成 dry-run request。
4. 将 CE raw output 永久保存在 `raw/ce-runs/<run-id>/`。

### Phase 4: PR/diff 和 security

1. 加 `agentic-diff-audit` 生成影响面和 review findings。
2. 加 `agentic-security-audit` 导入 Semgrep/CodeQL/SARIF。
3. 最终由 orchestrator 合并 coding/security/delivery/runtime/docs/business pools。

## 不建议做的事

- 不要把 “LLM 看完整仓库后总结” 当主流程。成本高, 结果不可复现。
- 不要把 CE 输出写进 `facts/`。CE 是 agent analysis。
- 不要只做 embedding RAG。代码理解需要 symbols、imports、routes、tests、CI、runtime 证据。
- 不要让 review skill 生成无证据的风格建议。噪音会迅速毁掉信任。
- 不要把 audit-board JSON 作为源数据。它应该始终是 export, 不是 source of truth。

## 参考资料

- OpenAI Codex Agent Skills: https://developers.openai.com/codex/skills
- OpenAI Codex AGENTS.md guidance: https://developers.openai.com/codex/guides/agents-md
- Agent Skills open standard: https://agentskills.io/home
- Claude Code Skills: https://code.claude.com/docs/en/skills
- RepoPrompt CE: https://github.com/repoprompt/repoprompt-ce
- Aider repository map: https://aider.chat/docs/repomap.html
- Aider tree-sitter repo map: https://aider.chat/2023/10/22/repomap.html
- Cursor secure codebase indexing: https://cursor.com/blog/secure-codebase-indexing
- Sourcegraph docs: https://sourcegraph.com/docs
- Sourcegraph Cody codebase understanding: https://sourcegraph.com/blog/how-cody-understands-your-codebase
- Continue context providers: https://docs.continue.dev/customize/custom-providers
- Continue codebase/documentation awareness: https://docs.continue.dev/guides/codebase-documentation-awareness
- CodeQL: https://codeql.github.com/
- GitHub code scanning: https://docs.github.com/en/code-security/concepts/code-scanning/code-scanning
- Semgrep: https://github.com/semgrep/semgrep
- Semgrep security skills for AI agents: https://semgrep.dev/blog/2026/security-skills-ai-agents/
- PR-Agent docs: https://docs.pr-agent.ai/
- Qodo Code Review: https://docs.qodo.ai/code-review
- Awesome Codex Skills: https://github.com/composiohq/awesome-codex-skills
- Snyk developer skills roundup: https://snyk.io/articles/top-claude-skills-developers/
- Codebase Research skill example: https://mcpmarket.com/tools/skills/codebase-research-analysis

