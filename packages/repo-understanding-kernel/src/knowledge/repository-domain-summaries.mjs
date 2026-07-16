import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { repositoryZoneCatalogHash } from '../planning/repository-zones.mjs'

export const REPOSITORY_DOMAIN_SUMMARY_AGENT_PLAN_SCHEMA = 'repo-repository-domain-summary-agent-plan/v1'
export const REPOSITORY_DOMAIN_SUMMARY_AGENT_CONTEXT_SCHEMA = 'repo-repository-domain-summary-agent-context/v1'
export const REPOSITORY_DOMAIN_SUMMARIES_SCHEMA = 'repo-repository-domain-summaries/v1'
export const REPOSITORY_DOMAIN_SUMMARY_REVIEW_SCHEMA = 'repo-repository-domain-summary-review/v1'

const DEFAULT_REFS = Object.freeze({
  contextRef: 'research/repository-domain-summaries/context.json',
  outputRef: 'research/repository-domain-summaries/result.json',
  reviewRef: 'research/repository-domain-summaries/review.json',
  finalRef: 'store/repository-domain-summaries.json',
})

const REVIEW_CHECKS = Object.freeze([
  'evidenceGrounding',
  'zoneCoverage',
  'entryAndCoreAccuracy',
  'boundaryAccuracy',
  'collaborationAccuracy',
  'noInventedBehavior',
  'unknownsPreserved',
])

export function buildRepositoryDomainSummaryAgentPlan({
  repositoryZones,
  staticProgramGraph,
  nodeSemanticCatalog,
  repoPath,
  generatedAt = staticProgramGraph?.generatedAt || nodeSemanticCatalog?.generatedAt || '1970-01-01T00:00:00.000Z',
  refs = {},
  maxEntriesPerZone = 12,
  maxCoreFilesPerZone = 12,
  maxBoundaryFilesPerZone = 16,
} = {}) {
  assertPlanningInputs({ repositoryZones, staticProgramGraph, nodeSemanticCatalog, repoPath })
  const artifactRefs = { ...DEFAULT_REFS, ...refs }
  const core = {
    graphId: staticProgramGraph.graphId,
    snapshotId: staticProgramGraph.snapshotId,
    semanticCatalogHash: repositoryZoneCatalogHash(nodeSemanticCatalog),
    zonePlanId: repositoryZones.zonePlanId,
    zoneCatalogHash: repositoryZoneCatalogHash(repositoryZones),
    repoPath: path.resolve(repoPath),
    allowedZoneIds: repositoryZones.zones.map(zone => zone.zoneId),
    artifactRefs,
    constraints: {
      authority: 'agent-only',
      coverage: 'all-reviewed-zones-exactly-once',
      classification: 'reuse-reviewed-zone-membership',
      evidence: 'accepted-semantics-and-static-graph',
      maxEntriesPerZone: positiveInteger(maxEntriesPerZone, 'maxEntriesPerZone'),
      maxCoreFilesPerZone: positiveInteger(maxCoreFilesPerZone, 'maxCoreFilesPerZone'),
      maxBoundaryFilesPerZone: positiveInteger(maxBoundaryFilesPerZone, 'maxBoundaryFilesPerZone'),
    },
  }
  const plan = {
    schemaVersion: REPOSITORY_DOMAIN_SUMMARY_AGENT_PLAN_SCHEMA,
    planId: `repository-domain-summary-agent-plan:${shortHash(stableStringify(core), 24)}`,
    ...core,
    agentRole: 'repo-domain-interpreter',
    reviewerRole: 'repo-domain-summary-verifier',
    generatedAt: String(generatedAt),
  }
  const issues = validateRepositoryDomainSummaryAgentPlan({ plan, repositoryZones, staticProgramGraph, nodeSemanticCatalog })
  if (issues.length) throw new Error(`Generated invalid Repository Domain Summary Agent Plan:\n- ${issues.join('\n- ')}`)
  return plan
}

