import fs from 'node:fs'
import path from 'node:path'
import { EXPLORERS, PREDICATES } from './harness-registry.mjs'

const HTML_SCHEMA = 'repo-human-readable-html/v1'
const DEFAULT_ACCENT = '#002FA7'

export function generateHumanReadableHtml(options) {
  const packageDir = path.resolve(options.packageDir)
  const outFile = path.resolve(options.outFile || path.join(packageDir, 'human-readable.html'))
  const state = readPackage(packageDir)
  const model = buildReadableModel(packageDir, state)
  const html = renderHtml(model)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, html, 'utf8')
  return {
    schemaVersion: HTML_SCHEMA,
    packageDir,
    output: outFile,
    repo: model.repo,
    metrics: model.metrics,
    architecture: {
      components: model.architecture.components.length,
      connections: model.architecture.connections.length,
      boundaries: model.architecture.boundaries.length,
    },
  }
}

function readPackage(packageDir) {
  const read = (...parts) => readJsonIfExists(path.join(packageDir, ...parts))
  const required = (value, rel) => {
    if (!value) throw new Error(`Missing required repo-understanding artifact: ${path.join(packageDir, rel)}`)
    return value
  }
  return {
    index: read('index.json'),
    inventory: read('static', 'inventory.json') || read('inventory.json'),
    codeMap: required(read('static', 'code-map.json'), 'static/code-map.json'),
    factGraph: required(read('fact-graph.json'), 'fact-graph.json'),
    renderGraph: read('render-graph.json') || read('static', 'render-graph.json'),
    knowledgeIndex: read('knowledge-index.json') || read('static', 'knowledge-index.json'),
    gapQueue: read('gap-queue.json'),
    verification: read('verification.json'),
    validation: read('validation.json'),
    exploration: read('analyses', 'repo-exploration.json'),
    synthesis: read('analyses', 'repo-understanding.json'),
  }
}

function buildReadableModel(packageDir, state) {
  const factGraph = state.factGraph || {}
  const repo = {
    name: state.index?.repo?.name || factGraph.repo?.name || state.codeMap?.repo?.name || path.basename(packageDir),
    path: state.index?.repo?.path || factGraph.repo?.path || state.codeMap?.repo?.path || '',
    git: state.index?.repo?.git || state.codeMap?.repo?.git || {},
  }
  const stats = {
    ...(state.validation?.stats || {}),
    ...(state.index?.counts || {}),
    ...(factGraph.stats || {}),
  }
  const nodes = Object.values(factGraph.nodes || {})
  const edges = Object.values(factGraph.edges || {})
  const gapTasks = state.gapQueue?.tasks || []
  const validation = state.validation || { passed: false, score: null, issues: ['validation.json missing'], warnings: [] }
  const verification = state.verification || {}
  const architecture = normalizeArchitecture(state.codeMap?.architecture)
  const routeNodes = nodes.filter(node => node.type === 'route')
  const topFiles = nodes
    .filter(node => node.type === 'file')
    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
    .slice(0, 8)
  const keyEdges = edges
    .filter(edge => ['routes-to', 'calls', 'reads-from', 'writes-to', 'guarded-by', 'dynamic-imports'].includes(edge.predicate))
    .sort((a, b) => edgeRank(b) - edgeRank(a))
    .slice(0, 8)
  const evidenceRefs = state.knowledgeIndex?.evidenceRefs || []
  return {
    schemaVersion: HTML_SCHEMA,
    generatedAt: new Date().toISOString(),
    packageDir,
    repo,
    metrics: {
      files: numberOr(stats.files, state.inventory?.files?.length),
      sourceFiles: numberOr(stats.sourceFiles, stats.sourceFileCount),
      protectedFiles: numberOr(stats.protectedFiles, 0),
      factNodes: numberOr(stats.factNodes, stats.nodeCount, nodes.length),
      factEdges: numberOr(stats.factEdges, stats.edgeCount, edges.length),
      coverageScore: numberOr(stats.coverageScore, factGraph.stats?.coverageScore),
      avgConfidence: numberOr(stats.avgConfidence, factGraph.stats?.avgConfidence),
      renderNodes: numberOr(stats.renderNodes, state.renderGraph?.nodes?.length),
      renderEdges: numberOr(stats.renderEdges, state.renderGraph?.edges?.length),
      knowledgeChunks: numberOr(stats.knowledgeChunks, state.knowledgeIndex?.chunks?.length),
      gapTasks: numberOr(stats.gapTasks, gapTasks.length),
      verifiedEdges: numberOr(stats.verifiedEdges, verification.checkedEdges),
      removedByVerifier: numberOr(stats.removedByVerifier, verification.removedEdges),
    },
    validation,
    verification,
    synthesisState: state.synthesis?.summary
      ? '已写入 L4 综合分析。本页结合结构化综合结果与事实图投影生成。'
      : '尚未写入 L4 综合分析。本页基于现有 harness 产物做确定性可读投影。',
    architecture,
    distributions: {
      nodeTypes: sortedCounts(nodes, node => node.type),
      predicates: sortedCounts(edges, edge => edge.predicate),
      tasks: sortedCounts(gapTasks, task => `${task.status || 'unknown'}:${task.type || 'unknown'}`),
      explorers: sortedCounts(gapTasks, task => task.explorer || 'unknown'),
    },
    topFiles,
    keyEdges,
    routeCount: routeNodes.length,
    openGaps: gapTasks
      .filter(task => task.status === 'open' || task.status === 'dispatched')
      .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority))
      .slice(0, 6),
    evidenceRefs: evidenceRefs.slice(0, 16),
    exploration: state.exploration || {},
  }
}

