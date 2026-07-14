# Repo Understanding Frontend-first v3 教程

这份教程从一个前端仓库开始，逐步解释每条命令、每个权威 artifact 和每道门禁。示例使用：

```text
repo:    /path/to/frontend-repo
package: /tmp/frontend-understanding
```

所有命令都从本仓库根目录执行。Node.js 要求 `>=20`。

## 0. 安装与自检

```bash
npm install
npm run eval:contract
node --test packages/repo-understanding-kernel/test/*.test.mjs
```

CLI 帮助：

```bash
npm run understanding:harness -- --help
```

v3 的 CLI 不启动 agent。它只生成 contract、WorkItem、prompt、schema、store、Map 和 verification；谁执行 WorkItem，由当前 host runtime 决定。

## 1. 先做 support gate

```bash
npm run understanding:harness -- scout \
  --repo /path/to/frontend-repo \
  --out /tmp/frontend-understanding
```

`scout` 名字保留为 CLI 入口，但该命令本身执行的是 deterministic census、SupportDecision、Static Program Graph、community、neighbor map、InvestigationFrame 和 Journey candidate 建立。它不会派 worker，stdout 中 `workItem` 固定为 `null`。

先看支持结论：

```bash
node -e "const x=require('/tmp/frontend-understanding/static/support-decision.json'); console.log(x.supportLevel, x.repoKind, x.frontendRoots)"
```

三种结果：

- `supported-frontend`：继续整个前端范围。
- `frontend-subtree-only`：只继续 `frontendRoots`，backend roots 是边界。
- `unsupported`：停止。backend 与 unknown 都不会进入 agent 流程。

检查这些文件：

```text
static/inventory.json
static/code-map.json
static/repo-profile.json
static/support-decision.json
static/static-program-graph.json
static/community-map.json
static/neighbor-map.json
static/investigation-frame.json
```

`inventory.json` 记录 file hash、language、category、protected status；`support-decision.json` 决定范围。二者不能由模型覆盖。

## 2. 建立正式分析包

```bash
npm run understanding:harness -- analyze \
  --repo /path/to/frontend-repo \
  --out /tmp/frontend-understanding \
  --mode fast
```

`fast` 与 `deep` 只调整每轮任务上限、context budget 和最大轮次，不降低 contract 或 Journey 门禁。

`analyze` 完成以下确定性工作：

1. 重新建立 census 和当前 snapshot。
2. 编译 Static Program Graph。
3. 建立 community / neighbor map 和 InvestigationFrame。
4. 初始化 semantic Evidence/Claim store。
5. 把真正的 semantic ambiguity 编译为 ResearchContract。
6. 把 runtime-only 和 product-intent 问题标为 blocked。
7. 建立 Journey candidates 与 closure reports。
8. 写 run state、events 和 analysis-phase verification。

同时清理旧包中的旧投影与过渡文件，避免不同协议混在同一目录里。

## 3. 读 Static Program Graph

快速查看图规模和 compiler 状态：

```bash
node --input-type=module -e '
  import fs from "node:fs";
  const g=JSON.parse(fs.readFileSync("/tmp/frontend-understanding/static/static-program-graph.json","utf8"));
  console.log({
    graphId:g.graphId,
    snapshotId:g.snapshotId,
    parser:g.parser.mode,
    providers:g.parser.providers,
    nodes:g.nodes.length,
    edges:g.edges.length,
    diagnostics:g.diagnostics.length
  });
'
```

图不是 route 列表。它包含编译可观察的：

- bootstrap、route、layout、page 和 component composition
- UI element、event、handler
- state、request、endpoint、response
- feedback/outcome candidates
- auth guard、build wiring、test wiring
- import/export 和上述实体间关系

每个节点和边都有 source range、parser/provider、evidence refs 和 structure fingerprint。

查看 diagnostics：

```bash
node --input-type=module -e '
  import fs from "node:fs";
  const g=JSON.parse(fs.readFileSync("/tmp/frontend-understanding/static/static-program-graph.json","utf8"));
  console.table(g.diagnostics.map(x=>({kind:x.kind,severity:x.severity,path:x.sourcePath,line:x.line})));
'
```

这些诊断包括 parser、import resolution、protected access 和 unsupported syntax。它们不会生成 ResearchContract。出现大量诊断时，应该修 parser/adapter 或收窄支持声明，不能让 agent 猜缺失结构。

## 4. 读 InvestigationFrame

