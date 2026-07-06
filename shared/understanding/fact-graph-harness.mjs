import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FACT_GRAPH_VERSION = '1.0'
const FACT_SCHEMA = 'repo-fact-graph/v1'
const RENDER_SCHEMA = 'repo-render-graph/v1'
const KNOWLEDGE_SCHEMA = 'repo-knowledge-index/v1'

const NODE_TYPES = new Set(['file', 'module', 'symbol', 'route', 'package', 'service', 'config', 'datastore'])
const EDGE_PREDICATES = new Set([
  'imports',
  'dynamic-imports',
  'contains',
  'depends-on',
  'routes-to',
  'registers',
  'calls',
  'guarded-by',
  'reads-from',
  'writes-to',
  'extends',
  'implements',
])

const CONFIDENCE = {
  explicit: 0.95,
  ast: 0.9,
  heuristic: 0.7,
  inferred: 0.5,
}

const DEFAULT_OPTIONS = {
  coverageThreshold: 0.85,
  renderNodeLimit: 800,
  maxLineFactFiles: 2500,
  maxLineFacts: 5000,
}

const SOURCE_CATEGORIES = new Set(['source', 'test', 'script', 'markup', 'config', 'data'])
const EXPLORATION_FACT_SCHEMA = 'repo-explorer-output/v1'

export function buildHarnessArtifacts(input) {
  const options = { ...DEFAULT_OPTIONS, ...loadHarnessOptions(), ...(input.options || {}) }
  const generatedAt = input.generatedAt || new Date().toISOString()
  const incrementalPaths = dedupeStrings(input.invalidatedPaths || input.changedPaths || [])
  const incremental = Boolean(input.previousFactGraph && input.incremental)
  const builder = incremental
    ? createGraphBuilderFromPrevious(input.previousFactGraph, incrementalPaths, input.repo, generatedAt, options)
    : createGraphBuilder(input.repo, generatedAt, options)
  builder.inventoryPaths = new Set((input.inventory.files || []).map(file => file.path))
  const staticInventory = incremental ? filterInventoryForPaths(input.inventory, incrementalPaths) : input.inventory
  const staticCodeMap = incremental ? filterCodeMapForPaths(input.codeMap, incrementalPaths) : input.codeMap
  addStaticFacts(builder, staticInventory, staticCodeMap, input.snippets || {}, options)
  addDynamicFacts(builder, input.inventory, input.explorationAnalysis, input.explorationEvidenceBundle)
  const externalVerification = applyExternalVerifierVerdicts(builder, input.explorationAnalysis)
  const verification = runAdversarialVerifier(builder, input.inventory, options, externalVerification)
  const factGraph = finalizeFactGraph(builder, input.inventory, options)
  const gapQueue = buildGapQueue(factGraph, input.inventory, options, input.previousGapQueue)
  const renderGraph = projectRenderGraph(factGraph, options)
  const knowledgeIndex = projectKnowledgeIndex(factGraph)
  const knowledgeJsonl = renderKnowledgeJsonl(knowledgeIndex)
  const wikiFiles = projectWiki(factGraph, input.analysis)
  return { inventory: input.inventory, gapQueue, verification, factGraph, renderGraph, knowledgeIndex, knowledgeJsonl, wikiFiles }
}

function loadHarnessOptions() {
  const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../harnesses/repo-understanding/harness.config.json')
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return {
      coverageThreshold: config.coverageThreshold,
      renderNodeLimit: config.renderNodeLimit,
      explorerBudgets: Object.fromEntries(Object.entries(config.explorers || {}).map(([name, value]) => [name, value.tokenBudget])),
      maxExplorerRounds: config.maxExplorerRounds,
    }
  } catch {
    return {}
  }
}

export function writeHarnessArtifacts(packageDir, artifacts, options = {}) {
  const root = path.resolve(packageDir)
  const staticDir = path.join(root, 'static')
  ensureDir(staticDir)

  if (artifacts.inventory) {
    writeJson(path.join(root, 'inventory.json'), artifacts.inventory)
    writeJson(path.join(staticDir, 'inventory.json'), artifacts.inventory)
  }
  if (artifacts.factGraph) {
    writeJson(path.join(root, 'fact-graph.json'), artifacts.factGraph)
    writeGraphStore(root, artifacts.factGraph)
  }
  if (artifacts.gapQueue) writeJson(path.join(root, 'gap-queue.json'), artifacts.gapQueue)
  if (artifacts.verification) writeJson(path.join(root, 'verification.json'), artifacts.verification)
  if (artifacts.renderGraph) {
    writeJson(path.join(root, 'render-graph.json'), artifacts.renderGraph)
    writeJson(path.join(staticDir, 'render-graph.json'), artifacts.renderGraph)
  }
  if (artifacts.knowledgeIndex) {
    writeJson(path.join(root, 'knowledge-index.json'), artifacts.knowledgeIndex)
    writeJson(path.join(staticDir, 'knowledge-index.json'), artifacts.knowledgeIndex)
  }
  if (typeof artifacts.knowledgeJsonl === 'string') {
    fs.writeFileSync(path.join(root, 'knowledge-index.jsonl'), artifacts.knowledgeJsonl, 'utf8')
  }
  if (artifacts.wikiFiles && options.writeWiki !== false) {
    const wikiDir = path.join(root, 'wiki')
    fs.rmSync(wikiDir, { recursive: true, force: true })
    for (const [rel, content] of Object.entries(artifacts.wikiFiles)) {
      const target = path.join(root, rel)
      ensureDir(path.dirname(target))
      fs.writeFileSync(target, content, 'utf8')
    }
  }
}

export function refreshHarnessArtifactsForPackage(packageDir, options = {}) {
  const root = path.resolve(packageDir)
  const inventory = readJson(path.join(root, 'static', 'inventory.json'))
  const codeMap = readJson(path.join(root, 'static', 'code-map.json'))
  const knowledgeIndex = readJsonIfExists(path.join(root, 'static', 'knowledge-index.json'))
  const snippets = {}
  for (const ref of knowledgeIndex?.evidenceRefs || []) {
    if (ref.snippet && ref.path) snippets[ref.path] = ref.snippet
  }
  const explorationAnalysis = readJsonIfExists(path.join(root, 'analyses', 'repo-exploration.json'))
  const explorationEvidenceBundle = readJsonIfExists(path.join(root, 'exploration', 'evidence-bundle.json'))
  const analysis = readJsonIfExists(path.join(root, 'analyses', 'repo-understanding.json'))
  const previousGapQueue = readJsonIfExists(path.join(root, 'gap-queue.json'))
  const artifacts = buildHarnessArtifacts({
    repo: inventory.repo,
    inventory,
    codeMap,
    snippets,
    generatedAt: new Date().toISOString(),
    packageDir: root,
    explorationAnalysis,
    explorationEvidenceBundle,
    analysis,
    previousGapQueue,
    options,
  })
  writeHarnessArtifacts(root, artifacts)
  refreshPackageIndex(root, artifacts)
  return artifacts
}

export function projectHarnessPackage(packageDir, options = {}) {
  const root = path.resolve(packageDir)
  const factGraph = readJson(path.join(root, 'fact-graph.json'))
  const only = options.only || 'all'
  const renderGraph = projectRenderGraph(factGraph, { ...DEFAULT_OPTIONS, ...(options.options || {}) })
  const knowledgeIndex = projectKnowledgeIndex(factGraph)
  const knowledgeJsonl = renderKnowledgeJsonl(knowledgeIndex)
  const analysis = readJsonIfExists(path.join(root, 'analyses', 'repo-understanding.json'))
  const wikiFiles = projectWiki(factGraph, analysis)
  const gapQueue = readJsonIfExists(path.join(root, 'gap-queue.json'))
  const artifacts = { factGraph, gapQueue, renderGraph, knowledgeIndex, knowledgeJsonl, wikiFiles }
  if (only === 'all' || only === 'render-graph') {
    writeJson(path.join(root, 'render-graph.json'), renderGraph)
    writeJson(path.join(root, 'static', 'render-graph.json'), renderGraph)
  }
  if (only === 'all' || only === 'knowledge-index') {
    writeJson(path.join(root, 'knowledge-index.json'), knowledgeIndex)
    writeJson(path.join(root, 'static', 'knowledge-index.json'), knowledgeIndex)
    fs.writeFileSync(path.join(root, 'knowledge-index.jsonl'), knowledgeJsonl, 'utf8')
  }
  if (only === 'all' || only === 'wiki') {
    const wikiDir = path.join(root, 'wiki')
    fs.rmSync(wikiDir, { recursive: true, force: true })
    for (const [rel, content] of Object.entries(wikiFiles)) {
      const target = path.join(root, rel)
      ensureDir(path.dirname(target))
      fs.writeFileSync(target, content, 'utf8')
    }
  }
  refreshPackageIndex(root, artifacts)
  return artifacts
}

export function renderKnowledgeJsonl(knowledgeIndex) {
  return `${(knowledgeIndex.chunks || [])
    .map(chunk => JSON.stringify({
      id: chunk.id,
      kind: chunk.kind,
      text: chunk.text,
      graphRefs: chunk.graphRefs || [],
      evidenceRefs: chunk.evidence || [],
      metadata: chunk.metadata || {},
    }))
    .join('\n')}\n`
}

function createGraphBuilder(repo, generatedAt, options) {
  return {
    repo,
    generatedAt,
    options,
    inventoryPaths: new Set(),
    nodes: new Map(),
    edges: new Map(),
    openQuestions: [],
    conflicts: [],
    unresolvedImports: [],
    semanticHints: [],
  }
}

function createGraphBuilderFromPrevious(previousGraph, invalidatedPaths, repo, generatedAt, options) {
  const invalidated = new Set(invalidatedPaths.map(normalizePath))
  const builder = createGraphBuilder(repo, generatedAt, options)
  const removedNodeIds = new Set()
  for (const node of Object.values(previousGraph.nodes || {})) {
    if (node.path && invalidated.has(normalizePath(node.path))) {
      removedNodeIds.add(node.id)
      continue
    }
    builder.nodes.set(node.id, {
      ...node,
      tags: [...(node.tags || [])],
      metadata: { ...(node.metadata || {}) },
    })
  }
  for (const edge of Object.values(previousGraph.edges || {})) {
    const evidenceTouchesInvalidated = (edge.evidence || []).some(item => invalidated.has(normalizePath(item.file)))
    if (removedNodeIds.has(edge.subject) || removedNodeIds.has(edge.object) || evidenceTouchesInvalidated) continue
    builder.edges.set(edge.id, {
      ...edge,
      evidence: (edge.evidence || []).map(item => ({ ...item })),
      metadata: { ...(edge.metadata || {}) },
      lastConfirmed: edge.lastConfirmed || previousGraph.analyzedAt,
    })
  }
  builder.openQuestions = (previousGraph.openQuestions || [])
    .filter(question => !(question.relatedNodes || []).some(ref => removedNodeIds.has(ref)))
    .map(question => ({ ...question, relatedNodes: [...(question.relatedNodes || [])] }))
  builder.incremental = {
    previousRepoId: previousGraph.repoId,
    invalidatedPaths: [...invalidated],
    removedNodeIds: [...removedNodeIds],
    reusedNodeCount: builder.nodes.size,
    reusedEdgeCount: builder.edges.size,
  }
  builder.unresolvedImports = [...(previousGraph.quality?.unresolvedImports || [])]
  builder.semanticHints = [...(previousGraph.quality?.semanticHints || [])]
  return builder
}

