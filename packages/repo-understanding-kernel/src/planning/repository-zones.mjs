import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const REPOSITORY_ZONE_AGENT_PLAN_SCHEMA = 'repo-repository-zone-agent-plan/v1'
export const REPOSITORY_ZONE_AGENT_CONTEXT_SCHEMA = 'repo-repository-zone-agent-context/v1'
export const REPO_REPOSITORY_ZONES_SCHEMA = 'repo-repository-zones/v2'
export const REPOSITORY_ZONE_REVIEW_SCHEMA = 'repo-repository-zone-review/v1'

const DEFAULT_REFS = Object.freeze({
  contextRef: 'research/repository-zones/context.json',
  outputRef: 'research/repository-zones/result.json',
  reviewRef: 'research/repository-zones/review.json',
  finalRef: 'planning/repository-zones.json',
})

/**
 * Build an Agent dispatch contract. This planner deliberately creates no
 * domains and assigns no file to a region. Domain authority belongs to the
 * Agent result and its independent Agent review.
 */
export function buildRepositoryZoneAgentPlan({
  inventory,
  staticProgramGraph,
  nodeSemanticCatalog,
  repoPath,
  generatedAt = staticProgramGraph?.generatedAt || nodeSemanticCatalog?.generatedAt || '1970-01-01T00:00:00.000Z',
  refs = {},
  maxZones = 24,
  maxSubzones = 96,
} = {}) {
  assertPlanningInputs({ inventory, staticProgramGraph, nodeSemanticCatalog, repoPath })
  const allowedFiles = inventoryPaths(inventory)
  const artifactRefs = { ...DEFAULT_REFS, ...refs }
  const core = {
    graphId: staticProgramGraph.graphId,
    snapshotId: staticProgramGraph.snapshotId,
    semanticCatalogHash: repositoryZoneCatalogHash(nodeSemanticCatalog),
    repoPath: path.resolve(repoPath),
    allowedFiles,
    artifactRefs,
    constraints: {
      authority: 'agent-only',
      coverage: 'all-inventory-files-exactly-once',
      sharedFileIdentity: 'single-membership',
      domainNaming: 'agent-derived',
      maxZones: positiveInteger(maxZones, 'maxZones'),
      maxSubzones: positiveInteger(maxSubzones, 'maxSubzones'),
    },
  }
  const plan = {
    schemaVersion: REPOSITORY_ZONE_AGENT_PLAN_SCHEMA,
    planId: `repository-zone-agent-plan:${shortHash(stableStringify(core), 24)}`,
    ...core,
    agentRole: 'repo-domain-analyzer',
    reviewerRole: 'repo-domain-verifier',
    generatedAt: String(generatedAt),
  }
  const issues = validateRepositoryZoneAgentPlan({ plan, inventory, staticProgramGraph, nodeSemanticCatalog })
  if (issues.length) throw new Error(`Generated invalid Repository Zone Agent Plan:\n- ${issues.join('\n- ')}`)
  return plan
}