function normalizeArchitecture(architecture) {
  if (!architecture || !Array.isArray(architecture.components)) {
    return {
      schemaVersion: 'repo-code-map-architecture/v1',
      method: { name: 'missing-architecture' },
      components: [],
      boundaries: [],
      connections: [],
      cards: [],
    }
  }
  return {
    schemaVersion: architecture.schemaVersion,
    method: architecture.method || {},
    components: (architecture.components || []).map(component => ({
      ...component,
      id: String(component.id || component.label || '').trim(),
      type: normalizeType(component.type),
      label: cleanText(displayArchitectureLabel(component)),
      sublabel: cleanText(translateArchitectureSublabel(component.sublabel || '')),
      role: cleanText(component.role || ''),
      confidence: cleanText(component.confidence || 'medium'),
      keyFiles: (component.keyFiles || []).slice(0, 8).map(cleanText),
      evidenceRefs: (component.evidenceRefs || []).slice(0, 10).map(cleanText),
      signals: (component.signals || []).slice(0, 8).map(cleanText),
    })).filter(component => component.id),
    boundaries: (architecture.boundaries || []).map(boundary => ({
      ...boundary,
      id: cleanText(boundary.id || boundary.label || 'boundary'),
      kind: cleanText(boundary.kind || 'region'),
      label: cleanText(translateBoundaryLabel(boundary.label || '边界')),
      wraps: (boundary.wraps || []).map(String),
      rationale: cleanText(boundary.rationale || ''),
      evidenceRefs: (boundary.evidenceRefs || []).slice(0, 8).map(cleanText),
    })),
    connections: (architecture.connections || []).map(connection => ({
      ...connection,
      id: cleanText(connection.id || `${connection.from}-${connection.to}`),
      from: String(connection.from || ''),
      to: String(connection.to || ''),
      label: cleanText(translateConnectionLabel(connection.label || connection.kind || 'link')),
      variant: cleanText(connection.variant || 'default'),
      kind: cleanText(connection.kind || ''),
      confidence: cleanText(connection.confidence || 'medium'),
      evidenceRefs: (connection.evidenceRefs || []).slice(0, 8).map(cleanText),
    })).filter(connection => connection.from && connection.to),
    cards: (architecture.cards || []).map(card => ({
      title: cleanText(card.title || ''),
      items: (card.items || []).slice(0, 5).map(cleanText),
    })),
  }
}

function renderHtml(model) {
  const architectureSvg = renderArchitectureSvg(model.architecture)
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(model.repo.name)} - 仓库理解报告</title>
  <style>
${renderCss()}
  </style>
</head>
<body>
  <header class="topbar">
    <a href="#summary" class="brand">仓库理解</a>
    <nav class="nav" aria-label="页面分区">
      <a href="#architecture">架构</a>
      <a href="#evidence">证据</a>
      <a href="#quality">质量</a>
    </nav>
    <div class="toolbar">
      <button type="button" data-action="theme">主题</button>
      <button type="button" data-action="svg">导出 SVG</button>
    </div>
  </header>
  <main id="summary">
    <section class="hero section-grid">
      <div class="hero-copy">
        <p class="kicker">人类可读层</p>
        <h1>${escapeHtml(model.repo.name)}</h1>
        <p class="lead">${escapeHtml(model.synthesisState)}</p>
        <div class="repo-meta">
          ${metaLine('产物包', model.packageDir)}
          ${metaLine('源码仓库', model.repo.path)}
          ${metaLine('Git', gitSummary(model.repo.git))}
        </div>
      </div>
      <div class="hero-score" aria-label="Harness 状态">
        ${renderScoreBlock('校验', model.validation.passed ? '通过' : '未通过', model.validation.score ?? 'n/a')}
        ${renderScoreBlock('覆盖率', formatPercent(model.metrics.coverageScore), `${model.metrics.factNodes} 个节点`)}
        ${renderScoreBlock('验证器', String(model.metrics.removedByVerifier), `${model.metrics.verifiedEdges} 条已检查`)}
      </div>
    </section>

    <section class="metric-strip" aria-label="产物指标">
      ${metric('文件', model.metrics.files, `${model.metrics.sourceFiles} 个源码文件`)}
      ${metric('事实图', model.metrics.factNodes, `${model.metrics.factEdges} 条关系`)}
      ${metric('渲染图', model.metrics.renderNodes, `${model.metrics.renderEdges} 条边`)}
      ${metric('知识索引', model.metrics.knowledgeChunks, '个片段')}
      ${metric('路由', model.routeCount, '个路由节点')}
      ${metric('缺口', model.metrics.gapTasks, '个任务')}
    </section>

    <section class="section-stack architecture-section" id="architecture">
      <div class="section-head">
        <p class="kicker">架构图</p>
        <h2>语义组件、边界与证据路径。</h2>
        <p>架构图读取 <code>static/code-map.json#architecture</code>，采用本地 SVG 布局渲染。节点分层、边界和连线均来自现有 understanding 产物。</p>
      </div>
      <div class="diagram-panel">
        ${architectureSvg}
      </div>
    </section>

    <section class="analysis-grid">
      ${renderArchitectureSummary(model.architecture)}
      ${renderComponentTable(model.architecture.components)}
    </section>

    <section class="section-stack" id="evidence">
      <div class="section-head">
        <p class="kicker">证据入口</p>
        <h2>优先看最有结构价值的文件和关系。</h2>
        <p>下面只展示高价值样本，完整细节仍在 <code>fact-graph.json</code>、<code>knowledge-index.json</code> 和 <code>wiki/</code> 中。</p>
      </div>
      <div class="evidence-lists">
        ${renderTopFiles(model.topFiles)}
        ${renderKeyEdges(model.keyEdges)}
      </div>
    </section>

    <section class="section-stack" id="quality">
      <div class="section-head">
        <p class="kicker">质量状态</p>
        <h2>哪些已经可信，哪些还要继续补证据。</h2>
        <p>校验、验证器、任务分布和待处理项均直接来自当前 package。</p>
      </div>
      <div class="quality-cards">
        ${renderQuality(model)}
      </div>
    </section>

    <section class="distribution-grid">
      ${distribution('节点类型', model.distributions.nodeTypes.map(([label, count]) => [translateNodeType(label), count]))}
      ${distribution('关系类型', model.distributions.predicates.map(([label, count]) => [translatePredicate(label), count]))}
      ${distribution('缺口任务', model.distributions.tasks.map(([label, count]) => [translateTaskBucket(label), count]))}
      ${distribution('探索器', model.distributions.explorers.map(([label, count]) => [translateExplorer(label), count]))}
    </section>

    <footer class="footer">
      <span>生成时间 ${escapeHtml(model.generatedAt)}</span>
      <span>来源：repo-understanding 产物</span>
    </footer>
  </main>
  <script>