function filterInventoryForPaths(inventory, paths) {
  const wanted = new Set(paths.map(normalizePath))
  const wantedFiles = (inventory.files || []).filter(file => wanted.has(normalizePath(file.path)))
  const wantedDirectories = (inventory.directories || []).filter(dir => (
    dir.path === '.' || wantedFiles.some(file => file.path === dir.path || file.path.startsWith(`${dir.path}/`))
  ))
  return {
    ...inventory,
    directories: wantedFiles.length ? wantedDirectories : [],
    files: wantedFiles,
  }
}

function filterCodeMapForPaths(codeMap, paths) {
  const wanted = new Set(paths.map(normalizePath))
  const touches = value => value && wanted.has(normalizePath(value))
  const relationshipTouches = rel => {
    const refs = [rel.from, rel.to, ...(rel.evidenceRefs || [])].map(String)
    return refs.some(ref => [...wanted].some(file => ref.includes(file)))
  }
  return {
    ...codeMap,
    manifests: (codeMap.manifests || []).filter(item => touches(item.path)),
    entrypoints: (codeMap.entrypoints || []).filter(item => touches(item.file)),
    symbols: (codeMap.symbols || []).filter(item => touches(item.file)),
    imports: (codeMap.imports || []).filter(item => touches(item.file)),
    annotations: (codeMap.annotations || []).filter(item => touches(item.file)),
    routes: (codeMap.routes || []).filter(item => touches(item.file)),
    componentRefs: (codeMap.componentRefs || []).filter(item => touches(item.file)),
    dependencies: (codeMap.manifests || []).filter(item => touches(item.path)).flatMap(item => item.dependencies || []),
    relationships: (codeMap.relationships || []).filter(relationshipTouches),
    keyFiles: (codeMap.keyFiles || []).filter(item => touches(item.path)),
  }
}

function addStaticFacts(builder, inventory, codeMap, snippets, options) {
  const repoNode = addNode(builder, {
    id: moduleId('.'),
    type: 'module',
    label: builder.repo.name,
    path: '.',
    tags: ['repo-root'],
    metadata: {
      git: builder.repo.git || {},
      fileCount: inventory.files.length,
    },
  })
  const fileMeta = new Map(inventory.files.map(file => [file.path, file]))
  const moduleNodes = new Map()
  const importResolver = buildImportResolver(inventory)

  for (const dir of inventory.directories || []) {
    const node = addNode(builder, {
      id: moduleId(dir.path),
      type: 'module',
      label: dir.path === '.' ? builder.repo.name : dir.path,
      path: dir.path,
      tags: dir.path === '.' ? ['repo-root'] : [],
      metadata: {
        files: dir.files,
        categories: dir.categories || {},
        languages: dir.languages || {},
      },
    })
    moduleNodes.set(dir.path, node)
    if (dir.path !== '.') {
      addEdge(builder, {
        subject: repoNode.id,
        predicate: 'contains',
        object: node.id,
        source: 'static',
        confidence: CONFIDENCE.explicit,
        metadata: { coverageEligible: false },
        evidence: [{ file: firstFileForDir(inventory.files, dir.path), tool: 'file-walker', rawConfidence: CONFIDENCE.explicit }],
      })
    }
  }

  for (const file of inventory.files) {
    const tags = [file.category].filter(Boolean)
    if (file.protected) tags.push('protected', 'metadata-only')
    if (file.contentAnalyzable) tags.push('content-analyzable')
    const node = addNode(builder, {
      id: fileId(file.path),
      type: 'file',
      label: path.basename(file.path),
      path: file.path,
      lang: file.language,
      tags,
      metadata: {
        size: file.size,
        lines: file.lines,
        hash: file.hash,
        hashKind: file.hashKind,
        category: file.category,
        protected: Boolean(file.protected),
        protectionReason: file.protectionReason || undefined,
      },
    })
    const top = topDir(file.path)
    const parent = moduleNodes.get(top) || repoNode
    addEdge(builder, {
      subject: parent.id,
      predicate: 'contains',
      object: node.id,
      source: 'static',
      confidence: CONFIDENCE.explicit,
      metadata: { coverageEligible: false },
      evidence: [{ file: file.path, tool: 'file-walker', rawConfidence: CONFIDENCE.explicit }],
    })
    if (file.category === 'config') {
      const configNode = addNode(builder, {
        id: configId(file.path),
        type: 'config',
        label: file.path,
        path: file.path,
        lang: file.language,
        tags: ['config'],
        metadata: { category: file.category },
      })
      addEdge(builder, {
        subject: node.id,
        predicate: 'contains',
        object: configNode.id,
        source: 'static',
        confidence: CONFIDENCE.explicit,
        evidence: [evidenceForFile(inventory, file.path, undefined, 'config-parser', CONFIDENCE.explicit)],
      })
    }
  }

  for (const entry of codeMap.entrypoints || []) {
    const fileNode = getNode(builder, fileId(entry.file))
    if (!fileNode) continue
    addTags(fileNode, ['entrypoint'])
    addEdge(builder, {
      subject: repoNode.id,
      predicate: 'registers',
      object: fileNode.id,
      source: 'static',
      confidence: CONFIDENCE.ast,
      evidence: [evidenceForFile(inventory, entry.file, entry.line, 'entrypoint-parser', CONFIDENCE.ast)],
      metadata: { kind: entry.kind, name: entry.name },
    })
  }

  for (const symbol of codeMap.symbols || []) {
    const symbolNode = addNode(builder, {
      id: symbolId(symbol.file, symbol.kind, symbol.name),
      type: 'symbol',
      label: symbol.name,
      path: symbol.file,
      lang: fileMeta.get(symbol.file)?.language,
      tags: [symbol.kind].filter(Boolean),
      metadata: {
        kind: symbol.kind,
        signature: symbol.signature,
        package: symbol.package,
        line: symbol.line,
      },
    })
    addEdge(builder, {
      subject: fileId(symbol.file),
      predicate: 'contains',
      object: symbolNode.id,
      source: 'static',
      confidence: CONFIDENCE.ast,
      metadata: { coverageEligible: false },
      evidence: [evidenceForFile(inventory, symbol.file, symbol.line, 'symbol-scanner', CONFIDENCE.ast)],
    })
  }

  for (const dep of codeMap.dependencies || []) {
    const name = dep.name || dep.artifactId || dep.groupId
    if (!name || name === 'unknown') continue
    const node = addNode(builder, {
      id: packageId(name),
      type: 'package',
      label: name,
      tags: [dep.scope || 'dependency'],
      metadata: {
        version: dep.version,
        scope: dep.scope,
        groupId: dep.groupId,
      },
    })
    addEdge(builder, {
      subject: repoNode.id,
      predicate: 'depends-on',
      object: node.id,
      source: 'static',
      confidence: CONFIDENCE.explicit,
      evidence: [{ file: manifestPathForDependency(codeMap, dep), tool: 'manifest-parser', rawConfidence: CONFIDENCE.explicit }],
      metadata: { scope: dep.scope, version: dep.version },
    })
  }

  for (const item of codeMap.imports || []) {
    const resolved = resolveImportTarget(inventory, item.file, item.target, importResolver)
    if (resolved.unresolved) {
      const question = `Unresolved import target ${item.target} in ${item.file}`
      builder.unresolvedImports.push({
        file: item.file,
        target: item.target,
        kind: item.kind,
        line: item.line,
        reason: resolved.reason || 'not resolved to an inventory file',
      })
      builder.openQuestions.push(openQuestion(question, [fileId(item.file)], 'import-resolver'))
      continue
    }
    const object = addNode(builder, resolved.node)
    addEdge(builder, {
      subject: fileId(item.file),
      predicate: item.kind === 'js-dynamic-import' ? 'dynamic-imports' : 'imports',
      object: object.id,
      source: 'static',
      confidence: item.kind === 'js-dynamic-import' ? CONFIDENCE.ast : CONFIDENCE.explicit,
      evidence: [evidenceForFile(inventory, item.file, item.line, item.kind || 'import-parser', item.kind === 'js-dynamic-import' ? CONFIDENCE.ast : CONFIDENCE.explicit)],
      metadata: { target: item.target, resolved: resolved.resolved },
    })
  }

  for (const route of codeMap.routes || []) {
    const node = addNode(builder, {
      id: routeId(route.method, route.path),
      type: 'route',
      label: route.method ? `${route.method} ${route.path}` : route.path,
      path: route.file,
      tags: ['route'],
      metadata: {
        method: route.method,
        kind: route.kind,
      },
    })
    addEdge(builder, {
      subject: node.id,
      predicate: 'routes-to',
      object: fileId(route.file),
      source: 'static',
      confidence: CONFIDENCE.ast,
      evidence: [evidenceForFile(inventory, route.file, route.line, 'route-hint-parser', CONFIDENCE.ast)],
      metadata: { routePath: route.path, method: route.method },
    })
  }

  for (const ref of codeMap.componentRefs || []) {
    const componentNode = addNode(builder, {
      id: symbolId(ref.file, 'component-ref', ref.name),
      type: 'symbol',
      label: ref.name,
      path: ref.file,
      lang: fileMeta.get(ref.file)?.language,
      tags: ['component-ref'],
      metadata: { kind: 'component-ref' },
    })
    addEdge(builder, {
      subject: fileId(ref.file),
      predicate: 'contains',
      object: componentNode.id,
      source: 'static',
      confidence: CONFIDENCE.ast,
      evidence: [evidenceForFile(inventory, ref.file, ref.line, 'vue-containment-scanner', CONFIDENCE.ast)],
    })
  }

  addLineHeuristicFacts(builder, inventory, options)
}

function addDynamicFacts(builder, inventory, explorationAnalysis, explorationEvidenceBundle) {
  if (!explorationAnalysis) return
  const facts = Array.isArray(explorationAnalysis.facts) ? explorationAnalysis.facts : []
  for (const fact of facts) {
    const predicate = normalizePredicate(fact.predicate)
    if (!predicate) {
      builder.openQuestions.push(openQuestion(`Explorer returned unsupported predicate: ${fact.predicate || 'unknown'}`, [], 'explorer-schema'))
      continue
    }
    const source = ['static', 'dynamic', 'inferred'].includes(fact.source) ? fact.source : 'dynamic'
    const subject = resolveExplorerNode(builder, inventory, fact.subject, fact.subjectType)
    const object = resolveExplorerNode(builder, inventory, fact.object, fact.objectType)
    const evidence = normalizeExplorerEvidence(inventory, fact.evidence, explorationEvidenceBundle, source)
    if (!evidence.length) {
      builder.openQuestions.push(openQuestion(`Explorer fact ${subject.id} ${predicate} ${object.id} has no usable evidence`, [subject.id, object.id], 'explorer-schema'))
      continue
    }
    addEdge(builder, {
      subject: subject.id,
      predicate,
      object: object.id,
      source,
      confidence: confidenceToNumber(fact.confidence ?? fact.rawConfidence, source === 'inferred' ? CONFIDENCE.inferred : CONFIDENCE.heuristic),
      evidence,
      metadata: { explorer: fact.explorer || fact.raisedBy, inferred: source === 'inferred' || Boolean(fact.inferred) },
    })
  }
  for (const item of normalizeOpenQuestionValues(explorationAnalysis.openQuestions || explorationAnalysis.gaps)) {
    builder.openQuestions.push(openQuestion(item.question, item.relatedNodes, item.raisedBy || 'repo-explorer'))
  }
}

