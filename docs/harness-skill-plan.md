# Harness Skill 化设计计划(v1)

> 目标:把 repo-understanding harness 改造为**任意 agent runtime 均可承载的 skill 套件**,去除对 codex CLI 的强依赖,同时保留 multi-agent fan-out 特性与全部质量门禁。
> 执行方式:Codex 按 H → S → V 顺序实现,每项完成后在对应章节追加 `- [x]` 与验证摘要。
> 前置状态:P0-1~P2-10、F-1~F-3 已修复并验收(见 harness-review-fix-plan.md);真实 L2 探索已产出 138 条带证据动态边,verifier 真实拦截。

---

## 0. 核心设计原则:依赖倒置

**现状(push 模型)**:harness 脚本 → `spawnSync('codex', ...)` → 强绑定 codex CLI 环境。宿主换成 Claude Code / opencode / Cursor 就跑不了 L2。

**目标(pull 模型)**:**承载 skill 的 agent 会话本身就是 LLM 运行时**。harness 只暴露三个文件契约原语(dispatch / ingest / status),任何 agent 按 SKILL.md 指令驱动这三个原语完成闭环。`codex exec` 降级为可选加速适配器。

```
任意 agent runtime(Claude Code / Codex / opencode / ...)
        │  承载
        ▼
┌─ repo-understanding skill(编排)─────────────────┐
│  analyze → status 循环:                          │
│    dispatch → [fan-out 或自己探索] → ingest       │
│    → verify → synthesize → report                 │
└──────────┬───────────────────────────────────────┘
           │ 只通过 CLI 原语读写,禁止直改 JSON
           ▼
harness CLI(确定性,零 LLM 依赖)
  dispatch / ingest / status / analyze / project / verify / report / serve
           ▼
package(fact-graph.json 唯一事实源,不变)
```

**不变量(红线,写进每个 SKILL.md)**:
1. agent 永远不直接编辑 package 内任何 JSON/wiki 产物,一切写入走 `ingest` / `write-subagent-analysis`。
2. fact-graph.json 仍是唯一事实源;skill 不新增任何孤立产物。
3. 探索一律只读源仓库;protected 文件 metadata-only。
4. 无证据不成事实;被 schema 拒绝的输出修正重试(最多 2 次),仍失败则降级 openQuestion,不得绕过校验。

---

## H. Harness 侧改造(先于 skill 实现)

### H-1 新增 `harness dispatch` 原语

从现有 `explore` 内部逻辑抽出派发部分,独立成命令:

```bash
harness dispatch --package <dir> [--max-tasks 40] [--explorers a,b,c]
```

- 从 gap-queue 取 open 可执行任务,按 explorer 分组,写入 `exploration/dispatch/round-<n>/`:
  - `<explorer>.md` — 该 explorer 的完整 prompt(复用现有模板:任务子集 + 静态签名 + 输出 schema + 规则)
  - `manifest.json` — round 号、每个 explorer 的任务 id 列表、tokenBudget、期望输出路径 `<explorer>.output.json`、schema 相对路径
- 任务标记 `dispatched`(沿用 F-1 已实现的状态模型)。
- stdout 输出 manifest 的 JSON,便于 agent 直接解析。

### H-2 新增 `harness ingest` 原语

```bash
harness ingest --package <dir> --analysis <file> [--explorer X] [--round N]
```

- 封装现有 `writeExplorationAnalysis`(严格校验 + snippet 裁剪 + 合并 + 重投影),追加:
  - 成功:stdout 输出 JSON `{merged: true, factsAccepted, edgeDelta, edgesRemovedByVerifier, removedEdgesByVerifier, coverage, openTasks}`,exit 0。
  - schema 拒绝:stdout 输出 JSON `{merged: false, issues: [...]}`(逐条可修正的错误),exit 2。**拒绝原因必须机器可读**,agent 靠它自修正重试。
- 对应任务状态 open→done 的判定沿用现有 gap 重算逻辑。

### H-3 新增 `harness status` 原语

```bash
harness status --package <dir>
```