${renderScript()}
  </script>
</body>
</html>
`
}

function renderCss() {
  return `
:root {
  color-scheme: light;
  --paper: #fafaf8;
  --ink: #0a0a0a;
  --muted: #737373;
  --line: #d4d4d2;
  --soft: #f0f0ee;
  --accent: ${DEFAULT_ACCENT};
  --accent-ink: #ffffff;
  --security: #b91c1c;
  --success: #0f766e;
  --warn: #c2410c;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
[data-theme="dark"] {
  color-scheme: dark;
  --paper: #111111;
  --ink: #f5f5f0;
  --muted: #a7a7a2;
  --line: #333330;
  --soft: #1b1b19;
  --accent: #6ea8ff;
  --accent-ink: #08111f;
  --security: #fb7185;
  --success: #5eead4;
  --warn: #fdba74;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  line-height: 1.5;
  overflow-x: hidden;
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size: 64px 64px;
  opacity: .2;
  z-index: -1;
}
a { color: inherit; text-decoration: none; }
code { font-family: var(--mono); font-size: .92em; background: var(--soft); padding: 2px 5px; }
button {
  font: 600 12px var(--mono);
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--line);
  min-height: 36px;
  padding: 0 12px;
  cursor: pointer;
}
button:hover, button:focus-visible { border-color: var(--accent); outline: none; }
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto auto;
  align-items: center;
  gap: 24px;
  min-height: 68px;
  padding: 0 5vw;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--paper) 92%, transparent);
  backdrop-filter: blur(14px);
}
.brand, .nav a, .kicker, .meta-label {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.brand {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav { display: flex; align-items: center; gap: 24px; color: var(--muted); }
.nav a:hover { color: var(--ink); }
.toolbar { display: flex; gap: 8px; flex-shrink: 0; }
main { width: min(1560px, 100%); margin: 0 auto; padding: 56px 5vw 72px; }
.section-grid {
  display: grid;
  grid-template-columns: minmax(0, .92fr) minmax(0, 1.38fr);
  gap: clamp(28px, 4vw, 72px);
  align-items: start;
  padding: 56px 0;
  border-bottom: 1px solid var(--line);
}
.section-grid > *,
.section-stack > *,
.analysis-grid > *,
.quality-grid > *,
.quality-cards > *,
.distribution-grid > *,
.evidence-lists > * {
  min-width: 0;
}
.hero { min-height: calc(100dvh - 156px); align-items: center; }
.hero-copy h1 {
  margin: 18px 0 18px;
  font-size: clamp(56px, 9vw, 156px);
  line-height: .88;
  letter-spacing: 0;
  font-weight: 200;
  max-width: 9ch;
}
.lead {
  margin: 0;
  max-width: 62ch;
  color: var(--muted);
  font-size: clamp(18px, 2vw, 24px);
  overflow-wrap: anywhere;
}
.kicker { color: var(--accent); margin: 0; }
.repo-meta {
  margin-top: 36px;
  display: grid;
  border-top: 1px solid var(--line);
}
.meta-line {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 18px;
  padding: 11px 0;
  border-bottom: 1px solid var(--line);
  min-width: 0;
}
.meta-value {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
}
.hero-score {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid var(--ink);
}
.score-block {
  min-height: 220px;
  display: grid;
  align-content: space-between;
  padding: 20px;
  border-right: 1px solid var(--ink);
}
.score-block:last-child { border-right: 0; }
.score-value {
  font-size: clamp(34px, 4vw, 64px);
  line-height: .9;
  font-weight: 200;
  overflow-wrap: normal;
}
.score-detail, .small-muted { color: var(--muted); font-family: var(--mono); font-size: 12px; }
.metric-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  border: 1px solid var(--line);
  margin: 0 0 48px;
}
.metric {
  padding: 18px;
  border-right: 1px solid var(--line);
  min-width: 0;
}
.metric:last-child { border-right: 0; }
.metric strong {
  display: block;
  font-size: clamp(26px, 3vw, 44px);
  line-height: 1;
  font-weight: 300;
}
.metric span { display: block; margin-top: 10px; color: var(--muted); font-family: var(--mono); font-size: 12px; }
.section-head h2 {
  margin: 16px 0 16px;
  font-size: clamp(28px, 3.4vw, 52px);
  line-height: 1;
  font-weight: 240;
  letter-spacing: 0;
}
.section-head p:not(.kicker) { color: var(--muted); max-width: 62ch; overflow-wrap: anywhere; }
.section-stack {
  display: grid;
  gap: 24px;
  padding: 52px 0;
  border-bottom: 1px solid var(--line);
}
.section-stack .section-head { max-width: 920px; }
.architecture-section { padding-top: 64px; }
.architecture-section .section-head { max-width: 1040px; }
.diagram-panel {
  overflow: auto;
  max-width: 100%;
  border: 1px solid var(--ink);
  background: var(--paper);
}
.architecture-svg { display: block; width: 100%; min-width: 0; height: auto; }
.svg-bg { fill: var(--paper); }
.boundary-region { fill: none; stroke: var(--accent); stroke-width: 1.2; stroke-dasharray: 7 6; opacity: .7; }
.boundary-security-group { fill: none; stroke: var(--security); stroke-width: 1.2; stroke-dasharray: 4 5; opacity: .85; }
.boundary-label { fill: var(--muted); font-family: var(--mono); font-size: 12px; font-weight: 600; text-transform: uppercase; }
.edge-default { stroke: var(--muted); }
.edge-emphasis { stroke: var(--accent); }
.edge-security { stroke: var(--security); stroke-dasharray: 6 5; }
.edge-dashed { stroke: var(--muted); stroke-dasharray: 5 5; }
.edge-label-bg { fill: var(--paper); stroke: var(--line); }
.edge-label { fill: var(--muted); font-family: var(--mono); font-size: 12px; }
.node-mask { fill: var(--paper); }
.node-box { stroke-width: 1.4; }
.node-frontend { fill: color-mix(in srgb, var(--accent) 10%, var(--paper)); stroke: var(--accent); }
.node-backend { fill: color-mix(in srgb, var(--ink) 7%, var(--paper)); stroke: var(--ink); }
.node-database { fill: color-mix(in srgb, var(--success) 12%, var(--paper)); stroke: var(--success); }
.node-cloud { fill: var(--soft); stroke: var(--muted); }
.node-security { fill: color-mix(in srgb, var(--security) 12%, var(--paper)); stroke: var(--security); }
.node-messagebus { fill: color-mix(in srgb, var(--warn) 12%, var(--paper)); stroke: var(--warn); }
.node-external { fill: var(--paper); stroke: var(--muted); }
.node-title { fill: var(--ink); font-family: var(--sans); font-size: 16px; font-weight: 650; }
.node-subtitle { fill: var(--muted); font-family: var(--mono); font-size: 12px; }
.analysis-grid, .quality-grid, .distribution-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
  align-items: start;
  padding: 56px 0;
  border-bottom: 1px solid var(--line);
}
.quality-grid { grid-template-columns: minmax(0, .85fr) repeat(2, minmax(0, 1fr)); }
.quality-cards {
  display: grid;
  grid-template-columns: minmax(0, .72fr) minmax(0, .72fr) minmax(0, 1.56fr);
  gap: 24px;
  align-items: start;
}
.panel {
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--paper) 86%, var(--soft));
  padding: 20px;
  min-width: 0;
}
.panel h3 { margin: 0 0 14px; font-size: 21px; font-weight: 450; }
.panel-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.panel-list li, .data-row {
  display: grid;
  grid-template-columns: minmax(0, .74fr) minmax(0, 1fr);
  gap: 18px;
  padding: 9px 0;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.data-row:first-child, .panel-list li:first-child { border-top: 0; }
.label { font-weight: 650; min-width: 0; overflow-wrap: anywhere; }
.value { color: var(--muted); min-width: 0; overflow-wrap: anywhere; }
.component-table { grid-column: span 1; }
.component-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 18px;
  padding: 14px 0;
  border-top: 1px solid var(--line);
}
.type-pill {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  min-height: 26px;
  padding: 0 8px;
  border: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
}
.files { margin-top: 8px; color: var(--muted); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.evidence-lists {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
  align-items: start;
}
.rank-list { display: grid; gap: 0; }
.rank-item {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 14px;
  padding: 10px 0;
  border-top: 1px solid var(--line);
}
.rank { font-family: var(--mono); color: var(--accent); font-weight: 700; }
.rank-item .label { font-size: 15px; line-height: 1.35; }
.rank-item .value { display: inline-block; margin-top: 3px; font-size: 14px; line-height: 1.42; }
.footer {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding-top: 28px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
}
@media (max-width: 980px) {
  .topbar { grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 0 24px; }
  .brand { font-size: 11px; letter-spacing: .06em; }
  .nav { display: none; }
  .toolbar { gap: 6px; }
  .toolbar button { padding: 0 9px; min-width: 48px; }
  .architecture-svg { min-width: 1100px; }
  main { padding-top: 32px; }
  .section-grid, .analysis-grid, .quality-grid, .quality-cards, .distribution-grid, .evidence-lists { grid-template-columns: 1fr; }
  .section-stack { padding: 40px 0; }
  .hero { min-height: auto; }
  .hero-copy h1 { max-width: 100%; font-size: clamp(46px, 16vw, 92px); }
  .hero-score, .metric-strip { grid-template-columns: 1fr; }
  .score-block, .metric { border-right: 0; border-bottom: 1px solid var(--line); min-height: 140px; }
  .score-block:last-child, .metric:last-child { border-bottom: 0; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  * { transition: none !important; animation: none !important; }
}`
}

function renderArchitectureSvg(architecture) {
  if (!architecture.components.length) {
    return `<div class="empty">未在 <code>static/code-map.json</code> 中找到架构段。</div>`
  }
  const layout = layoutArchitecture(architecture)
  const defs = `<defs>
    <marker id="arrow-default" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)"></path></marker>
    <marker id="arrow-emphasis" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)"></path></marker>
    <marker id="arrow-security" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--security)"></path></marker>
  </defs>`
  return `<svg id="architecture-svg" class="architecture-svg" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="architecture-title architecture-desc">
    <title id="architecture-title">仓库架构图</title>
    <desc id="architecture-desc">基于 repo-understanding code-map architecture 数据生成的语义架构图。</desc>
    ${defs}
    <rect class="svg-bg" x="0" y="0" width="${layout.width}" height="${layout.height}"></rect>
    ${layout.boundaries.map(renderBoundary).join('\n')}
    ${layout.connections.map(renderSvgConnection).join('\n')}
    ${layout.nodes.map(renderSvgNode).join('\n')}
  </svg>`
}

function layoutArchitecture(architecture) {
  const width = 1500
  const nodeWidth = 230
  const nodeHeight = 88
  const lanes = new Map([
    ['repo', { x: 80, centerY: 340, nodes: [] }],
    ['source', { x: 410, centerY: 250, nodes: [] }],
    ['support', { x: 770, centerY: 250, nodes: [] }],
    ['external', { x: 1135, centerY: 335, nodes: [] }],
  ])
  const repoNode = architecture.components.find(component => component.id === 'repo-runtime') || architecture.components[0]
  for (const component of architecture.components) {
    if (component.id === repoNode.id) lanes.get('repo').nodes.push(component)
    else if (component.type === 'external') lanes.get('external').nodes.push(component)
    else if (['security', 'cloud', 'database', 'messagebus'].includes(component.type)) lanes.get('support').nodes.push(component)
    else lanes.get('source').nodes.push(component)
  }
  const positions = new Map()
  for (const lane of lanes.values()) {
    const count = lane.nodes.length
    const step = 136
    const startY = count > 1 ? Math.max(118, lane.centerY - ((count - 1) * step) / 2) : lane.centerY - nodeHeight / 2
    lane.nodes.forEach((component, index) => {
      positions.set(component.id, {
        id: component.id,
        x: lane.x,
        y: startY + index * step,
        width: nodeWidth,
        height: nodeHeight,
        component,
      })
    })
  }
  const maxY = Math.max(...[...positions.values()].map(pos => pos.y + pos.height), 430)
  const height = Math.max(640, maxY + 104)
  const boundaries = (architecture.boundaries || [])
    .map(boundary => layoutBoundary(boundary, positions, width, height))
    .filter(Boolean)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))
  const rawConnections = (architecture.connections || [])
    .filter(connection => positions.has(connection.from) && positions.has(connection.to))
  const outgoingTotals = countBy(rawConnections, connection => connection.from)
  const incomingTotals = countBy(rawConnections, connection => connection.to)
  const outgoingSeen = new Map()
  const incomingSeen = new Map()
  const connections = rawConnections
    .map((connection, index) => {
      const outgoingIndex = outgoingSeen.get(connection.from) || 0
      const incomingIndex = incomingSeen.get(connection.to) || 0
      outgoingSeen.set(connection.from, outgoingIndex + 1)
      incomingSeen.set(connection.to, incomingIndex + 1)
      return layoutConnection(connection, positions, {
        index,
        outgoingIndex,
        outgoingTotal: outgoingTotals.get(connection.from) || 1,
        incomingIndex,
        incomingTotal: incomingTotals.get(connection.to) || 1,
      })
    })
    .filter(Boolean)
  return { width, height, nodes: [...positions.values()], boundaries, connections }
}

function layoutBoundary(boundary, positions, width, height) {
  const wrapped = (boundary.wraps || []).map(id => positions.get(id)).filter(Boolean)
  if (!wrapped.length) return null
  const minX = Math.max(40, Math.min(...wrapped.map(pos => pos.x)) - 48)
  const minY = Math.max(72, Math.min(...wrapped.map(pos => pos.y)) - 62)
  const maxX = Math.min(width - 40, Math.max(...wrapped.map(pos => pos.x + pos.width)) + 48)
  const maxY = Math.min(height - 40, Math.max(...wrapped.map(pos => pos.y + pos.height)) + 42)
  return {
    ...boundary,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function layoutConnection(connection, positions, port) {
  const from = positions.get(connection.from)
  const to = positions.get(connection.to)
  if (!from || !to) return null
  const x1 = from.x + from.width
  const y1 = from.y + 24 + (from.height - 48) * ((port.outgoingIndex + 1) / (port.outgoingTotal + 1))
  const x2 = to.x
  const y2 = to.y + 24 + (to.height - 48) * ((port.incomingIndex + 1) / (port.incomingTotal + 1))
  const pathValue = x2 > x1
    ? forwardConnectionPath(connection, from, to, x1, y1, x2, y2, port)
    : reverseConnectionPath(from, to)
  const showLabel = shouldShowConnectionLabel(connection)
  const labelWidth = showLabel ? Math.max(68, measureSvgText(connection.label) + 24) : 0
  const labelX = x2 > x1
    ? Math.max(x1 + labelWidth / 2 + 28, x2 - 88)
    : from.x + from.width / 2
  const labelOffset = (port.incomingIndex - ((port.incomingTotal - 1) / 2)) * 18
  return {
    ...connection,
    pathValue,
    labelX,
    labelY: y2 + labelOffset,
    labelWidth,
    showLabel,
  }
}

function forwardConnectionPath(connection, from, to, x1, y1, x2, y2, port) {
  if (to.component.type === 'external') {
    const channelOffset = (port.incomingIndex - ((port.incomingTotal - 1) / 2)) * 24
    const channelY = to.y > 390 ? Math.min(590, to.y + to.height + 44 + channelOffset) : 294
    return channelConnectionPath(x1, y1, x2, y2, channelY, 74, 86)
  }
  if (['security', 'cloud', 'database', 'messagebus'].includes(to.component.type)) {
    const channelY = to.y > from.y ? to.y + to.height + 34 : Math.max(112, to.y - 30)
    return channelConnectionPath(x1, y1, x2, y2, channelY, 58, 64)
  }
  const gap = Math.max(1, x2 - x1)
  const bend = Math.max(96, Math.min(210, gap * 0.48))
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

function channelConnectionPath(x1, y1, x2, y2, channelY, outGap, inGap) {
  const outX = x1 + outGap
  const inX = x2 - inGap
  const leadOut = outX + 26
  const leadIn = inX - 26
  return [
    `M ${x1} ${y1}`,
    `C ${outX} ${y1}, ${outX} ${channelY}, ${leadOut} ${channelY}`,
    `L ${leadIn} ${channelY}`,
    `C ${inX} ${channelY}, ${inX} ${y2}, ${x2} ${y2}`,
  ].join(' ')
}

function reverseConnectionPath(from, to) {
  const x1 = from.x + from.width / 2
  const y1 = from.y
  const x2 = to.x + to.width / 2
  const y2 = to.y
  const channelY = Math.min(y1, y2) - 70
  return `M ${x1} ${y1} C ${x1} ${channelY}, ${x2} ${channelY}, ${x2} ${y2}`
}

function renderBoundary(boundary) {
  const cls = boundary.kind === 'security-group' ? 'boundary-security-group' : 'boundary-region'
  return `<g>
    <rect class="${cls}" x="${boundary.x}" y="${boundary.y}" width="${boundary.width}" height="${boundary.height}"></rect>
    <text class="boundary-label" x="${boundary.x + 12}" y="${boundary.y + 20}">${escapeSvg(boundary.label)}</text>
  </g>`
}

function renderSvgConnection(connection) {
  const variant = ['emphasis', 'security', 'dashed'].includes(connection.variant) ? connection.variant : 'default'
  const marker = variant === 'security' ? 'arrow-security' : variant === 'emphasis' ? 'arrow-emphasis' : 'arrow-default'
  const label = connection.showLabel && connection.label ? `<g>
    <rect class="edge-label-bg" x="${connection.labelX - connection.labelWidth / 2}" y="${connection.labelY - 15}" width="${connection.labelWidth}" height="23"></rect>
    <text class="edge-label" x="${connection.labelX}" y="${connection.labelY + 2}" text-anchor="middle">${escapeSvg(connection.label)}</text>
  </g>` : ''
  return `<g>
    <path class="edge-${variant}" d="${connection.pathValue}" fill="none" stroke-width="1.6" marker-end="url(#${marker})"></path>
    ${label}
  </g>`
}

function renderSvgNode(node) {
  const component = node.component
  const lines = wrapSvgText(component.label, 16).slice(0, 2)
  const subtitle = wrapSvgText(component.sublabel || component.confidence, 28).slice(0, 1)
  const titleY = node.y + (lines.length > 1 ? 34 : 43)
  return `<g tabindex="0" aria-label="${escapeHtml(component.label)}">
    <rect class="node-mask" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}"></rect>
    <rect class="node-box node-${component.type}" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}"></rect>
    ${lines.map((line, index) => `<text class="node-title" x="${node.x + node.width / 2}" y="${titleY + index * 18}" text-anchor="middle">${escapeSvg(line)}</text>`).join('')}
    ${subtitle.map((line, index) => `<text class="node-subtitle" x="${node.x + node.width / 2}" y="${node.y + node.height - 18 + index * 12}" text-anchor="middle">${escapeSvg(line)}</text>`).join('')}
  </g>`
}

function renderArchitectureSummary(architecture) {
  const cards = architecture.cards.length ? architecture.cards : [{
    title: '架构模型',
    items: [
      `${architecture.components.length} 个组件`,
      `${architecture.connections.length} 条连接`,
      `${architecture.boundaries.length} 个边界`,
    ],
  }]
  return `<section class="panel">
    <h3>架构摘要</h3>
    <ul class="panel-list">
      ${cards.map(card => `<li><span class="label">${escapeHtml(translateCardTitle(card.title))}</span><span class="value">${escapeHtml(card.items.map(translateCardItem).join(' / '))}</span></li>`).join('')}
      <li><span class="label">生成方法</span><span class="value">${escapeHtml(architecture.method?.name || 'architecture projection')}</span></li>
    </ul>
  </section>`
}

function renderComponentTable(components) {
  return `<section class="panel component-table">
    <h3>组件</h3>
    ${components.slice(0, 12).map(component => `<div class="component-row">
      <span><span class="type-pill">${escapeHtml(translateNodeType(component.type))}</span></span>
      <span>
        <strong class="label">${escapeHtml(component.label)}</strong>
        <span class="value">：${escapeHtml(translateRole(component.role || component.sublabel || component.confidence))}</span>
        ${component.keyFiles?.length ? `<div class="files">${escapeHtml(component.keyFiles.slice(0, 4).join(' / '))}</div>` : ''}
      </span>
    </div>`).join('')}
  </section>`
}

function renderTopFiles(files) {
  return `<section class="panel">
    <h3>高价值文件</h3>
    <div class="rank-list">
      ${files.map((file, index) => `<div class="rank-item">
        <span class="rank">${String(index + 1).padStart(2, '0')}</span>
        <span><strong class="label">${escapeHtml(file.path || file.label)}</strong><br><span class="value">${escapeHtml(file.lang || file.metadata?.language || translateNodeType(file.type))} / 重要度 ${formatNumber(file.importance)}</span></span>
      </div>`).join('') || emptyText('未发现文件节点。')}
    </div>
  </section>`
}

function renderKeyEdges(edges) {
  return `<section class="panel">
    <h3>关键关系</h3>
    <div class="rank-list">
      ${edges.map((edge, index) => `<div class="rank-item">
        <span class="rank">${String(index + 1).padStart(2, '0')}</span>
        <span><strong class="label">${escapeHtml(translatePredicate(edge.predicate))}</strong><br><span class="value">${escapeHtml(formatEdgeSummary(edge))}</span></span>
      </div>`).join('') || emptyText('未发现关键关系。')}
    </div>
  </section>`
}

function renderQuality(model) {
  const validationItems = [
    ['状态', model.validation.passed ? '通过' : '未通过'],
    ['分数', model.validation.score ?? 'n/a'],
    ['问题', (model.validation.issues || []).length],
    ['警告', (model.validation.warnings || []).length],
  ]
  const verifierItems = [
    ['已检查', model.verification.checkedEdges ?? model.metrics.verifiedEdges],
    ['已确认', model.verification.confirmedEdges ?? 'n/a'],
    ['已移除', model.verification.removedEdges ?? model.metrics.removedByVerifier],
    ['跳过', model.verification.skippedEdges ?? 'n/a'],
  ]
  return `${miniPanel('校验', validationItems)}
    ${miniPanel('验证器', verifierItems)}
    <section class="panel">
      <h3>待处理项</h3>
      <div class="rank-list">
        ${model.openGaps.map((task, index) => `<div class="rank-item">
          <span class="rank">${String(index + 1).padStart(2, '0')}</span>
          <span><strong class="label">${escapeHtml(translateTaskType(task.type || 'task'))}</strong><br><span class="value">${escapeHtml(formatTaskReason(task.reason || ''))}</span></span>
        </div>`).join('') || emptyText('没有 open 或 dispatched 状态的缺口任务。')}
      </div>
    </section>`
}

function distribution(title, rows) {
  return `<section class="panel">
    <h3>${escapeHtml(title)}</h3>
    ${rows.slice(0, 10).map(([label, count]) => `<div class="data-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(count)}</span></div>`).join('') || emptyText('暂无数据。')}
  </section>`
}

function miniPanel(title, items) {
  return `<section class="panel">
    <h3>${escapeHtml(title)}</h3>
    ${items.map(([label, value]) => `<div class="data-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`).join('')}
  </section>`
}

function renderScript() {
  return `
