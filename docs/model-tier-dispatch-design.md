# 子代理模型分档派遣 · 调研与设计

> 问题:skill 族大量派遣 sub agent 时,子代理模型继承主线程(Codex 主线程 GPT-5.5 → 子代理全是 GPT-5.5)。机械型任务用高推理模型是 token 与时间的双重浪费。目标:让 agent runtime 在派遣时为不同任务选择合适档位的子代理——同时不破坏 runtime 中立(G-B)与确定性编排(ADK 原则)。

---

## 1. 调研结论

### 1.1 Runtime 机制(已查证)

| Runtime | 按次指定机制 | 备注 |
|---|---|---|
| Codex CLI | `codex exec -m <model> -c model_reasoning_effort="<level>"`;或 profile 文件 `--profile <name>` | CLI 覆盖优先于所有配置;exec 单次运行不可换模型(每 bundle 一次 exec,不受影响);`model_reasoning_effort` 仅 Responses API 模型有效 |
| Claude Code | Agent 工具 `model` 参数(按调用);`.claude/agents/*.md` frontmatter `model`;workflow `agent()` 的 `model`/`effort` | 档位词汇与 Codex 完全不同 |
| 其它/未知 | 可能完全没有 | 必须可降级:不支持时行为与今天一致 |

**推论**:跨 runtime 没有统一模型接口 → **契约层声明"算力需求类别"(effort class),不声明模型名**。模型名只出现在两个 runtime 专属层:用户的 `harness.config.json`(调参层)与 runtime 适配器。

### 1.2 本管线的判断力分布(按实战经验分级)

**架构红利(设计安全性的根基)**:生产端(L2)的坏输出被四层门禁拦截(schema 校验 → 证据存在性/行范围 → 确定性 verifier → 对抗校验),**弱模型污染不了 fact-graph**,最坏是接受率低——可观测、可升档重试。裁决端与综合端的错误是**终局的**(错杀真边、业务域划错,无下游兜底)。

→ **不对称原则:生产可降档,裁决/综合不降档。**

| 节点 | 工作性质 | effort |
|---|---|---|
| vue-containment | 机械:组件包含关系读取 | **low** |
| dynamic-import | 机械:解析 import 目标 | **low** |
| route-binding | 半机械:读 router 文件抄路由 | **low** |
| data-access | 识别 SQL/缓存面,需少量语义 | **medium** |
| coverage-directed | 开放式补缺口 | **medium** |
| call-chain | 跨文件多跳调用追踪 | **high** |
| auth-chain | 语义安全判断(guard 语义、dead branch) | **high** |
| adversarial-verify | 裁决:反驳质量决定图谱正确性 | **high**(不对称原则) |
| repo-synthesizer(L4) | 业务判断:businessDomains/keyFlows | **high**(不对称原则) |
| repo-human-readable | **零 LLM**,确定性投影 | n/a |

前端仓库的任务量大头(vue-containment/route-binding/dynamic-import)恰好全是 low——降档收益集中在量最大的地方。精确收益数字需 §3.4 的台账,先不编。

---

## 2. 设计:五层各司其职

沿用既有分层哲学——**注册表声明结构,manifest 传递契约,config 调参,SKILL.md 指导编排,适配器落 runtime 专属**。

### 2.1 注册表(结构层)——`harness-registry.mjs`

`EXPLORERS` 每项增加 `effort: 'low' | 'medium' | 'high'`(§1.2 的值)。这是**需求类别**,不是模型名。新增查询 `explorerEffort(name, config)`(config 可覆盖,同 tokenBudget 模式)。

### 2.2 Dispatch manifest(契约层)

`buildExplorerDispatch`/`createDispatchRound` 给每个 bundle 增加 `effort` 字段(注册表派生、config 可覆盖)。**加法字段,`repo-explorer-dispatch/v1` 不升版**;契约测试补断言:每个 bundle 的 effort ∈ {low,medium,high}。

### 2.3 Config(调参层,runtime 专属内容在此合法)

`harness.config.json` 新增可选段(缺省 = 全部继承主线程,零行为变化):

```json
"modelTiers": {
  "low":  { "model": "gpt-5.1-codex-mini", "reasoningEffort": "low" },
  "high": { "reasoningEffort": "xhigh" }
}
```

规则:某档未配置 → 该档 bundle 不加任何模型参数(继承);只配 `reasoningEffort` 不配 `model` → 只加 `-c` 不加 `-m`。**模型名写在用户 config 里不违反 G-B**——SKILL.md 与注册表仍然中立。

### 2.4 Codex 适配器(`explore --runner codex`)

spawn 参数按 bundle.effort 映射 config.modelTiers:追加 `-m <model>` 与 `-c model_reasoning_effort=<level>`。未映射 → 不加参数(今日行为)。

### 2.5 SKILL.md(编排层,runtime 中立措辞)

`repo-understanding` 流程第 3 步(dispatch 分支)增加:

> **子代理档位(能力条件句)**:manifest 每个 bundle 带 `effort`。若你的运行时支持为子代理指定模型或推理档位(如子代理 API 的 model/effort 参数、CLI 的按次覆盖、agent 定义文件的 model 字段),按 effort 派遣:`low` → 最经济的可用模型;`medium` → 默认;`high` → 与主线程同级或最高推理档。若不支持,忽略 effort,全部用默认——行为与不分档完全一致。

**约束(PRINCIPLE)两条:**
1. **不对称红线**:`adversarial-verify` bundle 与 `repo-synthesizer` 流程不得派给低于主线程默认档的子代理。
2. **失败升档**:低档 bundle 连续 2 次 `merged:false` 或 `factsAccepted=0` 时,允许(且建议)以更高档重派该 bundle 一次,并在会话简报中记录"升档重试"。

`repo-synthesizer`/`repo-fact-verifier` SKILL.md frontmatter 增加 `effort: high` 提示字段(供支持 agent 定义的 runtime 读取)。

---

## 3. 落地分期

- **P1(纯声明,零风险)**:注册表 effort + manifest 透传 + 契约断言 + SKILL.md 能力条件句与两条 PRINCIPLE。不支持分档的 runtime 零感知。
- **P2(Codex 适配)**:config.modelTiers + spawn 参数映射。缺省配置下 G-R1 式零 diff 验收。
- **P3(可观测,回答"降档到底值不值")**:`ingest` 增加可选 `--model/--effort-used` 参数记入 provenance;`report` 输出按档位的 facts 接受率 / verifier 拦截率 / 升档重试次数。这就是一直欠着的 W-3 台账的最小可用形态——有了它,"low 档 route-binding 接受率与 high 档无显著差异"才是可证的结论,而不是猜测。
- **P4(可选)**:Claude Code 适配器(`.claude/agents/` 定义 lite/deep explorer 变体)——仅当有 Claude Code 承载需求时做。

## 4. 非目标与红线

- **不做**运行时自动选模引擎(违反轻契约立场;选择权归编排 agent 与用户 config)。
- **不在** SKILL.md/注册表/manifest 出现任何具体模型名(G-B)。
- **不给** repo-human-readable 配档——它是零 LLM 确定性投影,这是对照组不是遗漏。
- 缺省(无 modelTiers、runtime 不支持)必须与今天行为逐字节一致。