export function validateRepositoryZoneAgentPlan({ plan, inventory, staticProgramGraph, nodeSemanticCatalog } = {}) {
  const issues = []
  if (plan?.schemaVersion !== REPOSITORY_ZONE_AGENT_PLAN_SCHEMA) issues.push(`schemaVersion must be ${REPOSITORY_ZONE_AGENT_PLAN_SCHEMA}`)
  if (!plan?.planId) issues.push('planId is required')
  if (!plan?.graphId || plan.graphId !== staticProgramGraph?.graphId) issues.push('graphId must match Static Program Graph')
  if (!plan?.snapshotId || plan.snapshotId !== staticProgramGraph?.snapshotId) issues.push('snapshotId must match Static Program Graph')
  if (!plan?.repoPath) issues.push('repoPath is required')
  if (plan?.semanticCatalogHash !== repositoryZoneCatalogHash(nodeSemanticCatalog)) issues.push('semanticCatalogHash must match the accepted Node Semantic Catalog')
  if (!sameStrings(plan?.allowedFiles, inventoryPaths(inventory))) issues.push('allowedFiles must cover every inventory file exactly once')
  if (plan?.constraints?.authority !== 'agent-only') issues.push('constraints.authority must be agent-only')
  if (plan?.constraints?.coverage !== 'all-inventory-files-exactly-once') issues.push('constraints.coverage is invalid')
  if (plan?.constraints?.sharedFileIdentity !== 'single-membership') issues.push('constraints.sharedFileIdentity is invalid')
  if (plan?.constraints?.domainNaming !== 'agent-derived') issues.push('constraints.domainNaming must be agent-derived')
  if (!Number.isInteger(plan?.constraints?.maxZones) || plan.constraints.maxZones < 1) issues.push('constraints.maxZones must be a positive integer')
  if (!Number.isInteger(plan?.constraints?.maxSubzones) || plan.constraints.maxSubzones < 1) issues.push('constraints.maxSubzones must be a positive integer')
  for (const key of Object.keys(DEFAULT_REFS)) if (!safeArtifactRef(plan?.artifactRefs?.[key])) issues.push(`artifactRefs.${key} must be a safe relative path`)
  if (plan?.zones !== undefined || plan?.memberships !== undefined) issues.push('Agent plan must not contain zones or memberships')
  const expectedCore = {
    graphId: plan?.graphId,
    snapshotId: plan?.snapshotId,
    semanticCatalogHash: plan?.semanticCatalogHash,
    repoPath: plan?.repoPath,
    allowedFiles: array(plan?.allowedFiles),
    artifactRefs: plan?.artifactRefs,
    constraints: plan?.constraints,
  }
  if (plan?.planId !== `repository-zone-agent-plan:${shortHash(stableStringify(expectedCore), 24)}`) issues.push('planId is not deterministic for its inputs')
  return uniqueSorted(issues)
}

export function buildRepositoryZoneAgentContext({ plan, inventory, staticProgramGraph, nodeSemanticCatalog, communityMap = null } = {}) {
  const planIssues = validateRepositoryZoneAgentPlan({ plan, inventory, staticProgramGraph, nodeSemanticCatalog })
  if (planIssues.length) throw new Error(`Invalid Repository Zone Agent Plan:\n- ${planIssues.join('\n- ')}`)
  const semanticByPath = new Map(array(nodeSemanticCatalog?.entries).map(entry => [portable(entry.filePath), entry]))
  const relations = aggregateFileRelations(staticProgramGraph, new Set(plan.allowedFiles))
  const relationsByPath = new Map(plan.allowedFiles.map(filePath => [filePath, []]))
  for (const relation of relations) {
    relationsByPath.get(relation.from)?.push({ direction: 'outbound', filePath: relation.to, edgeTypes: relation.edgeTypes, count: relation.count })
    relationsByPath.get(relation.to)?.push({ direction: 'inbound', filePath: relation.from, edgeTypes: relation.edgeTypes, count: relation.count })
  }
  const communityIdsByPath = indexCommunitiesByPath(communityMap, staticProgramGraph)
  const inventoryByPath = new Map(array(inventory?.files).map(file => [portable(file.path), file]))
  const files = plan.allowedFiles.map(filePath => {
    const file = inventoryByPath.get(filePath) || {}
    const semantic = semanticByPath.get(filePath)
    return {
      filePath,
      language: file.language || 'Unknown',
      category: file.category || 'unknown',
      lines: Number(file.lines || 0),
      size: Number(file.size || 0),
      binary: Boolean(file.binary),
      protected: Boolean(file.protected),
      communityIds: communityIdsByPath.get(filePath) || [],
      semantic: semantic ? compactSemantic(semantic) : null,
      relations: array(relationsByPath.get(filePath)).sort(compareRelations),
    }
  })
  return {
    schemaVersion: REPOSITORY_ZONE_AGENT_CONTEXT_SCHEMA,
    planId: plan.planId,
    graphId: plan.graphId,
    snapshotId: plan.snapshotId,
    semanticCatalogHash: plan.semanticCatalogHash,
    repo: {
      name: inventory?.repo?.name || path.basename(plan.repoPath),
      path: plan.repoPath,
      branch: inventory?.repo?.git?.branch || null,
      head: inventory?.repo?.git?.head || null,
    },
    graphSummary: {
      files: files.length,
      semanticFiles: files.filter(file => file.semantic).length,
      relations: relations.length,
      communities: new Set(files.flatMap(file => file.communityIds)).size,
    },
    files,
    analysisRequirements: [
      'Infer repository domains from accepted file responsibilities and code relationships; directory names are supporting evidence only.',
      'Create domain and subdomain names that describe this repository. No fixed taxonomy is supplied.',
      'Assign every allowed file exactly once. A shared file keeps one identity and must not be copied into multiple domains.',
      'Ground each domain and membership with semantic, graph, or inventory evidence from this context.',
      'Use needs-review when evidence is insufficient; do not invent files, runtime behavior, or product intent.',
    ],
    resultContract: {
      schemaVersion: REPO_REPOSITORY_ZONES_SCHEMA,
      outputRef: plan.artifactRefs.outputRef,
      status: 'draft',
      producerKind: 'agent',
      requiredCoverage: plan.constraints.coverage,
      maxZones: plan.constraints.maxZones,
      maxSubzones: plan.constraints.maxSubzones,
    },
    generatedAt: plan.generatedAt,
  }
}

