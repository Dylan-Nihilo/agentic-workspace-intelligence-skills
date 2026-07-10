# Repo Understanding Skill-first 重构设计

- 状态：已批准
- 日期：2026-07-10
- 架构定位：ADK 2.0-aligned runtime-neutral workflow protocol
- 产品边界：Skill-first
- 决策：不提供任何 runtime adapter、runtime runner 或 legacy integration

## 1. 摘要

本项目重构为一套可由任意 agent runtime 承载的 repo understanding skill 族。承载 skill 的 host agent 负责选择模型、调度 worker、决定并行或串行；本项目只提供 runtime-neutral skills、确定性 kernel、版本化协议和知识产物。

Kernel 永远不启动模型、subagent 或外部 agent CLI。所有语义工作统一表现为 WorkItem 输入和 WorkResult 输出。所有权威状态变更统一经过 kernel。最终知识资产由不可变 Evidence、受治理 Claim 和可重建 Projection 组成。

该设计对齐 ADK 2.0 的 graph、dynamic、collaborative workflow、typed node I/O、event ownership、fan-out/fan-in、retry 和 trajectory evaluation 原则，但不绑定 Google ADK SDK，也不宣称 ADK SDK 原生兼容。

## 2. 目标

1. 任意能够读取 skill、运行确定性脚本和读写文件的 agent runtime 都能执行完整流程。
2. 对任意单仓库产出可验证的架构、业务域、运行链路、知识数据集、wiki、HTML 和检索数据。
3. 每个 Claim 都能回溯到仓库快照中的 Evidence，推断与事实明确分离。
4. 支持 fast 和 deep 两种分析深度，但不依赖具体模型名或 runtime 能力。
5. 支持增量分析、失败恢复、任务重试、成本统计和跨 runtime 质量评估。
6. HTML、RAG、wiki 和 FactGraph 都是同一知识底座的 Projection。
7. Skill 文本保持精简，复杂规则通过 references、assets、schemas 和 deterministic kernel 渐进披露。

## 3. 非目标

1. 不实现 Codex、Claude、ADK 或其他 runtime adapter。
2. 不保留 explore --runner codex 或任何同类 legacy runner、alias、shim、fallback。
3. 不由 kernel 主动创建、恢复、取消或监控 agent session。
4. 不在协议中出现具体模型名，不保证 host 能按模型或 effort 分档。
5. 不要求用户安装 Google ADK，也不把 ADK Event、Session 或 ArtifactService 作为核心依赖。
6. 不允许 worker 直接编辑 Evidence、Claim、run state、FactGraph、wiki 或 HTML。
7. 不把 HTML 或 RAG index 当作分析真相源。
8. 不做一次性 clean-slate 替换；按可验证切片逐步替换旧核心，但不保留旧执行 integration。

## 4. 架构原则

### 4.1 Skill-first

Host runtime 是 agent 执行者。Skill 描述目标、角色、流程和门禁。Kernel 提供确定性原语。项目不拥有 runtime。

### 4.2 确定性控制，语义叶子

Snapshot、census、规划、状态迁移、校验、ingest、verification 和 projection 必须是确定性节点。LLM 只用于 profile refinement、证据探索、语义裁决和业务综合。

### 4.3 单一状态所有者

Worker 只写隔离 WorkResult。Orchestrator 收集结果并调用 kernel。Kernel 是唯一可以改变任务状态、Evidence、Claim、Gap 和 Projection 的组件。

### 4.4 事件先于快照状态

每次状态变更先追加不可变 RunEvent，再物化 run-state。run-state 可以从 RunEvent 重建。不得手工编辑 run-state。

### 4.5 大数据是 artifact，小状态用于路由

run-state 只保存当前节点、任务计数、门禁结果、预算和 nextAction。Evidence、Claim、WorkItem、WorkResult 和 Projection 使用独立 artifact 文件。

### 4.6 能力降级必须完成任务

