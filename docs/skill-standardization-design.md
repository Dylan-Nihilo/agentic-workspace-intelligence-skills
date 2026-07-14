# Skill 套件规范化设计（对照 ADK 2.0 + Skill 能力包范式）

> v1 历史设计。当前 repo-understanding v3 契约见
> `docs/repo-understanding-harness-design.md`；2026-07-10 Skill-first v2 规范
> 仅保留为历史基线。

> 目标：把 `skills/` 下的 **8 个 skill** 从"两族风格分裂、约束靠散文、无版本无测试"整改为一套**统一骨架、按风险控自由度、契约化可回归**的能力包。
> 方法：审计（8 单元）→ 设计（5 工作流）→ 对抗核查（红线 + 完整性）。本文档是三步综合，**已应用核查发现的事实修正**（见 §0.3）。
> 前置阅读：`docs/harness-skill-plan.md`（pull 模型 + 4 条红线）、`harnesses/repo-understanding/README.md`（fact-graph 单一事实源）。

---

## 0. 范式与评分卡

### 0.1 两个范式的落地口径

**范式 A（ADK 2.0）**：LLM 不做执行编排；确定性代码/图负责路由与调度；workflow 是显式有向图（确定性节点 + LLM 节点混排）；控上下文膨胀，管住每个节点拿到什么；**图边界即安全边界**——被诱导的 LLM 节点越不出它的边。

**范式 B（Skill 即能力包）**：Skill 不是知识库、不是提示词模板，而是给 agent 设计**稳定行为**的能力包。四个必须解决的问题：

1. **正确触发** — `description` 是路由器，只负责"被正确发现"，不写成教程。
2. **少占上下文** — SKILL.md 只放核心流程；`scripts/` 装确定性操作、`references/` 装按需知识、`assets/` 装模板素材。
3. **按风险控自由度** — 低风险/开放任务靠原则（PRINCIPLE），高风险/脆弱任务必须靠脚本 + HARD-GATE（agent 绕不过的硬校验）。
4. **真实任务验证** — 用真任务证明它确实改变了 agent 行为；把 skill 当软件（版本化、契约测试、回归守护）。

**本工程自有红线（并入评分卡，任何提案不得违反）**：

- **R1**：skill 目录内不得有校验/合并/投影**逻辑**副本；逻辑只有一份，在 harness / `shared/`。skill 只调 CLI 原语或**薄封装**。
- **R2**：`fact-graph.json`（repo 族）/ datasource pool（agentic 族）是单一事实源；agent 不手改产物，写入走 ingest / write-subagent。
- **R3**：SKILL.md 正文 **runtime 中立**——不出现 `Codex must` / `RepoPrompt CE` / `Task tool` 等运行时专名，用能力条件句。
- **R4**：pull 模型——承载 skill 的 agent 会话本身即 LLM 运行时，harness 只暴露文件契约原语。

### 0.2 审计评分卡（8 个 skill，1–5 分）

| skill | 触发 | 上下文 | 风险控 | 验证 | ADK | 主要问题 |
|---|---|---|---|---|---|---|
| repo-understanding | 5 | 5 | 4 | 2 | 5 | 无版本无 eval；`project` 列进原语却不在任何步骤；nextAction 三值只写了 dispatch 分支 |
| repo-explorer | 4 | 5 | 3 | 2 | 5 | 行号真实性未 gate；自检项列 4 项但 schema 要 7 项 |
| repo-fact-verifier | 5 | 4 | 4 | 2 | 4 | `not-refuted` 永久关闭下游确定性 gate（最尖锐 ADK 违背）；判定标准内联未下沉 |
| repo-synthesizer | 4 | 4 | 2 | 3 | 4 | **先写盘后校验**，错误产物+污染 wiki 已落盘（假 gate P1）；模板内联未进 assets |
| repo-human-readable | — | — | — | — | — | **审计遗漏，本文档补**：无版本；消费投影类、无对应门禁分类 |
| agentic-datasource-orchestrator | 3 | 4 | 4 | 1 | 5 | `Codex must`（违 R3）；与 repo-understanding 最高危路由重叠；`--run-ce` 外部执行无确定性闸门 |
| agentic-coding-audit | 3 | 5 | 4 | 2 | 5 | `Codex must`；export 可跳过 normalize gate；scripts 内含校验逻辑（违 R1） |
| agentic-ce-bridge | 3 | 4 | 2 | 1 | 3 | `RepoPrompt CE`/`agent_run`（违 R3）；无 schema 直写 pool；**parse 失败伪造 analysis**；双份 normalizeAnalyses（违 R1） |