export function validateRepositoryDomainSummaryAgentPlan({ plan, repositoryZones, staticProgramGraph, nodeSemanticCatalog } = {}) {
  const issues = []
  if (plan?.schemaVersion !== REPOSITORY_DOMAIN_SUMMARY_AGENT_PLAN_SCHEMA) issues.push(`schemaVersion must be ${REPOSITORY_DOMAIN_SUMMARY_AGENT_PLAN_SCHEMA}`)
  if (!plan?.planId) issues.push('planId is required')
  if (plan?.graphId !== staticProgramGraph?.graphId) issues.push('graphId must match Static Program Graph')
  if (plan?.snapshotId !== staticProgramGraph?.snapshotId) issues.push('snapshotId must match Static Program Graph')
  if (plan?.semanticCatalogHash !== repositoryZoneCatalogHash(nodeSemanticCatalog)) issues.push('semanticCatalogHash must match accepted Node Semantics')
  if (plan?.zonePlanId !== repositoryZones?.zonePlanId) issues.push('zonePlanId must match reviewed Repository Zones')
  if (plan?.zoneCatalogHash !== repositoryZoneCatalogHash(repositoryZones)) issues.push('zoneCatalogHash must match reviewed Repository Zones')
  if (!sameStrings(plan?.allowedZoneIds, array(repositoryZones?.zones).map(zone => zone.zoneId))) issues.push('allowedZoneIds must cover every reviewed zone exactly once')
  if (plan?.constraints?.authority !== 'agent-only') issues.push('constraints.authority must be agent-only')
  if (plan?.constraints?.coverage !== 'all-reviewed-zones-exactly-once') issues.push('constraints.coverage is invalid')
  if (plan?.constraints?.classification !== 'reuse-reviewed-zone-membership') issues.push('constraints.classification must preserve S7 memberships')
  if (plan?.constraints?.evidence !== 'accepted-semantics-and-static-graph') issues.push('constraints.evidence is invalid')
  for (const key of ['maxEntriesPerZone', 'maxCoreFilesPerZone', 'maxBoundaryFilesPerZone']) {
    if (!Number.isInteger(plan?.constraints?.[key]) || plan.constraints[key] < 1) issues.push(`constraints.${key} must be a positive integer`)
  }
  for (const key of Object.keys(DEFAULT_REFS)) if (!safeArtifactRef(plan?.artifactRefs?.[key])) issues.push(`artifactRefs.${key} must be a safe relative path`)
  if (plan?.summaries !== undefined) issues.push('Agent plan must not contain summaries')
  const expectedCore = {
    graphId: plan?.graphId,
    snapshotId: plan?.snapshotId,
    semanticCatalogHash: plan?.semanticCatalogHash,
    zonePlanId: plan?.zonePlanId,
    zoneCatalogHash: plan?.zoneCatalogHash,
    repoPath: plan?.repoPath,
    allowedZoneIds: array(plan?.allowedZoneIds),
    artifactRefs: plan?.artifactRefs,
    constraints: plan?.constraints,
  }
  if (plan?.planId !== `repository-domain-summary-agent-plan:${shortHash(stableStringify(expectedCore), 24)}`) issues.push('planId is not deterministic for its inputs')
  return uniqueSorted(issues)
}

