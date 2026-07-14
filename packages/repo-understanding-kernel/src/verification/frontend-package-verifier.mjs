import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { buildProductMaps, productMapPaths, productProjectionHash } from '../projections/product-maps.mjs'
import { loadJourneyStore } from '../knowledge/journey-store.mjs'
import { loadSemanticStore } from '../knowledge/semantic-store.mjs'
import { evaluateJourneySetClosure } from '../planning/journey-closure.mjs'
import { validateNodeSemanticBatchPlan } from '../planning/node-semantic-batch-planner.mjs'
import { loadNodeSemanticCatalog } from '../knowledge/node-semantic-catalog.mjs'

const ACTIVE_WORK_STATES = new Set(['ready', 'issued', 'result-produced'])
const MAP_KEYS = ['application', 'experience', 'runtimeFlow', 'change']

export function verifyFrontendPackage({ packageDir, phase = 'complete', generatedAt = new Date().toISOString() } = {}) {
  const root = path.resolve(packageDir || '.')
  const issues = []
  const warnings = []
  const requireMaps = ['projection', 'synthesis', 'complete'].includes(phase)
  const requireNarrative = ['synthesis', 'complete'].includes(phase)
  const requireHuman = phase === 'complete'
  const read = relative => readJson(path.join(root, relative))
  const support = read('static/support-decision.json')
  const inventory = read('static/inventory.json')
  const graph = read('static/static-program-graph.json')
  const frame = read('static/investigation-frame.json')
  const researchPlan = read('planning/manifest.json') || { contractRefs: [] }
  const state = read('state/run-state.json') || { workItems: {}, questions: {}, journeys: {} }

  if (!support) issues.push(issue('support-decision-missing', 'static/support-decision.json', 'SupportDecision is missing.'))
  if (support && !['supported-frontend', 'frontend-subtree-only', 'unsupported'].includes(support.supportLevel)) {
    issues.push(issue('support-decision-invalid', 'static/support-decision.json', `Unsupported supportLevel: ${support.supportLevel}`))
  }
  if (support?.supportLevel === 'unsupported') {
    return result({ root, phase, generatedAt, support, graph, frame, state, issues, warnings, terminal: 'unsupported' })
  }
  if (graph?.schemaVersion !== 'repo-static-program-graph/v1') {
    issues.push(issue('static-graph-missing', 'static/static-program-graph.json', 'Static Program Graph v1 is required.'))
  }
  if (frame?.schemaVersion !== 'repo-investigation-frame/v1') {
    issues.push(issue('investigation-frame-missing', 'static/investigation-frame.json', 'InvestigationFrame v1 is required.'))
  }
  const semanticStoreStatus = verifySemanticStore(root, graph, issues)
  const nodeSemanticStatus = verifyNodeSemanticCoverage({ root, inventory, graph, phase, issues })
  for (const [label, value] of [['SupportDecision', support], ['StaticProgramGraph', graph], ['InvestigationFrame', frame], ['RunState', state]]) {
    if (value?.snapshotId && graph?.snapshotId && value.snapshotId !== graph.snapshotId) {
      issues.push(issue('snapshot-mismatch', null, `${label} snapshot ${value.snapshotId} does not match ${graph.snapshotId}.`))
    }
  }

  const workItems = Object.values(state.workItems || {})
  const activeItems = workItems.filter(item => ACTIVE_WORK_STATES.has(item.status))
  if (phase !== 'analysis' && activeItems.length) {
    issues.push(issue('work-in-flight', 'state/run-state.json', `Active WorkItems: ${activeItems.map(item => item.itemId).join(', ')}`))
  }
  const blockingFailures = workItems.filter(item => item.blocking && ['rejected', 'abandoned'].includes(item.status) && !hasRetry(item, workItems))
  if (blockingFailures.length) {
    issues.push(issue('blocking-work-failed', 'state/run-state.json', `Blocking WorkItems failed: ${blockingFailures.map(item => item.itemId).join(', ')}`))
  }

  const contractStates = contractState(root, researchPlan.contractRefs || [], workItems)
  if (phase !== 'analysis') {
    const undispatched = contractStates.filter(item => item.status === 'undispatched')
    if (undispatched.length) issues.push(issue('contract-undispatched', 'planning/manifest.json', `Undispatched ResearchContracts: ${undispatched.map(item => item.contractId).join(', ')}`))
  }
  const criticalQuestions = criticalQuestionState(root, state)
  const unresolvedCritical = criticalQuestions.filter(item => !['resolved', 'waived', 'invalidated'].includes(item.status))
  if (phase !== 'analysis' && unresolvedCritical.length) {
    issues.push(issue('critical-question-open', 'planning/open-questions.json', `Critical semantic questions remain open: ${unresolvedCritical.map(item => item.questionId).join(', ')}`))
  }

  const journeyStatus = verifyJourneyClosure(root, graph, phase, issues)

  let mapStatus = { required: requireMaps, current: false, manifestPath: null, projectionKey: null }
  if (requireMaps) mapStatus = verifyMaps(root, graph, issues)
  let narrativeStatus = { required: requireNarrative, current: false, path: null }
  if (requireNarrative) narrativeStatus = verifyNarrative(root, graph, mapStatus, issues)
  let humanStatus = { required: requireHuman, current: false, path: null }
  if (requireHuman) humanStatus = verifyHumanProjection(root, narrativeStatus, mapStatus, issues)

  return result({
    root,
    phase,
    generatedAt,
    support,
    graph,
    frame,
    state,
    issues,
    warnings,
    terminal: null,
    contractStates,
    criticalQuestions,
    activeItems,
    blockingFailures,
    mapStatus,
    narrativeStatus,
    humanStatus,
    journeyStatus,
    semanticStoreStatus,
    nodeSemanticStatus,
  })
}