function addLineHeuristicFacts(builder, inventory, options) {
  let filesScanned = 0
  let hintsAdded = 0
  for (const file of inventory.files) {
    if (filesScanned >= options.maxLineFactFiles || hintsAdded >= options.maxLineFacts) break
    if (!file.contentAnalyzable || file.protected || !SOURCE_CATEGORIES.has(file.category)) continue
    if (!shouldScanLineFacts(file.path)) continue
    const text = safeRead(path.join(inventory.repo.path, file.path))
    if (!text) continue
    filesScanned += 1
    const lines = text.split(/\r?\n/)
    let fileHints = 0
    for (let i = 0; i < lines.length && fileHints < 10 && hintsAdded < options.maxLineFacts; i += 1) {
      const line = lines[i]
      const lineNo = i + 1
      const call = callSignal(line)
      if (call) {
        builder.semanticHints.push(semanticHint(file.path, lineNo, 'calls', call.kind, line, 'call-chain-hint-parser'))
        fileHints += 1
        hintsAdded += 1
      }
      const guard = guardSignal(line, file.path)
      if (guard) {
        builder.semanticHints.push(semanticHint(file.path, lineNo, 'guarded-by', guard.kind, line, 'auth-chain-hint-parser'))
        fileHints += 1
        hintsAdded += 1
      }
      const data = dataSignal(line, file.path)
      if (data) {
        builder.semanticHints.push(semanticHint(file.path, lineNo, data.write ? 'writes-to' : 'reads-from', data.kind, line, 'data-access-hint-parser'))
        fileHints += 1
        hintsAdded += 1
      }
    }
  }
}

function applyExternalVerifierVerdicts(builder, explorationAnalysis) {
  const checkedAt = builder.generatedAt
  const report = {
    schemaVersion: 'repo-adversarial-verification/v1',
    generatedAt: checkedAt,
    checkedEdges: 0,
    confirmedEdges: 0,
    removedEdges: 0,
    skippedEdges: 0,
    verdicts: [],
  }
  for (const item of normalizeVerifierVerdictValues(explorationAnalysis?.verdicts)) {
    report.checkedEdges += 1
    const edge = builder.edges.get(item.edgeId)
    if (!edge) {
      report.skippedEdges += 1
      report.verdicts.push({
        edgeId: item.edgeId,
        verdict: 'skipped',
        reason: `edge not present during graph rebuild: ${item.reason}`,
        evidenceChecked: item.evidenceChecked || 0,
      })
      continue
    }
    if (item.verdict === 'refuted') {
      builder.edges.delete(item.edgeId)
      report.removedEdges += 1
      report.verdicts.push({
        edgeId: item.edgeId,
        verdict: 'refuted',
        reason: item.reason,
        evidenceChecked: item.evidenceChecked || 0,
      })
      builder.openQuestions.push(openQuestion(
        `Verifier refuted edge ${edge.subject} ${edge.predicate} ${edge.object}: ${item.reason}`,
        [edge.subject, edge.object],
        'adversarial-verifier',
      ))
      continue
    }
    const verdict = item.verdict === 'not-refuted' ? 'not-refuted' : 'skipped'
    edge.metadata = {
      ...(edge.metadata || {}),
      verification: {
        tool: item.tool || 'repo-fact-verifier',
        verdict,
        checkedAt: item.checkedAt || checkedAt,
        reason: item.reason,
        evidenceChecked: item.evidenceChecked || 0,
      },
    }
    if (verdict === 'not-refuted') {
      report.confirmedEdges += 1
    } else {
      report.skippedEdges += 1
      builder.openQuestions.push(openQuestion(
        `Verifier could not confirm edge ${edge.subject} ${edge.predicate} ${edge.object}: ${item.reason}`,
        [edge.subject, edge.object],
        'adversarial-verifier',
      ))
    }
    report.verdicts.push({
      edgeId: item.edgeId,
      verdict,
      reason: item.reason,
      evidenceChecked: item.evidenceChecked || 0,
    })
  }
  return report
}

function normalizeVerifierVerdictValues(values) {
  return (Array.isArray(values) ? values : [])
    .map(item => {
      if (!item?.edgeId || !item.reason) return null
      const verdict = item.verdict === 'insufficient' ? 'skipped' : item.verdict
      if (!['not-refuted', 'refuted', 'skipped'].includes(verdict)) return null
      return {
        edgeId: item.edgeId,
        verdict,
        reason: String(item.reason),
        evidenceChecked: finiteNumber(item.evidenceChecked),
        checkedAt: item.checkedAt,
        tool: item.tool || 'repo-fact-verifier',
      }
    })
    .filter(Boolean)
}

function runAdversarialVerifier(builder, inventory, options, externalReport = null) {
  const checkedAt = builder.generatedAt
  const edgeEntries = [...builder.edges.entries()]
  const report = {
    schemaVersion: 'repo-adversarial-verification/v1',
    generatedAt: checkedAt,
    checkedEdges: externalReport?.checkedEdges || 0,
    confirmedEdges: externalReport?.confirmedEdges || 0,
    removedEdges: externalReport?.removedEdges || 0,
    skippedEdges: externalReport?.skippedEdges || 0,
    verdicts: [...(externalReport?.verdicts || [])],
  }
  const inventoryByPath = new Map((inventory.files || []).map(file => [file.path, file]))
  for (const [edgeId, edge] of edgeEntries) {
    if (!(edge.source !== 'static' || edge.confidence <= 0.7)) continue
    if (isExternalVerified(edge)) continue
    report.checkedEdges += 1
    const verdict = verifyEdgeEvidence(edge, builder.nodes, inventory, inventoryByPath)
    report.verdicts.push({ edgeId, ...verdict })
    if (verdict.verdict === 'refuted') {
      builder.edges.delete(edgeId)
      report.removedEdges += 1
      builder.openQuestions.push(openQuestion(
        `Verifier removed low-confidence edge ${edge.subject} ${edge.predicate} ${edge.object}: ${verdict.reason}`,
        [edge.subject, edge.object],
        'adversarial-verifier',
      ))
      continue
    }
    if (verdict.verdict === 'not-refuted') {
      edge.metadata = {
        ...(edge.metadata || {}),
        verification: {
          tool: 'deterministic-adversarial-verifier',
          verdict: verdict.verdict,
          checkedAt,
          reason: verdict.reason,
          evidenceChecked: verdict.evidenceChecked,
        },
      }
      report.confirmedEdges += 1
      continue
    }
    report.skippedEdges += 1
  }
  const removedNodeIds = pruneDynamicOrphanNodes(builder)
  if (removedNodeIds.size) {
    for (const question of builder.openQuestions) {
      question.relatedNodes = (question.relatedNodes || []).filter(ref => !removedNodeIds.has(ref))
    }
  }
  return report
}

function isExternalVerified(edge) {
  return edge.metadata?.verification?.tool === 'repo-fact-verifier'
}

function pruneDynamicOrphanNodes(builder) {
  const connected = new Set()
  for (const edge of builder.edges.values()) {
    connected.add(edge.subject)
    connected.add(edge.object)
  }
  const removed = new Set()
  for (const [nodeId, node] of builder.nodes.entries()) {
    if (connected.has(nodeId)) continue
    if ((node.tags || []).includes('dynamic')) {
      builder.nodes.delete(nodeId)
      removed.add(nodeId)
    }
  }
  return removed
}

function verifyEdgeEvidence(edge, nodes, inventory, inventoryByPath) {
  let checked = 0
  for (const evidence of edge.evidence || []) {
    const file = inventoryByPath.get(evidence.file)
    if (!file) return { verdict: 'refuted', reason: `missing evidence file ${evidence.file}`, evidenceChecked: checked }
    if (file.protected || file.category === 'protected') {
      return { verdict: 'refuted', reason: `protected evidence cannot support low-confidence edge ${evidence.file}`, evidenceChecked: checked }
    }
    if (!file.contentAnalyzable) {
      return { verdict: 'refuted', reason: `non-analyzable evidence cannot support low-confidence edge ${evidence.file}`, evidenceChecked: checked }
    }
    const text = evidence.snippet || evidenceTextFromFile(inventory.repo.path, evidence)
    if (!text.trim()) return { verdict: 'refuted', reason: `empty evidence at ${evidence.file}${evidence.line ? `:${evidence.line}` : ''}`, evidenceChecked: checked }
    checked += 1
    if (edgeLooksContradicted(edge, nodes, text)) {
      return { verdict: 'refuted', reason: `evidence text contradicts ${edge.predicate}`, evidenceChecked: checked }
    }
  }
  if (!checked) return { verdict: 'refuted', reason: 'no evidence checked', evidenceChecked: 0 }
  return { verdict: 'not-refuted', reason: 'all attached evidence files and ranges are present', evidenceChecked: checked }
}

function evidenceTextFromFile(repoPath, evidence) {
  const file = path.join(repoPath, evidence.file)
  const text = safeRead(file)
  if (!text) return ''
  const lines = text.split(/\r?\n/)
  const start = Math.max(1, Number(evidence.line || 1))
  const end = Math.max(start, Number(evidence.endLine || evidence.line || start))
  if (start > lines.length) return ''
  return lines.slice(start - 1, Math.min(lines.length, end)).join('\n')
}

function edgeLooksContradicted(edge, nodes, text) {
  const lower = text.toLowerCase()
  const subject = nodes.get(edge.subject)
  const object = nodes.get(edge.object)
  const objectToken = object?.path || object?.label
  if (edge.predicate === 'imports' || edge.predicate === 'dynamic-imports') {
    const target = edge.metadata?.target || objectToken
    return target && !importEvidenceTokens(target).some(token => lower.includes(token.toLowerCase()))
  }
  return false
}