- stdout 单个 JSON:coverage、open/dispatched/done 任务计数(按类型)、验证状态、`nextAction` 建议(`dispatch` | `synthesize` | `done`)。skill 的编排循环以它为唯一决策输入,避免 agent 自行解析多个文件。

### H-4 `explore --runner codex` 降级为适配器

- 现有 `explore` 重构为:内部调用 dispatch → 对每个 bundle 跑 codex exec → ingest。行为不变,但与 H-1/H-2 共享同一代码路径(禁止两套派发/写回逻辑)。
- 无 codex 时 exit 3 + 提示改用 skill 流程(替换现在的手工命令打印)。

### H-5 收尾在途工作

- 完成线程中未写完的 `harness report` 命令(人类可读概览:项目是什么/怎么跑/模块/路由/权限链/风险,全部字段从 package 产物抽取,禁止自由发挥),并纳入 `verify` 之后的标准链路。
- **F-4 基线提交**:只 stage harness 相关路径(`docs/ harnesses/ shared/ scripts/ package.json`),不含 `skills/agentic-coding-audit/SKILL.md` 的无关修改。此后每个 H/S 项一个 commit。

**H 阶段验收**:在无 codex 二进制的环境变量下(`PATH` 临时剔除),手工按 dispatch → 人工构造合法/非法 analysis → ingest 跑通:合法 merged、非法返回机器可读 issues;status 的 nextAction 随状态正确迁移。

- [x] H-1 `harness dispatch` 已落地:生成 `exploration/dispatch/round-<n>/manifest.json`、每个 explorer 的 `<explorer>.md` prompt 与 `<explorer>.output.json` 路径,stdout 输出 manifest JSON,并标记任务 `status=dispatched`。验证:`/tmp/repo-harness-skill-test` 上 `dispatch --max-tasks 3` 产出 round-1 manifest;round-3 manifest 的 schema 相对路径为 `harnesses/repo-understanding/schemas/explorer-output.schema.json`。
- [x] H-2 `harness ingest` 已落地:普通 explorer output 经合并后走 `writeExplorationAnalysis`;schema 拒绝输出 `{merged:false, issues:[...]}` 且 exit 2;`adversarial-verify` 支持 `repo-adversarial-verification/v1` verdict input,映射到 edge metadata 或删除边。验证:合法 openQuestion-only analysis 返回 `merged:true`;坏 predicate `made-up` 返回机器可读 issue `facts[0].predicate is invalid: made-up`;verifier `not-refuted` 把 `edge:da154647d28588fd` 写成 `metadata.verification.tool=repo-fact-verifier` 且不再重派 adversarial task。
- [x] H-3 `harness status` 已落地:stdout 单个 `repo-harness-status/v1` JSON,包含 coverage、open/dispatched/done/skipped/executableOpen、validation 与 `nextAction`。验证:analyze 后 `nextAction=dispatch`;dispatch 后 open/dispatched 计数正确变化。
- [x] H-4 `explore --runner codex` 已降级为适配器:内部使用 dispatch bundle + output file + ingest 写回;无 codex 时 exit 3 并提示 runtime-neutral skill flow。验证:临时 PATH 剔除 codex 后返回 exit 3 与 `dispatch`/`ingest` 指引。
- [x] H-5 `harness report` 与 request/write-subagent 入口已接入统一 CLI:report 生成 `/tmp/repo-harness-skill-test/report.md`;`harness request` 输出 runtime-neutral synthesis request;`harness write-subagent` 走 `writeAnalysis` 并返回 JSON validation 摘要。

---

## S. Skill 套件(4 个)

放置于 `skills/`,与现有 skill 同构:`SKILL.md`(通用,任何 runtime 可读)+ `references/`(协议细节)+ 可选 `agents/openai.yaml`(Codex 附加配置)。SKILL.md 正文**不得引用任何 runtime 专有工具名**(不写 "Task tool" / "codex exec"),用能力条件句表述:"若你的运行时支持并行子代理,则…;否则顺序执行"。

