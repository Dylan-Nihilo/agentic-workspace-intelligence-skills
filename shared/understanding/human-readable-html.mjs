import fs from 'node:fs'
import path from 'node:path'
import { EXPLORERS, PREDICATES } from './harness-registry.mjs'

const HTML_SCHEMA = 'repo-human-readable-html/v1'
const DEFAULT_ACCENT = '#002FA7'

export function generateHumanReadableHtml(options) {
  const packageDir = path.resolve(options.packageDir)
  const outFile = path.resolve(options.outFile || path.join(packageDir, 'human-readable.html'))
  const state = readPackage(packageDir)
  if (!state.synthesis) {
    console.error('warning: synthesis missing, page will use data-derived fallback')
  }
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
  const topFiles = nodes
    .filter(node => node.type === 'file')
    .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
    .slice(0, 8)
  const keyEdges = edges
    .filter(edge => ['routes-to', 'calls', 'reads-from', 'writes-to', 'guarded-by', 'dynamic-imports'].includes(edge.predicate))
    .sort((a, b) => edgeRank(b) - edgeRank(a))
    .slice(0, 8)
  const evidenceRefs = state.knowledgeIndex?.evidenceRefs || []
  const dependencies = state.codeMap?.dependencies || []
  const domains = enrichDomains(buildRouteDomains(nodes, edges, state.synthesis?.businessDomains), nodes, edges)
  const routeCount = domains.reduce((sum, domain) => sum + domain.count, 0)
  const techStack = buildTechStack(dependencies)
  const moduleGraph = buildModuleGraph(nodes, edges)
  const entryPoints = buildEntryPoints(state, nodes, edges)
  const sharedModules = buildSharedModules(nodes, edges)
  const dataFetchExamples = buildDataFetchExamples(nodes, edges)
  const synthesisSummary = cleanText(state.synthesis?.summary || '')
  const identity = buildIdentity(repo, techStack, routeCount, domains.length, state.codeMap?.manifests?.[0])
  const sourceFiles = numberOr(stats.sourceFiles, stats.sourceFileCount)
  const coverageScore = numberOr(stats.coverageScore, factGraph.stats?.coverageScore)
  return {
    schemaVersion: HTML_SCHEMA,
    generatedAt: new Date().toISOString(),
    packageDir,
    repo,
    metrics: {
      files: numberOr(stats.files, state.inventory?.files?.length),
      sourceFiles,
      protectedFiles: numberOr(stats.protectedFiles, 0),
      factNodes: numberOr(stats.factNodes, stats.nodeCount, nodes.length),
      factEdges: numberOr(stats.factEdges, stats.edgeCount, edges.length),
      coverageScore,
      coveredSourceFiles: Math.round(sourceFiles * coverageScore),
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
    identity,
    synthesisSummary,
    synthesisState: synthesisSummary || identity,
    synthesis: state.synthesis || null,
    architecture,
    domains,
    moduleGraph,
    techStack,
    entryPoints,
    sharedModules,
    dataFetchExamples,
    distributions: {
      nodeTypes: sortedCounts(nodes, node => node.type),
      predicates: sortedCounts(edges, edge => edge.predicate),
      tasks: sortedCounts(gapTasks, task => `${task.status || 'unknown'}:${task.type || 'unknown'}`),
      explorers: sortedCounts(gapTasks, task => task.explorer || 'unknown'),
    },
    topFiles,
    keyEdges,
    routeCount,
    openGaps: gapTasks
      .filter(task => task.status === 'open' || task.status === 'dispatched')
      .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority))
      .slice(0, 6),
    evidenceRefs: evidenceRefs.slice(0, 16),
    exploration: state.exploration || {},
  }
}

function buildIdentity(repo, techStack, routeCount, domainCount, manifest) {
  const stack = techStack.badges.length ? techStack.badges.join(' + ') : '前端'
  const scripts = manifest?.scripts?.build ? '，构建脚本为 Vite production build' : ''
  return `${repo.name}: ${stack} 移动端应用，${routeCount} 个页面跨 ${domainCount} 个业务域${scripts}。`
}

