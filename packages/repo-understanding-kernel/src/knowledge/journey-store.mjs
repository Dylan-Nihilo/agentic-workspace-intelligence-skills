import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  evaluateJourneyClosure,
  evaluateJourneySetClosure,
  validateJourneyIntegrity,
} from '../planning/journey-closure.mjs'

export const REPO_JOURNEY_STORE_MANIFEST_SCHEMA = 'repo-journey-store-manifest/v1'
export const UNRESOLVED_PRODUCT_OUTCOME = 'Unresolved product outcome; semantic evidence is required.'

const DEFINITION_SCHEMA = readBundledSchema('../../schemas/journey-definition.schema.json')
const BINDING_SCHEMA = readBundledSchema('../../schemas/journey-binding.schema.json')
const CLOSURE_SCHEMA = readBundledSchema('../../schemas/journey-closure-report.schema.json')
const MANIFEST_SCHEMA = readBundledSchema('../../schemas/journey-store-manifest.schema.json')

const RUNTIME_EDGE_RELATIONS = Object.freeze({
  'routes-to': 'next',
  'route-renders-page': 'next',
  'renders-component': 'next',
  'contains-ui-element': 'next',
  'emits-event': 'triggers',
  'emits-ui-event': 'triggers',
  'emits-component-event': 'triggers',
  'listens-component-event': 'triggers',
  'component-event-handled-by': 'handles',
  'handled-by': 'handles',
  'invokes-handler': 'handles',
  'triggers-effect': 'causes',
  'reads-state': 'reads',
  'writes-state': 'writes',
  'mutates-state': 'writes',
  'dispatches-request': 'requests',
  'issues-request': 'requests',
  'calls-endpoint': 'requests',
  'targets-endpoint': 'requests',
  'receives-response': 'resolves',
  'produces-feedback': 'shows',
  'produces-feedback-candidate': 'shows',
  'leads-to-outcome': 'produces',
  'produces-outcome-candidate': 'produces',
  'navigates-to-route': 'next',
  precedes: 'next',
  'branches-to': 'next',
})

const BINDING_TYPE_ORDER = Object.freeze({
  page: 1,
  'ui-element': 2,
  event: 3,
  handler: 4,
  effect: 5,
  'state-transition': 6,
  request: 7,
  endpoint: 8,
  response: 9,
  feedback: 10,
  outcome: 11,
})

export function journeyStorePaths(packageDir) {
  const packageRoot = path.resolve(packageDir)
  const storeParent = path.join(packageRoot, 'store')
  const root = path.join(storeParent, 'journeys')
  return {
    packageRoot,
    storeParent,
    root,
    definitions: path.join(root, 'definitions'),
    bindings: path.join(root, 'bindings'),
    closure: path.join(root, 'closure'),
    manifest: path.join(root, 'manifest.json'),
    lock: path.join(storeParent, '.journeys-write.lock'),
  }
}

export function validateJourneyDefinition(value) {
  return validateJsonSchema(value, DEFINITION_SCHEMA)
}

export function validateJourneyBindingSet(value) {
  return validateJsonSchema(value, BINDING_SCHEMA)
}

export function validateJourneyClosureReport(value) {
  return validateJsonSchema(value, CLOSURE_SCHEMA)
}

export function validateJourneyStoreManifest(value) {
  const issues = validateJsonSchema(value, MANIFEST_SCHEMA)
  if (value?.definitionsPath !== 'store/journeys/definitions') issues.push('$.definitionsPath must be store/journeys/definitions')
  if (value?.bindingsPath !== 'store/journeys/bindings') issues.push('$.bindingsPath must be store/journeys/bindings')
  if (value?.closurePath !== 'store/journeys/closure') issues.push('$.closurePath must be store/journeys/closure')
  const journeyIds = new Set()
  let previousId = null
  for (const [index, entry] of array(value?.entries).entries()) {
    if (journeyIds.has(entry?.journeyId)) issues.push(`$.entries[${index}].journeyId is duplicated: ${entry?.journeyId}`)
    journeyIds.add(entry?.journeyId)
    if (previousId !== null && String(entry?.journeyId).localeCompare(previousId) < 0) {
      issues.push('$.entries must be sorted by journeyId')
    }
    const fileName = journeyFileName(entry?.journeyId)
    if (entry?.definitionPath !== `store/journeys/definitions/${fileName}`) issues.push(`$.entries[${index}].definitionPath is not canonical`)
    if (entry?.bindingPath !== `store/journeys/bindings/${fileName}`) issues.push(`$.entries[${index}].bindingPath is not canonical`)
    if (entry?.closureReportPath !== `store/journeys/closure/${fileName}`) issues.push(`$.entries[${index}].closureReportPath is not canonical`)
    previousId = String(entry?.journeyId)
  }
  const counts = value?.counts || {}
  if (counts.journeys !== array(value?.entries).length) issues.push('$.counts.journeys must equal entries.length')
  for (const status of ['candidate', 'open', 'closed', 'blocked', 'invalidated']) {
    const actual = array(value?.entries).filter(entry => entry?.status === status).length
    if (counts[status] !== actual) issues.push(`$.counts.${status} must equal the number of ${status} entries`)
  }
  const critical = array(value?.entries).filter(entry => entry?.criticality === 'critical')
  if (counts.critical !== critical.length) issues.push('$.counts.critical must equal the number of critical entries')
  if (counts.criticalClosed !== critical.filter(entry => entry?.status === 'closed').length) {
    issues.push('$.counts.criticalClosed must equal the number of closed critical entries')
  }
  return uniqueSorted(issues)
}