export function buildRepositoryDomainSummaryAgentContext({ plan, repositoryZones, staticProgramGraph, nodeSemanticCatalog, inventory } = {}) {
  const planIssues = validateRepositoryDomainSummaryAgentPlan({ plan, repositoryZones, staticProgramGraph, nodeSemanticCatalog })
  if (planIssues.length) throw new Error(`Invalid Repository Domain Summary Agent Plan:\n- ${planIssues.join('\n- ')}`)
  const zoneById = new Map(repositoryZones.zones.map(zone => [zone.zoneId, zone]))
  const membershipByPath = new Map(repositoryZones.memberships.map(item => [portable(item.filePath), item]))
  const semanticByPath = new Map(array(nodeSemanticCatalog?.entries).map(entry => [portable(entry.filePath), entry]))
  const inventoryByPath = new Map(array(inventory?.files).map(file => [portable(file.path), file]))
  const fileRelations = aggregateFileRelations(staticProgramGraph, new Set(repositoryZones.memberships.map(item => portable(item.filePath))))
  const boundaryRelations = fileRelations.map(relation => {
    const from = membershipByPath.get(relation.from)
    const to = membershipByPath.get(relation.to)
    if (!from || !to || from.zoneId === to.zoneId) return null
    return {
      fromFilePath: relation.from,
      toFilePath: relation.to,
      fromZoneId: from.zoneId,
      toZoneId: to.zoneId,
      count: relation.count,
      edgeTypes: relation.edgeTypes,
    }
  }).filter(Boolean)
  const zones = repositoryZones.zones.map(zone => {
    const memberPaths = repositoryZones.memberships.filter(item => item.zoneId === zone.zoneId).map(item => portable(item.filePath)).sort()
    const files = memberPaths.map(filePath => {
      const membership = membershipByPath.get(filePath)
      const file = inventoryByPath.get(filePath) || {}
      const semantic = semanticByPath.get(filePath)
      return {
        filePath,
        language: file.language || 'Unknown',
        category: file.category || 'unknown',
        lines: Number(file.lines || 0),
        membership: {
          subzoneId: membership?.subzoneId || null,
          role: membership?.role || '',
          status: membership?.status || 'needs-review',
          confidence: Number(membership?.confidence || 0),
        },
        semantic: semantic ? compactSemantic(semantic) : null,
      }
    })
    const relations = boundaryRelations.filter(item => item.fromZoneId === zone.zoneId || item.toZoneId === zone.zoneId)
      .sort((left, right) => right.count - left.count || left.fromFilePath.localeCompare(right.fromFilePath) || left.toFilePath.localeCompare(right.toFilePath))
    return {
      zoneId: zone.zoneId,
      label: zone.label,
      summary: zone.summary,
      rationale: zone.rationale,
      confidence: zone.confidence,
      evidenceRefs: zone.evidenceRefs,
      subzones: zone.subzones.map(subzone => ({
        subzoneId: subzone.subzoneId,
        label: subzone.label,
        summary: subzone.summary,
        fileCount: subzone.fileCount,
        representativeFilePaths: subzone.representativeFilePaths,
      })),
      files,
      boundaryRelations: relations,
      crossZoneRelations: array(repositoryZones.crossZoneRelations).filter(item => item.fromZoneId === zone.zoneId || item.toZoneId === zone.zoneId),
    }
  })
  return {
    schemaVersion: REPOSITORY_DOMAIN_SUMMARY_AGENT_CONTEXT_SCHEMA,
    planId: plan.planId,
    graphId: plan.graphId,
    snapshotId: plan.snapshotId,
    semanticCatalogHash: plan.semanticCatalogHash,
    zonePlanId: plan.zonePlanId,
    zoneCatalogHash: plan.zoneCatalogHash,
    repo: {
      name: inventory?.repo?.name || path.basename(plan.repoPath),
      path: plan.repoPath,
      branch: inventory?.repo?.git?.branch || null,
      head: inventory?.repo?.git?.head || null,
    },
    summary: {
      zones: zones.length,
      files: repositoryZones.memberships.length,
      semanticFiles: [...semanticByPath.keys()].filter(filePath => membershipByPath.has(filePath)).length,
      boundaryRelations: boundaryRelations.length,
    },
    zones,
    analysisRequirements: [
      'Interpret each reviewed S7 domain as a whole; do not rename domains or change file memberships.',
      'Identify responsibility, entry files, core files, boundary files, outputs, and collaborating domains from accepted S6 semantics and Static Program Graph relations.',
      'Entry and core files must belong to the current zone. Boundary files must cite a concrete cross-zone relation.',
      'A boundary file direction and connectedZoneIds must exactly match every cross-zone relation incident to that file. Every graph evidence ref must use the declared boundary file as an endpoint.',
      'Describe engineering responsibility rather than inventing an end-to-end business journey or user intent.',
      'Keep uncertainty explicit in unknowns. Every positive statement must include grounding evidence from this context.',
    ],
    resultContract: {
      schemaVersion: REPOSITORY_DOMAIN_SUMMARIES_SCHEMA,
      outputRef: plan.artifactRefs.outputRef,
      status: 'draft',
      producerKind: 'agent',
      requiredCoverage: plan.constraints.coverage,
      roleVocabulary: ['entry', 'core', 'boundary'],
    },
    generatedAt: plan.generatedAt,
  }
}

export function validateRepositoryDomainSummaryDraft({ catalog, plan, repositoryZones, staticProgramGraph } = {}) {
  const issues = validateCatalogCore({ catalog, plan, repositoryZones, staticProgramGraph, expectedStatus: 'draft' })
  if (catalog?.review !== undefined) issues.push('draft catalog must not contain review')
  if (catalog?.metrics !== undefined) issues.push('draft catalog must not contain metrics')
  return uniqueSorted(issues)
}

