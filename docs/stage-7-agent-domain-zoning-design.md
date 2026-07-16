# Stage 7 — Agent Domain Zoning

## 目标

Stage 7 在 Stage 6 的同一棵文件依赖树上增加仓库专属的领域组织。它不创建第二张图：文件 identity、依赖边、根节点、展开状态、同层数量上限和检查器全部沿用 Stage 6；变化只发生在当前可见节点的位置、领域标记和动态底色上。

领域名称、子领域和文件归属由 Agent 阅读仓库资产后提出。确定性 kernel 负责准备上下文、校验、独立审核门禁和渲染，不负责猜测业务分类。

## 不做什么

- 不使用路径正则、目录映射、固定领域列表或依赖度阈值直接分类。
- 不用目录名作为唯一证据；路径只能辅助 Agent 定位源码。
- 不为未判断的文件编造兜底领域；使用 `needs-review` 保留未知项。
- 不创建矩形区域框、领域导航卡或另一张风格不同的图。
- 不预先渲染全仓库；领域布局只消费 Stage 6 当前已经展开的可见文件。
- 不在本阶段生成 Journey、行为路径或 API 参数表。

## 输入

Agent context 只封装已经存在的资产：

- `static/inventory.json`：全部仓库文件，保证覆盖边界明确。
- `store/node-semantics.json`：Stage 6 已接纳的代码文件职责、输入、动作、状态、输出、边界和未知项。
- `static/static-program-graph.json`：文件关系、Vue 组件关系、route、handler、request 等确定性边。
- `static/community-map.json` 与 `static/neighbor-map.json`：图结构上的邻接和社区证据。

样式、资源、文档和其他不进入 Stage 6 Agent 批次的文件仍必须被 Stage 7 覆盖。Agent 可根据引用者、邻接节点和仓库上下文判断归属；证据不足时明确标记待确认。

## 权威链路

```text
zone-plan
  -> planning/repository-zone-agent-plan.json
  -> research/repository-zones/context.json
  -> repo-domain-analyzer Agent
  -> research/repository-zones/result.json          # draft
  -> zone-review-plan
  -> repo-domain-verifier Agent                     # independent review
  -> research/repository-zones/review.json
  -> zone-ingest
  -> planning/repository-zones.json                 # authoritative
  -> repository-atlas.html                          # same-tree projection
```

`zone-plan` 的输出不得包含 `zones` 或 `memberships`。它只告诉 Host 应调度什么 Agent、读取哪些资产、写到哪里，以及结果必须满足哪些 schema 和门禁。

分析 Agent 与审核 Agent 必须是两个独立角色。审核绑定草稿的精确 content hash；草稿变化后，旧审核和旧权威 catalog 立即失效。只有 `zone-ingest` 能发布 `planning/repository-zones.json`。

## Agent 产物

Domain Agent 写入 `repo-repository-zones/v2`：

- `zones[]`：仓库特有的领域名称、说明、置信度、子领域和 `evidenceRefs`。
- `memberships[]`：每个 inventory 文件唯一对应一个 `zoneId` 与 `subzoneId`，并记录 role、rationale、confidence、status 与 `evidenceRefs`。
- `unknowns[]`：当前领域划分仍无法回答的问题。
- `status=needs-review` 的 membership：证据不足、跨域或暂时无法确认的文件；它仍保留唯一归属，但不会伪装成已接纳判断。

共享文件仍只有一个文件 identity 和一份权威归属。它可以被多个上游节点引用，但画布用共享引用线连接到同一张完整卡片，不复制为多个领域节点。

## 接纳门禁

审核至少检查：

- `semanticGrounding`：领域解释是否由已接纳语义或明确证据支撑。
- `graphCoherence`：文件关系是否与归属叙述基本一致。
- `completeCoverage`：inventory 中每个文件都被处理。
- `singleFileIdentity`：一个文件只有一个 membership。
- `notPathOnlyClassification`：不存在仅凭目录或文件名得出的分类。
- `noInventedFiles`：所有文件和证据引用都真实存在。

任一关键检查失败时，Stage 7 保持 `active`。Atlas 可以明确标记并预览 Agent 草稿，但不得把草稿称为权威产物。

## Atlas 表达

Stage 7 继续使用 Stage 6 的自上而下树形布局：

1. 用户展开或收起文件卡，先得到与 Stage 6 完全相同的可见文件集合。
2. 同层可见节点按已接纳领域稳定聚拢，不改变同层数量上限选择出的文件。
3. 画布根据当前卡片几何位置实时计算非矩形、低对比度领域底色。
4. 当前区域只有一个可见节点时使用紧凑轮廓；节点增加、减少或消失时，区域随树实时扩张、收缩或消失。
5. 卡片保留文件类型颜色，并增加领域与子领域 badge；检查器继续展示 Stage 6 节点语义和源码证据。

这使 Stage 7 成为 Stage 6 的语义重排，而不是新的静态架构图。

## 当前验证样例

`mp-merchant-access` 的已审核样例覆盖 443 个文件，形成 10 个领域、29 个子领域，并保留 13 个 `needs-review` 文件。首版使用静态兜底分类的草稿被审核拒绝；移除静态分类并由 Agent 重新判断后才被接纳。这个样例验证的是契约与画布行为，不构成其他仓库可复用的固定领域模板。