Host 不支持 subagent 时，由主会话顺序执行 worker skill。Host 不支持并行时顺序执行。Host 不支持模型选择时忽略 qualityClass。缺失能力不能破坏正确性。

### 4.7 Projection 可丢弃、可重建

FactGraph、architecture、domain、flow、knowledge index、wiki、report 和 HTML 都可以从 Snapshot、Evidence 和 Claim 重建。

## 5. 系统责任边界

### 5.1 Host Agent Runtime

负责：

- 读取和触发 repo-understanding skill；
- 按 WorkItem 选择主会话或 worker；
- 决定并行或串行；
- 自行选择模型、effort 和工具；
- 将 worker 输出写到 WorkItem 指定的 WorkResult 路径；
- 把 worker 完成或失败情况返回给 orchestrator。

Host 不直接写权威知识数据。

#### 最低 Host 能力契约

“任意 agent runtime”指满足以下最低能力的 host：

1. 能定位并读取 SKILL.md 及其 references 和 assets；
2. 能只读访问目标仓库；
3. 能执行 suite 内附带的 Node.js 20+ deterministic CLI；
4. 能读写 package 目录中的 JSON、JSONL 和文本 artifact；
5. 能按 output schema 生成结构化结果。

Subagent、并行执行、指定模型、session resume 和 token usage 都是可选能力，不属于最低契约。不满足 deterministic CLI 执行能力的纯聊天 runtime 不在支持范围内。

### 5.2 Skill Suite

保留六个角色：

| Skill | 职责 |
| --- | --- |
| repo-understanding | 主编排，读取 status，执行确定性节点，派发 WorkItem，串行 ingest |
| repo-scout | 只处理条件式 profile refinement WorkItem |
| repo-explorer | 定向读取源码并返回带 Evidence 引用的候选 Claim |
| repo-fact-verifier | 对高风险 Claim 或冲突 Claim 做语义裁决 |
| repo-synthesizer | 在 verification 通过后生成业务域、关键流程和人类解释 |
| repo-human-readable | 调用确定性 projection，不生成新事实 |

每个 SKILL.md 只保留触发条件、主流程、硬门禁、输入输出和返回约定。详细协议进入 references，模板进入 assets，确定性逻辑进入 kernel。

### 5.3 Deterministic Kernel

负责：

- RepoSnapshot 与 fingerprint；
- deterministic census 和静态关系；
- profile confidence 与 refinement 条件；
- Gap 识别、语义聚类、优先级和预算；
- WorkItem 生成；
- RunEvent、run-state 和 nextAction；
- WorkResult schema、Evidence、Claim 和 source range 校验；
- 串行 ingest 和冲突治理；
- deterministic verification；
- 所有 Projection。

Kernel 禁止包含模型调用、agent session 调用和 runtime 专属分支。

## 6. Workflow Graph

规范宏观流程如下：

1. Snapshot：冻结 repo 路径、Git 状态、内容 fingerprint 和 protected policy。
2. Census：一次扫描生成 inventory、language mix、manifests、symbols、imports、routes 和静态架构信号。
3. Profile Gate：判断 deterministic profile 是否足够可信。
4. Profile Refine：仅在 unknown、冲突或低置信时生成 agent WorkItem。
5. Plan：从 Gap、Claim 风险和目标 Projection 生成语义批次。
6. Fan-out：host 执行一个或多个 WorkItem。
7. Join：等待本批所有 blocking WorkItem 到达终态。
8. Ingest：逐个校验 WorkResult，追加 Evidence、Claim、Gap 和 RunEvent。
9. Gap Evaluation：计算边际收益、剩余预算和停止条件。
10. Loop：仍有高价值 Gap 时回到 Plan。
11. Verify：执行 deterministic verification，并按风险生成可选语义裁决 WorkItem。
12. Synthesize：所有 blocking 项终态且 verification 通过后生成综合 WorkItem。
13. Validate Synthesis：校验综合内容只引用已接受 Claim。
14. Project：生成 FactGraph、architecture、domain、flow、RAG、wiki、report 和 HTML。
15. Done 或 Blocked：记录明确终止原因。