export function validateRepositoryDomainSummaries(value, context = {}) {
  const issues = validateCatalogCore({
    catalog: value,
    plan: context.plan,
    repositoryZones: context.repositoryZones,
    staticProgramGraph: context.staticProgramGraph,
    expectedStatus: 'complete',
  })
  if (value?.review?.status !== 'accepted') issues.push('complete catalog requires an accepted Agent review')
  if (value?.review?.reviewer?.kind !== 'agent') issues.push('complete catalog reviewer must be an Agent')
  if (!value?.metrics || value.metrics.zones !== array(value?.summaries).length) issues.push('complete catalog metrics.zones must match summaries')
  return uniqueSorted(issues)
}

export function repositoryDomainSummaryCatalogHash(catalog) {
  return `sha256:${createHash('sha256').update(JSON.stringify(catalog) ?? 'null').digest('hex')}`
}

export function validateRepositoryDomainSummaryReview({ review, plan, catalog } = {}) {
  const issues = []
  if (review?.schemaVersion !== REPOSITORY_DOMAIN_SUMMARY_REVIEW_SCHEMA) issues.push(`schemaVersion must be ${REPOSITORY_DOMAIN_SUMMARY_REVIEW_SCHEMA}`)
  if (!review?.planId || review.planId !== plan?.planId) issues.push('planId must match the Agent plan')
  if (!review?.snapshotId || review.snapshotId !== plan?.snapshotId) issues.push('snapshotId must match the Agent plan')
  if (review?.catalogHash !== repositoryDomainSummaryCatalogHash(catalog)) issues.push('catalogHash must match the exact reviewed catalog')
  if (!['accepted', 'changes-requested'].includes(review?.status)) issues.push('status must be accepted or changes-requested')
  for (const check of REVIEW_CHECKS) if (typeof review?.checks?.[check] !== 'boolean') issues.push(`checks.${check} must be boolean`)
  if (!Array.isArray(review?.issues)) issues.push('issues must be an array')
  if (review?.reviewer?.kind !== 'agent' || !review?.reviewer?.agentId) issues.push('reviewer must identify an Agent')
  if (review?.reviewer?.agentId && review.reviewer.agentId === catalog?.producer?.agentId) issues.push('reviewer Agent must be independent from producer Agent')
  if (review?.status === 'accepted') {
    for (const check of REVIEW_CHECKS) if (review?.checks?.[check] !== true) issues.push(`accepted review requires checks.${check}=true`)
    if (array(review?.issues).length) issues.push('accepted review must not contain issues')
  }
  return uniqueSorted(issues)
}

export function acceptRepositoryDomainSummaryCatalog({ catalog, review, plan, repositoryZones, staticProgramGraph } = {}) {
  const draftIssues = validateRepositoryDomainSummaryDraft({ catalog, plan, repositoryZones, staticProgramGraph })
  if (draftIssues.length) throw new Error(`Invalid Repository Domain Summary Agent draft:\n- ${draftIssues.join('\n- ')}`)
  const reviewIssues = validateRepositoryDomainSummaryReview({ review, plan, catalog })
  if (reviewIssues.length) throw new Error(`Invalid Repository Domain Summary Agent review:\n- ${reviewIssues.join('\n- ')}`)
  if (review.status !== 'accepted') throw new Error('Repository Domain Summary Agent review requested changes')
  const orderByZone = new Map(repositoryZones.zones.map((zone, index) => [zone.zoneId, index]))
  const summaries = catalog.summaries.slice().sort((left, right) => orderByZone.get(left.zoneId) - orderByZone.get(right.zoneId))
  const finalCore = {
    planId: plan.planId,
    snapshotId: plan.snapshotId,
    graphId: plan.graphId,
    semanticCatalogHash: plan.semanticCatalogHash,
    zonePlanId: plan.zonePlanId,
    zoneCatalogHash: plan.zoneCatalogHash,
    summaries,
  }
  const accepted = {
    schemaVersion: REPOSITORY_DOMAIN_SUMMARIES_SCHEMA,
    summaryCatalogId: `repository-domain-summaries:${shortHash(stableStringify(finalCore), 24)}`,
    ...finalCore,
    status: 'complete',
    producer: catalog.producer,
    review: {
      status: review.status,
      catalogHash: review.catalogHash,
      reviewer: review.reviewer,
      generatedAt: review.generatedAt,
    },
    metrics: {
      zones: summaries.length,
      entryFiles: summaries.reduce((sum, item) => sum + item.entryFiles.length, 0),
      coreFiles: summaries.reduce((sum, item) => sum + item.coreFiles.length, 0),
      boundaryFiles: summaries.reduce((sum, item) => sum + item.boundaryFiles.length, 0),
      collaborations: summaries.reduce((sum, item) => sum + item.collaboratingDomains.length, 0),
      unknowns: summaries.reduce((sum, item) => sum + item.unknowns.length, 0),
    },
    generatedAt: catalog.generatedAt,
  }
  const issues = validateRepositoryDomainSummaries(accepted, { plan, repositoryZones, staticProgramGraph })
  if (issues.length) throw new Error(`Accepted Repository Domain Summaries are invalid:\n- ${issues.join('\n- ')}`)
  return accepted
}

