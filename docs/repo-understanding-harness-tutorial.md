# Repo Understanding Harness 教学讲义

> 本文是一次教学式代码走读的完整记录。目标:把 `repo-understanding` harness 从入口函数逐层讲透——它如何把一个陌生代码仓库转成"带证据的结构化知识资产"。
> 讲解顺序沿数据流从上游到下游:`analyze → collectRepoUnderstanding → buildHarnessArtifacts → buildGapQueue → dispatch/ingest → 投影层`。
> 全程对照开源项目 [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) 做架构比较。

---

## 0. 这个项目是什么

一句话:**把任意一个代码仓库,转换成"带证据的结构化知识资产"的流水线**。输入一个 repo,输出一个 `fact-graph.json`(知识图谱)+ 三种投影产物(wiki、render-graph、knowledge-index)。

它最有价值的地方不是"用 LLM 分析代码"本身,而是围绕这件事做的**工程化约束**——怎么保证 LLM 产出的"理解"是可验证、可回溯、不掺水的。

### 与 Understand-Anything 的并排对照

| 阶段 | 本项目 | Understand-Anything |
|---|---|---|
| 发现文件 | `walkFiles` + inventory | Project Scanner |
| 抽结构信号 | `extractFileSignals`(**正则**) | File Analyzer(**tree-sitter**) |
| 推断架构 | `buildArchitectureView` | Architecture Analyzer |
| 升格为图 | `buildHarnessArtifacts` | 图节点/边 + Graph Reviewer |
| 产出知识资产 | `fact-graph.json` + 投影 | `knowledge-graph.json` |

两者骨架几乎同构,说明这套"分阶段流水线"是这个问题域被反复验证的做法。**两个关键差异**:
1. **静态层技术**:本项目用正则(糙、快、零依赖、坏文件不崩),Understand-Anything 用 tree-sitter(准、重)。
2. **严谨性**:本项目多了一整套"证据 + 置信度 + 对抗验证"机制,这是它区别于 Understand-Anything 的核心。背后是不同的**信任分配**:本项目静态层做薄、把严谨性押在后面的证据与验证环节。

---

## 核心设计哲学(贯穿全篇)

### 哲学 1:事实统一,消费者只是投影

`fact-graph.json` 是唯一语义事实源。人看的 wiki、给小程序渲染的 render-graph.json、给 agent 做 RAG 的 knowledge-index.jsonl,全部是从同一张图**确定性地**投影出来的,禁止任何绕过图谱的"孤立产物"。三个消费面永远不会互相矛盾。

### 哲学 2:依赖倒置(pull 模型)

- **老的 push 模型**:harness 脚本内部 `spawnSync('codex')` 主动调 LLM,强绑定 codex CLI。
- **新的 pull 模型**:**承载 skill 的 agent 会话本身就是 LLM 运行时**(Claude Code / Codex / Cursor 都行),harness 退化成零 LLM 依赖的确定性 CLI,只暴露三个文件契约原语:`dispatch` / `ingest` / `status`。

agent 是外层循环,harness 是它反复调用的、不含任何 LLM 的纯函数库。

### 四个反复出现的价值观

1. **确定性执念**:排序、内容寻址 id、预算上界——同样输入必得同样输出。
2. **约束下沉到代码**:安全红线实现在最底层函数里,不靠 LLM 自觉。
3. **证据出生制**:信号从产生那一刻就带 `file:line`,证据链不是事后补的。
4. **诚实标注局限**:不完整就说不完整(`truncated`),不确定就标不确定(`removedByVerifier`)。

### L1→L4 流水线

| 层 | 干什么 | 谁执行 |
|---|---|---|
| L1 Scanner | 静态扫描:文件清单、code map、显式事实、gap queue | 纯代码,无 LLM |
| L2 Explorer | 领 gap 任务,只读探索,产出结构化 `facts[]` + `openQuestions[]` | LLM(agent 按 skill 执行) |
| L3 Merger | schema 校验、实体对齐、置信度合并、对抗验证 | 代码 + LLM verifier |
| L4 Projector | 从图投影出 wiki / render-graph / knowledge-index | 纯代码(synthesis 叙述用 LLM) |

---

## 第一课:L1 静态扫描——从入口到第一批"事实原料"

全部纯代码、零 LLM,负责把陌生仓库变成结构化"原料"。

### `analyze` 命令(harness.mjs:61)

```js
const result = collectRepoUnderstanding({ repoPath, outDir, maxFiles, incremental })
const validation = writeValidation(result.packageDir)   // 生成后立刻自检
if (!validation.passed) process.exitCode = 2            // 不过门禁就 exit 2
```

**要点**:每个"生产"动作后面都紧跟一个"验证"动作,且用 exit code 表达结果(0=成功,2=门禁不过)。CLI 的 stdout 给 agent 机器解析,exit code 给编排逻辑做分支——这是"任意 agent 可承载"的基础设施。

三段式骨架:**准备参数 → 干活 → 报告并用 exit code 表达成败**。`project` / `verify` / `status` 等命令全是同一骨架。

### `walkFiles`(repo-understanding-core.mjs:992)

