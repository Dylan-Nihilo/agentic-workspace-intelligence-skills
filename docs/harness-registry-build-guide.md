# Harness 扩展轴注册表 · Codex 构建指南

> 背景:变更容忍度评审发现,系统对"加功能"是散弹手术(explorer 4 文件 5+ 处、谓词 6 文件)、对"删功能"是假支持,三个已证实缺陷:
> **D1** `harness.config.json` 的 `explorers.<name>.enabled` 是死配置——grep 全部 harness+shared 代码零处读取;
> **D2** `executableGapTasks`(harness.mjs)不知道 explorer 集合,删/禁 explorer 后其 open 任务永远算 executable → `nextAction` 永远 `dispatch`,靠 `maxExplorerRounds` 保险丝逃生;
> **D3** `project --only` 白名单硬编码 `['render-graph','knowledge-index','wiki','all']`,没有 html——流程已闭环到 html 但重投影命令不知道这个节点。
> 目标:**每条扩展轴一个单一注册点**,加=改一处,删=真降级。**不是图执行引擎**——status/dispatch 的执行逻辑仍是现有代码,注册表只是数据源 + 契约。

---

## 0. 护栏

- **G-R1 零行为回归(默认全启用时)**:注册表接线后,对 `evals/fixtures/mini-repo` 重跑 `analyze`,fact-graph 的节点/边/gap-queue 与改前**逐字段一致**(先跑一次改前版本存 `/tmp/before/`,改后 diff)。注册表是重构,不是行为变更。
- **G-R2 不是引擎**:禁止引入"读声明来驱动执行"的解释器。`status`/`dispatch`/`project` 的控制流保持命令式代码,只把**数据**(名字/正则/预算/标签/白名单)改为从注册表导入。
- **G-R3 锚符号不锚行号**;所有断言进 `evals/contract/`,复用现有 run-contract 基建。
- **G-R4 命名保真**:explorer `dynamic-import`(单数)与谓词 `dynamic-imports`(复数)是**两个不同轴上的名字,不是拼写不一致**——禁止"顺手统一"。
- **G-R5 禁用 ≠ 删数据**:禁用 explorer 时,gap 任务**保持 open、保留 explorer 归属**,只在 executable/dispatch 层排除。重新启用后任务自然恢复可执行。禁止把任务改写成 skipped 或重新路由。
- 不掺 G-5..G-8、不动 producedBy 枚举、不删现有 gate(既有护栏全部继续适用)。

---

## REG-1 · 建 `shared/understanding/harness-registry.mjs`(单一数据源)

新模块,只导出**数据 + 纯查询函数**,零副作用:

```js
export const EXPLORERS = {
  // kind: 'path-routed' 由文件路径正则分派 | 'system' 由任务类型/兜底分派
  'vue-containment':   { kind: 'path-routed', pathPattern: /\.vue$|components?|views?|pages?/i, tokenBudget: 12000, label: 'Vue 结构',   inFactEnum: true },
  'route-binding':     { kind: 'path-routed', pathPattern: /route|router|controller|mapping/i,  tokenBudget: 12000, label: '路由绑定',   inFactEnum: true },
  'auth-chain':        { kind: 'path-routed', pathPattern: /auth|security|permission|filter|interceptor|guard/i, tokenBudget: 14000, label: '权限链路', inFactEnum: true },
  'data-access':       { kind: 'path-routed', pathPattern: /dao|mapper|repository|entity|sql|datasource|redis|cache/i, tokenBudget: 16000, label: '数据访问', inFactEnum: true },
  'call-chain':        { kind: 'path-routed', pathPattern: /client|facade|rpc|http|mq|kafka|rocket|queue|consumer|producer/i, tokenBudget: 18000, label: '调用链路', inFactEnum: true },
  'dynamic-import':    { kind: 'system', tokenBudget: 10000, label: '动态导入', inFactEnum: true },   // unresolved-import(js-dynamic-import) 任务
  'adversarial-verify':{ kind: 'system', tokenBudget: 8000,  label: '反向验证', inFactEnum: false },  // low-confidence-fact 任务
  'coverage-directed': { kind: 'system', tokenBudget: 10000, label: '覆盖导向', inFactEnum: false },  // coverage-gate openQuestion + path 兜底
}

export const PREDICATES = {
  // zhLabel 供 translatePredicate;protocolAnchor 是 explorer-protocol.md 的章节锚(契约测试用)
  'imports':         { zhLabel: '导入',     protocolAnchor: 'imports' },
  'dynamic-imports': { zhLabel: '动态导入', protocolAnchor: 'dynamic-imports' },
  'contains':        { zhLabel: '包含',     protocolAnchor: 'contains' },
  'depends-on':      { zhLabel: '依赖',     protocolAnchor: 'depends-on' },
  'routes-to':       { zhLabel: '路由指向', protocolAnchor: 'routes-to' },
  'registers':       { zhLabel: '注册',     protocolAnchor: 'registers' },
  'calls':           { zhLabel: '调用',     protocolAnchor: 'calls' },
  'guarded-by':      { zhLabel: '受保护于', protocolAnchor: 'guarded-by' },
  'reads-from':      { zhLabel: '读取',     protocolAnchor: 'reads-from' },
  'writes-to':       { zhLabel: '写入',     protocolAnchor: 'writes-to' },
  'extends':         { zhLabel: '继承',     protocolAnchor: 'extends' },
  'implements':      { zhLabel: '实现',     protocolAnchor: 'implements' },
}

export const PROJECTIONS = {
  'render-graph':    { output: 'render-graph.json' },
  'knowledge-index': { output: 'knowledge-index.jsonl' },
  'wiki':            { output: 'wiki/' },
  'html':            { output: 'human-readable.html' },
}

// 纯查询:config 是 harness.config.json 的 explorers 段(运行时调参层)
export function explorerEnabled(name, config = {}) { /* registry 有该名 && config?.[name]?.enabled !== false */ }
export function explorerBudget(name, config = {}) { /* config 覆盖 > registry 默认 */ }
export function pickExplorerForPath(filePath) { /* 按 EXPLORERS 中 path-routed 项的声明顺序匹配,兜底 coverage-directed */ }
export function validPredicateSet() { return new Set(Object.keys(PREDICATES)) }
```

**分层规则(写进模块头注释)**:注册表定义**节点集合与派生数据**(结构层,改代码);`harness.config.json` 的 `explorers` 段仍是**运行时调参**(enabled/tokenBudget 覆盖,改配置)。config 中出现注册表没有的 explorer 名 → harness 启动时报错退出(抓 typo)。

**验收**:`node --check` 过;模块无 I/O、无对 harness 其它模块的 import(避免环)。

## REG-2 · explorer 轴接线 + 修 D1/D2

派生点全部改为 import 注册表(**删除各处的私有字面量**):

| 现有位置(符号锚) | 改为 |
|---|---|
| `fact-graph-harness.mjs :: explorerForPath` | 委托 `pickExplorerForPath` |
| `fact-graph-harness.mjs :: explorerTokenBudget` 内置 map | 委托 `explorerBudget` |
| `fact-graph-harness.mjs :: buildGapQueue` 里的 `'adversarial-verify'` / `'dynamic-import'` / `'route-binding'` / `'coverage-directed'` 字面量 | 保留调用语义,但名字引用注册表常量(防止改名漏改) |
| `repo-exploration-core.mjs:~200` 的 explorer 枚举字符串 | 由 `EXPLORERS` 中 `inFactEnum: true` 的键生成 |
| `human-readable-html.mjs :: translateExplorer` | 由 `EXPLORERS[name].label` 派生(未知名回显原文) |

**D1/D2 修复(行为变更,唯一允许的一处)**:
- `harness.mjs :: executableGapTasks` 增加过滤:`explorerEnabled(task.explorer, config)`。被禁用 explorer 的 open 任务不再计入 executable。
- `harness.mjs :: buildHarnessStatus` 的 `tasks` 增加 `openDisabled` 计数(open 但 explorer 被禁用的任务数),让"有任务但被禁"可见而不是消失。
- `createDispatchRound`/`buildExplorerDispatch` 跳过禁用 explorer 的任务(不标记、不改状态,见 G-R5)。
- 效果:全部剩余 open 任务都属于禁用 explorer 时 → `executableOpen=0` → `nextAction=synthesize`,循环干净退出,不再靠轮次保险丝。