```bash
node --input-type=module -e '
  import fs from "node:fs";
  const f=JSON.parse(fs.readFileSync("/tmp/frontend-understanding/static/investigation-frame.json","utf8"));
  console.log({
    frameId:f.frameId,
    applicationKind:f.applicationKind,
    framework:f.framework.name,
    bundler:f.bundler.name,
    bootstrap:f.browserBootstrap.entryPath,
    routes:f.routeRoots.length,
    pages:f.pageCandidates.length,
    semanticAmbiguities:f.unresolvedSemanticAmbiguities.length,
    diagnostics:f.deterministicDiagnostics.length
  });
'
```

InvestigationFrame 是后续语义研究的边界说明，不是 agent 的自由探索提纲。它必须覆盖九个 map dimensions：bootstrap、route/layout/page、component、state/data flow、API、auth、build/deploy、test/quality、core journeys。

## 5. 看问题有没有资格派 worker

```bash
node --input-type=module -e '
  import fs from "node:fs";
  const p=JSON.parse(fs.readFileSync("/tmp/frontend-understanding/planning/manifest.json","utf8"));
  const q=JSON.parse(fs.readFileSync("/tmp/frontend-understanding/planning/open-questions.json","utf8"));
  console.log(p.questionCounts);
  console.table(q.questions.map(x=>({id:x.questionId,category:x.category,status:x.lifecycleStatus,blocking:x.blocking})));
'
```

判定规则：

- `semantic-ambiguity`：至少两个可证伪的 competing Hypotheses，允许生成 ResearchContract。
- `runtime-external-blocked`：源码无法证明，需要真实 runtime evidence，不派 repo explorer。
- `product-intent`：需要用户或产品资料，不派 repo explorer。
- parser/import/protected-file 问题：只留在 deterministic diagnostics。

ResearchContract 位于 `planning/contracts/*.json`。重点核对：

```text
questions
hypotheses
targetMaps / targetJourneys
scope.allowedFiles
scope.communityIds
scope.neighborDepth
acceptanceCriteria
completionRules
stopRules
blockedPolicies
budgetHints
```

如果没有 qualified semantic ambiguity，`planning/manifest.json` 的 `contractRefs` 可以为空。这不是漏扫；说明当前 snapshot 没有需要 agent 裁决的语义冲突。

## 6. 用 status 驱动流程

```bash
npm run understanding:harness -- status \
  --package /tmp/frontend-understanding
```

只依据 `nextAction` 行动：

| 值 | 意义 |
|---|---|
| `dispatch` | 有尚未派发的 ResearchContract |
| `await-results` | WorkItem 已发出，等待结果文件 |
| `ingest` | 结果文件已出现，等待 orchestrator 验收 |
| `project` | 权威输入已更新，需要生成或刷新 Map/HTML |
| `synthesize` | 四张 Map current，可以创建 narrative WorkItem |
| `blocked` | 有 blocking failure、关键问题或 Journey closure 缺口 |
| `done` | 当前 snapshot 的全部门禁已闭合 |
| `unsupported` | support gate 已终止 |

不要靠文件数、固定轮次或 token 消耗判断“够不够”。

## 7. 派发 semantic WorkItem

当 `nextAction=dispatch`：

```bash
npm run understanding:harness -- dispatch \
  --package /tmp/frontend-understanding \
  --max-tasks 16
```

stdout 和 `research/dispatch/<batch>/manifest.json` 会列出每个 WorkItem 的：

- item / contract identity
- prompt path
- output TaskOutcome path
- WorkResult path
- output schema path
- community 和 blocking map/journey 信息
- telemetry 命令
- ingest 命令

Host runtime 可以同时执行互不依赖的 WorkItem，但每个 worker 只能读取 WorkItem 的 `inputArtifactRefs` 和 contract scope。

Worker 的正确交付顺序：

1. 打开 prompt 和 ResearchContract。
2. 只在 `scope.allowedFiles` 与 deterministic context 内核对证据。
3. 对每个 contracted Hypothesis 记录 support 和 counter evidence。
4. 写 `.task-outcome.json`。
5. 计算文件 SHA-256。
6. 写准确路径下的 `.result.json` WorkResult envelope。
7. 返回控制权，不调用 ingest。

`WorkResult.status=completed` 只表示文件写好了。只有 TaskOutcome 对每个 blocking question 满足 acceptance criteria，contract 才能关闭。

## 8. Join 后串行 ingest

先等本批所有 worker 到达 transport terminal state。再逐个执行 manifest 给出的 ingest command，例如：

```bash
npm run understanding:harness -- ingest \
  --package /tmp/frontend-understanding \
  --work-result /tmp/frontend-understanding/work/results/<item>.result.json
```