四个值得学的细节:
1. **确定性**:显式 `sort`,遍历顺序不确定会导致 hash/id/截断结果漂移。
2. **用显式栈而非递归**:深目录不爆栈,`files.length < maxFiles` 可随时刹车。
3. **protected 文件处理**(安全红线的落地点):
   ```js
   const contentAnalyzable = !isProtected && isTextual && stat.size <= MAX_CONTENT_BYTES
   const text = contentAnalyzable ? safeRead(full) : ''   // 敏感文件一个字节都不读
   hash: isProtected ? hashMetadata(rel, stat) : hashFile(full),  // 连 hash 都只对元数据算
   ```
   **红线不靠 LLM 自觉,而是在最底层遍历函数里物理性地做不到。约束下沉到代码。**
4. **每个文件出来就带全套标签**(language/category/binary/large/contentAnalyzable),下游只依据标签过滤,不重复判断。

### `extractFileSignals`(repo-understanding-core.mjs:1271)

对每个可分析文件逐行跑正则,抽 5 类信号:

| 信号 | 例子 | 之后变成 |
|---|---|---|
| imports | `import x from './foo'` | imports 边 |
| symbols | `class UserService` | 节点 + contains 边 |
| routes | `@GetMapping("/orders")` | routes-to 边 |
| annotations/entrypoints | `@RestController`、`main()` | 入口标记、架构视图 |
| componentRefs | Vue `<UserCard>` | 组件引用 |

**为什么用正则而非 AST**:快、零依赖、坏文件不崩(有 try/catch 收集 parseFailures)。代价是漏判误判——**而这正是 L2 存在的理由**:L1 只负责"便宜地抓显式信号",语义留给 LLM。这就是置信度表的由来:`explicit:0.95, ast:0.9, heuristic:0.7, inferred:0.5`。

**上下文门控**:`path:'/orders'` 太易误命中,先用 `isJsRouteConfigFile` 判断"是不是路由配置文件"再抽 route 信号。先判语境、再抽信号。

**每条信号都带 line 和 evidenceRefs**——从最源头开始就没有裸数据。

---

## 第二课:`collectRepoUnderstanding`——如何把"庞杂"拆成"有序"

理解一个仓库很庞杂(上万文件、几十种关系、无数理解角度)。答案:**把"理解"拆成一条固定顺序的流水线,每一步产物喂给下一步,且每步都有边界和上限。**

伪代码骨架(232 行):
```js
files      = walkFiles(root)                    // ① 遍历文件,逐个打标签
inventory  = { repo元信息, 目录汇总, manifests, 文件清单 }   // ② 产物1:有哪些文件
snippets   = readSelectedFiles(chooseKeyFiles(...))          // ③ 挑关键文件读片段
codeMap    = buildCodeMap(root, files, ...)                  // ④ 产物2:文件里有什么信号
codeMap.architecture = buildArchitectureView(...)            // ⑤ 推断架构
harnessArtifacts = buildHarnessArtifacts(...)                // ⑥ 建 FactGraph(第三课)
writeJson(...) × N                                           // ⑦ 落盘
```

### 六段拆解

- **第 1 段(233-241)立规矩**:核心函数不假设调用者,再次校验路径存在;`ensureDir` 先建好输出目录。
- **第 2 段(243-278)产物 inventory**——"有哪些文件"。三个关键字段:
  - `schemaVersion`:每份产物带版本号,消费者可判断认不认识格式。
  - `scan.truncated: files.length >= maxFiles`:诚实记录"是不是没扫完"。
  - `files`:完整文件清单,只保留元数据,**不含内容**。inventory 是目录卡片,不是书本身。
- **第 3 段(280-298)产物 codeMap**——"文件里有什么信号"。三步:
  - `chooseKeyFiles`:用启发式打分挑最能代表仓库的**前 60 个**文件(清单+100、README+90、入口/路由+60...)。这是人类工程师接手陌生仓库的本能被编码成分数。
  - `readSelectedFiles`:**三重预算**(只读挑出的60个 × 每个≤2600字符 × 总量≤maxBytes)+ 脱敏。无论仓库多大,snippets 体积封顶。
  - `buildCodeMap`:逐行抽信号。
- **第 4 段(299-312)升格为 FactGraph**:委托给 `buildHarnessArtifacts`,一次拿到 factGraph+renderGraph+knowledgeIndex,保证同源。
- **第 5 段(313-372)packageIndex**:给知识包写"目录页/藏宝图"。`counts` 是体检报告,全部从真实产物数出来(`Object.keys().length`),不会撒谎。
- **第 6 段(374-380)落盘 + 返回**:**落盘发生在最后**——中途抛错则磁盘不留半个残缺包("要么全成、要么不留痕")。

**驯服庞杂的三件武器**:固定顺序分阶段、处处设上界、诚实标注局限。以及最重要的分工判断:**静态层只求便宜地抓显式信号,精确性和语义交给后面的 LLM 层与验证层。**

---

## 第三课:`buildHarnessArtifacts`——草图如何升格成"带证据的事实图"

### 6 行代码就是整条 L3 流水线(44 行)

```js
const builder = createGraphBuilder(...)                  // ① 空账本
builder.inventoryPaths = new Set(inventory.files.map(f => f.path))  // ② 合法文件白名单
addStaticFacts(builder, ...)                             // ③ 静态信号 → 事实
addDynamicFacts(builder, ...)                            // ④ LLM 探索结果 → 事实
applyExternalVerifierVerdicts(builder, ...)              // ⑤ 采纳外部 verifier 裁决
const verification = runAdversarialVerifier(builder, ...) // ⑥ 内建对抗验证:删伪边
const factGraph = finalizeFactGraph(builder, ...)        // ⑦ 定稿
// 然后从 factGraph 投影出 gapQueue / renderGraph / knowledgeIndex / wiki
```

