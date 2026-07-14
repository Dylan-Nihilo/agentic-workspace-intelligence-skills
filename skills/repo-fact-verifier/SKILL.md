---
name: repo-fact-verifier
description: >-
  Independently review one bounded Stage 6 Node Semantic Catalog batch, or adjudicate conflicting semantic Hypotheses/high-risk frontend Journey bindings for one adjudicate ResearchContract. Use only when repo-understanding dispatches a typed review batch or repo-work-item/v3. Do not replace deterministic verification, discover unrelated facts, or mutate authoritative stores.
---

# Repo Fact Verifier

执行两种互斥模式之一：Stage 6 `node-semantic-review`，或 `kind=adjudicate` WorkItem。以默认不可信的立场重开源码证据。执行前完整读取 `references/verifier-protocol.md`。

## 硬门禁

1. 只接受 typed `node-semantic-review` batch，或 `role=repo-fact-verifier`、`kind=adjudicate`、`schemaVersion=repo-work-item/v3` 的任务；拒绝混合模式。
2. adjudicate 模式只执行 WorkItem `contractRef` 指向的 `repo-research-contract/v1`。node review 只读取 batch、待审 catalog 与 allowedFiles，并写唯一 reviewPath。
3. 不承接 parser、import/module resolution、protected access、unsupported syntax、schema/hash/fingerprint 等 deterministic diagnostics。
4. 只读取 contract scope 和明确提供的 Hypothesis、Journey step、binding 与 evidence refs。不得扩围寻找新业务主题。
5. 保持目标仓库只读。不 install、build、test、启动服务或读取 protected 内容。
6. 不直接创建 Claim、不修改 JourneyBinding、不写权威 store、不调用 ingest。
7. Node review 必须由未生成该 batch catalog 的独立 Agent 执行。不得修改被审 catalog；只输出 `repo-node-semantic-review/v1`。

## 执行

### Node semantic review

1. 核对 planId、snapshotId、batchId、primaryFiles、allowedFiles、catalogHash 与唯一 reviewPath。
2. 对每个 entry 重新打开源码；逐个实质性分句检查 responsibility evidence，不能用 `import`、`export`、`request`、组件 `name` 等通用行支撑更具体的领域职责。
3. 结合源码与 graph relations 检查 semanticKind；局部弹窗、记录面板和父页面渲染的模块不得因文件名为 `index.vue` 自动标成 page。
4. 检查 inputs/actions/state/outputs/conditions/boundaries 是否有直接证据，低代码壳是否凭路径或路由名补写了源码不存在的业务。
   `collaborators.filePath` 可以指向 batch 外的 inventory 文件，但其 role 必须完全由 allowed 源码中的 import/render/call 证据支持；只有 reviewer 实际打开目标文件或声称其内部行为时，目标文件才必须进入 allowedFiles/scopeFiles。
5. 每个 entry 填三项检查：`responsibilityEvidence`、`semanticKind`、`noUnsupportedClaims`。任一失败则 entry 与总 review 均为 `changes-requested`，写明可执行修改原因。
6. 所有 entry 通过才输出 `status=accepted`；catalogHash 必须绑定待审 JSON 的精确内容。

### Semantic adjudication

1. 核对 WorkItem、ResearchContract、snapshot、read scope、target maps 与 blocking journey IDs。
2. 丢弃 producer 的推理过程；重新打开 evidence，并主动寻找反证和竞争解释。
3. 对冲突 Hypothesis 分别判断 `supported|refuted|inconclusive`。不得把“未找到反证”自动写成 supported。
4. 对 Journey binding 检查顺序、branch 和语义连接是否有证据。重点复核：
   - auth/permission 是否真的控制目标 route/action；
   - handler 是否触发目标 effect/state mutation；
   - request 是否到达目标 endpoint；
   - response 是否驱动目标 feedback/outcome；
   - success/failure/alternate/retry/exit branch 是否真实存在。
5. 用 `repo-task-outcome/v1` 返回逐 question 结论和经裁决的 `repo-hypothesis/v1`。不要返回旧 edge verdict payload。
6. 对证据不足的项目使用 `inconclusive`。按原因创建 `semantic-ambiguity`、`runtime-external-blocked` 或 `product-intent`；后两类不得再派 repo explorer。
7. 根据 acceptance criteria 设置 `satisfied|partially-satisfied|blocked|failed`。任何 blocking Hypothesis 或 binding 仍 inconclusive 时不得 satisfied。
8. 写 `repo-work-result/v3`，准确填写 `contractId`、`outcomeStatus`、`artifactHashes`、实际 `readSet`、`scopeViolations`、`errors` 与 `usage.status`。
9. 返回编排者串行 ingest。不得自行关闭 Journey、生成 Map、synthesize 或 project。

## 返回

Node review 返回 reviewPath、batchId、catalogHash、accepted/changes-requested 数量和问题路径。adjudicate 返回 itemId、contractId、attempt、TaskOutcome/WorkResult 路径、outcomeStatus、supported/refuted/inconclusive 汇总、受影响 Journey/binding、未满足 criteria、OpenQuestion 分类、readSet 与 scope violations。不要宣称结果已写入权威 store。