**两族成熟度差**：repo-\* 是 harness-first 参考实现（薄 skill、只调 CLI、runtime 中立、有对抗校验层、有返回契约）；agentic-\* 是早期原型（scripts 内含逻辑、硬编码运行时名、无对抗层、无写纪律声明）。规范化的主轴就是**让 agentic-\* 向 repo-\* 收敛**，同时把 repo-\* 隐式的门禁**显式标注 + 补齐验证**。

### 0.3 对抗核查修正的事实（写在最前，防止沿用错误前提）

原始设计蓝图有几处事实错误，已在本文档修正：

1. **套件是 8 个 skill，不是 7**。`repo-human-readable` 存在，且带 `scripts/generate-html.mjs`。它必须进所有表格（版本、description 重写 + 消歧、上下文瘦身）。
2. **ingest 已有真 schema 门禁**。`shared/understanding/repo-exploration-core.mjs` 的 `validateExplorerAnalysis()` 在写盘前调用、命中即 throw → `{merged:false}` + exit 2。"ingest 恒 merged:true"是错的；explorer 的残余风险只剩**行号真实性**（H-A3），不是"完全没 gate"。
3. **`producedBy` 枚举是 `['codex','subagent','human']`，不含 `agent`**（见 `normalize-coding-pool.mjs`）。runtime 中立只能改 **prose**，**数据值**必须仍落在真实枚举内（继续用 `subagent`/`human`），否则会被 exit 2 拒。若确要发 `agent`，先扩枚举再改 skill。
4. **脚本规则按能力判，不按族判**。`repo-human-readable/scripts/generate-html.mjs` 只 import `shared/understanding/human-readable-html.mjs`，是合法薄封装。规则应是"skill 目录不得有 validate/merge/project **逻辑**；薄 CLI 封装可留"。
5. **单一事实源是 `shared/understanding/*.mjs`（逻辑）+ `harness.mjs`（编排）**，不是只有 harness.mjs。契约测试/lint 应锚定**函数符号与 schemaVersion 字符串字面量**，不锚绝对行号（蓝图引用的行号已普遍漂移 8–12 行）。
6. **agentic 族还不存在 datasource ingest 原语**。让 agentic-\* "改走 ingest" 的前提是先**建**这个共享原语；在其上线前，不得删除 `normalize-coding-pool.mjs` 的 exit 2（那是 coding pool 目前唯一的 gate）。
7. **HARD-GATE 标签必须滞后于强制**。任何 `[HARD-GATE]` 标签只能在 harness 强制点 + 通过的契约测试都就绪后才贴；在那之前一律标 `[PRINCIPLE]` 并注明 TODO。

---

## 1. 标准 Skill 骨架与目录规范

### 1.1 SKILL.md 唯一章节模板

每个 SKILL.md 必须按此槽位顺序（中文族用中文标题、英文族用英文标题，但语义槽位一一对应），多一节少一节都算违规：

| 顺序 | 槽位 | 中文族 / 英文族标题 | 只放这些 |
|---|---|---|---|
| 0 | frontmatter | `---` | `name` / `description`(路由器) / `version` / `harnessContract` / `lastValidated` |
| 1 | 一句话定位 | H1 下第一段 | 输入是什么、产出是什么、你在图里是哪个节点 |
| 2 | 角色/独立性（可选） | `角色定位` / `Role` | 仅当该节点有对抗/独立立场时（如 verifier"默认事实是错的"） |
| 3 | **门禁** | `红线(HARD-GATE)` + `约束(PRINCIPLE)` 两节 | 见 §3 标注约定，强制拆成"脚本强制"与"判断"两块 |
| 4 | 流程 | `流程` / `Flow` | 编号步骤，每步至多一条 CLI 原语 + 一句判断 |
| 5 | 返回契约 | `返回给编排者` / `Return to caller` | 回传上游的结构化字段清单；无上游则写"面向用户交付项" |

**删除项**：agentic-\* 里独立的 `Script Usage` / `Commands` / `Quick Pipeline` / `Output Contract` 章节，全部并入槽位 4 或外迁（见 §5）。