ingest 会检查：

- WorkItem / WorkResult / ResearchContract / snapshot / attempt identity
- output path、schema 和 SHA-256
- readSet 是否在允许范围内
- `scopeViolations` 是否为空
- TaskOutcome 与 transport status 是否一致
- 每条 Hypothesis 是否与 contract 定义一致
- 每项 Evidence 是否存在于 governed store

通过后，supported Hypothesis 写成 accepted Claim，refuted Hypothesis 写成 refuted Claim。查看：

```bash
wc -l /tmp/frontend-understanding/store/evidence.jsonl
wc -l /tmp/frontend-understanding/store/claims.jsonl
node -e "console.log(require('/tmp/frontend-understanding/store/semantic-store-manifest.json'))"
```

不满足 contract 的结果返回 `merged:false` 并进入 rejected/blocked。需要重试时：

```bash
npm run understanding:harness -- retry \
  --package /tmp/frontend-understanding \
  --item <work-item-id>
```

重试保留 `retryOf`、idempotency identity 和 attempt；最多三次。不能通过改 store 绕过 rejection。

## 9. 理解 Journey closure

`analyze` 会从 route/page/runtime structure 生成 deterministic Journey candidate：

```text
store/journeys/definitions/*.json
store/journeys/bindings/*.json
store/journeys/closure/*.json
store/journeys/manifest.json
```

candidate 只记录编译可观察的 entry、step 和 binding。它会明确保留：

```text
actor: unknown-actor
goal: Unresolved product goal ...
successOutcome: Unresolved product outcome ...
```

这会产生 `product-intent` blocked Question。系统不会把 route 名、组件名或按钮文案猜成产品目标。

Journey 要关闭，至少要有 entry、action、handler、state、request、response、feedback、outcome 和 branch-failure 九个维度的受治理信息。critical Journey 少一个 required dimension 都不能 closed。

CLI 没有 `--assume-product-intent` 之类的绕过命令。用户或产品资料进入后，把确认过的 `JourneyDefinition[]` 与 `JourneyBinding[]` 写到隔离输入文件，再走受控导入；不得直接手改 definitions、bindings 或 manifest：

```bash
npm run understanding:harness -- journeys \
  --package /tmp/frontend-understanding \
  --definitions /path/to/definitions.json \
  --bindings /path/to/bindings.json
```

该命令内部调用 kernel 的原子 Journey Store writer，校验 snapshot、binding、closure 与 hash，并只对真正 closed 的 Journey 解析 product-intent question。对应契约测试在：

```text
packages/repo-understanding-kernel/test/journey-store.test.mjs
```

查看 closure：

```bash
node --input-type=module -e '
  import fs from "node:fs";
  const m=JSON.parse(fs.readFileSync("/tmp/frontend-understanding/store/journeys/manifest.json","utf8"));
  console.log(m.counts);
  console.table(m.entries.map(x=>({journey:x.journeyId,status:x.status,criticality:x.criticality,closure:x.closureReportPath})));
'
```

## 10. 生成四张 Product Map

当 `nextAction=project`：

```bash
npm run understanding:harness -- project \
  --package /tmp/frontend-understanding \
  --only maps
```

生成：

```text
projections/application-map.json
projections/experience-map.json
projections/runtime-flow-map.json
projections/change-map.json
projections/manifest.json
```

各 Map 的消费问题：

- Application Map：应用由哪些入口、route、page、component 和 boundary 组成。
- Experience Map：有哪些 governed Journey，哪些产品维度仍 blocked。
- Runtime Flow Map：每条 Journey 如何按顺序绑定到代码实体和分支。
- Change Map：改动某实体会沿反向依赖影响哪些 page、route、Journey 和工程 surface。

检查 projection identity：

```bash
node -e "console.log(require('/tmp/frontend-understanding/projections/manifest.json').projectionKey)"
```

accepted Claim、Journey、Static Program Graph 或 InvestigationFrame 变化后，旧 projectionKey 会失效；`verify` 会要求重新 project。

## 11. 生成 narrative

只有四张 Product Map current、Journey closure 满足门禁且 verification passed，`status` 才返回 `synthesize`：

```bash
npm run understanding:harness -- synthesize \
  --package /tmp/frontend-understanding
```

该命令只创建 synthesis ResearchContract 和 WorkItem。worker 只能读取四张 Map、Journey、OpenQuestion 和 contract，不能重新扫仓库。它写：

```text
synthesis/narrative.json
work/results/<synthesis-item>.result.json
```