export function validateRepositoryZoneDraft({ catalog, plan, inventory, staticProgramGraph } = {}) {
  const issues = validateCatalogCore({ catalog, plan, inventory, staticProgramGraph, expectedStatus: 'draft' })
  if (catalog?.review !== undefined) issues.push('draft catalog must not contain review')
  if (catalog?.crossZoneRelations !== undefined) issues.push('draft catalog must not contain projected crossZoneRelations')
  if (catalog?.metrics !== undefined) issues.push('draft catalog must not contain projected metrics')
  return uniqueSorted(issues)
}

export function validateRepositoryZones(value, context = {}) {
  const issues = validateCatalogCore({
    catalog: value,
    plan: context.plan,
    inventory: context.inventory,
    staticProgramGraph: context.staticProgramGraph,
    expectedStatus: 'complete',
  })
  if (value?.review?.status !== 'accepted') issues.push('complete catalog requires an accepted Agent review')
  if (value?.review?.reviewer?.kind !== 'agent') issues.push('complete catalog reviewer must be an Agent')
  if (!Array.isArray(value?.crossZoneRelations)) issues.push('complete catalog requires crossZoneRelations')
  if (!value?.metrics || value.metrics.files !== array(value?.memberships).length) issues.push('complete catalog metrics.files must match memberships')
  return uniqueSorted(issues)
}

export function repositoryZoneCatalogHash(catalog) {
  return `sha256:${createHash('sha256').update(JSON.stringify(catalog) ?? 'null').digest('hex')}`
}

export function validateRepositoryZoneReview({ review, plan, catalog } = {}) {
  const issues = []
  if (review?.schemaVersion !== REPOSITORY_ZONE_REVIEW_SCHEMA) issues.push(`schemaVersion must be ${REPOSITORY_ZONE_REVIEW_SCHEMA}`)
  if (!review?.planId || review.planId !== plan?.planId) issues.push('planId must match the Agent plan')
  if (!review?.snapshotId || review.snapshotId !== plan?.snapshotId) issues.push('snapshotId must match the Agent plan')
  if (review?.catalogHash !== repositoryZoneCatalogHash(catalog)) issues.push('catalogHash must match the exact reviewed catalog')
  if (!['accepted', 'changes-requested'].includes(review?.status)) issues.push('status must be accepted or changes-requested')
  const requiredChecks = ['semanticGrounding', 'graphCoherence', 'completeCoverage', 'singleFileIdentity', 'notPathOnlyClassification', 'noInventedFiles']
  for (const check of requiredChecks) if (typeof review?.checks?.[check] !== 'boolean') issues.push(`checks.${check} must be boolean`)
  if (!Array.isArray(review?.issues)) issues.push('issues must be an array')
  if (review?.reviewer?.kind !== 'agent' || !review?.reviewer?.agentId) issues.push('reviewer must identify an Agent')
  if (review?.reviewer?.agentId && review.reviewer.agentId === catalog?.producer?.agentId) issues.push('reviewer Agent must be independent from producer Agent')
  if (review?.status === 'accepted') {
    for (const check of requiredChecks) if (review?.checks?.[check] !== true) issues.push(`accepted review requires checks.${check}=true`)
    if (array(review?.issues).length) issues.push('accepted review must not contain issues')
  }
  return uniqueSorted(issues)
}