export function writeRepositoryDomainSummaryAgentPlan({ packageDir, plan, repositoryZones, staticProgramGraph, nodeSemanticCatalog, outputPath = 'planning/repository-domain-summary-agent-plan.json' } = {}) {
  const issues = validateRepositoryDomainSummaryAgentPlan({ plan, repositoryZones, staticProgramGraph, nodeSemanticCatalog })
  if (issues.length) throw new Error(`Repository Domain Summary Agent Plan is invalid:\n- ${issues.join('\n- ')}`)
  return writeJsonAtomic(packageDir, outputPath, plan)
}

export function writeRepositoryDomainSummaryAgentContext({ packageDir, context, outputPath = DEFAULT_REFS.contextRef } = {}) {
  if (context?.schemaVersion !== REPOSITORY_DOMAIN_SUMMARY_AGENT_CONTEXT_SCHEMA) throw new Error(`context schemaVersion must be ${REPOSITORY_DOMAIN_SUMMARY_AGENT_CONTEXT_SCHEMA}`)
  return writeJsonAtomic(packageDir, outputPath, context)
}

export function writeRepositoryDomainSummaries({ packageDir, summaries, plan, repositoryZones, staticProgramGraph, outputPath = DEFAULT_REFS.finalRef } = {}) {
  const issues = validateRepositoryDomainSummaries(summaries, { plan, repositoryZones, staticProgramGraph })
  if (issues.length) throw new Error(`Repository Domain Summaries are invalid:\n- ${issues.join('\n- ')}`)
  return writeJsonAtomic(packageDir, outputPath, summaries)
}

export function repositoryDomainSummaryReviewChecks() {
  return [...REVIEW_CHECKS]
}