### 1.2 内容外迁决策表

| 内容类型 | 归属 | 判据 |
|---|---|---|
| 确定性操作的**调用** | 直接调 harness CLI，或 `scripts/` 内**薄封装** | 有固定输入→固定输出的机械步骤 |
| 按需领域知识（判定标准、反例、误判史） | `references/` | 只在"动笔那一刻"需要，>10 行，会随经验增长 |
| 模板/物料（输出骨架、请求样板、legacy 形状） | `assets/` | 是"填空样板"，不是知识也不是逻辑 |
| Schema 全量字段清单 | **不放 SKILL.md**，指向 bundle 内嵌 schema 或 `references/` | 复述 schema 就产生第二份定义并漂移 |
| harness 已拥有的规则（count 重算、归一化） | **不放 SKILL.md** | harness 是唯一源，复述即制造漂移 |

### 1.3 R1 的正确表述（脚本按能力判）

一条规则写进套件 README，取代蓝图里错误的"repo-\* 禁 scripts/"：

> **SKILL.md 里出现的每一条命令，要么是 harness/shared 的 CLI 原语调用，要么是无逻辑的薄封装（只做参数转发/spawn/落 raw）；任何 validate / merge / normalize / project 代码都不得住在 skill 目录里。**

据此逐 skill 分类：

- **repo-understanding / repo-explorer / repo-fact-verifier / repo-synthesizer**：无 scripts/，只调 `understanding:harness -- <verb>`。合规。
- **repo-human-readable**：`scripts/generate-html.mjs` 是 `shared/understanding/human-readable-html.mjs` 的薄封装。**合规**（消费投影类，逻辑在 shared）。
- **agentic-coding-audit / agentic-ce-bridge**：`normalize-coding-pool.mjs`(`validateAnalyses`)、`run-ce-analysis.mjs`(`normalizeAnalyses`) 含逻辑且**双份定义会漂移**。**违规**，逻辑上移 `shared/`（见 §6 迁移，Wave 3）。
- **agentic-datasource-orchestrator**：`run-pipeline.mjs` 是编排装配脚本，逻辑分散——整改时归入 datasource harness。

### 1.4 Frontmatter 标准

```yaml
---
name: repo-explorer            # 与目录名一致，kebab-case
version: 1.1.0                  # semver：破坏产物契约=major，加约束=minor，措辞=patch
harnessContract:               # 该 skill 假定的 harness 对外契约版本（契约测试据此校验）
  dispatch: repo-explorer-dispatch/v1
  ingestResult: repo-harness-ingest-result/v1
  output: repo-exploration-analysis/v1
lastValidated: 2026-07-07      # 最近一次 eval:all 全绿日期
description: ...（只当路由器，见 §2）
---
```

配套每 skill 一份 `CHANGELOG.md`（3 行即可）。8 个 skill 当前 frontmatter 全部只有 `{name, description}`，**全部补 version**。

---

## 2. description 路由化重写（8 个）

### 2.1 消歧矩阵（把 5 组 overlap 变成 description 里的显式区分位）

| overlap | 冲突根因 | 区分锚点（改写后必须包含） |
|---|---|---|
| repo-understanding ↔ agentic-datasource-orchestrator（**最高危**） | 都是"多阶段代码库分析编排"，均未点明输出物 | `SINGLE repository` + fact-graph/wiki  **vs**  `MULTI-REPOSITORY workspace datasource` + `exports/workspace-datasource.json`；互加 `NOT ... use <sibling>` |
| agentic-coding-audit ↔ repo-explorer/understanding | `static code evidence` ≈ `static scan` 近义 | coding-audit 写 `datasource/pools/coding`（pool 语义），不出现 `fact triple`；repo-\* 写 fact-graph |
| agentic-ce-bridge ↔ agentic-coding-audit | 都往 `pool/analyses/*.json` 写 | ce-bridge = `external agent runtime` 产结论；coding-audit = `deterministic static evidence` |
| repo-fact-verifier ↔ repo-explorer | 都吐 evidence-keyed JSON | 动词对立：verifier `refute existing edges` / `does NOT produce new facts`；explorer `produce new facts` |
| **repo-human-readable ↔ repo-synthesizer ↔ repo-understanding**（本文档补） | "human-readable HTML" ≈ "human-facing synthesis" ≈ "human-readable report" | human-readable = **对已完成 package 的确定性 HTML 投影，不编辑任何源产物**；synthesizer = 写叙述 JSON；understanding = 编排整体 build |

