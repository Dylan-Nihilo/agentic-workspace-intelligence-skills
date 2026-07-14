# 子代理模型分档派遣 · Codex 构建指南

> 历史 v2 构建指南，已归档：当前 suite 不包含具体 runtime/model 分档
> integration；host 只解释 WorkItem v3 的声明式质量提示。下文的
> gap-queue 与 explorer-dispatch 内容不是当前执行契约。

> 设计依据:`docs/model-tier-dispatch-design.md`(先读,尤其 §1.2 不对称原则与 §4 非目标)。
> 本指南只做 **P1(纯声明层)**;P2(台账)单列在文末,**未获授权前不做**。
> 核心:注册表声明 effort 需求类别 → manifest 透传 → SKILL.md 用能力条件句指导编排 agent 自行映射。**零 runtime 适配代码。**

---

## 0. 护栏

- **G-M1 零模型名**:全部改动中不得出现任何具体模型名/档位词(gpt-*、claude-*、opus、haiku、xhigh…)。effort 只有 `low|medium|high` 三个需求类别词。验收含 grep。
- **G-M2 加法不破坏**:manifest 的 `effort` 是加法字段,`repo-explorer-dispatch/v1` **不升版**;gap-queue 任务结构**不动**(effort 是 bundle 级,不是 task 级)→ `registry:default-mini-repo-golden` 必须保持绿,零重烤基线。
- **G-M3 不碰遗留加速器**:`explore --runner codex` 的 spawn 参数一行不改(设计 §4 非目标)。
- **G-M4** SKILL.md 措辞 runtime 中立(能力条件句),沿用既有红线。

---

## M1 · 注册表加 effort(结构层)

`shared/understanding/harness-registry.mjs`:

1. `EXPLORERS` 每项增加 `effort`(值按设计 §1.2 表,照抄):

| explorer | effort |
|---|---|
| vue-containment / dynamic-import / route-binding | `'low'` |
| data-access / coverage-directed | `'medium'` |
| call-chain / auth-chain / adversarial-verify | `'high'` |

2. 新增导出(模式对齐 `explorerBudget`):

```js
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high'])
export function explorerEffort(name, config = {}) {
  // config.<name>.effort 覆盖(须 ∈ EFFORT_LEVELS,非法值忽略并回退注册表默认) > EXPLORERS[name].effort > 'medium'
}
```

3. `assertKnownExplorers` 顺带校验 config 里的 effort 覆盖值 ∈ EFFORT_LEVELS(非法值报错,同 typo-explorer 处理)。

## M2 · manifest 透传(契约层)

1. `harness.mjs :: buildExplorerDispatch`(~L1215,bundle 组装处 ~L1234):bundle 增加 `effort: explorerEffort(explorerName, explorerConfig)`。
2. `harness.mjs :: createDispatchRound`(manifest 映射处 ~L412/421 两处 bundle 投影):透传 `effort: bundle.effort`。
3. `renderDispatchBundleMarkdown`:bundle 的 `.md` 头部元信息区加一行 `Effort: <level>`(让人和 worker 都看得见)。
4. 兼容脚本 `harnesses/repo-understanding/scripts/build-explorer-dispatch.mjs`:同样从注册表取 `effort` 加进其输出的 explorers 项(两条 dispatch 路径不许分叉)。

## M3 · SKILL.md 编排指引(唯一"适配层")

**`skills/repo-understanding/SKILL.md`** 流程第 3 步 `dispatch` 分支后追加一段(整段粘贴;注意措辞立场——effort 是**先验**,最终决策权明文授予编排 agent,地板除外):

