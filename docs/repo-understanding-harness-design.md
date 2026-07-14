# Repo Understanding Frontend-first v3 设计

本文是当前实现契约，不是历史说明。对应代码位于：

- `packages/repo-understanding-kernel/`
- `packages/repo-understanding-cli/`
- `skills/repo-*`

## 1. 目标与边界

v3 的交付目标是回答四类消费问题：

1. Application：应用如何启动，route、layout、page、component、state、API、auth、build 和 test 如何组成。
2. Experience：用户以什么目标进入，经过哪些步骤、分支和可见反馈，最终成功或失败。
3. Runtime Flow：Journey 的每一步具体绑定到哪个 UI、event、handler、state、request、endpoint、response、feedback 或 outcome 实体。
4. Change：改动一个实体后，会影响哪些依赖、route、page、Journey、state、API、auth、test 和 build surface。

支持范围仅包含前端仓库和全栈仓库中可确定隔离的前端子树。backend 与 unknown 仓库 fail closed。v3 不提供 generic backend fallback，也不把多仓系统边界塞进单仓包。

## 2. 权威层级

v3 没有单一万能图。不同事实由不同权威层负责：

| 层 | 权威内容 | 可否由 worker 直接写 |
|---|---|---|
| Snapshot / Census | repo identity、文件 hash、manifest、保护状态 | 否 |
| SupportDecision | frontend、frontend-subtree-only 或 unsupported | 否 |
| Static Program Graph | 编译可观察的程序结构和关系 | 否 |
| Semantic Evidence / Claim | semantic Hypothesis 经 contract 验收后的结论 | 否，只能串行 ingest |
| JourneyDefinition / Binding | 用户旅程语义、代码绑定和 closure 状态 | 否，只能通过 Journey store writer |
| Product Maps | 上述权威输入的确定性消费投影 | 否，可重建 |
| Narrative / HTML | 对当前 Map 与 governed refs 的解释 | narrative 由 worker 候选输出，ingest 后才生效；HTML 纯确定性 |

因此，“结构存在”与“产品含义成立”是两件事。编译器可以确认按钮触发 handler、handler 发出 request，却不能据此发明用户是谁、目标是什么、成功意味着什么。

## 3. Frontend 支持门禁

`buildRepoSupportDecision` 根据 inventory、manifest、code map 和 deterministic profile 生成 `repo-support-decision/v1`：

- frontend → `supported-frontend`
- fullstack 且 frontend roots 可确定 → `frontend-subtree-only`
- backend → `unsupported` / `backend-repository`
- unknown → `unsupported` / `repository-kind-unknown`
- fullstack 但无法建立 frontend root → `unsupported`

`unsupported` 是 terminal state。系统仍可保留 census 和 SupportDecision 作为解释证据，但不会生成 ResearchContract 或派 agent work。

## 4. Deterministic compiler 与 Static Program Graph

`buildStaticProgramGraph` 在 SupportDecision 的 active roots 内工作。它优先使用 compiler/parser：

- TypeScript compiler：JS、JSX、TS、TSX 及模块关系。
- `@babel/parser`：TypeScript 失败时的 AST fallback。
- `@vue/compiler-sfc`：Vue SFC 的 script/template block。
- Svelte compiler 若可用则使用；不可用时记录诊断并使用 deterministic fallback lexer。

图节点覆盖 module、symbol、route、bootstrap、layout、page、UI element/event、handler、state、request、endpoint、response、feedback/outcome candidate、auth guard、build wiring、test wiring 等。边覆盖 import/export、route-page、render、event-handler、state mutation、request-endpoint、response、feedback/outcome candidate、auth、build 和 test 关系。

每个节点和边都带 source range、provider、source kind、structure fingerprint、evidence refs 和稳定 id。import 解析、parser failure、protected-file、compiler unavailable 等问题写入 `diagnostics[]`。

硬规则：deterministic diagnostic 不会变成 OpenQuestion，也不会触发 agent。修复解析器属于工程修复，不属于“让模型再看一遍”。

Static Program Graph 完成后，kernel 以稳定 Louvain 分区生成：

- `static/community-map.json`
- `static/neighbor-map.json`

ResearchContract 用 community 和一跳 neighbor 限定阅读范围，不允许 worker 自行扩大到全仓。

## 5. InvestigationFrame 与问题分类

`repo-investigation-frame/v1` 汇总以下确定性视角：

- framework / bundler / workspace roots
- browser bootstrap / application root
- route roots / layout / page candidates
- state / API client / auth-permission
- build-deploy / test-quality surfaces
- core flow candidates
- deterministic diagnostics
- unresolved semantic ambiguities

`qualifyOpenQuestions` 只接受三种问题：