### 2.2 逐条改写（引用为各 `SKILL.md:3` 原文）

**1. repo-understanding**
`Orchestrate end-to-end understanding of a SINGLE repository into an evidence-backed fact-graph, narrative wiki, and knowledge index. Use when the user asks to understand/analyze one codebase, build a repo wiki, or produce a repo knowledge graph — NOT to build a multi-repo workspace datasource (use agentic-datasource-orchestrator). Keywords - 理解仓库, 分析单个代码库, repo wiki, fact-graph, 架构分析.`

**2. repo-explorer**
`Produce new evidence-backed fact triples by read-only, targeted exploration of one dispatch bundle. Use for an L2 exploration task in the repo-understanding harness; produces facts (not verifies them — for refutation use repo-fact-verifier). Invoked by the repo-understanding orchestrator. Keywords - explorer bundle, gap task, 定向探索, fact 三元组, evidence, read-only.`

**3. repo-fact-verifier**
`Adversarially refute low-confidence or inferred edges that already exist in a repo-understanding fact-graph — attempt to disprove each edge using only its own evidence. Use for adversarial-verify tasks; consumes existing edges (does NOT produce new facts — for exploration use repo-explorer). Invoked by the repo-understanding orchestrator. Keywords - 对抗校验, refute, 低置信度, verifier, edge 校验.`

**4. repo-synthesizer**
`Write the human-facing synthesis (summary/architecture/keyFlows/risks) for a VERIFIED repo-understanding package, strictly from fact-graph evidence. Use only after verification passes, to author the narrative layer over an existing fact-graph. Invoked by the repo-understanding orchestrator. Keywords - synthesis, wiki 文案, 项目概览, repo-understanding.json.`

**5. repo-human-readable**（本文档补，消歧第 5 组）
`Render a self-contained human-readable HTML PAGE from an already-complete repo-understanding package (architecture SVG, evidence summaries, quality gates). Read-only consumer projection — edits no source artifact. Use to produce a shareable HTML view of an EXISTING package, not to build or synthesize it (use repo-understanding / repo-synthesizer). Keywords - HTML 页面, 自包含, human-readable projection, 架构图, package 可视化.`

**6. agentic-datasource-orchestrator**
`Coordinate producer skills that progressively fill a MULTI-REPOSITORY workspace datasource, then merge their pools into exports/workspace-datasource.json. Use when you need to run coding/CE producer stages in order, track stage completeness and missing evidence, and assemble the workspace datasource — NOT to build a single-repo fact-graph/wiki (use repo-understanding). Keywords - workspace datasource, pool 合并, 多仓协调, stage 完整度, exports/workspace-datasource.json.`
（删 `Codex must` → `you need to`；删 `plan later ... stages` 路线图；补 Keywords）

**7. agentic-coding-audit**
`Fill the coding pool (datasource/pools/coding) with DETERMINISTIC static code evidence and agent analyses that carry evidence references, then export audit-data-compatible JSON. Use to populate the coding pool of a multi-repository workspace datasource including micro-frontend systems — this writes a datasource pool, not a fact-graph (for single-repo fact-graphs use repo-understanding). Invoked by agentic-datasource-orchestrator. Keywords - coding pool, 静态代码证据, deterministic tooling, evidenceRefs, audit-data 导出.`
（`Codex` 全清 → `agent analyses`；`especially micro-frontend` 降级为关键词；补 `Invoked by` + Keywords）

**8. agentic-ce-bridge**
`Run an EXTERNAL agent runtime over a workspace datasource, capture its raw run output, and convert its conclusions into pool analyses/*.json with evidence references. Use to bridge an external code-understanding agent into a datasource pool — this produces external-subagent analyses (for deterministic static evidence use agentic-coding-audit). Invoked by agentic-datasource-orchestrator. Keywords - external agent runtime, CE bridge, raw run 捕获, pool analyses, subagent analysis.`
（删 `RepoPrompt CE CLI or MCP` / `agent_run` / `before later replacing CE ...`；MCP 不在 router 承诺——脚本只实现 CLI）