/**
 * Build a strict authoritative store model without touching disk.
 */
export function buildJourneyStore(input = {}) {
  const definitions = array(input.definitions).slice().sort(byJourneyId)
  const bindingSets = array(input.bindingSets || input.bindings).slice().sort(byJourneyId)
  const generatedAt = String(input.generatedAt || latestStoreTimestamp(definitions, bindingSets))
  const snapshotId = String(input.snapshotId || definitions[0]?.snapshotId || bindingSets[0]?.snapshotId || '')
  const issues = []
  collectDuplicateIds(definitions, 'journeyId', '$.definitions', issues)
  collectDuplicateIds(bindingSets, 'journeyId', '$.bindingSets', issues)
  if (!snapshotId) issues.push('$.snapshotId must be a non-empty string')

  for (const [index, definition] of definitions.entries()) {
    issues.push(...validateJourneyDefinition(definition).map(item => `$.definitions[${index}] ${item}`))
    if (definition?.snapshotId !== snapshotId) issues.push(`$.definitions[${index}].snapshotId must equal ${snapshotId}`)
  }
  for (const [index, bindingSet] of bindingSets.entries()) {
    issues.push(...validateJourneyBindingSet(bindingSet).map(item => `$.bindingSets[${index}] ${item}`))
    if (bindingSet?.snapshotId !== snapshotId) issues.push(`$.bindingSets[${index}].snapshotId must equal ${snapshotId}`)
  }

  const definitionIds = new Set(definitions.map(item => item?.journeyId))
  const bindingByJourney = new Map(bindingSets.map(item => [item?.journeyId, item]))
  for (const definition of definitions) {
    if (!bindingByJourney.has(definition?.journeyId)) issues.push(`Journey ${definition?.journeyId} has no JourneyBinding.`)
  }
  for (const bindingSet of bindingSets) {
    if (!definitionIds.has(bindingSet?.journeyId)) issues.push(`JourneyBinding ${bindingSet?.journeyId} has no JourneyDefinition.`)
  }

  const closureReports = definitions.map(definition => evaluateJourneyClosure({
    definition,
    bindingSet: bindingByJourney.get(definition?.journeyId),
    staticProgramGraph: input.staticProgramGraph,
    evaluatedAt: generatedAt,
  }))
  for (const [index, report] of closureReports.entries()) {
    issues.push(...validateJourneyClosureReport(report).map(item => `$.closureReports[${index}] ${item}`))
    issues.push(...report.integrityIssues.map(item => `${item.path}: ${item.code}: ${item.message}`))
  }

  const entries = definitions.map((definition, index) => {
    const bindingSet = bindingByJourney.get(definition.journeyId)
    const report = closureReports[index]
    const fileName = journeyFileName(definition.journeyId)
    return {
      journeyId: definition.journeyId,
      criticality: definition.criticality,
      status: report.status,
      definitionPath: `store/journeys/definitions/${fileName}`,
      bindingPath: `store/journeys/bindings/${fileName}`,
      closureReportPath: `store/journeys/closure/${fileName}`,
      definitionHash: hashCanonical(definition),
      bindingHash: hashCanonical(bindingSet || null),
      closureHash: hashCanonical(report),
    }
  })
  const manifest = {
    schemaVersion: REPO_JOURNEY_STORE_MANIFEST_SCHEMA,
    snapshotId,
    generatedAt,
    definitionsPath: 'store/journeys/definitions',
    bindingsPath: 'store/journeys/bindings',
    closurePath: 'store/journeys/closure',
    entries,
    counts: countEntries(entries),
    journeySetHash: computeJourneySetHash({ definitions, bindingSets }),
  }
  issues.push(...validateJourneyStoreManifest(manifest).map(item => `$.manifest ${item}`))

  return {
    definitions,
    bindingSets,
    closureReports,
    closureSet: evaluateJourneySetClosure({
      definitions,
      bindingSets,
      snapshotId,
      evaluatedAt: generatedAt,
      minimumJourneyClosureRate: input.minimumJourneyClosureRate,
    }),
    manifest,
    validation: { valid: issues.length === 0, issues: uniqueSorted(issues) },
  }
}

