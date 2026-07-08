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

**推论**:跨 runtime 没有统一模型接口,且 runtime 数量在增长,**逐个做适配器维护不过来(明确非目标)**。因此:契约层只声明"算力需求类别"(effort class),**映射到具体模型这件事整个交给编排 agent**——它就是自己 runtime 的天然适配器(pull 模型的本义:承载 skill 的 agent 会话即运行时)。我们提供声明,不提供接线。

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

## 2. 设计:三层,零 runtime 适配

沿用既有分层哲学——**注册表声明结构,manifest 传递契约,SKILL.md 指导编排**。没有第四层:不为任何 runtime 写接线代码,编排 agent 自己就是适配器。

### 2.1 注册表(结构层)——`harness-registry.mjs`

`EXPLORERS` 每项增加 `effort: 'low' | 'medium' | 'high'`(§1.2 的值)。这是**需求类别**,不是模型名。新增查询 `explorerEffort(name, config)`——`harness.config.json` 的 `explorers.<name>.effort` 可覆盖需求档位(调的是"这个任务多难",仍然 runtime 中立,同 tokenBudget 模式)。

### 2.2 Dispatch manifest(契约层)

`buildExplorerDispatch`/`createDispatchRound` 给每个 bundle 增加 `effort` 字段(注册表派生、config 可覆盖)。**加法字段,`repo-explorer-dispatch/v1` 不升版**;契约测试补断言:每个 bundle 的 effort ∈ {low,medium,high}。

### 2.3 SKILL.md(编排层 = 唯一的"适配层",runtime 中立措辞)

**决策结构(三层,明文)**:模型选择的最终决策权在编排 agent,但不是无先验的自由决策:

```
注册表 effort  = 静态先验(沉淀的领域知识;覆盖默认情况;成本可预算)
agent 裁量     = 动态修正(基于 agent 独有的信号:bundle 实际大小、仓库复杂度、
                 上一轮接受率、剩余预算、本 runtime 可用的模型)
红线           = 地板(裁决/综合不降档;不给 agent 裁量权——错误无下游兜底)
```

依据:任务难度在执行前难判断、执行后才充分暴露 → **先验管派遣时,证据管修正时**;模型选错不破坏图的正确性(门禁兜底),属低风险判断,可以交给 agent,但不值得每轮花高推理 token 重新推导已沉淀的先验。

`repo-understanding` 流程第 3 步(dispatch 分支)增加:

> **子代理档位**:bundle 的 `effort` 是**默认先验,不是指令**。若你的运行时支持为子代理指定模型或推理档位(如子代理调用参数、按次 CLI 覆盖、agent 定义文件等你运行时自己的机制),以 effort 为起点派遣(`low` → 最经济可用模型;`medium` → 默认;`high` → 与主线程同级或最高推理档),**并允许你基于自己掌握的信号调整**:bundle 任务量异常、仓库明显复杂或简单、上一轮该 explorer 的接受率、剩余预算。调整时在轮次简报中说明一句理由。**唯一不可调整的是档位地板(下条红线)**。若运行时不支持,忽略 effort,全部用默认——行为与不分档完全一致。

**约束(PRINCIPLE)两条:**
1. **不对称红线(地板,不可裁量)**:`adversarial-verify` bundle 与 `repo-synthesizer` 流程不得派给低于主线程默认档的子代理。
2. **失败升档**:低档 bundle 连续 2 次 `merged:false` 或 `factsAccepted=0` 时,允许(且建议)以更高档重派该 bundle 一次,并在会话简报中记录"升档重试"。

`repo-synthesizer`/`repo-fact-verifier` SKILL.md frontmatter 增加 `effort: high` 提示字段(供支持 agent 定义的 runtime 读取)。

---

## 3. 落地分期

- **P1(纯声明,零风险)**:注册表 effort + manifest 透传 + 契约断言 + SKILL.md 能力条件句与两条 PRINCIPLE。不支持分档的 runtime 零感知。
- **P2(可观测:降档收益验证 + agent 裁量的审计与反馈回路)**:`ingest` 增加可选 `--model-used/--effort-used` 参数记入 provenance(编排 agent 在 ingest 时自报实际派遣档位,含它偏离先验的调整);`report` 输出按档位的 facts 接受率 / verifier 拦截率 / 升档重试次数。三重价值:(a) "low 档 route-binding 接受率与 high 档无显著差异"从猜测变成可证结论;(b) agent 的裁量有了留痕审计——它偏离先验时派了什么、结果如何;(c) **先验可被证据修订**——跑若干仓库后,若数据显示某 explorer 的 low 档与 medium 档质量无差异,就降注册表先验。先验不是拍死的,是被台账持续校准的。台账字段本身 runtime 中立(记录"用了什么档",不管"怎么指定的")。

## 4. 非目标与红线

- **不做任何 runtime 专属适配器**(Codex/Claude Code/其它一律不做)——runtime 太多,做不过来也不该做;映射由编排 agent 按 SKILL.md 指引自行完成。既有的 `explore --runner codex` 遗留加速器**不接分档**,保持现状。
- **不做**运行时自动选模引擎(违反轻契约立场;选择权归编排 agent)。
- **不在** SKILL.md/注册表/manifest/config 出现任何具体模型名(G-B 收紧:config 也只许调 effort 需求档,不许写模型名)。
- **不给** repo-human-readable 配档——它是零 LLM 确定性投影,这是对照组不是遗漏。
- 缺省(runtime 不支持/忽略 effort)必须与今天行为完全一致。