> **修正（对齐 §0.3-3）**：以上 description 里的 "agent analyses" / "external-subagent" 只是 **prose 路由词**。落到数据层，`producedBy` 字段仍必须写 `subagent`/`human`/`codex`（真实枚举）。runtime 中立整改**不改数据值**，除非先在 `normalize-coding-pool.mjs` 扩枚举。

---

## 3. 风险分级与 HARD-GATE 映射

### 3.1 判定规则

> 一个操作是否需要 HARD-GATE，取决于**它出错时错误产物能否被下游持久化 / 污染人读层**，而非它写起来像不像"约束"。
> - **低风险/开放**（read-only、可回滚、错误只影响本轮判断）→ `[PRINCIPLE]`。
> - **高风险/脆弱**（写 fact-graph/wiki/导出、外部 runtime 执行、跨会话不可逆）→ `[HARD-GATE]`：harness 确定性代码 + 非零退出码强制。

**标注硬规则**：一条约束想标 `[HARD-GATE: <primitive> exit≠0]`，必须能指到 harness 里真实的 throw/exit 路径（按**函数符号**核对，不按行号）；指不到就只能标 `[PRINCIPLE]`，或先去 harness 补强制点。这把"是不是真门禁"变成可核对事实，直接堵住 repo-synthesizer 那类"asks nicely 却自称 gate"。

### 3.2 现有确定性 gate（5 个，均已核对，锚定函数符号）

| Gate | 位置（符号） | 机制 | 语义 |
|---|---|---|---|
| **G1 · explorer schema reject** | `repo-exploration-core.mjs :: validateExplorerAnalysis()` | throw → `{merged:false}` + exit 2 | 拒非法 predicate(12 值)/source/confidence/缺 subject-object/空 evidence/snippet>3 行 |
| **G2 · package validate** | `repo-understanding-core.mjs :: validateUnderstandingPackage()`，经 `writeValidation()` | `passed===false` → exit 2（report 分支 exit 3） | fact-graph/render-graph/knowledge-index/wiki/gap-queue 一致性、evidenceRef 有效性 |
| **G3 · 确定性对抗 verifier** | `fact-graph-harness.mjs :: verifyEdgeEvidence()` | 对 `source≠static || confidence≤0.7` 的边核证据；refuted→删边 | 证据缺失/protected/空文本/文本与谓词矛盾 → refuted |
| **G4 · 证据阈值 0.5/0.7** | `fact-graph-harness.mjs`（inferred=0.5，门槛≤0.7，投影 minConfidence=0.5） | 低阈值边强制进 G3；投影只吸 ≥0.5 | inferred 边必须被复核才可信 |
| **G5 · protected → metadata-only** | `fact-graph-harness.mjs`（protected 证据不支撑低置信边）+ `repo-understanding-core.mjs`（protected 片段不入 knowledgeIndex） | G3 判 refuted / G2 push issue | protected 文件只留 metadata |

### 3.3 需新增的 HARD-GATE（按优先级；均落 harness 侧单一源）

| ID | Skill | 缺口 | 强制机制（新增） | 优先级 |
|---|---|---|---|---|
| **H-A5/H-A6** | repo-synthesizer | write-subagent **先写盘后校验**，wiki 已污染；summary/keyFlows/keyFile 无机检 | G2 前移到 `writeAnalysis` 内、写盘+投影**之前**，不过即 throw、零落盘；可机检约束并入 | **P1** |
| **H-B2** | agentic-ce-bridge | 无 schema 直写 pool + 双份 normalizeAnalyses | 改走 **新建**的 shared datasource ingest 原语 + schema/证据 gate，删私有校验 | **P1** |
| **H-A4** | repo-fact-verifier | LLM `not-refuted` 永久关闭 G3（`isExternalVerified` 认 `tool==='repo-fact-verifier'` 即永久跳过复核） | 把信任收窄到确定性 tag（`deterministic-adversarial-verifier`），或让 G3 对所有边加性运行 | **P1**（安全边界，见注） |
| **H-B3** | agentic-ce-bridge | CE parse 失败时**合成伪 analysis** 照写 | parse 失败不合成 analysis，只留 raw + `ce-run-failed` 标记 + 非零退出 | **P2** |
| **H-A1** | repo-understanding | 串行 ingest 仅 prose（并发写会损坏 fact-graph） | ingest 取 package 写锁 + 并发检测 exit 2 | **P2** |
| **H-A2** | repo-understanding | openQuestion-only fallback 靠手搓 JSON（踩 R1） | 暴露 `ingest --open-question '<text>' --tasks <ids>` 原语 | **P2** |
| **H-B4** | agentic-datasource-orchestrator | `--run-ce` 外部执行无确定性闸门 | 默认 prepare-only；执行需 `--run-ce` **且** `--confirm-external`/env token 双因素 | **P2** |
| **H-A3** | repo-explorer | 编造行号可蒙混（G1 不核行号是否在文件范围内） | `validateExplorerAnalysis` 加"line ≤ 文件实际行数、range 有效"检查，命中 throw | **P2** |
| **H-B1** | agentic-coding-audit | export 可跳过 normalize gate | `export-audit-data.mjs` 入口重跑 `validateAnalyses` / freshness 检查，exit 2 | **P2** |

