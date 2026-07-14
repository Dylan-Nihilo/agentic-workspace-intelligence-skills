# Skill 规范化构建指南（执行者：Codex）

> v1 历史构建指南；其中旧 schema、raw ingest 与 write-subagent 要求已删除。

> 本文是 `docs/skill-standardization-design.md` 的**施工版**：把设计拆成带精确文件路径、精确 before/after、可验证验收的任务。
> **动手前先读**：`docs/skill-standardization-design.md`（设计与理由）、`docs/harness-skill-plan.md`（pull 模型 + 4 条红线）。
> 套件共 **8 个 skill**：`repo-understanding` / `repo-explorer` / `repo-fact-verifier` / `repo-synthesizer` / `repo-human-readable` / `agentic-datasource-orchestrator` / `agentic-coding-audit` / `agentic-ce-bridge`。

---

## 0. 护栏（每个任务都适用，违反即回退）

**必须做到：**
- **G-A** 只在被明确授权的 Wave 内改文件。Wave 0 是纯文档，**不得**改 `harnesses/` / `shared/` 下任何 `.mjs` 逻辑。
- **G-B** SKILL.md 正文 runtime 中立：不出现 `Codex`、`RepoPrompt CE`、`agent_run`、`codex exec`、`Task tool`、`MCP` 承诺。用能力条件句（"若你的运行时支持并行子代理，则…；否则顺序执行"）。
- **G-C** 不把 validate/merge/normalize/project **逻辑**放进 skill 目录。skill 里的脚本只能是薄封装（转发参数 / spawn / 落 raw）。`repo-human-readable/scripts/generate-html.mjs` 只 import `shared/understanding/human-readable-html.mjs`，是合规样板——照它的形态。
- **G-D** `[HARD-GATE]` 标签**只能**贴在能指到真实 `throw`/`exit≠0` 路径的约束上（按**函数符号**核对，不按行号）。指不到就标 `[PRINCIPLE]` 并写 `TODO(H-xx)`。见 §Wave0-T3 的标签对照表。
- **G-E** 契约测试 / lint 断言一律锚定**函数符号 + schemaVersion 字符串字面量**，绝不写死绝对行号。

**禁止：**
- 改数据层的 `producedBy` 值。runtime 中立只改 **prose**；`producedBy` 仍必须是 `codex`/`subagent`/`human`（`normalize-coding-pool.mjs` 的真实枚举），否则触发 exit 2。要发 `agent` 必须先扩枚举（属 Wave 2/3，不在重写范围）。
- 删除任何现有确定性 gate（尤其 `normalize-coding-pool.mjs` 的 `process.exit(2)`），在其共享替代上线前。
- 把 G-5..G-8（wiki 证据溯源、import-resolver 等 fact-graph 数据质量问题）掺进本次改造——它们正交，另行处理。

---

## Wave 0 — 纯文档重写（现在做，零 harness 风险）

四个任务，8 个 skill 全覆盖。全部只改 `skills/*/SKILL.md` 与新增 `skills/*/CHANGELOG.md`。

### Wave0-T1 · frontmatter 加版本

每个 `skills/<name>/SKILL.md` 的 frontmatter 当前恰为 `{name, description}`。改为：

```yaml
---
name: <不变>
version: 1.0.0
harnessContract:            # 仅 repo-* + repo-human-readable 需要；agentic-* 见下
  <见每 skill 备注>
lastValidated: 2026-07-07
description: <见 Wave0-T2 的重写值>
---
```

- **repo-\* 五个**（understanding/explorer/fact-verifier/synthesizer/human-readable）填 `harnessContract`，值取该 skill 实际消费的 schemaVersion（explorer 例：`dispatch: repo-explorer-dispatch/v1` / `ingestResult: repo-harness-ingest-result/v1` / `output: repo-exploration-analysis/v1`；其余按各自命令的输出契约填，拿不准的先只填能确认的项）。
- **agentic-\* 三个**暂无稳定 harness 契约版本，`harnessContract` 先省略，只加 `version` + `lastValidated`。
- **验收**：`grep -L '^version:' skills/*/SKILL.md` 输出为空（8 个都有 version）。

### Wave0-T2 · description 路由化重写（8 条精确值）

逐个把 `skills/<name>/SKILL.md:3` 的 `description` 整体替换为下列字符串（已消歧 + runtime 中立，可直接用）：