> **初稿已写好(Claude,2026-07-03)**,Codex 的职责是对齐与接线,不是重写:
> - `skills/repo-understanding/SKILL.md`
> - `skills/repo-explorer/SKILL.md` + `references/explorer-protocol.md`(12 谓词判定标准与真实误判反例,explorer/verifier 共用)
> - `skills/repo-fact-verifier/SKILL.md`
> - `skills/repo-synthesizer/SKILL.md`
>
> Codex 需要做的对齐项:
> 1. H-1~H-3 落地后,核对 SKILL.md 中引用的命令名/参数/输出字段与实际实现一致(尤其 `ingest` 的 stdout JSON 字段、`status.nextAction` 取值、dispatch manifest 结构)。
> 2. `repo-synthesizer` 里的 request 生成命令按实际入口修正(现有 `understanding:request` 或新增 `harness request`),写回命令名同理(现有 `understanding:write-subagent`)。
> 3. verifier 的 verdict 如何经 ingest 通道回写需要 harness 侧明确承接(现有 verification 管线只吃确定性检查;H-2 需支持 explorer=adversarial-verify 的 verdict 输入,映射到 edge metadata.verification 或删除边)。这是 H 阶段唯一的新契约点,实现时同步更新 S-3 的 schema 说明。
> 4. 为每个 skill 补 `agents/openai.yaml`(若 Codex 端需要)。SKILL.md 正文如需修改,保持 runtime 中立措辞。

- [x] S 对齐已完成:四个 SKILL.md 的命令名/参数与 `harness.mjs` 实现一致;`repo-synthesizer` 改为 `harness request` / `harness write-subagent`;`repo-fact-verifier` 改为 `repo-adversarial-verification/v1` schema 与 `skipped` verdict;并行 worker 写 output,编排者串行 ingest。
- [x] Codex UI metadata 已补齐:四个 skill 均新增 `agents/openai.yaml`,字段为 `display_name`、`short_description`、`default_prompt`。验证:`ruby -e 'require "yaml"; ...'` 解析通过。

### S-1 `repo-understanding`(编排,主入口)

- **触发**:用户要求"理解/分析这个仓库"、"生成 repo wiki/图谱/知识索引"。
- **流程**(写死在 SKILL.md):
  1. `harness scout --repo <path> --out <package>`;把 `scout/request.md` 派给可见 `repo-scout` worker;worker 写 `scout/output.json`;编排者执行 `harness ingest-scout --package <package> --analysis <package>/scout/output.json`。
  2. `harness analyze --repo <path> --out <package>`。
  3. 循环(最多 `maxExplorerRounds` 轮):`harness status` → nextAction=dispatch 时执行 `harness dispatch`;读 manifest;**若运行时支持并行子代理:每个 explorer bundle 派一个子代理(加载 repo-explorer skill)并行处理;否则本会话按 bundle 顺序自己执行 repo-explorer 流程**;全部 ingest 后进入下一轮。
  4. adversarial-verify 类任务派给 repo-fact-verifier(同样的并行/降级规则)。
  5. `harness verify`;通过后执行 repo-synthesizer 流程;最后 `harness report`。
- **红线段落**:上文 4 条不变量 + "status 的 nextAction 是唯一循环依据,禁止自行判断 coverage"。

### S-2 `repo-explorer`(L2 探索 worker)

- **输入**:一个 dispatch bundle 路径(`<explorer>.md`)。
- **指令要点**:
  - 只读探索目标仓库,优先处理 bundle 内任务清单,新发现进 openQuestions,不擅自扩围;
  - 输出严格按 bundle 内嵌 schema 写到 manifest 指定的 output 路径;并行模式下由编排者串行执行 `harness ingest`,单会话顺序模式可代编排者执行 ingest;
  - ingest 返回 `merged:false` 时,按 issues 逐条修正 JSON 重试(≤2 次);仍失败则把失败原因写成 openQuestion-only 的 analysis 再 ingest;
  - evidence snippet ≤3 行、必须带 file+line、禁止读取/引用 protected 文件内容;
  - token 预算:达到 bundle 标注预算的估算上限时停止扩展,已完成部分照常提交。
- **references/explorer-protocol.md**:facts 三元组语义表(12 个 predicate 的判定标准与反例——把本轮 `checkPermission` 漏判这类经验沉淀进去)。

### S-3 `repo-fact-verifier`(L3 语义对抗 worker)