这是动态 workflow：宏观节点固定，探索轮次、任务数量和路由由确定性状态决定。

### 6.1 ADK 2.0 语义映射

| ADK 2.0 概念 | 本协议中的 runtime-neutral 等价物 |
| --- | --- |
| Workflow graph | 固定宏观节点与确定性 nextAction 路由 |
| Dynamic workflow | Gap Evaluation 驱动的 Plan、Fan-out、Join、Ingest 循环 |
| FunctionNode | 单一职责的 deterministic kernel command |
| AgentNode | WorkItem 加对应 worker skill |
| Coordinator agent | repo-understanding orchestrator skill |
| Event output | WorkResult envelope 和角色 output artifact |
| Event state | 小型 run-state 路由状态 |
| Event history | append-only run-events.jsonl |
| Artifact service | Snapshot、Evidence、Claim、Gap 和 Projection store |
| Parallel paths | Host 可选的并行 WorkItem 执行 |
| Join node | Kernel 强制的 blocking WorkItem resolution barrier |
| Workflow evaluation | Contract、behavioral 和 trajectory eval |

该映射只定义语义，不导入 ADK SDK 类型。ADK host 可以把 FunctionNode 映射为 kernel command、把 AgentNode 映射为 worker skill；其他 host 使用自己的原生执行方式。

## 7. Work 协议

### 7.1 WorkItem

WorkItem schemaVersion 为 repo-work-item/v2，至少包含：

| 字段 | 含义 |
| --- | --- |
| itemId | 稳定任务标识 |
| runId | 所属运行 |
| attempt | 从 1 开始的尝试号 |
| kind | profile-refine、explore、adjudicate、synthesize |
| role | 应加载的 worker skill |
| objective | 单一、可验收的目标 |
| dependencies | 前置 WorkItem 或 Claim |
| contextManifest | 输入 artifact 引用，不内嵌整个仓库 |
| outputSchemaRef | 结果 schema |
| outputPath | 隔离 WorkResult 路径 |
| qualityClass | routine、analytical、critical |
| criticality | low、medium、high |
| budgetHints | 文件数、上下文字节、预期完成范围 |
| idempotencyKey | 同一 snapshot 和任务语义下稳定 |

qualityClass 和 budgetHints 都是 host 可忽略的声明式提示，不是 runtime 命令。

### 7.2 WorkResult

WorkResult envelope schemaVersion 为 repo-work-result/v2，至少包含：

| 字段 | 含义 |
| --- | --- |
| itemId、runId、attempt | 必须与 WorkItem 完全匹配 |
| status | completed、failed、blocked |
| output | completed 时指向角色专属结果 artifact；failed 或 blocked 时可省略 |
| evidenceRefs | 本次读取的 source Evidence 引用 |
| observations | 非事实运行观察 |
| errors | 结构化失败原因 |
| producer | role 必填；runtime、model、effort、usage 均为可选自报字段 |
| producedAt | 结果生成时间 |

角色专属 output 继续使用独立 schema，避免一个万能 schema 混合 scout、explorer、verifier 和 synthesizer 语义。

### 7.3 Worker 写入规则

1. Worker 只能写自己的 WorkResult envelope 和角色 output artifact。
2. Worker 不调用 ingest，不修改任务状态，不重建 Projection。
3. Worker 一次 invocation 只对应一个 attempt。
4. Worker 失败时如实返回 failed 或 blocked，不在内部吞掉失败并伪装完成。

## 8. 状态与事件

### 8.1 WorkItem 状态

合法状态为：

- ready：可由 orchestrator 派发；
- issued：已交给 host，尚无结果；
- result-produced：结果文件存在，尚未 ingest；
- accepted：结果通过校验并完成 ingest；
- rejected：结果未通过校验；
- abandoned：host 明确放弃该 attempt；
- waived：依据明确 policy 或用户授权被豁免，并记录原因和授权来源。

rejected 后重试必须创建 attempt 加一的新 WorkItem，不覆盖旧结果。