③④ **两个事实来源汇入同一个 builder**(静态正则的 + LLM 探索的)——这是"事实统一"哲学的代码落点。LLM 只在 ④ 的上游出现,产出喂进来:**图的构造是纯代码,LLM 只是它的数据供应商。**

`builder` 是贯穿构造过程的**可变累加器**,用 `Map` 存 nodes/edges(核心操作是按 id O(1) 查重)。最后 `finalizeFactGraph` 冻结成不可变产物。

### `addEdge`——事实进图的唯一门(1475 行),四道关卡

一条边 = 一个断言 `subject —predicate→ object`。**每条断言必须同时闯过四关**:

```js
// 关卡1:谓词必须在 12 个白名单里
// 关卡2:两端节点必须已存在(不许悬空边)
// 关卡3:必须有证据,且证据文件在 inventory 白名单里
// 关卡4:置信度必须 ≥ 0.5
```

- **关卡3 `isInventoryEvidence`(1533)是防伪造证据的关键**:证据引用的文件必须真实存在于 inventory。LLM 可以撒谎"我在某文件某行看到了",但它没法凭空让那个文件出现在 inventory 里(inventory 是静态扫描的、不受 LLM 影响)。
- **"拒绝 = 记 openQuestion"而非"拒绝 = 丢弃"**:每个 `return null` 前先 push 一条 openQuestion。**被拒的事实不消失,变成"待办疑问",之后被 gap queue 变成探索任务。拒绝不是终点,是下一轮探索的起点。**

### 置信度合并公式 `1 - ∏(1-cᵢ)`(1518-1530)

边已存在时的合并:
```js
existing.evidence = dedupeEvidence([...existingEvidence, ...newEvidence])   // 证据并集
const hasIndependentEvidence = newEvidence.some(item => item.tool && !existingTools.has(item.tool))
if (hasIndependentEvidence) {
  existing.confidence = round01(1 - (1 - existing.confidence) * (1 - rawConfidence))  // 叠加
}
```

例子:已有边 0.7(explorer A),explorer B **独立**也抽出同边 0.6 → `1-(1-0.7)(1-0.6)=0.88`。**结果比两个输入都高**——独立事件都指向同一结论时可信度提升。

**关键前置条件 `hasIndependentEvidence`**:置信度叠加**只在证据来自不同 tool(不同来源)时才发生**。否则同一 explorer 提交两次就自我刷分到 0.99,那是自证作弊。**这个系统不"信任来源",只"信任交叉印证"。** 置信度不是谁声称的,而是"多少独立来源、拿多少真实证据共同指向它"算出来的。

---

## 补充:12 个谓词是什么

定义在 fact-graph-harness.mjs:12,是 FactGraph 里**唯一被允许的边类型**,不在名单里的会在 `addEdge` 第一关被拒。

**第一组 结构关系**(静态正则高置信度抽出):`contains` / `imports` / `dynamic-imports` / `depends-on` / `registers`——骨架,置信度 0.9~0.95。`contains` 打了 `coverageEligible:false`,算覆盖率时不算(免得廉价边刷虚高)。

**第二组 语义/行为关系**(靠 L2 LLM explorer):`routes-to` / `calls` / `guarded-by` / `reads-from` / `writes-to`——血肉,真正回答"系统怎么运作",置信度 0.5~0.7,需过对抗验证。

**第三组 类型关系**:`extends` / `implements`。

**为什么是白名单**:换来(1)每种谓词有明确验证规则;(2)投影时能按谓词确定性渲染;(3)explorer 和 verifier 有共同判定标准。代价是表达受限——塞不进的降级成 openQuestion。**换灵活性 vs 换可验证性**,本项目选后者。

### explorer 谓词协议(explorer-protocol.md)的判定标准与反例

灵魂:**谓词描述的是代码的真实运行语义,不是文本相似度。** 每条"不算"都是真实翻过的车:

- `guarded-by`:`ant-design` 含 `sign`、`ignoreReadBeforeAssign` 含 `sign`、lock 文件依赖名——全是子串误命中。**判据是代码行为,不是子串命中。** 但项目自有函数如 `checkPermission`/`permissionIds` 只要行为在做访问控制**就算**(曾因只认标准注解而漏判)。
- `routes-to`:任意对象字面量的 `path:` 键曾把 `static/code-map.json` 判成路由;i18n 路径、面包屑不算。
- `calls`:`console.error` 里的 URL 曾被判成调用;工具函数内部互调不跨服务边界不算。
- `reads-from`/`writes-to`:`isSelect` 里的 `Select`、`formData.contactType = x`(表单赋值不是写数据库)不算。
- `contains` vs `imports`:只 import 未在 template 渲染 = imports;真实渲染子组件 = contains。同一行 import,配不同使用情况,落不同谓词。

通用纪律:**证据即判据**(没看过上下文的人能复核出谓词成立,做不到→openQuestion);**confidence 校准**(直接可见 0.85-0.95;一步推断 0.6-0.8;两步以上不当 fact);**一事一边**;**不许猜 alias**(交给确定性解析器)。

---

## 第四课:`runAdversarialVerifier`——证据不足就删边(去伪)

### 为什么"去伪"比"查缺"难

LLM(和糙正则)最擅长产出的错误不是"漏",而是**"看起来合理但没证据支撑"的断言**。它谓词合法、两端有节点、甚至附了证据行号,`addEdge` 四关拦不住(形式全合规)。所以需要专门去啃证据、试图反驳的环节。