- **输入**:adversarial-verify 任务(edge id + 证据)。
- **独立性约束(multi-agent 质量关键)**:只给事实三元组 + 证据片段,**不给产出该事实的 explorer 推理过程**;指令定位为"试图反驳":默认怀疑,证据不足即判 refuted。
- 输出走同一 ingest 通道(verdict 作为 metadata 回写,复用现有 verification 管线)。

### S-4 `repo-synthesizer`(L4 人读产物)

- 读 `harness request` 生成的 synthesis request,产出 `repo-understanding.json`,经 `harness write-subagent` 写回(触发 wiki 叙述化重投影,P2-8 已实现)。
- 约束:每个事实性陈述必须引用 request 中给出的 edge/evidence id,禁止引入图谱外知识。

---

## M. Multi-agent 特性的保持方式

| 特性 | 实现 |
|---|---|
| explorer fan-out | dispatch 按 explorer 分组产出独立 bundle;支持子代理的 runtime 并行派发(每子代理一个 bundle + repo-explorer skill),不支持的顺序执行。**契约是文件,与派发机制解耦** |
| 探索独立性 | 每个 explorer 只见自己的 bundle,互相不可见;独立发现同一事实时走 addEdge 异源置信度叠加(P0-4 修复后的正确语义) |
| 对抗独立性 | verifier 与 explorer 角色分离(S-3 不见推理过程),即使宿主只有单会话,也要求"先全部探索完、再以 verifier 身份重新领任务",禁止边产出边自证 |
| 多轮收敛 | 编排 skill 的 status 循环 = loop-until-dry;dispatched 状态防重派(F-1 已实现) |
| 并发安全 | 并行子代理各写自己的 output 文件;**ingest 由编排者串行执行**(fact-graph 合并不做并发写),manifest 中标明 |

---

## V. 验收(全部通过才算 skill 化完成)

1. **无 codex 环境跑通**:在 Claude Code 会话中(PATH 无 codex),对 mp-merchant-access 执行 repo-understanding skill 全流程:≥2 轮真实探索、≥50 条动态边入图、verify passed、report 含项目概览。
2. **codex 环境跑通**:同一 skill 套件由 Codex 承载执行,产物通过同一 verify;与 1 的 fact-graph 做谓词分布对比,记录差异(允许内容不同,质量门必须同过)。
3. **multi-agent 实测**:在支持子代理的 runtime 下,单轮 ≥3 个 explorer 并行,ingest 串行合并无冲突,dispatched 状态无重派。
4. **质量不回退**:语义抽检门 pass;连续 2 次增量 confidence 零漂移;旧污染包仍 fail。
5. **红线审计**:全流程结束后 `git status` 显示 package 外无脚本未授权写入;抽查 10 条新动态边证据全部真实。

### 本次本地验收记录(Codex Desktop,2026-07-03)

- [x] 本地 runtime-neutral 契约 smoke test:以 `harnesses/repo-understanding` 为目标 repo,输出 `/tmp/repo-harness-skill-test`,完成 `analyze → status → dispatch → ingest(合法) → ingest(非法) → verifier ingest → verify → report → request`。
- [x] 质量门: `find harnesses shared scripts skills -name '*.mjs' -print0 | xargs -0 -n 1 node --check` 通过;`package.json` 与 harness schemas JSON parse 通过;四个 `agents/openai.yaml` YAML parse 通过;runtime 专有措辞扫描未命中 `Task tool` / `codex exec` / `codex-subagent`。
- [ ] V-1 Claude Code 无 codex 全流程、V-2 Codex 完整事实分布对比、V-3 runtime 子代理并行实测、V-4 连续增量 confidence 漂移、V-5 10 条真实动态边红线审计尚未执行。本次只完成工程改造与本地契约验收,不冒充外部 runtime 验收。

### Claude 独立评审记录(2026-07-03,Claude Code 作为宿主 runtime 实测)