function validateCatalogCore({ catalog, plan, repositoryZones, staticProgramGraph, expectedStatus }) {
  const issues = []
  if (catalog?.schemaVersion !== REPOSITORY_DOMAIN_SUMMARIES_SCHEMA) issues.push(`schemaVersion must be ${REPOSITORY_DOMAIN_SUMMARIES_SCHEMA}`)
  if (!catalog?.summaryCatalogId) issues.push('summaryCatalogId is required')
  if (catalog?.planId !== plan?.planId) issues.push('planId must match Repository Domain Summary Agent Plan')
  if (catalog?.snapshotId !== plan?.snapshotId) issues.push('snapshotId must match Repository Domain Summary Agent Plan')
  if (catalog?.graphId !== staticProgramGraph?.graphId) issues.push('graphId must match Static Program Graph')
  if (catalog?.semanticCatalogHash !== plan?.semanticCatalogHash) issues.push('semanticCatalogHash must match Agent plan')
  if (catalog?.zonePlanId !== repositoryZones?.zonePlanId) issues.push('zonePlanId must match reviewed Repository Zones')
  if (catalog?.zoneCatalogHash !== plan?.zoneCatalogHash) issues.push('zoneCatalogHash must match Agent plan')
  if (catalog?.status !== expectedStatus) issues.push(`status must be ${expectedStatus}`)
  if (catalog?.producer?.kind !== 'agent' || !catalog?.producer?.agentId) issues.push('producer must identify the domain-interpretation Agent')
  if (!Array.isArray(catalog?.summaries)) issues.push('summaries must be an array')
  const zoneById = new Map(array(repositoryZones?.zones).map(zone => [zone.zoneId, zone]))
  const membershipByPath = new Map(array(repositoryZones?.memberships).map(item => [portable(item.filePath), item]))
  const graphRelations = aggregateFileRelations(staticProgramGraph, new Set(membershipByPath.keys()))
  const relationKeys = new Set(graphRelations.map(item => `${item.from}\u0000${item.to}`))
  const seenZones = new Set()
  for (const [index, summary] of array(catalog?.summaries).entries()) {
    const pointer = `summaries[${index}]`
    const zone = zoneById.get(summary?.zoneId)
    if (!zone) issues.push(`${pointer}.zoneId references an unknown reviewed zone`)
    if (seenZones.has(summary?.zoneId)) issues.push(`${pointer}.zoneId is duplicated`)
    seenZones.add(summary?.zoneId)
    if (zone && summary?.label !== zone.label) issues.push(`${pointer}.label must preserve the reviewed S7 title`)
    if (!textValue(summary?.responsibility?.summary)) issues.push(`${pointer}.responsibility.summary is required`)
    validateEvidenceRefs(summary?.responsibility?.evidenceRefs, membershipByPath, relationKeys, issues, `${pointer}.responsibility.evidenceRefs`, true)
    validateFileRoles(summary?.entryFiles, 'entryFiles', summary?.zoneId, membershipByPath, relationKeys, plan?.constraints?.maxEntriesPerZone, issues, pointer)
    validateFileRoles(summary?.coreFiles, 'coreFiles', summary?.zoneId, membershipByPath, relationKeys, plan?.constraints?.maxCoreFilesPerZone, issues, pointer)
    validateBoundaryFiles(summary?.boundaryFiles, summary?.zoneId, zoneById, membershipByPath, graphRelations, relationKeys, plan?.constraints?.maxBoundaryFilesPerZone, issues, pointer)
    validateCollaborations(summary?.collaboratingDomains, summary?.zoneId, zoneById, repositoryZones, membershipByPath, relationKeys, issues, pointer)
    if (!Array.isArray(summary?.outputs)) issues.push(`${pointer}.outputs must be an array`)
    for (const [outputIndex, output] of array(summary?.outputs).entries()) {
      if (!textValue(output?.name) || !textValue(output?.description)) issues.push(`${pointer}.outputs[${outputIndex}] requires name and description`)
      validateEvidenceRefs(output?.evidenceRefs, membershipByPath, relationKeys, issues, `${pointer}.outputs[${outputIndex}].evidenceRefs`, true)
    }
    if (!Array.isArray(summary?.unknowns)) issues.push(`${pointer}.unknowns must be an array`)
    for (const [unknownIndex, unknown] of array(summary?.unknowns).entries()) {
      if (!textValue(unknown?.question) || !textValue(unknown?.reason)) issues.push(`${pointer}.unknowns[${unknownIndex}] requires question and reason`)
      validateEvidenceRefs(unknown?.evidenceRefs, membershipByPath, relationKeys, issues, `${pointer}.unknowns[${unknownIndex}].evidenceRefs`, false)
    }
    if (!confidence(summary?.confidence)) issues.push(`${pointer}.confidence must be between 0 and 1`)
  }
  if (!sameStrings([...seenZones], plan?.allowedZoneIds)) issues.push('summaries must cover every reviewed zone exactly once')
  return issues
}

function validateFileRoles(items, field, zoneId, membershipByPath, relationKeys, maximum, issues, pointer) {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(`${pointer}.${field} must be a non-empty array`)
    return
  }
  if (items.length > maximum) issues.push(`${pointer}.${field} exceeds Agent plan limit`)
  const seen = new Set()
  for (const [index, item] of items.entries()) {
    const filePath = portable(item?.filePath)
    if (seen.has(filePath)) issues.push(`${pointer}.${field}[${index}].filePath is duplicated`)
    seen.add(filePath)
    if (membershipByPath.get(filePath)?.zoneId !== zoneId) issues.push(`${pointer}.${field}[${index}].filePath must belong to the current zone`)
    if (!textValue(item?.reason)) issues.push(`${pointer}.${field}[${index}].reason is required`)
    validateEvidenceRefs(item?.evidenceRefs, membershipByPath, relationKeys, issues, `${pointer}.${field}[${index}].evidenceRefs`, true)
  }
}

