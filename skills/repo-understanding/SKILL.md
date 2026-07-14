---
name: repo-understanding
description: >-
  Orchestrate the only supported end-to-end workflow for understanding one frontend repository or an isolated frontend subtree. Use when the user asks to understand a frontend codebase, reconstruct user journeys, build Application/Experience/Runtime Flow/Change Maps, or create a repo knowledge package. Fail closed for backend repositories; use a workspace orchestrator for multi-repo datasource work.
---

# Repo Understanding

把一个受支持的前端仓库转成可验证的四张 Map 与 Journey。你是唯一编排入口；只调度叶子 skill，不代替 worker 做语义研究，也不直接创造 Claim、Journey 或 Map 内容。

## 硬门禁

1. 先读取 `repo-support-decision/v1`。只允许 `supported-frontend` 或 `frontend-subtree-only` 继续。
2. 对 `unsupported`、纯后端或无法可靠定位前端 root 的仓库立即终止为 unsupported。不得派 explorer、调用 synthesizer、生成伪前端 Map 或回退旧 backend 流程。
3. 对 `frontend-subtree-only` 只分析 `frontendRoots`；把 `backendRoots` 当外部 unsupported boundary，不读取为本次应用实现。
4. 保持目标仓库只读。对 protected 文件只记录 metadata，不读内容、不推测值。
5. 把 parser failure、unresolved import、protected access、unsupported syntax 和静态绑定失败写入 `deterministicDiagnostics`。不得为它们创建 agent 任务。
   源码解析优先复用官方 compiler/parser provider：Vue SFC 用 `@vue/compiler-sfc`，template 用 `@vue/compiler-dom`，script 按语言交给 TypeScript 或 Babel；adapter 只归一化 fact 与跨 AST 绑定，禁止按仓库名、目录名或业务路由写特判。
6. 只为 `semantic-ambiguity` 规划 agent 工作。把 `runtime-external-blocked` 留作 runtime limitation；把 `product-intent` 交给用户或产品资料，不派 repo explorer。
7. Stage 7 及以后每次 governed agent 调用必须绑定 `repo-research-contract/v1` 与 `repo-work-item/v3`。Stage 6 只接受 `repo-node-semantic-batch-plan/v1` 中带 batchId、allowedFiles、source fingerprints 与唯一 outputRef 的批次；拒绝自由文本 objective。
8. 在全部已派发 WorkItem 到达 accepted/waived 或显式失败策略终态前保持下游 Join。`result-produced` 可以按 manifest 顺序串行 ingest；Join 关闭前不得 synthesize 或 project。
9. 只由编排者持锁串行 ingest。Worker 不得修改 Claim、Question、Journey、Map、run state 或 event log。
10. 把 `repo-work-result/v3.status=completed` 视为 transport 完成，不视为研究完成。只有 `repo-task-outcome/v1.status=satisfied` 且 acceptance criteria 全部满足才关闭 contract。
11. 进入 Map projection、synthesis 或 HTML 前必须满足 Journey Set closure gate：所有 critical Journey closed，且 `journeyClosureRate >= minimumJourneyClosureRate`。当前 CLI 默认 `minimumJourneyClosureRate=1`，即所有 governed Journey 都必须 closed。
12. `repository-atlas.html` 是 deterministic 阶段产物，不属于 Product Map 或最终 human-readable projection。Static Program Graph 生成后即可发布，并在 planning、WorkItem、Journey、projection、synthesis 与 verify 状态变化后刷新；不得让 Journey closure 阻止代码全貌可视化。
13. Static Program Graph 后必须先完成 Node Semantic Catalog。Stage 5 只按 inventory、community、源码体积和指纹生成有界批次，不生成模板问题；Stage 6 只解释单个文件节点，不生成 Journey、业务路径或 API 参数表。
14. `store/node-semantics.json.status=complete` 且 eligible 文件全部为 `accepted` 前，不得进入 Stage 7 Journey Exploration。Worker 只写 batch result；另一个独立 `repo-fact-verifier` Agent 必须对精确 catalog hash 生成 accepted review；编排者才可用 `semantic-ingest` 串行接纳。

## 固定流程

按以下顺序推进，不得跳步：

```text
snapshot
→ support decision
→ static program graph
→ investigation frame
→ repository atlas（deterministic，后续阶段持续刷新）
→ node semantic batch plan
→ node semantic Agent fan-out
→ independent node semantic review
→ serial node semantic acceptance
→ complete Node Semantic Catalog
→ research contracts
→ WorkItem fan-out
→ serial ingest while Join remains open
→ Join closes
→ Journey closure / adjudication
→ Application Map
→ Experience Map
→ Runtime Flow Map
→ Change Map
→ synthesis / human-readable projection
→ verify
→ done | unsupported | blocked
```