### 只审"可疑"的边(693 行)

```js
if (!(edge.source !== 'static' || edge.confidence <= 0.7)) continue  // 只审:非静态 OR 置信度≤0.7
if (isExternalVerified(edge)) continue                                // 跳过已被 LLM verifier 审过的
```

把对抗火力集中在真正可疑的目标上——LLM 抽的语义边、低置信边。静态高置信边默认可信。

### `verifyEdgeEvidence`——"有罪推定"的证据审查(754 行)

**七个出口,六个是 `refuted`,只有最后一个是 `not-refuted`。** 默认有罪,一条边必须让所有证据熬过全部检查才勉强判"未被反驳":
1. 证据文件缺失 → refuted
2. protected 文件不能背书 → refuted(安全红线第三次执行)
3. non-analyzable 文件 → refuted
4. 证据文本为空 → refuted
5. `edgeLooksContradicted` → refuted
6. 没检查过任何证据 → refuted

措辞 `not-refuted`(未被反驳)而非 `verified`(已证实)——**认识论上的诚实**:机械检查能排除明显的假,不能证明真。

### `edgeLooksContradicted`(787 行)——只对 imports 做文本矛盾检查

```js
if (edge.predicate === 'imports' || edge.predicate === 'dynamic-imports') {
  const target = edge.metadata?.target || objectToken
  return target && !importEvidenceTokens(target).some(token => lower.includes(token.toLowerCase()))
}
return false   // 其它 10 个谓词一律不做
```

**确定性验证器很克制**,只在自己有把握的地方(import 的目标名必然出现在 import 语句里)下删边的重手,其余留给 LLM 验证器。知道自己能判什么、不能判什么。

### 翻车:G-1——验证器自己误杀真事实

真实场景:Claude 提交真边 `crud.less imports search-item.less`,证据 `@import "./search-item";`。老版本判定:目标 `search-item.less`,去证据行找这个 token → **找不到**(Less/JS import 惯例不带扩展名) → refuted → **删了一条真边**。

修复(`importEvidenceTokens` 799 行):生成多候选 token——剥掉 `?query`/`#hash`、加 basename、加**去扩展名的 stem**(`search-item`)。

**这个翻车真正的教训**:**去伪机制本身也会犯错,而且它的错比漏检更危险。** 漏检(留下假边)顶多噪声,下游还能兜;**误杀(删掉真边)是静默的、不可见的**——你不会知道本该有的真相消失了。所以设两重克制:(1)只在高把握处删;(2)删边也留痕(701 行每删一条 push 一条 openQuestion)。**一个会删真相的工具,必须让每次删除可见、可追溯、可申诉。**

(相关 G-2:误杀时 ingest 却返回 merged:true 掩盖了删边,于是补 `edgesRemovedByVerifier` 字段让 worker 感知。)

### `pruneDynamicOrphanNodes`(737 行)

删边后清理孤儿节点,但**只删带 `dynamic` 标签的孤儿**(幻觉残骸),静态文件节点保留。动态(可能幻觉)从严,静态(可信)从宽。

---

## 第五课:`buildGapQueue` + `status`——让系统自己知道"还差什么"

### gap queue 是系统的"待办清单"

职责:**把图里所有"还差点什么"的信号,收集成一张可派发执行的任务清单。** 这是"多轮收敛"的燃料。

### 五种缺口信号,五个来源(997 行,五个 for 循环)

| 来源 | 任务类型 | 触发条件 | explorer | 优先级 |
|---|---|---|---|---|
| 遍历源文件 | coverage-gap | 除 contains 外无任何事实 | 按路径推断 | high |
| 遍历边 | low-confidence-fact | 非静态 或 置信度≤0.7 且未外部验证 | adversarial-verify | medium |
| 未解析导入 | unresolved-import | import 目标没解析到文件节点 | dynamic-import/route-binding | high/medium |
| 语义提示 | semantic-hint | 正则嗅到"可能是 guarded-by"但没把握 | 按路径推断 | medium/low |
| 开放问题 | open-question | 被拒事实、verifier 删边留下的疑问 | 谁提出派回给谁 | high/medium |

**伏笔回收**:open-question ← `addEdge` 每次拒绝 + verifier 删边;low-confidence-fact 的触发条件与 verifier 筛选条件一模一样;semantic-hint = 不确定的不进图、进任务队列。

### 三个精妙细节

1. **任务 id 由内容决定(1007)**:`gap:${hash(type:reason:relatedNodes)}`。新一轮重算时按 id 继承上一轮 `status`/`dispatch`——**一个已 dispatched 的任务不会被打回重派。防重复派发**,系统才能收敛。内容寻址 id 从"去重"升级成"跨轮次状态记忆"。
2. **computeCoverage 里 contains 边不算数(1626)**:每个文件天然被 contains,算上就永远 100%。**覆盖率衡量的不是"文件在不在图里",而是"我们对它的运作理解了没有"。** 诚实的指标必须排除廉价到无意义的边。
3. **任务按优先级排序(1085)**:先派最重要的。

### 闭环合拢:`status.nextAction`(harness.mjs:311)

**唯一决策点**,核心三行:
```js
const nextAction = executableOpenTasks > 0
  ? 'dispatch'                                    // 还有可执行开放任务 → 继续派
  : hasSynthesis && validation.passed
    ? 'done'                                       // 没任务+综合完+验证过 → 完工
    : 'synthesize'                                // 没任务但没综合 → 做人读层
```