export function writeFrontendVerification(input = {}) {
  const verification = verifyFrontendPackage(input)
  const target = path.join(path.resolve(input.packageDir), 'verification', 'frontend-verification.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  writeJsonAtomic(target, verification)
  return { verification, path: target }
}

function verifyMaps(root, graph, issues) {
  const paths = productMapPaths(root)
  const manifest = readJson(paths.manifest)
  const status = { required: true, current: false, manifestPath: paths.manifest, projectionKey: manifest?.projectionKey || null }
  if (manifest?.schemaVersion !== 'repo-product-map-manifest/v1') {
    issues.push(issue('product-map-manifest-missing', relative(root, paths.manifest), 'Product Map manifest v1 is required.'))
    return status
  }
  if (manifest.snapshotId !== graph?.snapshotId) {
    issues.push(issue('product-map-snapshot-stale', relative(root, paths.manifest), 'Product Map snapshot does not match Static Program Graph.'))
  }
  let expected
  try {
    expected = buildProductMaps({ packageDir: root })
  } catch (error) {
    issues.push(issue('product-map-rebuild-failed', relative(root, paths.manifest), error.message))
    return status
  }
  if (!deepEqual(manifest.projectionKey, expected.manifest.projectionKey)) {
    issues.push(issue('product-map-key-stale', relative(root, paths.manifest), 'Product Map projectionKey does not match current graph, claims, journeys, or frame.'))
  }
  for (const key of MAP_KEYS) {
    const entry = manifest.projections?.[key]
    if (!entry?.path || !entry?.contentHash) {
      issues.push(issue('product-map-entry-missing', relative(root, paths.manifest), `Missing ${key} projection entry.`))
      continue
    }
    const file = path.resolve(root, entry.path)
    if (!inside(root, file) || !fs.existsSync(file)) {
      issues.push(issue('product-map-file-missing', entry.path, `${key} projection file is missing.`))
      continue
    }
    if (productProjectionHash(readJson(file)) !== entry.contentHash) {
      issues.push(issue('product-map-hash-mismatch', entry.path, `${key} projection contentHash is stale.`))
    }
  }
  status.current = !issues.some(item => item.code.startsWith('product-map-'))
  return status
}

function verifyNarrative(root, graph, mapStatus, issues) {
  const file = path.join(root, 'synthesis', 'narrative.json')
  const narrative = readJson(file)
  const status = { required: true, current: false, path: file }
  if (narrative?.schemaVersion !== 'repo-synthesis-narrative/v3') {
    issues.push(issue('narrative-missing', relative(root, file), 'Synthesis narrative v3 is required.'))
    return status
  }
  if (narrative.snapshotId !== graph?.snapshotId) issues.push(issue('narrative-snapshot-stale', relative(root, file), 'Narrative snapshot is stale.'))
  if (!deepEqual(narrative.projectionKey, mapStatus.projectionKey)) {
    issues.push(issue('narrative-map-key-stale', relative(root, file), 'Narrative does not reference the current Product Map projectionKey.'))
  }
  const manifest = readJson(path.join(root, 'projections', 'manifest.json'))
  for (const key of MAP_KEYS) {
    if (narrative.mapRefs?.[key] !== manifest?.projections?.[key]?.path) {
      issues.push(issue('narrative-map-ref-invalid', relative(root, file), `Narrative ${key} mapRef does not match the manifest.`))
    }
  }
  for (const field of ['title', 'executiveSummary', 'applicationSummary', 'experienceSummary', 'runtimeFlowSummary', 'changeSummary']) {
    if (!String(narrative[field] || '').trim()) issues.push(issue('narrative-field-missing', relative(root, file), `${field} is required.`))
  }
  status.current = !issues.some(item => item.code.startsWith('narrative-'))
  return status
}

function verifyHumanProjection(root, narrativeStatus, mapStatus, issues) {
  const file = path.join(root, 'human-readable.html')
  const status = { required: true, current: false, path: file }
  if (!fs.existsSync(file)) {
    issues.push(issue('human-projection-missing', relative(root, file), 'Human-readable HTML is required.'))
    return status
  }
  const htmlMtime = fs.statSync(file).mtimeMs
  const inputs = [narrativeStatus.path, mapStatus.manifestPath].filter(Boolean).filter(fs.existsSync)
  const newestInput = Math.max(0, ...inputs.map(input => fs.statSync(input).mtimeMs))
  if (htmlMtime < newestInput) issues.push(issue('human-projection-stale', relative(root, file), 'Human-readable HTML is older than its narrative or Product Map inputs.'))
  status.current = !issues.some(item => item.code.startsWith('human-projection-'))
  return status
}

function contractState(root, refs, workItems) {
  const idsByItem = new Map(workItems.map(item => {
    const contract = readJson(path.isAbsolute(item.contractRef || '') ? item.contractRef : path.resolve(root, item.contractRef || 'missing'))
    return [contract?.contractId, item]
  }).filter(([contractId]) => contractId))
  return refs.map(ref => ({ contractId: ref.contractId, status: idsByItem.get(ref.contractId)?.status || 'undispatched', itemId: idsByItem.get(ref.contractId)?.itemId || null }))
}

function criticalQuestionState(root, state) {
  const set = readJson(path.join(root, 'planning', 'open-questions.json'))
  return (set?.questions || []).filter(question => question.criticality === 'critical').map(question => ({
    questionId: question.questionId,
    status: state.questions?.[question.questionId]?.status || question.lifecycleStatus,
  }))
}

function verifyJourneyClosure(root, graph, phase, issues) {
  const required = phase !== 'analysis'
  const status = {
    required,
    current: false,
    journeyCount: 0,
    closedJourneyCount: 0,
    closureRate: 0,
    criticalGatePassed: false,
    criticalOpenJourneyIds: [],
  }
  let store
  try {
    store = loadJourneyStore(root)
  } catch (error) {
    if (required) issues.push(issue('journey-store-invalid', 'store/journeys/manifest.json', error.message))
    return status
  }
  const closure = evaluateJourneySetClosure({
    definitions: store.definitions,
    bindingSets: store.bindingSets,
    staticProgramGraph: graph,
    snapshotId: graph?.snapshotId,
    evaluatedAt: store.manifest.generatedAt,
  })
  status.journeyCount = closure.counts.journeys
  status.closedJourneyCount = closure.counts.closed
  status.closureRate = closure.journeyClosureRate
  status.criticalGatePassed = closure.criticalGatePassed
  status.criticalOpenJourneyIds = closure.criticalOpenJourneyIds
  status.current = closure.canComplete
  if (required && !closure.canComplete) {
    const detail = closure.counts.journeys === 0
      ? 'No governed JourneyDefinition/JourneyBinding exists.'
      : `Journey closure is ${closure.counts.closed}/${closure.counts.journeys}; critical open: ${closure.criticalOpenJourneyIds.join(', ') || 'none'}.`
    issues.push(issue('journey-closure-incomplete', 'store/journeys/manifest.json', detail))
  }
  return status
}

function verifySemanticStore(root, graph, issues) {
  const status = { required: true, current: false, evidenceCount: 0, claimCount: 0, claimSetHash: null }
  let store
  try {
    store = loadSemanticStore(root)
  } catch (error) {
    issues.push(issue('semantic-store-invalid', 'store/semantic-store-manifest.json', error.message))
    return status
  }
  status.evidenceCount = store.evidence.length
  status.claimCount = store.claims.length
  status.claimSetHash = store.manifest?.hashes?.claims || null
  if (!store.validation.valid) {
    for (const message of store.validation.issues) {
      issues.push(issue('semantic-store-invalid', 'store/semantic-store-manifest.json', message))
    }
  }
  if (store.manifest?.snapshotId !== graph?.snapshotId) {
    issues.push(issue('semantic-store-snapshot-stale', 'store/semantic-store-manifest.json', 'Semantic Store snapshot does not match Static Program Graph.'))
  }
  status.current = !issues.some(item => item.code.startsWith('semantic-store-'))
  return status
}

export function verifyNodeSemanticCoverage({ root, inventory, graph, phase = 'complete', issues = [] } = {}) {
  const planPath = path.join(root, 'planning', 'node-semantic-batches.json')
  const plan = readJson(planPath)
  const required = phase !== 'analysis'
  const status = {
    required,
    current: false,
    planPath: fs.existsSync(planPath) ? relative(root, planPath) : null,
    catalogPath: null,
    eligibleFiles: plan?.eligibleFileCount || 0,
    acceptedFiles: 0,
    missingFiles: [],
  }
  if (!plan) {
    if (required) issues.push(issue('node-semantic-plan-missing', 'planning/node-semantic-batches.json', 'Node Semantic Batch Plan is required before Journey exploration.'))
    return status
  }
  const planValidation = validateNodeSemanticBatchPlan({ plan, inventory, staticProgramGraph: graph, repoPath: plan.repoPath })
  if (!planValidation.valid) {
    issues.push(issue('node-semantic-plan-invalid', 'planning/node-semantic-batches.json', planValidation.issues.join('; ')))
    return status
  }
  const loaded = loadNodeSemanticCatalog(root, { staticProgramGraph: graph, inventory })
  status.catalogPath = relative(root, loaded.path)
  if (!loaded.catalog) {
    if (required) issues.push(issue('node-semantic-catalog-missing', status.catalogPath, 'Node Semantic Catalog is required before Journey exploration.'))
    return status
  }
  if (!loaded.validation.valid) {
    issues.push(issue('node-semantic-catalog-invalid', status.catalogPath, loaded.validation.issues.join('; ')))
    return status
  }
  const expected = new Set((plan.batches || []).flatMap(batch => batch.primaryFiles || []))
  const accepted = new Set((loaded.catalog.entries || []).filter(entry => entry.status === 'accepted').map(entry => entry.filePath))
  status.acceptedFiles = accepted.size
  status.missingFiles = [...expected].filter(filePath => !accepted.has(filePath)).sort()
  status.current = loaded.catalog.status === 'complete' && status.missingFiles.length === 0 && accepted.size === expected.size
  if (required && !status.current) {
    issues.push(issue('node-semantic-coverage-incomplete', status.catalogPath, `Node semantic coverage is ${accepted.size}/${expected.size}; ${status.missingFiles.length} files remain.`))
  }
  return status
}

function hasRetry(item, workItems) {
  return workItems.some(candidate => candidate.retryOf === item.itemId && !['rejected', 'abandoned'].includes(candidate.status))
}

function result(context) {
  const passed = context.terminal === 'unsupported' ? context.issues.length === 0 : context.issues.length === 0
  return {
    schemaVersion: 'repo-frontend-verification/v1',
    generatedAt: context.generatedAt,
    packageDir: context.root,
    phase: context.phase,
    snapshotId: context.graph?.snapshotId || context.state?.snapshotId || null,
    supportLevel: context.support?.supportLevel || null,
    terminal: context.terminal,
    passed,
    issues: context.issues,
    warnings: context.warnings,
    gates: {
      staticGraph: context.graph?.schemaVersion === 'repo-static-program-graph/v1',
      investigationFrame: context.frame?.schemaVersion === 'repo-investigation-frame/v1',
      semanticStore: context.semanticStoreStatus || { required: true, current: false },
      nodeSemantics: context.nodeSemanticStatus || { required: false, current: false },
      activeWorkItems: (context.activeItems || []).map(item => item.itemId),
      blockingFailures: (context.blockingFailures || []).map(item => item.itemId),
      contractStates: context.contractStates || [],
      criticalQuestions: context.criticalQuestions || [],
      journeys: context.journeyStatus || { required: false, current: false },
      productMaps: context.mapStatus || { required: false, current: false },
      narrative: context.narrativeStatus || { required: false, current: false },
      humanProjection: context.humanStatus || { required: false, current: false },
    },
  }
}

function issue(code, artifactRef, message) {
  return { code, artifactRef, message }
}

function readJson(file) {
  if (!fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function inside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}