### 8.2 RunEvent

RunEvent schemaVersion 为 repo-run-event/v2。run-events.jsonl 采用 append-only 事件，至少支持：

- run-created；
- snapshot-created；
- census-completed；
- work-planned；
- work-issued；
- result-detected；
- result-accepted；
- result-rejected；
- work-abandoned；
- claim-accepted；
- claim-refuted；
- verification-passed；
- verification-failed；
- synthesis-accepted；
- projection-built；
- run-blocked；
- run-completed。

每个事件包含 eventId、runId、sequence、eventType、occurredAt、actor、payload 和 previousEventHash。

### 8.3 nextAction

run-state schemaVersion 为 repo-run-state/v2。

合法值为：

- bootstrap；
- refine-profile；
- dispatch；
- await-results；
- ingest；
- verify；
- synthesize；
- project；
- done；
- blocked。

只要存在 issued 项，nextAction 不得为 synthesize、project 或 done。存在 result-produced 时必须优先 ingest。Blocking 项只有 accepted 或依据 policy、用户授权显式 waived 才算 resolved；critical blocking 项禁止自动 waive。Rejected 或 abandoned 的 blocking attempt 必须创建替代 attempt；无法替代时 run 进入 blocked，不能通过 Join。非 blocking 项可以 rejected、abandoned 或 waived 后结束。

## 9. Knowledge Data Model

### 9.1 RepoSnapshot

RepoSnapshot schemaVersion 为 repo-snapshot/v2。它是分析身份边界，包含 repo identity、Git revision、dirty fingerprint、scan roots、protected patterns、file manifest 和内容摘要。一次 run 只绑定一个 Snapshot。源仓库变化后必须新建 Snapshot 或显式进入 incremental run。

### 9.2 Evidence Store

Evidence schemaVersion 为 repo-evidence/v2。Evidence 是不可变的 source observation，至少包含：

- evidenceId；
- snapshotId；
- source path；
- startLine 和 endLine；
- snippet；
- snippetHash；
- fileContentHash；
- extractor；
- protected 标记；
- capturedAt。

同一 source range 和内容 hash 去重。源文件变化时旧 Evidence 不修改，新 Snapshot 生成新 Evidence。
Protected 文件只允许 metadata Evidence，不得保存 snippet、内容 hash 或任何文件内容派生值。

### 9.3 Claim Store

Claim schemaVersion 为 repo-claim/v2。Claim 表达可验证知识，至少包含：

- claimId；
- subject、predicate、object；
- qualifiers；
- evidenceIds；
- derivation：deterministic 或 agent；
- status：proposed、accepted、refuted、superseded；
- confidence；
- riskClass；
- createdByItemId；
- verification records；
- supersedes 和 supersededBy。

只有 accepted Claim 能进入正式 Projection。推断必须以 derivation 和 confidence 明示，不能伪装成静态事实。

### 9.4 Gap Store

Gap schemaVersion 为 repo-gap/v2。Gap 是尚未解决的知识需求，不属于 Claim。Gap 至少包含 target Projection、问题、相关实体、优先级、风险、expectedInformationGain、estimatedCost、状态和来源。合法状态为 open、planned、resolved、waived、blocked；critical Gap 禁止自动 waived。

Gap 经过 planner 聚类后生成 WorkItem，不能保持一文件一任务的机械映射。

### 9.5 Projection

Projection 包含：

- FactGraph：兼容图查询的 Claim 图视图；
- Architecture：组件、边界、依赖和入口视图；
- Domain：业务实体、规则、能力和所有权视图；
- Flow：请求、状态、数据和异步链路视图；
- Knowledge Index：面向检索的实体、模块、流程和决策 chunk；
- Wiki、report 和 HTML：面向人的解释视图。

Projection 记录 projectionVersion、snapshotId、claimSetHash 和生成器版本。任何 Projection 都不得反向修改 Claim。