function importEvidenceTokens(value) {
  const text = String(value || '').replace(/^package:/, '').trim()
  const withoutQuery = text.split(/[?#]/)[0]
  const candidates = [text, withoutQuery]
  for (const item of [text, withoutQuery]) {
    const basename = path.posix.basename(item)
    candidates.push(basename)
    candidates.push(stripLastExtension(item))
    candidates.push(stripLastExtension(basename))
  }
  return dedupeStrings(candidates)
    .map(item => item.replace(/^['"]|['"]$/g, '').trim())
    .filter(item => item.length >= 2)
}

function stripLastExtension(value) {
  const ext = path.posix.extname(value)
  return ext ? value.slice(0, -ext.length) : value
}

function finalizeFactGraph(builder, inventory, options) {
  const nodes = Object.fromEntries([...builder.nodes.entries()].map(([id, node]) => [id, { ...node }]))
  const edges = Object.fromEntries([...builder.edges.entries()].map(([id, edge]) => [id, { ...edge }]))
  const degree = new Map()
  const evidenceCount = new Map()
  for (const node of Object.values(nodes)) {
    degree.set(node.id, { in: 0, out: 0 })
    evidenceCount.set(node.id, 0)
  }
  for (const edge of Object.values(edges)) {
    if (!nodes[edge.subject] || !nodes[edge.object]) continue
    degree.get(edge.subject).out += 1
    degree.get(edge.object).in += 1
    evidenceCount.set(edge.subject, (evidenceCount.get(edge.subject) || 0) + edge.evidence.length)
    evidenceCount.set(edge.object, (evidenceCount.get(edge.object) || 0) + edge.evidence.length)
  }
  const maxIn = Math.max(1, ...[...degree.values()].map(item => item.in))
  const maxOut = Math.max(1, ...[...degree.values()].map(item => item.out))
  const maxEvidence = Math.max(1, ...evidenceCount.values())
  for (const node of Object.values(nodes)) {
    const d = degree.get(node.id) || { in: 0, out: 0 }
    const isEntry = node.tags.includes('entrypoint') ? 1 : 0
    node.importance = round01(
      0.35 * (d.in / maxIn) +
      0.25 * (d.out / maxOut) +
      0.2 * ((evidenceCount.get(node.id) || 0) / maxEvidence) +
      0.2 * isEntry,
    )
    if (d.in >= 6) addTags(node, ['high-fan-in'])
    if (d.out >= 6) addTags(node, ['high-fan-out'])
  }

  const coverage = computeCoverage(inventory, edges, nodes)
  if (coverage.score < options.coverageThreshold) {
    for (const file of coverage.isolated.slice(0, 60)) {
      builder.openQuestions.push(openQuestion(
        `Coverage gap: ${file} has no non-containment facts yet.`,
        [fileId(file)],
        'coverage-gate',
      ))
    }
  }

  const edgeValues = Object.values(edges)
  return {
    schemaVersion: FACT_SCHEMA,
    version: FACT_GRAPH_VERSION,
    repoId: repoId(builder.repo),
    repo: builder.repo,
    analyzedAt: builder.generatedAt,
    nodes,
    edges,
    openQuestions: dedupeOpenQuestions(builder.openQuestions),
    stats: {
      nodeCount: Object.keys(nodes).length,
      edgeCount: edgeValues.length,
      coverageScore: coverage.score,
      coveredSourceFiles: coverage.covered,
      sourceFileCount: coverage.total,
      symbolExtractionRate: coverage.symbolExtractionRate,
      symbolCoveredSourceFiles: coverage.symbolCovered,
      avgConfidence: round01(edgeValues.reduce((sum, edge) => sum + edge.confidence, 0) / Math.max(1, edgeValues.length)),
    },
    quality: {
      coverageThreshold: options.coverageThreshold,
      lowConfidenceEdges: edgeValues.filter(edge => edge.confidence < 0.7).map(edge => edge.id),
      conflicts: builder.conflicts,
      incremental: builder.incremental || null,
      unresolvedImports: dedupeBy(builder.unresolvedImports || [], item => `${item.file}:${item.target}:${item.line || ''}`).slice(0, 500),
      semanticHints: dedupeBy(builder.semanticHints || [], item => item.id).slice(0, 1000),
    },
  }
}

function projectRenderGraph(factGraph, options) {
  const selected = selectRenderNodes(factGraph, options.renderNodeLimit)
  const selectedIds = new Set(selected.map(node => node.id))
  const nodes = selected.map((node, index) => ({
    id: node.id,
    type: node.type,
    kind: node.type,
    label: node.label,
    path: node.path,
    lang: node.lang,
    tags: node.tags,
    importance: node.importance,
    metadata: node.metadata,
    sizeHint: Math.round(24 + node.importance * 44),
    view: {
      group: node.type,
      position: layoutPosition(node, index),
      size: [Math.round(132 + node.importance * 64), 56],
    },
  }))
  const edges = Object.values(factGraph.edges)
    .filter(edge => selectedIds.has(edge.subject) && selectedIds.has(edge.object))
    .map(edge => ({
      id: edge.id,
      subject: edge.subject,
      object: edge.object,
      from: edge.subject,
      to: edge.object,
      predicate: edge.predicate,
      kind: edge.predicate,
      label: edgeLabel(edge.predicate),
      confidence: edge.confidence,
      source: edge.source,
      evidence: edge.evidence,
      evidenceRefs: edge.evidence.map((_, index) => evidenceRefId(edge.id, index)),
      style: edgeStyle(edge),
      metadata: edge.metadata || {},
    }))
  const groups = Object.values(factGraph.nodes)
    .filter(node => node.type === 'module')
    .map(module => ({
      id: `group:${module.id}`,
      nodeId: module.id,
      label: module.label,
      path: module.path,
      nodes: nodes
        .filter(node => node.path && module.path && (module.path === '.' || node.path === module.path || node.path.startsWith(`${module.path}/`)))
        .map(node => node.id),
    }))
    .filter(group => group.nodes.length)
  const renderGraph = {
    schemaVersion: RENDER_SCHEMA,
    version: FACT_GRAPH_VERSION,
    repoId: factGraph.repoId,
    repo: factGraph.repo,
    source: {
      factGraph: 'fact-graph.json',
      inventory: 'inventory.json',
    },
    nodes,
    edges,
    groups,
    frames: groups.map(group => ({
      id: group.id,
      kind: 'module-group',
      label: group.label,
      nodeIds: group.nodes,
    })),
    views: [
      {
        id: 'architecture',
        label: 'Architecture',
        nodeFilter: { types: ['module', 'file', 'service', 'config', 'package'], minImportance: 0.04 },
        edgeFilter: { predicates: ['contains', 'depends-on', 'imports', 'dynamic-imports', 'calls'], minConfidence: 0.5 },
        layoutHint: 'layered',
      },
      {
        id: 'route-map',
        label: 'Route Map',
        nodeFilter: { types: ['route', 'file', 'service'] },
        edgeFilter: { predicates: ['routes-to', 'calls'], minConfidence: 0.5 },
        layoutHint: 'tree',
      },
      {
        id: 'data-flow',
        label: 'Data Flow',
        nodeFilter: { types: ['file', 'service', 'datastore'] },
        edgeFilter: { predicates: ['calls', 'reads-from', 'writes-to'], minConfidence: 0.5 },
        layoutHint: 'layered',
      },
      {
        id: 'auth-map',
        label: 'Auth Map',
        nodeFilter: { types: ['file', 'config', 'service'], tags: ['auth', 'security'] },
        edgeFilter: { predicates: ['guarded-by'], minConfidence: 0.5 },
        layoutHint: 'force',
      },
    ],
    drilldown: buildDrilldown(factGraph, selectedIds, new Set(edges.map(edge => edge.id))),
  }
  renderGraph.checks = checkRenderGraph(renderGraph)
  return renderGraph
}

function buildGapQueue(factGraph, inventory, options, previousGapQueue = null) {
  const tasks = []
  const nodes = factGraph.nodes || {}
  const edges = Object.values(factGraph.edges || {})
  const sourceFiles = inventory.files.filter(file => SOURCE_CATEGORIES.has(file.category) && !file.protected)
  const coverage = computeCoverage(inventory, factGraph.edges || {}, factGraph.nodes || {})
  const connectedFiles = new Set(coverage.coveredFiles || [])
  const previousTasks = new Map((previousGapQueue?.tasks || []).map(task => [task.id, task]))

  const addTask = (task) => {
    const id = `gap:${hashText(`${task.type}:${task.reason}:${(task.relatedNodes || []).join('|')}`).slice(0, 12)}`
    if (tasks.some(item => item.id === id)) return
    const previous = previousTasks.get(id)
    const relatedNodes = dedupeStrings(task.relatedNodes || [])
      .filter(ref => nodes[ref] || factGraph.edges?.[ref])
    tasks.push({
      id,
      status: previous?.status || 'open',
      priority: task.priority || 'medium',
      explorer: task.explorer,
      type: task.type,
      reason: task.reason,
      relatedNodes,
      suggestedSearches: dedupeStrings(task.suggestedSearches || []).slice(0, 8),
      tokenBudget: task.tokenBudget || explorerTokenBudget(task.explorer, options),
      dispatch: previous?.dispatch,
    })
  }

  for (const file of sourceFiles) {
    if (connectedFiles.has(file.path)) continue
    addTask({
      priority: 'high',
      explorer: explorerForPath(file.path),
      type: 'coverage-gap',
      reason: `${file.path} has no non-containment facts after L1 scan.`,
      relatedNodes: [fileId(file.path)],
      suggestedSearches: [path.basename(file.path).replace(/\.[^.]+$/, ''), file.path],
    })
  }

  for (const edge of edges) {
    if ((edge.source !== 'static' || edge.confidence <= 0.7) && !isExternalVerified(edge)) {
      addTask({
        priority: 'medium',
        explorer: 'adversarial-verify',
        type: 'low-confidence-fact',
        reason: `${edge.subject} ${edge.predicate} ${edge.object} has confidence ${edge.confidence}.`,
        relatedNodes: [edge.subject, edge.object, edge.id],
        suggestedSearches: edge.evidence.map(item => item.file),
      })
    }
  }

  for (const item of factGraph.quality?.unresolvedImports || []) {
    addTask({
      priority: item.kind === 'js-dynamic-import' ? 'high' : 'medium',
      explorer: item.kind === 'js-dynamic-import' ? 'dynamic-import' : 'route-binding',
      type: 'unresolved-import',
      reason: `Import target ${item.target} in ${item.file} was not resolved to a file node: ${item.reason}.`,
      relatedNodes: [fileId(item.file)],
      suggestedSearches: [item.target, item.file],
    })
  }

  for (const hint of factGraph.quality?.semanticHints || []) {
    addTask({
      priority: hint.predicate === 'guarded-by' ? 'medium' : 'low',
      explorer: explorerForPath(hint.file),
      type: 'semantic-hint',
      reason: `${hint.file}:${hint.line} may imply ${hint.predicate} (${hint.signal}); L2 must confirm before it becomes a FactGraph edge.`,
      relatedNodes: [fileId(hint.file)],
      suggestedSearches: [hint.signal, hint.file],
      tokenBudget: explorerTokenBudget(explorerForPath(hint.file), options),
    })
  }

  for (const question of factGraph.openQuestions || []) {
    addTask({
      priority: question.raisedBy === 'coverage-gate' ? 'high' : 'medium',
      explorer: question.raisedBy === 'coverage-gate' ? 'coverage-directed' : question.raisedBy,
      type: 'open-question',
      reason: question.question,
      relatedNodes: question.relatedNodes,
      suggestedSearches: question.relatedNodes?.map(ref => nodes[ref]?.path || nodes[ref]?.label || ref) || [],
    })
  }

  tasks.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.id.localeCompare(b.id))
  return {
    schemaVersion: 'repo-gap-queue/v1',
    generatedAt: factGraph.analyzedAt,
    repoId: factGraph.repoId,
    coverageScore: factGraph.stats.coverageScore,
    coverageThreshold: options.coverageThreshold,
    taskCount: tasks.length,
    openTaskCount: tasks.filter(task => task.status === 'open').length,
    dispatchedTaskCount: tasks.filter(task => task.status === 'dispatched').length,
    tasks,
  }
}

function projectKnowledgeIndex(factGraph) {
  const evidenceRefs = []
  const chunks = []
  const nodes = factGraph.nodes
  const addEvidenceRef = (ref) => {
    if (!ref.id || evidenceRefs.some(item => item.id === ref.id)) return
    evidenceRefs.push(ref)
  }
  const addChunk = (chunk) => {
    if (!chunk.text) return
    chunks.push({
      id: chunk.id,
      kind: chunk.kind,
      title: chunk.title,
      text: chunk.text.slice(0, 4000),
      graphRefs: dedupeStrings(chunk.graphRefs || []),
      evidenceRefs: dedupeStrings(chunk.evidenceRefs || []),
      evidence: chunk.evidence || [],
      metadata: chunk.metadata || {},
    })
  }

  for (const node of Object.values(nodes).filter(item => item.type === 'file')) {
    addEvidenceRef({
      id: `evidence:file:${node.path}`,
      path: node.path,
      kind: node.metadata?.category || 'file',
      summary: `${node.lang || 'File'} ${node.metadata?.category || 'file'}${node.metadata?.protected ? ' metadata-only protected file' : ''}`,
    })
    if (node.metadata?.category === 'manifest') {
      addEvidenceRef({
        id: `evidence:manifest:${node.path}`,
        path: node.path,
        kind: 'manifest',
        summary: `${node.lang || 'Manifest'} manifest`,
      })
    }
  }
  addEvidenceRef({
    id: 'evidence:facts:code-map-symbols',
    path: 'static/code-map.json',
    kind: 'code-map',
    summary: 'Extracted symbols in static code map',
  })
  addEvidenceRef({
    id: 'evidence:facts:code-map-architecture',
    path: 'static/code-map.json',
    kind: 'code-map',
    summary: 'Static architecture view in code map',
  })
  addEvidenceRef({
    id: 'evidence:facts:render-graph',
    path: 'render-graph.json',
    kind: 'render-graph',
    summary: 'Projected render graph derived from FactGraph',
  })

  for (const edge of Object.values(factGraph.edges)) {
    edge.evidence.forEach((evidence, index) => {
      addEvidenceRef({
        id: evidenceRefId(edge.id, index),
        path: evidence.file,
        line: evidence.line,
        endLine: evidence.endLine,
        kind: 'fact-evidence',
        summary: `${edge.predicate} evidence for ${edge.subject} -> ${edge.object}`,
        snippet: evidence.snippet,
      })
    })
    const subject = nodes[edge.subject]
    const object = nodes[edge.object]
    addChunk({
      id: `chunk:fact:${edge.id}`,
      kind: 'fact',
      title: `${subject?.label || edge.subject} ${edgeLabel(edge.predicate)} ${object?.label || edge.object}`,
      text: `${subject?.label || edge.subject} ${edgeLabel(edge.predicate)} ${object?.label || edge.object}. Confidence ${edge.confidence}. Evidence: ${formatEvidenceList(edge.evidence)}.`,
      graphRefs: [edge.id, edge.subject, edge.object],
      evidenceRefs: edge.evidence.map((_, index) => evidenceRefId(edge.id, index)),
      evidence: edge.evidence,
      metadata: {
        lang: subject?.lang || object?.lang,
        module: moduleForPath(subject?.path || object?.path),
        predicates: [edge.predicate],
        confidence: edge.confidence,
        importance: Math.max(subject?.importance || 0, object?.importance || 0),
      },
    })
  }

  for (const node of Object.values(nodes).filter(item => item.type === 'symbol').slice(0, 400)) {
    const related = relatedEdges(factGraph, node.id).slice(0, 12)
    addChunk({
      id: `chunk:symbol:${safeId(node.id)}`,
      kind: 'symbol-card',
      title: node.label,
      text: `${node.label} is a ${node.metadata?.kind || 'symbol'} in ${node.path || 'unknown path'}. Related facts: ${related.map(edge => `${edgeLabel(edge.predicate)} ${nodes[edge.object]?.label || nodes[edge.subject]?.label || ''}`).join('; ')}.`,
      graphRefs: [node.id, ...related.map(edge => edge.id)],
      evidenceRefs: related.flatMap(edge => edge.evidence.map((_, index) => evidenceRefId(edge.id, index))).slice(0, 16),
      evidence: related.flatMap(edge => edge.evidence).slice(0, 16),
      metadata: {
        lang: node.lang,
        module: moduleForPath(node.path),
        predicates: [...new Set(related.map(edge => edge.predicate))],
        confidence: avg(related.map(edge => edge.confidence)),
        importance: node.importance,
      },
    })
  }

  for (const node of Object.values(nodes).filter(item => item.type === 'module')) {
    const related = relatedEdges(factGraph, node.id).slice(0, 18)
    addChunk({
      id: `chunk:module:${safeId(node.id)}`,
      kind: 'module-card',
      title: node.label,
      text: `${node.label} is a module with ${node.metadata?.files || 0} files. Key facts: ${related.map(edge => `${edgeLabel(edge.predicate)} ${nodes[edge.object]?.label || nodes[edge.subject]?.label || ''}`).join('; ')}.`,
      graphRefs: [node.id, ...related.map(edge => edge.id)],
      evidenceRefs: related.flatMap(edge => edge.evidence.map((_, index) => evidenceRefId(edge.id, index))).slice(0, 16),
      evidence: related.flatMap(edge => edge.evidence).slice(0, 16),
      metadata: {
        module: node.path,
        predicates: [...new Set(related.map(edge => edge.predicate))],
        confidence: avg(related.map(edge => edge.confidence)),
        importance: node.importance,
      },
    })
  }

  return {
    schemaVersion: KNOWLEDGE_SCHEMA,
    version: FACT_GRAPH_VERSION,
    repoId: factGraph.repoId,
    repo: factGraph.repo,
    purpose: 'agent-rag-knowledge-index',
    sources: {
      factGraph: 'fact-graph.json',
      renderGraph: 'render-graph.json',
    },
    evidenceRefs,
    chunks,
  }
}

function projectWiki(factGraph, analysis = null) {
  if (analysis?.summary && analysis?.modules?.length) return projectAnalysisWiki(factGraph, analysis)
  return projectMechanicalWiki(factGraph)
}

function projectAnalysisWiki(factGraph, analysis) {
  const files = {}
  const nodes = factGraph.nodes
  const edges = Object.values(factGraph.edges)
  const evidenceEdges = evidenceEdgesByFile(factGraph)
  const markRefs = refs => (refs || [])
    .map(ref => evidenceMarkForEvidenceRef(ref, evidenceEdges))
    .filter(Boolean)
    .slice(0, 4)
    .join(' ')
  files['wiki/README.md'] = [
    `# ${factGraph.repo.name}`,
    '',
    `${analysis.summary} ${markRefs(analysis.evidenceRefs)}`.trim(),
    '',
    `Generated from \`fact-graph.json\` and \`analyses/repo-understanding.json\` at ${factGraph.analyzedAt}.`,
    '',
    '## Architecture Layers',
    '',
    ...(analysis.architecture?.layers || []).map(layer => `- ${layer.name}: ${layer.purpose || ''} ${markRefs(layer.evidenceRefs)}`.trim()),
    '',
    '## Key Modules',
    '',
    ...(analysis.modules || []).slice(0, 12).map(module => `- ${module.name}: ${module.responsibility || ''} ${markRefs(module.evidenceRefs)}`.trim()),
    '',
  ].join('\n')

  files['wiki/architecture.md'] = [
    `# ${factGraph.repo.name} Architecture`,
    '',
    `Style: ${analysis.architecture?.style || 'unknown'} ${markRefs(analysis.evidenceRefs)}`.trim(),
    '',
    '## Components',
    '',
    ...(analysis.architecture?.components || []).map(component => `- ${component.name || component.label}: ${component.responsibility || component.role || ''} ${markRefs(component.evidenceRefs)}`.trim()),
    '',
    '## Connections',
    '',
    ...(analysis.architecture?.connections || []).map(connection => `- ${connection.from || '?'} -> ${connection.to || '?'}: ${connection.label || ''} ${markRefs(connection.evidenceRefs)}`.trim()),
    '',
  ].join('\n')

  files['wiki/key-flows.md'] = [
    `# ${factGraph.repo.name} Key Flows`,
    '',
    ...(analysis.keyFlows || []).flatMap(flow => [
      `## ${flow.name}`,
      '',
      `${Array.isArray(flow.steps) ? flow.steps.join(' -> ') : ''} ${markRefs(flow.evidenceRefs)}`.trim(),
      '',
    ]),
  ].join('\n')

  files['wiki/dependencies.md'] = [
    `# ${factGraph.repo.name} Dependencies`,
    '',
    ...edges
      .filter(edge => edge.predicate === 'depends-on' || edge.predicate === 'imports' || edge.predicate === 'dynamic-imports')
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 160)
      .map(edge => wikiEdgeLine(edge, nodes)),
    '',
  ].join('\n')

  files['wiki/open-questions.md'] = [
    `# ${factGraph.repo.name} Open Questions`,
    '',
    ...(analysis.openQuestions?.length ? analysis.openQuestions.map(question => `- ${question}`) : []),
    ...(factGraph.openQuestions.length ? factGraph.openQuestions.map(question => `- ${question.question} (${question.raisedBy})`) : []),
    ...(analysis.openQuestions?.length || factGraph.openQuestions.length ? [] : ['- None recorded.']),
    '',
  ].join('\n')

  for (const module of analysis.modules || []) {
    const keyFiles = module.keyFiles || []
    const moduleEdges = edges
      .filter(edge => keyFiles.some(file => nodes[edge.subject]?.path === file || nodes[edge.object]?.path === file))
      .slice(0, 80)
    files[`wiki/modules/${safeId(module.name || keyFiles[0] || 'module')}.md`] = [
      `# ${module.name}`,
      '',
      `${module.responsibility || ''} ${markRefs(module.evidenceRefs)}`.trim(),
      '',
      ...moduleEdges.map(edge => wikiEdgeLine(edge, nodes)),
      '',
    ].join('\n')
  }
  return files
}

function projectMechanicalWiki(factGraph) {
  const files = {}
  const nodes = factGraph.nodes
  const edges = Object.values(factGraph.edges)
  const topNodes = Object.values(nodes).sort((a, b) => b.importance - a.importance).slice(0, 30)
  const architectureEdges = edges
    .filter(edge => ['registers', 'depends-on', 'imports', 'dynamic-imports', 'calls', 'routes-to'].includes(edge.predicate))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 60)

  files['wiki/README.md'] = [
    `# ${factGraph.repo.name}`,
    '',
    'L1 mechanical projection. No final synthesis analysis has been written yet, so this wiki is a deterministic graph projection with evidence marks rather than a human-authored architecture narrative.',
    '',
    `Generated from \`fact-graph.json\` at ${factGraph.analyzedAt}.`,
    '',
    '## Entry Points',
    ...topNodes
      .filter(node => node.tags.includes('entrypoint'))
      .slice(0, 12)
      .map(node => `- ${node.label} (${node.path || node.id})${markFirstEdge(factGraph, node.id)}`),
    '',
    '## Highest-Importance Nodes',
    ...topNodes.slice(0, 12).map(node => `- ${node.label} [${node.type}] importance=${node.importance}${markFirstEdge(factGraph, node.id)}`),
    '',
  ].join('\n')

  files['wiki/architecture.md'] = [
    `# ${factGraph.repo.name} Architecture`,
    '',
    `Coverage: ${factGraph.stats.coverageScore}. Average confidence: ${factGraph.stats.avgConfidence}.`,
    '',
    ...architectureEdges.map(edge => wikiEdgeLine(edge, nodes)),
    '',
  ].join('\n')

  files['wiki/key-flows.md'] = [
    `# ${factGraph.repo.name} Key Flows`,
    '',
    ...edges
      .filter(edge => ['routes-to', 'calls', 'guarded-by', 'reads-from', 'writes-to'].includes(edge.predicate))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 120)
      .map(edge => wikiEdgeLine(edge, nodes)),
    '',
  ].join('\n')

  files['wiki/dependencies.md'] = [
    `# ${factGraph.repo.name} Dependencies`,
    '',
    ...edges
      .filter(edge => edge.predicate === 'depends-on' || edge.predicate === 'imports' || edge.predicate === 'dynamic-imports')
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 160)
      .map(edge => wikiEdgeLine(edge, nodes)),
    '',
  ].join('\n')

  files['wiki/open-questions.md'] = [
    `# ${factGraph.repo.name} Open Questions`,
    '',
    ...(factGraph.openQuestions.length
      ? factGraph.openQuestions.map(question => `- ${question.question} (${question.raisedBy})`)
      : ['- None recorded.']),
    '',
  ].join('\n')

  const modules = Object.values(nodes)
    .filter(node => node.type === 'module')
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 80)
  for (const module of modules) {
    const moduleEdges = edges
      .filter(edge => edge.subject === module.id || edge.object === module.id || pathTouchesModule(nodes[edge.subject]?.path, module.path) || pathTouchesModule(nodes[edge.object]?.path, module.path))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 80)
    files[`wiki/modules/${safeId(module.path || module.label)}.md`] = [
      `# ${module.label}`,
      '',
      `Module path: ${module.path || '.'}. Importance: ${module.importance}.${markFirstEdge(factGraph, module.id)}`,
      '',
      ...moduleEdges.map(edge => wikiEdgeLine(edge, nodes)),
      '',
    ].join('\n')
  }
  return files
}