function validateBoundaryFiles(items, zoneId, zoneById, membershipByPath, graphRelations, relationKeys, maximum, issues, pointer) {
  if (!Array.isArray(items)) {
    issues.push(`${pointer}.boundaryFiles must be an array`)
    return
  }
  if (items.length > maximum) issues.push(`${pointer}.boundaryFiles exceeds Agent plan limit`)
  const seen = new Set()
  for (const [index, item] of items.entries()) {
    const filePath = portable(item?.filePath)
    if (seen.has(filePath)) issues.push(`${pointer}.boundaryFiles[${index}].filePath is duplicated`)
    seen.add(filePath)
    if (membershipByPath.get(filePath)?.zoneId !== zoneId) issues.push(`${pointer}.boundaryFiles[${index}].filePath must belong to the current zone`)
    if (!['inbound', 'outbound', 'bidirectional'].includes(item?.direction)) issues.push(`${pointer}.boundaryFiles[${index}].direction is invalid`)
    if (!Array.isArray(item?.connectedZoneIds) || item.connectedZoneIds.length === 0) issues.push(`${pointer}.boundaryFiles[${index}].connectedZoneIds must not be empty`)
    for (const connectedZoneId of array(item?.connectedZoneIds)) if (!zoneById.has(connectedZoneId) || connectedZoneId === zoneId) issues.push(`${pointer}.boundaryFiles[${index}] references an invalid connected zone`)
    if (!textValue(item?.reason)) issues.push(`${pointer}.boundaryFiles[${index}].reason is required`)
    validateEvidenceRefs(item?.evidenceRefs, membershipByPath, relationKeys, issues, `${pointer}.boundaryFiles[${index}].evidenceRefs`, true)

    const incidentRelations = array(graphRelations).filter(relation => {
      if (relation.from !== filePath && relation.to !== filePath) return false
      const otherFilePath = relation.from === filePath ? relation.to : relation.from
      const otherZoneId = membershipByPath.get(otherFilePath)?.zoneId
      return Boolean(otherZoneId && otherZoneId !== zoneId)
    })
    const actualConnectedZoneIds = uniqueSorted(incidentRelations.map(relation => {
      const otherFilePath = relation.from === filePath ? relation.to : relation.from
      return membershipByPath.get(otherFilePath)?.zoneId
    }).filter(Boolean))
    if (!actualConnectedZoneIds.length) issues.push(`${pointer}.boundaryFiles[${index}] must participate in a cross-zone graph relation`)
    if (!sameStrings(item?.connectedZoneIds, actualConnectedZoneIds)) issues.push(`${pointer}.boundaryFiles[${index}].connectedZoneIds must exactly match cross-zone relations for the boundary file`)

    const hasOutbound = incidentRelations.some(relation => relation.from === filePath)
    const hasInbound = incidentRelations.some(relation => relation.to === filePath)
    const expectedDirection = hasOutbound && hasInbound ? 'bidirectional' : hasOutbound ? 'outbound' : hasInbound ? 'inbound' : null
    if (expectedDirection && item?.direction !== expectedDirection) issues.push(`${pointer}.boundaryFiles[${index}].direction must be ${expectedDirection} for the boundary file graph relations`)

    const graphEvidenceRefs = array(item?.evidenceRefs).filter(ref => ref?.kind === 'graph')
    if (!graphEvidenceRefs.length) issues.push(`${pointer}.boundaryFiles[${index}].evidenceRefs must contain concrete graph evidence`)
    for (const [evidenceIndex, ref] of graphEvidenceRefs.entries()) {
      const refFilePath = portable(ref?.filePath)
      const relatedFilePath = portable(ref?.relatedFilePath)
      if (refFilePath !== filePath && relatedFilePath !== filePath) {
        issues.push(`${pointer}.boundaryFiles[${index}].evidenceRefs[${evidenceIndex}] must reference the declared boundary file`)
        continue
      }
      const otherFilePath = refFilePath === filePath ? relatedFilePath : refFilePath
      const otherZoneId = membershipByPath.get(otherFilePath)?.zoneId
      if (!otherZoneId || otherZoneId === zoneId || !actualConnectedZoneIds.includes(otherZoneId)) issues.push(`${pointer}.boundaryFiles[${index}].evidenceRefs[${evidenceIndex}] must connect the boundary file to a declared external zone`)
    }
  }
}

