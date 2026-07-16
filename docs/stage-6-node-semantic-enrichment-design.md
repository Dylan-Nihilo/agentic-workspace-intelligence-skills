# Stage 6 — Node Semantic Enrichment

## 目标

Stage 6 把 Stage 5 已选定的文件节点从“能看到结构”提升为“能解释这个文件本身”。它只解释局部代码语义，不拼装跨页面业务路径。

```text
Stage 5
Static Program Graph + semantic batches
          ↓
Stage 6
Agent reads one bounded AST neighborhood
          ↓
Node Semantic Catalog
          ↓
Independent semantic review
          ↓
Repository Atlas cards gain evidence-backed meaning
          ↓
Stage 7
Domain Agent consumes accepted node semantics + graph relations
  -> independently reviewed repository domains
  -> same tree, dynamically regrouped by the visible nodes
```

## Stage 6 回答什么

每个文件节点只回答以下问题：

1. 这个文件在代码中承担什么职责？
2. 它从哪里接收输入？
3. 它会执行哪些局部动作？
4. 它持有哪些本地状态？
5. 它向界面或其他模块产生什么输出？
6. 哪些条件会改变其行为？
7. 它与哪些直接相邻文件协作？
8. 哪些内容仅凭当前代码不能确认？

## Stage 6 不回答什么

- 不判断用户角色、业务目标或产品意图。
- 不把多个页面自动串成完整 Journey。
- 不根据路由目录推断流程顺序。
- 不把 parser/import 失败交给 Agent 猜。
- 不在本阶段展开 API 参数表；API 专项分析后续单独执行。

## 调度单位

Stage 5 按静态图 community 与源码体积生成有限批次。一个批次包含：

- 一组不超过上限的主文件；
- 这些文件在 Static Program Graph 中的实体与直接关系；
- 已解析的 template/script AST 摘要；
- 允许读取的源码文件和行数预算；
- 预期输出路径与 `repo-node-semantic-catalog/v1` schema。

Agent 不按“32 个模板问题”工作，也不扫完整仓库。它对批次中的真实节点生成语义条目。

## 权威产物

`store/node-semantics.json` 是 Stage 6 的消费产物。每个条目包含：

- `filePath` 和对应 graph entity；
- `semanticKind`；
- 带源码行证据的 `responsibility`；
- `inputs`、`actions`、`state`、`outputs`、`conditions`；
- 直接 `collaborators`；
- 明确文件不承担什么的 `boundaries`；
- `unknowns`；
- 整卡与字段级 `confidence`、状态和 producer。

证据只保存稳定文件路径与行号范围，不复制源码片段，避免仓库变化后在知识产物中留下陈旧代码副本。

`draft` 条目允许进入 Atlas 供人工检查，但不能被 Stage 7 当成已确认语义。确定性校验只能证明路径、范围、行号和 schema 合法，不能证明“这些行真的支撑这句话”。因此另一个未生成该 catalog 的 `repo-fact-verifier` 必须重开源码，逐条检查职责证据、semanticKind 与越界推断，并用 `repo-node-semantic-review/v1` 绑定精确 catalog hash。只有 review accepted 后，`semantic-ingest` 才能把条目提升为 `accepted`。

Review 产物位于 `research/node-semantics/reviews/batch-*.review.json`，每条记录检查：

- `responsibilityEvidence`：职责描述中的实质性分句是否都有源码支持；
- `semanticKind`：文件角色是否与源码和 incoming relations 一致；
- `noUnsupportedClaims`：是否没有从目录、路由名或通用 import/export 行补写业务含义；
- `catalogHash`：review 是否仍对应当前待审 JSON。

如果文件存在于 inventory、但静态图尚未产生 entity（例如应用 HTML 壳），条目仍以 `filePath` 为身份，`entityIds` 允许为空；它不能伪造 graph entity。

## Atlas 的渐进变化

- Stage 5：卡片仍只显示文件类型、关系、诊断和共享节点。
- Stage 6：已处理卡片增加职责摘要、“语义已补充”标记和显式“展开语义全文”控件。
- 选中卡片：检查器完整展示职责、输入、动作、状态、输出、条件、边界、协作者、未知项和证据行，并提供章节导航。
- 未处理卡片明确显示“待语义分析”，不填充猜测。
- Stage 7：沿用同一棵树、同一批文件卡、同一份展开状态；Domain Agent 使用已接纳节点语义和静态边提出仓库专属领域，审核通过后，画布随当前可见节点动态重排并绘制领域底色。

## 完成条件

Stage 6 的完成度按合格节点计算，不按问题数量计算：

```text
accepted eligible nodes / all eligible nodes
```

eligible 范围由 inventory 确定：仓库内可分析的 Vue、JavaScript、TypeScript 与 HTML 文件全部进入 Stage 6，包括以代码表达的构建配置。样式、文档、二进制资源、protected 文件与仓库外第三方包不进入 Agent 批次；它们仍保留为静态边界或资源事实。

Merchant 当前快照的完成目标是 325 个代码文件全部通过 batch acceptance，最终 catalog 才能标记为 `complete`。