function evidenceEdgesByFile(factGraph) {
  const byFile = new Map()
  for (const edge of Object.values(factGraph.edges || {})) {
    for (const evidence of edge.evidence || []) {
      if (!evidence.file) continue
      const list = byFile.get(evidence.file) || []
      list.push(edge)
      byFile.set(evidence.file, list)
    }
  }
  return byFile
}

function evidenceMarkForEvidenceRef(ref, byFile) {
  const file = String(ref || '').replace(/^evidence:(file|manifest):/, '')
  if (!file || file === ref) return ''
  const edge = byFile.get(file)?.[0]
  return edge ? evidenceMark(edge) : ''
}

function addNode(builder, input) {
  const type = NODE_TYPES.has(input.type) ? input.type : 'symbol'
  const id = input.id || `${type}:${safeId(input.label || input.path)}`
  const existing = builder.nodes.get(id)
  if (existing) {
    addTags(existing, input.tags || [])
    existing.metadata = { ...(existing.metadata || {}), ...(input.metadata || {}) }
    if (!existing.path && input.path) existing.path = input.path
    if (!existing.lang && input.lang) existing.lang = input.lang
    return existing
  }
  const node = {
    id,
    type,
    label: String(input.label || id),
    path: input.path,
    lang: input.lang,
    tags: dedupeStrings(input.tags || []),
    importance: 0,
    metadata: input.metadata || {},
  }
  builder.nodes.set(id, node)
  return node
}