export function acceptRepositoryZoneCatalog({ catalog, review, plan, inventory, staticProgramGraph } = {}) {
  const draftIssues = validateRepositoryZoneDraft({ catalog, plan, inventory, staticProgramGraph })
  if (draftIssues.length) throw new Error(`Invalid Repository Zone Agent draft:\n- ${draftIssues.join('\n- ')}`)
  const reviewIssues = validateRepositoryZoneReview({ review, plan, catalog })
  if (reviewIssues.length) throw new Error(`Invalid Repository Zone Agent review:\n- ${reviewIssues.join('\n- ')}`)
  if (review.status !== 'accepted') throw new Error('Repository Zone Agent review requested changes')
  const memberships = catalog.memberships.map(item => ({
    ...item,
    status: item.status === 'needs-review' ? 'needs-review' : 'accepted',
  })).sort((left, right) => left.filePath.localeCompare(right.filePath))
  const zones = materializeZoneMemberships(catalog.zones, memberships)
  const crossZoneRelations = buildCrossZoneRelations(staticProgramGraph, memberships)
  const finalCore = {
    planId: plan.planId,
    snapshotId: plan.snapshotId,
    graphId: plan.graphId,
    semanticCatalogHash: plan.semanticCatalogHash,
    zones,
    memberships,
    crossZoneRelations,
  }
  const accepted = {
    schemaVersion: REPO_REPOSITORY_ZONES_SCHEMA,
    zonePlanId: `repository-zones:${shortHash(stableStringify(finalCore), 24)}`,
    ...finalCore,
    status: 'complete',
    producer: catalog.producer,
    review: {
      status: review.status,
      catalogHash: review.catalogHash,
      reviewer: review.reviewer,
      generatedAt: review.generatedAt,
    },
    unknowns: array(catalog.unknowns),
    metrics: {
      files: memberships.length,
      zones: zones.length,
      subzones: zones.reduce((sum, zone) => sum + zone.subzones.length, 0),
      unclassifiedFiles: memberships.filter(item => item.status === 'needs-review').length,
      crossZoneRelations: crossZoneRelations.reduce((sum, relation) => sum + relation.count, 0),
    },
    generatedAt: catalog.generatedAt,
  }
  const issues = validateRepositoryZones(accepted, { plan, inventory, staticProgramGraph })
  if (issues.length) throw new Error(`Accepted Repository Zones are invalid:\n- ${issues.join('\n- ')}`)
  return accepted
}

export function writeRepositoryZoneAgentPlan({ packageDir, plan, inventory, staticProgramGraph, nodeSemanticCatalog, outputPath = 'planning/repository-zone-agent-plan.json' } = {}) {
  const issues = validateRepositoryZoneAgentPlan({ plan, inventory, staticProgramGraph, nodeSemanticCatalog })
  if (issues.length) throw new Error(`Repository Zone Agent Plan is invalid:\n- ${issues.join('\n- ')}`)
  return writeJsonAtomic(packageDir, outputPath, plan)
}

export function writeRepositoryZoneAgentContext({ packageDir, context, outputPath = DEFAULT_REFS.contextRef } = {}) {
  if (context?.schemaVersion !== REPOSITORY_ZONE_AGENT_CONTEXT_SCHEMA) throw new Error(`context schemaVersion must be ${REPOSITORY_ZONE_AGENT_CONTEXT_SCHEMA}`)
  return writeJsonAtomic(packageDir, outputPath, context)
}

export function writeRepositoryZones({ packageDir, zones, plan, inventory, staticProgramGraph, outputPath = DEFAULT_REFS.finalRef } = {}) {
  if (!packageDir) throw new Error('writeRepositoryZones requires packageDir')
  const issues = validateRepositoryZones(zones, { plan, inventory, staticProgramGraph })
  if (issues.length) throw new Error(`Repository Zones are invalid:\n- ${issues.join('\n- ')}`)
  return writeJsonAtomic(packageDir, outputPath, zones)
}