> **子代理档位**:manifest 每个 bundle 带 `effort`(low/medium/high)。它是**默认先验,不是指令**——最终派什么档由你决定。**若你的运行时支持为子代理指定模型或推理档位**(如子代理调用参数、按次 CLI 覆盖、agent 定义文件等你运行时自己的机制),以 effort 为起点派遣:`low` → 你可用的最经济模型;`medium` → 默认;`high` → 与主线程同级或你可用的最高推理档;**并允许你基于自己掌握的信号上下调整**——bundle 任务量异常大或小、仓库明显复杂或简单、上一轮该 explorer 的接受率、剩余预算。调整时在轮次简报中说明一句理由。**唯一不可调整的是档位地板(约束第 9 条)**。若运行时不支持,忽略 effort,全部用默认——行为与不分档完全一致。

**约束(PRINCIPLE) 节追加两条:**

> 9. 档位地板(不可裁量):`adversarial-verify` bundle 与最终综合(repo-synthesizer)不得派给低于主线程默认档的子代理——裁决与综合的错误没有下游门禁兜底,此条不在第 3 步的调整授权范围内。
> 10. 失败升档:低档 bundle 连续 2 次 `merged:false` 或 `factsAccepted=0` 时,建议以更高档重派该 bundle 一次,并在轮次简报中记录"升档重试"。

**`skills/repo-fact-verifier/SKILL.md`** 与 **`skills/repo-synthesizer/SKILL.md`** frontmatter 各加一行 `effort: high`(供支持 agent 定义的 runtime 读取的声明式提示;正文不加 runtime 措辞)。

## M4 · 契约断言(挂进 `evals/contract/run-contract.mjs`)

1. `registry:effort-complete`:每个 EXPLORERS 项的 `effort ∈ EFFORT_LEVELS`。
2. `dispatch:effort-in-manifest`:mini-repo 上跑 dispatch,manifest 每个 bundle 有合法 `effort`,且与注册表(无覆盖时)一致;bundle `.md` 含 `Effort:` 行。
3. `registry:effort-config-override`:临时 config 设某 explorer `effort: 'high'` → manifest 反映覆盖;设非法值 `'ultra'` → 启动报错(沿用 assertKnownExplorers 路径)。
4. **G-M1 验收**:`grep -rniE 'gpt-|claude-|opus|haiku|sonnet|xhigh' shared/understanding/harness-registry.mjs skills/repo-understanding/SKILL.md skills/repo-fact-verifier/SKILL.md skills/repo-synthesizer/SKILL.md packages/repo-understanding-cli/src/commands.mjs` 为空。
5. 既有断言全绿,尤其 `registry:default-mini-repo-golden`(G-M2:golden 不重烤)。

**提交**:M1+M2 一个 `feat(dispatch): declare effort tiers in registry and manifest`;M3 一个 `docs(skill): effort-tier orchestration guidance`;M4 并入 M1/M2 提交或单独 `test(contract):`。

**DoD**:`npm run eval:contract` 全绿;dispatch manifest 可见 effort;grep 零模型名;golden 未动;`explore --runner codex` 无 diff。

---

## P2(台账,单独授权后再做——本次不做)

> 角色升级(与设计文档 §3 P2 同步):台账不只验证"降档值不值",还是 **agent 裁量的审计与反馈回路**——agent 偏离先验的每次调整都留痕;数据积累后可反向修订注册表先验(某 explorer 的 low 档接受率与 medium 无差异 → 降先验)。

- `harness.mjs :: ingest` 增加可选 `--effort-used <level>` / `--model-used <label>`,写入现有 provenance(与 `explorer/round/runtime` 并列);字段自由文本,harness 不校验模型名(runtime 中立:记录"用了什么",不管"怎么指定")。
- `report` 聚合 exploration history:按 effort-used 分组输出 facts 接受率 / verifier 拦截数 / 升档重试次数。
- `repo-understanding` SKILL.md ingest 步骤加一句:"若你按档位派遣了子代理,ingest 时用 `--effort-used`(可选 `--model-used`)如实登记,供 report 统计降档收益。"
- 契约:带 `--effort-used low` 的 ingest 后,history/provenance 可查到该值;不带时字段缺省、行为不变。