这是 loop-until-dry 引擎的心脏。**为什么决策权必须在确定性代码里而非 LLM**:LLM 判断"够了没有"不可靠、不可复现;`nextAction` 从 gap queue 机械算出,gap queue 从图的客观状态机械算出。整条决策链没有一环依赖 LLM 的主观感觉。

> **LLM 是强大的执行者(去探索、去反驳、去综合),但绝不是流程的裁判。裁判永远是确定性代码。**

---

## 第六课:`dispatch` / `ingest`——agent 与 harness 的文件契约

**harness 是跑在 agent runtime 里的确定性内核,dispatch 和 ingest 是它俩之间唯一的两次握手。**

- **dispatch(出题)**:把"该探索什么"打包成自包含 prompt 文件(bundle),写到磁盘。
- **ingest(交卷+批改)**:agent 把答案 JSON 写到 output 路径,调 ingest,harness 严格校验、合并进图、返回机器可读批改结果。

**为什么必须是文件而非函数调用**:文件契约 runtime 中立。只要能"读一个 md、写一个 json",就能当 explorer。这是"任意 agent 可承载"的物理基础。

### dispatch 三步

1. **按 explorer 分组**(build-explorer-dispatch.mjs):按 `task.explorer` 字段把任务分桶,每桶给一个专门 explorer 角色。**这是 multi-agent fan-out 的分组依据,也是"异源独立"置信度叠加的来源。**
2. **每桶渲染成自包含 prompt**:
   - 内层 body(`renderExplorerPrompt`):角色 + 任务清单 + 从现有 factGraph 捞出的相关节点/边。
   - 外层 wrapper(`renderDispatchBundleMarkdown` 1048):Contract(只读、不碰网络、证据≤3行、protected 只读元数据)+ **完整 schema 内嵌** + **ingest 命令原样给出** + output 路径。
   - **自包含性是刻意的**:并行模式下每个 bundle 派给全新无上下文的子代理,打开 md 什么都有。契约自包含 = 派发机制可随便换。
3. **落盘 + markDispatchedTasks(标成 dispatched,防重派)+ 写 manifest.json**(带 schemaVersion,版本化契约)。

### ingest 批改四动作(ingestExplorationAnalysis 428)

```js
const incoming = sanitizeExplorerOutput(value)              // ① 清洗+严格校验
const next = mergeExplorationAnalyses(base, incoming, ...)  // ② 并入已有探索分析
writeExplorationAnalysis(root, next, ...)                   // ③ ★ 触发全图重建(重跑 addEdge + verifier)
buildHarnessStatus(root, { validation })                   // ④ 重算 nextAction
return { merged:true, factsAccepted, edgeDelta,
         edgesRemovedByVerifier, nextAction, ... }          // 机器可读批改结果
```

**第③步是关键**:agent 提交的每条 fact 都重新过 `addEdge` 四关 + 对抗验证器。**agent 说的话不直接进图,只是"申请入图",能不能进由确定性门禁说了算。** 所以返回体有 `edgeDelta`(净增边数)和 `edgesRemovedByVerifier`(被当场删的)。

### 两条 ingest 分支——闭环合上

```js
if (isVerificationOutput(value, provenance.explorer)) return ingestVerificationAnalysis(...)  // verifier 交卷
return ingestExplorationAnalysis(...)                                                         // explorer 交卷
```

verifier 分支(`verifierOutputToExplorationAnalysis` 1097)把 `refuted`/`skipped` 裁决**转成 openQuestion** → 又被 gap queue 变成任务。**探索产出边 → 验证质疑边 → 质疑变 openQuestion → gap queue 变任务 → 再次 dispatch。** 闭环的最后一根线。

### 自纠错协议

schema 拒绝时 ingest 返回 `{merged:false, issues:[...]}`(逐条机器可读错误)+ exit 2。worker 按 issues 修正重试≤2次,仍失败降级成 openQuestion-only 分析再 ingest。**不允许绕过校验**——校验永远是硬门,agent 再自信也得过门。

---

## 补充:主 agent 如何知道要派 sub agent

**没有任何代码去"派"sub agent。harness 从头到尾不知道 sub agent 的存在。**

`dispatch` 做完只在磁盘留下 bundle 文件 + manifest,进程就结束,不 spawn 任何东西。那"派 sub agent"是谁干的?——**主 agent(编排者)在执行 `repo-understanding` SKILL.md 的指令。**

> **SKILL.md 是一段用自然语言写的"程序",主 agent(一个 LLM)是这段程序的"解释器"。**

SKILL.md 探索循环第 3 步:
```
若你的运行时支持并行子代理:为每个 bundle 派一个子代理,子代理加载 repo-explorer skill,输入为 bundle 路径。
否则:自己按顺序对每个 bundle 执行 repo-explorer 流程。
```

主 agent 读到"为每个 bundle 派一个子代理",用**自己所在 runtime 提供的并发能力**去做(Claude Code 用 Task 工具,Codex 用它自己的机制)。**数据依据是 manifest 的 `explorers` 数组**(有几个 bundle 就派几个)。

**为什么绕这一圈**:SKILL.md 故意不写"用 Task 工具"(计划文档 S 章硬规矩:不得引用 runtime 专有工具名),用能力条件句。于是同一套 harness + SKILL.md + bundle,在 Claude Code / Codex / 简单 runtime / 人肉 四种环境都能跑通,区别只在"派 sub agent"这个抽象动作被映射成什么具体能力。