function validateCatalogCore({ catalog, plan, inventory, staticProgramGraph, expectedStatus }) {
  const issues = []
  if (catalog?.schemaVersion !== REPO_REPOSITORY_ZONES_SCHEMA) issues.push(`schemaVersion must be ${REPO_REPOSITORY_ZONES_SCHEMA}`)
  if (!catalog?.zonePlanId) issues.push('zonePlanId is required')
  if (!catalog?.planId || catalog.planId !== plan?.planId) issues.push('planId must match the Repository Zone Agent Plan')
  if (!catalog?.snapshotId || catalog.snapshotId !== plan?.snapshotId) issues.push('snapshotId must match the Repository Zone Agent Plan')
  if (!catalog?.graphId || catalog.graphId !== staticProgramGraph?.graphId) issues.push('graphId must match Static Program Graph')
  if (catalog?.semanticCatalogHash !== plan?.semanticCatalogHash) issues.push('semanticCatalogHash must match the Repository Zone Agent Plan')
  if (catalog?.status !== expectedStatus) issues.push(`status must be ${expectedStatus}`)
  if (catalog?.producer?.kind !== 'agent' || !catalog?.producer?.agentId) issues.push('producer must identify the domain-analysis Agent')
  if (!Array.isArray(catalog?.zones) || catalog.zones.length === 0) issues.push('zones must be a non-empty Agent-derived array')
  if (!Array.isArray(catalog?.memberships)) issues.push('memberships must be an array')
  if (!Array.isArray(catalog?.unknowns)) issues.push('unknowns must be an array')
  const inventorySet = new Set(inventoryPaths(inventory))
  const zoneById = new Map()
  const subzoneKeys = new Set()
  let subzoneCount = 0
  for (const [index, zone] of array(catalog?.zones).entries()) {
    const pointer = `zones[${index}]`
    if (!safeId(zone?.zoneId)) issues.push(`${pointer}.zoneId must be a stable slug`)
    if (zoneById.has(zone?.zoneId)) issues.push(`${pointer}.zoneId is duplicated`)
    zoneById.set(zone?.zoneId, zone)
    if (!textValue(zone?.label) || !textValue(zone?.summary) || !textValue(zone?.rationale)) issues.push(`${pointer} requires label, summary, and rationale`)
    if (!confidence(zone?.confidence)) issues.push(`${pointer}.confidence must be between 0 and 1`)
    validateEvidenceRefs(zone?.evidenceRefs, inventorySet, issues, `${pointer}.evidenceRefs`, true)
    if (!Array.isArray(zone?.subzones) || zone.subzones.length === 0) issues.push(`${pointer}.subzones must not be empty`)
    for (const [subIndex, subzone] of array(zone?.subzones).entries()) {
      const subPointer = `${pointer}.subzones[${subIndex}]`
      const key = `${zone?.zoneId}\u0000${subzone?.subzoneId}`
      if (!safeId(subzone?.subzoneId)) issues.push(`${subPointer}.subzoneId must be a stable slug`)
      if (subzoneKeys.has(key)) issues.push(`${subPointer}.subzoneId is duplicated inside the zone`)
      subzoneKeys.add(key)
      if (!textValue(subzone?.label) || !textValue(subzone?.summary) || !textValue(subzone?.rationale)) issues.push(`${subPointer} requires label, summary, and rationale`)
      if (!confidence(subzone?.confidence)) issues.push(`${subPointer}.confidence must be between 0 and 1`)
      validateEvidenceRefs(subzone?.evidenceRefs, inventorySet, issues, `${subPointer}.evidenceRefs`, true)
      subzoneCount += 1
    }
  }
  if (array(catalog?.zones).length > (plan?.constraints?.maxZones || 0)) issues.push('zones exceed plan.constraints.maxZones')
  if (subzoneCount > (plan?.constraints?.maxSubzones || 0)) issues.push('subzones exceed plan.constraints.maxSubzones')
  const membershipPaths = new Set()
  for (const [index, membership] of array(catalog?.memberships).entries()) {
    const pointer = `memberships[${index}]`
    const filePath = portable(membership?.filePath)
    if (!inventorySet.has(filePath)) issues.push(`${pointer}.filePath is absent from inventory: ${filePath}`)
    if (membershipPaths.has(filePath)) issues.push(`${pointer}.filePath is duplicated: ${filePath}`)
    membershipPaths.add(filePath)
    const zone = zoneById.get(membership?.zoneId)
    if (!zone) issues.push(`${pointer}.zoneId references an unknown Agent domain`)
    if (zone && !array(zone.subzones).some(subzone => subzone.subzoneId === membership?.subzoneId)) issues.push(`${pointer}.subzoneId references an unknown Agent subdomain`)
    if (!textValue(membership?.role) || !textValue(membership?.rationale)) issues.push(`${pointer} requires role and rationale`)
    if (!confidence(membership?.confidence)) issues.push(`${pointer}.confidence must be between 0 and 1`)
    if (!['proposed', 'accepted', 'needs-review'].includes(membership?.status)) issues.push(`${pointer}.status is invalid`)
    validateEvidenceRefs(membership?.evidenceRefs, inventorySet, issues, `${pointer}.evidenceRefs`, true)
  }
  if (!sameStrings([...membershipPaths], inventoryPaths(inventory))) issues.push('memberships must cover every inventory file exactly once')
  return issues
}