| 分类 | 是否派 agent | 处理方式 |
|---|---:|---|
| `semantic-ambiguity` | 是 | 必须包含至少两个竞争 Hypothesis，编译 ResearchContract |
| `runtime-external-blocked` | 否 | 留作 runtime limitation，需要运行时证据 |
| `product-intent` | 否 | 交给用户或产品资料，不让 repo explorer 猜 |

parse、syntax、import、module resolution、protected-file、missing-file、line-range 一律降为 deterministic diagnostic。

## 6. ResearchContract → WorkItem → TaskOutcome

### 6.1 ResearchContract

`repo-research-contract/v1` 明确写出：

- questions 和 contracted Hypotheses
- target Product Maps 与 target Journeys
- allowed files、entry entities、community、neighbor depth
- support / counter evidence 要求
- acceptance criteria、completion rules、stop rules
- blocked policies 和 budget hints

没有 contract 的语义探索不允许进入 authoritative store。

### 6.2 WorkItem v3

`dispatch` 从 `planning/manifest.json` 中选择尚未派发的 contract，生成 `repo-work-item/v3` 和 batch manifest。WorkItem 固定 `contractRef`、`completionPolicyRef`、input refs、output schema、output path、scope、criticality 和 budget hints。

Host runtime 可以并行执行独立 WorkItem。Worker 只允许：

1. 读取 WorkItem 声明的输入。
2. 写指定的 TaskOutcome artifact。
3. 写指定的 WorkResult envelope。

Worker 不调用 ingest，也不编辑 store、Question、Journey、Map、state、trace 或 HTML。

### 6.3 TaskOutcome 与 WorkResult v3

TaskOutcome 表达 contracted question 和 Hypothesis 的真实完成情况；WorkResult 表达文件交付、hash、readSet、scope violation、producer 与 telemetry。

`WorkResult.status=completed` 只表示 worker 成功写出结果文件，不能代替 `TaskOutcome.status=satisfied`。`validateTaskOutcome` 会检查：

- contract、run、snapshot、item 和 attempt identity
- 每个 blocking question 是否真正满足 completion criteria
- 每个 contracted Hypothesis 是否被 supported/refuted，或按规则明确 inconclusive
- support/counter Evidence 是否存在且受治理
- readSet 是否在 scope 内
- artifact hash 是否匹配
- runtime/product/semantic 问题是否正确分类
- partial completion 是否被错误声称为完成

### 6.4 Join 与串行 ingest

并行只存在于 worker 执行阶段。所有结果回到 orchestrator 后，按 WorkResult 路径逐个 ingest。package write lock、state transition 和 run event 顺序均由 kernel 控制。

成功的 semantic TaskOutcome 会把 Hypothesis 转为 `repo-claim/v2`：supported → accepted，refuted → refuted。证据引用必须存在于 `store/evidence.jsonl`。失败、blocked 或不满足 contract 的结果进入 rejected/blocked 状态，不能污染 Claim store。

## 7. Semantic store

`initializeSemanticStore` 从当前 snapshot 的源文件和 manifest 建立 Evidence：

- 普通可分析文件 → `source-range`
- protected file → `file-metadata`

`store/semantic-store-manifest.json` 记录 Evidence / Claim 数量和 canonical hash。`loadSemanticStore` 会重新计算 hash，并检查每个 Claim 的 Evidence 引用。

静态程序结构保留在 Static Program Graph；只有通过 ResearchContract 的语义 Hypothesis 才进入 Claim store。二者不会混成一个模糊事实池。

## 8. Authoritative Journey store

Journey 使用三个互相校验的实体：

- `repo-journey-definition/v1`：actor、goal、trigger、entry、有序 steps、branches、visible feedback、success/failure outcomes。
- `repo-journey-binding/v1`：Journey step 到 page、UI element、event、handler、effect、state transition、request、endpoint、response、feedback、outcome 的绑定。
- `repo-journey-closure-report/v1`：entry、action、handler、state、request、response、feedback、outcome、branch-failure 九个维度的 closure。

Static Program Graph 可以生成 Journey candidate 和代码 bindings，但 candidate 会明确写入 `unknown-actor`、unresolved product goal/outcome，不伪造产品语义。此时 `product-intent` Question 为 blocked，Journey 不能关闭。

Journey store 使用 package-scoped exclusive lock 和 atomic replace。`manifest.json` 绑定 definition/binding/closure 的路径、hash、status、criticality 和 `journeySetHash`。

完成门禁要求：

- 至少存在一个 governed Journey。
- 所有 critical Journey closed。
- 当前默认 Journey closure rate 为 100%。
- 每个 closed Journey 的 required dimensions 均 closed，且 integrity 校验通过。