> fan-out 的**要不要做/做几个**由 manifest 数据决定(确定性),**怎么做**由 runtime 能力决定(各不相同),SKILL.md 是把两者粘起来的 runtime 中立胶水。

---

## 第七课:投影层——"事实统一,消费者只是投影"的兑现

三个投影函数**输入全都只有 factGraph**(wiki 多一个可选 analysis),不读源仓库、不调 LLM、不碰别的中间文件。纯函数:图进,产物出。**三个消费面永远不可能互相矛盾,因为它们是同一个真相的三次确定性重写。**

### 投影一:`projectKnowledgeIndex`(1099)——给 RAG 的"带出处的检索单元"

产出 `evidenceRefs[]`(证据登记表)+ `chunks[]`(检索块)。三种 chunk:fact chunk(每条边)、symbol-card(每个符号)、module-card(每个模块)。

**每个 chunk 都带 `graphRefs` 和 `evidenceRefs` 双向锚定**:
- graphRefs 指回图节点/边 id → "这条知识在图里哪个位置"
- evidenceRefs 指回具体证据(file:line:snippet)→ "凭什么成立"

普通 RAG 检索出来是无出处的文本;这里检索出来是**带出处、带可信度、可回溯到源码行的事实**。质量门禁"knowledge JSONL 的 graphRefs 必须解析到图"守的就是这根锚定线。(text 截断 4000——上界执念到最后一个函数。)

### 投影二:`projectWiki`(1242)——给人读,两种模式

```js
if (analysis?.summary && analysis?.modules?.length) return projectAnalysisWiki(...)  // 有综合:叙述
return projectMechanicalWiki(...)                                                    // 无综合:机械投影
```

`projectMechanicalWiki` 的 README **诚实自曝**:"L1 mechanical projection. No final synthesis analysis has been written yet..." 不假装自己是完整成品。

### 翻车:G-5——证据标注是"装饰性引用"

wiki 铁律:每条事实性陈述必须带 `[e:edge-id -> file:line]` 证据标注。**表面完美,但 G-5 发现标注大多指错地方**:

`markFirstEdge` 给节点盖戳时取**第一条相关边**,而文件节点的第一条边几乎总是平凡的 `contains`。于是:wiki 写着"权限校验通过 permissionIds 实现"(句子是对的),盖的戳却指向"src 包含 permission.js"(毫无信息量),而真正能证明它的 `guarded-by` 边**引用率为零**(实测 269 个标注全是 contains/depends-on/imports,137 条语义边被引用 0 次)。

校验器 `validateWiki` 为何没抓到:**只检查 `[e:` 字符串存不存在,不检查它指向的边和句子语义搭不搭。**

**G-1 与 G-5 是同一认识论陷阱的两面**:
- G-1:验证器"太严",看到不含扩展名的 import 就误杀(假阴性)。
- G-5:验证器"太浅",看到有 `[e:` 就算通过(假阳性)。

**一个只检查"形式在不在"的校验,对"内容对不对"是失明的。形式合规、内容错位的产物,比明显缺失更危险——因为它看起来通过了验证。装饰性的证据戳比没有戳更糟,它给了读者虚假的"已被证实"的安全感。**

---

## 补充课 A:`addStaticFacts`——静态事实具体怎么长出来(fact-graph-harness.mjs:287)

第三课讲了 `addEdge`(进图的门),但没讲静态信号具体怎么变成一条条边。这里补上。`addStaticFacts` 按固定顺序把 codeMap 的每类信号灌进 builder:

1. **模块树**:先建 repo 根节点(`module:.`),再为每个目录建 module 节点,`repo contains dir`(confidence=explicit 0.95,`coverageEligible:false`)。
2. **文件节点**:每个文件建 file 节点(protected 的打 `protected`/`metadata-only` 标签),`parentModule contains file`。config 文件额外建 config 节点。
3. **入口**:`repo registers file`(confidence=ast 0.9),给文件节点加 `entrypoint` 标签。
4. **符号**:`file contains symbol`(ast)。
5. **依赖**:`repo depends-on package`(explicit),证据指向 manifest。
6. **导入**(核心):`resolveImportTarget` 解析目标——解析成功则 `file imports/dynamic-imports target`;**解析失败则 push 到 `builder.unresolvedImports` + 一条 `import-resolver` 的 openQuestion**(这就是第五课 gap queue 里 unresolved-import 任务的来源)。
7. **路由**:建 route 节点,`route routes-to file`(ast)。
8. **组件引用**(Vue):`file contains component`。
9. 最后 `addLineHeuristicFacts`——正则嗅到的"可能是 guarded-by"等弱信号,存成 semanticHints(第五课 semantic-hint 任务的来源)。

**关键观察:每条静态边的 evidence 都带一个 `tool` 字段**——`file-walker` / `symbol-scanner` / `route-hint-parser` / `manifest-parser` / `import-parser` 等。回想第三课的置信度合并公式:叠加只在"不同 tool"的证据出现时发生。**不同的静态解析器本身就是不同的 tool**,所以静态与 LLM 探索独立命中同一条边时,置信度能正确叠加。tool 字段不是装饰,它是"异源独立"的判定依据。

**置信度分层**也在这里体现:直接可见的(imports、依赖、contains-目录)= explicit 0.95;需要解析器识别的(符号、路由、动态导入、入口)= ast 0.9。这与 explorer-protocol 里 LLM 探索的 0.5~0.8 形成梯度——**信号越"显式",置信度起点越高。**

