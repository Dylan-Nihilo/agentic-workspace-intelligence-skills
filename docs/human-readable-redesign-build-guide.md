# Human-readable HTML 重设计 · Codex 构建指南

> 历史 v2 构建记录，已归档。文中的 FactGraph 与
> `shared/understanding/human-readable-html.mjs` 已退出执行面；当前 HTML
> 只消费四张 Product Maps、governed Journeys 与已验收 narrative。当前协议见
> `docs/repo-understanding-harness-design.md`。

> 诊断结论：**问题九成在渲染逻辑，不在数据质量**——值钱的语义数据（111 routes-to / 102 dynamic-imports / 795 imports / 36 depends-on）已在 `fact-graph.json` 里，HTML 却渲染了 code-map 的 7 桶烂聚合 + 内部 QA 遥测。本指南把页面从"管线仪表盘"改成"仓库导览"。
> **改动范围**：绝大多数是**单文件** `shared/understanding/human-readable-html.mjs`（渲染），加一个上游编排项（synthesis 必须先跑）。
> 基于真实包验证：`outputs/code-understanding/shop-manage-mobile-20260706-182841/`（Vue3+Vant 移动端，108 路由 / 7 router 文件 / 234 源文件，且**无** `analyses/repo-understanding.json`）。

---

## 0. 护栏（贯穿所有任务）

**litmus（每个视图动手前自问）**：这个视图要的数据在 `fact-graph.json` 里吗？在 → 照做（纯渲染）；不在 → 不许编，标注为"数据未覆盖"或走上游。

**强制规则（批判验证过，缺任一条就退回 public/src 老毛病）：**
- **G1 排除 `src/static`**：该目录 214 个资源文件，任何模块/文件聚合必须先剔除，否则 `src` 桶重新被撑爆。
- **G2 绝不画 451 个 file 节点**：一律折叠到模块级（`src/view/<feature>` 或 `src/<layer>`），目标 ~25 个节点。
- **G3 每域页面截断**：invoice 有 46 个页面，"Top N + 还有 X 个（按需下钻）"，N 建议 8。
- **G4 边阈值**：模块图只画 `imports` 聚合后 weight≥3 的边（72 条），不画 795 条原始边。
- **G5 剔除噪声 router**：只统计 object 路径在 `src/router/` 下的 `routes-to`（自动排除被误判成 router 的 tsconfig.json / vite.config.ts / api index）。
- **G6 诚实**：`guarded-by=0` → **绝不画权限链**；`calls=5` 且集中在单文件 → 数据获取只作"一条追踪示例"，不称"模式"；`reads-from` 5/6 是资源噪声，不得当数据访问；`importance` 是内部中心度分，用于排序可以，但标注为编辑取舍而非语义真理。

**禁止**：新增任何抽取器 / 改 L2 / 动 fact-graph 数据（本轮是渲染重构，不是补数据）；不删 QA 数据（是**降级折叠**，不是删除，审计人格还要用）。

---

## Phase 0 — 解锁（上游 + 生成器兜底，先做，去掉最糟第一印象）

### PH0-1 · synthesis 必须在 html 之前跑（编排）
- `skills/repo-understanding/SKILL.md` 收尾流程：`verify` 通过 → `repo-synthesizer` → **再** `harness html`（承接既有集成方案；html 是终态投影，不进每轮 ingest）。
- `harness html` 加一道软提示：若 `analyses/repo-understanding.json` 缺失，stderr 打印 `warning: synthesis missing, page will use data-derived fallback`（不阻断，仍出页）。

### PH0-2 · 生成器兜底身份句（渲染）
- `human-readable-html.mjs` 的 `synthesisState`：删掉"尚未写入 L4 综合分析"这句道歉。改为：有 synthesis 用其 `summary`；无 synthesis 用 **PH1-1 的 `identity` 计算句**。页面永不以道歉开场。
- **验收**：对当前这份无-synthesis 的包重生成，hero 首屏是"Vue3+Vant 移动端…N 个页面跨 M 个域"，不是道歉/覆盖率。

---