**V-1 缩减版已由 Claude 亲自跑通**(`/tmp/mp-skill-v1`,mp-merchant-access,单轮):`analyze → status(nextAction=dispatch, 413 open) → dispatch --max-tasks 4(2 bundles) → Claude 按 repo-explorer SKILL.md 真实探索并写 2 个 output → 串行 ingest(均 merged) → verify passed → report 165 行`。任务状态流转正确:fact 落地的任务消队、openQuestion 转 2 个新任务、dispatched 防重派。bundle 自包含性成立(contract+ingest 命令+strict schema 内嵌,首次提交即通过校验)。

**评审发现的新问题(G 系列,修完才能跑完整 V):**

#### G-1 verifier 误杀无扩展名导入(P1,正确性)

实测:Claude 提交的真实事实 `crud.less imports search-item.less`(证据 `src/components/Crud/styles/crud.less:3` 的 `@import "./search-item";`)被 deterministic verifier 以 `evidence text contradicts imports` refuted 删边。原因:import token 检查要求证据文本包含 object 的完整 basename(`search-item.less`),而 Less/JS 导入惯例不带扩展名。**修复**:token 匹配同时尝试去扩展名的 stem(`search-item`);对 `?inline` 等 query 后缀同理剥离。**验收**:重放该 fact 不再被删;构造真错误目标(证据文本与 stem 也不匹配)仍被删。

- [x] 完成:import verifier 已匹配完整目标、去 query/hash 目标、basename、stem。验证:`/tmp/harness-g123-package` 中 `crud.less @import "./search-item";` 对 `search-item.less` 的 fact 返回 `edgesRemovedByVerifier=0`,FactGraph 保留 `file:src/components/Crud/styles/crud.less imports file:src/components/Crud/styles/search-item.less`;错误目标 `not-there.less` 仍被 verifier 删除。

#### G-2 ingest 契约掩盖 verifier 误杀(P1,契约诚实性)

上述误杀发生时 ingest 返回 `merged:true, factsAccepted:1`,仅 `edgeDelta:0` 暗示异常。**修复**:ingest 返回体增加 `edgesRemovedByVerifier`(本次写回后被 verifier 删除的、源自本 analysis 的边数)与对应 edge/reason 列表,worker 才能感知并按 SKILL.md 申诉或降级 openQuestion。**验收**:重放 G-1 场景,返回体明确报告 removed=1 及 reason。

- [x] 完成:普通 exploration ingest 返回 `edgesRemovedByVerifier` 与 `removedEdgesByVerifier[]`。验证:错误目标 replay 返回 `edgesRemovedByVerifier=1`,列表含 `edge:9d3ef32a8395d3e5` 与 reason `evidence text contradicts imports`。

#### G-3 `factsRejected` 恒为 0(P2,契约语义)

ingest 是全有或全无(schema 拒绝走异常路径),`factsRejected` 字段永远是 0,有误导性。删除该字段或改为真实语义。

- [x] 完成:成功 ingest 返回体已移除 `factsRejected`;schema 拒绝仍走 `{merged:false, issues:[...]}`。验证:`/tmp/harness-g123-good.out` 与 `/tmp/harness-g123-bad.out` 均无 `factsRejected` 字段。

#### G-4 流程欠账(重申)

F-4 基线提交至今未做(git log 仍只有 af82261)。当前工作区已被 Codex 清理干净(无关 diff 已还原、outputs 已删),**没有理由再拖**:立即 commit 全部 harness/skill/docs 文件作为基线。

- [x] 完成:已先提交 G-4 基线 `66f481d Add repo understanding harness skill baseline`,包含 `docs/ harnesses/ shared/ scripts/ package.json skills/repo-*`。

**完整 V-1(≥2 轮、≥50 动态边)、V-3(≥3 explorer 并行)在 G-1/G-2 修复后由 Claude 再执行。**

### 产物内容评审新发现(2026-07-03,mp-merchant-access-repo-understanding 正文核读)

#### G-5 wiki 证据标注是装饰性引用,语义边引用率为零(P1,设计承诺打折)