/**
 * Transactionally replace the authoritative package journey store.
 * A package-scoped exclusive lock prevents concurrent writers.
 */
export function writeJourneyStore(input = {}) {
  if (!input.packageDir) throw new Error('writeJourneyStore requires packageDir')
  const built = buildJourneyStore(input)
  if (!built.validation.valid) {
    throw new Error(`Journey store validation failed:\n- ${built.validation.issues.join('\n- ')}`)
  }
  const paths = journeyStorePaths(input.packageDir)
  return withJourneyStoreLock(paths, () => replaceJourneyStore(paths, built))
}

/**
 * Rebuild closure reports and the manifest from authoritative definition and
 * binding files. Existing projection/manifest state is never used as truth.
 */
export function rebuildJourneyStore(packageDir, options = {}) {
  const paths = journeyStorePaths(packageDir)
  return withJourneyStoreLock(paths, () => {
    const definitions = readJsonDirectory(paths.definitions)
    const bindingSets = readJsonDirectory(paths.bindings)
    const previousManifest = readJsonIfExists(paths.manifest)
    const built = buildJourneyStore({
      ...options,
      definitions,
      bindingSets,
      snapshotId: options.snapshotId || definitions[0]?.snapshotId || previousManifest?.snapshotId,
      generatedAt: options.generatedAt || previousManifest?.generatedAt || latestStoreTimestamp(definitions, bindingSets),
    })
    if (!built.validation.valid) {
      throw new Error(`Journey store validation failed:\n- ${built.validation.issues.join('\n- ')}`)
    }
    return replaceJourneyStore(paths, built)
  })
}

export function loadJourneyStore(packageDir, options = {}) {
  const paths = journeyStorePaths(packageDir)
  const manifest = readJson(paths.manifest)
  const issues = validateJourneyStoreManifest(manifest)
  const definitions = []
  const bindingSets = []
  const closureReports = []
  for (const [index, entry] of array(manifest.entries).entries()) {
    const definitionFile = resolvePackageArtifact(paths.packageRoot, entry.definitionPath)
    const bindingFile = resolvePackageArtifact(paths.packageRoot, entry.bindingPath)
    const closureFile = resolvePackageArtifact(paths.packageRoot, entry.closureReportPath)
    const definition = readJson(definitionFile)
    const bindingSet = readJson(bindingFile)
    const closureReport = readJson(closureFile)
    definitions.push(definition)
    bindingSets.push(bindingSet)
    closureReports.push(closureReport)
    issues.push(...validateJourneyDefinition(definition).map(item => `$.entries[${index}].definition ${item}`))
    issues.push(...validateJourneyBindingSet(bindingSet).map(item => `$.entries[${index}].binding ${item}`))
    issues.push(...validateJourneyClosureReport(closureReport).map(item => `$.entries[${index}].closureReport ${item}`))
    issues.push(...validateJourneyIntegrity({ definition, bindingSet }).map(item => `$.entries[${index}] ${item.path}: ${item.code}: ${item.message}`))
    issues.push(...array(closureReport?.integrityIssues).map(item => `$.entries[${index}] ${item.path}: ${item.code}: ${item.message}`))
    if (definition?.journeyId !== entry.journeyId || bindingSet?.journeyId !== entry.journeyId || closureReport?.journeyId !== entry.journeyId) {
      issues.push(`$.entries[${index}] journey identities do not match the manifest entry`)
    }
    if (definition?.snapshotId !== manifest.snapshotId || bindingSet?.snapshotId !== manifest.snapshotId || closureReport?.snapshotId !== manifest.snapshotId) {
      issues.push(`$.entries[${index}] snapshot identities do not match the manifest`)
    }
    if (hashCanonical(definition) !== entry.definitionHash) issues.push(`$.entries[${index}].definitionHash does not match the stored definition`)
    if (hashCanonical(bindingSet) !== entry.bindingHash) issues.push(`$.entries[${index}].bindingHash does not match the stored binding`)
    if (hashCanonical(closureReport) !== entry.closureHash) issues.push(`$.entries[${index}].closureHash does not match the stored closure report`)
    const rebuiltClosure = evaluateJourneyClosure({ definition, bindingSet, evaluatedAt: manifest.generatedAt })
    if (hashCanonical(rebuiltClosure) !== hashCanonical(closureReport)) {
      issues.push(`$.entries[${index}].closureReport is not a deterministic rebuild of authoritative journey content`)
    }
  }
  if (computeJourneySetHash({ definitions, bindingSets }) !== manifest.journeySetHash) {
    issues.push('$.journeySetHash does not match authoritative JourneyDefinition/JourneyBinding content')
  }
  const result = {
    paths,
    definitions,
    bindingSets,
    closureReports,
    manifest,
    validation: { valid: issues.length === 0, issues: uniqueSorted(issues) },
  }
  if (options.strict !== false && !result.validation.valid) {
    throw new Error(`Journey store integrity check failed:\n- ${result.validation.issues.join('\n- ')}`)
  }
  return result
}