新 FactGraph 使用 repo-fact-graph/v2。迁移期允许额外生成 repo-fact-graph/v1 兼容 Projection，但 v1 只能从 v2 Claim Store 单向生成。

## 10. L0 与扫描策略

1. Deterministic census 始终执行，并且是全流程唯一一次全仓扫描。
2. L1 静态分析复用 census artifact，不重复 walk 和解析同一文件。
3. Agent profile refinement 默认不执行。
4. 仅在以下条件之一成立时生成 profile-refine WorkItem：repoKind unknown、语言与 manifest 冲突、入口无法确定、source root 置信不足、用户明确要求 deep profile。
5. Profile refinement 只能影响 scan policy 和 planner，不能直接生成业务 Claim。
6. Snapshot fingerprint 未变化时复用 census 和 profile。

## 11. 规划、批处理与成本

### 11.1 语义批处理

Planner 以组件、业务域、调用链、route group、dependency cluster 或风险主题聚类 Gap。禁止按每个 uncovered file、每条 edge 或每个 unresolved import 机械创建独立任务。

### 11.2 优先级

优先级由以下因素确定：

- 目标 Projection 是否依赖该 Gap；
- 错误后果和风险；
- expectedInformationGain；
- estimatedCost；
- 是否可由 deterministic scanner 解决；
- 是否阻塞关键架构或业务问题。

### 11.3 分析模式

fast：优先 deterministic census，只处理阻塞架构理解的高价值 Gap，生成核心架构、域和检索资产。

deep：扩大语义覆盖和 adversarial verification，分析关键流程、异常路径、权限、数据一致性和跨模块影响。

两种模式共享 schema、状态机和质量门，不维护两套流程。

### 11.4 停止条件

必须记录以下一种 stopReason：

- coverage-reached；
- all-blocking-work-resolved；
- budget-exhausted；
- wall-time-reached；
- no-marginal-gain；
- max-depth-reached；
- user-stopped；
- unrecoverable-blocker。

coverage 不能单独证明完成。Blocking WorkItem 必须 resolved；critical Gap 必须 resolved 或经用户明确 waived。任何 critical Gap 进入 blocked 时，run 必须进入 blocked，不能完成。

## 12. 错误、重试与恢复

1. WorkResult schema 错误产生 result-rejected 事件，错误列表保持机器可读。
2. Retry policy 由 orchestrator 执行，默认最多两个新 attempt；worker 不自重试 ingest。
3. 每次 attempt 使用独立文件，保留失败轨迹。
4. Kernel crash 后从 run-events 重建 run-state，再扫描 result 文件识别未提交结果。
5. Host worker 消失时，orchestrator 可将 issued attempt 标记 abandoned，再创建新 attempt。
6. Snapshot 改变后未 ingest 的旧结果必须拒绝，不能跨快照写入。
7. 任何未捕获 kernel 异常必须非零退出，不得降级成成功结果。
8. blocked run 必须列出 blocking item、失败原因和恢复动作。

## 13. Verification 与 Evaluation

### 13.1 Contract Evaluation

- 所有 schema version 和 required field；
- WorkItem 与 WorkResult identity 匹配；
- 合法状态迁移；
- run-state 可从事件重建；
- Projection 可从同一 Claim 集合重复生成相同摘要。

### 13.2 Behavioral Evaluation

- issued 存在时不得 synthesize；
- worker 直接修改权威 store 必须被检测；
- rejected retry 生成新 attempt；
- snapshot mismatch 必须拒绝；
- verification fail 不得进入 synthesis；
- 无 subagent runtime 可顺序完成同一流程。

### 13.3 Knowledge Quality Evaluation

- predicate precision 和 recall；
- Evidence range precision；
- Claim groundedness；
- 架构问答正确率与引用完整率；
- domain/flow 的 source support；
- open critical Gap 数量。

### 13.4 Retrieval Evaluation

- Hit@k；
- nDCG；
- answer faithfulness；
- citation precision；
- trivial chunk ratio；
- duplicate context ratio。

### 13.5 Cost Evaluation