实测:新包 wiki 全部 269 个 `[e:edge:...]` 标注中,contains 占 41%、depends-on 占 35%、imports 占 24%,**guarded-by/calls/routes-to/reads-from 等 137 条 L2 语义边被引用 0 次**。抽样 3 个标注(如权限链叙述句)全部指向 `module:src contains file:X` 平凡边,无行号无片段——句子本身经源码核对是真的(hasPermission.js 确实读 `store.getters.permissionIds`),但点开证据看到的是"src 包含 main.ts",无法证明该句。根因:`projectWiki` 的 `markFirstEdge` 取节点第一条相关边(通常是 contains),而 synthesis JSON 里明明带着正确的 evidenceRefs 未被透传。`validateWiki` 只查 `[e:` 字符串存在,对此完全失明。**修复**:wiki 投影透传 synthesis 各条目的 evidenceRefs;无 synthesis 时按句子涉及谓词选相关语义边;`validateWiki` 抽样检查标注边的 predicate 与所在章节语义匹配(key-flows 章节引用 contains 边即告警)。**验收**:重投影后 wiki 标注中语义边占比 ≥50%,权限链句子的标注可回溯到真实 guarded-by 边。

#### G-6 import 解析器残留两个路径缺陷(P2,数据直接可见)

open-questions 中出现:`_/assets/img/icon-delete.svg?inline` 未解析(`?inline` query 后缀未剥离——G-1 验收项曾要求剥离,未覆盖 import-resolver 路径);`@/components/rectification//merchantInspection/index.vue` 未解析(双斜杠未归一化)。**修复**:解析前剥离 `?query`/`#hash` 后缀、归一化重复斜杠。**验收**:这两条从 unresolved 队列消失并解析为真实 file 边。

- [x] 完成:import resolver 在 alias/relative/heuristic 解析前统一标准化 target。验证:临时 fixture 中 `_/assets/img/icon-delete.svg?inline` 与 `@/components/rectification//merchantInspection/index.vue` 均进入 FactGraph imports 边,unresolved 队列为空。

#### G-7 mock 目录路由污染 routes-to(P2)

语义抽检失败样本全部来自 `src/mock/services/demo.js` 的路由被当作真实路由。**修复**:mock/fixture 目录(`src/mock/`、`__mocks__/`)的 route 事实默认不生成。**验收**:routes-to 抽检 passRate 回到 1.0,route-map 视图无 mock 路由。

- [x] 完成:JS route-config 识别跳过 mock/fixture 目录。验证:临时 fixture 中 `src/mock/services/demo.js` 的 `/mock-only` 未进入 `codeMap.routes`,真实 `src/router/index.js` 的 `/real` 保留。

#### G-8 open-questions.md 混排(P3)

前 5 条高价值架构问题与 import-resolver 机械 backlog 混排。**修复**:按 raisedBy 分节(架构待确认 / 解析器待办 / explorer 遗留)。

---

## 非目标(本期不做)

- 不做 harness 自身的进程级并发调度器(并行属于宿主 runtime 能力)。
- 不做 embedding/向量化(knowledge-index 结构已预留)。
- 不迁移 `outputs/` 旧格式包。

---

## 附:后续阶段 — 独立分发形态(本期不做,验收通过后再启动)

当前 skill 为**项目内 skill**:与 harness 同仓库,SKILL.md 直接调用 `npm run understanding:harness`,skill 目录零脚本(逻辑只有 harness 一份,守住"无孤立逻辑"红线)。

若需要把 skill 装进 `~/.claude/skills/`、分发给其他团队或其他 agent runtime 独立使用,再做以下打包工作(纯打包,不动逻辑):

1. **首选:harness 发布为 npm 包**(如 `@yeepay/repo-understanding-harness`,bin 暴露 `repo-harness` 命令)。四个 SKILL.md 中的命令改为 `npx @yeepay/repo-understanding-harness <command> ...`,skill 目录仍零脚本,天然跨机器。
2. **备选:每个 skill 加薄 bootstrap**(`scripts/bootstrap.mjs`):按 `REPO_HARNESS_HOME` 环境变量 → 同仓库相对路径 → git clone 的顺序定位 harness,然后转发命令。仅在不便发 npm 包时使用。
3. 打包时冻结契约版本:dispatch manifest / ingest 出参 / status 出参 各带 `schemaVersion`,skill 与 harness 版本不匹配时 ingest 直接拒绝并提示升级。

**红线不变**:任何分发形态下,skill 目录内不得出现校验/合并/投影逻辑的副本。