> **H-A4 升级为 P1**：核查指出——一句幻觉 `not-refuted` 让该边在**未来每次 rebuild** 都跳过唯一确定性证据门 G3，不受支撑的事实永久存活于 fact-graph.json。这正是范式 A"variance-prone 的 LLM 节点不得停用下游确定性控制"的直接违背，按安全边界口径应与 H-A5/H-B2 同级。

> **ADK 图边界三处**：H-A1（串行 ingest 是防两个 explorer 子代理并发写同一存储的边约束）、H-A4（LLM 不得关闭确定性门）、H-B4（外部执行从"flag 即放行"升级为"确定性双因素闸门"）——都是把 prose 边界升格为代码强制的边。

---

## 4. Skill 即软件：校验与版本化体系

### 4.1 目录约定（新增顶层 `evals/`，与 skills/ 平级——不进任何 skill 目录，守 R1）

```
evals/
  fixtures/
    mini-repo/            # ~15 文件真实小仓库（含 1 import、1 guarded-by、1 protected、1 src/mock 路由）
    golden/
      repo-understanding.status.json      # 冻结 status 三态
      repo-explorer.output.json           # golden explorer 输出（合法）
      repo-explorer.output.bad.json       # 故意坏：伪造行号 / 非法 predicate / 空 evidence
      coding-pool.golden.json             # 冻结 coding-audit normalize 输出
  behavioral/   # 每 skill 一个：真实任务 → 可观测行为变化
  triggering/   # description 路由：该触发命中、不该触发不命中
  contract/     # schemaVersion + nextAction 枚举 + golden 回归
  run-all.mjs
```

`package.json` 加 `eval:behavioral` / `eval:triggering` / `eval:contract` / `eval:all`。所有 eval 复用 harness / normalize 等**已存在单一源**，自己不重写校验逻辑（eval 是确定性代码，测的是"LLM 节点被 skill 约束后的可观测产物"，判分权归确定性层——符合范式 A）。

### 4.2 四类 eval

| 类型 | 回答 | 通过判据（可观测） |
|---|---|---|
| **behavioral** | skill 触发后**真改了行为**吗 | 产物 delta：如 explorer 产 ≥N 条带证据 fact 且 `edgeDelta>0`；编排者 0 处手改 package |
| **triggering** | `description` 在对的 prompt 点亮、在**兄弟 prompt** 不点亮 | 命中矩阵；复用 skill-creator `run_eval.py` + `aggregate_benchmark.py`（命中率+方差量化门） |
| **contract** | schemaVersion / nextAction 枚举 / golden **没漂移** | 精确等值断言；任一 tag 或枚举变更即 fail |
| **regression** | 旧污染包仍 fail、修复场景(G-1..G-7)不复发 | 旧包 verify 非 0；replay delta 符合冻结值 |

**行为 eval 锁"反事实"**（没有该 skill 就不会发生的 delta）：

