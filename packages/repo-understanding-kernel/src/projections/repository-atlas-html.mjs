import fs from 'node:fs'
import path from 'node:path'

export const REPOSITORY_ATLAS_SCHEMA = 'repo-repository-atlas-html/v1'

const STAGE_DEFINITIONS = Object.freeze([
  ['snapshot', 'Snapshot', '冻结本次分析的仓库身份与文件清单', ['index.json', 'static/inventory.json']],
  ['support', 'Support Decision', '确认前端范围与不支持边界', ['static/support-decision.json']],
  ['static-graph', 'Static Program Graph', '构建文件、符号、组件与依赖关系', ['static/static-program-graph.json', 'static/code-map.json', 'static/community-map.json', 'static/neighbor-map.json']],
  ['investigation', 'Investigation Frame', '整理页面、状态、API 与候选入口', ['static/investigation-frame.json', 'store/journeys/manifest.json']],
  ['research-plan', 'Semantic Planning', '选择待解释节点并限定局部 AST 邻域', ['planning/node-semantic-batches.json', 'planning/manifest.json']],
  ['agent-research', 'Node Semantics', '为文件卡片补充有源码证据的局部语义', ['store/node-semantics.json', 'store/semantic-store-manifest.json']],
  ['semantic-zoning', 'Agent Domain Zoning', '由 Domain Agent 基于已接纳节点语义与代码关系发现仓库领域，再经独立 Agent 审核接纳', ['planning/repository-zone-agent-plan.json', 'research/repository-zones/context.json', 'research/repository-zones/result.json', 'research/repository-zones/review.json', 'planning/repository-zones.json']],
  ['domain-understanding', 'Agent Domain Understanding', '沿用已审核的仓库领域，由独立 Agent 解释各领域的职责、入口、核心、边界与协作关系', ['planning/repository-domain-summary-agent-plan.json', 'research/repository-domain-summaries/context.json', 'research/repository-domain-summaries/result.json', 'research/repository-domain-summaries/review.json', 'store/repository-domain-summaries.json']],
  ['product-maps', 'Product Maps', '生成 Application、Experience、Runtime 与 Change Map', ['projections/manifest.json']],
  ['synthesis', 'Synthesis', '生成有证据约束的仓库叙事', ['synthesis/narrative.json']],
  ['human-readable', 'Human-readable', '生成最终可阅读交付页面', ['human-readable.html']],
  ['verify', 'Verify', '验证阶段产物、闭环与交付一致性', ['verification/frontend-verification.json']],
])

export function generateRepositoryAtlasHtml(options = {}) {
  if (!options.packageDir) throw new Error('generateRepositoryAtlasHtml requires packageDir')
  const packageDir = path.resolve(options.packageDir)
  const outFile = path.resolve(options.outFile || path.join(packageDir, 'repository-atlas.html'))
  const model = buildRepositoryAtlasModel(packageDir)
  const html = renderRepositoryAtlasHtml(model)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, html, 'utf8')
  return {
    schemaVersion: REPOSITORY_ATLAS_SCHEMA,
    packageDir,
    output: outFile,
    repo: model.repo,
    snapshotId: model.snapshotId,
    currentStage: model.progress.currentStage,
    completedStages: model.progress.completedStages,
    files: model.summary.files,
    graphNodes: model.graph.nodes.length,
    graphEdges: model.graph.edges.length,
  }
}

export function buildRepositoryAtlasModel(packageDir) {
  const root = path.resolve(packageDir)
  const index = readOptional(root, 'index.json')
  const inventory = readOptional(root, 'static/inventory.json') || { files: [], counts: {} }
  const support = readOptional(root, 'static/support-decision.json')
  const graph = readOptional(root, 'static/static-program-graph.json') || { nodes: [], edges: [], diagnostics: [] }
  const codeMap = readOptional(root, 'static/code-map.json') || { routes: [], symbols: [], imports: [], relationships: [] }
  const communities = readOptional(root, 'static/community-map.json') || { communities: [] }
  const frame = readOptional(root, 'static/investigation-frame.json')
  const planning = readOptional(root, 'planning/manifest.json')
  const questions = readOptional(root, 'planning/open-questions.json')
  const nodeSemanticPlan = readOptional(root, 'planning/node-semantic-batches.json')
  const repositoryZoneAgentPlan = readOptional(root, 'planning/repository-zone-agent-plan.json')
  const repositoryZoneDraft = readOptional(root, 'research/repository-zones/result.json')
  const repositoryZoneReview = readOptional(root, 'research/repository-zones/review.json')
  const repositoryZonePlanCandidate = readOptional(root, 'planning/repository-zones.json')
  const repositoryZonePlan = repositoryZonePlanCandidate?.schemaVersion === 'repo-repository-zones/v2' && repositoryZonePlanCandidate?.status === 'complete'
    ? repositoryZonePlanCandidate
    : null
  const repositoryDomainSummaryAgentPlan = readOptional(root, 'planning/repository-domain-summary-agent-plan.json')
  const repositoryDomainSummaryDraft = readOptional(root, 'research/repository-domain-summaries/result.json')
  const repositoryDomainSummaryReview = readOptional(root, 'research/repository-domain-summaries/review.json')
  const repositoryDomainSummariesCandidate = readOptional(root, 'store/repository-domain-summaries.json')
  const repositoryDomainSummariesCatalog = repositoryDomainSummariesCandidate?.schemaVersion === 'repo-repository-domain-summaries/v1'
    && repositoryDomainSummariesCandidate?.status === 'complete'
    ? repositoryDomainSummariesCandidate
    : null
  const workflow = readOptional(root, 'state/run-state.json')
  const journeys = readOptional(root, 'store/journeys/manifest.json')
  const projectionManifest = readOptional(root, 'projections/manifest.json')
  const narrative = readOptional(root, 'synthesis/narrative.json')
  const verification = readOptional(root, 'verification/frontend-verification.json')
  const semanticManifest = readOptional(root, 'store/semantic-store-manifest.json')
  const nodeSemantics = readOptional(root, 'store/node-semantics.json')

  const fileModel = buildFileModel({ inventory, graph, codeMap, nodeSemantics })
  const graphModel = buildFileGraph({ files: fileModel, graph, communities })
  const stages = buildStages({
    root,
    inventory,
    support,
    graph,
    frame,
    planning,
    questions,
    nodeSemanticPlan,
    repositoryZoneAgentPlan,
    repositoryZoneDraft,
    repositoryZoneReview,
    repositoryZonePlan,
    repositoryDomainSummaryAgentPlan,
    repositoryDomainSummaryDraft,
    repositoryDomainSummaryReview,
    repositoryDomainSummariesCatalog,
    workflow,
    journeys,
    projectionManifest,
    narrative,
    verification,
    semanticManifest,
    nodeSemantics,
  })
  const current = stages.find(stage => ['active', 'blocked', 'ready'].includes(stage.status))
    || stages.find(stage => stage.status === 'waiting')
    || stages.at(-1)
  let completedStages = 0
  for (const stage of stages) {
    if (stage.status !== 'complete') break
    completedStages += 1
  }
  const diagnosticSummary = countBy(graph.diagnostics || [], item => item.kind || 'unknown')
  const edgeSummary = {}
  for (const edge of graphModel.edges) {
    for (const [type, count] of Object.entries(edge.types)) edgeSummary[type] = (edgeSummary[type] || 0) + count
  }
  const nodeSummary = countBy(graph.nodes || [], item => String(item.nodeId || '').split(':')[0] || 'unknown')
  const repositoryZones = buildRepositoryZoneModel(repositoryZonePlan, fileModel, {
    agentPlan: repositoryZoneAgentPlan,
    draft: repositoryZoneDraft,
    review: repositoryZoneReview,
  })
  const repositoryDomainSummaries = buildRepositoryDomainSummaryModel(repositoryDomainSummariesCatalog, {
    agentPlan: repositoryDomainSummaryAgentPlan,
    draft: repositoryDomainSummaryDraft,
    review: repositoryDomainSummaryReview,
  })

  return {
    schemaVersion: REPOSITORY_ATLAS_SCHEMA,
    generatedAt: new Date().toISOString(),
    repo: {
      name: index?.repo?.name || inventory?.repo?.name || path.basename(root),
      path: index?.repo?.path || inventory?.repo?.path || null,
      branch: index?.repo?.git?.branch || inventory?.repo?.git?.branch || null,
      head: index?.repo?.git?.head || inventory?.repo?.git?.head || null,
      supportLevel: support?.supportLevel || 'unknown',
    },
    snapshotId: graph.snapshotId || support?.snapshotId || null,
    progress: {
      totalStages: stages.length,
      completedStages,
      currentStage: current?.number || 1,
      currentStageId: current?.id || 'snapshot',
      currentStatus: current?.status || 'waiting',
      summary: current?.status === 'blocked'
        ? `第 ${current.number} 阶段已执行，当前门禁阻塞。`
        : `当前位于第 ${current?.number || 1} 阶段。`,
    },
    stages,
    summary: {
      files: inventory.files?.length || 0,
      sourceFiles: inventory.counts?.categories?.source || index?.counts?.sourceFiles || 0,
      graphNodes: graph.nodes?.length || 0,
      graphEdges: graph.edges?.length || 0,
      routes: nodeSummary.route || codeMap.routes?.length || 0,
      pages: nodeSummary.page || 0,
      modules: nodeSummary.module || 0,
      communities: communities.communities?.length || 0,
      diagnostics: graph.diagnostics?.length || 0,
      blockedQuestions: countQuestions(questions, 'blocked'),
      researchContracts: planning?.contractRefs?.length || 0,
      eligibleSemanticNodes: nodeSemanticPlan?.eligibleFileCount || 0,
      semanticBatches: nodeSemanticPlan?.batchCount || 0,
      semanticNodes: nodeSemantics?.entries?.length || 0,
      acceptedSemanticNodes: nodeSemantics?.entries?.filter(item => item.status === 'accepted').length || 0,
      repositoryZones: repositoryZones.metrics.zones,
      repositorySubzones: repositoryZones.metrics.subzones,
      zonedFiles: repositoryZones.metrics.files,
      unclassifiedFiles: repositoryZones.metrics.unclassifiedFiles,
      understoodDomains: repositoryDomainSummaries.metrics.zones,
      domainEntryFiles: repositoryDomainSummaries.metrics.entryFiles,
      domainCoreFiles: repositoryDomainSummaries.metrics.coreFiles,
      domainBoundaryFiles: repositoryDomainSummaries.metrics.boundaryFiles,
      domainCollaborations: repositoryDomainSummaries.metrics.collaborations,
      domainUnknowns: repositoryDomainSummaries.metrics.unknowns,
      journeys: journeys?.counts?.journeys || 0,
      closedJourneys: journeys?.counts?.closed || 0,
    },
    files: fileModel,
    graph: graphModel,
    repositoryZones,
    repositoryDomainSummaries,
    diagnostics: {
      byKind: entriesForCount(diagnosticSummary),
      samples: (graph.diagnostics || []).slice(0, 80).map(item => ({
        kind: item.kind || 'unknown',
        severity: item.severity || 'warning',
        message: item.message || '',
        sourcePath: item.sourcePath || null,
      })),
    },
    relationTypes: entriesForCount(edgeSummary),
  }
}

function buildStages(input) {
  const blockedQuestions = countQuestions(input.questions, 'blocked')
  const contractCount = input.planning?.contractRefs?.length || 0
  const workItems = Object.values(input.workflow?.workItems || {})
  const activeWork = workItems.filter(item => ['ready', 'issued', 'result-produced'].includes(item.status)).length
  const acceptedWork = workItems.filter(item => ['accepted', 'waived'].includes(item.status)).length
  const semanticEntries = input.nodeSemantics?.entries || []
  const acceptedSemantics = semanticEntries.filter(item => item.status === 'accepted').length
  const eligibleSemantics = input.nodeSemanticPlan?.eligibleFileCount || 0
  const journeyCount = input.journeys?.counts?.journeys || 0
  const closedJourneys = input.journeys?.counts?.closed || 0
  const repositoryZones = input.repositoryZonePlan?.zones || []
  const populatedRepositoryZones = repositoryZones.filter(zone => (zone.fileCount || 0) > 0).length
  const repositorySubzones = repositoryZones.reduce((total, zone) => total + (zone.subzones?.length || 0), 0)
  const repositoryDomainSummaries = input.repositoryDomainSummariesCatalog?.summaries || input.repositoryDomainSummaryDraft?.summaries || []
  const statuses = {
    snapshot: exists(input.root, 'static/inventory.json') ? 'complete' : 'active',
    support: input.support ? (input.support.supportLevel === 'unsupported' ? 'blocked' : 'complete') : 'waiting',
    'static-graph': input.graph?.graphId ? 'complete' : 'waiting',
    investigation: input.frame?.frameId ? 'complete' : 'waiting',
    'research-plan': !input.planning
      ? (input.frame ? 'ready' : 'waiting')
      : blockedQuestions > 0 && contractCount === 0
        ? 'blocked'
        : 'complete',
    'agent-research': input.nodeSemantics?.status === 'complete'
      ? 'complete'
      : semanticEntries.length > 0 || activeWork > 0
      ? 'active'
      : input.planning
        ? 'ready'
        : 'waiting',
    'semantic-zoning': input.repositoryZonePlan?.status === 'complete'
      ? 'complete'
      : input.repositoryZoneAgentPlan || input.repositoryZoneDraft || input.repositoryZoneReview
        ? 'active'
        : input.nodeSemantics?.status === 'complete'
          ? 'ready'
          : 'waiting',
    'domain-understanding': input.repositoryDomainSummariesCatalog?.status === 'complete'
      ? 'complete'
      : input.repositoryDomainSummaryAgentPlan || input.repositoryDomainSummaryDraft || input.repositoryDomainSummaryReview
        ? 'active'
        : input.repositoryZonePlan?.status === 'complete'
          ? 'ready'
          : 'waiting',
    'product-maps': input.projectionManifest ? 'complete' : 'waiting',
    synthesis: input.narrative ? 'complete' : 'waiting',
    'human-readable': exists(input.root, 'human-readable.html') ? 'complete' : 'waiting',
    verify: input.verification?.passed === true ? 'complete' : input.verification ? 'failed' : 'waiting',
  }
  const details = {
    snapshot: `${input.inventory?.files?.length || 0} files`,
    support: input.support?.supportLevel || '等待范围判断',
    'static-graph': `${input.graph?.nodes?.length || 0} nodes · ${input.graph?.edges?.length || 0} edges`,
    investigation: `${input.frame?.coreFlowCandidates?.length || 0} flow candidates`,
    'research-plan': input.nodeSemanticPlan ? `${input.nodeSemanticPlan.batchCount || 0} batches · ${eligibleSemantics} files` : `${contractCount} contracts · ${blockedQuestions} blocked questions`,
    'agent-research': `${acceptedSemantics}/${eligibleSemantics || semanticEntries.length} accepted`,
    'semantic-zoning': input.repositoryZonePlan
      ? `${populatedRepositoryZones} zones · ${repositorySubzones} subzones · ${input.repositoryZonePlan.metrics?.files || input.repositoryZonePlan.memberships?.length || 0} files`
      : input.repositoryZoneReview
      ? `${input.repositoryZoneReview.status || 'reviewing'} · independent Agent review`
      : input.repositoryZoneDraft
      ? `${input.repositoryZoneDraft.zones?.length || 0} proposed domains · waiting review`
      : input.repositoryZoneAgentPlan
      ? `${input.repositoryZoneAgentPlan.allowedFiles?.length || 0} files · waiting Domain Agent`
      : `${closedJourneys}/${journeyCount} closed`,
    'domain-understanding': input.repositoryDomainSummariesCatalog
      ? `${repositoryDomainSummaries.length} domains · reviewed responsibilities and boundaries`
      : input.repositoryDomainSummaryReview
      ? `${input.repositoryDomainSummaryReview.status || 'reviewing'} · independent Agent review`
      : input.repositoryDomainSummaryDraft
      ? `${repositoryDomainSummaries.length} domain summaries · waiting review`
      : input.repositoryDomainSummaryAgentPlan
      ? `${input.repositoryDomainSummaryAgentPlan.allowedZoneIds?.length || 0} domains · waiting interpreting Agent`
      : `${repositoryZones.length} reviewed domains · ready for interpretation`,
    'product-maps': input.projectionManifest ? '4 governed maps' : '等待 Journey closure',
    synthesis: input.narrative ? 'narrative ready' : '等待 Product Maps',
    'human-readable': exists(input.root, 'human-readable.html') ? 'delivery ready' : '等待 synthesis',
    verify: input.verification ? (input.verification.passed ? 'passed' : `${input.verification.issues?.length || 0} issues`) : '尚未验证',
  }
  return STAGE_DEFINITIONS.map(([id, label, description, artifacts], index) => ({
    id,
    number: index + 1,
    label,
    description,
    status: statuses[id],
    detail: details[id],
    artifacts: artifacts.map(artifactPath => ({ path: artifactPath, present: exists(input.root, artifactPath) })),
  }))
}

function buildRepositoryZoneModel(plan, files, agentState = {}) {
  const draft = !plan
    && agentState.draft?.schemaVersion === 'repo-repository-zones/v2'
    && agentState.draft?.status === 'draft'
    && (!agentState.agentPlan?.planId || agentState.draft.planId === agentState.agentPlan.planId)
    ? agentState.draft
    : null
  const source = plan || draft
  const preview = Boolean(draft)
  const fileSet = new Set((files || []).map(file => file.path))
  const memberships = (source?.memberships || []).filter(item => fileSet.has(item.filePath))
  const membershipByPath = new Map(memberships.map(item => [item.filePath, item]))
  const zones = (source?.zones || []).map(zone => {
    const memberFilePaths = (zone.memberFilePaths || memberships.filter(item => item.zoneId === zone.zoneId).map(item => item.filePath))
      .filter(filePath => membershipByPath.has(filePath))
    return {
      ...zone,
      fileCount: memberFilePaths.length,
      memberFilePaths,
      subzones: (zone.subzones || []).map(subzone => {
        const paths = (subzone.memberFilePaths || memberships.filter(item => item.zoneId === zone.zoneId && item.subzoneId === subzone.subzoneId).map(item => item.filePath))
          .filter(filePath => membershipByPath.has(filePath))
        return {
          ...subzone,
          fileCount: paths.length,
          memberFilePaths: paths,
          representativeFilePaths: (subzone.representativeFilePaths || []).filter(filePath => membershipByPath.has(filePath)),
        }
      }).filter(subzone => subzone.fileCount > 0),
    }
  }).filter(zone => zone.fileCount > 0)
  return {
    status: preview ? 'preview' : source?.status || (agentState.agentPlan || agentState.draft || agentState.review ? 'active' : 'waiting'),
    preview,
    reviewStatus: agentState.review?.status || null,
    zonePlanId: source?.zonePlanId || null,
    gates: source?.gates || {},
    metrics: {
      files: memberships.length,
      zones: zones.length,
      subzones: zones.reduce((total, zone) => total + zone.subzones.length, 0),
      unclassifiedFiles: memberships.filter(item => item.status === 'needs-review').length,
      crossZoneRelations: source?.metrics?.crossZoneRelations || 0,
    },
    zones,
    memberships,
    crossZoneRelations: source?.crossZoneRelations || [],
  }
}