## 9. 四张 Product Map

`buildProductMaps` 同时读取 Static Program Graph、InvestigationFrame、accepted semantic Claims 和 authoritative Journey store，确定性生成：

| Map | 内容 |
|---|---|
| Application Map | support level、前端范围、应用边界、bootstrap/root、route-layout-page、实体关系、state/API/auth/build/test surfaces |
| Experience Map | governed Journey、semantic claims、blocked dimensions |
| Runtime Flow Map | Journey binding 的有序 runtime steps、transitions、branch 和未绑定 Journey |
| Change Map | 反向依赖闭包、受影响 route/page/Journey、state/API/auth/test/build surfaces |

`projections/manifest.json` 的 `projectionKey` 绑定：

- snapshot id
- Static Program Graph hash
- accepted Claim set hash
- authoritative Journey set hash
- InvestigationFrame identity
- generator identity

Map 文件有语义 content hash。`createdAt`、`updatedAt`、`generatedAt`、`evaluatedAt`、`writtenAt` 保留用于审计，但不参与 projectionKey 或 Map content hash；同一 snapshot 在独立运行中必须得到相同 key/hash。validator 会在内存中重新构建预期结果，检查 projectionKey、文件存在性和 content hash；旧 Map 不能冒充当前 Map。

## 10. Narrative 与 HTML

四张 Product Map 和 Journey closure 通过 verification 后，`synthesize` 创建一个 `kind=synthesize` 的 WorkItem。它只能读取：

- `projections/manifest.json` 与四张 Map
- governed Journey files
- 当前 OpenQuestion set
- synthesis ResearchContract

`repo-synthesis-narrative/v3` 必须引用当前 projectionKey 和准确 map paths，且只能引用存在的 Journey、Claim、Evidence 和 Question。所有 unresolved question 必须进入 limitations。

`human-readable.html` 由 deterministic renderer 生成。它按 Journey、Map 和 narrative 呈现应用总览、体验流程、运行链、改动影响、证据与限制，不从 route table 自由写故事。

## 11. 状态机

`status` 返回 `repo-harness-status/v3`，`nextAction` 是唯一编排依据：

```text
unsupported
or
dispatch -> await-results -> ingest -> project -> synthesize -> project -> done
                                  \-> blocked
```

实际链路可能跳过没有任务的阶段。例如不存在 qualified semantic ambiguity 时，analyze 后直接进入 `project`。任何在途 WorkItem 都会阻止后续门禁；任何未替代的 blocking failure、critical question 或 Journey closure 缺口都会进入 `blocked`。

完整 run event 追加到 `store/run-events.jsonl`，衍生状态写入 `state/run-state.json`。新 snapshot 开始前会归档旧 run 的 events、state、trace 和 work artifacts。

## 12. 验证门禁

`verifyFrontendPackage` 支持 analysis、projection、synthesis、complete 四个 phase，检查：

1. SupportDecision、Static Program Graph、InvestigationFrame 与 snapshot 一致。
2. semantic store hash 和 Evidence refs 正确。
3. 无在途 WorkItem，无未替代 blocking failure。
4. ResearchContract 已处理，critical Question 已解决、waived 或 invalidated。
5. authoritative Journey closure 满足要求。
6. Product Maps 对当前 graph/claims/journeys/frame 是 current。
7. narrative 对当前 projectionKey 和 refs 是 current。
8. HTML 存在且不早于 narrative 和 Product Map manifest。

结果写入 `verification/frontend-verification.json`。验证失败时 CLI 以非零退出，不得把“schema 能解析”当成交付完成。

## 13. 旧执行路径删除

frontend-first v3 明确删除以下旧路径：

- gap/coverage 驱动的“扫不够就继续派任务”循环。
- FactGraph 作为唯一语义真相的架构。
- 按通用 explorer 类型做 fan-out 的派发模型。
- raw analysis、`facts[]` 或无 contract 的直接 ingest。
- parser/import failure 转 OpenQuestion 的行为。
- generic backend fallback。
- architecture/domain/flow、render graph、knowledge index、wiki 的旧投影链。

`analyze` 会删除旧包中的兼容文件和目录，防止 v2/v3 混合消费。当前消费者应只读取本设计列出的 v3 artifacts。

## 14. 非目标

- 不在 kernel 内启动或选择模型。
- 不在 CLI 内实现进程级 agent 并发；并发由 host runtime 负责。
- 不用模型修复 compiler/parser。
- 不根据代码标签发明 actor、goal、feedback 或 outcome。
- 不把 backend 结构套进 frontend Product Maps。
- 不承诺跨仓架构理解；该边界属于 workspace datasource 产品线。