function getNode(builder, id) {
  return builder.nodes.get(id)
}

function addEdge(builder, input) {
  const predicate = normalizePredicate(input.predicate)
  if (!predicate) {
    builder.openQuestions.push(openQuestion(`Rejected edge with unsupported predicate: ${input.predicate}`, [input.subject, input.object].filter(Boolean), 'merger'))
    return null
  }
  if (!builder.nodes.has(input.subject) || !builder.nodes.has(input.object)) {
    builder.openQuestions.push(openQuestion(`Rejected dangling edge: ${input.subject} ${predicate} ${input.object}`, [input.subject, input.object].filter(Boolean), 'merger'))
    return null
  }
  const evidence = normalizeEvidence(input.evidence, input.source || 'static')
    .filter(item => isInventoryEvidence(builder, item))
  if (!evidence.length) {
    builder.openQuestions.push(openQuestion(`Rejected no-evidence edge: ${input.subject} ${predicate} ${input.object}`, [input.subject, input.object], 'merger'))
    return null
  }
  const rawConfidence = confidenceToNumber(input.confidence, input.source === 'inferred' ? CONFIDENCE.inferred : CONFIDENCE.heuristic)
  if (rawConfidence < 0.5) {
    builder.openQuestions.push(openQuestion(`Rejected low-confidence edge: ${input.subject} ${predicate} ${input.object}`, [input.subject, input.object], 'confidence-gate'))
    return null
  }
  const id = edgeId(input.subject, predicate, input.object)
  const metadata = {
    ...(input.predicate === 'contains' ? { coverageEligible: false } : {}),
    ...(input.metadata || {}),
  }
  const existing = builder.edges.get(id)
  if (!existing) {
    const edge = {
      id,
      subject: input.subject,
      predicate,
      object: input.object,
      evidence,
      confidence: round01(rawConfidence),
      source: input.source || 'static',
      firstSeen: builder.generatedAt,
      lastConfirmed: builder.generatedAt,
      metadata,
    }
    builder.edges.set(id, edge)
    return edge
  }
  const existingEvidence = existing.evidence || []
  const existingKeys = new Set(existingEvidence.map(evidenceMergeKey))
  const existingTools = new Set(existingEvidence.map(item => item.tool).filter(Boolean))
  const newEvidence = evidence.filter(item => !existingKeys.has(evidenceMergeKey(item)))
  existing.evidence = dedupeEvidence([...existingEvidence, ...newEvidence])
  const hasIndependentEvidence = newEvidence.some(item => item.tool && !existingTools.has(item.tool))
  if (hasIndependentEvidence) {
    existing.confidence = round01(1 - (1 - existing.confidence) * (1 - rawConfidence))
  }
  existing.source = mergeSource(existing.source, input.source || 'static')
  existing.lastConfirmed = builder.generatedAt
  existing.metadata = { ...(existing.metadata || {}), ...metadata }
  return existing
}

function isInventoryEvidence(builder, evidence) {
  if (!evidence.file) return false
  return !builder.inventoryPaths?.size || builder.inventoryPaths.has(evidence.file)
}

function normalizeEvidence(values, source) {
  const input = Array.isArray(values) ? values : values ? [values] : []
  return input
    .map(item => {
      const file = item.file || item.path
      if (!file) return null
      return {
        file,
        line: finiteNumber(item.line ?? item.startLine),
        endLine: finiteNumber(item.endLine),
        snippet: trimSnippet(item.snippet ?? item.text),
        tool: item.tool || (source === 'dynamic' ? 'repo-explorer' : 'scanner'),
        rawConfidence: confidenceToNumber(item.rawConfidence ?? item.confidence, source === 'inferred' ? CONFIDENCE.inferred : CONFIDENCE.heuristic),
      }
    })
    .filter(Boolean)
}

function normalizeExplorerEvidence(inventory, evidenceValues, bundle, source) {
  const bundleByPath = new Map()
  for (const file of bundle?.files || []) {
    bundleByPath.set(file.path, file)
  }
  return normalizeEvidence(evidenceValues, source)
    .map(evidence => {
      const meta = inventory.files.find(file => file.path === evidence.file)
      if (meta?.protected) return { ...evidence, snippet: undefined, tool: evidence.tool || 'repo-explorer' }
      if (!evidence.snippet && bundleByPath.has(evidence.file)) {
        const excerpt = bundleByPath.get(evidence.file).excerpts?.[0]
        if (excerpt) {
          return {
            ...evidence,
            line: evidence.line || excerpt.startLine,
            endLine: evidence.endLine || excerpt.endLine,
            snippet: trimSnippet(excerpt.text),
          }
        }
      }
      return evidence
    })
}

function evidenceForFile(inventory, filePath, line, tool, rawConfidence) {
  const meta = inventory.files.find(file => file.path === filePath)
  if (!meta || meta.protected || !meta.contentAnalyzable || !line) {
    return { file: filePath, line, tool, rawConfidence }
  }
  const text = safeRead(path.join(inventory.repo.path, filePath))
  if (!text) return { file: filePath, line, tool, rawConfidence }
  const lines = text.split(/\r?\n/)
  const start = Math.max(1, line - 1)
  const end = Math.min(lines.length, line + 1)
  return {
    file: filePath,
    line: start,
    endLine: end,
    snippet: trimSnippet(lines.slice(start - 1, end).join('\n')),
    tool,
    rawConfidence,
  }
}

function evidenceForLine(file, line, text, tool, rawConfidence) {
  return { file, line, endLine: line, snippet: trimSnippet(text), tool, rawConfidence }
}

function semanticHint(file, line, predicate, signal, text, tool) {
  return {
    id: `hint:${hashText(`${file}:${line}:${predicate}:${signal}`).slice(0, 12)}`,
    file,
    line,
    predicate,
    signal,
    tool,
    snippet: trimSnippet(text),
  }
}

function computeCoverage(inventory, edges, nodes = null) {
  const sourceFiles = inventory.files
    .filter(file => SOURCE_CATEGORIES.has(file.category) && !file.protected)
    .map(file => file.path)
  const connected = new Set()
  const symbolConnected = new Set()
  for (const edge of Object.values(edges)) {
    const subjectFile = filePathForGraphRef(edge.subject, nodes)
    const objectFile = filePathForGraphRef(edge.object, nodes)
    if (edge.predicate === 'contains' && subjectFile) symbolConnected.add(subjectFile)
    if (edge.metadata?.coverageEligible === false || edge.predicate === 'contains') continue
    for (const file of [subjectFile, objectFile].filter(Boolean)) {
      const other = file === subjectFile ? objectFile : subjectFile
      if (other && other === file) continue
      connected.add(file)
    }
  }
  const covered = sourceFiles.filter(file => connected.has(file)).length
  const symbolCovered = sourceFiles.filter(file => symbolConnected.has(file)).length
  return {
    total: sourceFiles.length,
    covered,
    score: round01(covered / Math.max(1, sourceFiles.length)),
    coveredFiles: sourceFiles.filter(file => connected.has(file)),
    isolated: sourceFiles.filter(file => !connected.has(file)),
    symbolCovered,
    symbolExtractionRate: round01(symbolCovered / Math.max(1, sourceFiles.length)),
  }
}

function filePathForGraphRef(ref, nodes) {
  if (!ref) return ''
  if (ref.startsWith('file:')) return ref.slice('file:'.length)
  const node = nodes?.[ref]
  if (!node) return ''
  if (node.type === 'file') return node.path || ''
  return node.path && /\.[A-Za-z0-9]+$/.test(node.path) ? node.path : ''
}

function selectRenderNodes(factGraph, limit) {
  const nodes = Object.values(factGraph.nodes)
  const required = nodes.filter(node => ['module', 'route', 'service', 'datastore', 'config'].includes(node.type) || node.tags.includes('entrypoint'))
  const optional = nodes
    .filter(node => !required.includes(node))
    .sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id))
  return dedupeBy([...required, ...optional].slice(0, limit), item => item.id)
}

function buildDrilldown(factGraph, selectedNodeIds, selectedEdgeIds) {
  const drilldown = {}
  for (const nodeId of selectedNodeIds) {
    const node = factGraph.nodes[nodeId]
    const edges = relatedEdges(factGraph, nodeId)
      .filter(edge => selectedEdgeIds.has(edge.id))
      .slice(0, 40)
    drilldown[nodeId] = {
      kind: 'node',
      nodeId,
      label: node.label,
      path: node.path,
      evidence: edges.flatMap(edge => edge.evidence).slice(0, 20),
      edges: edges.map(edge => edge.id),
    }
  }
  for (const edgeId of selectedEdgeIds) {
    const edge = factGraph.edges[edgeId]
    drilldown[edgeId] = {
      kind: 'edge',
      edgeId,
      subject: edge.subject,
      predicate: edge.predicate,
      object: edge.object,
      confidence: edge.confidence,
      evidence: edge.evidence,
    }
  }
  return drilldown
}

function checkRenderGraph(renderGraph) {
  const issues = []
  const warnings = []
  const nodeIds = new Set(renderGraph.nodes.map(node => node.id))
  for (const edge of renderGraph.edges) {
    if (!nodeIds.has(edge.subject)) issues.push(`Dangling render edge subject: ${edge.id}`)
    if (!nodeIds.has(edge.object)) issues.push(`Dangling render edge object: ${edge.id}`)
    if (!edge.evidence?.length) issues.push(`Render edge has no evidence: ${edge.id}`)
  }
  for (const group of renderGraph.groups) {
    const missing = group.nodes.filter(id => !nodeIds.has(id))
    if (missing.length) issues.push(`Render group ${group.id} references missing nodes: ${missing.slice(0, 5).join(', ')}`)
  }
  for (const view of renderGraph.views) {
    const minConfidence = view.edgeFilter?.minConfidence ?? 0
    const matchingEdges = renderGraph.edges.filter(edge => {
      if (view.edgeFilter?.predicates && !view.edgeFilter.predicates.includes(edge.predicate)) return false
      return edge.confidence >= minConfidence
    })
    if (matchingEdges.length > 1200) warnings.push(`View ${view.id} has ${matchingEdges.length} edges; consumer should collapse modules first`)
  }
  return {
    passed: issues.length === 0,
    issues,
    warnings,
  }
}