export function computeJourneySetHash(input = {}) {
  const definitions = array(input.definitions).slice().sort(byJourneyId).map(stripTemporalMetadata)
  const bindingSets = array(input.bindingSets || input.bindings).slice().sort(byJourneyId).map(stripTemporalMetadata)
  return hashCanonical({ definitions, bindingSets })
}

/**
 * Create deterministic journey candidates from existing static graph/frame
 * evidence. Product actor, goal and outcome remain explicitly unresolved.
 */
export function deriveJourneyCandidates(input = {}) {
  const graph = input.staticProgramGraph || {}
  const frame = input.investigationFrame || {}
  const snapshotId = String(input.snapshotId || graph.snapshotId || frame.snapshotId || '')
  const generatedAt = String(input.generatedAt || frame.generatedAt || graph.generatedAt || '1970-01-01T00:00:00.000Z')
  const diagnostics = []
  if (!snapshotId) diagnostics.push(candidateDiagnostic('snapshot-missing', 'Journey candidates require a snapshotId.'))
  if (graph.snapshotId && frame.snapshotId && graph.snapshotId !== frame.snapshotId) {
    diagnostics.push(candidateDiagnostic('snapshot-mismatch', 'StaticProgramGraph and InvestigationFrame snapshots do not match.'))
    return { definitions: [], bindingSets: [], diagnostics }
  }
  if (graph.supportLevel === 'unsupported') {
    diagnostics.push(candidateDiagnostic('unsupported-repository', 'Journey candidates are not generated for unsupported repositories.'))
    return { definitions: [], bindingSets: [], diagnostics }
  }

  const candidateDescriptors = collectCandidateDescriptors(graph, frame)
  const definitions = []
  const bindingSets = []
  for (const descriptor of candidateDescriptors) {
    const generated = generateCandidatePair({ descriptor, graph, frame, snapshotId, generatedAt })
    definitions.push(generated.definition)
    bindingSets.push(generated.bindingSet)
  }
  return {
    definitions: definitions.sort(byJourneyId),
    bindingSets: bindingSets.sort(byJourneyId),
    diagnostics: diagnostics.sort((left, right) => left.diagnosticId.localeCompare(right.diagnosticId)),
  }
}

export function writeDerivedJourneyCandidates(input = {}) {
  const derived = deriveJourneyCandidates(input)
  const written = writeJourneyStore({
    ...input,
    definitions: derived.definitions,
    bindingSets: derived.bindingSets,
  })
  return { ...written, diagnostics: derived.diagnostics }
}

function collectCandidateDescriptors(graph, frame) {
  const descriptors = []
  for (const candidate of array(frame.coreFlowCandidates)) {
    descriptors.push({
      candidateId: String(candidate?.candidateId || `flow:${shortHash(stableStringify(candidate))}`),
      title: String(candidate?.title || candidate?.candidateId || 'Frontend journey candidate'),
      entryEntityIds: uniqueSorted(array(candidate?.entryEntityIds).map(String)),
      sourcePath: candidate?.sourcePath || null,
      evidenceIds: uniqueSorted(array(candidate?.evidenceRefs || candidate?.evidenceIds).map(String)),
      criticality: normalizeCriticality(candidate?.criticality),
      blocking: candidate?.blocking === true,
    })
  }
  if (!descriptors.length) {
    for (const node of array(graph.nodes).filter(node => normalizedEntityType(node) === 'route')) {
      descriptors.push({
        candidateId: `flow:route:${shortHash(node.nodeId)}`,
        title: String(node.label || node.nodeId),
        entryEntityIds: [node.nodeId],
        sourcePath: node.source?.sourcePath || null,
        evidenceIds: uniqueSorted(array(node.evidenceRefs).map(String)),
        criticality: 'medium',
        blocking: false,
      })
    }
  }
  if (!descriptors.length) {
    for (const page of array(frame.pageCandidates)) {
      descriptors.push({
        candidateId: `flow:page:${shortHash(page.entityId || page.sourcePath)}`,
        title: pageTitle(page.sourcePath || page.entityId),
        entryEntityIds: [page.entityId].filter(Boolean),
        sourcePath: page.sourcePath || null,
        evidenceIds: uniqueSorted(array(page.evidenceRefs).map(String)),
        criticality: 'medium',
        blocking: false,
      })
    }
  }
  return uniqueObjects(descriptors, item => item.candidateId)
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
}