### 阶段性可视化

对用户统一显示以下 11 个阶段；状态只使用 `complete|active|ready|blocked|failed|waiting`：

1. Snapshot → `index.json`、`static/inventory.json`
2. Support Decision → `static/support-decision.json`
3. Static Program Graph → graph、code map、community map、neighbor map
4. Investigation Frame → investigation frame、Journey candidates
5. Semantic Planning → `planning/node-semantic-batches.json`、bounded Agent contexts
6. Node Semantics → `store/node-semantics.json`、文件职责/输入/动作/状态/输出/边界
7. Journey Exploration → 基于静态图与 accepted node semantics 的 ResearchContracts、JourneyDefinition/Binding
8. Product Maps → Application、Experience、Runtime Flow、Change Map
9. Synthesis → evidence-grounded narrative
10. Human-readable → final delivery HTML
11. Verify → frontend verification

在第 1–11 阶段都允许刷新：

```bash
npm run --silent understanding:harness -- atlas \
  --package <package-dir> \
  --out <package-dir>/repository-atlas.html
```

Repository Atlas 必须延续最终 HTML 的视觉语言，并至少包含：可切换的阶段轨道及阶段增量、VSCode 式文件树、按文件类型区分的 icon、自上而下的文件级依赖流、上下游切换、逐级展开且不设置总层级上限、每次展开的同层数量上限、循环与重复节点标记、搜索与文件检查器、确定性诊断覆盖层。阶段切换必须只展示该阶段已经产生的真实能力和数据；不得用最终产物冒充历史快照。依赖流默认只展开根节点的一层关系，不得直接把全部 symbol、UI element 与 AST 节点平铺成不可读的全量力导图。

所有 CLI 命令从本仓库根目录执行：

```bash
npm run --silent understanding:harness -- <command> ...
```

### 可执行入口与状态循环

先用独立 package 目录做 support preflight。`scout` 返回 `nextAction=unsupported` 时立即停止；否则建立 v3 分析包。默认用 `fast`，只在用户明确要求更深语义研究时使用 `--mode deep`。

```bash
npm run --silent understanding:harness -- scout \
  --repo <repo-path> --out <package-dir>
npm run --silent understanding:harness -- analyze \
  --repo <repo-path> --out <package-dir> --mode fast
npm run --silent understanding:harness -- status \
  --package <package-dir>
```

之后每次只根据最新 `status.nextAction` 执行一个分支，再重新运行 `status`：

- Static Program Graph 建好后先运行 `npm run --silent understanding:harness -- semantic-plan --package <package-dir>`。Host 按 `research/node-semantics/contexts/batch-*.json` 调度 `repo-explorer` 的 `node-semantic-enrichment` 模式。
- Batch result 返回后先运行 `npm run --silent understanding:harness -- semantic-review-plan --package <package-dir>`，生成绑定精确 catalog hash 的 typed review dispatch。由未生成该 catalog 的 `repo-fact-verifier` 重开源码，写入 `research/node-semantics/reviews/batch-*.review.json`。随后运行 `npm run --silent understanding:harness -- semantic-ingest --package <package-dir>`；`unreviewedBatches` 或 `changesRequestedBatches` 非空时不得提升为 accepted。只有返回 `complete` 才能进入下列 Journey/ResearchContract 状态循环。

- `dispatch`：运行 `npm run --silent understanding:harness -- dispatch --package <package-dir>`，由 host 执行 manifest 中的 WorkItem。
- `await-results`：等待 worker 写完 TaskOutcome/WorkResult，不运行下游命令。
- `ingest`：按 manifest 顺序逐个运行 `npm run --silent understanding:harness -- ingest --package <package-dir> --work-result <work-result.json>`。
- `project`：`validation.gates.productMaps.current` 未通过时运行 `npm run --silent understanding:harness -- project --package <package-dir> --only maps`；Product Maps 与 narrative 均 current 时运行 `npm run --silent understanding:harness -- html --package <package-dir>`。
- `synthesize`：运行 `npm run --silent understanding:harness -- synthesize --package <package-dir>`，由 host 执行返回的 narrative WorkItem，然后按 `ingest` 分支验收。
- `blocked`：运行 `npm run --silent understanding:harness -- verify --package <package-dir>` 并检查 OpenQuestion/Journey closure；对 rejected/abandoned WorkItem 仅用 `retry --package <package-dir> --item <item-id>`，产品输入仅用 `journeys` 命令受控导入。没有受支持的解锁动作时如实终止为 blocked。
- `done`：再运行 `npm run --silent understanding:harness -- verify --package <package-dir>` 做交付复核后终止。
- `unsupported`：报告 support decision 并终止。

