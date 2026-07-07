---
name: repo-human-readable
version: 1.0.0
harnessContract:
  inputArchitecture: repo-code-map-architecture/v1
  output: repo-human-readable-html/v1
lastValidated: 2026-07-07
description: Render a self-contained human-readable HTML PAGE from an already-complete repo-understanding package (architecture SVG, evidence summaries, quality gates). Read-only consumer projection — edits no source artifact. Use to produce a shareable HTML view of an EXISTING package, not to build or synthesize it (use repo-understanding / repo-synthesizer). Keywords - HTML 页面, 自包含, human-readable projection, 架构图, package 可视化.
---

# Repo Human Readable

输入是一个已有 repo-understanding package;产出是自包含 `human-readable.html` 页面。它是只读消费投影,不是事实生产者,也不是最终综合作者。

## 红线(HARD-GATE)

无额外数据门禁;本 skill 是只读消费投影,不生产事实。

## 约束(PRINCIPLE)

1. [PRINCIPLE] 生成器仅接受已完成的 package;缺 `static/code-map.json` 或 `fact-graph.json` 时前置失败。
2. [PRINCIPLE] TODO(投影只读 gate) 不得编辑 `fact-graph.json`、`static/code-map.json`、`render-graph.json`、`knowledge-index.json`、`wiki/` 或其他源产物。
3. 页面指标必须来自当前 package;不要手写或补造数字。
4. 架构图数据来自 `static/code-map.json#architecture`;证据、路径和质量状态必须可回溯。
5. 如果最终综合缺失,页面必须说明它是确定性投影,不是最终人读综合。
6. 视觉和 SVG 约束见 `references/visual-contract.md`。

## 流程

1. 在 harness repo 根目录运行:

```bash
npm run --silent understanding:human-html -- --package <package-dir>
```

2. 可选指定输出:

```bash
npm run --silent understanding:human-html -- --package <package-dir> --out <file.html>
```

3. 默认输出:

```text
<package-dir>/human-readable.html
```

4. 验证:

```bash
node --check shared/understanding/human-readable-html.mjs
npm run --silent understanding:human-html -- --package <package-dir>
```

5. 打开 HTML 或用 headless browser 检查:页面非空、SVG 可见、质量数据 populated、移动端不重叠、主题切换和 SVG export 不报错。

## 返回给编排者

返回 HTML 路径、schemaVersion、repo 名称、metrics 摘要、架构组件/连线/边界数量,以及验证结果。