function generateCandidatePair({ descriptor, graph, frame, snapshotId, generatedAt }) {
  const nodeById = new Map(array(graph.nodes).map(node => [node?.nodeId, node]))
  const pageCandidate = findPageCandidate(descriptor, frame)
  const starts = resolveEntryNodes(descriptor, pageCandidate, graph)
  const runtime = collectRuntimeNodes(starts, graph, nodeById)
  const journeyId = `journey:${shortHash(`${snapshotId}|${descriptor.candidateId}`, 20)}`
  const bindingRecords = []
  const stepRecords = []

  // InvestigationFrame file candidates are census references, while confirmed
  // Journey bindings must point at an entity in the Static Program Graph.
  const entryEntity = starts[0]?.nodeId || pageCandidate?.entityId || descriptor.entryEntityIds[0] || `candidate:${shortHash(descriptor.candidateId)}`
  const entryEvidence = uniqueSorted([
    ...descriptor.evidenceIds,
    ...array(pageCandidate?.evidenceRefs),
    ...starts.flatMap(node => array(node?.evidenceRefs)),
  ])
  const entryStepId = `${journeyId}:step:1`
  const entrySourcePath = pageCandidate?.sourcePath || descriptor.sourcePath || starts[0]?.source?.sourcePath || null
  stepRecords.push(candidateStep({
    stepId: entryStepId,
    order: 1,
    title: 'Entry candidate',
    description: `Deterministically observed entry candidate: ${descriptor.title}`,
    blocking: descriptor.blocking,
    evidenceIds: entryEvidence,
  }))
  bindingRecords.push(candidateBinding({
    journeyId,
    stepId: entryStepId,
    order: 1,
    bindingType: 'page',
    entityId: entryEntity,
    entityType: normalizedEntityType(starts[0]) || (pageCandidate ? 'page' : 'entry-candidate'),
    sourcePath: entrySourcePath,
    evidenceIds: entryEvidence,
    confirmed: entryEvidence.length > 0 && Boolean(starts[0] || pageCandidate),
    confidence: Number(pageCandidate?.confidence ?? starts[0]?.attributes?.confidence ?? 0.6),
  }))

  const existingEntities = new Set(bindingRecords.map(item => item.entityId))
  for (const record of runtime.nodes) {
    if (existingEntities.has(record.node.nodeId)) continue
    const bindingType = bindingTypeForNode(record.node)
    if (!bindingType) continue
    const order = stepRecords.length + 1
    const stepId = `${journeyId}:step:${order}`
    const evidenceIds = uniqueSorted(array(record.node.evidenceRefs).map(String))
    stepRecords.push(candidateStep({
      stepId,
      order,
      title: `Observed ${bindingType}`,
      description: `Deterministically observed ${bindingType} entity: ${record.node.label || record.node.nodeId}`,
      blocking: descriptor.blocking,
      evidenceIds,
    }))
    bindingRecords.push(candidateBinding({
      journeyId,
      stepId,
      order,
      bindingType,
      entityId: record.node.nodeId,
      entityType: normalizedEntityType(record.node) || bindingType,
      sourcePath: record.node.source?.sourcePath || null,
      evidenceIds,
      confirmed: evidenceIds.length > 0,
      confidence: Number(record.node.attributes?.confidence ?? 0.9),
    }))
    existingEntities.add(record.node.nodeId)
  }

  const bindingByEntity = new Map(bindingRecords.map(item => [item.entityId, item]))
  const branches = []
  const relations = []
  for (const edge of runtime.edges) {
    const from = bindingByEntity.get(edge.from)
    const to = bindingByEntity.get(edge.to)
    if (!from || !to || from.bindingId === to.bindingId) continue
    const branchCondition = edge.attributes?.branchCondition || edge.attributes?.condition || null
    const branchId = branchCondition ? `${journeyId}:branch:${shortHash(`${edge.edgeId}|${branchCondition}`)}` : null
    if (branchId) {
      const branch = {
        branchId,
        fromStepId: from.stepId,
        condition: String(branchCondition),
        nextStepId: to.stepId,
        kind: normalizeBranchKind(edge.attributes?.branchKind, branchCondition),
        evidenceIds: uniqueSorted(array(edge.evidenceRefs).map(String)),
        claimIds: [],
      }
      branches.push(branch)
      const step = stepRecords.find(item => item.stepId === from.stepId)
      if (step) step.branchIds.push(branchId)
    }
    relations.push({
      fromBindingId: from.bindingId,
      toBindingId: to.bindingId,
      kind: RUNTIME_EDGE_RELATIONS[edge.type],
      branchId,
      evidenceIds: uniqueSorted(array(edge.evidenceRefs).map(String)),
      claimIds: [],
    })
  }

  const feedbackBindings = bindingRecords.filter(item => item.bindingType === 'feedback' && item.status === 'confirmed')
  const definition = {
    schemaVersion: 'repo-journey-definition/v1',
    journeyId,
    snapshotId,
    title: descriptor.title,
    actor: 'unknown-actor',
    goal: `Unresolved product goal for ${descriptor.title}`,
    trigger: {
      kind: descriptor.entryEntityIds.length ? 'route-entry' : 'unknown',
      description: `Deterministic entry candidate for ${descriptor.title}`,
      entityId: descriptor.entryEntityIds[0] || entryEntity || null,
      evidenceIds: entryEvidence,
      claimIds: [],
    },
    entry: {
      routeId: starts.find(node => normalizedEntityType(node) === 'route')?.nodeId || null,
      pageId: pageCandidate?.entityId || (bindingRecords[0]?.entityType === 'page' ? bindingRecords[0].entityId : null),
      sourcePath: entrySourcePath,
      evidenceIds: entryEvidence,
      claimIds: [],
    },
    steps: stepRecords,
    branches: uniqueObjects(branches, item => item.branchId).sort((left, right) => left.branchId.localeCompare(right.branchId)),
    visibleFeedback: feedbackBindings.map(binding => ({
      feedbackId: `${journeyId}:feedback:${shortHash(binding.bindingId)}`,
      stepId: binding.stepId,
      kind: 'other',
      description: `Observed feedback entity ${binding.entityId}; product meaning remains unresolved.`,
      evidenceIds: binding.evidenceIds,
      claimIds: [],
    })),
    successOutcome: {
      outcomeId: `${journeyId}:outcome:unresolved`,
      stepId: stepRecords.at(-1).stepId,
      description: UNRESOLVED_PRODUCT_OUTCOME,
      evidenceIds: [],
      claimIds: [],
    },
    failureOutcomes: [],
    evidenceIds: uniqueSorted([...entryEvidence, ...stepRecords.flatMap(item => item.evidenceIds)]),
    claimIds: [],
    criticality: descriptor.blocking ? 'critical' : descriptor.criticality,
    status: 'candidate',
    createdAt: generatedAt,
    updatedAt: generatedAt,
  }
  const bindingSet = {
    schemaVersion: 'repo-journey-binding/v1',
    bindingSetId: `binding-set:${shortHash(journeyId, 20)}`,
    journeyId,
    snapshotId,
    bindings: bindingRecords,
    relations: uniqueObjects(relations, item => `${item.fromBindingId}|${item.toBindingId}|${item.kind}|${item.branchId || ''}`)
      .sort((left, right) => `${left.fromBindingId}|${left.toBindingId}|${left.kind}`.localeCompare(`${right.fromBindingId}|${right.toBindingId}|${right.kind}`)),
    status: 'open',
    generatedAt,
  }
  return { definition, bindingSet }
}