## Phase 1 — 翻转（纯 HTML，全在 `human-readable-html.mjs`，观感跳变最大）

### PH1-1 · `buildReadableModel` 增补派生字段（模型层）

在现有 `buildReadableModel` 里，用已加载的 `nodes`/`edges` 计算并加进返回对象（字段名建议如下）：

```js
// 域地图：routes-to 按 router 文件分组（G5 过滤）
const routeEdges = edges.filter(e => e.predicate === 'routes-to'
  && /(^|\/)src\/router\//.test(nodeOf(e.object)?.path || ''))
// 每组：{ domain: routerBasename, routerFile, count, screens:[{ path: routeNode.label, line: e.evidence[0].line,
//   comment: 抽 evidence snippet 首行的 // 中文注释, view: 见 PH2 join }] }

// 模块图：imports 聚合到模块级（G1/G2/G4）
const moduleOf = p => p.startsWith('src/view/') ? `src/view/${p.split('/')[2]}`
  : p.startsWith('src/') ? `src/${p.split('/')[1]}` : p.split('/').slice(0,1)[0]
// 排除 src/static；file→file 折叠为 module→module 累加 weight；保留 weight>=3

// 技术栈：depends-on 的 package 节点（29 个）
// entryPoints: main.ts / App.vue / src/router/*；sharedModules: imports 入度最高的 file 节点
// dataFetchExamples: 仅保留存在完整 view→api→endpoint 的 calls 链（G6：本包只有 1 条）
```

新增字段：`identity`（一句话："<repo.name>: <stack 徽章文字> 移动端应用，<routeCount> 个页面跨 <domains.length> 个业务域"）、`domains`、`moduleGraph`、`techStack`、`entryPoints`、`sharedModules`、`dataFetchExamples`。

### PH1-2 · 新版 hero = 身份卡
替换 `renderHtml` 的 hero（`renderScoreBlock('校验'/'覆盖率'/'验证器')` 三块，约 212-216 行）为：`identity` 句 + git 来源（`model.repo.git`）+ 技术栈徽章（`model.techStack` 取 vue/vue-router/pinia/axios/vant 等运行时库）。

### PH1-3 · 主图必须是一张真 SVG 架构图（分层模块依赖图）

> **返修记录（v1 教训）**：首版 Codex 把域地图渲染成了文字块，并把唯一的 SVG 降级进诊断区——结果页面一张图都不剩。**页面必须有一张可视化架构图**，且不能是 code-map 的 public/src 老图。

**PH1-3a 分层模块依赖 SVG（= 页面的"架构图"，主图位置）**：把 PH2-2 的模块图**做成真 SVG 并提到这里**。三层布局：
- 上层节点 = view 特性模块（invoice/channel/tax/invoice-service…，box 面积 ∝ 该模块文件数）
- 中层 = 共享层 `components / utils / api / request`
- 底层 = 外部包 lane
- 有向边 = `imports` 聚合到模块级、weight≥3（72 条），线宽 ∝ weight；高亮 `request/index.ts` 这类高入度枢纽
- 遵守 G1（排 src/static）/ G2（≤~25 节点）/ G4（阈值）。

**PH1-3b 功能/域清单（次要，可文字可方块）**：`renderDomainMap(model.domains)` 保留为功能清单，7 个域各列 Top 8 screen + "还有 X 个"（G3）。它是"这 App 能干什么"的清单，不承担"架构图"职责。

**删除**：`renderArchitectureSvg(model.architecture)` 与 `renderComponentTable`（code-map 7 桶烂数据），以及 v1 里被降级到诊断区的那张 `architecture-svg`——**彻底删，不留在诊断区**。

### PH1-4 · QA 遥测全部折叠
把下列移进一个 `<details><summary>管线诊断</summary>`（**降级不删除**）：hero 三连、metric-strip 的 事实图/渲染图/知识索引/缺口 tile（221-225 行）、`renderQuality`（256-265 行）、`distribution-grid`（节点类型/谓词/任务/explorer，267-272 行）。metric-strip 只留"文件"和"路由"（后者改写为"N 个页面跨 M 域"）。