### 导入解析 `resolveImportTarget`(1804)——LLM 不做代码能做得更准的事

按优先级尝试:
1. **相对/绝对路径**(`./` `/`)→ `resolveRelativeImport`(normalize + join)→ inventory 文件,否则 unresolved。
2. **alias**(`@/` `_/`、tsconfig paths、vite/webpack 配置)→ `expandAliasTarget` 展开再解析。
3. **内部启发式** → `expandInternalHeuristic`。
4. 都不是 → 当**外部包**,建 package 节点(tags `external`)。
5. 仍解析不了 → openQuestion + unresolvedImports → 变成 gap 任务。

这呼应 explorer-protocol 那条纪律:**explorer 不许自己猜 alias 展开,交给这个确定性解析器。** LLM 只负责"我看到一条 import 语句"这个事实,路径解析这种确定性的活交给代码——信任分配。

(相关翻车 **G-6**:`?inline` query 后缀、`//` 双斜杠未归一化导致解析失败,进了 unresolved 队列。修复:解析前剥 `?query`、归一化重复斜杠。又一个"形式细节导致误判"的例子。)

---

## 补充课 B:投影三 `projectRenderGraph`(fact-graph-harness.mjs:893)——给小程序的可视化投影

第七课讲了 knowledge-index 和 wiki 两个投影,这里补第三个:给"mp 微渲染"用的 render-graph。机制和另外两个同构(纯函数:图进,产物出),但多了**可视化几何**和**多视图**两个特色:

1. **选点**:`selectRenderNodes` 按 importance 取前 `renderNodeLimit`(800)个节点——大图不会把上万节点全塞进渲染层(上界执念)。
2. **几何**:每个节点带 `view.position` / `view.size` / `sizeHint`,尺寸随 importance 放大——重要的节点画得更大。
3. **无悬空边**:edges 只保留**两端都在选中集合里**的边(914 行 `selectedIds.has(subject) && selectedIds.has(object)`),从源头杜绝悬空引用。
4. **`views[]`——同一张图的四个"镜头"**:这是 render-graph 最精妙的地方。它预定义四个视图,每个是一组 nodeFilter + edgeFilter + layoutHint:
   - `architecture`:contains/depends-on/imports/calls 边,分层布局
   - `route-map`:routes-to/calls 边,树形布局
   - `data-flow`:calls/reads-from/writes-to 边,分层
   - `auth-map`:**只看 guarded-by 边**,力导向布局
   **这直接兑现了第一课"12 谓词换可验证性"的价值**——因为谓词是固定白名单,才能按谓词切出"权限视图""数据流视图"这些确定性镜头。auth-map 就是把所有 `guarded-by` 边单独抽出来画成一张权限链图。同一张事实图,四个镜头,零额外数据。
5. **自检**:`checkRenderGraph` 写进 `renderGraph.checks`,守质量门禁"render graph references 必须 resolve"。

---

## 补充课 C:L4 synthesis——人读综合层(repo-understanding-core.mjs:383 / 478)

第七课讲 wiki 有"机械/叙述"两模式,叙述模式的输入 `analysis` 从哪来?——就是 L4 synthesis 产出的 `analyses/repo-understanding.json`。整个 L4 是"request → 写作 → 写回 → 触发 wiki 重投影"四步。

### 第 1 步 `harness request`(buildRequestForPackage 383)

组装一个**综合请求**:把裁剪后的 FactGraph、架构视图、evidenceRefs、关键片段、探索分析打包成给 synthesizer 看的上下文。注意它是 `transientRequests`(瞬态,只存 hash)——请求本身不是产物,只是喂给 LLM 的一次性上下文。

### 第 2 步 synthesizer 写作(约束是灵魂)

`repo-synthesizer` skill 的**唯一知识来源约束**:

> 你只能基于 request 内容写作:每个事实性陈述必须引用其中的 evidenceRefs / edge id;request 里没有的结论,**哪怕你"知道"这个框架通常如何,也只能进 openQuestions,不得写成事实。**

这是对抗 LLM"脑补"的关键——它读过无数 Vue/Spring 项目,很容易写出"这类项目通常……"的通用套话。约束强制它:**只说图里有证据的,其余一律降级为疑问。** protected 文件只能陈述"存在且受保护"。

### 第 3 步 `harness write-subagent`(writeAnalysis 478)→ 第 4 步 触发 wiki 重投影

`writeAnalysis` 做三件事:
1. `normalizeAnalysis`:把 LLM 输出规整成固定 schema(summary/architecture/modules/keyFlows/risks/openQuestions),缺的字段补空数组——**结构永远合法**。
2. **provenance 全链存证**(445-460):`producedBy` 记录 runtime、role、requestHash、`analysisInputHash`、`analysisOutputHash`、sourcePath。**谁、基于哪个请求、用什么输入、产出什么,全部有哈希可查。** 这是"人读产物也要可审计"——你能验证这份叙述是不是从当时那张图产生的,有没有被偷换。
3. 写 `repo-understanding.json` + `SUMMARY.md`,并 `projectHarnessPackage(only:'wiki')`(501 行)——**这一步把 wiki 从机械模式翻转成叙述模式**(第七课 `projectAnalysisWiki` 分支)。这就是"写回 synthesis 自动触发 wiki 重投影"的机关。

写回失败(schema/evidence 校验不过)→ 按报错修正重试≤2 次,**不得删证据凑格式**。又是那条贯穿全局的红线。

---

## 补充课 D:三个 worker 子代理的视角对比