function collectRuntimeNodes(starts, graph, nodeById) {
  const edgeCandidates = array(graph.edges).filter(edge => Object.hasOwn(RUNTIME_EDGE_RELATIONS, edge?.type))
  const adjacency = new Map()
  for (const edge of edgeCandidates) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    adjacency.get(edge.from).push(edge)
  }
  for (const edges of adjacency.values()) edges.sort((left, right) => String(left.edgeId).localeCompare(String(right.edgeId)))
  const queue = starts.map(node => ({ node, distance: 0 }))
  const visited = new Map(starts.map(node => [node.nodeId, 0]))
  const edges = []
  while (queue.length) {
    const current = queue.shift()
    for (const edge of adjacency.get(current.node.nodeId) || []) {
      const target = nodeById.get(edge.to)
      if (!target) continue
      edges.push(edge)
      if (!visited.has(target.nodeId)) {
        visited.set(target.nodeId, current.distance + 1)
        queue.push({ node: target, distance: current.distance + 1 })
      }
    }
  }
  const nodes = [...visited.entries()]
    .map(([nodeId, distance]) => ({ node: nodeById.get(nodeId), distance }))
    .filter(item => item.node)
    .sort((left, right) => left.distance - right.distance
      || (BINDING_TYPE_ORDER[bindingTypeForNode(left.node)] || 99) - (BINDING_TYPE_ORDER[bindingTypeForNode(right.node)] || 99)
      || left.node.nodeId.localeCompare(right.node.nodeId))
  return { nodes, edges: uniqueObjects(edges, item => item.edgeId) }
}

function resolveEntryNodes(descriptor, pageCandidate, graph) {
  const nodes = array(graph.nodes)
  const ids = new Set([...descriptor.entryEntityIds, pageCandidate?.entityId].filter(Boolean))
  const sourcePaths = new Set([descriptor.sourcePath, pageCandidate?.sourcePath].filter(Boolean))
  const exact = nodes.filter(node => ids.has(node?.nodeId))
  if (exact.length) return exact.sort(compareEntryNodes)
  const byPath = nodes.filter(node => sourcePaths.has(node?.source?.sourcePath))
  if (byPath.length) return byPath.sort(compareEntryNodes)
  return nodes.filter(node => normalizedEntityType(node) === 'route' && String(node?.label) === descriptor.title)
    .sort(compareEntryNodes)
}

function compareEntryNodes(left, right) {
  const rank = node => ({ route: 0, page: 1, module: 2, symbol: 3 }[normalizedEntityType(node)] ?? 4)
  return rank(left) - rank(right) || left.nodeId.localeCompare(right.nodeId)
}