function refreshPackageIndex(root, artifacts) {
  const indexPath = path.join(root, 'index.json')
  if (!fs.existsSync(indexPath)) return
  const index = readJson(indexPath)
  index.factGraph = 'fact-graph.json'
  index.products = {
    ...(index.products || {}),
    inventory: 'inventory.json',
    gapQueue: 'gap-queue.json',
    verification: 'verification.json',
    factGraph: 'fact-graph.json',
    store: 'store/',
    renderGraph: 'render-graph.json',
    knowledgeIndexJson: 'knowledge-index.json',
    knowledgeIndexJsonl: 'knowledge-index.jsonl',
    wiki: 'wiki/',
  }
  index.static = {
    ...(index.static || {}),
    renderGraph: 'static/render-graph.json',
    knowledgeIndex: 'static/knowledge-index.json',
  }
  index.counts = {
    ...(index.counts || {}),
    factNodes: Object.keys(artifacts.factGraph.nodes).length,
    factEdges: Object.keys(artifacts.factGraph.edges).length,
    coverageScore: artifacts.factGraph.stats.coverageScore,
    gapTasks: artifacts.gapQueue?.taskCount ?? artifacts.gapQueue?.tasks?.length ?? index.counts?.gapTasks,
    verifiedEdges: artifacts.verification?.checkedEdges,
    removedByVerifier: artifacts.verification?.removedEdges,
    renderNodes: artifacts.renderGraph.nodes.length,
    renderEdges: artifacts.renderGraph.edges.length,
    knowledgeRefs: artifacts.knowledgeIndex.evidenceRefs.length,
    knowledgeChunks: artifacts.knowledgeIndex.chunks.length,
  }
  index.updatedAt = new Date().toISOString()
  writeJson(indexPath, index)
}

function writeGraphStore(root, factGraph) {
  const storeDir = path.join(root, 'store')
  ensureDir(storeDir)
  writeJson(path.join(storeDir, 'manifest.json'), {
    schemaVersion: 'repo-fact-graph-store/v1',
    repoId: factGraph.repoId,
    analyzedAt: factGraph.analyzedAt,
    backend: 'jsonl',
    files: {
      nodes: 'nodes.jsonl',
      edges: 'edges.jsonl',
      openQuestions: 'open-questions.jsonl',
    },
  })
  fs.writeFileSync(path.join(storeDir, 'nodes.jsonl'), `${Object.values(factGraph.nodes || {}).map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8')
  fs.writeFileSync(path.join(storeDir, 'edges.jsonl'), `${Object.values(factGraph.edges || {}).map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8')
  fs.writeFileSync(path.join(storeDir, 'open-questions.jsonl'), `${(factGraph.openQuestions || []).map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8')
}

function buildImportResolver(inventory) {
  const paths = new Set((inventory.files || []).map(file => file.path))
  const aliases = [
    ...readAliasConfig(inventory.repo?.path || '', paths),
    ...readTsPathAliases(inventory.repo?.path || '', paths),
  ]
  if ([...paths].some(file => file.startsWith('src/'))) {
    aliases.push({ alias: '@', target: 'src' })
    aliases.push({ alias: '_', target: 'src' })
  }
  return {
    paths,
    aliases: dedupeBy(aliases.filter(item => item.alias && item.target), item => `${item.alias}:${item.target}`)
      .sort((a, b) => b.alias.length - a.alias.length),
    srcDirs: new Set(
      [...paths]
        .filter(file => file.startsWith('src/') && file.slice(4).includes('/'))
        .map(file => file.slice(4).split('/')[0]),
    ),
    topDirs: new Set([...paths].filter(file => file.includes('/')).map(file => file.split('/')[0])),
  }
}

function resolveImportTarget(inventory, fromFile, target, resolver = buildImportResolver(inventory)) {
  const normalizedTarget = normalizeImportTarget(target)
  if (!normalizedTarget) return { unresolved: true, reason: 'empty import target' }

  if (normalizedTarget.startsWith('.') || normalizedTarget.startsWith('/')) {
    const resolved = resolveRelativeImport(resolver.paths, fromFile, normalizedTarget)
    if (resolved) {
      return resolvedFileNode(inventory, resolved)
    }
    return { unresolved: true, reason: 'relative import did not resolve to an inventory file' }
  }

  const aliasBase = expandAliasTarget(normalizedTarget, resolver)
  if (aliasBase) {
    const resolved = resolveBareImport(resolver.paths, aliasBase)
    if (resolved) return resolvedFileNode(inventory, resolved)
    return { unresolved: true, reason: `alias import ${target} expanded to ${aliasBase} but did not resolve` }
  }

  const heuristicBase = expandInternalHeuristic(normalizedTarget, resolver)
  if (heuristicBase) {
    const resolved = resolveBareImport(resolver.paths, heuristicBase)
    if (resolved) return resolvedFileNode(inventory, resolved)
    return { unresolved: true, reason: `internal-looking import ${target} did not resolve` }
  }

  const pkg = packageNameFromImport(normalizedTarget)
  if (!pkg || pkg === '.' || pkg.startsWith('@/') || resolver.topDirs.has(pkg)) {
    return { unresolved: true, reason: `import target ${target} is not a valid external package` }
  }
  return {
    resolved: false,
    node: {
      id: packageId(pkg),
      type: 'package',
      label: pkg,
      tags: ['external'],
      metadata: { importTarget: target },
    },
  }
}

function normalizeImportTarget(target) {
  return normalizePath(String(target || '').split(/[?#]/)[0]).replace(/\/{2,}/g, '/')
}

function resolvedFileNode(inventory, resolved) {
  return {
    resolved: true,
    node: {
      id: fileId(resolved),
      type: 'file',
      label: path.basename(resolved),
      path: resolved,
      lang: inventory.files.find(file => file.path === resolved)?.language,
      tags: ['import-target'],
    },
  }
}

function resolveRelativeImport(paths, fromFile, target) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target))
  return resolveBareImport(paths, base)
}

function resolveBareImport(paths, base) {
  const normalized = normalizePath(base).replace(/^\/+/, '')
  const candidates = [
    normalized,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.mjs`,
    `${normalized}.vue`,
    `${normalized}.json`,
    `${normalized}.less`,
    `${normalized}.css`,
    `${normalized}.java`,
    `${normalized}/index.js`,
    `${normalized}/index.jsx`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `${normalized}/index.mjs`,
    `${normalized}/index.vue`,
    `${normalized}/index.json`,
  ]
  return candidates.find(candidate => paths.has(candidate))
}

function expandAliasTarget(target, resolver) {
  for (const alias of resolver.aliases) {
    if (target === alias.alias) return alias.target
    if (target.startsWith(`${alias.alias}/`)) return `${alias.target}/${target.slice(alias.alias.length + 1)}`
  }
  return ''
}

function expandInternalHeuristic(target, resolver) {
  if (!target || target.startsWith('.') || target.startsWith('/') || target.startsWith('@')) return ''
  const [first, ...rest] = target.split('/')
  if (!rest.length) return ''
  if (resolver.topDirs.has(first)) return target
  if (resolver.srcDirs.has(first)) return `src/${target}`
  return ''
}

function readAliasConfig(repoPath, paths) {
  const aliases = []
  for (const rel of ['vue.config.js', 'webpack.config.js', 'webpack.config.cjs', 'vite.config.js', 'vite.config.ts']) {
    if (!paths.has(rel)) continue
    const text = safeRead(path.join(repoPath, rel))
    for (const match of text.matchAll(/\.set\(\s*['"]([^'"]+)['"]\s*,\s*resolve\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      aliases.push({ alias: match[1], target: normalizePath(match[2]) })
    }
    for (const match of text.matchAll(/['"]([^'"]+)['"]\s*:\s*(?:path\.)?resolve\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)/g)) {
      aliases.push({ alias: match[1], target: normalizePath(match[2]) })
    }
  }
  return aliases
}

function readTsPathAliases(repoPath, paths) {
  const aliases = []
  for (const rel of ['tsconfig.json', 'jsconfig.json']) {
    if (!paths.has(rel)) continue
    const parsed = readJsonLoose(path.join(repoPath, rel))
    const baseUrl = normalizePath(parsed?.compilerOptions?.baseUrl || '.')
    const pathMap = parsed?.compilerOptions?.paths || {}
    for (const [aliasPattern, targets] of Object.entries(pathMap)) {
      const targetPattern = Array.isArray(targets) ? targets[0] : targets
      if (!targetPattern) continue
      const alias = aliasPattern.replace(/\/\*$/, '')
      const target = normalizePath(path.posix.join(baseUrl, String(targetPattern).replace(/\/\*$/, '')))
      aliases.push({ alias, target })
    }
  }
  return aliases
}

function readJsonLoose(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    return JSON.parse(text)
  } catch {
    return null
  }
}

function resolveExplorerNode(builder, inventory, value, hintedType) {
  if (typeof value === 'object' && value) {
    const type = NODE_TYPES.has(value.type || hintedType) ? (value.type || hintedType) : 'symbol'
    const id = value.id || idForTypedValue(type, value.path || value.name || value.label)
    return addNode(builder, {
      id,
      type,
      label: value.label || value.name || value.path || id,
      path: value.path,
      lang: value.lang,
      tags: ['dynamic'],
      metadata: value.metadata || {},
    })
  }
  const text = String(value || '').trim()
  if (!text) {
    return addNode(builder, { id: serviceId('unknown-explorer-node'), type: 'service', label: 'unknown-explorer-node', tags: ['dynamic', 'unknown'] })
  }
  if (builder.nodes.has(text)) return builder.nodes.get(text)
  const existingFile = inventory.files.find(file => file.path === text)
  if (existingFile) return addNode(builder, { id: fileId(text), type: 'file', label: path.basename(text), path: text, lang: existingFile.language, tags: ['dynamic'] })
  let type = NODE_TYPES.has(hintedType) ? hintedType : inferExplorerType(text)
  if (type === 'file') {
    type = looksExternalImportTarget(text) ? 'package' : 'service'
  }
  return addNode(builder, {
    id: idForTypedValue(type, text),
    type,
    label: labelFromTypedValue(text),
    path: type === 'file' ? text : undefined,
    tags: ['dynamic'],
    metadata: { rawRef: text },
  })
}

function callSignal(line) {
  if (/RemoteServiceFactory|getService\(|@DubboReference|@FeignClient|RestTemplate|WebClient|HttpClient|OkHttp|axios\.|fetch\(|XMLHttpRequest|grpc|Hessian|httpinvoke/i.test(line)) {
    return { kind: 'remote-call', label: extractQuoted(line) || 'remote-service' }
  }
  if (/KafkaTemplate|RocketMQ|RabbitTemplate|JmsTemplate|sendMessage|publish|producer|consumer|topic/i.test(line)) {
    return { kind: 'async-call', label: extractQuoted(line) || 'message-bus' }
  }
  return null
}

function guardSignal(line, filePath) {
  if (/@PreAuthorize|@RequiresPermissions|@Secured|\bv-hasPermission\b|\b(permissionIds|permissions|roles|auth|security|token|jwt|oauth|shiro)\b|SecurityFilter|AuthFilter|FilterRegistration/i.test(line)) {
    return { kind: 'auth-guard', label: securityLabelFromLine(line, filePath) }
  }
  return null
}

function dataSignal(line, filePath) {
  if (/RedisTemplate|CacheManager|@Cacheable|\bcacheNames?\b/i.test(line)) return { kind: 'cache', label: 'cache', write: /\b(put|set|write|save|update)\b/i.test(line) }
  if (/\b(Kafka|RocketMQ|topic|queue|exchange)\b/i.test(line)) return { kind: 'topic', label: 'topic', write: /\b(send|publish|produce|write)\b/i.test(line) }
  if (/@Table|@Entity|Mapper\b|Repository\b|JdbcTemplate|DataSource|\bSELECT\b\s+|\bINSERT\b\s+|\bUPDATE\b\s+|\bDELETE\b\s+/i.test(line)) {
    return { kind: 'database', label: tableNameFromLine(line) || (/(mapper|dao|repository|entity)/i.test(filePath) ? moduleForPath(filePath) : 'database'), write: /\b(INSERT|UPDATE|DELETE|save|update|delete|insert)\b/i.test(line) }
  }
  return null
}

function shouldScanLineFacts(filePath) {
  return /(application|bootstrap|config|web\.xml|router|route|controller|service|facade|api|handler|filter|interceptor|listener|consumer|scheduler|job|mq|kafka|rocket|redis|cache|dao|mapper|repository|entity|datasource|client|rpc|http|security|auth|permission|\.vue$|\.tsx?$|\.jsx?$|\.java$|\.xml$|\.yml$|\.yaml$|\.properties$)/i.test(filePath)
}

function normalizeOpenQuestionValues(values) {
  return (Array.isArray(values) ? values : values ? [values] : []).map(item => {
    if (typeof item === 'string') return { question: item, relatedNodes: [], raisedBy: 'repo-explorer' }
    return {
      question: String(item.question || item.title || item.finding || '').trim(),
      relatedNodes: Array.isArray(item.relatedNodes) ? item.relatedNodes : [],
      raisedBy: item.raisedBy || item.explorer || 'repo-explorer',
    }
  }).filter(item => item.question)
}

function normalizePredicate(value) {
  return EDGE_PREDICATES.has(value) ? value : null
}

function mergeSource(a, b) {
  if (a === b) return a
  if (a === 'inferred') return b
  if (b === 'inferred') return a
  if (a === 'dynamic' || b === 'dynamic') return 'dynamic'
  return 'static'
}

function confidenceToNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value))
  if (value === 'high') return 0.9
  if (value === 'medium') return 0.7
  if (value === 'low') return 0.5
  return fallback
}

function idForTypedValue(type, value) {
  if (type === 'file') return fileId(value)
  if (type === 'module') return moduleId(value)
  if (type === 'route') return routeId(undefined, value)
  if (type === 'package') return packageId(value)
  if (type === 'service') return serviceId(value)
  if (type === 'config') return configId(value)
  if (type === 'datastore') return datastoreId(value)
  return `symbol:${safeId(value)}`
}

function inferExplorerType(value) {
  if (looksExternalImportTarget(value)) return 'package'
  if (/\.(js|jsx|ts|tsx|vue|java|go|py|xml|yml|yaml|json|properties|less|css|scss)$/.test(value) || value.includes('/')) return 'file'
  if (/^\/[A-Za-z0-9_./:-]*$/.test(value)) return 'route'
  if (/^[A-Za-z0-9_.@/-]+$/.test(value) && (value.includes('@') || value.includes('.') || value.includes('/'))) return 'package'
  return 'service'
}

function looksExternalImportTarget(value) {
  const text = String(value || '').replace(/^package:/, '')
  if (text.startsWith('~/')) return false
  if (text.startsWith('~')) return true
  if (text.startsWith('@/') || text.startsWith('_/') || text.startsWith('./') || text.startsWith('../') || text.startsWith('/')) return false
  if (text.startsWith('@')) return true
  return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_./@-]+$/.test(text) && !text.startsWith('src/')
}