| skill | 通过判据 | 反事实 |
|---|---|---|
| repo-explorer | 给 bundle → ≥3 条合法 predicate + evidence 齐全的 fact；ingest `merged:true` 且 `edgeDelta>0`；git status 0 处手改 | 会写"总结散文"或伪造行号 |
| repo-fact-verifier | 证据失效的边 → `refuted` 且删边；真边 → `not-refuted` 保留 | 盲信 producer、不重开证据 |
| repo-synthesizer | 每条 fact 有 `evidenceRefs`；无证据"常识"进 openQuestions | 把"Vue 项目通常有 router"当 fact 写进 wiki |
| repo-understanding | nextAction 三态各走对分支；ingest 串行；全程 0 未授权写入 | 自解读 coverage 提前停 / 并发 ingest 撞包 |
| repo-human-readable | 生成非空 HTML + 架构 SVG；**git status 证明未改任何源产物** | 编辑 fact-graph/wiki 破坏 R2 |
| agentic-coding-audit | 缺 evidenceRefs 的 analysis → normalize **exit 2**；合法 → 等于 golden | 无证据 analysis 混入 board |
| agentic-ce-bridge | CE stdout → analysis 过 schema；**parse 失败不合成伪 analysis**（H-B3 后） | garbage CE run 当"分析"持久化 |
| agentic-datasource-orchestrator | prepare-ce 端到端过 schema；`--run-ce` 无 `--confirm-external` **拒执行**（H-B4 后） | 过早触发外部 runtime |

### 4.3 契约测试锚定（**函数符号 + schemaVersion 字面量，绝不锚行号**）

| 冻结项 | 锚（符号/字面量） | 断言 |
|---|---|---|
| nextAction 枚举 | harness `status` 输出的 nextAction 三元三态 | fixture 造三态，断言集合 = `{dispatch, synthesize, done}` |
| status schemaVersion | 字面量 `repo-harness-status/v1` | 精确等值 |
| ingest 结果体 | 字面量 `repo-harness-ingest-result/v1` | 含 `merged/edgeDelta/edgesRemovedByVerifier/removedEdgesByVerifier/nextAction` |
| dispatch manifest | 字面量 `repo-explorer-dispatch/v1` | 精确等值 |
| write-subagent 结果 | 字面量 `repo-harness-write-subagent-result/v1` | 精确等值 |
| explorer 输出契约 | `schemas/explorer-output.schema.json` | 7 required 顶层字段 + evidence 六元组 |
| golden 包回归 | `evals/fixtures/golden/*` | mini-repo 全流程产物 diff = 空 |

**防漂移锁**：有人改 nextAction 枚举 → 契约测试立刻红 → 强制同步 repo-understanding SKILL.md 的分支表（该表本身是 P2 修复项：今天只写 dispatch 分支，漏 `synthesize→step4`、`done→terminate`）。

### 4.4 映射 V-1..V-5（人工清单拆成机器项 + 一次性人工）

| 验收 | 拆分 |
|---|---|
| V-1 无 codex 全流程 | **机器化**：mini-repo 缩减版（≥1 轮、nextAction 三态、verify passed）进 CI；全量 mp 版仍人工 |
| V-2 codex 谓词分布对比 | **人工**（需真实 Codex host）；其"质量门同过"一半 → 契约断言两套产物 verify 均 passed |
| V-3 ≥3 explorer 并行 | **人工**；可机器化一半：断言 dispatch 每 bundle 独立 outputPath + 串行 ingest 无重派 |
| V-4 confidence 零漂移、旧包仍 fail | **机器化**：连跑 3 次 `analyze --incremental` 断言 confidence 不变；旧 mp 包 verify 非 0 |
| V-5 红线审计 | **半机器化**：临时目录全流程后 `git status --porcelain` 对 package 外断言空；10 条边人工抽检 |

---

## 5. 上下文瘦身：逐 skill 搬迁清单

| Skill | 现状 | 建议搬出 | 目标层 | 结论 |
|---|---|---|---|---|
| agentic-coding-audit | 70 行 | Script Usage 全段 + Output Contract 目录树 + legacy 字段 | references + assets | **需搬迁（最重）** |
| agentic-datasource-orchestrator | 62 行 | Quick Pipeline 三块 bash（仅差一 flag）+ Skill Family 详述 | references + 脚本 usage | 需搬迁 |
| repo-fact-verifier | 37 行 | verdict 判定基线 + 字段枚举 | **新建** `references/verifier-protocol.md` | 轻度搬迁 |
| agentic-ce-bridge | 48 行 | Commands 全量 bash | `references/ce-cli-contract.md`（已存在） | 轻度搬迁 |
| repo-synthesizer | 35 行 | 输出 JSON 形状 | **新建** `assets/repo-understanding.template.json` | 接近最小 |
| repo-human-readable | ~100 行 | Visual Direction / Architecture Diagram 风格细则可下沉 | `references/`（可选） | 视需要 |
| repo-explorer | 38 行 | 0（自检项改为指向已存在 references + 内嵌 schema） | 只改指针 | **已正确最小（标杆）** |
| repo-understanding | 66 行 | 0（全是编排核心流程） | 不搬 | **已正确最小** |

