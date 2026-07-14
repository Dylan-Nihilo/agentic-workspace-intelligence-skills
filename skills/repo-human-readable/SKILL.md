---
name: repo-human-readable
description: >-
  Render a self-contained HTML view from completed Application, Experience, Runtime Flow, and Change Maps, governed Journeys, and a validated synthesis narrative. Use for the final readable projection of an existing frontend repo-understanding package. Never inspect source code, infer missing relationships, or edit knowledge artifacts.
---

# Repo Human Readable

把已有前端理解 package 中的四张 Map、Journey 与已验证 synthesis narrative 渲染成自包含 HTML。你是只读消费投影，不是事实生产者、研究 agent 或 synthesis 作者。

## 硬门禁

1. 只消费 Application Map、Experience Map、Runtime Flow Map、Change Map、canonical Journey manifest 指向的 `repo-journey-definition/v1`、`repo-journey-binding/v1`、closure report，以及 `synthesis/narrative.json` 中的 `repo-synthesis-narrative/v3`。
2. 任何 required Map、canonical Journey ref/file 或 synthesis narrative 缺失、stale、schema/hash 不匹配，或 Journey Set 未达到默认 100% closure gate 时前置失败。
3. 不读取源码、StaticProgramGraph、raw Claim/Evidence store、旧 architecture/domain/flow/code-map 或旧 HTML 来补事实。
4. 不直接编辑 Map、Journey、Claim、Question、state、event ledger、manifest、wiki 或其他源产物。Active workflow 的 ledger 只能由 harness wrapper 受控更新。
5. 不推断缺失关系，不重排 Journey step，不隐藏 conflicted/missing binding，不补造 feedback/outcome/风险/数字。
6. 视觉、信息层级和验证要求遵循 `references/visual-contract.md`。

## 渲染

先检查 package 是否存在 `state/run-state.json` 或 `store/run-events.jsonl`。存在任一文件就是 active workflow package，必须在本仓库根目录通过 harness wrapper 渲染，使 `projection-built` / `run-completed` 由工作流受控写入：

```bash
npm run --silent understanding:harness -- project --package <package-dir> --only html
```

需要显式输出路径时，active workflow 使用同一 wrapper：

```bash
npm run --silent understanding:harness -- html --package <package-dir> --out <file.html>
```

只有 package 不存在 state/event ledger、明确是隔离的 projection-only package 时，才可直接调用只读 leaf renderer：

```bash
npm run --silent understanding:human-html -- --package <package-dir> [--out <file.html>]
```

直接 renderer 不写 RunEvent，不能把 active workflow 标记为 completed。

默认输出：

```text
<package-dir>/human-readable.html
```

页面必须按以下顺序呈现：

1. Application Map 携带的 support level、frontend scope、snapshot 与 renderer validation 状态；
2. Application Map；
3. Experience Map；
4. Runtime Flow Map 与关键 Journey；
5. Change Map；
6. unresolved `semantic-ambiguity`、`runtime-external-blocked`、`product-intent` 与 deterministic diagnostics；
7. provenance、artifact hash 与生成信息。

把 Journey 按稳定 step order 与 `success|failure|alternate|retry|exit` branch 呈现。把 binding 的 `confirmed|candidate|conflicted|missing` 状态明确显示，不得用样式掩盖不确定性。

## 验证

检查生成器语法：

```bash
node --check packages/repo-understanding-kernel/src/projections/human-readable-html.mjs
```

重建 HTML 时仍遵守上述边界：active workflow 重复调用 harness `html`（幂等完成）；projection-only package 才调用 `understanding:human-html`。

再用浏览器检查：

- 页面非空且四张 Map 都可定位；
- Runtime Flow 的 step 顺序、branch 与输入 Journey 一致；
- Change Map 的 impact 与输入条目一致；
- blocked/open/diagnostic 状态可见；
- evidence/provenance 可追溯；
- narrative 的 snapshot、projectionKey、Map/Journey refs 与权威产物一致；
- 移动端无重叠，键盘可操作，文字对比度合格；
- theme toggle 与 SVG export 不报错；
- HTML 中不存在旧 Map 的独立公共入口或新造事实。

## 返回

返回 HTML 路径、repo/snapshot、support level、四张 Map 的 artifact hash、Journey closed/open/blocked 数量与 closure gate 结果、三类 OpenQuestion 数量、deterministic diagnostics 数量与验证结果。所有值必须直接来自输入产物。