function findPageCandidate(descriptor, frame) {
  const entryIds = new Set(descriptor.entryEntityIds)
  return array(frame.pageCandidates).find(page => entryIds.has(page?.entityId) || page?.sourcePath === descriptor.sourcePath)
    || (array(frame.pageCandidates).length === 1 ? frame.pageCandidates[0] : null)
}

function bindingTypeForNode(node) {
  const type = normalizedEntityType(node)
  const aliases = {
    page: 'page',
    'ui-element': 'ui-element',
    event: 'event',
    'ui-event': 'event',
    'component-event': 'event',
    handler: 'handler',
    effect: 'effect',
    state: 'state-transition',
    'state-transition': 'state-transition',
    'state-write': 'state-transition',
    request: 'request',
    'request-dispatch': 'request',
    endpoint: 'endpoint',
    response: 'response',
    feedback: 'feedback',
    'feedback-candidate': 'feedback',
    outcome: 'outcome',
    'outcome-candidate': 'outcome',
  }
  return aliases[type] || null
}

function normalizedEntityType(node) {
  return String(node?.entityType || node?.attributes?.entityType || node?.attributes?.kind || node?.kind || '')
    .trim()
    .toLowerCase()
}

function candidateStep(input) {
  return {
    stepId: input.stepId,
    order: input.order,
    title: input.title,
    description: input.description,
    branchIds: [],
    blocking: Boolean(input.blocking),
    evidenceIds: uniqueSorted(input.evidenceIds),
    claimIds: [],
  }
}

function candidateBinding(input) {
  return {
    bindingId: `${input.journeyId}:binding:${shortHash(`${input.stepId}|${input.bindingType}|${input.entityId}`)}`,
    stepId: input.stepId,
    order: input.order,
    branchId: null,
    bindingType: input.bindingType,
    entityId: String(input.entityId),
    entityType: String(input.entityType),
    sourcePath: input.sourcePath ? String(input.sourcePath) : null,
    evidenceIds: uniqueSorted(input.evidenceIds),
    claimIds: [],
    confidence: clamp(input.confidence),
    status: input.confirmed ? 'confirmed' : 'candidate',
  }
}

function normalizeBranchKind(value, condition) {
  if (['success', 'failure', 'alternate', 'retry', 'exit'].includes(value)) return value
  if (/error|fail|reject|invalid|denied|timeout/i.test(String(condition))) return 'failure'
  if (/retry|again/i.test(String(condition))) return 'retry'
  return 'alternate'
}

function candidateDiagnostic(kind, message) {
  return {
    diagnosticId: `journey-diagnostic:${shortHash(`${kind}|${message}`)}`,
    kind,
    severity: 'warning',
    message,
  }
}

function countEntries(entries) {
  const critical = entries.filter(entry => entry.criticality === 'critical')
  return {
    journeys: entries.length,
    candidate: entries.filter(entry => entry.status === 'candidate').length,
    open: entries.filter(entry => entry.status === 'open').length,
    closed: entries.filter(entry => entry.status === 'closed').length,
    blocked: entries.filter(entry => entry.status === 'blocked').length,
    invalidated: entries.filter(entry => entry.status === 'invalidated').length,
    critical: critical.length,
    criticalClosed: critical.filter(entry => entry.status === 'closed').length,
  }
}

function withJourneyStoreLock(paths, action) {
  fs.mkdirSync(paths.storeParent, { recursive: true })
  let fileDescriptor
  try {
    fileDescriptor = fs.openSync(paths.lock, 'wx')
    fs.writeFileSync(fileDescriptor, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 'utf8')
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Journey store writer lock is already held: ${paths.lock}`)
    throw error
  }
  try {
    return action()
  } finally {
    fs.closeSync(fileDescriptor)
    fs.rmSync(paths.lock, { force: true })
  }
}

function replaceJourneyStore(paths, built) {
  const stage = path.join(paths.storeParent, `.journeys-stage-${process.pid}-${shortHash(`${built.manifest.journeySetHash}|${built.manifest.generatedAt}`)}`)
  const backup = path.join(paths.storeParent, `.journeys-backup-${process.pid}-${shortHash(paths.root)}`)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.rmSync(backup, { recursive: true, force: true })
  fs.mkdirSync(path.join(stage, 'definitions'), { recursive: true })
  fs.mkdirSync(path.join(stage, 'bindings'), { recursive: true })
  fs.mkdirSync(path.join(stage, 'closure'), { recursive: true })
  try {
    for (const entry of built.manifest.entries) {
      const definition = built.definitions.find(item => item.journeyId === entry.journeyId)
      const bindingSet = built.bindingSets.find(item => item.journeyId === entry.journeyId)
      const report = built.closureReports.find(item => item.journeyId === entry.journeyId)
      writeJson(path.join(stage, 'definitions', path.basename(entry.definitionPath)), definition)
      writeJson(path.join(stage, 'bindings', path.basename(entry.bindingPath)), bindingSet)
      writeJson(path.join(stage, 'closure', path.basename(entry.closureReportPath)), report)
    }
    writeJson(path.join(stage, 'manifest.json'), built.manifest)
    if (fs.existsSync(paths.root)) fs.renameSync(paths.root, backup)
    fs.renameSync(stage, paths.root)
    fs.rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!fs.existsSync(paths.root) && fs.existsSync(backup)) fs.renameSync(backup, paths.root)
    fs.rmSync(stage, { recursive: true, force: true })
    throw error
  }
  return { ...built, paths }
}

function latestStoreTimestamp(definitions, bindingSets) {
  const values = [
    ...definitions.flatMap(item => [item?.createdAt, item?.updatedAt]),
    ...bindingSets.map(item => item?.generatedAt),
  ].filter(Boolean).map(String).sort()
  return values.at(-1) || '1970-01-01T00:00:00.000Z'
}

function readJsonDirectory(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => readJson(path.join(directory, entry.name)))
    .sort(byJourneyId)
}

function readBundledSchema(relativePath) {
  return JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null
}

function resolvePackageArtifact(packageRoot, relativePath) {
  const resolved = path.resolve(packageRoot, String(relativePath || ''))
  const relative = path.relative(packageRoot, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Journey store artifact escapes packageDir: ${relativePath}`)
  }
  return resolved
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function journeyFileName(journeyId) {
  const slug = String(journeyId).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'journey'
  return `${slug}-${shortHash(journeyId)}.json`
}