- accepted Claim per token；
- accepted Claim per minute；
- cost per correct architecture answer；
- context reuse ratio；
- marginal gain per round。

### 13.6 Trajectory Evaluation

- 节点顺序是否合法；
- fan-out 后是否经过 Join；
- 是否绕过 ingest；
- retry、waive、blocked 是否有事件；
- synthesis 和 projection 是否只在门禁后执行。

## 14. 目录设计

目标结构：

    packages/
      repo-understanding-kernel/
        src/
          snapshot/
          census/
          planning/
          workflow/
          ingest/
          knowledge/
          verification/
          projections/
        schemas/
        test/
      repo-understanding-cli/
        src/
        test/
    skills/
      repo-understanding/
      repo-scout/
      repo-explorer/
      repo-fact-verifier/
      repo-synthesizer/
      repo-human-readable/
    evals/
      contract/
      behavioral/
      knowledge/
      retrieval/
      trajectory/

发布单元是完整 repo-understanding skill suite，包含 skills、deterministic CLI、kernel 和 schemas。Runtime 注册各 skill 入口，但不能把单个 skill 目录脱离 suite 后单独分发。repo-understanding skill 内的薄 launcher 只负责定位 suite 内 CLI 并透传参数，不启动 agent。

仓库中不创建 adapters、runners 或 integrations 目录。

## 15. Skill 内容规范

1. 每个 SKILL.md 控制在 500 行以内，目标保持在 150 行以内。
2. Frontmatter 只包含触发、版本和协议声明，不放具体模型配置。
3. Runtime-neutral 正文不得出现 Codex、Claude、Gemini、Task tool 或某 SDK 的专属调用方法。
4. 使用能力条件句描述 parallelism 和 subagent。
5. references 只在对应步骤需要时加载。
6. scripts 只能是 deterministic CLI 薄入口，不启动 agent。
7. assets 只放 output template 或展示资源。
8. Skill 不重复 schema，不复制 kernel 规则。

## 16. 迁移与删除策略

### 16.1 立即禁止

- 新增任何 runtime adapter 或 runner；
- 扩展 explore --runner codex；
- 新增 runtime-specific skill 正文；
- 让 worker 调用 ingest；
- 继续把 effort 当作可强制模型档位。

### 16.2 删除而非兼容

explore 命令及其 --runner codex 路径直接删除。同步删除 codexAvailable、runCodexExplorer、相关 usage、错误提示和测试。不保留 alias、shim、deprecated wrapper 或 fallback。

### 16.3 数据兼容边界

旧 FactGraph、wiki 和 HTML 文件格式可以在迁移期作为 versioned Projection 生成，但只能由新 Claim Store 单向生成。禁止旧路径与新路径双写，禁止旧文件反向 ingest 到 Claim Store。

### 16.4 Strangler 边界

旧 monolith 按 snapshot、census、workflow、knowledge、projection 切片逐步替换。每个切片只有在新实现通过 contract 和 golden evaluation 后才删除旧实现。执行 integration 不参与 Strangler，直接删除。

## 17. 实施切片与门禁

### Slice 0：基线与协议冻结

- 冻结三个真实基准仓库和 mini repo；
- 保存质量、token、耗时和产物基线；
- 新增 WorkItem、WorkResult、RunEvent 和 run-state schema；
- 添加 ADK-aligned trajectory contract。

退出门禁：现有 deterministic contract 全绿；新 schema contract 全绿；基线可重复。

### Slice 1：状态机与 Join Barrier

- 实现 append-only RunEvent；
- 从事件物化 run-state；
- 实现新 WorkItem 状态和 nextAction；
- 修复 issued 被误判为可 synthesize；
- 增加 crash rebuild 和 snapshot mismatch 测试。

退出门禁：任何在途 WorkItem 都不能越过 Join；状态可完整重建。

### Slice 2：统一 Work 协议与删除 runner

- dispatch 改为生成 repo-work-item/v2；
- worker 输出改为 repo-work-result/v2 envelope；
- orchestrator 成为唯一 ingest 调用者；
- 删除 explore、--runner codex 和所有相关代码；
- 修订六个 skill 的责任边界。