const root = document.documentElement;
const storedTheme = localStorage.getItem('repo-readable-theme');
if (storedTheme) root.setAttribute('data-theme', storedTheme);
document.querySelector('[data-action="theme"]').addEventListener('click', () => {
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  localStorage.setItem('repo-readable-theme', next);
});
document.querySelector('[data-action="svg"]').addEventListener('click', () => {
  const svg = document.getElementById('architecture-svg');
  if (!svg) return;
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const source = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'architecture.svg';
  link.click();
  URL.revokeObjectURL(url);
});`
}

function renderScoreBlock(label, value, detail) {
  return `<div class="score-block"><span class="meta-label">${escapeHtml(label)}</span><strong class="score-value">${escapeHtml(value)}</strong><span class="score-detail">${escapeHtml(detail)}</span></div>`
}

function metric(label, value, detail) {
  return `<div class="metric"><strong>${escapeHtml(value ?? 'n/a')}</strong><span>${escapeHtml(label)} / ${escapeHtml(detail || '')}</span></div>`
}

function metaLine(label, value) {
  return `<div class="meta-line"><span class="meta-label">${escapeHtml(label)}</span><span class="meta-value">${escapeHtml(value || 'n/a')}</span></div>`
}

function emptyText(value) {
  return `<p class="small-muted">${escapeHtml(value)}</p>`
}

function gitSummary(git) {
  if (!git) return 'n/a'
  return [git.branch, git.head, git.remote].filter(Boolean).join(' / ') || 'n/a'
}

function countBy(values, keyFn) {
  const counts = new Map()
  for (const value of values || []) {
    const key = keyFn(value)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

function shouldShowConnectionLabel(connection) {
  return connection.variant === 'security'
    || connection.variant === 'dashed'
    || ['权限', '使用', '导入', '声明', '入口'].includes(connection.label)
}

function measureSvgText(value) {
  return String(value || '')
    .split('')
    .reduce((width, char) => width + (/[\u4e00-\u9fff]/.test(char) ? 13 : 7), 0)
}

function formatEdgeSummary(edge) {
  const subject = compactGraphRef(edge.subject)
  const object = compactGraphRef(edge.object)
  const evidence = edge.evidence?.[0]
  const evidenceText = evidence?.file ? `证据 ${evidence.file}${evidence.line ? `:${evidence.line}` : ''}` : '无证据片段'
  return `${subject} -> ${object} / ${evidenceText}`
}

function compactGraphRef(value) {
  return String(value || '')
    .replace(/^file:/, '')
    .replace(/^service:/, '')
    .replace(/^route:/, '')
    .replace(/^package:/, '')
    .replace(/^config:/, '')
    .replace(/src-/g, 'src/')
    .replace(/-index-ts/g, '/index.ts')
}

function formatTaskReason(reason) {
  const value = cleanText(reason)
  const coverage = value.match(/^(.+) has no non-containment facts after L1 scan\.$/)
  if (coverage) return `L1 扫描后，${coverage[1]} 缺少非包含关系事实。`
  const unresolved = value.match(/^Import target (.+) from (.+) did not resolve/)
  if (unresolved) return `${unresolved[2]} 的导入目标 ${unresolved[1]} 未解析。`
  return value
}

function translateCardTitle(value) {
  const map = {
    'Semantic Map': '语义地图',
    'Evidence Base': '证据基础',
    'Safety Boundary': '安全边界',
  }
  return map[value] || value
}

function translateCardItem(value) {
  return String(value || '')
    .replace(/components grouped by role/g, '个按职责聚合的组件')
    .replace(/sparse architecture connections/g, '条稀疏架构连接')
    .replace(/static entrypoint signals/g, '个静态入口信号')
    .replace(/manifests/g, '个 manifest')
    .replace(/extracted symbols/g, '个抽取符号')
    .replace(/code-map relationships/g, '条 code-map 关系')
    .replace(/protected files kept metadata-only/g, '个 protected 文件仅保留元数据')
    .replace(/Architecture and graph data store paths, hashes, and evidence refs, not protected content/g, '架构图和事实图只存路径、hash 与 evidence refs，不存 protected 内容')
}

function translateArchitectureSublabel(value) {
  return String(value || '')
    .replace(/source-like files/g, '个源码候选文件')
    .replace(/config files/g, '个配置文件')
    .replace(/security-related files/g, '个安全相关文件')
    .replace(/declared packages/g, '个声明依赖')
    .replace(/Binary Resource/g, '二进制资源')
    .replace(/Text/g, '文本')
}

function translateBoundaryLabel(value) {
  const raw = String(value || '')
  const repo = raw.match(/^Repository:\s*(.+)$/)
  if (repo) return `仓库：${repo[1]}`
  const map = {
    'Source + Runtime Wiring': '源码与运行时编排',
    'Security-sensitive Surface': '安全敏感面',
  }
  return map[raw] || raw
}

function translateRole(value) {
  return String(value || '')
    .replace('Repository runtime surface inferred from manifests, entrypoints, and file mix.', '由 manifest、入口和文件结构推断出的仓库运行面。')
    .replace('Source-area component grouped from directory inventory.', '从目录清单聚合出的源码区域。')
    .replace('Runtime configuration, framework wiring, and deployment metadata.', '运行配置、框架 wiring 与部署元数据。')
    .replace('Authentication, authorization, signing, permission, or credential-adjacent code.', '认证、授权、签名、权限或凭据相邻代码。')
    .replace('Declared external dependency surface.', 'manifest 中声明的外部依赖面。')
    .replace('Third-party libraries and external integration surface inferred from manifests.', '从 manifest 推断出的第三方库和外部集成面。')
}

function translateConnectionLabel(value) {
  const map = {
    'ui/source': 'UI / 源码',
    source: '源码',
    configures: '配置',
    guards: '权限',
    uses: '使用',
    imports: '导入',
    declares: '声明',
    link: '关联',
    entrypoint: '入口',
  }
  return map[String(value || '')] || value
}

function translateNodeType(value) {
  const map = {
    frontend: '前端',
    backend: '后端',
    database: '数据',
    cloud: '配置',
    security: '安全',
    messagebus: '消息',
    external: '外部',
    file: '文件',
    module: '模块',
    symbol: '符号',
    route: '路由',
    package: '依赖包',
    service: '服务',
    config: '配置',
    datastore: '数据源',
  }
  return map[String(value || '').toLowerCase()] || value
}

function translatePredicate(value) {
  return PREDICATES[String(value || '')]?.zhLabel || value
}

function translateTaskType(value) {
  const map = {
    'coverage-gap': '覆盖缺口',
    'low-confidence-fact': '低置信事实',
    'unresolved-import': '未解析导入',
    'semantic-hint': '语义线索',
    'open-question': '开放问题',
    task: '任务',
  }
  return map[String(value || '')] || value
}

function translateTaskBucket(value) {
  const [status, type] = String(value || '').split(':')
  return `${translateStatus(status)}:${translateTaskType(type)}`
}

function translateStatus(value) {
  const map = {
    open: '待处理',
    dispatched: '已派发',
    done: '完成',
    skipped: '跳过',
    unknown: '未知',
  }
  return map[String(value || '')] || value
}

function translateExplorer(value) {
  return EXPLORERS[String(value || '')]?.label || value
}

function edgeRank(edge) {
  return Number(edge.confidence || 0) + Number(edge.importance || 0) + (edge.evidence?.length || 0) * 0.05
}

function priorityRank(priority) {
  return { low: 1, medium: 2, high: 3, critical: 4 }[priority] || 0
}

function normalizeType(type) {
  const value = String(type || 'backend').toLowerCase()
  return ['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external'].includes(value) ? value : 'backend'
}

function displayArchitectureLabel(component) {
  const id = String(component.id || '')
  const dependencySignal = id.match(/^dependency-signal-(.+)$/)
  if (id === 'repo-runtime') return component.label || component.id || '仓库运行面'
  if (id === 'source-src') return '源码目录 src'
  if (id === 'source-public') return '静态资源 public'
  if (id === 'configuration') return '配置'
  if (id === 'security-auth') return '权限 / 认证'
  if (id === 'dependency-signal-external') return '外部依赖信号'
  if (dependencySignal) return `${titleCase(dependencySignal[1])} 依赖信号`
  if (id === 'external-dependencies') return '第三方库'
  return component.label || component.id || '组件'
}

function titleCase(value) {
  return String(value || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ')
}

function sortedCounts(values, keyFn) {
  const counts = new Map()
  for (const value of values || []) {
    const key = cleanText(keyFn(value) || 'unknown')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function wrapSvgText(value, limit) {
  const text = cleanText(value)
  if (text.length <= limit) return [text]
  const words = text.split(/([\s/_-]+)/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    if ((current + word).length > limit && current) {
      lines.push(current.trim())
      current = word
    } else {
      current += word
    }
  }
  if (current.trim()) lines.push(current.trim())
  return lines.length ? lines : [text.slice(0, limit)]
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2022/g, '*')
    .trim()
}

function formatPercent(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 'n/a'
  return `${Math.round(num * 1000) / 10}%`
}

function formatNumber(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 'n/a'
  return String(Math.round(num * 1000) / 1000)
}

function numberOr(...values) {
  for (const value of values) {
    const num = Number(value)
    if (Number.isFinite(num)) return num
  }
  return 0
}

function escapeHtml(value) {
  return cleanText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeSvg(value) {
  return escapeHtml(value)
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