function buildRepositoryDomainSummaryModel(catalog, agentState = {}) {
  const draft = !catalog
    && agentState.draft?.schemaVersion === 'repo-repository-domain-summaries/v1'
    && agentState.draft?.status === 'draft'
    && (!agentState.agentPlan?.planId || agentState.draft.planId === agentState.agentPlan.planId)
    ? agentState.draft
    : null
  const source = catalog || draft
  const summaries = source?.summaries || []
  const computedMetrics = {
    zones: summaries.length,
    entryFiles: summaries.reduce((total, item) => total + (item.entryFiles?.length || 0), 0),
    coreFiles: summaries.reduce((total, item) => total + (item.coreFiles?.length || 0), 0),
    boundaryFiles: summaries.reduce((total, item) => total + (item.boundaryFiles?.length || 0), 0),
    collaborations: summaries.reduce((total, item) => total + (item.collaboratingDomains?.length || 0), 0),
    unknowns: summaries.reduce((total, item) => total + (item.unknowns?.length || 0), 0),
  }
  return {
    status: catalog ? 'complete' : draft ? 'preview' : (agentState.agentPlan || agentState.review ? 'active' : 'waiting'),
    preview: Boolean(draft),
    planId: source?.planId || agentState.agentPlan?.planId || null,
    summaryCatalogId: source?.summaryCatalogId || null,
    producer: source?.producer || null,
    review: catalog?.review || agentState.review || null,
    metrics: source?.metrics || computedMetrics,
    summaries,
  }
}

function buildFileModel({ inventory, graph, codeMap, nodeSemantics }) {
  const diagnosticsByFile = countBy(graph.diagnostics || [], item => item.sourcePath || '')
  const routesByFile = countBy(codeMap.routes || [], item => item.file || item.sourcePath || '')
  const semanticsByFile = new Map((nodeSemantics?.entries || []).map(entry => [entry.filePath, entry]))
  const files = (inventory.files || []).map(file => ({
    path: file.path,
    name: path.posix.basename(file.path),
    directory: path.posix.dirname(file.path),
    extension: path.posix.extname(file.path).slice(1).toLowerCase(),
    language: file.language || 'Text',
    category: file.category || 'unknown',
    size: file.size || 0,
    lines: file.lines || 0,
    protected: Boolean(file.protected),
    binary: Boolean(file.binary),
    diagnostics: diagnosticsByFile[file.path] || 0,
    routes: routesByFile[file.path] || 0,
    semantic: semanticsByFile.get(file.path) || null,
    kind: fileKind(file),
  }))
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function buildFileGraph({ files, graph, communities }) {
  const fileByPath = new Map(files.map(file => [file.path, file]))
  const graphFiles = files.filter(file => !file.binary && file.category !== 'resource')
  const graphFileSet = new Set(graphFiles.map(file => file.path))
  const sourcePathByNode = new Map()
  for (const node of graph.nodes || []) {
    const sourcePath = sourcePathForNode(node)
    if (sourcePath && fileByPath.has(sourcePath)) sourcePathByNode.set(node.nodeId, sourcePath)
  }
  const communityVotes = new Map()
  for (const community of communities.communities || []) {
    for (const nodeId of community.memberNodeIds || []) {
      const sourcePath = sourcePathByNode.get(nodeId)
      if (!sourcePath) continue
      const votes = communityVotes.get(sourcePath) || new Map()
      votes.set(community.communityId, (votes.get(community.communityId) || 0) + 1)
      communityVotes.set(sourcePath, votes)
    }
  }
  const communityOrdinal = new Map((communities.communities || []).map((community, index) => [community.communityId, index + 1]))
  const edgesByPair = new Map()
  for (const edge of graph.edges || []) {
    const source = sourcePathByNode.get(edge.from)
    const target = sourcePathByNode.get(edge.to)
    if (!source || !target || source === target || !graphFileSet.has(source) || !graphFileSet.has(target)) continue
    const key = `${source}\u0000${target}`
    const current = edgesByPair.get(key) || { source, target, count: 0, types: {} }
    current.count += 1
    current.types[edge.type || 'related'] = (current.types[edge.type || 'related'] || 0) + 1
    edgesByPair.set(key, current)
  }
  const degree = new Map()
  for (const edge of edgesByPair.values()) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + edge.count)
    degree.set(edge.target, (degree.get(edge.target) || 0) + edge.count)
  }
  const nodes = graphFiles.map(file => {
    const votes = communityVotes.get(file.path)
    const communityId = votes
      ? [...votes.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0]
      : null
    return {
      id: file.path,
      label: file.name,
      path: file.path,
      kind: file.kind,
      language: file.language,
      lines: file.lines,
      size: file.size,
      diagnostics: file.diagnostics,
      routes: file.routes,
      degree: degree.get(file.path) || 0,
      community: communityId ? communityOrdinal.get(communityId) : null,
      group: communityId ? `Community ${communityOrdinal.get(communityId)}` : topLevelGroup(file.path),
      semantic: file.semantic,
    }
  })
  const edges = [...edgesByPair.values()].map((edge, index) => ({
    id: `file-edge-${index + 1}`,
    ...edge,
    primaryType: Object.entries(edge.types).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0],
  }))
  return { nodes, edges }
}

function renderRepositoryAtlasHtml(model) {
  const embedded = safeJson(model)
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(model.repo.name)} · Repository Atlas</title>
<style>${atlasStyles()}</style>
</head>
<body>
<a class="skip-link" href="#atlas">跳到 Repository Atlas</a>
<header class="masthead">
  <div class="masthead__top">
    <span><span class="status-dot status-dot--${escapeHtml(model.progress.currentStatus)}"></span>Repository understanding / deterministic surface</span>
    <span>${escapeHtml(model.repo.branch || 'unknown branch')} · ${escapeHtml(model.repo.head || 'unknown head')}</span>
  </div>
  <div class="masthead__body">
    <div>
      <p class="kicker">Stage ${String(model.progress.currentStage).padStart(2, '0')} / ${String(model.progress.totalStages).padStart(2, '0')}</p>
      <h1>${escapeHtml(model.repo.name)}</h1>
    </div>
    <div class="masthead__summary">
      <p>${escapeHtml(model.progress.summary)}</p>
      <dl><div><dt>Support</dt><dd>${escapeHtml(model.repo.supportLevel)}</dd></div><div><dt>Snapshot</dt><dd>${escapeHtml(shortId(model.snapshotId))}</dd></div></dl>
      <button class="tool-button" id="theme-toggle" type="button">切换主题</button>
    </div>
  </div>
</header>
<main>
  <section class="stage-section" aria-labelledby="stage-title">
    <div class="section-heading section-heading--compact">
      <span class="section-number">00</span>
      <div><p class="eyebrow">Pipeline</p><h2 id="stage-title">阶段与产物</h2><p>前 ${model.progress.completedStages} 阶段完成；当前停在第 ${model.progress.currentStage} 阶段。</p></div>
      <code>${escapeHtml(model.schemaVersion)}</code>
    </div>
    <div class="stage-rail" id="stage-rail" role="list"></div>
    <div class="stage-inspector" id="stage-inspector" aria-live="polite"></div>
  </section>
  <section class="atlas-section" id="atlas" aria-labelledby="atlas-title">
    <div class="section-heading">
      <span class="section-number">05</span>
      <div><p class="eyebrow">Current artifact</p><h2 id="atlas-title">Repository Atlas</h2><p>文件树回答“代码在哪里”，依赖流回答“从这个文件继续会走到哪里”。默认只展开一层，按需向下追踪，诊断缺口始终可见。</p></div>
      <code>repository-atlas.html</code>
    </div>
    <div class="metric-strip" aria-label="仓库统计">
      <div><strong>${formatNumber(model.summary.files)}</strong><span>Files</span></div>
      <div><strong>${formatNumber(model.summary.graphNodes)}</strong><span>Graph nodes</span></div>
      <div><strong>${formatNumber(model.summary.graphEdges)}</strong><span>Relations</span></div>
      <div><strong>${formatNumber(model.summary.routes)}</strong><span>Routes</span></div>
      <div><strong>${formatNumber(model.summary.diagnostics)}</strong><span>Diagnostics</span></div>
    </div>
    <div class="atlas-toolbar" role="toolbar" aria-label="Repository Atlas 工具栏">
      <label class="search-field"><span>⌕</span><input id="file-search" type="search" placeholder="搜索文件或路径" autocomplete="off"></label>
      <div class="relation-filters" id="relation-filters" aria-label="关系类型筛选"></div>
      <button class="tool-button" id="reset-flow" type="button">重置展开</button>
    </div>
    <div class="workbench">
      <aside class="explorer" aria-label="文件资源管理器">
        <header><span>EXPLORER</span><strong>${formatNumber(model.summary.files)}</strong></header>
        <div class="repo-root"><span class="disclosure">⌄</span><strong>${escapeHtml(model.repo.name)}</strong></div>
        <div class="file-tree" id="file-tree" role="tree"></div>
      </aside>
      <section class="graph-panel" aria-label="自上而下的文件依赖流">
        <header class="panel-tabs"><button class="panel-tab panel-tab--active" type="button">DEPENDENCY FLOW</button><span id="graph-caption" aria-live="polite">等待选择根文件</span></header>
        <div class="flow-toolbar" role="toolbar" aria-label="依赖流方向">
          <div class="direction-switch" aria-label="查看方向">
            <button type="button" class="direction-button direction-button--active" data-direction="downstream" aria-pressed="true">查看下游</button>
            <button type="button" class="direction-button" data-direction="upstream" aria-pressed="false">查看上游</button>
          </div>
          <span class="flow-guide">双指捏合缩放 · 三指/鼠标拖拽移动 · 点“展开”继续一层</span>
        </div>
        <div class="stage-evolution" id="stage-evolution" aria-live="polite"></div>
        <div class="flow-viewport" id="flow-viewport" tabindex="0" aria-label="可拖拽、双指捏合或用键盘移动与缩放的文件依赖流">
          <div id="dependency-flow" class="dependency-flow"></div>
          <aside id="domain-companion" class="domain-companion" aria-live="polite" hidden></aside>
        </div>
      </section>
      <aside class="inspector" aria-label="文件详情">
        <header><span>INSPECTOR</span><strong id="selection-state">NO SELECTION</strong></header>
        <div id="file-inspector" class="file-inspector"><div class="empty-state"><strong>选择一个文件</strong><p>从文件树或依赖流选择节点，查看依赖、诊断和上下游文件。</p></div></div>
      </aside>
    </div>
    <details class="diagnostic-band">
      <summary><span><strong>${formatNumber(model.summary.diagnostics)}</strong> 条确定性诊断</span><small>展开已知缺口</small></summary>
      <div class="diagnostic-content">
        <p>这些缺口会影响关系图完整度，但不会被伪装成已理解的代码关系。</p>
        <div class="diagnostic-kinds">${model.diagnostics.byKind.slice(0, 8).map(item => `<span><strong>${formatNumber(item.count)}</strong>${escapeHtml(item.key)}</span>`).join('')}</div>
      </div>
    </details>
  </section>
</main>
<footer><span>${escapeHtml(model.repo.path || '')}</span><span>Generated ${escapeHtml(model.generatedAt)}</span></footer>
<script id="atlas-data" type="application/json">${embedded}</script>
<script>${atlasFlowScript()}</script>
</body>
</html>`
}

function atlasStyles() {
  return `