退出门禁：PATH 中无 Codex、Claude 或 ADK CLI 仍可完成 deterministic contract；源码无 agent runner。

### Slice 3：L0 与成本重构

- 一次 census；
- 条件式 profile refine；
- fingerprint cache；
- 语义 Gap batching；
- hard context cap 和 marginal-gain stop。

退出门禁：质量不下降超过 2 个百分点；初始目标 token 降低 40%，耗时降低 50%。

### Slice 4：Evidence、Claim、Gap Store

- 新建 v2 stores；
- deterministic facts 与 agent candidates 统一进入 Claim governance；
- verifier 只改变 Claim 状态；
- FactGraph 改为 Projection。

退出门禁：所有 accepted Claim 可回溯 Evidence；FactGraph 可完全重建。

### Slice 5：Projection 与 RAG

- architecture、domain、flow 使用同一 Claim 集合；
- RAG chunk 按 entity、module、flow、decision 生成；
- HTML 和 wiki 只读 Projection；
- 建立 retrieval 和 grounded QA eval。

退出门禁：不存在无 Evidence 的正式展示 Claim；检索与问答达到冻结阈值。

### Slice 6：拆分 monolith 与发布

- 将旧 shared/understanding 巨型文件迁入 kernel 子模块；
- 发布 deterministic CLI package；
- skill 通过相对 package locator 或安装清单定位 CLI；
- 删除已替换旧模块和旧 npm script。

退出门禁：干净安装后能在至少两个不同 host runtime 中按同一 skill 协议完成基准；无 runtime-specific integration。

## 18. 成功标准

### 正确性

- premature synthesis 为零；
- accepted Claim 无 Evidence 的数量为零；
- Projection 反向写入权威 store 为零；
- in-flight WorkItem 泄漏为零。

### 质量

- 架构问答正确率和 citation precision 不低于冻结基线；
- critical relation precision 不低于冻结阈值；
- verifier 误删和漏拦截均有独立回归集。

### 效率

- 相对当前真实基准，首阶段目标 token 降低 40%；
- wall time 降低 50%；
- duplicate context ratio 持续下降；
- no-marginal-gain 能在无新增有效 Claim 时停止循环。

### 可移植性

- Skill 正文无 runtime 专属调用；
- Kernel 无模型或 agent 进程调用；
- 无 subagent 能力时可顺序完成；
- 支持 subagent 时可 fan-out，并通过同一 Join 和 ingest 门禁。

## 19. 已批准决策

1. 产品采用 Skill-first，不构建独立 agent execution engine。
2. 使用协议优先的 Strangler 重构，不做 clean-slate 重写。
3. 采用 ADK 2.0-aligned 表述，不宣称 ADK SDK compliant。
4. 不做任何 runtime adapter。
5. 不做任何 legacy integration；现有 runtime runner 直接删除。
6. Runtime 负责 agent 调度，kernel 负责确定性状态和知识治理。
7. WorkItem、WorkResult、RunEvent 是跨 runtime 的核心协议。
8. Evidence 是不可变观察，Claim 是治理对象，FactGraph 是 Projection。
9. L0 agent refinement 是条件式节点，不是必经节点。
10. Evaluation 同时覆盖 workflow trajectory、知识质量、检索质量和成本。

## 20. 规范参考

- Google ADK 2.0 Overview：https://adk.dev/2.0/
- ADK Workflows：https://adk.dev/workflows/
- ADK Graph Workflows：https://adk.dev/graphs/
- ADK Collaborative Workflows：https://adk.dev/workflows/collaboration/
- ADK Workflow Data Handling：https://adk.dev/workflows/data-handling/
- ADK Graph Routes and Join：https://adk.dev/graphs/routes/
- ADK Evaluation：https://adk.dev/evaluate/
- Codex Skill Creator 本地规范：/Users/c0007/.agents/skills/skill-creator/SKILL.md