随后仍由 orchestrator 串行 ingest。validator 会确认 narrative：

- 使用当前 projectionKey。
- map refs 与 manifest 完全一致。
- Journey / Claim / Evidence / Question refs 都存在。
- unresolved governed Question 全部进入 limitations。
- 没有发明新的 map relation、feedback 或 outcome。

## 12. 生成报告与 HTML

结构化报告：

```bash
npm run understanding:harness -- report \
  --package /tmp/frontend-understanding
```

输出 `report.md`，包含支持结论、图规模、ResearchContract、Journey closure、Map 规模、OpenQuestion 和 narrative 状态。

最终页面：

```bash
npm run understanding:harness -- html \
  --package /tmp/frontend-understanding
```

输出 `human-readable.html`。HTML 只消费当前四张 Map、Journey 和 narrative；它不会另起一轮事实发现。

也可以在已有 narrative 时：

```bash
npm run understanding:harness -- project \
  --package /tmp/frontend-understanding \
  --only all
```

## 13. 最终验证

```bash
npm run understanding:harness -- verify \
  --package /tmp/frontend-understanding
```

结果写入：

```text
verification/frontend-verification.json
```

检查重点：

```bash
node --input-type=module -e '
  import fs from "node:fs";
  const v=JSON.parse(fs.readFileSync("/tmp/frontend-understanding/verification/frontend-verification.json","utf8"));
  console.log({passed:v.passed,phase:v.phase,issues:v.issues});
  console.log(v.gates);
'
```

`passed=false` 时 CLI exit code 非零。不要只看 JSON 是否存在；重点是 `issues[]` 和各 gate 的 `current` 状态。

## 14. 调试真实 worker 成本

Host 在 worker 开始、结束或失败时记录 telemetry：

```bash
npm run understanding:harness -- trace \
  --package /tmp/frontend-understanding \
  --item <work-item-id> \
  --event started \
  --runtime <runtime-name> \
  --model <model-name>
```

结束时只有拿到真实数据才填写 token、cost 和 duration。没有数据就保留 `usage.status=unavailable`。

```bash
npm run understanding:harness -- debug \
  --package /tmp/frontend-understanding
```

`debug` 会汇总 issued/started/completed/failed、真实 usage 和 accepted agent Claim 效率，不做成本估算。

## 15. Incremental 模式

```bash
npm run understanding:harness -- analyze \
  --repo /path/to/frontend-repo \
  --out /tmp/frontend-understanding \
  --incremental \
  --base HEAD~1
```

当前实现把 git changed files、受影响 entity ids 和 structure fingerprint 写入 `static/invalidation.json`，随后确定性重建 Static Program Graph。它不会复用旧 Claim 或旧 Map 来假装完成增量分析。

## 16. 本地只读服务

```bash
npm run understanding:harness -- serve \
  --package /tmp/frontend-understanding \
  --port 8787
```

可读 endpoints：

```text
/health
/status
/static-program-graph
/application-map
/experience-map
/runtime-flow-map
/change-map
/journeys
/narrative
```

## 17. 常见阻塞怎么处理

### `unsupported`

先读 `static/support-decision.json`。backend/unknown 是预期 fail closed；fullstack 应确认 frontend roots 能否由 manifest/workspace 证据确定。

### `journey-closure-incomplete`

读 `store/journeys/manifest.json` 和对应 closure report。若缺 actor/goal/outcome，需要产品输入；若缺 binding，核对 Static Program Graph 或建立受治理的 semantic adjudication。不能直接把 status 改成 closed。

### `product-map-key-stale`

权威输入更新后重跑 `project --only maps`。

### `work-in-flight`

还有 WorkItem 为 ready/issued/result-produced。先等待、ingest 或按 contract policy 处理失败，不能提前 synthesis。

### `semantic-store-invalid`

检查 manifest hash 和 Claim 的 Evidence refs。不要手改 JSONL；重新 analyze 或通过合法 ingest 恢复。

### parser/import diagnostics 很多

修 compiler adapter 或 importer。不要把这些问题包装成 semantic ambiguity。

## 18. v3 不再做什么

旧版 gap/coverage 循环、FactGraph 唯一真相、通用 explorer fan-out、raw `facts[]` ingest、parser/import 问题派 agent、generic backend fallback 和旧 architecture/domain/flow/wiki 投影链都已退出当前协议。

v3 的完成定义是：当前 snapshot 的 contract 已关闭、authoritative Journey 已闭合、四张 Product Map current、narrative grounded、HTML current、verification passed。文件多、图大或 worker 跑了很多轮都不能替代这些条件。