:root{--paper:oklch(96.8% .012 86);--paper-deep:oklch(92.5% .018 83);--panel:oklch(94.5% .014 84);--ink:oklch(20% .018 78);--muted:oklch(45% .018 78);--line:oklch(78% .022 80);--accent:oklch(44% .13 35);--accent-soft:oklch(91% .035 35);--ok:oklch(44% .09 151);--warn:oklch(54% .13 70);--danger:oklch(48% .16 28);--code:oklch(31% .022 77);--node-page:oklch(93.5% .036 43);--node-component:oklch(93.5% .034 248);--node-api:oklch(93.5% .038 151);--node-state:oklch(93% .042 82);--node-route:oklch(93% .04 24);--node-config:oklch(93.5% .018 98);--serif:"Iowan Old Style","Palatino Linotype","Book Antiqua",Palatino,serif;--sans:"Avenir Next",Avenir,"Century Gothic",sans-serif;--mono:"SFMono-Regular",Menlo,Consolas,monospace}
[data-theme="dark"]{--paper:oklch(21% .018 76);--paper-deep:oklch(25% .019 76);--panel:oklch(23% .018 76);--ink:oklch(92% .014 84);--muted:oklch(72% .018 82);--line:oklch(39% .022 78);--accent:oklch(72% .13 45);--accent-soft:oklch(30% .05 35);--ok:oklch(72% .11 151);--warn:oklch(76% .12 76);--danger:oklch(70% .15 28);--code:oklch(83% .018 83);--node-page:oklch(28% .036 43);--node-component:oklch(28% .034 248);--node-api:oklch(28% .038 151);--node-state:oklch(28% .04 82);--node-route:oklch(28% .04 24);--node-config:oklch(27% .018 98)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5}button,input{font:inherit}button{color:inherit}code{color:var(--code);font-family:var(--mono);font-size:.72rem;overflow-wrap:anywhere}.skip-link{position:fixed;z-index:100;top:8px;left:8px;padding:8px 12px;background:var(--ink);color:var(--paper);transform:translateY(-160%)}.skip-link:focus{transform:none}.masthead{padding:18px clamp(18px,3vw,48px) 14px;border-bottom:1px solid var(--ink)}.masthead__top{display:flex;justify-content:space-between;gap:20px;color:var(--muted);font-size:.68rem;letter-spacing:.05em;text-transform:uppercase}.status-dot{display:inline-block;width:7px;height:7px;margin-right:6px;background:var(--muted)}.status-dot--complete{background:var(--ok)}.status-dot--blocked,.status-dot--failed{background:var(--danger)}.status-dot--active,.status-dot--ready{background:var(--warn)}.masthead__body{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.7fr);align-items:end;gap:clamp(24px,5vw,80px);margin:22px 0 8px}.kicker,.eyebrow{margin:0 0 4px;color:var(--accent);font-size:.66rem;letter-spacing:.13em;text-transform:uppercase}h1,h2{font-family:var(--serif);font-weight:400;letter-spacing:-.05em}h1{margin:0;font-size:clamp(2.8rem,6vw,5.5rem);line-height:.88}h2{margin:0 0 6px;font-size:clamp(2.2rem,4vw,4.2rem);line-height:.94}.masthead__summary>p{max-width:520px;margin:0;color:var(--muted);font-family:var(--serif);font-size:1rem}.masthead__summary dl{display:flex;gap:24px;margin:10px 0}.masthead__summary dl div{display:grid;grid-template-columns:auto 1fr;gap:8px;padding:4px 0;border-top:1px solid var(--line)}dt{color:var(--muted);font-size:.65rem;text-transform:uppercase}dd{margin:0;font-family:var(--mono);font-size:.68rem}.tool-button{border:1px solid var(--ink);border-radius:0;background:transparent;padding:6px 10px;cursor:pointer}.tool-button:hover,.tool-button:focus-visible{background:var(--ink);color:var(--paper);outline:none}.stage-section{padding:32px clamp(18px,3vw,48px) 24px;border-bottom:1px solid var(--ink)}.atlas-section{padding:20px clamp(14px,2.4vw,36px) 12px;border-bottom:1px solid var(--ink)}.section-heading{display:grid;grid-template-columns:38px minmax(0,1fr) minmax(150px,.32fr);gap:clamp(12px,2vw,28px);align-items:start;margin-bottom:18px}.atlas-section>.section-heading{align-items:end;margin-bottom:12px}.section-heading--compact h2{font-size:clamp(2rem,3.5vw,3.8rem)}.section-heading p:not(.eyebrow){max-width:760px;margin:0;color:var(--muted);font-size:.8rem}.section-number{color:var(--accent);font-family:var(--serif);font-size:1rem}.stage-rail{display:grid;grid-template-columns:repeat(11,minmax(108px,1fr));overflow-x:auto;border:1px solid var(--line)}.stage-card{position:relative;min-height:116px;padding:10px;border:0;border-right:1px solid var(--line);background:var(--paper);text-align:left;cursor:pointer}.stage-card:last-child{border-right:0}.stage-card:hover,.stage-card:focus-visible,.stage-card--selected{background:var(--paper-deep);outline:none}.stage-card__number{display:flex;justify-content:space-between;color:var(--muted);font-family:var(--mono);font-size:.62rem}.stage-card__status{width:7px;height:7px;background:var(--muted)}.stage-card--complete .stage-card__status{background:var(--ok)}.stage-card--blocked .stage-card__status,.stage-card--failed .stage-card__status{background:var(--danger)}.stage-card--active .stage-card__status,.stage-card--ready .stage-card__status{background:var(--warn)}.stage-card strong{display:block;margin:15px 0 5px;font-family:var(--serif);font-size:.9rem;line-height:1.15}.stage-card small{color:var(--muted);font-family:var(--mono);font-size:.56rem}.stage-inspector{display:grid;grid-template-columns:minmax(180px,.55fr) 1fr;gap:clamp(18px,3vw,44px);min-height:88px;padding:14px 0;border-bottom:1px solid var(--line)}.stage-inspector h3{margin:0 0 4px;font-family:var(--serif);font-size:1.3rem}.stage-inspector p{margin:0;color:var(--muted);font-size:.78rem}.artifact-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--line)}.artifact-link{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}.artifact-link:nth-child(odd){padding-right:20px}.artifact-link--missing{color:var(--muted);pointer-events:none}.artifact-link span{font-family:var(--mono);font-size:.62rem}.metric-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);background:var(--line);gap:1px}.metric-strip>div{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:7px 10px;background:var(--paper)}.metric-strip strong{font-family:var(--serif);font-size:1.12rem;font-weight:400}.metric-strip span{color:var(--muted);font-size:.58rem;text-transform:uppercase}.atlas-toolbar{display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 0;border-top:1px solid var(--line)}.search-field{display:flex;align-items:center;gap:8px;min-width:250px;border:1px solid var(--line);padding:5px 8px;background:var(--paper)}.search-field:focus-within{border-color:var(--ink)}.search-field input{width:100%;border:0;outline:0;background:transparent;color:var(--ink)}.relation-filters{display:flex;flex:1;gap:4px;overflow-x:auto}.filter-chip{border:1px solid var(--line);background:transparent;padding:4px 7px;white-space:nowrap;cursor:pointer;font-family:var(--mono);font-size:.58rem}.filter-chip--active{border-color:var(--ink);background:var(--ink);color:var(--paper)}.workbench{display:grid;grid-template-columns:minmax(220px,260px) minmax(500px,1fr) minmax(240px,288px);height:max(680px,calc(100dvh - 170px));border:1px solid var(--ink);background:var(--panel)}.explorer,.inspector,.graph-panel{min-width:0;overflow:hidden}.explorer,.graph-panel{border-right:1px solid var(--line)}.explorer>header,.inspector>header,.panel-tabs{height:30px;display:flex;align-items:center;justify-content:space-between;padding:0 8px;border-bottom:1px solid var(--line);font-size:.58rem;letter-spacing:.08em}.explorer>header strong,.inspector>header strong{color:var(--muted);font-family:var(--mono);font-weight:400}.repo-root{height:26px;display:flex;align-items:center;gap:5px;padding:0 8px;border-bottom:1px solid var(--line);font-size:.68rem;text-transform:uppercase}.disclosure{font-size:.62rem}.file-tree{height:calc(100% - 56px);overflow:auto;padding:4px 0 12px;font-family:var(--sans);font-size:12px}.tree-children{display:none}.tree-node--open>.tree-children{display:block}.tree-row{height:23px;display:flex;align-items:center;gap:4px;padding-right:8px;cursor:default;white-space:nowrap}.tree-row:hover,.tree-row--selected{background:var(--paper-deep)}.tree-row:focus-visible{outline:1px solid var(--accent);outline-offset:-1px}.tree-twist{width:14px;flex:0 0 14px;text-align:center;color:var(--muted);font-size:9px}.tree-name{overflow:hidden;text-overflow:ellipsis}.tree-count{margin-left:auto;color:var(--muted);font-family:var(--mono);font-size:9px}.file-icon{width:15px;height:15px;flex:0 0 15px;display:inline-grid;place-items:center}.file-icon svg{width:14px;height:14px;overflow:visible}.file-icon .sheet{fill:none;stroke:currentColor;stroke-width:1.1}.file-icon text{fill:currentColor;font:700 5px var(--sans)}.icon-vue{color:oklch(55% .14 155)}.icon-js{color:oklch(64% .14 85)}.icon-ts{color:oklch(55% .14 240)}.icon-json{color:oklch(55% .11 70)}.icon-style{color:oklch(56% .13 345)}.icon-markdown{color:oklch(53% .12 250)}.icon-image{color:oklch(55% .13 305)}.icon-config{color:var(--muted)}.icon-folder{color:oklch(58% .1 78)}.graph-panel{display:flex;flex-direction:column}.panel-tabs{justify-content:flex-start;gap:12px}.panel-tab{align-self:stretch;border:0;border-bottom:2px solid transparent;background:transparent;padding:0 4px;font-size:.58rem;letter-spacing:.08em}.panel-tab--active{border-color:var(--accent)}#graph-caption{margin-left:auto;color:var(--muted);font-family:var(--mono);font-size:.56rem}.canvas-shell{position:relative;flex:1;min-height:0;background:var(--paper-deep);overflow:hidden}#relation-canvas{display:block;width:100%;height:100%;cursor:grab}#relation-canvas:active{cursor:grabbing}#relation-canvas:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.canvas-legend{position:absolute;top:10px;left:10px;display:flex;flex-wrap:wrap;gap:10px;padding:6px 8px;background:color-mix(in oklch,var(--paper) 88%,transparent);border:1px solid var(--line);font-size:9px}.canvas-legend span{display:flex;align-items:center;gap:4px}.legend-node{width:7px;height:7px;border-radius:50%;background:var(--muted)}.legend-node--view{background:oklch(56% .12 34)}.legend-node--component{background:oklch(54% .11 255)}.legend-node--api{background:oklch(51% .1 155)}.legend-node--state{background:oklch(60% .12 83)}.legend-node--config{background:oklch(55% .05 78)}.canvas-help{position:absolute;right:10px;bottom:10px;padding:5px 8px;background:color-mix(in oklch,var(--paper) 88%,transparent);border:1px solid var(--line);color:var(--muted);font-size:9px}.file-inspector{height:calc(100% - 30px);overflow:auto;padding:12px}.empty-state{padding:16px 0;color:var(--muted)}.empty-state strong{color:var(--ink);font-family:var(--serif);font-size:1.1rem}.file-title{margin:0 0 3px;font-family:var(--serif);font-size:1.25rem;overflow-wrap:anywhere}.file-path{margin:0 0 12px;color:var(--muted);font-family:var(--mono);font-size:.6rem;overflow-wrap:anywhere}.property-list{margin:0}.property-list>div{display:grid;grid-template-columns:70px 1fr;gap:8px;padding:6px 0;border-top:1px solid var(--line)}.property-list dd{overflow-wrap:anywhere}.relation-list{margin-top:16px}.relation-list h4{margin:0;padding-bottom:6px;border-bottom:1px solid var(--ink);font-size:.62rem;letter-spacing:.1em;text-transform:uppercase}.relation-item{display:grid;grid-template-columns:12px minmax(0,1fr);gap:7px;padding:7px 0;border-bottom:1px solid var(--line);cursor:pointer}.relation-item:hover strong{color:var(--accent)}.relation-item i{width:6px;height:6px;margin-top:5px;background:var(--muted)}.relation-item strong{display:block;font-size:.68rem;overflow-wrap:anywhere}.relation-item small{color:var(--muted);font-family:var(--mono);font-size:.55rem}.diagnostic-band{margin-top:8px;border-top:1px solid var(--ink)}.diagnostic-band summary{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 0;cursor:pointer;list-style:none}.diagnostic-band summary::-webkit-details-marker{display:none}.diagnostic-band summary span{font-family:var(--serif);font-size:.95rem}.diagnostic-band summary strong{color:var(--accent);font-size:1.1rem;font-weight:500}.diagnostic-band summary small{color:var(--muted);font-family:var(--mono);font-size:.56rem}.diagnostic-band summary::after{content:"＋";color:var(--accent);font-family:var(--mono)}.diagnostic-band[open] summary::after{content:"−"}.diagnostic-content{display:grid;grid-template-columns:minmax(220px,.55fr) 1fr;gap:24px;padding:8px 0 12px;border-top:1px solid var(--line)}.diagnostic-content>p{margin:0;color:var(--muted);font-size:.72rem}.diagnostic-kinds{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start}.diagnostic-kinds span{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--line);font-family:var(--mono);font-size:.6rem}.diagnostic-kinds strong{color:var(--accent)}footer{display:flex;justify-content:space-between;gap:18px;padding:8px clamp(14px,2.4vw,36px);color:var(--muted);font-size:.6rem}
.skip-link{top:-80px;transform:none}.skip-link:focus{top:8px}
/* Progressive dependency flow: one readable layer at a time. */
.flow-toolbar{height:34px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 8px;border-bottom:1px solid var(--line);background:var(--panel)}.direction-switch{display:flex;border:1px solid var(--line)}.direction-button{border:0;border-right:1px solid var(--line);background:transparent;padding:4px 7px;color:var(--muted);cursor:pointer;font-size:.62rem}.direction-button:last-child{border-right:0}.direction-button:hover,.direction-button:focus-visible{color:var(--ink);outline:1px solid var(--accent);outline-offset:-1px}.direction-button--active{background:var(--ink);color:var(--paper)}.direction-button:disabled{cursor:not-allowed;opacity:.38}.flow-guide{color:var(--muted);font-family:var(--mono);font-size:.55rem}.stage-evolution{display:grid;grid-template-columns:78px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:44px;padding:4px 8px;border-bottom:1px solid var(--line);background:var(--paper)}.stage-evolution__stage{color:var(--accent);font-family:var(--mono);font-size:.54rem;letter-spacing:.08em;text-transform:uppercase}.stage-evolution__change strong{display:block;font-family:var(--serif);font-size:.82rem}.stage-evolution__change span{display:block;color:var(--muted);font-size:.57rem}.stage-evolution__nav{display:flex;align-items:center;gap:4px}.stage-evolution__step{border:1px solid var(--line);background:transparent;width:24px;height:22px;cursor:pointer;font-family:var(--mono);font-size:.6rem}.stage-evolution__step:hover,.stage-evolution__step:focus-visible{border-color:var(--accent);color:var(--accent);outline:none}.stage-evolution__step:disabled{cursor:not-allowed;opacity:.3}.stage-evolution__delta{padding:2px 5px;background:var(--accent-soft);color:var(--accent);font-family:var(--mono);font-size:.52rem;white-space:nowrap}.stage-evolution--locked .stage-evolution__delta{background:var(--paper-deep);color:var(--muted)}.flow-viewport{position:relative;flex:1;min-height:0;overflow:auto;background-color:var(--paper-deep);background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:24px 24px;scrollbar-gutter:stable}.flow-viewport:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.dependency-flow{display:flex;align-items:flex-start;justify-content:center;min-width:max-content;min-height:100%;padding:42px 42px 90px}.flow-branch{position:relative;display:flex;flex:0 0 auto;flex-direction:column;align-items:center}.flow-branch--child::before{content:"";position:absolute;top:-28px;left:50%;height:28px;border-left:1px solid var(--muted)}.flow-relation{position:absolute;z-index:2;top:-19px;left:50%;max-width:150px;transform:translateX(-50%);padding:1px 5px;border:1px solid var(--line);background:var(--paper-deep);color:var(--muted);font-family:var(--mono);font-size:.52rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.flow-node-wrap{position:relative}.flow-branch--expanded>.flow-node-wrap::after{content:"";position:absolute;top:100%;left:50%;height:28px;border-left:1px solid var(--muted)}.flow-card{position:relative;width:210px;min-height:116px;padding:11px;border:1px solid var(--ink);background:var(--paper);box-shadow:3px 3px 0 color-mix(in oklch,var(--ink) 14%,transparent)}.flow-card--kind-view,.flow-card--kind-page{background:var(--node-page)}.flow-card--kind-component{background:var(--node-component)}.flow-card--kind-api{background:var(--node-api)}.flow-card--kind-state{background:var(--node-state)}.flow-card--kind-route{background:var(--node-route)}.flow-card--kind-config{background:var(--node-config)}.flow-card--root{width:238px;border-color:var(--accent);box-shadow:4px 4px 0 var(--accent-soft)}.flow-card--selected{outline:2px solid var(--accent);outline-offset:2px}.flow-card--terminal{border-style:dashed}.flow-card__button{display:block;width:100%;border:0;background:transparent;padding:0;text-align:left;cursor:pointer}.flow-card__button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.flow-card__meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;color:var(--muted);font-family:var(--mono);font-size:.54rem;text-transform:uppercase}.flow-card__kind{display:flex;align-items:center;gap:5px}.flow-card__kind i{width:6px;height:6px;background:var(--muted)}.flow-card__kind--view i,.flow-card__kind--page i{background:oklch(56% .12 34)}.flow-card__kind--component i{background:oklch(54% .11 255)}.flow-card__kind--api i{background:oklch(51% .1 155)}.flow-card__kind--state i{background:oklch(60% .12 83)}.flow-card__kind--route i{background:var(--accent)}.flow-card h4{margin:0 0 4px;font-family:var(--serif);font-size:1rem;font-weight:600;line-height:1.15;overflow-wrap:anywhere}.flow-card__path{display:-webkit-box;min-height:28px;margin:0;color:var(--muted);font-family:var(--mono);font-size:.57rem;line-height:1.35;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}.flow-badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}.flow-badge{padding:1px 4px;background:var(--paper-deep);color:var(--muted);font-family:var(--mono);font-size:.5rem}.flow-badge--danger{background:color-mix(in oklch,var(--danger) 15%,var(--paper));color:var(--danger)}.flow-card__actions{display:flex;align-items:center;justify-content:space-between;gap:5px;margin-top:9px;padding-top:7px;border-top:1px solid var(--line)}.flow-action{border:0;background:transparent;padding:2px;color:var(--muted);cursor:pointer;font-family:var(--mono);font-size:.55rem}.flow-action:hover,.flow-action:focus-visible{color:var(--accent);outline:1px solid var(--accent);outline-offset:1px}.flow-action--expand{margin-left:auto;color:var(--ink);font-weight:700}.flow-children{position:relative;display:flex;align-items:flex-start;justify-content:center;gap:18px;margin-top:28px;padding-top:28px}.flow-children::before{content:"";position:absolute;top:0;right:105px;left:105px;border-top:1px solid var(--muted)}.flow-more-branch{position:relative;display:flex;width:92px;justify-content:center}.flow-more-branch::before{content:"";position:absolute;top:-28px;left:50%;height:28px;border-left:1px solid var(--muted)}.flow-more{border:1px dashed var(--muted);background:var(--paper);padding:8px 6px;color:var(--muted);cursor:pointer;font-family:var(--mono);font-size:.54rem}.flow-more:hover,.flow-more:focus-visible{border-color:var(--accent);color:var(--accent);outline:none}.flow-empty{width:min(430px,80vw);margin:auto;padding:24px;border:1px solid var(--line);background:var(--paper);text-align:center}.flow-empty strong{display:block;margin-bottom:4px;font-family:var(--serif);font-size:1.2rem}.flow-empty p{margin:0;color:var(--muted);font-size:.72rem}.stage-preview{display:flex;flex-direction:column;align-items:center}.stage-preview__root,.stage-preview__card{border:1px solid var(--ink);background:var(--paper);padding:12px;text-align:center}.stage-preview__root{width:240px}.stage-preview__root strong{display:block;font-family:var(--serif);font-size:1.1rem}.stage-preview__root small,.stage-preview__card small{color:var(--muted);font-family:var(--mono);font-size:.55rem}.stage-preview__stem{height:36px;border-left:1px solid var(--muted)}.stage-preview__children{display:flex;gap:12px;padding-top:22px;border-top:1px solid var(--muted)}.stage-preview__card{position:relative;width:150px}.stage-preview__card::before{content:"";position:absolute;bottom:100%;left:50%;height:23px;border-left:1px solid var(--muted)}.stage-preview__card strong{display:block;margin-bottom:3px;font-size:.72rem;overflow-wrap:anywhere}.flow-reference{width:132px}.flow-reference .flow-relation{max-width:116px}.flow-reference__button{width:132px;min-height:58px;border:1px dashed var(--muted);background:var(--paper);padding:8px;text-align:left;cursor:pointer}.flow-reference__button:hover,.flow-reference__button:focus-visible{border-color:var(--accent);color:var(--accent);outline:none}.flow-reference__button strong{display:block;font-size:.66rem;line-height:1.2;overflow-wrap:anywhere}.flow-reference__button small{display:block;margin-top:5px;color:var(--muted);font-family:var(--mono);font-size:.49rem;line-height:1.3}.flow-reference__button:hover small,.flow-reference__button:focus-visible small{color:inherit}
.semantic-tree-layout{position:relative;z-index:2}.semantic-territory-layer{position:absolute;inset:0;overflow:visible;pointer-events:none}.semantic-territory-layer--shapes{z-index:0}.semantic-territory-layer--labels{z-index:4}.semantic-territory{--territory-color:oklch(54% .12 250);transition:opacity 140ms ease}.semantic-territory__shape{fill:color-mix(in oklch,var(--territory-color) 24%,transparent);stroke:none}.semantic-territory__label{fill:var(--territory-color);stroke:var(--paper-deep);stroke-width:5px;paint-order:stroke fill;font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.05em}.semantic-territory-layer--focus .semantic-territory{opacity:.16}.semantic-territory-layer--focus .semantic-territory--active{opacity:1}.semantic-zone-node{position:relative}.semantic-zone-node::before{content:"";position:absolute;z-index:3;top:-1px;right:-1px;left:-1px;height:4px;background:var(--zone-accent,var(--accent));pointer-events:none}.flow-badge--zone{border-color:var(--zone-accent,var(--accent));color:var(--zone-accent,var(--accent))}.semantic-territory--tone-0,.semantic-zone-node--tone-0{--territory-color:oklch(56% .15 25);--zone-accent:oklch(56% .15 25)}.semantic-territory--tone-1,.semantic-zone-node--tone-1{--territory-color:oklch(56% .13 43);--zone-accent:oklch(56% .13 43)}.semantic-territory--tone-2,.semantic-zone-node--tone-2{--territory-color:oklch(54% .12 250);--zone-accent:oklch(54% .12 250)}.semantic-territory--tone-3,.semantic-zone-node--tone-3{--territory-color:oklch(50% .12 155);--zone-accent:oklch(50% .12 155)}.semantic-territory--tone-4,.semantic-zone-node--tone-4{--territory-color:oklch(52% .09 98);--zone-accent:oklch(52% .09 98)}.semantic-territory--tone-5,.semantic-zone-node--tone-5{--territory-color:oklch(57% .13 82);--zone-accent:oklch(57% .13 82)}[data-theme="dark"] .semantic-territory--tone-0,[data-theme="dark"] .semantic-zone-node--tone-0{--territory-color:oklch(72% .14 30);--zone-accent:oklch(72% .14 30)}[data-theme="dark"] .semantic-territory--tone-1,[data-theme="dark"] .semantic-zone-node--tone-1{--territory-color:oklch(74% .12 48);--zone-accent:oklch(74% .12 48)}[data-theme="dark"] .semantic-territory--tone-2,[data-theme="dark"] .semantic-zone-node--tone-2{--territory-color:oklch(72% .11 250);--zone-accent:oklch(72% .11 250)}[data-theme="dark"] .semantic-territory--tone-3,[data-theme="dark"] .semantic-zone-node--tone-3{--territory-color:oklch(72% .11 155);--zone-accent:oklch(72% .11 155)}[data-theme="dark"] .semantic-territory--tone-4,[data-theme="dark"] .semantic-zone-node--tone-4{--territory-color:oklch(74% .08 98);--zone-accent:oklch(74% .08 98)}[data-theme="dark"] .semantic-territory--tone-5,[data-theme="dark"] .semantic-zone-node--tone-5{--territory-color:oklch(76% .12 82);--zone-accent:oklch(76% .12 82)}.dependency-flow{position:relative}.flow-branch{z-index:2}.shared-link-layer{position:absolute;z-index:1;inset:0;pointer-events:none;overflow:visible}.shared-link-group{opacity:.42;transition:opacity 160ms ease-out}.shared-link-group--active{opacity:1}.shared-link-bus,.shared-link-stem,.shared-link-target{fill:none;stroke:var(--accent);vector-effect:non-scaling-stroke}.shared-link-bus{stroke-width:1.5}.shared-link-stem{stroke-width:1;stroke-dasharray:3 3}.shared-link-target{stroke-width:1.5}.shared-link-junction{fill:var(--paper-deep);stroke:var(--accent);stroke-width:1;vector-effect:non-scaling-stroke}.shared-link-arrow{fill:var(--accent)}.shared-link-label{fill:var(--accent);font-family:var(--mono);font-size:8px;letter-spacing:.04em}.flow-reference__button{position:relative}.flow-reference__button::after{content:"";position:absolute;right:-4px;bottom:-4px;width:7px;height:7px;border:1px solid var(--accent);background:var(--paper-deep)}.flow-shared-active{outline:2px solid var(--accent);outline-offset:3px}.flow-card.flow-shared-active{outline-width:3px}.flow-card.flow-reference-arrival::after{content:"";position:absolute;z-index:5;inset:-7px;border:2px solid var(--accent);pointer-events:none;transform-origin:center;animation:flow-reference-arrival 560ms cubic-bezier(.22,1,.36,1) both}@keyframes flow-reference-arrival{from{opacity:.9;transform:scale(.96)}to{opacity:0;transform:scale(1.06)}}
.flow-card__semantic{margin:8px 0 0;padding-top:7px;border-top:1px solid var(--line);color:var(--ink);font-size:.62rem;line-height:1.4;overflow-wrap:anywhere}.flow-card__semantic--collapsed{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3}.flow-action--semantic{color:var(--accent);font-weight:700}.flow-badge--semantic{background:var(--accent-soft);color:var(--accent)}.semantic-panel{margin-top:20px;border-top:2px solid var(--accent)}.semantic-panel__head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:9px 0;border-bottom:1px solid var(--line)}.semantic-panel__head strong{font-family:var(--serif);font-size:1rem}.semantic-panel__head span{color:var(--accent);font-family:var(--mono);font-size:.55rem}.semantic-nav{position:sticky;z-index:3;top:-14px;display:flex;flex-wrap:wrap;gap:4px;margin:0 -14px;padding:8px 14px;border-bottom:1px solid var(--line);background:var(--panel)}.semantic-nav a{border:1px solid var(--line);padding:3px 6px;color:var(--muted);font-family:var(--mono);font-size:.52rem;text-decoration:none}.semantic-nav a:hover,.semantic-nav a:focus-visible{border-color:var(--accent);color:var(--accent);outline:none}.semantic-responsibility-section,.semantic-group{scroll-margin-top:42px}.semantic-responsibility-section{padding:10px 0 2px}.semantic-section-label{display:block;margin-bottom:4px;color:var(--muted);font-size:.56rem;letter-spacing:.08em;text-transform:uppercase}.semantic-responsibility{margin:0 0 6px;color:var(--ink);font-size:.74rem;overflow-wrap:anywhere}.semantic-group{margin-top:10px;border-bottom:1px solid var(--line)}.semantic-group summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 0;color:var(--muted);cursor:pointer;font-size:.58rem;font-weight:700;letter-spacing:.08em;list-style:none;text-transform:uppercase}.semantic-group summary::-webkit-details-marker{display:none}.semantic-group summary::after{content:"＋";color:var(--accent);font-family:var(--mono);font-size:.68rem}.semantic-group[open] summary::after{content:"−"}.semantic-group summary:hover,.semantic-group summary:focus-visible{color:var(--accent);outline:none}.semantic-group summary small{margin-left:auto;color:var(--muted);font-family:var(--mono);font-size:.5rem;font-weight:400}.semantic-group__body{border-top:1px solid var(--line)}.semantic-item{padding:7px 0;border-bottom:1px solid var(--line)}.semantic-item:last-child{border-bottom:0}.semantic-item strong{display:flex;align-items:baseline;justify-content:space-between;gap:6px;font-size:.68rem}.semantic-item__confidence{color:var(--accent);font-family:var(--mono);font-size:.5rem;font-weight:400}.semantic-item p{margin:2px 0;color:var(--muted);font-size:.65rem;overflow-wrap:anywhere}.semantic-evidence{display:block;color:var(--accent);font-family:var(--mono);font-size:.52rem;overflow-wrap:anywhere;white-space:normal}.semantic-unknown{padding:7px 0;border-bottom:1px dashed var(--line);color:var(--muted);font-size:.63rem;overflow-wrap:anywhere}.semantic-unknown:last-child{border-bottom:0}.semantic-panel--empty{padding:12px 0;color:var(--muted);font-size:.68rem}
.flow-viewport{overflow:hidden;overflow:clip;overscroll-behavior:none;touch-action:none;cursor:grab}.flow-viewport--panning{cursor:grabbing}.flow-viewport--panning *{cursor:grabbing!important;user-select:none}.flow-viewport--panning .dependency-flow{will-change:transform}.dependency-flow{position:absolute;top:0;left:0;transform-origin:0 0}
.stage-rail{grid-template-columns:repeat(12,minmax(108px,1fr))}
.semantic-territory__label-action{pointer-events:auto;cursor:pointer}.semantic-territory__label-action:focus{outline:none}.semantic-territory__label-backdrop{fill:color-mix(in oklch,var(--paper-deep) 92%,transparent);stroke:var(--territory-color);stroke-width:1px;vector-effect:non-scaling-stroke}.semantic-territory__label-action:hover .semantic-territory__label-backdrop,.semantic-territory__label-action:focus .semantic-territory__label-backdrop{fill:var(--paper);stroke-width:2px}.semantic-territory--collaborator{opacity:.52!important}.domain-card--dimmed{opacity:.16;filter:saturate(.3)}.domain-card--focused{outline:3px solid var(--zone-accent,var(--accent));outline-offset:4px}.domain-card--collaborator{opacity:.68;outline:1px dashed var(--zone-accent,var(--accent));outline-offset:3px}.flow-badge--domain-role{border:1px solid currentColor;background:var(--paper);color:var(--accent);font-weight:700}.flow-badge--domain-boundary{color:var(--danger)}
.flow-relation--domain-boundary{border-color:var(--danger);color:var(--danger);font-weight:700}
.flow-badge--domain-role{border:0;box-shadow:inset 0 0 0 1px currentColor}
.domain-role-strip{position:absolute;z-index:5;top:-8px;right:8px;display:flex;gap:3px}.domain-role-strip .flow-badge{background:var(--paper);white-space:nowrap}
.domain-companion{position:absolute;z-index:20;top:12px;right:12px;width:min(350px,calc(100% - 24px));max-height:calc(100% - 24px);overflow:auto;border:1px solid var(--ink);background:var(--paper);box-shadow:5px 5px 0 var(--line);cursor:default}.domain-companion[hidden]{display:none}.domain-companion__head{position:sticky;z-index:2;top:0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:12px;border-bottom:1px solid var(--ink);background:var(--paper)}.domain-companion__eyebrow{display:block;margin-bottom:3px;color:var(--accent);font-family:var(--mono);font-size:.52rem;letter-spacing:.08em;text-transform:uppercase}.domain-companion__head h3{margin:0;font-family:var(--serif);font-size:1.2rem;line-height:1.1}.domain-companion__close{align-self:start;border:1px solid var(--line);background:transparent;width:26px;height:26px;cursor:pointer}.domain-companion__close:hover,.domain-companion__close:focus-visible{border-color:var(--accent);color:var(--accent);outline:none}.domain-companion__body{padding:12px}.domain-companion__responsibility{margin:0 0 10px;font-family:var(--serif);font-size:.83rem;line-height:1.5}.domain-companion__metrics{display:grid;grid-template-columns:repeat(4,1fr);margin-bottom:12px;border:1px solid var(--line);background:var(--line);gap:1px}.domain-companion__metrics span{display:grid;place-items:center;padding:5px 2px;background:var(--paper);color:var(--muted);font-family:var(--mono);font-size:.47rem;text-align:center}.domain-companion__metrics strong{color:var(--ink);font-family:var(--serif);font-size:.9rem;font-weight:400}.domain-companion__section{margin-top:12px}.domain-companion__section h4{margin:0 0 5px;padding-bottom:4px;border-bottom:1px solid var(--line);color:var(--muted);font-size:.54rem;letter-spacing:.08em;text-transform:uppercase}.domain-file{display:block;width:100%;border:0;border-bottom:1px dashed var(--line);background:transparent;padding:6px 0;text-align:left;cursor:pointer}.domain-file:hover,.domain-file:focus-visible{color:var(--accent);outline:none}.domain-file strong{display:block;font-family:var(--mono);font-size:.58rem;overflow-wrap:anywhere}.domain-file small{display:block;margin-top:2px;color:var(--muted);font-size:.56rem;line-height:1.35}.domain-collaboration,.domain-output,.domain-unknown{padding:6px 0;border-bottom:1px dashed var(--line)}.domain-collaboration strong,.domain-output strong{display:block;font-size:.63rem}.domain-collaboration p,.domain-output p,.domain-unknown p{margin:2px 0 0;color:var(--muted);font-size:.58rem;line-height:1.4}.domain-unknown{color:var(--danger)}
.flow-reference--cycle .flow-reference__button{border-style:solid;border-color:var(--warn);background:color-mix(in oklch,var(--warn) 8%,var(--paper));color:var(--ink)}.flow-reference--cycle .flow-reference__button strong{color:var(--warn)}.flow-reference--cycle .flow-reference__button::after{border-color:var(--warn);border-radius:50%}
.domain-companion{touch-action:pan-y}
@media(max-width:1100px){.workbench{grid-template-columns:260px 1fr}.inspector{display:none}.graph-panel{border-right:0}.metric-strip{grid-template-columns:repeat(3,1fr)}}
@media(max-width:760px){.masthead__body,.section-heading,.stage-inspector,.diagnostic-content{grid-template-columns:1fr}.section-number{display:none}.masthead__top{align-items:flex-start;flex-direction:column}.metric-strip{grid-template-columns:repeat(2,1fr)}.atlas-toolbar{align-items:stretch;flex-direction:column}.search-field{min-width:0}.workbench{grid-template-columns:1fr;height:auto;min-height:0}.explorer{height:330px;border-right:0;border-bottom:1px solid var(--line)}.graph-panel{height:600px}.flow-toolbar{height:auto;min-height:42px;align-items:flex-start;flex-direction:column;padding-top:6px;padding-bottom:6px}.flow-guide{white-space:normal}.stage-evolution{grid-template-columns:68px minmax(0,1fr);gap:8px}.stage-evolution__nav{grid-column:1/-1;justify-content:flex-end}.dependency-flow{padding:38px 24px 80px}.flow-card{width:190px}.flow-card--root{width:210px}.artifact-links{grid-template-columns:1fr}.stage-section,.atlas-section{padding-left:14px;padding-right:14px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.flow-card.flow-reference-arrival::after{display:none;animation:none}}
@media print{.tool-button,.atlas-toolbar,.flow-toolbar{display:none}.workbench{height:700px}.stage-section,.atlas-section{padding:30px}.masthead{padding:30px}}
`
}

function atlasScript() {
  return `
(function(){
  'use strict';
  var model=JSON.parse(document.getElementById('atlas-data').textContent);
  var selectedPath=null;
  var searchValue='';
  var activeTypes=new Set(model.relationTypes.slice(0,6).map(function(item){return item.key;}));
  var nodeById=new Map(model.graph.nodes.map(function(node){return [node.id,node];}));
  var fileByPath=new Map(model.files.map(function(file){return [file.path,file];}));
  var stageRail=document.getElementById('stage-rail');
  var stageInspector=document.getElementById('stage-inspector');
  var fileTree=document.getElementById('file-tree');
  var inspector=document.getElementById('file-inspector');
  var selectionState=document.getElementById('selection-state');
  var canvas=document.getElementById('relation-canvas');
  var shell=document.getElementById('canvas-shell');
  var ctx=canvas.getContext('2d');
  var view={x:0,y:0,scale:1};
  var layout=[];
  var layoutById=new Map();
  var drag=null;
  var hover=null;

  function escapeHtml(value){return String(value==null?'':value).replace(/[&<>\"']/g,function(char){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[char];});}
  function format(value){return new Intl.NumberFormat('en-US').format(value||0);}
  function fileIcon(filePath,isFolder){
    if(isFolder)return '<span class="file-icon icon-folder" aria-hidden="true"><svg viewBox="0 0 16 16"><path class="sheet" d="M1.5 4.5h5l1.4 1.5h6.6v7.5h-13z"/></svg></span>';
    var ext=(filePath.split('.').pop()||'').toLowerCase();var kind='config',glyph='·';
    if(ext==='vue'){kind='vue';glyph='V';}else if(['js','mjs','cjs','jsx'].includes(ext)){kind='js';glyph='JS';}else if(['ts','tsx'].includes(ext)){kind='ts';glyph='TS';}else if(ext==='json'){kind='json';glyph='{}';}else if(['css','less','scss','sass'].includes(ext)){kind='style';glyph='#';}else if(['md','mdx'].includes(ext)){kind='markdown';glyph='M';}else if(['png','jpg','jpeg','gif','svg','webp','ico'].includes(ext)){kind='image';glyph='◇';}else if(['html','htm'].includes(ext)){kind='style';glyph='<> ';}else{glyph=ext.slice(0,2).toUpperCase()||'·';}
    return '<span class="file-icon icon-'+kind+'" aria-hidden="true"><svg viewBox="0 0 16 16"><path class="sheet" d="M3 1.5h6l4 4v9H3zM9 1.5v4h4"/><text x="8" y="11.5" text-anchor="middle">'+escapeHtml(glyph)+'</text></svg></span>';
  }
  function buildTree(files){
    var root={name:model.repo.name,dirs:new Map(),files:[]};
    files.forEach(function(file){var parts=file.path.split('/');var cursor=root;parts.slice(0,-1).forEach(function(part){if(!cursor.dirs.has(part))cursor.dirs.set(part,{name:part,dirs:new Map(),files:[]});cursor=cursor.dirs.get(part);});cursor.files.push(file);});
    return root;
  }
  function treeCount(node){var count=node.files.length;node.dirs.forEach(function(child){count+=treeCount(child);});return count;}
  function renderTreeNode(node,depth,parentPath){
    var html='';var dirs=Array.from(node.dirs.values()).sort(function(a,b){return a.name.localeCompare(b.name);});
    dirs.forEach(function(dir){var full=parentPath?parentPath+'/'+dir.name:dir.name;var open=full==='src'||full==='src/views';html+='<div class="tree-node '+(open?'tree-node--open':'')+'" data-dir="'+escapeHtml(full)+'"><div class="tree-row" role="treeitem" tabindex="0" style="padding-left:'+(depth*12+4)+'px"><span class="tree-twist">'+(open?'⌄':'›')+'</span>'+fileIcon(full,true)+'<span class="tree-name">'+escapeHtml(dir.name)+'</span><span class="tree-count">'+treeCount(dir)+'</span></div><div class="tree-children" role="group">'+renderTreeNode(dir,depth+1,full)+'</div></div>';});
    node.files.sort(function(a,b){return a.name.localeCompare(b.name);}).forEach(function(file){html+='<div class="tree-row tree-file" role="treeitem" tabindex="0" data-file="'+escapeHtml(file.path)+'" style="padding-left:'+(depth*12+18)+'px"><span class="tree-twist"></span>'+fileIcon(file.path,false)+'<span class="tree-name">'+escapeHtml(file.name)+'</span>'+(file.diagnostics?'<span class="tree-count">!'+file.diagnostics+'</span>':'')+'</div>';});
    return html;
  }
  function renderTree(){var filtered=model.files.filter(function(file){return !searchValue||file.path.toLowerCase().includes(searchValue);});fileTree.innerHTML=renderTreeNode(buildTree(filtered),0,'');bindTree();highlightTree();}
  function bindTree(){
    fileTree.querySelectorAll('[data-dir]>.tree-row').forEach(function(row){row.addEventListener('click',function(){var node=row.parentElement;node.classList.toggle('tree-node--open');row.querySelector('.tree-twist').textContent=node.classList.contains('tree-node--open')?'⌄':'›';});row.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();row.click();}});});
    fileTree.querySelectorAll('[data-file]').forEach(function(row){row.addEventListener('click',function(){selectFile(row.dataset.file,true);});row.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();row.click();}});});
  }
  function highlightTree(){fileTree.querySelectorAll('[data-file]').forEach(function(row){row.classList.toggle('tree-row--selected',row.dataset.file===selectedPath);});}
  function renderStages(){stageRail.innerHTML=model.stages.map(function(stage){return '<button class="stage-card stage-card--'+stage.status+(stage.number===model.progress.currentStage?' stage-card--selected':'')+'" type="button" data-stage="'+stage.number+'" role="listitem"><span class="stage-card__number"><span>'+String(stage.number).padStart(2,'0')+'</span><i class="stage-card__status"></i></span><strong>'+escapeHtml(stage.label)+'</strong><small>'+escapeHtml(stage.detail)+'</small></button>';}).join('');stageRail.querySelectorAll('[data-stage]').forEach(function(button){button.addEventListener('click',function(){stageRail.querySelectorAll('.stage-card').forEach(function(item){item.classList.remove('stage-card--selected');});button.classList.add('stage-card--selected');renderStageDetail(model.stages[Number(button.dataset.stage)-1]);});});renderStageDetail(model.stages[model.progress.currentStage-1]);}
  function renderStageDetail(stage){var labels={complete:'已完成',blocked:'已阻塞',failed:'验证失败',active:'执行中',ready:'可执行',waiting:'等待上游'};stageInspector.innerHTML='<div><p class="eyebrow">Stage '+String(stage.number).padStart(2,'0')+' · '+escapeHtml(labels[stage.status]||stage.status)+'</p><h3>'+escapeHtml(stage.label)+'</h3><p>'+escapeHtml(stage.description)+'</p></div><div class="artifact-links">'+stage.artifacts.map(function(item){return '<a class="artifact-link '+(item.present?'':'artifact-link--missing')+'" '+(item.present?'href="'+escapeHtml(item.path)+'"':'aria-disabled="true"')+'><span>'+escapeHtml(item.path)+'</span><strong>'+(item.present?'OPEN':'WAITING')+'</strong></a>';}).join('')+'</div>';}
  function renderFilters(){var host=document.getElementById('relation-filters');host.innerHTML=model.relationTypes.slice(0,10).map(function(item){return '<button type="button" class="filter-chip '+(activeTypes.has(item.key)?'filter-chip--active':'')+'" data-type="'+escapeHtml(item.key)+'">'+escapeHtml(item.key)+' · '+format(item.count)+'</button>';}).join('');host.querySelectorAll('[data-type]').forEach(function(button){button.addEventListener('click',function(){var type=button.dataset.type;if(activeTypes.has(type))activeTypes.delete(type);else activeTypes.add(type);button.classList.toggle('filter-chip--active',activeTypes.has(type));draw();});});}
  function buildLayout(){
    var groups=new Map();model.graph.nodes.forEach(function(node){var key=node.group||'Other';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(node);});
    var ordered=Array.from(groups.entries()).sort(function(a,b){return b[1].length-a[1].length;});var cols=Math.ceil(Math.sqrt(ordered.length));layout=[];layoutById.clear();
    ordered.forEach(function(entry,index){var gx=(index%cols)*310;var gy=Math.floor(index/cols)*250;var members=entry[1].sort(function(a,b){return b.degree-a.degree||a.path.localeCompare(b.path);});members.forEach(function(node,i){var angle=i*2.3999632297;var radius=18*Math.sqrt(i);var point={id:node.id,node:node,x:gx+Math.cos(angle)*radius,y:gy+Math.sin(angle)*radius,r:Math.max(3,Math.min(10,3+Math.log2(node.degree+1)))};layout.push(point);layoutById.set(node.id,point);});});
  }
  function resize(){var rect=shell.getBoundingClientRect();var dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.max(1,Math.floor(rect.width*dpr));canvas.height=Math.max(1,Math.floor(rect.height*dpr));canvas.style.width=rect.width+'px';canvas.style.height=rect.height+'px';ctx.setTransform(dpr,0,0,dpr,0,0);draw();}
  function bounds(){if(!layout.length)return {minX:0,maxX:1,minY:0,maxY:1};return layout.reduce(function(b,p){b.minX=Math.min(b.minX,p.x);b.maxX=Math.max(b.maxX,p.x);b.minY=Math.min(b.minY,p.y);b.maxY=Math.max(b.maxY,p.y);return b;},{minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity});}
  function fit(){var rect=shell.getBoundingClientRect();var b=bounds();var pad=70;view.scale=Math.min((rect.width-pad*2)/Math.max(1,b.maxX-b.minX),(rect.height-pad*2)/Math.max(1,b.maxY-b.minY),1.4);view.x=rect.width/2-(b.minX+b.maxX)/2*view.scale;view.y=rect.height/2-(b.minY+b.maxY)/2*view.scale;draw();}
  function css(name){return getComputedStyle(document.documentElement).getPropertyValue(name).trim();}
  function nodeColor(kind){var colors={view:'oklch(56% .12 34)',page:'oklch(56% .12 34)',component:'oklch(54% .11 255)',api:'oklch(51% .1 155)',state:'oklch(60% .12 83)',route:'oklch(52% .13 35)',config:'oklch(55% .05 78)',test:'oklch(60% .1 310)',source:'oklch(49% .05 230)'};return colors[kind]||colors.source;}
  function worldToScreen(point){return {x:point.x*view.scale+view.x,y:point.y*view.scale+view.y};}
  function screenToWorld(x,y){return {x:(x-view.x)/view.scale,y:(y-view.y)/view.scale};}
  function visibleEdge(edge){return Object.keys(edge.types).some(function(type){return activeTypes.has(type);});}
  function neighborSet(){var set=new Set(selectedPath?[selectedPath]:[]);if(selectedPath)model.graph.edges.forEach(function(edge){if(edge.source===selectedPath)set.add(edge.target);if(edge.target===selectedPath)set.add(edge.source);});return set;}
  function draw(){
    var rect=shell.getBoundingClientRect();ctx.clearRect(0,0,rect.width,rect.height);var neighbors=neighborSet();ctx.save();ctx.translate(view.x,view.y);ctx.scale(view.scale,view.scale);
    model.graph.edges.forEach(function(edge){if(!visibleEdge(edge))return;var a=layoutById.get(edge.source),b=layoutById.get(edge.target);if(!a||!b)return;var emphasized=selectedPath&&(edge.source===selectedPath||edge.target===selectedPath);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=emphasized?css('--accent'):css('--line');ctx.globalAlpha=emphasized?.88:(selectedPath?.12:.28);ctx.lineWidth=(emphasized?1.7:.55)/view.scale;ctx.stroke();});
    layout.forEach(function(point){var selected=point.id===selectedPath,related=neighbors.has(point.id),dimmed=selectedPath&&!related;ctx.globalAlpha=dimmed?.18:1;ctx.beginPath();ctx.arc(point.x,point.y,(selected?point.r+3:point.r)/view.scale*.85+point.r*.15,0,Math.PI*2);ctx.fillStyle=nodeColor(point.node.kind);ctx.fill();if(point.node.diagnostics){ctx.strokeStyle=css('--danger');ctx.lineWidth=1.4/view.scale;ctx.stroke();}if(selected||point.id===hover){ctx.strokeStyle=css('--ink');ctx.lineWidth=2/view.scale;ctx.stroke();}if(selected||point.id===hover||(related&&view.scale>1.15)||(view.scale>1.75&&point.node.degree>2)){ctx.globalAlpha=1;ctx.fillStyle=css('--ink');ctx.font=(selected?'700 ':'')+(10/view.scale)+'px '+css('--sans');ctx.fillText(point.node.label,point.x+9/view.scale,point.y-7/view.scale);}});ctx.restore();ctx.globalAlpha=1;
  }
  function hitTest(x,y){var world=screenToWorld(x,y),best=null,bestDistance=14/view.scale;layout.forEach(function(point){var dx=point.x-world.x,dy=point.y-world.y,d=Math.sqrt(dx*dx+dy*dy);if(d<bestDistance){best=point;bestDistance=d;}});return best;}
  function selectFile(filePath,center){selectedPath=filePath;highlightTree();renderInspector();document.getElementById('graph-caption').textContent=filePath||'全部文件关系';if(center&&layoutById.has(filePath)){var rect=shell.getBoundingClientRect(),point=layoutById.get(filePath);view.scale=Math.max(view.scale,1.35);view.x=rect.width/2-point.x*view.scale;view.y=rect.height/2-point.y*view.scale;}draw();}
  function renderInspector(){
    var file=fileByPath.get(selectedPath),node=nodeById.get(selectedPath);if(!file){selectionState.textContent='NO SELECTION';inspector.innerHTML='<div class="empty-state"><strong>选择一个文件</strong><p>从文件树或关系画布选择节点，查看依赖、诊断和上下游文件。</p></div>';return;}selectionState.textContent=(node?node.kind:file.kind).toUpperCase();
    var related=model.graph.edges.filter(function(edge){return edge.source===selectedPath||edge.target===selectedPath;}).sort(function(a,b){return b.count-a.count;}).slice(0,40);
    inspector.innerHTML='<h3 class="file-title">'+escapeHtml(file.name)+'</h3><p class="file-path">'+escapeHtml(file.path)+'</p><dl class="property-list"><div><dt>Language</dt><dd>'+escapeHtml(file.language)+'</dd></div><div><dt>Lines</dt><dd>'+format(file.lines)+'</dd></div><div><dt>Size</dt><dd>'+format(file.size)+' B</dd></div><div><dt>Relations</dt><dd>'+format(node?node.degree:0)+'</dd></div><div><dt>Routes</dt><dd>'+format(file.routes)+'</dd></div><div><dt>Diagnostics</dt><dd>'+format(file.diagnostics)+'</dd></div><div><dt>Community</dt><dd>'+escapeHtml(node&&node.community?'#'+node.community:'unassigned')+'</dd></div></dl><div class="relation-list"><h4>Connected files · '+related.length+'</h4>'+related.map(function(edge){var other=edge.source===selectedPath?edge.target:edge.source;var direction=edge.source===selectedPath?'→':'←';return '<div class="relation-item" role="button" tabindex="0" data-related="'+escapeHtml(other)+'"><i></i><div><strong>'+direction+' '+escapeHtml(other)+'</strong><small>'+escapeHtml(Object.keys(edge.types).join(' · '))+' · '+edge.count+'</small></div></div>';}).join('')+'</div>';
    inspector.querySelectorAll('[data-related]').forEach(function(item){item.addEventListener('click',function(){selectFile(item.dataset.related,true);});item.addEventListener('keydown',function(event){if(event.key==='Enter'){item.click();}});});
  }
  canvas.addEventListener('pointerdown',function(event){canvas.setPointerCapture(event.pointerId);drag={x:event.clientX,y:event.clientY,vx:view.x,vy:view.y,moved:false};});
  canvas.addEventListener('pointermove',function(event){var rect=canvas.getBoundingClientRect();if(drag){var dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;view.x=drag.vx+dx;view.y=drag.vy+dy;draw();return;}var hit=hitTest(event.clientX-rect.left,event.clientY-rect.top);var next=hit?hit.id:null;if(next!==hover){hover=next;canvas.style.cursor=hover?'pointer':'grab';draw();}});
  canvas.addEventListener('pointerup',function(event){var rect=canvas.getBoundingClientRect();if(drag&&!drag.moved){var hit=hitTest(event.clientX-rect.left,event.clientY-rect.top);if(hit)selectFile(hit.id,false);}drag=null;});
  canvas.addEventListener('wheel',function(event){event.preventDefault();var rect=canvas.getBoundingClientRect(),mx=event.clientX-rect.left,my=event.clientY-rect.top,world=screenToWorld(mx,my),factor=Math.exp(-event.deltaY*.001);view.scale=Math.max(.12,Math.min(4,view.scale*factor));view.x=mx-world.x*view.scale;view.y=my-world.y*view.scale;draw();},{passive:false});
  document.getElementById('file-search').addEventListener('input',function(event){searchValue=event.target.value.trim().toLowerCase();renderTree();var match=model.files.find(function(file){return searchValue&&file.path.toLowerCase().includes(searchValue);});if(match)selectFile(match.path,true);});
  document.getElementById('fit-graph').addEventListener('click',fit);
  document.getElementById('theme-toggle').addEventListener('click',function(){var root=document.documentElement;root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';draw();});
  new ResizeObserver(resize).observe(shell);
  renderStages();renderFilters();renderTree();buildLayout();resize();requestAnimationFrame(function(){fit();if(location.hash==='#atlas')document.getElementById('atlas').scrollIntoView();});
})();
`
}

function atlasFlowScript() {
  return `
