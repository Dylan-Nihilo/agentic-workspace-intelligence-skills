# Repo Understanding Frontend-first v3 Skill 计划

本文记录当前 skill/runtime 边界、已落地阶段和后续维护验收。它不是旧版迁移日志。

## 1. 目标

把一个受支持的前端仓库或全栈仓库的前端子树，转换为：

1. deterministic Static Program Graph；
2. governed semantic Evidence / Claim；
3. authoritative JourneyDefinition / JourneyBinding；
4. Application、Experience、Runtime Flow、Change 四张 Product Map；
5. grounded narrative 与 `human-readable.html`。

实现必须 runtime-neutral：host runtime 执行 agent，kernel 只负责确定性 contract、state、ingest、store、projection 和 verification。

## 2. 当前协议版本

| Contract | Version |
|---|---|
| SupportDecision | `repo-support-decision/v1` |
| Static Program Graph | `repo-static-program-graph/v1` |
| InvestigationFrame | `repo-investigation-frame/v1` |
| OpenQuestion | `repo-open-question/v1` |
| ResearchContract | `repo-research-contract/v1` |
| Hypothesis | `repo-hypothesis/v1` |
| TaskOutcome | `repo-task-outcome/v1` |
| WorkItem | `repo-work-item/v3` |
| WorkResult | `repo-work-result/v3` |
| Semantic store manifest | `repo-semantic-store-manifest/v1` |
| JourneyDefinition | `repo-journey-definition/v1` |
| JourneyBinding | `repo-journey-binding/v1` |
| Journey closure report | `repo-journey-closure-report/v1` |
| Product Map manifest | `repo-product-map-manifest/v1` |
| Synthesis narrative | `repo-synthesis-narrative/v3` |
| Run state / event | `repo-run-state/v3` / `repo-run-event/v3` |
| Frontend verification | `repo-frontend-verification/v1` |

## 3. 责任分层

```text
host runtime
  └─ 执行 WorkItem；可并行执行互不依赖的任务

repo-understanding skill
  └─ 读取 status.nextAction；路由 worker；等待 Join；串行调用 CLI

worker skills
  └─ 读取一个 ResearchContract；只写 TaskOutcome + WorkResult

deterministic CLI / kernel
  └─ support、compiler graph、contract、state、ingest、store、Journey、Map、verify、HTML
```

权威写入边界：

- Worker 不改 Claim、Question、Journey、Map、run state、event log 或 trace。
- Orchestrator 不把 worker 自述直接当事实，只调用 ingest。
- Semantic store 和 Journey store 各自持 package-scoped writer lock。
- Projection 可删除重建；Evidence、accepted/refuted Claim 和 Journey authority 只能走治理入口。

## 4. Skill 路由

| Skill | 触发条件 | Work kind | 禁止事项 |
|---|---|---|---|
| `repo-understanding` | 单前端仓库理解、Journey、四张 Map、HTML | orchestrator | 不代替 worker 做研究，不直接写 store |
| `repo-explorer` | 已派 `semantic-research` contract | `semantic-research` | 不扩 scope，不输出 raw facts 数组 |
| `repo-fact-verifier` | contracted Hypothesis 冲突或高风险 Journey binding 裁决 | `adjudicate` | 不替代 deterministic verifier，不发现无关事实 |
| `repo-synthesizer` | 四张 Map current 且 Journey closure 通过 | `synthesize` | 不重扫仓库，不改 Map/Journey |
| `repo-human-readable` | narrative 已验收，需要最终页面 | deterministic projection | 不生产事实 |

多仓理解由 `agentic-datasource-orchestrator` 路由，不属于本计划。

## 5. 实现阶段与当前状态

### P0 — 支持范围和 deterministic compiler

- [x] `SupportDecision` 对 backend/unknown fail closed。
- [x] fullstack 仅在 frontend roots 可确定时进入 `frontend-subtree-only`。
- [x] census 记录 protected metadata，不读取受保护内容。
- [x] TypeScript、Babel、Vue compiler 驱动 Static Program Graph。
- [x] parser、import、protected 和 unsupported syntax 写 deterministic diagnostics。
- [x] graph 节点/边带 source range、provider、structure fingerprint 和 evidence refs。
- [x] 生成稳定 community map 与 neighbor map。

验收：backend 不产生 ResearchContract；fullstack graph 不越过 frontend roots；相同输入重建 graph/community/neighbor 结果稳定。

### P1 — InvestigationFrame 与 ResearchContract