function labelFromTypedValue(value) {
  return value.includes('/') ? path.posix.basename(value) || value : value
}

function formatEvidenceList(evidence) {
  return evidence.map(item => `${item.file}${item.line ? `:${item.line}` : ''}`).join(', ')
}

function relatedEdges(factGraph, nodeId) {
  return Object.values(factGraph.edges).filter(edge => edge.subject === nodeId || edge.object === nodeId)
}

function markFirstEdge(factGraph, nodeId) {
  const edge = relatedEdges(factGraph, nodeId)[0]
  return edge ? ` ${evidenceMark(edge)}` : ''
}

function wikiEdgeLine(edge, nodes) {
  return `- ${nodes[edge.subject]?.label || edge.subject} ${edgeLabel(edge.predicate)} ${nodes[edge.object]?.label || edge.object} ${evidenceMark(edge)}`
}

function evidenceMark(edge) {
  const evidence = edge.evidence[0] || {}
  return `[e:${edge.id} -> ${evidence.file || 'unknown'}${evidence.line ? `:${evidence.line}` : ''}]`
}

function pathTouchesModule(filePath, modulePath) {
  if (!filePath || !modulePath) return false
  return modulePath === '.' || filePath === modulePath || filePath.startsWith(`${modulePath}/`)
}

function edgeLabel(predicate) {
  return predicate.replace(/-/g, ' ')
}

function edgeStyle(edge) {
  return {
    variant: edge.source === 'inferred' ? 'dashed' : edge.confidence < 0.7 ? 'soft' : 'solid',
    opacity: Math.max(0.25, edge.confidence),
    width: edge.confidence >= 0.9 ? 2 : 1,
  }
}

function explorerForPath(filePath) {
  if (/\.vue$|components?|views?|pages?/i.test(filePath)) return 'vue-containment'
  if (/route|router|controller|mapping/i.test(filePath)) return 'route-binding'
  if (/auth|security|permission|filter|interceptor|guard/i.test(filePath)) return 'auth-chain'
  if (/dao|mapper|repository|entity|sql|datasource|redis|cache/i.test(filePath)) return 'data-access'
  if (/client|facade|rpc|http|mq|kafka|rocket|queue|consumer|producer/i.test(filePath)) return 'call-chain'
  return 'coverage-directed'
}

function explorerTokenBudget(explorer, options = {}) {
  if (options.explorerBudgets?.[explorer]) return options.explorerBudgets[explorer]
  return {
    'vue-containment': 12000,
    'route-binding': 12000,
    'dynamic-import': 10000,
    'call-chain': 18000,
    'auth-chain': 14000,
    'data-access': 16000,
    'adversarial-verify': 8000,
    'coverage-directed': 10000,
  }[explorer] || 10000
}

function priorityRank(priority) {
  return { high: 0, medium: 1, low: 2 }[priority] ?? 1
}

function layoutPosition(node, index) {
  const column = {
    module: 0,
    route: 1,
    file: 2,
    symbol: 3,
    service: 4,
    config: 1,
    datastore: 5,
    package: 5,
  }[node.type] ?? 2
  const row = index % 60
  return [80 + column * 220, 80 + row * 82]
}

function moduleForPath(filePath) {
  if (!filePath) return undefined
  return filePath.includes('/') ? filePath.split('/')[0] : '.'
}

function moduleId(value) {
  return `module:${safeId(value || '.')}`
}

function fileId(value) {
  return `file:${normalizePath(value)}`
}

function symbolId(file, kind, name) {
  return `symbol:${safeId(`${file}:${kind}:${name}`)}`
}

function routeId(method, value) {
  return `route:${safeId(`${method || 'ANY'}:${value || '/'}`)}`
}

function packageId(value) {
  return `package:${safeId(packageNameFromImport(value))}`
}

function serviceId(value) {
  return `service:${safeId(value || 'service')}`
}

function configId(value) {
  return `config:${safeId(value || 'config')}`
}

function datastoreId(value) {
  return `datastore:${safeId(value || 'datastore')}`
}

function edgeId(subject, predicate, object) {
  return `edge:${hashText(`${subject}|${predicate}|${object}`).slice(0, 16)}`
}

function evidenceRefId(edgeIdValue, index) {
  return `evidence:${edgeIdValue}:${index}`
}

function repoId(repo) {
  return hashText(`${repo.path || repo.name}:${repo.git?.head || ''}:${repo.git?.remote || ''}`).slice(0, 20)
}

function packageNameFromImport(value) {
  const text = String(value || 'unknown').replace(/^~/, '')
  if (text.startsWith('@')) return text.split('/').slice(0, 2).join('/')
  return text.split('/')[0] || text
}

function firstFileForDir(files, dir) {
  return files.find(file => dir === '.' || file.path.startsWith(`${dir}/`))?.path
}

function topDir(filePath) {
  return filePath.includes('/') ? filePath.split('/')[0] : '.'
}

function manifestPathForDependency(codeMap, dep) {
  const manifest = (codeMap.manifests || [])[0]
  return manifest?.path || 'manifest'
}

function extractQuoted(line) {
  return line.match(/["']([^"']{2,120})["']/)?.[1]
}

function securityLabelFromLine(line, filePath) {
  if (/@PreAuthorize\b/.test(line)) return '@PreAuthorize'
  if (/@RequiresPermissions\b/.test(line)) return '@RequiresPermissions'
  if (/\bv-hasPermission\b/.test(line)) return 'v-hasPermission'
  if (/\bpermissionIds\b/.test(line)) return 'permissionIds'
  if (/\btoken\b/i.test(line)) return 'token'
  return /(shiro|security|auth|permission)/i.test(filePath) ? filePath : 'security-policy'
}

function tableNameFromLine(line) {
  return line.match(/\b(?:from|into|update|table)\s+([A-Za-z_][\w.]*)/i)?.[1]
}

function addTags(node, tags) {
  node.tags = dedupeStrings([...(node.tags || []), ...(tags || [])])
}

function dedupeEvidence(values) {
  return dedupeBy(values, evidenceMergeKey)
}

function evidenceMergeKey(item) {
  return `${item.tool || ''}:${item.file || ''}:${item.line || ''}`
}

function dedupeOpenQuestions(values) {
  return dedupeBy(values.filter(item => item.question), item => `${item.question}:${(item.relatedNodes || []).join(',')}`)
}

function openQuestion(question, relatedNodes = [], raisedBy = 'harness') {
  return {
    id: `oq:${hashText(`${question}:${relatedNodes.join(',')}`).slice(0, 12)}`,
    question,
    relatedNodes: dedupeStrings(relatedNodes),
    raisedBy,
  }
}

function avg(values) {
  const nums = values.filter(value => Number.isFinite(value))
  return nums.length ? round01(nums.reduce((sum, value) => sum + value, 0) / nums.length) : 0
}

function round01(value) {
  if (!Number.isFinite(value)) return 0
  return Number(Math.max(0, Math.min(1, value)).toFixed(3))
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function trimSnippet(value) {
  if (!value) return undefined
  const lines = String(value).split(/\r?\n/).slice(0, 3)
  return lines.join('\n').slice(0, 1200)
}

function normalizePath(value) {
  return String(value || '').split(path.sep).join('/')
}

function safeId(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

function hashText(text) {
  return createHash('sha1').update(String(text)).digest('hex')
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null
  return readJson(file)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function dedupeStrings(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))]
}

function dedupeBy(items, keyFn) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

export { EXPLORATION_FACT_SCHEMA }