(function(){
  'use strict';
  var model=JSON.parse(document.getElementById('atlas-data').textContent);
  var CHILD_BATCH=3;
  var searchValue='';
  var selectedStage=model.progress.currentStatus==='waiting'&&model.progress.completedStages>0?model.progress.completedStages:model.progress.currentStage;
  var flowDirection='downstream';
  var activeTypes=new Set(model.relationTypes.slice(0,6).map(function(item){return item.key;}));
  var nodeById=new Map(model.graph.nodes.map(function(node){return [node.id,node];}));
  var fileByPath=new Map(model.files.map(function(file){return [file.path,file];}));
  var rankedNodes=model.graph.nodes.slice().sort(function(a,b){return b.degree-a.degree||a.path.localeCompare(b.path);});
  var rootPath=nodeById.has('src/main.ts')?'src/main.ts':(rankedNodes[0]?rankedNodes[0].path:null);
  var selectedPath=rootPath;
  var expandedNodes=new Set(rootPath?[rootPath]:[]);
  var expandedSemanticSummaries=new Set();
  var childLimits=new Map();
  var stageRail=document.getElementById('stage-rail');
  var stageInspector=document.getElementById('stage-inspector');
  var stageEvolution=document.getElementById('stage-evolution');
  var fileTree=document.getElementById('file-tree');
  var inspector=document.getElementById('file-inspector');
  var selectionState=document.getElementById('selection-state');
  var flowHost=document.getElementById('dependency-flow');
  var flowViewport=document.getElementById('flow-viewport');
  var domainCompanion=document.getElementById('domain-companion');
  var focusedDomainZoneId=null;
  var domainSummaryByZone=new Map(model.repositoryDomainSummaries.summaries.map(function(summary){return [summary.zoneId,summary];}));
  var nodeOrdinal=new Map(model.graph.nodes.map(function(node,index){return [node.id,index+1];}));
  var CAMERA_MIN_SCALE=.45;
  var CAMERA_MAX_SCALE=2;
  var camera={x:0,y:0,scale:1};
  var activePointers=new Map();
  var multiPointerGesture=null;
  var suppressCanvasClick=false;
  var lastViewportSize={width:0,height:0};
  var safariGestureStart=null;
  var cameraAnimationFrame=0;
  var referenceArrivalTimer=0;
  var prefersReducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');

  function escapeHtml(value){return String(value==null?'':value).replace(/[&<>\"']/g,function(char){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[char];});}
  function format(value){return new Intl.NumberFormat('en-US').format(value||0);}
  function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
  function applyCamera(){flowViewport.scrollLeft=0;flowViewport.scrollTop=0;flowHost.style.transform='translate('+camera.x.toFixed(2)+'px,'+camera.y.toFixed(2)+'px) scale('+camera.scale.toFixed(4)+')';flowViewport.dataset.cameraX=camera.x.toFixed(2);flowViewport.dataset.cameraY=camera.y.toFixed(2);flowViewport.dataset.cameraScale=camera.scale.toFixed(4);}
  function cancelCameraAnimation(){if(cameraAnimationFrame){cancelAnimationFrame(cameraAnimationFrame);cameraAnimationFrame=0;}flowViewport.dataset.cameraAnimating='false';}
  function easeOutQuint(value){return 1-Math.pow(1-value,5);}
  function animateCameraTo(nextX,nextY,onComplete){cancelCameraAnimation();var startX=camera.x;var startY=camera.y;var deltaX=nextX-startX;var deltaY=nextY-startY;var distance=Math.hypot(deltaX,deltaY);if(prefersReducedMotion.matches||distance<1){camera.x=nextX;camera.y=nextY;applyCamera();if(onComplete)onComplete();return;}var duration=clamp(300+distance*.08,320,480);var startedAt=performance.now();flowViewport.dataset.cameraAnimating='true';function step(now){var progress=clamp((now-startedAt)/duration,0,1);var eased=easeOutQuint(progress);camera.x=startX+deltaX*eased;camera.y=startY+deltaY*eased;applyCamera();if(progress<1){cameraAnimationFrame=requestAnimationFrame(step);return;}cameraAnimationFrame=0;flowViewport.dataset.cameraAnimating='false';if(onComplete)onComplete();}cameraAnimationFrame=requestAnimationFrame(step);}
  function zoomCameraAt(nextScale,clientX,clientY){cancelCameraAnimation();var rect=flowViewport.getBoundingClientRect();var pointX=Number.isFinite(clientX)?clientX-rect.left:rect.width/2;var pointY=Number.isFinite(clientY)?clientY-rect.top:rect.height/2;var oldScale=camera.scale;var scale=clamp(nextScale,CAMERA_MIN_SCALE,CAMERA_MAX_SCALE);if(Math.abs(scale-oldScale)<.0001)return;var sceneX=(pointX-camera.x)/oldScale;var sceneY=(pointY-camera.y)/oldScale;camera.scale=scale;camera.x=pointX-sceneX*scale;camera.y=pointY-sceneY*scale;applyCamera();}
  function sceneRect(element){var hostRect=flowHost.getBoundingClientRect();var rect=element.getBoundingClientRect();return {left:(rect.left-hostRect.left)/camera.scale,top:(rect.top-hostRect.top)/camera.scale,width:rect.width/camera.scale,height:rect.height/camera.scale};}
  function primaryFlowElement(){return flowHost.querySelector('[data-node-card]')||flowHost.querySelector('.stage-preview,.flow-empty')||flowHost.firstElementChild;}
  function centerCameraOnPrimary(){var primary=primaryFlowElement();if(!primary)return;cancelCameraAnimation();var rect=sceneRect(primary);camera.x=flowViewport.clientWidth/2-(rect.left+rect.width/2)*camera.scale;camera.y=0;applyCamera();lastViewportSize={width:flowViewport.clientWidth,height:flowViewport.clientHeight};}
  function markReferenceArrival(element){clearTimeout(referenceArrivalTimer);flowHost.querySelectorAll('.flow-reference-arrival').forEach(function(card){card.classList.remove('flow-reference-arrival');});element.classList.add('flow-reference-arrival');referenceArrivalTimer=setTimeout(function(){element.classList.remove('flow-reference-arrival');},600);}
  function revealCameraElement(element,animated,center,onComplete){var viewportRect=flowViewport.getBoundingClientRect();var rect=element.getBoundingClientRect();var margin=32;var usableRight=viewportRect.right;if(center&&domainCompanion&&!domainCompanion.hidden){var companionRect=domainCompanion.getBoundingClientRect();if(companionRect.left>viewportRect.left+160&&companionRect.left<usableRight)usableRight=companionRect.left-16;}var deltaX=center?(viewportRect.left+usableRight)/2-(rect.left+rect.width/2):rect.left<viewportRect.left+margin?viewportRect.left+margin-rect.left:rect.right>viewportRect.right-margin?viewportRect.right-margin-rect.right:0;var deltaY=center?(viewportRect.top+viewportRect.bottom)/2-(rect.top+rect.height/2):rect.top<viewportRect.top+margin?viewportRect.top+margin-rect.top:rect.bottom>viewportRect.bottom-margin?viewportRect.bottom-margin-rect.bottom:0;var nextX=camera.x+deltaX;var nextY=camera.y+deltaY;if(animated){animateCameraTo(nextX,nextY,onComplete);return;}cancelCameraAnimation();camera.x=nextX;camera.y=nextY;applyCamera();if(onComplete)onComplete();}
  function fileIcon(filePath,isFolder){
    if(isFolder)return '<span class="file-icon icon-folder" aria-hidden="true"><svg viewBox="0 0 16 16"><path class="sheet" d="M1.5 4.5h5l1.4 1.5h6.6v7.5h-13z"/></svg></span>';
    var ext=(filePath.split('.').pop()||'').toLowerCase();var kind='config',glyph='·';
    if(ext==='vue'){kind='vue';glyph='V';}else if(['js','mjs','cjs','jsx'].includes(ext)){kind='js';glyph='JS';}else if(['ts','tsx'].includes(ext)){kind='ts';glyph='TS';}else if(ext==='json'){kind='json';glyph='{}';}else if(['css','less','scss','sass'].includes(ext)){kind='style';glyph='#';}else if(['md','mdx'].includes(ext)){kind='markdown';glyph='M';}else if(['png','jpg','jpeg','gif','svg','webp','ico'].includes(ext)){kind='image';glyph='◇';}else if(['html','htm'].includes(ext)){kind='style';glyph='<>'; }else{glyph=ext.slice(0,2).toUpperCase()||'·';}
    return '<span class="file-icon icon-'+kind+'" aria-hidden="true"><svg viewBox="0 0 16 16"><path class="sheet" d="M3 1.5h6l4 4v9H3zM9 1.5v4h4"/><text x="8" y="11.5" text-anchor="middle">'+escapeHtml(glyph)+'</text></svg></span>';
  }
  function buildTree(files){var root={name:model.repo.name,dirs:new Map(),files:[]};files.forEach(function(file){var parts=file.path.split('/');var cursor=root;parts.slice(0,-1).forEach(function(part){if(!cursor.dirs.has(part))cursor.dirs.set(part,{name:part,dirs:new Map(),files:[]});cursor=cursor.dirs.get(part);});cursor.files.push(file);});return root;}
  function treeCount(node){var count=node.files.length;node.dirs.forEach(function(child){count+=treeCount(child);});return count;}
  function renderTreeNode(node,depth,parentPath){
    var html='';var dirs=Array.from(node.dirs.values()).sort(function(a,b){return a.name.localeCompare(b.name);});
    dirs.forEach(function(dir){var full=parentPath?parentPath+'/'+dir.name:dir.name;var open=full==='src'||full==='src/views';html+='<div class="tree-node '+(open?'tree-node--open':'')+'" data-dir="'+escapeHtml(full)+'"><div class="tree-row" role="treeitem" tabindex="0" style="padding-left:'+(depth*12+4)+'px"><span class="tree-twist">'+(open?'⌄':'›')+'</span>'+fileIcon(full,true)+'<span class="tree-name">'+escapeHtml(dir.name)+'</span><span class="tree-count">'+treeCount(dir)+'</span></div><div class="tree-children" role="group">'+renderTreeNode(dir,depth+1,full)+'</div></div>';});
    node.files.sort(function(a,b){return a.name.localeCompare(b.name);}).forEach(function(file){html+='<div class="tree-row tree-file" role="treeitem" tabindex="0" data-file="'+escapeHtml(file.path)+'" style="padding-left:'+(depth*12+18)+'px"><span class="tree-twist"></span>'+fileIcon(file.path,false)+'<span class="tree-name">'+escapeHtml(file.name)+'</span>'+(file.diagnostics?'<span class="tree-count">!'+file.diagnostics+'</span>':'')+'</div>';});return html;
  }
  function renderTree(){var filtered=model.files.filter(function(file){return !searchValue||file.path.toLowerCase().includes(searchValue);});fileTree.innerHTML=renderTreeNode(buildTree(filtered),0,'');bindTree();highlightTree();}
  function bindTree(){
    fileTree.querySelectorAll('[data-dir]>.tree-row').forEach(function(row){row.addEventListener('click',function(){var treeNode=row.parentElement;treeNode.classList.toggle('tree-node--open');row.querySelector('.tree-twist').textContent=treeNode.classList.contains('tree-node--open')?'⌄':'›';});row.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();row.click();}});});
    fileTree.querySelectorAll('[data-file]').forEach(function(row){row.addEventListener('click',function(){selectFile(row.dataset.file,true);});row.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();row.click();}});});
  }
  function highlightTree(){fileTree.querySelectorAll('[data-file]').forEach(function(row){row.classList.toggle('tree-row--selected',row.dataset.file===selectedPath);});}
  function stageStatusLabel(status){return {complete:'已完成',blocked:'已阻塞',failed:'验证失败',active:'执行中',ready:'可执行',waiting:'等待上游'}[status]||status;}
  function domainStageActive(){return selectedStage===7||selectedStage===8;}
  function domainUnderstandingActive(){return selectedStage===8;}
  function selectStage(stageNumber,scrollToAtlas){selectedStage=Math.max(1,Math.min(model.stages.length,stageNumber));if(!domainUnderstandingActive())focusedDomainZoneId=null;renderStages();renderStageDetail(model.stages[selectedStage-1]);renderEvolution();renderDomainControls();renderInspector();renderFlow(true);if(scrollToAtlas)document.getElementById('atlas').scrollIntoView({behavior:'smooth',block:'start'});}
  function renderStages(){
    stageRail.innerHTML=model.stages.map(function(stage){return '<button class="stage-card stage-card--'+stage.status+(stage.number===selectedStage?' stage-card--selected':'')+'" type="button" data-stage="'+stage.number+'" role="listitem"><span class="stage-card__number"><span>'+String(stage.number).padStart(2,'0')+'</span><i class="stage-card__status"></i></span><strong>'+escapeHtml(stage.label)+'</strong><small>'+escapeHtml(stage.detail)+'</small></button>';}).join('');
    stageRail.querySelectorAll('[data-stage]').forEach(function(button){button.addEventListener('click',function(){selectStage(Number(button.dataset.stage),true);});});
  }
  function renderStageDetail(stage){stageInspector.innerHTML='<div><p class="eyebrow">Stage '+String(stage.number).padStart(2,'0')+' · '+escapeHtml(stageStatusLabel(stage.status))+'</p><h3>'+escapeHtml(stage.label)+'</h3><p>'+escapeHtml(stage.description)+'</p></div><div class="artifact-links">'+stage.artifacts.map(function(item){return '<a class="artifact-link '+(item.present?'':'artifact-link--missing')+'" '+(item.present?'href="'+escapeHtml(item.path)+'"':'aria-disabled="true"')+'><span>'+escapeHtml(item.path)+'</span><strong>'+(item.present?'OPEN':'WAITING')+'</strong></a>';}).join('')+'</div>';}
  function stageChange(stage){
    if(stage.status==='waiting'||stage.number>model.progress.currentStage)return {title:'本阶段尚未执行',detail:'画布停留在 Stage '+String(model.progress.currentStage).padStart(2,'0')+' 的真实产物，不预演不存在的数据。',delta:'LOCKED',locked:true};
    if(stage.number===1)return {title:'建立仓库文件基线',detail:format(model.summary.files)+' 个文件进入可浏览清单，先能回答“代码在哪里”。',delta:'+'+format(model.summary.files)+' FILES'};
    if(stage.number===2)return {title:'增加分析范围门禁',detail:'支持级别确认为 '+model.repo.supportLevel+'，后续图谱受此范围约束。',delta:'SCOPE GATE'};
    if(stage.number===3)return {title:'首次生成文件级依赖流',detail:format(model.graph.nodes.length)+' 个文件节点、'+format(model.graph.edges.length)+' 条文件关系变为可追踪结构。',delta:'+'+format(model.graph.edges.length)+' EDGES'};
    if(stage.number===4)return {title:'在静态图上增加调查入口',detail:stage.detail+'；文件图不变，新增的是下一阶段研究要从哪里开始。',delta:'ENTRY POINTS'};
    if(stage.number===5)return {title:'为节点语义分析建立有限批次',detail:format(model.summary.semanticBatches)+' 个有界批次覆盖 '+format(model.summary.eligibleSemanticNodes)+' 个可分析代码文件；不再依赖模板问题数量。',delta:stage.status==='blocked'?'BLOCKED':'PLAN READY'};
    if(stage.number===6)return {title:'给文件卡片补充局部语义',detail:format(model.summary.acceptedSemanticNodes)+' / '+format(model.summary.eligibleSemanticNodes||model.summary.semanticNodes)+' 个文件语义已接纳；不在本阶段拼装业务路径。',delta:format(model.summary.acceptedSemanticNodes)+'/'+format(model.summary.eligibleSemanticNodes||model.summary.semanticNodes)+' ACCEPTED'};
    if(stage.number===7&&model.summary.repositoryZones>0&&model.repositoryZones.preview)return {title:'Domain Agent 草稿已投到原始文件树',detail:format(model.summary.zonedFiles)+' 个文件暂分为 '+format(model.summary.repositoryZones)+' 个领域和 '+format(model.summary.repositorySubzones)+' 个子领域；当前仅供预览，独立审核通过前不属于权威产物。',delta:'DRAFT · '+format(model.summary.repositoryZones)+' DOMAINS'};
    if(stage.number===7&&model.summary.repositoryZones>0)return {title:'Domain Agent 已将同一棵文件树组织为仓库领域',detail:format(model.summary.zonedFiles)+' 个文件经独立 Agent 审核后唯一归入 '+format(model.summary.repositoryZones)+' 个领域和 '+format(model.summary.repositorySubzones)+' 个子领域；'+format(model.summary.unclassifiedFiles)+' 个归属仍待确认。',delta:format(model.summary.repositoryZones)+' DOMAINS'};
    if(stage.number===7)return {title:'等待仓库语义分区',detail:'S6 节点语义已就绪；运行 zone-plan 后，同一画布会按领域重新组织文件。',delta:'ZONING READY'};
    if(stage.number===8&&model.summary.understoodDomains>0&&model.repositoryDomainSummaries.preview)return {title:'领域理解 Agent 草稿已回到同一棵树',detail:format(model.summary.understoodDomains)+' 个领域已有职责、入口、核心与边界草稿；点击领域标题可原位聚焦，独立审核前仅供预览。',delta:'DRAFT · '+format(model.summary.understoodDomains)+' SUMMARIES'};
    if(stage.number===8&&model.summary.understoodDomains>0)return {title:'领域职责与边界已通过独立 Agent 审核',detail:format(model.summary.understoodDomains)+' 个领域、'+format(model.summary.domainEntryFiles)+' 个入口、'+format(model.summary.domainCoreFiles)+' 个核心文件和 '+format(model.summary.domainBoundaryFiles)+' 个边界文件已映射回原始树。',delta:format(model.summary.understoodDomains)+' UNDERSTOOD'};
    if(stage.number===8)return {title:'等待领域理解 Agent',detail:'S7 领域与文件归属保持不变；本阶段只解释领域职责、入口、核心、边界和协作关系。',delta:'INTERPRETATION READY'};
    return {title:stage.label+' 产物已生成',detail:stage.description,delta:stageStatusLabel(stage.status).toUpperCase()};
  }
  function renderEvolution(){var stage=model.stages[selectedStage-1];var change=stageChange(stage);stageEvolution.className='stage-evolution'+(change.locked?' stage-evolution--locked':'');stageEvolution.innerHTML='<span class="stage-evolution__stage">Stage '+String(stage.number).padStart(2,'0')+'<br>'+escapeHtml(stageStatusLabel(stage.status))+'</span><span class="stage-evolution__change"><strong>'+escapeHtml(change.title)+'</strong><span>'+escapeHtml(change.detail)+'</span></span><span class="stage-evolution__nav"><button type="button" class="stage-evolution__step" data-evolution-step="'+(selectedStage-1)+'" aria-label="上一个阶段" '+(selectedStage===1?'disabled':'')+'>←</button><span class="stage-evolution__delta">'+escapeHtml(change.delta)+'</span><button type="button" class="stage-evolution__step" data-evolution-step="'+(selectedStage+1)+'" aria-label="下一个阶段" '+(selectedStage===model.stages.length?'disabled':'')+'>→</button></span>';stageEvolution.querySelectorAll('[data-evolution-step]').forEach(function(button){button.addEventListener('click',function(){selectStage(Number(button.dataset.evolutionStep),false);});});}
  function renderDomainControls(){
    var active=domainStageActive();var hasZones=model.repositoryZones.zones.length>0;document.querySelector('.flow-guide').textContent=!active?'双指捏合缩放 · 三指/鼠标拖拽移动 · 点“展开”继续一层':domainUnderstandingActive()?(model.summary.understoodDomains>0?'点击领域标题聚焦 · 卡片标记入口 / 核心 / 边界 · 原树结构不变':'沿用 S7 树形结构 · 等待 Agent 解释领域职责与边界'):hasZones?(model.repositoryZones.preview?'沿用 S6 树形结构 · 当前为 Agent 草稿预览，尚未通过独立审核':'沿用 S6 树形结构 · Agent 领域随展开和收起实时重排'):'沿用 S6 树形结构 · 等待 Domain Agent 提出并审核领域划分';
  }
  function renderFilters(){var host=document.getElementById('relation-filters');host.innerHTML=model.relationTypes.slice(0,10).map(function(item){return '<button type="button" class="filter-chip '+(activeTypes.has(item.key)?'filter-chip--active':'')+'" data-type="'+escapeHtml(item.key)+'">'+escapeHtml(item.key)+' · '+format(item.count)+'</button>';}).join('');host.querySelectorAll('[data-type]').forEach(function(button){button.addEventListener('click',function(){var type=button.dataset.type;if(activeTypes.has(type))activeTypes.delete(type);else activeTypes.add(type);button.classList.toggle('filter-chip--active',activeTypes.has(type));renderFlow(false);});});}
  function visibleTypes(edge){return Object.entries(edge.types).filter(function(entry){return activeTypes.has(entry[0]);}).sort(function(a,b){return b[1]-a[1]||a[0].localeCompare(b[0]);});}
  function connectionsFor(filePath,direction){var items=[];model.graph.edges.forEach(function(edge){var next=direction==='downstream'&&edge.source===filePath?edge.target:direction==='upstream'&&edge.target===filePath?edge.source:null;if(!next)return;var types=visibleTypes(edge);if(!types.length)return;items.push({path:next,edge:edge,types:types,count:types.reduce(function(total,item){return total+item[1];},0)});});return items.sort(function(a,b){return b.count-a.count||a.path.localeCompare(b.path);});}
  function connections(filePath){return connectionsFor(filePath,flowDirection);}
  function reuseCount(filePath){return connectionsFor(filePath,flowDirection==='downstream'?'upstream':'downstream').length;}
  function relationLabel(connection){return connection.types.slice(0,2).map(function(entry){return entry[0]+(entry[1]>1?' ×'+entry[1]:'');}).join(' · ');}
  function resetExpansion(){expandedNodes.clear();childLimits.clear();if(rootPath)expandedNodes.add(rootPath);}
  function setRoot(filePath){if(!nodeById.has(filePath))return;rootPath=filePath;selectedPath=filePath;resetExpansion();highlightTree();renderInspector();renderFlow(true);}
  function selectFile(filePath,makeRoot){if(!fileByPath.has(filePath))return;selectedPath=filePath;highlightTree();renderInspector();if(makeRoot){setRoot(filePath);return;}renderFlow(false);}
  function repositoryDomainRoles(filePath){if(!domainUnderstandingActive())return [];var zoneMeta=repositoryZoneMeta(filePath);var summary=zoneMeta?domainSummaryByZone.get(zoneMeta.zone.zoneId):null;if(!summary)return [];var roles=[];if(summary.entryFiles.some(function(item){return item.filePath===filePath;}))roles.push({label:'入口',className:'flow-badge--domain-role'});if(summary.coreFiles.some(function(item){return item.filePath===filePath;}))roles.push({label:'核心',className:'flow-badge--domain-role'});if(summary.boundaryFiles.some(function(item){return item.filePath===filePath;}))roles.push({label:'边界',className:'flow-badge--domain-role flow-badge--domain-boundary'});return roles;}
  function isCrossDomainConnection(connection){if(!domainUnderstandingActive()||!connection?.edge)return false;var source=repositoryMembership(connection.edge.source);var target=repositoryMembership(connection.edge.target);return Boolean(source&&target&&source.zoneId!==target.zoneId);}
  function nodeBadges(node,children,state,depth,filePath){var badges=[];var reuse=reuseCount(filePath);var zoneMeta=domainStageActive()?repositoryZoneMeta(filePath):null;if(zoneMeta)badges.push('<span class="flow-badge flow-badge--zone">'+escapeHtml(zoneMeta.zone.label)+' · '+escapeHtml(zoneMeta.subzone.label)+'</span>');badges.push('<span class="flow-badge">'+children.length+' '+(flowDirection==='downstream'?'下游':'上游')+'</span>');if(selectedStage>=6&&node.semantic)badges.push('<span class="flow-badge flow-badge--semantic">'+(node.semantic.status==='accepted'?'语义已接纳':'语义草稿')+'</span>');if(reuse>1)badges.push('<span class="flow-badge">被 '+reuse+' 个'+(flowDirection==='downstream'?'上游':'下游')+'复用</span>');if(node.diagnostics)badges.push('<span class="flow-badge flow-badge--danger">'+node.diagnostics+' diagnostics</span>');return badges.join('');}
  function renderFlowBranch(filePath,connection,depth,ancestors,seen,stats){
    var node=nodeById.get(filePath);if(!node)return '';
    var cycle=ancestors.has(filePath);var duplicate=!cycle&&depth>0&&seen.has(filePath);var state=cycle?'cycle':duplicate?'duplicate':'';if(!cycle&&!duplicate)seen.add(filePath);
    var relation=connection?'<span class="flow-relation'+(isCrossDomainConnection(connection)?' flow-relation--domain-boundary':'')+'" title="'+escapeHtml(relationLabel(connection))+'">'+escapeHtml(relationLabel(connection))+'</span>':'';
    if(cycle){stats.references+=1;stats.cycles=(stats.cycles||0)+1;return '<div class="flow-branch flow-branch--child flow-reference flow-reference--cycle">'+relation+'<button type="button" class="flow-reference__button" data-shared-ref="'+escapeHtml(filePath)+'" data-reference-kind="cycle" title="回到已显示的 '+escapeHtml(node.label)+'"><strong>↩ '+escapeHtml(node.label)+'</strong><small>事件回路 · 返回已有节点</small></button></div>';}
    if(duplicate){stats.references+=1;return '<div class="flow-branch flow-branch--child flow-reference">'+relation+'<button type="button" class="flow-reference__button" data-shared-ref="'+escapeHtml(filePath)+'" data-reference-kind="shared" title="该文件只保留一张完整卡片"><strong>↗ '+escapeHtml(node.label)+'</strong><small>共享节点 · 已合并到首次出现</small></button></div>';}
    var children=connections(filePath);var terminal=Boolean(state);var expanded=!terminal&&expandedNodes.has(filePath)&&children.length>0;var limit=childLimits.get(filePath)||CHILD_BATCH;var shown=expanded?children.slice(0,limit):[];if(domainStageActive()&&model.repositoryZones.zones.length)shown=arrangeVisibleDomainChildren(shown);stats.nodes+=1;stats.maxDepth=Math.max(stats.maxDepth,depth);
    var zoneMeta=domainStageActive()?repositoryZoneMeta(filePath):null;var cardClass='flow-card flow-card--kind-'+escapeHtml(node.kind)+(depth===0?' flow-card--root':'')+(selectedPath===filePath?' flow-card--selected':'')+(terminal?' flow-card--terminal':'')+(zoneMeta?' semantic-zone-node semantic-zone-node--tone-'+zoneMeta.tone:'');
    var hasSemantic=selectedStage>=6&&node.semantic;var semanticExpanded=hasSemantic&&expandedSemanticSummaries.has(filePath);var semanticId='flow-semantic-'+(nodeOrdinal.get(filePath)||0);
    var actions='';if(depth>0&&!state)actions+='<button type="button" class="flow-action" data-root="'+escapeHtml(filePath)+'">设为根</button>';if(hasSemantic)actions+='<button type="button" class="flow-action flow-action--semantic" data-semantic-summary-toggle="'+escapeHtml(filePath)+'" aria-expanded="'+(semanticExpanded?'true':'false')+'" aria-controls="'+semanticId+'" aria-label="'+(semanticExpanded?'收起 ':'展开 ')+escapeHtml(node.label)+' 的完整语义摘要">'+(semanticExpanded?'收起语义':'展开语义全文')+'</button>';if(children.length&&!terminal)actions+='<button type="button" class="flow-action flow-action--expand" data-expand="'+escapeHtml(filePath)+'" aria-expanded="'+(expanded?'true':'false')+'">'+(expanded?'收起':'展开下一层 · '+Math.min(children.length,CHILD_BATCH))+'</button>';
    var semanticHtml=hasSemantic?'<p id="'+semanticId+'" class="flow-card__semantic'+(semanticExpanded?'':' flow-card__semantic--collapsed')+'">'+escapeHtml(node.semantic.responsibility.summary)+'</p>':'';
    var domainRoles=repositoryDomainRoles(filePath);var domainRoleHtml=domainRoles.length?'<span class="domain-role-strip" aria-label="领域角色">'+domainRoles.map(function(role){return '<span class="flow-badge '+role.className+'">'+role.label+'</span>';}).join('')+'</span>':'';
    var html='<div class="flow-branch '+(depth>0?'flow-branch--child ':'')+(expanded?'flow-branch--expanded':'')+'">'+relation+'<div class="flow-node-wrap"><article class="'+cardClass+'" data-node-card="'+escapeHtml(filePath)+'"'+(zoneMeta?' data-zone-id="'+escapeHtml(zoneMeta.zone.zoneId)+'"':'')+'>'+domainRoleHtml+'<button type="button" class="flow-card__button" data-select="'+escapeHtml(filePath)+'"><span class="flow-card__meta"><span class="flow-card__kind flow-card__kind--'+escapeHtml(node.kind)+'"><i></i>'+escapeHtml(node.kind)+'</span><span>'+format(node.degree)+' relations</span></span><h4>'+escapeHtml(node.label)+'</h4><p class="flow-card__path">'+escapeHtml(node.path)+'</p>'+semanticHtml+'<span class="flow-badges">'+nodeBadges(node,children,state,depth,filePath)+'</span></button>'+(actions?'<div class="flow-card__actions">'+actions+'</div>':'')+'</article></div>';
    if(expanded){var nextAncestors=new Set(ancestors);nextAncestors.add(filePath);html+='<div class="flow-children">'+shown.map(function(child){return renderFlowBranch(child.path,child,depth+1,nextAncestors,seen,stats);}).join('');if(children.length>shown.length)html+='<div class="flow-more-branch"><button type="button" class="flow-more" data-more="'+escapeHtml(filePath)+'">+'+(children.length-shown.length)+' 个未展开</button></div>';html+='</div>';}
    return html+'</div>';
  }
  function svgNode(name,attributes){var node=document.createElementNS('http://www.w3.org/2000/svg',name);Object.entries(attributes||{}).forEach(function(entry){node.setAttribute(entry[0],String(entry[1]));});return node;}
  function sharedDom(filePath){return {references:Array.from(flowHost.querySelectorAll('[data-shared-ref]')).filter(function(element){return element.dataset.sharedRef===filePath;}),target:Array.from(flowHost.querySelectorAll('[data-node-card]')).find(function(element){return element.dataset.nodeCard===filePath;})||null};}
  function setSharedHighlight(filePath,active){var related=sharedDom(filePath);related.references.forEach(function(element){element.classList.toggle('flow-shared-active',active);});if(related.target)related.target.classList.toggle('flow-shared-active',active);flowHost.querySelectorAll('[data-shared-group]').forEach(function(group){if(group.dataset.sharedGroup===filePath)group.classList.toggle('shared-link-group--active',active);});}
  function drawSharedLinks(){
    flowHost.querySelectorAll('.shared-link-layer').forEach(function(layer){layer.remove();});flowHost.querySelectorAll('.flow-shared-active').forEach(function(element){element.classList.remove('flow-shared-active');});
    var referenceGroups=new Map();flowHost.querySelectorAll('[data-shared-ref]').forEach(function(reference){var filePath=reference.dataset.sharedRef;var values=referenceGroups.get(filePath)||[];values.push(reference);referenceGroups.set(filePath,values);});if(!referenceGroups.size)return;
    var hostRect=flowHost.getBoundingClientRect();var width=Math.max(flowHost.scrollWidth,flowHost.offsetWidth);var height=Math.max(flowHost.scrollHeight,flowHost.offsetHeight);var svg=svgNode('svg',{class:'shared-link-layer',width:width,height:height,viewBox:'0 0 '+width+' '+height,'aria-hidden':'true'});var defs=svgNode('defs');var marker=svgNode('marker',{id:'shared-link-arrow',markerWidth:8,markerHeight:8,refX:7,refY:4,orient:'auto',markerUnits:'strokeWidth'});marker.appendChild(svgNode('path',{class:'shared-link-arrow',d:'M0,0 L8,4 L0,8 Z'}));defs.appendChild(marker);svg.appendChild(defs);
    referenceGroups.forEach(function(references,filePath){var target=sharedDom(filePath).target;if(!target)return;var targetRect=target.getBoundingClientRect();var targetX=(targetRect.left-hostRect.left+targetRect.width/2)/camera.scale;var targetY=(targetRect.bottom-hostRect.top)/camera.scale;var sourcePoints=references.map(function(reference){var rect=reference.getBoundingClientRect();return {x:(rect.left-hostRect.left+rect.width/2)/camera.scale,y:(rect.bottom-hostRect.top)/camera.scale};});var busY=Math.min(height-18,Math.max(targetY,...sourcePoints.map(function(point){return point.y;}))+24);var xValues=[targetX].concat(sourcePoints.map(function(point){return point.x;}));var minX=Math.min.apply(Math,xValues);var maxX=Math.max.apply(Math,xValues);var group=svgNode('g',{class:'shared-link-group','data-shared-group':filePath});group.appendChild(svgNode('path',{class:'shared-link-bus',d:'M '+minX+' '+busY+' H '+maxX}));sourcePoints.forEach(function(point){group.appendChild(svgNode('path',{class:'shared-link-stem',d:'M '+point.x+' '+point.y+' V '+busY}));group.appendChild(svgNode('circle',{class:'shared-link-junction',cx:point.x,cy:busY,r:3}));});group.appendChild(svgNode('path',{class:'shared-link-target',d:'M '+targetX+' '+busY+' V '+targetY,'marker-end':'url(#shared-link-arrow)'}));var label=svgNode('text',{class:'shared-link-label',x:(minX+maxX)/2,y:busY-6,'text-anchor':'middle'});var cycleCount=references.filter(function(reference){return reference.dataset.referenceKind==='cycle';}).length;var sharedCount=references.length-cycleCount;label.textContent=cycleCount&&sharedCount?'共享 '+sharedCount+' · 回路 '+cycleCount:cycleCount?'事件回路 · '+cycleCount+' 条':'共享汇流 · '+(references.length+1)+' 处';group.appendChild(label);svg.appendChild(group);target.classList.add('flow-shared-target');});
    flowHost.prepend(svg);
  }
  function repositoryMembership(filePath){return model.repositoryZones.memberships.find(function(item){return item.filePath===filePath;})||null;}
  function repositoryZoneMeta(filePath){var membership=repositoryMembership(filePath);if(!membership)return null;var zoneIndex=model.repositoryZones.zones.findIndex(function(item){return item.zoneId===membership.zoneId;});var zone=model.repositoryZones.zones[zoneIndex];if(!zone)return null;var subzone=zone.subzones.find(function(item){return item.subzoneId===membership.subzoneId;})||{subzoneId:membership.subzoneId,label:membership.subzoneId};return {membership:membership,zone:zone,subzone:subzone,tone:Math.max(0,zoneIndex)%6};}
  function repositoryZoneLabel(zoneId){var zone=model.repositoryZones.zones.find(function(item){return item.zoneId===zoneId;});return zone?zone.label:zoneId;}
  function domainDirectionLabel(direction){return {inbound:'接收',outbound:'输出',bidirectional:'双向'}[direction]||direction;}
  function renderDomainFiles(title,items){if(!items||!items.length)return '';return '<section class="domain-companion__section"><h4>'+escapeHtml(title)+' · '+items.length+'</h4>'+items.map(function(item){return '<button type="button" class="domain-file" data-domain-file="'+escapeHtml(item.filePath)+'"><strong>'+escapeHtml(item.filePath)+'</strong><small>'+escapeHtml(item.reason)+'</small></button>';}).join('')+'</section>';}
  function renderDomainCompanion(){if(!domainUnderstandingActive()||!focusedDomainZoneId){domainCompanion.hidden=true;domainCompanion.innerHTML='';return;}var summary=domainSummaryByZone.get(focusedDomainZoneId);var zone=model.repositoryZones.zones.find(function(item){return item.zoneId===focusedDomainZoneId;});domainCompanion.hidden=false;if(!summary){domainCompanion.innerHTML='<header class="domain-companion__head"><div><span class="domain-companion__eyebrow">Stage 08 · waiting</span><h3>'+escapeHtml(zone?zone.label:focusedDomainZoneId)+'</h3></div><button type="button" class="domain-companion__close" data-domain-close aria-label="显示全部领域">×</button></header><div class="domain-companion__body"><p class="domain-companion__responsibility">这个领域尚未产生经约束的 Agent 摘要，S7 文件归属仍然有效。</p></div>';bindDomainCompanion();return;}var state=model.repositoryDomainSummaries.preview?'Agent 草稿 · 待独立审核':'独立 Agent 已审核';var collaborations=(summary.collaboratingDomains||[]).map(function(item){return '<div class="domain-collaboration"><strong>'+escapeHtml(repositoryZoneLabel(item.zoneId))+' · '+escapeHtml(domainDirectionLabel(item.direction))+' · '+format(item.relationCount)+' 条关系</strong><p>'+escapeHtml(item.summary)+'</p></div>';}).join('');var outputs=(summary.outputs||[]).map(function(item){return '<div class="domain-output"><strong>'+escapeHtml(item.name)+'</strong><p>'+escapeHtml(item.description)+'</p></div>';}).join('');var unknowns=(summary.unknowns||[]).map(function(item){return '<div class="domain-unknown"><strong>尚未确认</strong><p>'+escapeHtml(item.question)+' · '+escapeHtml(item.reason)+'</p></div>';}).join('');domainCompanion.innerHTML='<header class="domain-companion__head"><div><span class="domain-companion__eyebrow">Stage 08 · '+escapeHtml(state)+' · '+Math.round((summary.confidence||0)*100)+'%</span><h3>'+escapeHtml(summary.label)+'</h3></div><button type="button" class="domain-companion__close" data-domain-close aria-label="显示全部领域">×</button></header><div class="domain-companion__body"><p class="domain-companion__responsibility">'+escapeHtml(summary.responsibility.summary)+'</p><div class="domain-companion__metrics"><span><strong>'+summary.entryFiles.length+'</strong>入口</span><span><strong>'+summary.coreFiles.length+'</strong>核心</span><span><strong>'+summary.boundaryFiles.length+'</strong>边界</span><span><strong>'+summary.collaboratingDomains.length+'</strong>协作</span></div>'+renderDomainFiles('入口文件',summary.entryFiles)+renderDomainFiles('核心文件',summary.coreFiles)+renderDomainFiles('边界文件',summary.boundaryFiles)+(collaborations?'<section class="domain-companion__section"><h4>协作领域</h4>'+collaborations+'</section>':'')+(outputs?'<section class="domain-companion__section"><h4>领域产物</h4>'+outputs+'</section>':'')+(unknowns?'<section class="domain-companion__section"><h4>未知项</h4>'+unknowns+'</section>':'')+'</div>';bindDomainCompanion();}
  function bindDomainCompanion(){domainCompanion.querySelectorAll('[data-domain-close]').forEach(function(button){button.addEventListener('click',function(){setDomainFocus(null);});});domainCompanion.querySelectorAll('[data-domain-file]').forEach(function(button){button.addEventListener('click',function(){selectFile(button.dataset.domainFile,true);});});}
  function domainCollaboratorZoneIds(zoneId){var summary=domainSummaryByZone.get(zoneId);return new Set((summary?.collaboratingDomains||[]).map(function(item){return item.zoneId;}));}
  function applyDomainFocus(){var zoneId=domainUnderstandingActive()?focusedDomainZoneId:null;var collaborators=zoneId?domainCollaboratorZoneIds(zoneId):new Set();setSemanticTerritoryFocus(zoneId);flowHost.querySelectorAll('[data-zone-id]').forEach(function(card){var cardZoneId=card.dataset.zoneId;card.classList.toggle('domain-card--focused',Boolean(zoneId)&&cardZoneId===zoneId);card.classList.toggle('domain-card--collaborator',Boolean(zoneId)&&collaborators.has(cardZoneId));card.classList.toggle('domain-card--dimmed',Boolean(zoneId)&&cardZoneId!==zoneId&&!collaborators.has(cardZoneId));});renderDomainCompanion();}
  function setDomainFocus(zoneId){focusedDomainZoneId=zoneId&&focusedDomainZoneId===zoneId?null:zoneId;applyDomainFocus();}
  function arrangeVisibleDomainChildren(items){var zoneOrder=new Map(model.repositoryZones.zones.map(function(zone,index){return [zone.zoneId,index];}));return items.map(function(item,index){var meta=repositoryZoneMeta(item.path);return {item:item,index:index,zoneIndex:meta?(zoneOrder.get(meta.zone.zoneId)||0):999,subzoneId:meta?meta.subzone.subzoneId:''};}).sort(function(a,b){return a.zoneIndex-b.zoneIndex||a.subzoneId.localeCompare(b.subzoneId)||a.index-b.index;}).map(function(entry){return entry.item;});}
  function collectVisibleRepositoryGraph(){var paths=[];var pathSet=new Set();var edges=[];var references=0;var cycles=0;var maxDepth=0;var depthByPath=new Map();function visit(filePath,depth,ancestors){var node=nodeById.get(filePath);if(!node)return;if(pathSet.has(filePath)){references+=1;return;}pathSet.add(filePath);paths.push(filePath);depthByPath.set(filePath,depth);maxDepth=Math.max(maxDepth,depth);var children=connections(filePath);if(!expandedNodes.has(filePath)||!children.length)return;var limit=childLimits.get(filePath)||CHILD_BATCH;var nextAncestors=new Set(ancestors);nextAncestors.add(filePath);children.slice(0,limit).forEach(function(connection){edges.push({source:filePath,target:connection.path,connection:connection});if(nextAncestors.has(connection.path)){references+=1;cycles+=1;return;}if(pathSet.has(connection.path)){references+=1;return;}visit(connection.path,depth+1,nextAncestors);});}if(rootPath)visit(rootPath,0,new Set());return {paths:paths,pathSet:pathSet,edges:edges,references:references,cycles:cycles,maxDepth:maxDepth,depthByPath:depthByPath};}
  function buildVisibleRepositoryRegions(visible){var membershipByPath=new Map(model.repositoryZones.memberships.map(function(item){return [item.filePath,item];}));var zoneById=new Map(model.repositoryZones.zones.map(function(zone){return [zone.zoneId,zone];}));var groups=new Map();visible.paths.forEach(function(filePath){var membership=membershipByPath.get(filePath);if(!membership)return;var zone=zoneById.get(membership.zoneId);if(!zone)return;var group=groups.get(zone.zoneId);if(!group){group={zone:zone,paths:[],subzoneMap:new Map()};groups.set(zone.zoneId,group);}group.paths.push(filePath);var subzone=zone.subzones.find(function(item){return item.subzoneId===membership.subzoneId;})||{subzoneId:membership.subzoneId,label:membership.subzoneId,description:'当前可见节点的语义子区域。',confidence:membership.confidence};var subGroup=group.subzoneMap.get(subzone.subzoneId);if(!subGroup){subGroup={subzone:subzone,paths:[]};group.subzoneMap.set(subzone.subzoneId,subGroup);}subGroup.paths.push(filePath);});return model.repositoryZones.zones.map(function(zone){var group=groups.get(zone.zoneId);if(!group)return null;return {zone:zone,paths:group.paths,subzones:Array.from(group.subzoneMap.values())};}).filter(Boolean);}
  function semanticTerritoryCardBounds(card,hostRect){var rect=card.getBoundingClientRect();return {left:(rect.left-hostRect.left)/camera.scale,top:(rect.top-hostRect.top)/camera.scale,right:(rect.right-hostRect.left)/camera.scale,bottom:(rect.bottom-hostRect.top)/camera.scale,width:rect.width/camera.scale,height:rect.height/camera.scale};}
  function semanticTerritoryHull(points){var ordered=points.slice().sort(function(a,b){return a.x-b.x||a.y-b.y;});if(ordered.length<=1)return ordered;function cross(origin,a,b){return (a.x-origin.x)*(b.y-origin.y)-(a.y-origin.y)*(b.x-origin.x);}var lower=[];ordered.forEach(function(point){while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],point)<=0)lower.pop();lower.push(point);});var upper=[];ordered.slice().reverse().forEach(function(point){while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],point)<=0)upper.pop();upper.push(point);});lower.pop();upper.pop();return lower.concat(upper);}
  function territoryPointToward(from,to,distance){var length=Math.hypot(to.x-from.x,to.y-from.y)||1;var amount=Math.min(distance,length/3);return {x:from.x+(to.x-from.x)*amount/length,y:from.y+(to.y-from.y)*amount/length};}
  function roundedTerritoryPath(points){if(points.length<3)return '';var corners=points.map(function(point,index){var previous=points[(index-1+points.length)%points.length];var next=points[(index+1)%points.length];return {point:point,entry:territoryPointToward(point,previous,22),exit:territoryPointToward(point,next,22)};});var path='M '+corners[0].entry.x+' '+corners[0].entry.y+' Q '+corners[0].point.x+' '+corners[0].point.y+' '+corners[0].exit.x+' '+corners[0].exit.y;for(var index=1;index<corners.length;index+=1){var corner=corners[index];path+=' L '+corner.entry.x+' '+corner.entry.y+' Q '+corner.point.x+' '+corner.point.y+' '+corner.exit.x+' '+corner.exit.y;}return path+' Z';}
  function setSemanticTerritoryFocus(zoneId){var layers=flowHost.querySelectorAll('.semantic-territory-layer');if(!layers.length)return;var collaborators=zoneId?domainCollaboratorZoneIds(zoneId):new Set();layers.forEach(function(layer){layer.classList.toggle('semantic-territory-layer--focus',Boolean(zoneId));layer.querySelectorAll('[data-territory-zone]').forEach(function(group){group.classList.toggle('semantic-territory--active',group.dataset.territoryZone===zoneId);group.classList.toggle('semantic-territory--collaborator',Boolean(zoneId)&&collaborators.has(group.dataset.territoryZone));});});}
  function drawSemanticTerritories(visible){flowHost.querySelectorAll('.semantic-territory-layer').forEach(function(layer){layer.remove();});var regions=buildVisibleRepositoryRegions(visible);if(!regions.length)return;var cards=new Map(Array.from(flowHost.querySelectorAll('[data-node-card]')).map(function(card){return [card.dataset.nodeCard,card];}));if(!cards.size)return;var hostRect=flowHost.getBoundingClientRect();var width=Math.max(flowHost.scrollWidth,flowHost.offsetWidth);var height=Math.max(flowHost.scrollHeight,flowHost.offsetHeight);var shapeSvg=svgNode('svg',{class:'semantic-territory-layer semantic-territory-layer--shapes',width:width,height:height,viewBox:'0 0 '+width+' '+height,'aria-hidden':'true'});var labelSvg=svgNode('svg',{class:'semantic-territory-layer semantic-territory-layer--labels',width:width,height:height,viewBox:'0 0 '+width+' '+height,'aria-hidden':domainUnderstandingActive()?'false':'true'});regions.forEach(function(region,regionIndex){var regionCards=region.paths.map(function(filePath){return cards.get(filePath);}).filter(Boolean);if(!regionCards.length)return;var bounds=regionCards.map(function(card){return semanticTerritoryCardBounds(card,hostRect);});var zoneIndex=model.repositoryZones.zones.findIndex(function(item){return item.zoneId===region.zone.zoneId;});var className='semantic-territory semantic-territory--tone-'+(Math.max(0,zoneIndex)%6);var shapeGroup=svgNode('g',{class:className,'data-territory-zone':region.zone.zoneId});if(bounds.length===1){var bound=bounds[0];shapeGroup.appendChild(svgNode('ellipse',{class:'semantic-territory__shape',cx:bound.left+bound.width/2,cy:bound.top+bound.height/2,rx:bound.width/2+22,ry:bound.height/2+18}));}else{var padding=20;var hull=semanticTerritoryHull(bounds.flatMap(function(bound){return [{x:bound.left-padding,y:bound.top-padding},{x:bound.right+padding,y:bound.top-padding},{x:bound.right+padding,y:bound.bottom+padding},{x:bound.left-padding,y:bound.bottom+padding}];}));shapeGroup.appendChild(svgNode('path',{class:'semantic-territory__shape',d:roundedTerritoryPath(hull)}));}shapeSvg.appendChild(shapeGroup);var minX=Math.min.apply(Math,bounds.map(function(bound){return bound.left;}));var minY=Math.min.apply(Math,bounds.map(function(bound){return bound.top;}));var labelText=(model.repositoryZones.preview?'草稿 · ':'')+region.zone.label+' · '+regionCards.length;var labelX=Math.max(8,minX+4);var labelY=Math.max(20,minY-8);var labelAttributes={class:className,'data-territory-zone':region.zone.zoneId};if(domainUnderstandingActive()){labelAttributes.class+=' semantic-territory__label-action';labelAttributes['data-domain-focus']=region.zone.zoneId;labelAttributes.role='button';labelAttributes.tabindex='0';labelAttributes['aria-label']='聚焦领域 '+region.zone.label;}var labelGroup=svgNode('g',labelAttributes);if(domainUnderstandingActive())labelGroup.appendChild(svgNode('rect',{class:'semantic-territory__label-backdrop',x:labelX-5,y:labelY-14,width:Math.max(96,labelText.length*8+10),height:19}));var label=svgNode('text',{class:'semantic-territory__label',x:labelX,y:labelY});label.textContent=labelText;labelGroup.appendChild(label);labelSvg.appendChild(labelGroup);});flowHost.prepend(shapeSvg);flowHost.appendChild(labelSvg);bindDomainTitleActions();applyDomainFocus();}
  function bindDomainTitleActions(){flowHost.querySelectorAll('[data-domain-focus]').forEach(function(label){label.addEventListener('click',function(event){event.preventDefault();setDomainFocus(label.dataset.domainFocus);});label.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();setDomainFocus(label.dataset.domainFocus);}});});}
  function bindSemanticTerritories(){if(domainUnderstandingActive())return;flowHost.querySelectorAll('[data-zone-id]').forEach(function(card){card.addEventListener('mouseenter',function(){setSemanticTerritoryFocus(card.dataset.zoneId);});card.addEventListener('mouseleave',function(){setSemanticTerritoryFocus(null);});card.addEventListener('focusin',function(){setSemanticTerritoryFocus(card.dataset.zoneId);});card.addEventListener('focusout',function(){setSemanticTerritoryFocus(null);});});}
  function renderRepositoryZones(centerRoot){if(!rootPath||!nodeById.has(rootPath)){flowHost.innerHTML='<div class="flow-empty"><strong>没有可展示的文件关系</strong><p>当前关系筛选下没有文件级节点。</p></div>';renderDomainCompanion();return;}var visible=collectVisibleRepositoryGraph();var regions=buildVisibleRepositoryRegions(visible);var stats={nodes:0,references:0,cycles:0,maxDepth:0};flowHost.innerHTML='<div class="semantic-tree-layout">'+renderFlowBranch(rootPath,null,0,new Set(),new Set(),stats)+'</div>';bindFlow();bindSemanticTerritories();var stagePrefix=domainUnderstandingActive()?(model.repositoryDomainSummaries.preview?'S8 待审核领域理解 · ':'S8 领域理解 · '):(model.repositoryZones.preview?'待审核草稿 · ':'');document.getElementById('graph-caption').textContent=stagePrefix+rootPath+' · 原始树形布局 · '+format(visible.paths.length)+' 个可见节点 / '+format(visible.references)+' 个节点引用（'+format(visible.cycles)+' 条回路） / '+format(regions.length)+' 个当前区域 / '+(visible.maxDepth+1)+' 层';requestAnimationFrame(function(){drawSemanticTerritories(visible);drawSharedLinks();if(centerRoot)centerCameraOnPrimary();else applyCamera();});}
  function topDirectories(){var counts=new Map();model.files.forEach(function(file){var part=file.path.split('/')[0]||'root';counts.set(part,(counts.get(part)||0)+1);});return Array.from(counts.entries()).sort(function(a,b){return b[1]-a[1]||a[0].localeCompare(b[0]);});}
  function renderStagePreview(stage){
    if(stage.status==='waiting'||stage.number>model.progress.currentStage)return '<div class="flow-empty"><strong>Stage '+String(stage.number).padStart(2,'0')+' 尚未产生</strong><p>当前没有可展示的阶段产物。画布不会用最终结果冒充历史结果。</p></div>';
    if(stage.number===1){var dirs=topDirectories();var visible=dirs.slice(0,6);if(dirs.length>6)visible.push(['其他目录',dirs.slice(6).reduce(function(total,item){return total+item[1];},0)]);return '<div class="stage-preview"><div class="stage-preview__root"><strong>'+escapeHtml(model.repo.name)+'</strong><small>'+format(model.summary.files)+' files · inventory snapshot</small></div><div class="stage-preview__stem"></div><div class="stage-preview__children">'+visible.map(function(item){return '<div class="stage-preview__card"><strong>'+escapeHtml(item[0])+'</strong><small>'+format(item[1])+' files</small></div>';}).join('')+'</div></div>';}
    return '<div class="stage-preview"><div class="stage-preview__root"><strong>'+escapeHtml(model.repo.name)+'</strong><small>Snapshot scope</small></div><div class="stage-preview__stem"></div><div class="stage-preview__children"><div class="stage-preview__card"><strong>'+escapeHtml(model.repo.supportLevel)+'</strong><small>support decision</small></div><div class="stage-preview__card"><strong>'+format(model.summary.files)+' files</strong><small>inside analysis scope</small></div></div></div>';
  }
  function renderFlow(centerRoot){
    renderDomainCompanion();var stage=model.stages[selectedStage-1];var canShowGraph=selectedStage>=3&&selectedStage<=model.progress.currentStage&&stage.status!=='waiting';document.querySelectorAll('[data-direction]').forEach(function(button){button.disabled=!canShowGraph;button.classList.toggle('direction-button--active',button.dataset.direction===flowDirection);button.setAttribute('aria-pressed',button.dataset.direction===flowDirection?'true':'false');});
    if(!canShowGraph){flowHost.innerHTML=renderStagePreview(stage);document.getElementById('graph-caption').textContent='Stage '+String(stage.number).padStart(2,'0')+' · '+stage.label;requestAnimationFrame(function(){if(centerRoot)centerCameraOnPrimary();else applyCamera();});return;}
    if(domainStageActive()&&model.repositoryZones.zones.length){renderRepositoryZones(centerRoot);return;}
    if(!rootPath||!nodeById.has(rootPath)){flowHost.innerHTML='<div class="flow-empty"><strong>没有可展示的文件关系</strong><p>当前关系筛选下没有文件级节点。</p></div>';requestAnimationFrame(function(){if(centerRoot)centerCameraOnPrimary();else applyCamera();});return;}
    var stats={nodes:0,references:0,cycles:0,maxDepth:0};flowHost.innerHTML=renderFlowBranch(rootPath,null,0,new Set(),new Set(),stats);document.getElementById('graph-caption').textContent=rootPath+' · '+(flowDirection==='downstream'?'下游':'上游')+' · '+stats.nodes+' 个唯一节点 / '+stats.references+' 个节点引用（'+stats.cycles+' 条回路） / '+(stats.maxDepth+1)+' 层';bindFlow();requestAnimationFrame(function(){drawSharedLinks();if(centerRoot)centerCameraOnPrimary();else applyCamera();});
  }
  function bindFlow(){
    flowHost.querySelectorAll('[data-select]').forEach(function(button){button.addEventListener('click',function(){selectFile(button.dataset.select,false);});});
    flowHost.querySelectorAll('[data-shared-ref]').forEach(function(button){var filePath=button.dataset.sharedRef;button.addEventListener('mouseenter',function(){setSharedHighlight(filePath,true);});button.addEventListener('mouseleave',function(){setSharedHighlight(filePath,false);});button.addEventListener('focus',function(){setSharedHighlight(filePath,true);});button.addEventListener('blur',function(){setSharedHighlight(filePath,false);});button.addEventListener('click',function(){selectFile(filePath,false);requestAnimationFrame(function(){var target=Array.from(flowHost.querySelectorAll('[data-node-card]')).find(function(card){return card.dataset.nodeCard===filePath;});if(target){revealCameraElement(target,true,true,function(){markReferenceArrival(target);});setSharedHighlight(filePath,true);}});});});
    flowHost.querySelectorAll('[data-node-card]').forEach(function(card){var filePath=card.dataset.nodeCard;if(!sharedDom(filePath).references.length)return;card.addEventListener('mouseenter',function(){setSharedHighlight(filePath,true);});card.addEventListener('mouseleave',function(){setSharedHighlight(filePath,false);});card.addEventListener('focusin',function(){setSharedHighlight(filePath,true);});card.addEventListener('focusout',function(){setSharedHighlight(filePath,false);});});
    flowHost.querySelectorAll('[data-expand]').forEach(function(button){button.addEventListener('click',function(){var filePath=button.dataset.expand;if(expandedNodes.has(filePath))expandedNodes.delete(filePath);else expandedNodes.add(filePath);renderFlow(false);});});
    flowHost.querySelectorAll('[data-root]').forEach(function(button){button.addEventListener('click',function(){setRoot(button.dataset.root);});});
    flowHost.querySelectorAll('[data-semantic-summary-toggle]').forEach(function(button){button.addEventListener('click',function(){var filePath=button.dataset.semanticSummaryToggle;if(expandedSemanticSummaries.has(filePath))expandedSemanticSummaries.delete(filePath);else expandedSemanticSummaries.add(filePath);renderFlow(false);requestAnimationFrame(function(){var next=Array.from(flowHost.querySelectorAll('[data-semantic-summary-toggle]')).find(function(item){return item.dataset.semanticSummaryToggle===filePath;});if(next)next.focus();});});});
    flowHost.querySelectorAll('[data-more]').forEach(function(button){button.addEventListener('click',function(){var filePath=button.dataset.more;childLimits.set(filePath,(childLimits.get(filePath)||CHILD_BATCH)+CHILD_BATCH);renderFlow(false);});});
  }
  function semanticEvidenceLabel(evidence){return (evidence||[]).map(function(item){return item.sourcePath+':'+item.startLine+'-'+item.endLine;}).join(' · ');}
  function renderSemanticGroup(id,title,items){if(!items||!items.length)return '';return '<details class="semantic-group" id="semantic-'+id+'" tabindex="-1" open><summary><span>'+escapeHtml(title)+'</span><small>'+items.length+' 项</small></summary><div class="semantic-group__body">'+items.map(function(item){var confidence=Number.isFinite(item.confidence)?'<span class="semantic-item__confidence">'+Math.round(item.confidence*100)+'%</span>':'';return '<div class="semantic-item"><strong><span>'+escapeHtml(item.name)+'</span>'+confidence+'</strong><p>'+escapeHtml(item.description)+'</p><span class="semantic-evidence">'+escapeHtml(semanticEvidenceLabel(item.evidence))+'</span></div>';}).join('')+'</div></details>';}
  function renderSemanticPanel(semantic){
    if(selectedStage<6)return '';
    if(!semantic)return '<div class="semantic-panel semantic-panel--empty">Stage 6 尚未为这个节点生成语义。结构关系仍然有效，但这里不会补写猜测。</div>';
    var collaborators=(semantic.collaborators||[]).map(function(item){return {name:item.filePath,description:item.role,evidence:item.evidence};});
    var sections=[['responsibility','职责',true],['inputs','输入',semantic.inputs],['actions','动作',semantic.actions],['state','状态',semantic.state],['outputs','输出',semantic.outputs],['conditions','条件',semantic.conditions],['boundaries','职责边界',semantic.boundaries],['collaborators','直接协作者',collaborators],['unknowns','未知项',semantic.unknowns]].filter(function(section){return section[2]===true||(section[2]||[]).length;});
    var navigation='<nav class="semantic-nav" aria-label="语义章节">'+sections.map(function(section){return '<a href="#semantic-'+section[0]+'" data-semantic-nav>'+escapeHtml(section[1])+'</a>';}).join('')+'</nav>';
    var unknowns=(semantic.unknowns||[]).length?'<details class="semantic-group" id="semantic-unknowns" tabindex="-1" open><summary><span>未知项</span><small>'+semantic.unknowns.length+' 项</small></summary><div class="semantic-group__body">'+semantic.unknowns.map(function(item){var evidence=semanticEvidenceLabel(item.evidence);return '<div class="semantic-unknown"><strong>'+escapeHtml(item.kind)+'</strong> · '+escapeHtml(item.question)+'<br>'+escapeHtml(item.reason)+(evidence?'<span class="semantic-evidence">'+escapeHtml(evidence)+'</span>':'')+'</div>';}).join('')+'</div></details>':'';
    return '<section class="semantic-panel"><div class="semantic-panel__head"><strong>'+escapeHtml(semantic.title)+'</strong><span>'+escapeHtml(semantic.status)+' · '+Math.round((semantic.confidence||0)*100)+'%</span></div>'+navigation+'<section class="semantic-responsibility-section" id="semantic-responsibility" tabindex="-1"><strong class="semantic-section-label">职责</strong><p class="semantic-responsibility">'+escapeHtml(semantic.responsibility.summary)+'</p><span class="semantic-evidence">'+escapeHtml(semanticEvidenceLabel(semantic.responsibility.evidence))+'</span></section>'+renderSemanticGroup('inputs','输入',semantic.inputs)+renderSemanticGroup('actions','动作',semantic.actions)+renderSemanticGroup('state','状态',semantic.state)+renderSemanticGroup('outputs','输出',semantic.outputs)+renderSemanticGroup('conditions','条件',semantic.conditions)+renderSemanticGroup('boundaries','职责边界',semantic.boundaries)+renderSemanticGroup('collaborators','直接协作者',collaborators)+unknowns+'</section>';
  }
  function renderInspector(){
    var file=fileByPath.get(selectedPath),node=nodeById.get(selectedPath);if(!file){selectionState.textContent='NO SELECTION';inspector.innerHTML='<div class="empty-state"><strong>选择一个文件</strong><p>从文件树或依赖流选择节点，查看依赖、诊断和上下游文件。</p></div>';return;}selectionState.textContent=(node?node.kind:file.kind).toUpperCase();
    var related=model.graph.edges.filter(function(edge){return edge.source===selectedPath||edge.target===selectedPath;}).sort(function(a,b){return b.count-a.count;}).slice(0,40);
    inspector.innerHTML='<h3 class="file-title">'+escapeHtml(file.name)+'</h3><p class="file-path">'+escapeHtml(file.path)+'</p><dl class="property-list"><div><dt>Language</dt><dd>'+escapeHtml(file.language)+'</dd></div><div><dt>Lines</dt><dd>'+format(file.lines)+'</dd></div><div><dt>Size</dt><dd>'+format(file.size)+' B</dd></div><div><dt>Relations</dt><dd>'+format(node?node.degree:0)+'</dd></div><div><dt>Routes</dt><dd>'+format(file.routes)+'</dd></div><div><dt>Diagnostics</dt><dd>'+format(file.diagnostics)+'</dd></div><div><dt>Community</dt><dd>'+escapeHtml(node&&node.community?'#'+node.community:'unassigned')+'</dd></div></dl>'+renderSemanticPanel(file.semantic)+'<div class="relation-list"><h4>Connected files · '+related.length+'</h4>'+related.map(function(edge){var other=edge.source===selectedPath?edge.target:edge.source;var direction=edge.source===selectedPath?'→':'←';return '<div class="relation-item" role="button" tabindex="0" data-related="'+escapeHtml(other)+'"><i></i><div><strong>'+direction+' '+escapeHtml(other)+'</strong><small>'+escapeHtml(Object.keys(edge.types).join(' · '))+' · '+edge.count+'</small></div></div>';}).join('')+'</div>';
    inspector.querySelectorAll('[data-semantic-nav]').forEach(function(link){link.addEventListener('click',function(event){var target=inspector.querySelector(link.getAttribute('href'));if(!target)return;event.preventDefault();target.scrollIntoView({block:'start'});target.focus({preventScroll:true});});});
    inspector.querySelectorAll('[data-related]').forEach(function(item){item.addEventListener('click',function(){selectFile(item.dataset.related,true);});item.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){item.click();}});});
  }
  function setPanning(active){flowViewport.classList.toggle('flow-viewport--panning',active);}
  function pointerDistance(first,second){return Math.hypot(second.x-first.x,second.y-first.y);}
  function pointerMidpoint(first,second){return {x:(first.x+second.x)/2,y:(first.y+second.y)/2};}
  function pointerCentroid(points){return {x:points.reduce(function(total,point){return total+point.x;},0)/points.length,y:points.reduce(function(total,point){return total+point.y;},0)/points.length};}
  function startMultiPointerGesture(){var points=Array.from(activePointers.values());if(points.length<2){multiPointerGesture=null;return;}if(points.length>2){multiPointerGesture={kind:'pan',ids:points.map(function(point){return point.id;}),centroid:pointerCentroid(points),x:camera.x,y:camera.y};return;}var midpoint=pointerMidpoint(points[0],points[1]);var viewportRect=flowViewport.getBoundingClientRect();var anchorX=midpoint.x-viewportRect.left;var anchorY=midpoint.y-viewportRect.top;multiPointerGesture={kind:'pinch',ids:[points[0].id,points[1].id],distance:pointerDistance(points[0],points[1]),scale:camera.scale,sceneX:(anchorX-camera.x)/camera.scale,sceneY:(anchorY-camera.y)/camera.scale,anchorX:anchorX,anchorY:anchorY};}
  function capturePointer(pointerId){try{flowViewport.setPointerCapture(pointerId);}catch(error){}}
  function releasePointer(pointerId){try{if(flowViewport.hasPointerCapture(pointerId))flowViewport.releasePointerCapture(pointerId);}catch(error){}}
  domainCompanion.addEventListener('wheel',function(event){event.stopPropagation();},{passive:true});
  domainCompanion.addEventListener('pointerdown',function(event){event.stopPropagation();});
  flowViewport.addEventListener('wheel',function(event){event.preventDefault();if(event.ctrlKey)zoomCameraAt(camera.scale*Math.exp(-event.deltaY*.01),event.clientX,event.clientY);},{passive:false});
  flowViewport.addEventListener('pointerdown',function(event){if(event.pointerType==='mouse'&&event.button!==0)return;cancelCameraAnimation();activePointers.set(event.pointerId,{id:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY});if(activePointers.size>1){activePointers.forEach(function(point){capturePointer(point.id);});startMultiPointerGesture();suppressCanvasClick=true;setPanning(true);}else if(!event.target.closest('button,a,input,summary,[role="button"]'))flowViewport.focus({preventScroll:true});});
  flowViewport.addEventListener('pointermove',function(event){var previous=activePointers.get(event.pointerId);if(!previous)return;if(event.pointerType==='mouse'&&(event.buttons&1)===0)return;var next={id:event.pointerId,x:event.clientX,y:event.clientY,startX:previous.startX,startY:previous.startY};activePointers.set(event.pointerId,next);var points=Array.from(activePointers.values());if(points.length>1){event.preventDefault();if(!multiPointerGesture||multiPointerGesture.ids.length!==points.length)startMultiPointerGesture();if(multiPointerGesture.kind==='pan'){var panPoints=multiPointerGesture.ids.map(function(id){return activePointers.get(id);}).filter(Boolean);var centroid=pointerCentroid(panPoints);camera.x=multiPointerGesture.x+centroid.x-multiPointerGesture.centroid.x;camera.y=multiPointerGesture.y+centroid.y-multiPointerGesture.centroid.y;}else{var pinchPoints=multiPointerGesture.ids.map(function(id){return activePointers.get(id);});var distance=pointerDistance(pinchPoints[0],pinchPoints[1]);camera.scale=clamp(multiPointerGesture.scale*(multiPointerGesture.distance?distance/multiPointerGesture.distance:1),CAMERA_MIN_SCALE,CAMERA_MAX_SCALE);camera.x=multiPointerGesture.anchorX-multiPointerGesture.sceneX*camera.scale;camera.y=multiPointerGesture.anchorY-multiPointerGesture.sceneY*camera.scale;}applyCamera();suppressCanvasClick=true;setPanning(true);return;}var moved=Math.hypot(next.x-next.startX,next.y-next.startY);if(moved>3||flowViewport.classList.contains('flow-viewport--panning')){event.preventDefault();capturePointer(event.pointerId);camera.x+=next.x-previous.x;camera.y+=next.y-previous.y;applyCamera();suppressCanvasClick=true;setPanning(true);}});
  function finishPointer(event){if(!activePointers.has(event.pointerId))return;activePointers.delete(event.pointerId);releasePointer(event.pointerId);if(activePointers.size>1)startMultiPointerGesture();else{multiPointerGesture=null;if(activePointers.size===1){var remaining=Array.from(activePointers.values())[0];remaining.startX=remaining.x;remaining.startY=remaining.y;}}if(!activePointers.size){setPanning(false);if(suppressCanvasClick)setTimeout(function(){suppressCanvasClick=false;},0);}}
  flowViewport.addEventListener('pointerup',finishPointer);
  flowViewport.addEventListener('pointercancel',finishPointer);
  flowViewport.addEventListener('click',function(event){if(!suppressCanvasClick)return;event.preventDefault();event.stopPropagation();suppressCanvasClick=false;},true);
  flowHost.addEventListener('focusin',function(event){if(event.target instanceof Element&&event.target.matches(':focus-visible'))requestAnimationFrame(function(){revealCameraElement(event.target);});});
  flowViewport.addEventListener('gesturestart',function(event){event.preventDefault();safariGestureStart={scale:camera.scale,x:event.clientX,y:event.clientY};},{passive:false});
  flowViewport.addEventListener('gesturechange',function(event){if(!safariGestureStart)return;event.preventDefault();zoomCameraAt(safariGestureStart.scale*event.scale,Number.isFinite(event.clientX)?event.clientX:safariGestureStart.x,Number.isFinite(event.clientY)?event.clientY:safariGestureStart.y);},{passive:false});
  flowViewport.addEventListener('gestureend',function(){safariGestureStart=null;});
  flowViewport.addEventListener('keydown',function(event){if(event.target!==flowViewport)return;var rect=flowViewport.getBoundingClientRect();var centerX=rect.left+rect.width/2;var centerY=rect.top+rect.height/2;var handled=true;if(event.key==='+'||event.key==='=')zoomCameraAt(camera.scale*1.12,centerX,centerY);else if(event.key==='-'||event.key==='_')zoomCameraAt(camera.scale/1.12,centerX,centerY);else if(event.key==='0'){cancelCameraAnimation();camera.scale=1;applyCamera();centerCameraOnPrimary();}else if(event.key==='ArrowLeft'){cancelCameraAnimation();camera.x+=48;applyCamera();}else if(event.key==='ArrowRight'){cancelCameraAnimation();camera.x-=48;applyCamera();}else if(event.key==='ArrowUp'){cancelCameraAnimation();camera.y+=48;applyCamera();}else if(event.key==='ArrowDown'){cancelCameraAnimation();camera.y-=48;applyCamera();}else handled=false;if(handled)event.preventDefault();});
  document.querySelectorAll('[data-direction]').forEach(function(button){button.addEventListener('click',function(){if(button.disabled)return;flowDirection=button.dataset.direction;resetExpansion();renderFlow(true);});});
  document.getElementById('file-search').addEventListener('input',function(event){searchValue=event.target.value.trim().toLowerCase();renderTree();var match=model.files.find(function(file){return searchValue&&file.path.toLowerCase().includes(searchValue);});if(match)selectFile(match.path,true);});
  document.getElementById('reset-flow').addEventListener('click',function(){resetExpansion();renderFlow(true);});
  document.getElementById('theme-toggle').addEventListener('click',function(){var root=document.documentElement;root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';});
  new ResizeObserver(function(){var next={width:flowViewport.clientWidth,height:flowViewport.clientHeight};if(next.width<1||next.height<1)return;if(lastViewportSize.width){camera.x+=(next.width-lastViewportSize.width)/2;camera.y+=(next.height-lastViewportSize.height)/2;applyCamera();}lastViewportSize=next;requestAnimationFrame(function(){if(domainStageActive()&&model.repositoryZones.zones.length)drawSemanticTerritories(collectVisibleRepositoryGraph());drawSharedLinks();});}).observe(flowViewport);
  renderStages();renderStageDetail(model.stages[selectedStage-1]);renderEvolution();renderDomainControls();renderFilters();renderTree();renderInspector();renderFlow(true);if(location.hash==='#atlas')document.getElementById('atlas').scrollIntoView();
})();
`
}

function sourcePathForNode(node) {
  if (node?.source?.sourcePath) return node.source.sourcePath
  if (node?.attributes?.sourcePath) return node.attributes.sourcePath
  const nodeId = String(node?.nodeId || '')
  if (nodeId.startsWith('module:')) return nodeId.slice('module:'.length)
  return null
}

function fileKind(file) {
  const value = file.path.toLowerCase()
  if (/(^|\/)views?\//.test(value)) return 'view'
  if (/(^|\/)pages?\//.test(value)) return 'page'
  if (/(^|\/)components?\//.test(value) || file.extension === 'vue') return 'component'
  if (/(^|\/)(api|services?)\//.test(value)) return 'api'
  if (/(^|\/)(store|stores|state)\//.test(value)) return 'state'
  if (/(^|\/)router\//.test(value)) return 'route'
  if (/(test|spec)\.[^.]+$/.test(value) || /(^|\/)tests?\//.test(value)) return 'test'
  if (file.category === 'config' || file.category === 'manifest') return 'config'
  return 'source'
}

function topLevelGroup(filePath) {
  const parts = filePath.split('/')
  if (parts[0] !== 'src') return parts[0] || 'root'
  return parts.slice(0, Math.min(3, parts.length - 1)).join('/') || 'src'
}

function countQuestions(value, status) {
  return (value?.questions || []).filter(question => question.lifecycleStatus === status || question.status === status).length
}

function countBy(values, selector) {
  const counts = {}
  for (const value of values || []) {
    const key = selector(value)
    if (!key) continue
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function entriesForCount(value) {
  return Object.entries(value).map(([key, count]) => ({ key, count })).sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
}

function readOptional(root, relativePath) {
  const filePath = path.join(root, relativePath)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function exists(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath))
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char])
}

function shortId(value) {
  if (!value) return 'unavailable'
  return String(value).length > 26 ? `${String(value).slice(0, 24)}…` : String(value)
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value || 0)
}