**repo-understanding**
```
Orchestrate end-to-end understanding of a SINGLE repository into an evidence-backed fact-graph, narrative wiki, and knowledge index. Use when the user asks to understand/analyze one codebase, build a repo wiki, or produce a repo knowledge graph — NOT to build a multi-repo workspace datasource (use agentic-datasource-orchestrator). Keywords - 理解仓库, 分析单个代码库, repo wiki, fact-graph, 架构分析.
```
**repo-explorer**
```
Produce new evidence-backed fact triples by read-only, targeted exploration of one dispatch bundle. Use for an L2 exploration task in the repo-understanding harness; produces facts (not verifies them — for refutation use repo-fact-verifier). Invoked by the repo-understanding orchestrator. Keywords - explorer bundle, gap task, 定向探索, fact 三元组, evidence, read-only.
```
**repo-fact-verifier**
```
Adversarially refute low-confidence or inferred edges that already exist in a repo-understanding fact-graph — attempt to disprove each edge using only its own evidence. Use for adversarial-verify tasks; consumes existing edges (does NOT produce new facts — for exploration use repo-explorer). Invoked by the repo-understanding orchestrator. Keywords - 对抗校验, refute, 低置信度, verifier, edge 校验.
```
**repo-synthesizer**
```
Write the human-facing synthesis (summary/architecture/keyFlows/risks) for a VERIFIED repo-understanding package, strictly from fact-graph evidence. Use only after verification passes, to author the narrative layer over an existing fact-graph. Invoked by the repo-understanding orchestrator. Keywords - synthesis, wiki 文案, 项目概览, repo-understanding.json.
```
**repo-human-readable**
```
Render a self-contained human-readable HTML PAGE from an already-complete repo-understanding package (architecture SVG, evidence summaries, quality gates). Read-only consumer projection — edits no source artifact. Use to produce a shareable HTML view of an EXISTING package, not to build or synthesize it (use repo-understanding / repo-synthesizer). Keywords - HTML 页面, 自包含, human-readable projection, 架构图, package 可视化.
```
**agentic-datasource-orchestrator**
```
Coordinate producer skills that progressively fill a MULTI-REPOSITORY workspace datasource, then merge their pools into exports/workspace-datasource.json. Use when you need to run coding/CE producer stages in order, track stage completeness and missing evidence, and assemble the workspace datasource — NOT to build a single-repo fact-graph/wiki (use repo-understanding). Keywords - workspace datasource, pool 合并, 多仓协调, stage 完整度, exports/workspace-datasource.json.
```
**agentic-coding-audit**
```
Fill the coding pool (datasource/pools/coding) with DETERMINISTIC static code evidence and agent analyses that carry evidence references, then export audit-data-compatible JSON. Use to populate the coding pool of a multi-repository workspace datasource including micro-frontend systems — this writes a datasource pool, not a fact-graph (for single-repo fact-graphs use repo-understanding). Invoked by agentic-datasource-orchestrator. Keywords - coding pool, 静态代码证据, deterministic tooling, evidenceRefs, audit-data 导出.
```
**agentic-ce-bridge**
```
Run an EXTERNAL agent runtime over a workspace datasource, capture its raw run output, and convert its conclusions into pool analyses/*.json with evidence references. Use to bridge an external code-understanding agent into a datasource pool — this produces external-subagent analyses (for deterministic static evidence use agentic-coding-audit). Invoked by agentic-datasource-orchestrator. Keywords - external agent runtime, CE bridge, raw run 捕获, pool analyses, subagent analysis.
```

- **验收**：`grep -rEl 'Codex must|RepoPrompt CE|agent_run|codex exec|Task tool' skills/*/SKILL.md` 的 description 行为空；8 条都含 `Keywords -`；每条是路由器不是教程。
  - **预算说明（2026-07-07 修订）**：上面这些目标串实测 353–517 字符，超过早期 ≤~320 的设想。经评审确认：多出的长度几乎都用在**否定式消歧锚**（"NOT ... use X instead"）上，这正是消除套件内路由撞车的关键，值得保留。故预算放宽到 **≤~520 字符**，硬性要求改为"必须含 Keywords + 至少一处对兄弟 skill 的否定式消歧"。唯一偏长的 `agentic-coding-audit`(517) 若要收紧，可把"including micro-frontend systems"移进 Keywords，非必须。

### Wave0-T3 · 章节骨架归一 + 门禁两节拆分

目标模板（槽位顺序固定）：`frontmatter → 一句话定位 → 角色/独立性(可选) → 门禁(红线 HARD-GATE + 约束 PRINCIPLE 两节) → 流程 → 返回给编排者`。