### 1. 建立 support decision

运行 deterministic census/support gate，生成 `<package-dir>/static/support-decision.json`（`repo-support-decision/v1`）。验证 `repoKind`、`supportLevel`、`frontendRoots`、`backendRoots` 与证据一致。

- `supported-frontend`：继续分析整个前端范围。
- `frontend-subtree-only`：把 snapshot 与后续读集限制到 frontend roots。
- `unsupported`：记录原因并结束，不生成空 Map 冒充成功。

不得让 agent 覆盖确定性 support decision。

### 2. 构建 StaticProgramGraph

运行 deterministic analyze。先解析源码，再建立 import/export、symbol、render、route、state、API、auth、build/test 与图分析结果。

把下列问题保留为 deterministic diagnostics：

- parser 或 compiler 失败；
- import/module resolution 失败；
- protected 文件不可读；
- unsupported syntax/framework adapter；
- 静态 route/render/state/API binding 缺失。

修 scanner 或报告 unsupported；不得让 agent 猜出缺失静态边。

### 3. 建立 InvestigationFrame

从 support decision 与 static graph 生成 `<package-dir>/static/investigation-frame.json`（`repo-investigation-frame/v1`）。覆盖九个 map dimensions：

- `application-bootstrap`
- `route-layout-page`
- `component-composition`
- `state-ownership-data-flow`
- `api-client`
- `auth-permission`
- `build-deploy`
- `testing-quality`
- `core-journeys`

InvestigationFrame 仅由 deterministic kernel 生成，不派任何独立 worker。需要语义判断的歧义必须进入 ResearchContract，不得把确定性诊断包装成 agent 任务。

### 4. 编译 ResearchContract

先确认 `store/node-semantics.json.status=complete`。本节属于 Stage 7 Journey Exploration；不得复用旧模板问题代替根据静态图与已接纳节点语义形成的真实语义歧义。

把合格的 `semantic-ambiguity` 编译为 `repo-research-contract/v1`。每个 contract 必须包含：

- 明确 questions 与可证伪 hypotheses；
- `targetMaps`（仅 `application|experience|runtime-flow|change`）与 `targetJourneys`；
- allowed files、community、entry entities 与 neighbor depth；
- deterministic context refs；
- acceptance、completion、stop 与 blocked rules；
- budget hints。

按静态图 community 和一阶 neighbor map 组批。禁止按未覆盖文件逐个派任务，也禁止把整个仓库塞进一个 prompt。

维护 OpenQuestion 生命周期：`proposed → qualified → planned → resolved|blocked|waived|invalidated`。只有 `semantic-ambiguity` 可以进入 planned；另外两类不得产生 agent WorkItem。

### 5. 派发 WorkItem v3

只派发以下 `kind`：

- `semantic-research` → `repo-explorer`
- `adjudicate` → `repo-fact-verifier`
- `synthesize` → `repo-synthesizer`

检查 WorkItem 的 `contractRef`、`completionPolicyRef`、`inputArtifactRefs`、`outputSchemaRef`、community、neighbor map、blocking map dimensions 与 blocking journey IDs。

让 worker 只写 `outputArtifactPath` 与 WorkResult 路径。要求 WorkResult v3 填写 `contractId`、`outcomeStatus`、`readSet`、`artifactHashes`、`scopeViolations` 和 `usage.status=reported|unavailable`；不得估算 usage。

本节是 Stage 7 及以后使用的 governed WorkItem。Stage 6 node-semantic worker 使用 `planning/node-semantic-batches.json` 中的 batch identity 和唯一 outputRef，并由 `semantic-ingest` 的专用门禁验收，不得伪装成 Journey ResearchContract。

### 6. 执行 Join

每次只接纳一个 `result-produced` WorkItem，按 manifest 顺序串行 ingest；尚未返回的项继续等待。逐项检查：

- identity、attempt、snapshot 与 contract 匹配；
- output artifact 存在且 hash 匹配；
- readSet fingerprint 未 stale；
- scopeViolations 为空；
- WorkResult 与 TaskOutcome 状态一致。

任何 WorkItem 仍为 issued/result-produced 时保持 Join。任何 stale、越界或 schema 失败结果都拒绝 ingest，并按 contract 的 retry/blocked policy 处理。

### 7. 串行 ingest