function compactSemantic(entry) {
  return {
    semanticKind: entry.semanticKind || 'other',
    title: entry.title || path.posix.basename(entry.filePath || ''),
    responsibility: entry.responsibility?.summary || '',
    inputs: compactSemanticItems(entry.inputs),
    actions: compactSemanticItems(entry.actions),
    state: compactSemanticItems(entry.state),
    outputs: compactSemanticItems(entry.outputs),
    conditions: compactSemanticItems(entry.conditions),
    boundaries: compactSemanticItems(entry.boundaries),
    collaborators: array(entry.collaborators).map(item => ({ filePath: portable(item.filePath), role: item.role || '' })),
    evidence: semanticEvidence(entry),
    confidence: Number(entry.confidence || 0),
    status: entry.status,
  }
}

function compactSemanticItems(items) {
  return array(items).map(item => ({ name: item.name || '', description: item.description || '' })).filter(item => item.name || item.description)
}

function semanticEvidence(entry) {
  const values = [entry?.responsibility, ...array(entry?.inputs), ...array(entry?.actions), ...array(entry?.state), ...array(entry?.outputs), ...array(entry?.conditions), ...array(entry?.boundaries), ...array(entry?.collaborators)]
  return uniqueBy(values.flatMap(item => array(item?.evidence)).map(item => ({
    filePath: portable(item.sourcePath),
    startLine: Number(item.startLine || 0),
    endLine: Number(item.endLine || item.startLine || 0),
  })).filter(item => item.filePath), item => `${item.filePath}:${item.startLine}:${item.endLine}`)
}

function materializeZoneMemberships(zones, memberships) {
  return zones.map((zone, order) => {
    const zoneMembers = memberships.filter(item => item.zoneId === zone.zoneId)
    return {
      ...zone,
      order,
      fileCount: zoneMembers.length,
      memberFilePaths: zoneMembers.map(item => item.filePath).sort(),
      subzones: zone.subzones.map(subzone => {
        const subzoneMembers = zoneMembers.filter(item => item.subzoneId === subzone.subzoneId)
        return {
          ...subzone,
          fileCount: subzoneMembers.length,
          memberFilePaths: subzoneMembers.map(item => item.filePath).sort(),
          representativeFilePaths: subzoneMembers.slice().sort((left, right) => right.confidence - left.confidence || left.filePath.localeCompare(right.filePath)).slice(0, 8).map(item => item.filePath),
        }
      }),
    }
  })
}

function buildCrossZoneRelations(graph, memberships) {
  const membershipByPath = new Map(memberships.map(item => [item.filePath, item]))
  const fileSet = new Set(memberships.map(item => item.filePath))
  const relations = aggregateFileRelations(graph, fileSet)
  const values = new Map()
  for (const relation of relations) {
    const from = membershipByPath.get(relation.from)
    const to = membershipByPath.get(relation.to)
    if (!from || !to || from.zoneId === to.zoneId) continue
    const key = `${from.zoneId}\u0000${to.zoneId}`
    const current = values.get(key) || { fromZoneId: from.zoneId, toZoneId: to.zoneId, count: 0, edgeTypes: {} }
    current.count += relation.count
    for (const [type, count] of Object.entries(relation.edgeTypes)) current.edgeTypes[type] = (current.edgeTypes[type] || 0) + count
    values.set(key, current)
  }
  return [...values.values()].sort((left, right) => left.fromZoneId.localeCompare(right.fromZoneId) || left.toZoneId.localeCompare(right.toZoneId))
}