**门禁标签对照表（已同步至 Wave 2 落地后的现实，2026-07-07 修订）。** 每个 `[HARD-GATE: X]` 的 X 必须能 grep 到 `throw`/`process.exit`；`[PRINCIPLE]` 是 agent 被要求遵守但代码不强制的约束。评审后 Codex 误标的项已在"当前正确标签"列修正，并对应 `docs/skill-standardization-remediation.md` 的 R 项。

| skill | 约束 | 当前正确标签（Wave 2 后） |
|---|---|---|
| repo-explorer | predicate∈12值 / source / confidence / 非空 evidence | `[HARD-GATE: validateExplorerAnalysis]`（真实 exit 2） |
| repo-explorer | evidence 行号真实存在 | `[HARD-GATE: validateExplorerAnalysis]`（H-A3 已加行范围检查） |
| repo-understanding | `verify` 不过不得进综合 | `[HARD-GATE: validateUnderstandingPackage]` |
| repo-understanding | ingest 必须串行、禁并发写 | `[HARD-GATE: withPackageWriteLock]`（H-A1 已落地原子锁；见 R9 stale 回收） |
| repo-understanding | 记录未决问题优先用原语 | `[PRINCIPLE]`（`openQuestionAnalysis` 是便利原语，**不是**门禁；见 **R5**——Codex 误标 HARD-GATE） |
| repo-understanding | 循环只依 `status.nextAction` | `[PRINCIPLE]`（判断类） |
| repo-fact-verifier | `refuted` 删边 | `[HARD-GATE: verifyEdgeEvidence]` |
| repo-fact-verifier | 独立性 / `not-refuted` 立场 | `[PRINCIPLE]`（H-A4 的 `isExternalVerified` 收窄**在 R1 修复后**才是可信 gate；见 **R1**） |
| repo-synthesizer | write-subagent 写回合法性 | `[HARD-GATE: validateAnalysisBeforeWrite]`（H-A5 已前移，零落盘） |
| repo-synthesizer | summary≥120 / keyFlows 2-5 | `[HARD-GATE: validateAnalysisBeforeWrite]`（同一校验内） |
| repo-human-readable | 不得编辑任何源产物 | `[PRINCIPLE]`（无强制；投影只读约束） |
| repo-human-readable | 缺输入文件即失败 | `[PRINCIPLE]` 前置条件（**不是**保护性门禁；见 **R6**——Codex 误标 HARD-GATE `generateHumanReadableHtml`） |
| agentic-coding-audit | analyses 必带 evidenceRefs 等字段 | `[HARD-GATE: validateAgentAnalyses]`（真实 exit 2；**R3**——Codex 写成已不存在的 `validateAnalyses`） |
| agentic-coding-audit | export 前必须 normalize | `[HARD-GATE: assertExportGate]`（H-B1 已落地） |
| agentic-ce-bridge | 写 pool 前 schema 校验 | `[HARD-GATE: ingestAgentAnalyses]`（H-B2 走 shared 原语） |
| agentic-ce-bridge | parse 失败不伪造 analysis | `[HARD-GATE: assertCeParsed]`（强制真实存在，但需 **R4** 把标签从标记名 `ce-run-failed` 锚到该符号） |
| agentic-datasource-orchestrator | `--run-ce` 外部执行确认 | `[HARD-GATE: assertExternalExecutionConfirmed]`（H-B4 已落地） |