- [x] InvestigationFrame 覆盖九个 frontend map dimensions。
- [x] OpenQuestion 限定为 `semantic-ambiguity`、`runtime-external-blocked`、`product-intent`。
- [x] 只有至少两个 competing Hypotheses 的 semantic ambiguity 可规划 agent。
- [x] ResearchContract 固定 target maps/journeys、allowed files、community、acceptance、completion、stop 和 blocked policies。
- [x] runtime/product-intent 问题保持 blocked，不派 repo explorer。

验收：parser/import 问题不能出现在 dispatch manifest；没有合格歧义时 contractRefs 可以为空，流程直接进入 projection 阶段。

### P2 — WorkItem / TaskOutcome / serial ingest

- [x] dispatch 只生成 `repo-work-item/v3`。
- [x] worker 输出严格分为 TaskOutcome 与 WorkResult envelope。
- [x] artifact hash、readSet、scope、snapshot、attempt、contract identity 全部校验。
- [x] `completed` transport state 与 `satisfied` research outcome 分离。
- [x] blocking criteria 未满足时拒绝 partial completion。
- [x] Host 可并行执行独立 WorkItem；Join 后仅 orchestrator 串行 ingest。
- [x] rejected item 保留 retryOf 和 attempt，最大三次。
- [x] telemetry 只接受 reported 或 unavailable，不估算。

验收：越界 readSet、scope violation、hash mismatch、Hypothesis drift、partial satisfied 和 replay ingest 都必须失败且不写 Claim。

### P3 — Semantic Evidence / Claim store

- [x] 当前 snapshot 的源文件和 manifest 初始化为 governed Evidence。
- [x] protected file 只生成 metadata Evidence。
- [x] supported Hypothesis 转 accepted Claim，refuted Hypothesis 转 refuted Claim。
- [x] Claim Evidence refs、snapshot 和 canonical hash 可重算。
- [x] store 使用 exclusive writer lock 和 atomic write。

验收：未知 Evidence id、snapshot mismatch、manifest hash mismatch 或并发 writer 全部拒绝。

### P4 — Authoritative Journey closure

- [x] JourneyDefinition 表达 actor、goal、trigger、ordered steps、branches、feedback、success/failure outcomes。
- [x] JourneyBinding 绑定 page、UI、event、handler、state、request、endpoint、response、feedback、outcome。
- [x] deterministic candidate 不发明 actor、goal 或 product outcome。
- [x] closure 按 entry/action/handler/state/request/response/feedback/outcome/branch-failure 九维计算。
- [x] critical Journey 有缺口时禁止 closed。
- [x] Journey store manifest 绑定每个 definition/binding/closure hash 和 journeySetHash。
- [x] writer lock、atomic replace、rebuild 和 stale file cleanup 已实现。

验收：把 candidate status 手改为 closed 不能通过；缺 response、feedback、outcome 或 failure branch 的 critical Journey 不能关闭。

### P5 — 四张 Product Map

- [x] Application Map 组合 graph、frame 和 application-targeted semantic Claims。
- [x] Experience Map 只消费 governed Journeys 和相关 Claims。
- [x] Runtime Flow Map 保持 JourneyBinding 稳定顺序、transition 和 branch。
- [x] Change Map 计算 reverse dependency closure 和受影响 page/route/Journey/engineering surfaces。
- [x] 四张 Map 共用 snapshot 和 projectionKey。
- [x] manifest 记录每张 Map 的 path、schemaVersion 和 contentHash。
- [x] validator 可在内存中重建并检测 stale graph/Claim/Journey/frame。

验收：任一 authoritative input 改变后，旧 Map 必须被判 stale；Map 不能引用不存在的 entity、Journey、Claim 或 Evidence。

### P6 — Narrative、HTML 与完成门禁

- [x] synthesis WorkItem 只读四张 Product Map、Journey、OpenQuestion 和 synthesis contract。
- [x] narrative v3 绑定当前 projectionKey 和准确 map refs。
- [x] unresolved governed Question 必须进入 limitations。
- [x] HTML 由 deterministic renderer 生成，不新建事实。
- [x] verification 分 analysis / projection / synthesis / complete 四阶段。
- [x] complete gate 检查 semantic store、in-flight work、blocking failures、contracts、critical questions、Journey closure、Map freshness、narrative grounding 和 HTML freshness。
- [x] `status.nextAction` 统一为 `dispatch|await-results|ingest|project|synthesize|blocked|done|unsupported`。

验收：缺 Map、Journey 未闭合、narrative 过期或 HTML 早于输入时均不能 done。

## 6. 标准运行循环