主 agent(编排者)之外,harness 定义了三个 worker 角色,分别对应 L2/L3/L4。把三份 SKILL.md 并排看,能看清"multi-agent 独立性"是怎么设计的:

| | repo-explorer(L2) | repo-fact-verifier(L3) | repo-synthesizer(L4) |
|---|---|---|---|
| 输入 | 一个 dispatch bundle(任务清单) | 一批 adversarial-verify 任务(三元组+证据) | 一个已 verify 的 package |
| 立场 | 发现者:抽事实 | **反驳者:默认事实是错的** | 叙述者:只复述图里的事实 |
| 产出 | `facts[]` + `openQuestions[]` | `verdicts[]`(refuted/not-refuted/skipped) | `repo-understanding.json` |
| 核心约束 | 只读、不扩围、证据行级、宁缺毋滥 | **不看 explorer 的推理过程**、单会话降级也要重开文件核对 | **只能引用 request 里的 evidence**,脑补进 openQuestions |

**三个共同红线**(写在每份 SKILL.md 里):
1. **不直接编辑任何产物文件**,一切写入走 ingest / write-subagent。
2. **禁止为通过校验而删证据、编行号、调 confidence。**
3. **一切以行级证据为准,拿不准就降级**(explorer 降成 openQuestion,verifier 降成 skipped,synthesizer 降成 risks/openQuestions)。

**verifier 的独立性约束是 multi-agent 质量的关键**:它只拿到三元组 + 证据,拿不到"产出这条事实的 explorer 是怎么想的"。为什么?因为如果它看到 explorer 的推理,就会被那套推理"说服",失去独立视角——它的价值恰恰在于**从零开始、只凭证据、试图反驳**。even 单会话降级模式(同一个 LLM 既当 explorer 又当 verifier),也强制要求"重新打开证据文件核对,禁止凭刚才的记忆下结论"。这就是第一课"对抗独立性"红线的落地:**先全部探索完,再以 verifier 身份重新领任务,禁止边产出边自证。**

---

## 贯穿主题:G 系列翻车的共同命题

G-1(误杀真边)、G-2(删除被掩盖)、G-5(证据戳指错地方)是同一个更深命题的三个切面:

> **当你把不可靠的东西(正则、LLM)纳入一条声称"可信"的流水线,最难的不是让它产出正确结果,而是让你的验证机制能识破"看起来对但其实错位"的产物。** 明显的错(崩溃、缺字段)容易挡;难挡的是形式合规、语义错位的那一类。它们都能骗过一个只看形式的校验。

**这个项目的成熟,不在于它第一次就做对了,而在于它把每一次"形式通过、实质出错"都当成 bug 记下来、修掉、固化成新的校验规则。** explorer-protocol 的"真实误判史"、G 系列问题清单,全是这个自我纠偏的过程。一个把 LLM 嵌进可信系统的工程,它的质量不是设计出来的,是这样一次次翻车翻出来的。

---

## 附:完整数据流图

```
analyze(harness.mjs:61)
  │  准备参数 → 干活 → 报告(exit code 表达成败)
  ▼
collectRepoUnderstanding(core:232)
  ├─ walkFiles ──────────── 遍历+打标签(protected 物理不读)
  ├─ extractFileSignals ─── 逐行正则抽 5 类信号(便宜的 L1 草图)
  ├─ chooseKeyFiles/readSelectedFiles ─ 挑前60、三重预算
  └─ buildHarnessArtifacts(fact-graph-harness:44)
       ├─ addStaticFacts ─┐
       ├─ addDynamicFacts ┼─▶ addEdge(四关:谓词/实体/证据/置信度)
       │                  │      ├─ 通过 → 入图;异源独立才 1-∏(1-c) 叠加
       │                  │      └─ 拒绝 → openQuestion
       ├─ runAdversarialVerifier ─ 去伪(有罪推定,删边留痕)
       ├─ finalizeFactGraph ─ 冻结成不可变 factGraph(唯一事实源)
       ├─ buildGapQueue ─── 五种缺口信号 → 任务(内容寻址 id 防重派)
       └─ project*  ─────── 从图投影三消费品
            ├─ projectKnowledgeIndex ─ RAG(chunk + graphRefs + evidenceRefs)
            ├─ projectWiki ────────── 人读(有/无综合两模式,证据戳)
            └─ projectRenderGraph ─── 小程序渲染
                          │
  ┌───────────────────────┘
  ▼
status.nextAction(harness:311) ── 唯一决策点(确定性,非 LLM)
  ├─ dispatch ─▶ 打包自包含 bundle + manifest ─▶ 主 agent 按 SKILL.md 派子代理
  │              子代理(repo-explorer)只读探索 ─▶ 写 output.json
  │              ─▶ ingest(重跑 addEdge+verifier)─▶ 回到图,新一轮
  ├─ synthesize ─▶ L4 人读层
  └─ done ─▶ 完工

四个价值观贯穿始终:确定性执念 · 约束下沉到代码 · 证据出生制 · 诚实标注局限
```

---

*讲义完。覆盖:第一课(L1 静态扫描)、第二课(collectRepoUnderstanding)、第三课(buildHarnessArtifacts + addEdge + 置信度合并)、补充(12 谓词 + explorer 协议)、第四课(对抗验证/去伪 + G-1)、第五课(gap queue + status)、第六课(dispatch/ingest 文件契约)、补充(主 agent fan-out 机制)、第七课(投影层 + G-5)。*