取得 package write lock，按 manifest 顺序逐个 ingest。将 Hypothesis 作为待治理研究结果，不直接当 Claim。

- `supported`：满足证据门禁后才可转 accepted Claim。
- `refuted`：保留反证并关闭或重开相关 question。
- `inconclusive`：不得视为通过；按 OpenQuestion 分类路由。
- `partially-satisfied`：保留有效结果，但不关闭 blocking contract。
- `blocked|failed`：记录原因，不绕过关键维度。

### 8. 闭合 Journey

用 `repo-journey-definition/v1` 表达 actor、goal、trigger、有序 steps、branches、feedback 与 outcomes；用 `repo-journey-binding/v1` 绑定 page、UI element、event、handler、effect、state transition、request、endpoint、feedback 与 outcome。

只使用 Journey status `candidate|open|closed|blocked|invalidated` 与 binding status `confirmed|candidate|conflicted|missing`。不得把 candidate/missing binding 计入闭合步骤。

对每条 governed Journey 检查完整闭合链；critical Journey 不得通过降低 closure rate 门槛豁免：

```text
entry → page/layout → user action → event → handler → effect
→ state transition → request/endpoint → feedback → outcome
→ failure/alternate/retry/exit branches
```

遇到冲突 Hypothesis 或高风险 auth/request/state/outcome binding 时创建 `kind=adjudicate` contract。未满足 Journey Set closure gate 时不得生成 Map 或进入成功终态；默认要求所有 governed Journey closed，且所有 critical Journey 必须 closed。

当 `product-intent` 需要 Dylan 或产品资料补充 actor、goal、branch 或 outcome 时，先把经确认的 `JourneyDefinition[]` 与 `JourneyBinding[]` 写到隔离输入文件，再由编排者执行：

```bash
npm run --silent understanding:harness -- journeys \
  --package <package-dir> \
  --definitions <definitions.json> \
  --bindings <bindings.json>
```

该命令会校验 snapshot、binding 完整性与 closure，串行替换权威 Journey Store，并把已闭合的 product-intent question 标为 resolved；不得直接编辑 `store/journeys/` 绕过校验。

### 9. 生成四张 Map

只从 static graph、accepted Claims、JourneyDefinition 与 JourneyBinding 确定性生成：

- **Application Map**：bootstrap、route/layout/page、component、state、API/auth/build/test 边界。
- **Experience Map**：audience、goal、page、interaction、feedback、success/failure outcome。
- **Runtime Flow Map**：按稳定顺序和 branch 展示关键 Journey 的运行链。
- **Change Map**：reverse dependencies、affected page/Journey、state/API/auth surface、tests 与 build/deploy impact。

不得把旧 architecture/domain/flow/code-map 作为同级公开产物，也不得让 synthesizer 即兴生成 Map 关系。

### 10. 综合、渲染与验证

仅在四张 Map 已生成且 Journey Set closure gate 仍通过后派发 `kind=synthesize`。让 `repo-synthesizer` 只消费四张 Map、Journey 与 governed OpenQuestion，再让 `repo-human-readable` 从同一组权威产物和已验证 narrative 渲染 HTML。

Active workflow package 必须由编排者执行 harness `html --package <package-dir>` 或 `project --only html`，让 wrapper 写入 `projection-built` 并在 complete gate 通过时发出 `run-completed`。底层 HTML renderer 仍是只读 leaf；`understanding:human-html` 只适用于不存在 `state/run-state.json` / `store/run-events.jsonl` 的隔离 projection-only package，不得用它绕过 active workflow completion。

最终验证必须确认：

- 所有 required map dimensions 完成；
- 所有 critical semantic ambiguity 已 resolved 或 adjudicated；
- Journey Set closure rate 达到配置门槛（默认 100%）、所有 critical Journey closed，且 branch 与 evidence 可追溯；
- 没有 in-flight WorkItem；
- deterministic verification 通过；
- projection hash 与 static graph、accepted Claim set、Journey set 一致；
- backend/fullstack boundary 未被越界读取。

不得用 raw fact 数、文件覆盖率、固定轮数或 token 耗尽宣称完成。预算只能停止新增非关键研究，不能豁免 critical contract 或 Journey step。

## 返回

返回 support level、frontend roots、package 路径、Node Semantic Catalog 的 accepted/eligible 覆盖率与缺失批次、四张 Map 路径、Journey Set closure rate/门槛与 critical Journey 闭合状态、未解决 OpenQuestion 分类、deterministic diagnostics、verification 结果、HTML 路径，以及每个 WorkItem 的 status/outcomeStatus/usage 汇总。所有数字和状态必须来自产物，不得美化。