```text
analyze
  -> status
  -> dispatch?       host 执行当前 WorkItems
  -> await-results?  等待本批完成
  -> ingest?         orchestrator 串行写回
  -> project?        重建四张 Product Map
  -> blocked?        获取 runtime / product input 或处理 blocking failure
  -> synthesize?     host 执行 narrative WorkItem，再 ingest
  -> project?        生成 current HTML
  -> done
```

每次循环只看 `status.nextAction`。不得自定义“扫描轮数够了”“文件覆盖够了”或“token 花完了”作为完成条件。

## 7. Artifact contract

必须存在的分析期 artifacts：

```text
static/inventory.json
static/code-map.json
static/repo-profile.json
static/support-decision.json
static/static-program-graph.json
static/community-map.json
static/neighbor-map.json
static/investigation-frame.json
planning/manifest.json
planning/open-questions.json
store/evidence.jsonl
store/claims.jsonl
store/semantic-store-manifest.json
store/journeys/manifest.json
state/run-state.json
store/run-events.jsonl
verification/frontend-verification.json
```

交付期增加：

```text
projections/application-map.json
projections/experience-map.json
projections/runtime-flow-map.json
projections/change-map.json
projections/manifest.json
synthesis/narrative.json
human-readable.html
```

每个消费 artifact 必须通过 manifest/hash 或 explicit refs 绑定上游，不允许通过“文件刚好在目录里”推断 current。

## 8. 验证矩阵

| 风险 | 最小测试 |
|---|---|
| backend 被误当 frontend | backend fixture → `unsupported`、零 contract |
| fullstack 越界 | graph source paths 全在 frontend roots |
| parser failure 触发 agent | diagnostics 有记录、dispatch 无对应 contract |
| WorkResult 伪造完成 | completed + partial TaskOutcome → reject |
| worker 扩 scope | readSet 越界 → reject |
| 并发污染 store | writer lock held → reject |
| 产品语义被猜测 | candidate actor/goal/outcome 保持 unresolved |
| Journey 假关闭 | 缺任一 required dimension → closure fail |
| Map 过期 | Claim/Journey/graph 变更后 verify fail |
| narrative 发明事实 | 未知 Claim/Evidence/Journey/Question ref → reject |
| HTML 过期 | HTML mtime 早于 narrative/manifest → verify fail |

执行入口：

```bash
npm run eval:contract
npm run eval:all
node --test packages/repo-understanding-kernel/test/*.test.mjs
```

任何新 schema、edge kind、Journey dimension、Map 字段或 status transition 都必须增加 fixture 和负向门禁测试。

## 9. 已删除的旧协议

以下内容不得重新引入：

- gap/coverage 驱动的 planner 和完成判定。
- FactGraph 作为唯一事实源。
- 按通用 explorer 角色做 fan-out 的 task queue。
- raw analysis、`facts[]`、无 ResearchContract 的直接 ingest。
- parser/import/protected-file 问题转 agent task。
- generic backend fallback。
- architecture/domain/flow/render-graph/knowledge-index/wiki 的旧公开投影链。
- Worker 直接修改 package state 或执行 ingest。
- 固定模型名、runtime 工具名或虚构 usage。

迁移旧 package 时重新运行 `analyze`。v3 不保证读取或升级旧包；`analyze` 会清理已知兼容产物，避免混包。

## 10. 后续维护项

这些属于受控扩展，不改变当前核心协议：

- 新 framework compiler adapter：必须先落 deterministic parser 和 diagnostics，再扩 SupportDecision。
- runtime evidence connector：只能解决 `runtime-external-blocked`，不能覆盖 source evidence。
- product input adapter：必须通过 Journey store writer 落 actor/goal/feedback/outcome 和 provenance，不能提供跳过 closure 的开关。
- 新 Product Map consumer：只能读取 v3 Maps/Journeys/refs，不能创建第二套事实 store。
- 分发为独立 npm 包：只改变安装入口，不复制 kernel 逻辑到 skill 目录。

## 11. 完成定义

当前 snapshot 只有同时满足以下条件才算完成：

- SupportDecision 为 supported frontend scope。
- 无在途 WorkItem 和未替代 blocking failure。
- 所有 critical semantic Questions 已 resolved、waived 或 invalidated。
- 至少一个 governed Journey 存在，critical Journeys 全 closed，closure rate 达到策略要求。
- 四张 Product Map 对当前 graph/Claims/Journeys/frame 是 current。
- narrative 引用当前 projectionKey，所有 refs 可解析，limitations 完整。
- `human-readable.html` 对当前 narrative 和 Map manifest 是 current。
- `verification/frontend-verification.json` 为 passed。
- `status.nextAction=done`。

任何单一数量指标都不能替代这组条件。