**逐 skill 骨架动作：**
- **repo-understanding**：已接近模板。把"依赖 CLI 原语"行里的 `project` 删掉（它不在任何流程步骤，是误导项）；红线节改名标 `红线(HARD-GATE / PRINCIPLE)` 并按上表拆两块；流程补 nextAction 三值分支表（`dispatch`→派发探索串行ingest；`synthesize`→退出循环进综合；`done`→终止）。
- **repo-explorer**：已是标杆。仅把"硬约束"节按上表拆 HARD-GATE/PRINCIPLE；流程 step2 自检项从"列 4 项"改为"按 bundle 内嵌 `## Output Schema` 逐项自检，补齐全部必填顶层字段"。不搬字节。
- **repo-fact-verifier**：保留角色/独立性两节（核心 stance，不下沉）；把 verdict 判定基线细节 + 字段枚举**外迁**到**新建** `skills/repo-fact-verifier/references/verifier-protocol.md`，SKILL.md 只留三值枚举名 + 指针 + "只有 `verdicts[]` load-bearing，四个计数由 harness 重算"。
- **repo-synthesizer**：门禁节按上表（write-subagent 标 PRINCIPLE+TODO(H-A5)）；输出 JSON 形状抽到**新建** `skills/repo-synthesizer/assets/repo-understanding.template.json`，正文改为"按 assets 模板填写"。
- **repo-human-readable**：加 frontmatter version；把 Visual Direction / Architecture Diagram 的风格细则下沉到**新建** `references/`（可选）；正文置顶保留"read-only consumer projection，不编辑任何源产物" 并标 `[PRINCIPLE] TODO`。
- **agentic-datasource-orchestrator**：`## Quick Pipeline` 三块 bash 塌缩为 1 条规范调用 + "`--prepare-ce`/`--run-ce` 切换 CE"一行（`--run-ce` 的确认要求保留在正文，是行为约束）；阶段表/Future skills 详述移入 `references/pipeline-contract.md`（已存在）；补 `## 返回给编排者`（无上游则写"面向用户交付项"）。
- **agentic-coding-audit**：`## Script Usage`（三段重复 bash）删除，脚本用法交给 `--help`；`## Output Contract` 目录树移入 `references/coding-data-pool-schema.md`（已存在）；legacy 字段清单移入 `references/output-compatibility.md`（已存在）；`## Evidence Rules` 保留（核心原则）；补 `## 返回给编排者`。
- **agentic-ce-bridge**：`## Commands` 全量 bash 移入 `references/ce-cli-contract.md`（已存在），正文只留"默认 `--dry-run`，去掉才真正执行 CE"这一安全默认；`## Boundaries` 保留；补 `## 返回给编排者`。

- **验收**：每个 SKILL.md 顶层标题集合 = 模板槽位集（可缺"角色/独立性"可选槽）；每个 `[HARD-GATE:...]` 括号里点名的符号在 `harnesses/`/`shared/` 里 grep 得到对应 `throw`/`process.exit`；无 SKILL.md 内联 >10 行 schema/模板。

### Wave0-T4 · 每 skill CHANGELOG

新建 `skills/<name>/CHANGELOG.md`：
```
## 1.0.0 — 2026-07-07
- description 路由化重写 + runtime 中立（清 Codex/RepoPrompt CE）
- 章节骨架归一、门禁按 HARD-GATE/PRINCIPLE 标注
- frontmatter 加 version/harnessContract/lastValidated
```

### Wave 0 自检脚本（Codex 收尾跑一遍）
```bash
cd "<repo-root>"
echo "== 无 version 的 skill（应为空）=="; grep -L '^version:' skills/*/SKILL.md
echo "== runtime 专名残留（应为空）=="; grep -rnE 'Codex must|RepoPrompt CE|agent_run|codex exec|Task tool' skills/*/SKILL.md
echo "== 无 Keywords 的 description（应为空）=="; grep -L 'Keywords -' skills/*/SKILL.md
echo "== HARD-GATE 标签点名的符号是否真实存在 =="; \
  grep -rhoE '\[HARD-GATE: *[A-Za-z0-9_/-]+' skills/*/SKILL.md | sed 's/\[HARD-GATE: *//' | sort -u
echo "   ^ 逐个到 harnesses/ shared/ grep 应能找到 throw/exit"
echo "== 新建 CHANGELOG =="; ls skills/*/CHANGELOG.md | wc -l   # 期望 8
```

**Wave 0 Definition of Done**：8 个 SKILL.md 通过上面自检；`git diff` 只动 `skills/**`（无 harnesses/shared 逻辑改动）；每条 description 能被 triggering 直觉区分（人工抽读两个 orchestrator 不再互相泛匹配）。

---

## Wave 1 — 契约锁（防漂移，纯新增代码，不改现有逻辑）

**目的**：冻结 harness 对外契约，让 Wave 0 的 SKILL.md prose 有测试兜底。

- **W1-T1** 建 `evals/` 顶层目录（与 `skills/` 平级，**不进任何 skill 目录**，守 G-C）：`fixtures/`（`mini-repo/` + `golden/`）、`contract/`、`behavioral/`、`triggering/`、`run-all.mjs`。`package.json` 加 `eval:contract` / `eval:behavioral` / `eval:triggering` / `eval:all`。
- **W1-T2** `mini-repo` fixture：真实 ~15 文件小仓库，须含 1 条 import、1 条 guarded-by、1 个 protected 文件、1 个 `src/mock/` 路由。golden 产物在**修复 G 系列后的 harness** 上生成，别把 bug 冻进 golden。
- **W1-T3** contract eval（锚字面量，见 G-E）：断言 `status` 输出 `nextAction ∈ {dispatch,synthesize,done}`、schemaVersion 字面量 `repo-harness-status/v1` / `repo-harness-ingest-result/v1` / `repo-explorer-dispatch/v1` / `repo-harness-write-subagent-result/v1` 未变；explorer 输出契约对 `schemas/explorer-output.schema.json` 的 7 required + evidence 六元组。
- **验收**：`npm run eval:contract` 全绿；故意改一个 schemaVersion 字面量 → 立刻红。