function aggregateFileRelations(graph, fileSet) {
  const sourcePathByNode = new Map()
  for (const node of array(graph?.nodes)) {
    const sourcePath = portable(node?.source?.sourcePath || node?.attributes?.sourcePath || (String(node?.nodeId || '').startsWith('module:') ? String(node.nodeId).slice(7) : ''))
    if (sourcePath && fileSet.has(sourcePath)) sourcePathByNode.set(node.nodeId, sourcePath)
  }
  const values = new Map()
  for (const edge of array(graph?.edges)) {
    const from = sourcePathByNode.get(edge.from)
    const to = sourcePathByNode.get(edge.to)
    if (!from || !to || from === to) continue
    const key = `${from}\u0000${to}`
    const current = values.get(key) || { from, to, count: 0, edgeTypes: {} }
    current.count += 1
    current.edgeTypes[edge.type || 'related'] = (current.edgeTypes[edge.type || 'related'] || 0) + 1
    values.set(key, current)
  }
  return [...values.values()].sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to))
}

function indexCommunitiesByPath(communityMap, graph) {
  const sourcePathByNode = new Map(array(graph?.nodes).map(node => [node.nodeId, portable(node?.source?.sourcePath || node?.attributes?.sourcePath)]))
  const values = new Map()
  for (const membership of array(communityMap?.membership)) {
    const filePath = sourcePathByNode.get(membership.nodeId)
    if (!filePath) continue
    const ids = values.get(filePath) || new Set()
    ids.add(membership.communityId)
    values.set(filePath, ids)
  }
  return new Map([...values].map(([filePath, ids]) => [filePath, [...ids].sort()]))
}

function validateEvidenceRefs(refs, inventorySet, issues, pointer, required) {
  if (!Array.isArray(refs) || (required && refs.length === 0)) {
    issues.push(`${pointer} must contain Agent grounding evidence`)
    return
  }
  for (const [index, ref] of refs.entries()) {
    const itemPointer = `${pointer}[${index}]`
    if (!['semantic', 'graph', 'inventory'].includes(ref?.kind)) issues.push(`${itemPointer}.kind is invalid`)
    if (!inventorySet.has(portable(ref?.filePath))) issues.push(`${itemPointer}.filePath is absent from inventory`)
    if (ref?.relatedFilePath && !inventorySet.has(portable(ref.relatedFilePath))) issues.push(`${itemPointer}.relatedFilePath is absent from inventory`)
    if (!textValue(ref?.claim)) issues.push(`${itemPointer}.claim is required`)
  }
}

function assertPlanningInputs({ inventory, staticProgramGraph, nodeSemanticCatalog, repoPath }) {
  if (!Array.isArray(inventory?.files)) throw new Error('inventory.files is required')
  if (!staticProgramGraph?.graphId || !staticProgramGraph?.snapshotId) throw new Error('Static Program Graph requires graphId and snapshotId')
  if (nodeSemanticCatalog?.status !== 'complete') throw new Error('Node Semantic Catalog must be complete before Domain Agent planning')
  if (array(nodeSemanticCatalog?.entries).some(entry => entry.status !== 'accepted')) throw new Error('Node Semantic Catalog contains non-accepted entries')
  if (!repoPath) throw new Error('repoPath is required')
}

function inventoryPaths(inventory) {
  return uniqueSorted(array(inventory?.files).map(file => portable(file.path)).filter(Boolean))
}

function writeJsonAtomic(packageDir, outputPath, value) {
  if (!packageDir) throw new Error('packageDir is required')
  const target = path.resolve(packageDir, outputPath)
  const root = `${path.resolve(packageDir)}${path.sep}`
  if (!target.startsWith(root)) throw new Error(`outputPath escapes packageDir: ${outputPath}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, target)
  return target
}

function compareRelations(left, right) {
  return right.count - left.count || left.direction.localeCompare(right.direction) || left.filePath.localeCompare(right.filePath)
}

function safeArtifactRef(value) {
  const normalized = portable(value)
  return Boolean(normalized && !path.posix.isAbsolute(normalized) && normalized !== '..' && !normalized.startsWith('../'))
}

function safeId(value) {
  return /^[a-z0-9][a-z0-9:_-]*$/.test(String(value || ''))
}

function textValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function confidence(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function positiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`)
  return number
}

function portable(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function sameStrings(left, right) {
  const a = uniqueSorted(array(left))
  const b = uniqueSorted(array(right))
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function uniqueSorted(values) {
  return [...new Set(array(values).filter(Boolean))].sort()
}

function uniqueBy(values, key) {
  const result = []
  const seen = new Set()
  for (const value of values) {
    const identity = key(value)
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push(value)
  }
  return result
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function shortHash(value, length) {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}