**Phase 1 验收**（对 shop-manage-mobile 包 `npm run understanding:human-html -- --package <pkg>` 重生成）：
- 首屏是身份卡，无覆盖率/验证器/边数；
- 主图是 6-7 个按路由数排的业务域（invoice 明显最大），**不含** public/src 桶；
- 覆盖率/边数/explorer 分布全在折叠区内；
- `node --check shared/understanding/human-readable-html.mjs` 通过。

---

## Phase 2 — 充实（纯 HTML）

- **PH2-1 页面索引（下钻）** `renderScreenIndex`：每域 route→view 明细。**注意这是真工程点**（批判 flag）：`routes-to`（route→router文件）与 `dynamic-imports`（router文件→view）**无直接边**，按同一 router 文件内**行序**配对（route.evidence.line 与 dynamic-import.evidence.line 就近匹配）。**必须有降级**：配不到 view 的 route（tax 16 路由 vs 11 view）显示为"（无独立视图/重定向）"，不得瞎连。
  - **懒加载徽章要删（v1 教训）**：Vue 里懒加载是默认写法，全部路由都是 → `懒加载视图` 徽章零信息量、纯噪声。**默认不标**，只标**例外**：配不到 view 的重定向/父级路由标"（无独立视图）"，极少数非懒加载 eager 路由才标"eager"。删掉现有 `<span class="screen-meta">懒加载视图</span>`。
- **PH2-2 分层模块图** —— **已上提为 PH1-3a 的主图 SVG**，此处不再单列。
- **PH2-3 技术栈面板** `renderTechStack(model.techStack)`：分组框架 + 重型客户端库（html2canvas/vue-pdf-embed/qrcodejs2 等）。**caveat（G6/批判）**：`package` 节点无 dev/prod 标记，会混入 vite/babel/typescript。要干净分组需读该包的 `package.json` 的 dependencies/devDependencies；读不到就按已知 dev 库名单过滤，并标注"依赖分类为启发式"。
- **PH2-4 从哪读起** `renderEntryPoints`：入口（main.ts/App.vue/router）+ 高扇入共享模块（request/index.ts、utils/index.ts）。隐藏原始"重要度 0.209"，改角色标签（"HTTP 客户端"/"共享工具"）。

---

## Phase 3 — 证据按需（纯 HTML）

- **PH3-1 数据获取链（scoped）** `renderDataFetchExample(model.dataFetchExamples)`：标题写"一条追踪示例"，只展示存在的完整链（本包：`getData → licenseRecordList → POST …/licenseServer/licenseRecordList`）。不呈现 reads-from/writes-to 为数据访问。
- **PH3-2 覆盖率内联一行**：`stats.coverageScore`/`coveredSourceFiles` 作正文小字"理解了 234 个源文件中的 201 个；页面→API 与鉴权链仅部分映射"，不做标题。
- **PH3-3 反 mangle**：任何暴露给人看的列表，把节点 ID（`route:ANY:-channel-…`、`file:src/…`）还原为真实路径/URL；`renderKeyEdges` 的 mangled 行要么修要么并入 PH2-1/PH3-1。

---

## Phase 4 — 叙述 + 未来（上游，本轮之后）

- 当 synthesis 跑过时，把其 `summary`/`keyFlows`/`risks` 接进 hero 与主图上方（数据存在才渲染）。
- 若日后要权限视图：加 `guarded-by` 抽取器（L2），属数据侧，不在本渲染指南范围。

---

## 施工顺序与总验收

1. **Phase 0 → Phase 1**（先解锁 + 翻转，做完就能看出方向对不对，建议先只交付到这里让用户 review）。
2. Phase 2 → 3。
3. **总验收**：对 shop-manage-mobile 包（无 synthesis）与任一有 synthesis 的包各生成一次；两者都：身份卡开场、域地图为主图、无 public/src 桶、QA 全折叠、模块图 ≤~25 节点、每域截断生效、无编造数据（权限链不存在、数据链仅示例）。`node --check` 通过。

每个 PH 项一个 commit，前缀 `feat(human-html):`。