**套件级足迹标准**：① 新增 `assets/` 约定（模板一律进 assets，不内联散文/脚本字符串）；② 脚本 usage 单一源（删正文复述，留脚本 `usage()`/`--help`）；③ schema/判定标准归 references，一份。

---

## 6. 落地顺序（enforcement-first，不破坏在跑的 harness）

**核查结论：不得整份一次性落地——会让在跑的 harness 对着"撒谎的 SKILL.md"运行。** 按波次推进：

**Wave 0 — 纯文档，零 harness 风险（先发）**
1. 把 `repo-human-readable` 补进所有表格，全文改口径为"8-skill 套件"。
2. 8 个 skill frontmatter 加 `version` / `harnessContract` / `lastValidated` + `CHANGELOG.md`（纯增量）。
3. 8 条 description 路由化重写 + runtime 中立（清 `Codex`/`RepoPrompt CE`/`agent_run`）+ 第 5 组消歧锚点。**唯一风险是路由行为变化，用 triggering eval 兜底。**

**Wave 1 — 防漂移锁（最小投入/最大收益）**
4. 只上 contract eval：CLI 调用 + 断言 schemaVersion 字面量 + nextAction 三态集合，**不锚行号**。它第一件事就是修正蓝图里的陈旧行号引用，并冻结所有 SKILL.md prose 依赖的 harness 契约。

**Wave 2 — 强制先落地，标签后翻转**
5. 按核实优先级实现 harness gate，每个配一条证明 exit≠0 的契约测试，**通过后**才把该 skill 的 `[PRINCIPLE]→[HARD-GATE]` 翻转：
   - H-A5/H-A6（synthesizer 前置校验，P1，污染 wiki 今天就在发生）先做；
   - **建 shared datasource ingest 原语** → 再做 H-B2/H-B3（ce-bridge，删私有 normalize）；
   - H-A4（verifier not-refuted 不再抑制 G3，P1 安全边界）；
   - 其余 P2（H-A1/H-A2/H-A3/H-B1/H-B4）。
6. 加 lint：`[HARD-GATE]` 标签点名的 primitive 若在 harness/shared 无 throw/exit 即 fail（把"标签滞后强制"变成 CI 强制）。

**Wave 3 — R1 收敛（对 agentic 在跑管线风险最高，最后做）**
7. 把 `validateAnalyses`/`normalizeAnalyses`/`subjectFromId` 从各 skill `scripts/` 迁到 `shared/`——**但先指定目标归宿**（新 datasource harness vs `shared/scripts/`）与 AgentAnalysis schema 归属。保留旧脚本可用，直到共享原语通过 `coding-pool.golden.json` diff，再切调用点、再删副本。**决不在 shared 替代上线前删 `normalize-coding-pool.mjs` 的 exit 2。**

**与既有 backlog 的关系**：Wave 1 契约 eval 直接实现 V-4/V-1 的机器半。`docs/harness-skill-plan.md` 的 **G-5..G-8**（wiki 证据溯源、import-resolver、mock 路由、open-questions 排版）是**正交的 fact-graph 数据质量修复，不并入本次 skill 规范化**——否则会把路由/标签变更耦合到无关的投影工作。

---

## 7. 一页速查

- **8 个 skill**（含易漏的 repo-human-readable）。
- **统一骨架**：frontmatter(含 version) → 一句话定位 → 门禁(HARD-GATE/PRINCIPLE 两节) → 流程 → 返回契约。
- **description = 路由器**：8 条已重写，5 组 overlap 全部注入区分锚点 + 负向指路；agentic 三家清运行时专名。
- **风险分级**：5 个现有 gate + 9 个待补，标签**滞后于强制**；H-A5 / H-B2 / H-A4 为 P1。
- **Skill 即软件**：顶层 `evals/`，四类 eval，契约锚**符号/字面量非行号**，version + CHANGELOG。
- **R1 按能力判**：skill 目录无逻辑，薄封装可留（generate-html.mjs 合规，agentic normalize 违规待迁）。
- **落地**：Wave 0 纯文档 → Wave 1 契约锁 → Wave 2 强制+翻标签 → Wave 3 逻辑收敛；G-5..G-8 不并入。