function validateCollaborations(items, zoneId, zoneById, repositoryZones, membershipByPath, relationKeys, issues, pointer) {
  if (!Array.isArray(items)) {
    issues.push(`${pointer}.collaboratingDomains must be an array`)
    return
  }
  const relationPairs = new Set(array(repositoryZones?.crossZoneRelations).map(item => `${item.fromZoneId}\u0000${item.toZoneId}`))
  const seen = new Set()
  for (const [index, item] of items.entries()) {
    if (seen.has(item?.zoneId)) issues.push(`${pointer}.collaboratingDomains[${index}].zoneId is duplicated`)
    seen.add(item?.zoneId)
    if (!zoneById.has(item?.zoneId) || item.zoneId === zoneId) issues.push(`${pointer}.collaboratingDomains[${index}].zoneId is invalid`)
    if (!['inbound', 'outbound', 'bidirectional'].includes(item?.direction)) issues.push(`${pointer}.collaboratingDomains[${index}].direction is invalid`)
    if (!Number.isInteger(item?.relationCount) || item.relationCount < 1) issues.push(`${pointer}.collaboratingDomains[${index}].relationCount must be a positive integer`)
    if (!textValue(item?.summary)) issues.push(`${pointer}.collaboratingDomains[${index}].summary is required`)
    const outbound = relationPairs.has(`${zoneId}\u0000${item?.zoneId}`)
    const inbound = relationPairs.has(`${item?.zoneId}\u0000${zoneId}`)
    if (!outbound && !inbound) issues.push(`${pointer}.collaboratingDomains[${index}] has no reviewed cross-zone relation`)
    validateEvidenceRefs(item?.evidenceRefs, membershipByPath, relationKeys, issues, `${pointer}.collaboratingDomains[${index}].evidenceRefs`, true)
  }
}

function validateEvidenceRefs(refs, membershipByPath, relationKeys, issues, pointer, required) {
  if (!Array.isArray(refs) || (required && refs.length === 0)) {
    issues.push(`${pointer} must contain grounding evidence`)
    return
  }
  for (const [index, ref] of refs.entries()) {
    const itemPointer = `${pointer}[${index}]`
    if (!['semantic', 'graph', 'zone'].includes(ref?.kind)) issues.push(`${itemPointer}.kind is invalid`)
    const filePath = portable(ref?.filePath)
    const relatedFilePath = portable(ref?.relatedFilePath)
    if (!membershipByPath.has(filePath)) issues.push(`${itemPointer}.filePath is absent from reviewed zones`)
    if (ref?.relatedFilePath && !membershipByPath.has(relatedFilePath)) issues.push(`${itemPointer}.relatedFilePath is absent from reviewed zones`)
    if (ref?.kind === 'graph' && (!relatedFilePath || !relationKeys.has(`${filePath}\u0000${relatedFilePath}`))) issues.push(`${itemPointer} must reference a concrete directed graph relation`)
    if (ref?.kind === 'semantic' && (!Number.isInteger(ref?.startLine) || !Number.isInteger(ref?.endLine) || ref.startLine < 1 || ref.endLine < ref.startLine)) issues.push(`${itemPointer} semantic evidence requires a valid source range`)
    if (!textValue(ref?.claim)) issues.push(`${itemPointer}.claim is required`)
  }
}

function compactSemantic(entry) {
  return {
    semanticKind: entry.semanticKind || 'other',
    title: entry.title || path.posix.basename(entry.filePath || ''),
    responsibility: entry.responsibility?.summary || '',
    actions: compactSemanticItems(entry.actions),
    outputs: compactSemanticItems(entry.outputs),
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
  const values = [entry?.responsibility, ...array(entry?.actions), ...array(entry?.outputs), ...array(entry?.boundaries), ...array(entry?.collaborators)]
  return uniqueBy(values.flatMap(item => array(item?.evidence)).map(item => ({
    filePath: portable(item.sourcePath),
    startLine: Number(item.startLine || 0),
    endLine: Number(item.endLine || item.startLine || 0),
  })).filter(item => item.filePath), item => `${item.filePath}:${item.startLine}:${item.endLine}`)
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

function assertPlanningInputs({ repositoryZones, staticProgramGraph, nodeSemanticCatalog, repoPath }) {
  if (repositoryZones?.status !== 'complete' || !array(repositoryZones?.zones).length) throw new Error('Reviewed Repository Zones must be complete before S8 planning')
  if (!staticProgramGraph?.graphId || !staticProgramGraph?.snapshotId) throw new Error('Static Program Graph requires graphId and snapshotId')
  if (nodeSemanticCatalog?.status !== 'complete') throw new Error('Node Semantic Catalog must be complete before S8 planning')
  if (array(nodeSemanticCatalog?.entries).some(entry => entry.status !== 'accepted')) throw new Error('Node Semantic Catalog contains non-accepted entries')
  if (!repoPath) throw new Error('repoPath is required')
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

function safeArtifactRef(value) {
  const normalized = portable(value)
  return Boolean(normalized && !path.posix.isAbsolute(normalized) && normalized !== '..' && !normalized.startsWith('../'))
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
