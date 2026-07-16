# Stage 8 — Agent Domain Understanding

## 目标

Stage 8 解释 Stage 7 已审核领域的工程职责。它不重新分类文件，也不创建第二张图：领域名称、文件唯一归属、依赖边、根节点、展开状态和卡片位置全部沿用 Stage 7。

本阶段回答七类问题：这个领域负责什么、从哪些文件进入、哪些文件承载核心职责、哪些文件连接其他领域、与谁协作、产生什么可观察结果、还有什么无法从当前代码确认。

## 不做什么

- 不修改 Stage 7 的 `zoneId`、领域标题、子领域或文件 membership。
- 不把文件调用链包装成用户业务旅程。
- 不依据目录名、文件名或固定模板生成领域职责。
- 不把没有语义或图关系证据的判断写成事实。
- 不生成新的领域图、矩形架构图或脱离原树的详情页面。
- 不在本阶段补 API 参数表、运行时流量或产品意图。

## 输入

`domain-summary-plan` 只消费已存在的权威资产：

- `planning/repository-zones.json`：Stage 7 已审核的领域、子领域和文件归属。
- `store/node-semantics.json`：Stage 6 已接纳的文件职责、输入、动作、输出、边界和源码行号。
- `static/static-program-graph.json`：真实有向文件关系，用于证明领域边界和协作方向。
- `static/inventory.json`：文件类型、行数和仓库身份。

生成的 context 按领域封装成员文件、可用语义、跨领域文件边和 Stage 7 关系摘要。Agent 只能在这些边界内作答。

## 权威链路

```text
domain-summary-plan
  -> planning/repository-domain-summary-agent-plan.json
  -> research/repository-domain-summaries/context.json
  -> repo-domain-interpreter Agent
  -> research/repository-domain-summaries/result.json       # draft
  -> domain-summary-review-plan
  -> repo-domain-summary-verifier Agent                     # independent review
  -> research/repository-domain-summaries/review.json
  -> domain-summary-ingest
  -> store/repository-domain-summaries.json                 # authoritative
  -> repository-atlas.html                                  # same-tree projection
```

解释 Agent 与审核 Agent 必须是两个不同的 Agent。审核绑定草稿的精确 SHA-256 hash；草稿变化后，旧审核与旧权威产物立即失效。只有 `domain-summary-ingest` 可以写入最终 catalog。

## Agent 产物

每个已审核领域必须恰好对应一个 summary：

- `responsibility`：领域的工程职责，附语义或领域证据。
- `entryFiles`：进入该领域的主要代码入口，文件必须属于当前领域。
- `coreFiles`：承载主要职责的核心文件，文件必须属于当前领域。
- `boundaryFiles`：连接其他领域的本领域文件。`connectedZoneIds` 和 `direction` 必须由该文件参与的全部真实跨领域有向关系精确推导；每条图证据都必须以该文件为端点。
- `collaboratingDomains`：协作领域、方向、关系数量与说明。
- `outputs`：从代码可证明的领域产物或能力。
- `unknowns`：静态代码无法确认的问题及原因。
- `confidence`：整段领域解释的置信度。

语义证据必须引用 context 中已有的 `filePath:startLine-endLine`；图证据必须对应 Static Program Graph 中真实存在的有向文件关系。

## 接纳门禁

独立审核至少检查：

- `evidenceGrounding`：积极判断都有可回溯证据。
- `zoneCoverage`：所有 Stage 7 领域恰好覆盖一次，名称与归属不变。
- `entryAndCoreAccuracy`：入口和核心文件属于当前领域，解释与证据一致。
- `boundaryAccuracy`：边界文件、连接领域和方向与该文件的全部真实跨领域关系完全一致，引用的图证据不能借用其他文件之间的关系。
- `collaborationAccuracy`：协作领域与 Stage 7 关系和文件边一致。
- `noInventedBehavior`：没有把静态调用细节夸大成业务行为。
- `unknownsPreserved`：证据不足处保留未知项。

任一检查失败时 Stage 8 保持 `active`；Atlas 可以显示草稿预览，但必须明确标注“待独立审核”。

## Atlas 表达

Stage 8 继续使用 Stage 7 的自上而下树形画布：

1. 当前可见文件、父子关系和展开状态完全不变；每个文件只保留一张完整卡片，普通复用显示为共享引用，回到祖先节点的关系显示为紧凑的“事件回路”引用。
2. 领域标题变为可聚焦控件；鼠标点击和键盘 Enter/Space 都可操作。
3. 聚焦后，当前领域卡片高亮，协作领域保留次级强调，其他领域淡出。
4. 入口、核心、边界角色以小型 badge 标在原文件卡片上。
5. 画布右侧出现伴随说明卡，展示职责、角色文件、协作、产物、未知项和审核状态。
6. 关闭说明卡后恢复全部领域；画布的缩放、移动、展开和文件检查器保持原行为。

## 当前验证样例

`mp-merchant-access` 首个 Stage 8 修订草稿覆盖 Stage 7 的 10 个领域，包含 45 个入口文件、51 个核心文件、55 个边界文件、52 条领域协作摘要、29 个领域产物和 11 个未知项。它是仓库专属结果，不构成其他仓库的固定领域模板。