**验收**:mini-repo 上 (a) 默认全启用 → 与改前输出零 diff(G-R1);(b) config 置 `route-binding.enabled=false` 后 dispatch 不产出该 bundle、`status.tasks.openDisabled>0`、当仅剩禁用任务时 `nextAction=synthesize`;(c) 重新启用后同批任务恢复 executable。

## REG-3 · 谓词轴接线(校验式,不生成文件)

五个消费点,两种处理:

**改为 import(代码内的)**:
- `repo-exploration-core.mjs:19 :: VALID_PREDICATES` → `validPredicateSet()`
- `repo-understanding-core.mjs:740 :: validPredicates` → 同上
- `fact-graph-harness.mjs :: normalizePredicate` 的合法集 → 同上
- `human-readable-html.mjs :: translatePredicate` → 由 `PREDICATES[name].zhLabel` 派生

**改为契约断言(静态文件,不做运行时生成)**:
- `schemas/explorer-output.schema.json` 的 predicate enum:新增 contract 断言"schema enum 集合 == `Object.keys(PREDICATES)`",不一致即红。schema 文件本身保持静态(bundle 自包含性依赖它)。
- `skills/repo-explorer/references/explorer-protocol.md`:断言每个注册谓词的 `protocolAnchor` 在文档中有对应标题——加谓词忘写判定标准会被测试抓住。

**验收**:改前后 mini-repo 零 diff;故意往 `PREDICATES` 加一个 `test-pred` 不改 schema → `eval:contract` 红。

## REG-4 · 投影轴接线 + 修 D3

- `harness.mjs :: project` 的白名单 `['render-graph','knowledge-index','wiki','all']` → `[...Object.keys(PROJECTIONS), 'all']`。
- `fact-graph-harness.mjs :: projectHarnessPackage` 的 `only ===` 分支增加 html:`only==='all' || only==='html'` 时调用 `generateHumanReadableHtml`(harness.mjs 已 import 它;注意依赖方向——若 fact-graph-harness 不宜 import html 模块,可在 harness.mjs 的 `project` 命令层做 html 分支,projectHarnessPackage 不动,二选一,**以不引入循环依赖为准**)。
- 独立的 `harness html` 命令保留(按需单渲染入口)。
- README 输出契约与 `PROJECTIONS[*].output` 对齐(契约断言:README 的 Output Contract 段包含每个投影的 output 文件名)。

**验收**:`project --package <pkg> --only html` 生成 `human-readable.html`;`--only all` 后四种产物齐全;`--only bogus` 报 usage。

## REG-5 · 注册完整性契约测试(新增 `evals/contract/registry.assert.mjs`,挂进 run-contract)

1. **无游离字面量**:对 `harnesses/ shared/` 的 `.mjs` 做受控扫描,凡匹配 explorer 名模式且不在 `EXPLORERS` 的字符串 → 红(白名单机制豁免注释/测试 fixture)。
2. schema enum == PREDICATES 键集(REG-3)。
3. explorer-protocol.md 锚点覆盖每个谓词(REG-3)。
4. config 的 explorers 键 ⊆ EXPLORERS 键。
5. 禁用行为场景(REG-2 验收 b/c 自动化)。
6. **G-R1 回归**:mini-repo analyze 输出与冻结基线 diff(基线在 REG-1 动手前生成并提交到 `evals/fixtures/golden/`)。

---

## 执行顺序与 DoD

```
基线冻结(改前 mini-repo 产物 → golden) → REG-1 → REG-2 → REG-3 → REG-4 → REG-5
```

每个 REG 一个 commit,前缀 `refactor(registry):`(REG-2 的 D1/D2 修复单独 commit,前缀 `fix(registry):`——它是行为变更,要能单独 revert)。

**DoD**:`npm run eval:contract` 全绿(含新 registry 断言);默认配置下 mini-repo 零 diff;禁用任一 explorer 系统干净收敛到 synthesize 而非靠轮次保险丝;`project --only html` 可用;加一个假 explorer/谓词只需改注册表一处 + 协议文档,漏改任何消费点由契约测试报红。