---

## Wave 2 — 补 harness 强制，再翻 HARD-GATE 标签

**规则（G-D 强化版）**：每个 gate 先在 harness/shared 落地强制 + 配一条证明 exit≠0 的 contract 测试；**通过后**才把对应 SKILL.md 的 `[PRINCIPLE] TODO(H-xx)` 翻成 `[HARD-GATE:...]`。顺序按核实优先级：

| 序 | ID | 位置（符号） | 要做的强制 |
|---|---|---|---|
| 1 | **H-A5/H-A6** (P1) | `repo-understanding-core.mjs :: writeAnalysis` | 把 `validateUnderstandingPackage`（synthesis 子集 + summary≥120/keyFlows 2-5/keyFile∈inventory 机检）前移到 `writeJson`/`projectHarnessPackage` **之前**，不过即 throw、零落盘 |
| 2 | **建 shared datasource ingest 原语** | 新增 `shared/scripts/` 或新 datasource harness | schema 校验 + 证据存在性 + exit≠0；作为 agentic-* 的统一写入口 |
| 3 | **H-B2** (P1) | `agentic-ce-bridge/scripts/run-ce-analysis.mjs` | 改走上一步的 ingest 原语；删私有 `normalizeAnalyses/subjectFromId` |
| 4 | **H-B3** | 同上 | CE parse 失败不合成 analysis，只留 raw + `ce-run-failed` 标记 + 非零退出 |
| 5 | **H-A4** (P1 安全边界) | `fact-graph-harness.mjs :: isExternalVerified` | 收窄信任到确定性 tag（`deterministic-adversarial-verifier`），LLM `not-refuted` 不再永久跳过 G3 |
| 6 | **H-A1** | harness `ingest` | package 写锁 + 并发检测 exit 2 |
| 7 | **H-A2** | harness `ingest` | 暴露 `ingest --open-question '<text>' --tasks <ids>` 原语（替代手搓 JSON） |
| 8 | **H-A3** | `validateExplorerAnalysis` | 加 line ≤ 文件实际行数 / range 有效检查 |
| 9 | **H-B1** | `agentic-coding-audit/scripts/export-audit-data.mjs` | 入口重跑 `validateAnalyses` / freshness 检查，exit 2 |

- **W2-lint**：加一条 CI lint——`[HARD-GATE]` 标签点名的 primitive 若在 harness/shared 无 `throw`/`process.exit` 即 fail。
- **behavioral eval** 同步补：每个 skill 断言"反事实 delta"（见设计 §4.2）；其中 explorer 坏输入→`merged:false`、synthesizer 坏输入→零落盘、ce-bridge parse 失败→不伪造，这几条会在对应 gate 落地前故意红，正是它们的价值。

---

## Wave 3 — R1 逻辑收敛（对在跑 agentic 管线风险最高，最后做）

- **W3-T1** 指定共享归宿：新 datasource harness 还是 `shared/scripts/`；明确 `AgentAnalysis` schema 归属。
- **W3-T2** 把 `validateAnalyses` / `normalizeAnalyses` / `subjectFromId` 从 `agentic-coding-audit/scripts/` 与 `agentic-ce-bridge/scripts/` 迁到共享单一源。
- **W3-T3** 保留旧脚本可用，直到共享原语通过 `evals/fixtures/golden/coding-pool.golden.json` diff；再切调用点；**再**删副本。
- **红线**：共享替代通过 golden 前，**不得**删 `normalize-coding-pool.mjs` 的 `process.exit(2)`。

---

## 附：任务依赖速览

```
Wave 0 (纯文档, 8 SKILL.md)  ──可独立交付──►  triggering 直觉验收
        │
Wave 1 (evals/ + contract 锁)  ──先于任何标签翻转──►
        │
Wave 2 (harness 强制 → 翻 HARD-GATE 标签)   H-A5/H-B2/H-A4 优先
        │        └─ 需先"建 shared datasource ingest 原语"才能做 H-B2/H-B3
        │
Wave 3 (R1 逻辑收敛)  ──最后, 且 golden 回归门后才删旧副本──►
```

G-5..G-8 与本指南正交，**不并入**。