function stripTemporalMetadata(value) {
  if (Array.isArray(value)) return value.map(stripTemporalMetadata)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (['createdAt', 'updatedAt', 'generatedAt', 'evaluatedAt'].includes(key)) continue
    output[key] = stripTemporalMetadata(value[key])
  }
  return output
}

function hashCanonical(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function shortHash(value, length = 12) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length)
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function validateJsonSchema(value, schema, root = schema, pointer = '$') {
  const issues = []
  if (schema.$ref) {
    const target = resolveSchemaRef(root, schema.$ref)
    return target ? validateJsonSchema(value, target, root, pointer) : [`${pointer} references unknown schema ${schema.$ref}`]
  }
  if (Object.hasOwn(schema, 'const') && !sameValue(value, schema.const)) issues.push(`${pointer} must equal ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.some(item => sameValue(value, item))) issues.push(`${pointer} must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`)
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.length && !types.some(type => matchesType(value, type))) {
    issues.push(`${pointer} must be ${types.join(' or ')}`)
    return issues
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${pointer} must contain at least ${schema.minLength} characters`)
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) issues.push(`${pointer} must match ${schema.pattern}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${pointer} must be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${pointer} must be <= ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${pointer} must contain at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${pointer} must contain at most ${schema.maxItems} items`)
    if (schema.uniqueItems) {
      const keys = value.map(stableStringify)
      if (new Set(keys).size !== keys.length) issues.push(`${pointer} must contain unique items`)
    }
    if (schema.items) value.forEach((item, index) => issues.push(...validateJsonSchema(item, schema.items, root, `${pointer}[${index}]`)))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {}
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) issues.push(`${pointer}.${required} is required`)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) issues.push(`${pointer}.${key} is not allowed`)
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) issues.push(...validateJsonSchema(value[key], child, root, `${pointer}.${key}`))
    }
  }
  return issues
}

function resolveSchemaRef(root, reference) {
  if (!reference.startsWith('#/')) return null
  return reference.slice(2).split('/').reduce((current, token) => current?.[token.replace(/~1/g, '/').replace(/~0/g, '~')], root)
}

function matchesType(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function sameValue(left, right) {
  return stableStringify(left) === stableStringify(right)
}

function collectDuplicateIds(values, field, pointer, issues) {
  const seen = new Set()
  values.forEach((value, index) => {
    const id = value?.[field]
    if (seen.has(id)) issues.push(`${pointer}[${index}].${field} is duplicated: ${id}`)
    seen.add(id)
  })
}

function normalizeCriticality(value) {
  return ['low', 'medium', 'high', 'critical'].includes(value) ? value : 'medium'
}

function clamp(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0
}

function pageTitle(value) {
  const source = String(value || 'Frontend page')
  return source.split('/').at(-1)?.replace(/\.[^.]+$/, '') || source
}

function byJourneyId(left, right) {
  return String(left?.journeyId || '').localeCompare(String(right?.journeyId || ''))
}

function uniqueSorted(values) {
  return [...new Set(array(values).filter(value => value !== null && value !== undefined && value !== '').map(String))].sort()
}

function uniqueObjects(values, key) {
  const seen = new Set()
  return array(values).filter(value => {
    const token = key(value)
    if (!token || seen.has(token)) return false
    seen.add(token)
    return true
  })
}

function array(value) {
  return Array.isArray(value) ? value : []
}