// 顶层路径段 -> agent authored 业务域（来自 synthesis.businessDomains）
function buildSegToBusiness(businessDomains) {
  const map = new Map()
  for (const domain of businessDomains || []) {
    for (const prefix of domain.prefixes || []) {
      map.set(String(prefix).replace(/^\//, ''), { name: domain.name, description: domain.description || '' })
    }
  }
  return map
}

function buildRouteDomains(nodes, edges, businessDomains = null) {
  const nodeById = indexById(nodes)
  const segToBusiness = buildSegToBusiness(businessDomains)
  const routeEdges = edges
    .filter(edge => edge.predicate === 'routes-to')
    .map(edge => ({
      edge,
      routeNode: nodeById.get(edge.subject),
      routerNode: nodeById.get(edge.object),
      evidence: edge.evidence?.[0] || {},
    }))
    .filter(item => item.routeNode?.label && /^src\/router\//.test(item.routerNode?.path || ''))

  const routesByRouter = new Map()
  for (const item of routeEdges) {
    const routerFile = item.routerNode.path
    if (!routesByRouter.has(routerFile)) routesByRouter.set(routerFile, [])
    routesByRouter.get(routerFile).push(item)
  }
  for (const routes of routesByRouter.values()) {
    routes.sort((a, b) => numberOr(a.evidence.line) - numberOr(b.evidence.line))
  }

  const dynamicByRouter = new Map()
  for (const edge of edges.filter(edge => edge.predicate === 'dynamic-imports')) {
    const routerPath = nodeById.get(edge.subject)?.path
    const viewPath = nodeById.get(edge.object)?.path
    if (!/^src\/router\//.test(routerPath || '') || !viewPath) continue
    if (!dynamicByRouter.has(routerPath)) dynamicByRouter.set(routerPath, [])
    dynamicByRouter.get(routerPath).push({
      view: viewPath,
      line: numberOr(edge.evidence?.[0]?.line),
      evidence: edge.evidence?.[0] || {},
    })
  }
  for (const imports of dynamicByRouter.values()) {
    imports.sort((a, b) => a.line - b.line)
  }

  // 分组键：优先按 agent authored 业务域（跨 router 文件）；无 businessDomains 时回退到 router 文件名
  const groups = new Map()
  for (const [routerFile, routes] of routesByRouter.entries()) {
    const routerName = path.basename(routerFile, path.extname(routerFile))
    routes.forEach((item, index) => {
      const line = numberOr(item.evidence.line)
      const nextRawLine = Number(routes[index + 1]?.evidence?.line)
      const nextLine = Number.isFinite(nextRawLine) ? nextRawLine : Number.POSITIVE_INFINITY
      const view = matchDynamicImport(dynamicByRouter.get(routerFile) || [], line, nextLine)
      const label = item.routeNode.label
      const topSeg = String(label).split('/').filter(Boolean)[0] || ''
      const business = segToBusiness.get(topSeg)
      const key = business ? business.name : routerName
      if (!groups.has(key)) {
        groups.set(key, {
          domain: key,
          description: business?.description || '',
          byBusiness: Boolean(business),
          routers: new Set(),
          count: 0,
          screens: [],
        })
      }
      const group = groups.get(key)
      group.routers.add(routerName)
      group.count += 1
      group.screens.push({
        path: label,
        line,
        comment: extractRouteComment(item.evidence.snippet),
        view: view?.view || '',
        lazy: Boolean(view),
      })
    })
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      routerFile: group.byBusiness ? `${group.routers.size} 个路由文件` : [...group.routers][0] || '',
      routers: undefined,
      screens: group.screens.sort((a, b) => a.line - b.line),
    }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
}

function matchDynamicImport(imports, routeLine, nextRouteLine) {
  return imports.find(item => item.line >= routeLine && item.line < nextRouteLine) || null
}

function extractRouteComment(snippet) {
  const text = String(snippet || '')
  const inline = text.match(/path:\s*["'][^"']+["']\s*,?\s*\/\/\s*([^\n]+)/)
  if (inline?.[1]) return cleanText(inline[1])
  for (const line of text.split('\n')) {
    const comment = line.match(/\/\/\s*(.+)$/)?.[1]
    if (!comment) continue
    const cleaned = cleanText(comment)
    if (!cleaned || /^[{}[\],]+$/.test(cleaned)) continue
    if (/^(path|name|component|redirect)\b/.test(cleaned)) continue
    return cleaned
  }
  return ''
}

function buildTechStack(dependencies) {
  const deps = (dependencies || [])
    .map(dep => ({
      name: cleanText(dep.name),
      version: cleanText(dep.version || ''),
      scope: cleanText(dep.scope || 'runtime'),
      group: classifyDependency(dep.name, dep.scope),
    }))
    .filter(dep => dep.name)
  const badgeNames = ['vue', 'vue-router', 'pinia', 'axios', 'vant']
  return {
    badges: badgeNames.filter(name => deps.some(dep => dep.name === name)),
    groups: [
      ['框架 / 状态', deps.filter(dep => dep.group === 'framework')],
      ['UI / 移动端', deps.filter(dep => dep.group === 'ui')],
      ['HTTP / 集成', deps.filter(dep => dep.group === 'integration')],
      ['文档 / 二维码 / 截图', deps.filter(dep => dep.group === 'document')],
      ['构建工具', deps.filter(dep => dep.group === 'tooling')],
      ['其他运行时', deps.filter(dep => dep.group === 'runtime')],
    ].filter(([, items]) => items.length),
    dependencies: deps,
  }
}

function classifyDependency(name, scope) {
  const value = String(name || '')
  if (['vue', 'vue-router', 'pinia'].includes(value)) return 'framework'
  if (['vant', '@vant/area-data', 'sass', 'postcss-pxtorem'].includes(value)) return 'ui'
  if (['axios', 'js-cookie', 'vconsole', 'vue-clipboard3'].includes(value)) return 'integration'
  if (/pdf|qrcode|html2canvas|office/i.test(value)) return 'document'
  if (scope === 'dev' || /vite|babel|typescript|vue-tsc|fast-glob/i.test(value)) return 'tooling'
  return 'runtime'
}

function buildModuleGraph(nodes, edges) {
  const nodeById = indexById(nodes)
  const moduleFiles = new Map()
  const weighted = new Map()
  for (const edge of edges.filter(edge => edge.predicate === 'imports')) {
    const fromPath = nodeById.get(edge.subject)?.path
    const toPath = nodeById.get(edge.object)?.path
    if (!fromPath || !toPath || isStaticAssetPath(fromPath) || isStaticAssetPath(toPath)) continue
    const from = moduleOfPath(fromPath)
    const to = moduleOfPath(toPath)
    if (!from || !to || from === to) continue
    addSet(moduleFiles, from, fromPath)
    addSet(moduleFiles, to, toPath)
    const key = `${from} -> ${to}`
    const current = weighted.get(key) || { from, to, weight: 0, evidence: [] }
    current.weight += 1
    if (current.evidence.length < 3 && edge.evidence?.[0]) current.evidence.push(edge.evidence[0])
    weighted.set(key, current)
  }
  const edgesOut = [...weighted.values()]
    .filter(edge => edge.weight >= 3)
    .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from))
    .slice(0, 32)
  const used = new Set(edgesOut.flatMap(edge => [edge.from, edge.to]))
  const nodesOut = [...used]
    .map(id => ({ id, lane: moduleLane(id), files: moduleFiles.get(id)?.size || 0 }))
    .sort((a, b) => laneRank(a.lane) - laneRank(b.lane) || b.files - a.files || a.id.localeCompare(b.id))
    .slice(0, 25)
  const kept = new Set(nodesOut.map(node => node.id))
  return {
    nodes: nodesOut,
    edges: edgesOut.filter(edge => kept.has(edge.from) && kept.has(edge.to)),
    omittedEdges: Math.max(0, [...weighted.values()].filter(edge => edge.weight >= 3).length - edgesOut.length),
  }
}

function buildEntryPoints(state, nodes, edges) {
  const fileSet = new Set(nodes.filter(node => node.type === 'file').map(node => node.path).filter(Boolean))
  const candidates = [
    ['src/main.ts', '应用启动'],
    ['src/App.vue', '根组件'],
    ['src/router/index.ts', '路由装配'],
    ...nodes.filter(node => node.type === 'file' && /^src\/router\/.+\.ts$/.test(node.path || '') && node.path !== 'src/router/index.ts')
      .map(node => [node.path, '业务路由']),
  ]
  const unique = []
  const seen = new Set()
  for (const [file, role] of candidates) {
    if (!fileSet.has(file) && !state.inventory?.files?.some(item => item.path === file)) continue
    if (seen.has(file)) continue
    seen.add(file)
    unique.push({ file, role })
  }
  return unique.slice(0, 10)
}

function buildSharedModules(nodes, edges) {
  const nodeById = indexById(nodes)
  const incoming = new Map()
  for (const edge of edges.filter(edge => edge.predicate === 'imports')) {
    const target = nodeById.get(edge.object)
    const targetPath = target?.path
    if (!targetPath || isStaticAssetPath(targetPath)) continue
    incoming.set(targetPath, (incoming.get(targetPath) || 0) + 1)
  }
  return [...incoming.entries()]
    .filter(([file]) => /^src\/(request|utils|api|router|components|store)\//.test(file) || /^src\/(request|router|store)\.ts$/.test(file))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([file, inbound]) => ({ file, inbound, role: sharedModuleRole(file) }))
}

function buildDataFetchExamples(nodes, edges) {
  const calls = edges.filter(edge => edge.predicate === 'calls')
  const examples = []
  for (const viewToApi of calls) {
    const apiToPost = calls.find(edge => edge.subject === viewToApi.object && edge.object === 'package:service.post')
    if (!apiToPost) continue
    const viewEvidence = viewToApi.evidence?.[0] || {}
    const apiEvidence = apiToPost.evidence?.[0] || {}
    examples.push({
      viewFunction: serviceName(viewToApi.subject),
      apiFunction: serviceName(viewToApi.object),
      endpoint: extractEndpoint(apiEvidence.snippet),
      viewFile: viewEvidence.file || '',
      apiFile: apiEvidence.file || '',
      lines: [viewEvidence.line, apiEvidence.line].filter(Boolean),
    })
  }
  return examples.slice(0, 3)
}

function indexById(nodes) {
  return new Map((nodes || []).map(node => [node.id, node]))
}

function addSet(map, key, value) {
  if (!map.has(key)) map.set(key, new Set())
  map.get(key).add(value)
}

function isStaticAssetPath(file) {
  return /^src\/static\//.test(file || '') || /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i.test(file || '')
}

function moduleOfPath(file) {
  const value = String(file || '')
  if (!value || isStaticAssetPath(value)) return ''
  const parts = value.split('/')
  if (parts[0] === 'src' && parts[1] === 'view' && parts[2]) return `src/view/${parts[2]}`
  if (parts[0] === 'src' && parts[1] === 'api' && parts[2]) return `src/api/${parts[2]}`
  if (parts[0] === 'src' && parts[1]) return `src/${parts[1]}`
  return parts[0] || value
}

function moduleLane(moduleId) {
  if (/^src\/view\//.test(moduleId)) return 'view'
  if (/^src\/api\//.test(moduleId)) return 'api'
  if (/^src\//.test(moduleId)) return 'shared'
  return 'package'
}

function laneRank(lane) {
  return { view: 1, api: 2, shared: 3, package: 4 }[lane] || 9
}

function sharedModuleRole(file) {
  if (/src\/request/.test(file)) return 'HTTP 客户端'
  if (/src\/utils/.test(file)) return '共享工具'
  if (/src\/api/.test(file)) return 'API wrapper'
  if (/src\/router/.test(file)) return '路由装配'
  if (/src\/components/.test(file)) return '共享组件'
  if (/src\/store/.test(file)) return '状态管理'
  return '共享模块'
}

function serviceName(value) {
  return String(value || '').replace(/^service:/, '').replace(/^package:/, '')
}

function extractEndpoint(snippet) {
  const text = String(snippet || '')
  const candidates = [...text.matchAll(/['"]([^'"]*\/[^'"]*)['"]/g)].map(match => match[1])
  return candidates.find(value => !value.startsWith('@/')) || candidates[0] || 'endpoint 未从片段中解析'
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
      <a href="#domains">业务域</a>
      <a href="#screens">页面</a>
      <a href="#modules">模块</a>
      <a href="#diagnostics">诊断</a>
    </nav>
    <div class="toolbar">
      <button type="button" data-action="theme">主题</button>
      <button type="button" data-action="svg">导出架构图</button>
    </div>
  </header>
  <main id="summary">
    <section class="hero guide-hero">
      <div class="hero-copy">
        <p class="kicker">仓库导览</p>
        <h1>${escapeHtml(model.repo.name)}</h1>
        <p class="lead">${escapeHtml(model.identity)}</p>
        ${model.synthesisSummary ? `<p class="summary-note">${escapeHtml(model.synthesisSummary)}</p>` : ''}
        ${renderStackBadges(model.techStack.badges)}
        <div class="repo-meta">
          ${metaLine('产物包', model.packageDir)}
          ${metaLine('源码仓库', model.repo.path)}
          ${metaLine('Git', gitSummary(model.repo.git))}
        </div>
      </div>
      <div class="hero-facts" aria-label="仓库轮廓">
        ${renderFactTile('页面', model.routeCount, `${model.domains.length} 个业务域`)}
        ${renderFactTile('源码', model.metrics.sourceFiles, `${model.metrics.files} 个文件`)}
        ${renderFactTile('入口', model.entryPoints.length, '启动与路由入口')}
        ${renderFactTile('共享', model.sharedModules.length, '高扇入模块')}
      </div>
    </section>

    <section class="metric-strip compact-strip" aria-label="仓库指标">
      ${metric('文件', model.metrics.files, `${model.metrics.sourceFiles} 个源码文件`)}
      ${metric('页面', model.routeCount, `${model.domains.length} 个业务域`)}
    </section>

    ${renderSynthesisHighlights(model.synthesis)}

    <section class="section-stack domain-section" id="domains">
      <div class="section-head">
        <p class="kicker">业务域地图</p>
        <h2>${escapeHtml(model.routeCount)} 个页面按 router 域聚合。</h2>
        <p>每个业务域给出中文作用描述与一张"域 → 依赖层"架构图；数据来自 <code>fact-graph.json</code> 的 <code>routes-to</code> / <code>dynamic-imports</code> / <code>imports</code>，只统计指向 <code>src/router/</code> 的路由关系。</p>
      </div>
      ${renderDomainMap(model.domains)}
    </section>

    <section class="section-stack" id="screens">
      <div class="section-head">
        <p class="kicker">页面索引</p>
        <h2>路由、视图文件和中文注释按业务域下钻。</h2>
        <p>配不到独立视图的页面会明确标注为无独立视图或重定向，不做猜测。</p>
      </div>
      ${renderScreenIndex(model.domains)}
    </section>

    <section class="section-stack" id="modules">
      <div class="section-head">
        <p class="kicker">工程结构</p>
        <h2>模块依赖折叠到可读层级。</h2>
        <p>模块图由 <code>imports</code> 聚合而来，排除 <code>src/static</code> 资源噪声，只保留权重不低于 3 的模块关系。</p>
      </div>
      ${renderModuleGraph(model.moduleGraph)}
      <div class="analysis-grid">
        ${renderEntryPoints(model.entryPoints, model.sharedModules)}
        ${renderTechStack(model.techStack)}
      </div>
    </section>

    <section class="section-stack" id="evidence">
      <div class="section-head">
        <p class="kicker">证据路径</p>
        <h2>保留能落到文件和调用链的入口。</h2>
        <p>${escapeHtml(renderCoverageSentence(model))}</p>
      </div>
      <div class="analysis-grid">
        ${renderDataFetchExamples(model.dataFetchExamples)}
        ${renderTopFiles(model.topFiles)}
      </div>
    </section>

    <details class="diagnostics" id="diagnostics">
      <summary>
        <span>
          <strong>管线诊断</strong>
          <small>覆盖率、验证器、缺口队列、节点与关系分布</small>
        </span>
      </summary>
      <div class="diagnostic-body">
        <div class="hero-score" aria-label="Harness 状态">
          ${renderScoreBlock('校验', model.validation.passed ? '通过' : '未通过', model.validation.score ?? 'n/a')}
          ${renderScoreBlock('覆盖率', formatPercent(model.metrics.coverageScore), `${model.metrics.factNodes} 个节点`)}
          ${renderScoreBlock('验证器', String(model.metrics.removedByVerifier), `${model.metrics.verifiedEdges} 条已检查`)}
        </div>
        <section class="metric-strip" aria-label="产物指标">
          ${metric('事实图', model.metrics.factNodes, `${model.metrics.factEdges} 条关系`)}
          ${metric('渲染图', model.metrics.renderNodes, `${model.metrics.renderEdges} 条边`)}
          ${metric('知识索引', model.metrics.knowledgeChunks, '个片段')}
          ${metric('缺口', model.metrics.gapTasks, '个任务')}
        </section>
        <div class="quality-cards">
          ${renderQuality(model)}
        </div>
        <section class="distribution-grid">
          ${distribution('节点类型', model.distributions.nodeTypes.map(([label, count]) => [translateNodeType(label), count]))}
          ${distribution('关系类型', model.distributions.predicates.map(([label, count]) => [translatePredicate(label), count]))}
          ${distribution('缺口任务', model.distributions.tasks.map(([label, count]) => [translateTaskBucket(label), count]))}
          ${distribution('探索器', model.distributions.explorers.map(([label, count]) => [translateExplorer(label), count]))}
        </section>
      </div>
    </details>

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
.guide-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.18fr) minmax(320px, .82fr);
  gap: clamp(28px, 5vw, 76px);
  align-items: center;
  padding: 56px 0;
  border-bottom: 1px solid var(--line);
}
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
.summary-note {
  margin: 18px 0 0;
  max-width: 78ch;
  color: var(--muted);
  font-size: 15px;
  overflow-wrap: anywhere;
}
.kicker { color: var(--accent); margin: 0; }
.stack-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 22px;
}
.stack-badges span {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid var(--accent);
  color: var(--accent);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
}
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
.hero-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border: 1px solid var(--ink);
}
.fact-tile {
  min-height: 188px;
  display: grid;
  align-content: space-between;
  padding: 20px;
  border-right: 1px solid var(--ink);
  border-bottom: 1px solid var(--ink);
}
.fact-tile:nth-child(2n) { border-right: 0; }
.fact-tile:nth-last-child(-n + 2) { border-bottom: 0; }
.fact-tile strong {
  font-size: clamp(42px, 6vw, 86px);
  line-height: .86;
  font-weight: 220;
}
.fact-tile span:last-child {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.metric-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  border: 1px solid var(--line);
  margin: 0 0 48px;
}
.compact-strip {
  max-width: 760px;
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
.domain-section { padding-top: 64px; }
.domain-map {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
  gap: 16px;
}
.domain-card {
  display: grid;
  gap: 12px;
  align-content: start;
  min-height: 240px;
  padding: 18px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--paper) 88%, var(--soft));
}
/* 卡片统一宽度：每域架构图需要一致的横向空间，尺寸类不再改变跨列宽度 */
.domain-size-xl, .domain-size-lg, .domain-size-md, .domain-size-sm { grid-column: auto; }
.domain-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: start;
  min-width: 0;
}
.domain-head strong {
  display: block;
  margin-top: 6px;
  font-size: clamp(22px, 2.4vw, 34px);
  line-height: 1;
  font-weight: 350;
}
.domain-count {
  flex-shrink: 0;
  color: var(--accent);
  font-family: var(--mono);
  font-weight: 700;
}
.domain-screens {
  display: grid;
  gap: 6px;
}
.screen-line {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr);
  gap: 12px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}
.screen-path, .screen-route strong {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink);
}
.screen-meta, .screen-view, .screen-line-no {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 13px;
}
.screen-index {
  display: grid;
  gap: 12px;
}
.screen-domain {
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--paper) 90%, var(--soft));
}
.screen-domain summary {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  padding: 14px 16px;
  cursor: pointer;
}
.screen-domain summary span {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.screen-table {
  display: grid;
  padding: 0 16px 12px;
}
.screen-row {
  display: grid;
  grid-template-columns: minmax(0, .95fr) minmax(0, 1.15fr) 64px;
  gap: 14px;
  padding: 9px 0;
  border-top: 1px solid var(--line);
  align-items: start;
}
.screen-route em {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-style: normal;
  font-size: 13px;
}
.module-graph {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(320px, .7fr);
  gap: 24px;
  align-items: start;
}
.module-lanes {
  display: grid;
  gap: 14px;
}
.module-lane {
  border: 1px solid var(--line);
  padding: 16px;
  background: color-mix(in srgb, var(--paper) 88%, var(--soft));
}
.module-lane h3, .subhead {
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 460;
}
.subhead { margin-top: 22px; }
.module-node-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.module-node {
  display: inline-grid;
  gap: 2px;
  max-width: 240px;
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  background: var(--paper);
}
.module-node strong {
  overflow-wrap: anywhere;
  font-family: var(--mono);
  font-size: 12px;
}
.module-node small {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
}
.dependency-groups {
  display: grid;
  gap: 12px;
}
.dependency-group {
  display: grid;
  gap: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.dependency-group span {
  color: var(--muted);
  overflow-wrap: anywhere;
}
.diagram-panel {
  overflow: auto;
  max-width: 100%;
  border: 1px solid var(--ink);
  background: var(--paper);
}
.architecture-svg { display: block; width: 100%; min-width: 0; height: auto; }
.svg-bg { fill: var(--paper); }
.arch-svg { display: block; width: 100%; height: auto; color: var(--muted); background: var(--soft); border: 1px solid var(--line); border-radius: 12px; }
.arch-lane-title { fill: var(--muted); font-size: 13px; font-weight: 600; }
.arch-node rect { fill: var(--paper); stroke: var(--line); stroke-width: 1.2; }
.arch-node.lane-view rect { stroke: var(--accent); }
.arch-node.lane-api rect { stroke: var(--security); }
.arch-node-label { fill: var(--ink); font-size: 14px; font-weight: 600; }
.arch-node-sub { fill: var(--muted); font-size: 11px; }
.arch-edge { fill: none; stroke: var(--muted); opacity: 0.5; }
.domain-purpose { margin: 0.35rem 0 0.6rem; color: var(--ink); font-size: 0.94rem; }
.domain-diagram { margin: 0.2rem 0 0.7rem; }
.domain-diagram .arch-svg { max-width: 560px; }
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
.panel p { overflow-wrap: anywhere; }
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
.synthesis-grid {
  padding-top: 36px;
}
.diagnostics {
  margin-top: 56px;
  border: 1px solid var(--ink);
  background: color-mix(in srgb, var(--paper) 92%, var(--soft));
}
.diagnostics > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  cursor: pointer;
}
.diagnostics > summary strong {
  display: block;
  font-size: 22px;
  font-weight: 460;
}
.diagnostics > summary small {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
}
.diagnostic-body {
  display: grid;
  gap: 24px;
  padding: 0 20px 24px;
}
.architecture-diagnostic {
  border-bottom: 0;
  padding-bottom: 0;
}
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
  .guide-hero, .section-grid, .analysis-grid, .quality-grid, .quality-cards, .distribution-grid, .evidence-lists, .module-graph { grid-template-columns: 1fr; }
  .section-stack { padding: 40px 0; }
  .hero { min-height: auto; }
  .hero-copy h1 { max-width: 100%; font-size: clamp(46px, 16vw, 92px); }
  .hero-score, .hero-facts, .metric-strip, .domain-map { grid-template-columns: 1fr; }
  .domain-size-xl, .domain-size-lg, .domain-size-md, .domain-size-sm { grid-column: span 1; grid-row: span 1; }
  .score-block, .metric { border-right: 0; border-bottom: 1px solid var(--line); min-height: 140px; }
  .score-block:last-child, .metric:last-child { border-bottom: 0; }
  .fact-tile { border-right: 0; border-bottom: 1px solid var(--ink); min-height: 140px; }
  .fact-tile:nth-child(2n) { border-right: 0; }
  .fact-tile:nth-last-child(-n + 2) { border-bottom: 1px solid var(--ink); }
  .fact-tile:last-child { border-bottom: 0; }
  .screen-line, .screen-row { grid-template-columns: 1fr; }
  .screen-domain summary { display: grid; }
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

function renderStackBadges(badges) {
  if (!badges?.length) return ''
  return `<div class="stack-badges" aria-label="技术栈">${badges.map(badge => `<span>${escapeHtml(badge)}</span>`).join('')}</div>`
}

function renderFactTile(label, value, detail) {
  return `<div class="fact-tile">
    <span class="meta-label">${escapeHtml(label)}</span>
    <strong>${escapeHtml(value ?? 'n/a')}</strong>
    <span>${escapeHtml(detail || '')}</span>
  </div>`
}

function renderSynthesisHighlights(synthesis) {
  if (!synthesis || (!synthesis.keyFlows?.length && !synthesis.risks?.length)) return ''
  const flows = (synthesis.keyFlows || []).slice(0, 3)
  const risks = (synthesis.risks || []).slice(0, 3)
  return `<section class="analysis-grid synthesis-grid" aria-label="综合分析">
    <section class="panel">
      <h3>L4 关键流程</h3>
      <div class="rank-list">
        ${flows.map((flow, index) => `<div class="rank-item">
          <span class="rank">${String(index + 1).padStart(2, '0')}</span>
          <span><strong class="label">${escapeHtml(flow.name || '流程')}</strong><br><span class="value">${escapeHtml(formatFlowSteps(flow.steps))}</span></span>
        </div>`).join('') || emptyText('没有写入 keyFlows。')}
      </div>
    </section>
    <section class="panel">
      <h3>L4 风险提示</h3>
      <div class="rank-list">
        ${risks.map((risk, index) => `<div class="rank-item">
          <span class="rank">${String(index + 1).padStart(2, '0')}</span>
          <span><strong class="label">${escapeHtml(risk.title || '风险')}</strong><br><span class="value">${escapeHtml(risk.rationale || risk.severity || '')}</span></span>
        </div>`).join('') || emptyText('没有写入 risks。')}
      </div>
    </section>
  </section>`
}

const DEP_LANES = [
  ['components', '组件'],
  ['utils', '工具'],
  ['api', 'API'],
  ['request', '请求'],
  ['store', '状态'],
]

function depLaneOf(file) {
  const value = String(file || '')
  if (!value || isStaticAssetPath(value)) return ''
  if (/^src\/components\//.test(value)) return 'components'
  if (/^src\/utils(\/|\.)/.test(value)) return 'utils'
  if (/^src\/api\//.test(value)) return 'api'
  if (/^src\/request(\/|\.|$)/.test(value)) return 'request'
  if (/^src\/store(\/|\.|$)/.test(value)) return 'store'
  return ''
}

// 给每个业务域补：中文作用描述（来自路由中文注释）+ 该域视图依赖的共享层（用于每域架构图）
function enrichDomains(domains, nodes, edges) {
  const nodeById = indexById(nodes)
  const importsByFile = new Map()
  for (const edge of edges) {
    if (edge.predicate !== 'imports') continue
    const from = nodeById.get(edge.subject)?.path
    const to = nodeById.get(edge.object)?.path
    if (!from || !to) continue
    if (!importsByFile.has(from)) importsByFile.set(from, [])
    importsByFile.get(from).push(to)
  }
  return domains.map(domain => {
    const comments = [...new Set(domain.screens.map(screen => screen.comment).filter(Boolean))]
    // 作用描述：优先用 agent authored 的业务域描述；否则回退到路由中文注释派生
    const purpose = domain.description
      || (comments.length ? `负责 ${comments.slice(0, 6).join('、')}${comments.length > 6 ? ' 等' : ''}` : '前端路由域，具体职责见页面清单')
    const viewFiles = [...new Set(domain.screens.map(screen => screen.view).filter(Boolean))]
    const laneMods = new Map()
    for (const viewFile of viewFiles) {
      for (const target of importsByFile.get(viewFile) || []) {
        const lane = depLaneOf(target)
        if (!lane) continue
        addSet(laneMods, lane, moduleOfPath(target) || target)
      }
    }
    const deps = DEP_LANES
      .filter(([key]) => laneMods.has(key))
      .map(([key, label]) => ({ key, label, modules: laneMods.get(key).size }))
    const subFeatures = groupSubFeatures(domain.screens)
    return { ...domain, purpose, deps, subFeatures, viewCount: viewFiles.length }
  })
}

function displayModuleName(value) {
  return String(value || '').replace(/^src\//, '').replace(/^package:/, '')
}

// 自适应子功能分组：先按一级路径分组；若只得一组（该域路由共用同一前缀），自动下钻到二级
function groupSubFeatures(screens) {
  const build = depth => {
    const map = new Map()
    for (const screen of screens) {
      const segs = String(screen.path || '').split('/').filter(Boolean)
      const seg = segs[depth] || segs[segs.length - 1] || '根'
      if (!map.has(seg)) map.set(seg, { seg, count: 0, label: '' })
      const group = map.get(seg)
      group.count += 1
      if (!group.label && screen.comment) group.label = screen.comment
    }
    return [...map.values()]
  }
  let groups = build(0)
  if (groups.length < 2) groups = build(1)
  return groups.sort((a, b) => b.count - a.count || a.seg.localeCompare(b.seg)).slice(0, 8)
}

function truncateLabel(value, max) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// 通用分层列式 SVG：columns=[{title,nodes:[{id,label,sub,lane}]}]，edges=[{from,to,weight}]
function layeredColumnsSvg(columns, edges, options = {}) {
  const cols = columns.filter(column => column.nodes.length)
  if (!cols.length) return ''
  const colW = options.colW || 240
  const gapX = options.gapX || 96
  const nodeH = 48
  const gapY = 18
  const padX = 28
  const padTop = 50
  const padBottom = 26
  const width = padX * 2 + cols.length * colW + (cols.length - 1) * gapX
  const maxRows = Math.max(1, ...cols.map(column => column.nodes.length))
  const height = padTop + padBottom + maxRows * nodeH + (maxRows - 1) * gapY
  const pos = new Map()
  cols.forEach((column, ci) => {
    const x = padX + ci * (colW + gapX)
    column.x = x
    const colH = column.nodes.length * nodeH + (column.nodes.length - 1) * gapY
    const startY = padTop + (height - padTop - padBottom - colH) / 2
    column.nodes.forEach((node, ri) => {
      pos.set(node.id, { x, y: startY + ri * (nodeH + gapY), w: colW, h: nodeH, node })
    })
  })
  const maxWeight = Math.max(1, ...edges.map(edge => edge.weight || 1))
  const edgeSvg = edges.filter(edge => pos.has(edge.from) && pos.has(edge.to)).map(edge => {
    const a = pos.get(edge.from)
    const b = pos.get(edge.to)
    const x1 = a.x + a.w
    const y1 = a.y + a.h / 2
    const x2 = b.x
    const y2 = b.y + b.h / 2
    const mx = (x1 + x2) / 2
    const sw = 1 + Math.round(((edge.weight || 1) / maxWeight) * 4)
    return `<path class="arch-edge" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" stroke-width="${sw}" marker-end="url(#arch-arrow)"></path>`
  }).join('')
  const nodeSvg = [...pos.values()].map(item => {
    const node = item.node
    const label = truncateLabel(displayModuleName(node.label ?? node.id), 22)
    const sub = node.sub ? `<text class="arch-node-sub" x="${item.x + 13}" y="${item.y + 33}">${escapeHtml(node.sub)}</text>` : ''
    return `<g class="arch-node lane-${escapeHtml(node.lane || 'default')}">
      <rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" rx="10"></rect>
      <text class="arch-node-label" x="${item.x + 13}" y="${item.y + (node.sub ? 20 : 29)}">${escapeHtml(label)}</text>
      ${sub}
    </g>`
  }).join('')
  const titles = cols.map(column => `<text class="arch-lane-title" x="${column.x + colW / 2}" y="26" text-anchor="middle">${escapeHtml(column.title)}</text>`).join('')
  const id = options.id ? ` id="${options.id}"` : ''
  return `<svg${id} class="arch-svg architecture-svg" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMidYMid meet">
    <defs><marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"></path></marker></defs>
    ${titles}
    ${edgeSvg}
    ${nodeSvg}
  </svg>`
}

// 全局架构图：view 特性层 → API 层 → 共享层 → 外部包
function renderModuleSvg(moduleGraph) {
  const laneDefs = [['view', '页面特性层'], ['api', 'API 层'], ['shared', '共享层'], ['package', '外部包']]
  const columns = laneDefs.map(([lane, title]) => ({
    title,
    nodes: moduleGraph.nodes.filter(node => node.lane === lane).map(node => ({ id: node.id, label: node.id, sub: `${node.files} 文件`, lane })),
  }))
  if (!columns.some(column => column.nodes.length)) return emptyText('没有达到阈值的模块关系。')
  return layeredColumnsSvg(columns, moduleGraph.edges, { colW: 236, gapX: 96, id: 'architecture-svg' })
}

// 每个业务域一张架构图：业务域 → 它的子功能（按页面数，带中文名）
function renderDomainSvg(domain) {
  const subs = domain.subFeatures || []
  if (subs.length < 2) return ''
  const columns = [
    { title: '业务域', nodes: [{ id: '__domain', label: displayDomainName(domain.domain), sub: `${domain.count} 页面`, lane: 'view' }] },
    { title: '子功能（按页面数）', nodes: subs.map(sub => ({
      id: `sf-${sub.seg}`,
      label: sub.label || `/${sub.seg}`,
      sub: `/${sub.seg} · ${sub.count} 页`,
      lane: sub.count >= 4 ? 'view' : 'shared',
    })) },
  ]
  const edges = subs.map(sub => ({ from: '__domain', to: `sf-${sub.seg}`, weight: sub.count }))
  return `<div class="domain-diagram">${layeredColumnsSvg(columns, edges, { colW: 220, gapX: 130 })}</div>`
}

function renderDomainMap(domains) {
  const max = Math.max(...domains.map(domain => domain.count), 1)
  return `<div class="domain-map">
    ${domains.map(domain => `<section class="domain-card ${domainSizeClass(domain.count, max)}">
      <div class="domain-head">
        <span>
          <span class="meta-label">${escapeHtml(domain.routerFile)}</span>
          <strong>${escapeHtml(displayDomainName(domain.domain))}</strong>
        </span>
        <span class="domain-count">${escapeHtml(domain.count)} 页面</span>
      </div>
      <p class="domain-purpose">${escapeHtml(domain.purpose)}</p>
      ${renderDomainSvg(domain)}
      <div class="domain-screens">
        ${[...domain.screens].sort((a, b) => (b.comment ? 1 : 0) - (a.comment ? 1 : 0) || a.line - b.line).slice(0, 8).map(screen => renderScreenPreview(screen)).join('')}
      </div>
      ${domain.screens.length > 8 ? `<p class="small-muted">共 ${escapeHtml(domain.screens.length)} 个页面，此处优先展示有中文说明的，其余见下方索引。</p>` : ''}
    </section>`).join('') || emptyText('没有可展示的路由域。')}
  </div>`
}

function renderScreenPreview(screen) {
  const desc = screen.comment || (screen.view ? '' : '重定向 / 父级路由')
  return `<div class="screen-line">
    <span class="screen-path">${escapeHtml(screen.path)}</span>
    ${desc ? `<span class="screen-meta">${escapeHtml(desc)}</span>` : ''}
  </div>`
}

function renderScreenIndex(domains) {
  return `<div class="screen-index">
    ${domains.map(domain => `<details class="screen-domain" ${domains.length <= 3 ? 'open' : ''}>
      <summary><strong>${escapeHtml(displayDomainName(domain.domain))}</strong><span>${escapeHtml(domain.count)} 页面 / ${escapeHtml(domain.routerFile)}</span></summary>
      <div class="screen-table">
        ${domain.screens.map(screen => `<div class="screen-row">
          <span class="screen-route">
            <strong>${escapeHtml(screen.path)}</strong>
            ${screen.comment ? `<em>${escapeHtml(screen.comment)}</em>` : ''}
          </span>
          <span class="screen-view">${escapeHtml(screen.view || '无独立视图/重定向')}</span>
          <span class="screen-line-no">L${escapeHtml(screen.line || 'n/a')}</span>
        </div>`).join('')}
      </div>
    </details>`).join('')}
  </div>`
}

function renderModuleGraph(moduleGraph) {
  return `<div class="module-graph">
    <div class="diagram-panel">${renderModuleSvg(moduleGraph)}</div>
    <section class="panel module-edges">
      <h3>高权重依赖（imports 聚合）</h3>
      <div class="rank-list">
        ${moduleGraph.edges.slice(0, 12).map((edge, index) => `<div class="rank-item">
          <span class="rank">${String(index + 1).padStart(2, '0')}</span>
          <span><strong class="label">${escapeHtml(displayModuleName(edge.from))} → ${escapeHtml(displayModuleName(edge.to))}</strong><br><span class="value">聚合 ${escapeHtml(edge.weight)} 条 imports</span></span>
        </div>`).join('') || emptyText('没有达到阈值的模块关系。')}
      </div>
    </section>
  </div>`
}

function renderEntryPoints(entryPoints, sharedModules) {
  return `<section class="panel">
    <h3>从哪读起</h3>
    <div class="rank-list">
      ${entryPoints.map((entry, index) => `<div class="rank-item">
        <span class="rank">${String(index + 1).padStart(2, '0')}</span>
        <span><strong class="label">${escapeHtml(entry.file)}</strong><br><span class="value">${escapeHtml(entry.role)}</span></span>
      </div>`).join('') || emptyText('未识别入口文件。')}
    </div>
    <h3 class="subhead">高扇入共享模块</h3>
    <div class="rank-list">
      ${sharedModules.map((item, index) => `<div class="rank-item">
        <span class="rank">${String(index + 1).padStart(2, '0')}</span>
        <span><strong class="label">${escapeHtml(item.file)}</strong><br><span class="value">${escapeHtml(item.role)} / 入度 ${escapeHtml(item.inbound)}</span></span>
      </div>`).join('') || emptyText('未识别高扇入共享模块。')}
    </div>
  </section>`
}

function renderTechStack(techStack) {
  return `<section class="panel">
    <h3>技术栈</h3>
    <p class="small-muted">依赖分组来自 <code>code-map.dependencies</code> 的 scope 与包名启发式分类。</p>
    <div class="dependency-groups">
      ${techStack.groups.map(([title, deps]) => `<div class="dependency-group">
        <strong>${escapeHtml(title)}</strong>
        <span>${deps.slice(0, 9).map(dep => escapeHtml(`${dep.name}${dep.version ? ` ${dep.version}` : ''}`)).join(' / ')}${deps.length > 9 ? ` / +${deps.length - 9}` : ''}</span>
      </div>`).join('')}
    </div>
  </section>`
}

function renderDataFetchExamples(examples) {
  return `<section class="panel">
    <h3>数据获取追踪示例</h3>
    <p class="small-muted">只展示 fact-graph 中存在完整 view -> api -> service.post 链的样本。</p>
    <div class="rank-list">
      ${examples.map((example, index) => `<div class="rank-item">
        <span class="rank">${String(index + 1).padStart(2, '0')}</span>
        <span>
          <strong class="label">${escapeHtml(example.viewFunction)} -> ${escapeHtml(example.apiFunction)} -> POST</strong><br>
          <span class="value">${escapeHtml(example.endpoint)}<br>${escapeHtml(example.viewFile)} / ${escapeHtml(example.apiFile)}</span>
        </span>
      </div>`).join('') || emptyText('当前 fact-graph 中没有完整的数据获取链。')}
    </div>
  </section>`
}

function renderCoverageSentence(model) {
  const covered = Math.min(model.metrics.sourceFiles, model.metrics.coveredSourceFiles)
  return `理解了 ${covered} 个源文件中的 ${model.metrics.sourceFiles} 个；页面到 API 与鉴权链仅按已验证事实展示，未覆盖处不做推断。`
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

function domainSizeClass(count, max) {
  const ratio = max ? count / max : 0
  if (ratio >= 0.72) return 'domain-size-xl'
  if (ratio >= 0.38) return 'domain-size-lg'
  if (ratio >= 0.18) return 'domain-size-md'
  return 'domain-size-sm'
}

// 域名直接来自 agent authored 的 businessDomains（或回退的 router 文件名）；不再硬编码猜测
function displayDomainName(value) {
  return String(value || '')
}

function formatFlowSteps(steps) {
  const values = (steps || []).map(step => {
    if (typeof step === 'string') return step
    if (step?.label) return step.label
    if (step?.description) return step.description
    return ''
  }).filter(Boolean)
  return values.slice(0, 3).join(' -> ')
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
