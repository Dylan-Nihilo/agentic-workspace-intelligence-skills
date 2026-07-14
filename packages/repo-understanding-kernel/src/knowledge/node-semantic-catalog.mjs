import fs from 'node:fs'
import path from 'node:path'
import { validateNodeSemanticReview } from './node-semantic-review.mjs'

export const NODE_SEMANTIC_CATALOG_SCHEMA = 'repo-node-semantic-catalog/v1'

export function validateNodeSemanticCatalog({ catalog, staticProgramGraph, inventory } = {}) {
  const issues = []
  if (catalog?.schemaVersion !== NODE_SEMANTIC_CATALOG_SCHEMA) issues.push('schemaVersion must be repo-node-semantic-catalog/v1')
  if (!catalog?.snapshotId) issues.push('snapshotId is required')
  if (staticProgramGraph?.snapshotId && catalog?.snapshotId !== staticProgramGraph.snapshotId) issues.push('catalog snapshotId does not match Static Program Graph')
  if (!['empty', 'partial', 'complete'].includes(catalog?.status)) issues.push('status must be empty, partial, or complete')
  if (!Array.isArray(catalog?.entries)) issues.push('entries must be an array')
  if (!catalog?.generatedAt) issues.push('generatedAt is required')

  const inventoryByPath = new Map((inventory?.files || []).map(file => [portable(file.path), file]))
  const graphEntityPathById = new Map((staticProgramGraph?.nodes || []).map(node => [node.nodeId, portable(node?.source?.sourcePath || node?.attributes?.sourcePath)]))
  const seen = new Set()
  for (const [index, entry] of (catalog?.entries || []).entries()) {
    const pointer = `entries[${index}]`
    const filePath = portable(entry?.filePath)
    if (!filePath) issues.push(`${pointer}.filePath is required`)
    if (seen.has(filePath)) issues.push(`${pointer}.filePath is duplicated: ${filePath}`)
    seen.add(filePath)
    const file = inventoryByPath.get(filePath)
    if (!file) issues.push(`${pointer}.filePath is absent from inventory: ${filePath}`)
    if (file?.protected) issues.push(`${pointer}.filePath is protected: ${filePath}`)
    if (!Array.isArray(entry?.entityIds)) issues.push(`${pointer}.entityIds must be an array`)
    const fileHasGraphEntities = [...graphEntityPathById.values()].some(sourcePath => sourcePath === filePath)
    if (fileHasGraphEntities && entry?.entityIds?.length === 0) issues.push(`${pointer}.entityIds must not be empty when the file has graph entities`)
    for (const entityId of entry?.entityIds || []) {
      if (!graphEntityPathById.has(entityId)) issues.push(`${pointer}.entityIds references an unknown graph entity: ${entityId}`)
      else if (graphEntityPathById.get(entityId) !== filePath) issues.push(`${pointer}.entityIds references an entity from another file: ${entityId}`)
    }

    const scopeFiles = new Set((entry?.scopeFiles || []).map(portable).filter(Boolean))
    if (!scopeFiles.has(filePath)) issues.push(`${pointer}.scopeFiles must include filePath`)
    for (const scopeFile of scopeFiles) if (!inventoryByPath.has(scopeFile)) issues.push(`${pointer}.scopeFiles references an unknown file: ${scopeFile}`)

    if (!entry?.responsibility?.summary) issues.push(`${pointer}.responsibility.summary is required`)
    validateConfidence(issues, `${pointer}.responsibility.confidence`, entry?.responsibility?.confidence)
    if (!Number.isFinite(entry?.confidence) || entry.confidence < 0 || entry.confidence > 1) issues.push(`${pointer}.confidence must be between 0 and 1`)
    if (!['draft', 'accepted', 'blocked'].includes(entry?.status)) issues.push(`${pointer}.status must be draft, accepted, or blocked`)
    if (entry?.producer?.kind !== 'agent' || !entry?.producer?.workItemId) issues.push(`${pointer}.producer must identify an agent WorkItem`)

    validateEvidence(issues, `${pointer}.responsibility`, entry?.responsibility?.evidence, scopeFiles, inventoryByPath)
    for (const field of ['inputs', 'actions', 'state', 'outputs', 'conditions', 'boundaries']) {
      if (!Array.isArray(entry?.[field])) issues.push(`${pointer}.${field} must be an array`)
      for (const [statementIndex, statement] of (entry?.[field] || []).entries()) {
        if (!statement?.name || !statement?.description) issues.push(`${pointer}.${field}[${statementIndex}] requires name and description`)
        validateConfidence(issues, `${pointer}.${field}[${statementIndex}].confidence`, statement?.confidence)
        validateEvidence(issues, `${pointer}.${field}[${statementIndex}]`, statement?.evidence, scopeFiles, inventoryByPath)
      }
    }
    if (!Array.isArray(entry?.collaborators)) issues.push(`${pointer}.collaborators must be an array`)
    for (const [collaboratorIndex, collaborator] of (entry?.collaborators || []).entries()) {
      if (!inventoryByPath.has(portable(collaborator?.filePath))) issues.push(`${pointer}.collaborators[${collaboratorIndex}] references an unknown file: ${collaborator?.filePath}`)
      if (!collaborator?.role) issues.push(`${pointer}.collaborators[${collaboratorIndex}].role is required`)
      validateEvidence(issues, `${pointer}.collaborators[${collaboratorIndex}]`, collaborator?.evidence, scopeFiles, inventoryByPath)
    }
    if (!Array.isArray(entry?.unknowns)) issues.push(`${pointer}.unknowns must be an array`)
  }
  if (catalog?.status === 'empty' && (catalog?.entries || []).length > 0) issues.push('empty catalog cannot contain entries')
  if (catalog?.status === 'complete' && (catalog?.entries || []).some(entry => entry.status !== 'accepted')) issues.push('complete catalog can contain only accepted entries')
  return { valid: issues.length === 0, issues }
}

export function loadNodeSemanticCatalog(packageDir, context = {}) {
  const filePath = path.join(path.resolve(packageDir), 'store', 'node-semantics.json')
  if (!fs.existsSync(filePath)) return { path: filePath, catalog: null, validation: { valid: true, issues: [] } }
  const catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return { path: filePath, catalog, validation: validateNodeSemanticCatalog({ catalog, ...context }) }
}

export function validateNodeSemanticBatchDraft({ catalog, batch, staticProgramGraph, inventory } = {}) {
  const issues = []
  if (!batch?.batchId || !Array.isArray(batch?.primaryFiles) || !Array.isArray(batch?.allowedFiles)) {
    return { valid: false, issues: ['a planned node-semantic batch is required'] }
  }
  const validation = validateNodeSemanticCatalog({ catalog, staticProgramGraph, inventory })
  issues.push(...validation.issues)
  if (catalog?.status !== 'partial') issues.push('worker catalog status must be partial')
  const expectedPaths = uniqueSorted(batch.primaryFiles.map(portable).filter(Boolean))
  const actualPaths = uniqueSorted((catalog?.entries || []).map(entry => portable(entry.filePath)).filter(Boolean))
  if (!sameStrings(expectedPaths, actualPaths)) issues.push('worker catalog must cover every batch primary file exactly once')
  const allowedFiles = new Set(batch.allowedFiles.map(portable).filter(Boolean))
  const graphEntitiesByPath = new Map()
  for (const node of staticProgramGraph?.nodes || []) {
    const sourcePath = portable(node?.source?.sourcePath || node?.attributes?.sourcePath)
    if (!sourcePath || !node?.nodeId) continue
    const entityIds = graphEntitiesByPath.get(sourcePath) || []
    entityIds.push(node.nodeId)
    graphEntitiesByPath.set(sourcePath, entityIds)
  }
  for (const [index, entry] of (catalog?.entries || []).entries()) {
    const pointer = `entries[${index}]`
    if (entry?.status !== 'draft') issues.push(`${pointer}.status must be draft before acceptance`)
    if (entry?.producer?.workItemId !== batch.batchId) issues.push(`${pointer}.producer.workItemId must equal batchId`)
    for (const scopeFile of entry?.scopeFiles || []) if (!allowedFiles.has(portable(scopeFile))) issues.push(`${pointer}.scopeFiles is outside batch.allowedFiles: ${scopeFile}`)
    const expectedEntityIds = new Set(graphEntitiesByPath.get(portable(entry?.filePath)) || [])
    if (expectedEntityIds.size > 0 && (entry?.entityIds || []).length === 0) issues.push(`${pointer}.entityIds must identify at least one graph entity for filePath`)
    for (const entityId of entry?.entityIds || []) if (!expectedEntityIds.has(entityId)) issues.push(`${pointer}.entityIds is outside the file graph entities: ${entityId}`)
  }
  return { valid: issues.length === 0, issues: uniqueSorted(issues) }
}

export function acceptNodeSemanticBatchCatalog({ catalog, review, planId, batch, staticProgramGraph, inventory } = {}) {
  const draftValidation = validateNodeSemanticBatchDraft({ catalog, batch, staticProgramGraph, inventory })
  const issues = [...draftValidation.issues]
  const reviewValidation = validateNodeSemanticReview({ review, planId, batch, catalog })
  issues.push(...reviewValidation.issues.map(message => `review: ${message}`))
  if (review?.status !== 'accepted') issues.push('review.status must be accepted')
  if (issues.length) throw new Error(`Node Semantic Batch Catalog was not accepted:\n${uniqueSorted(issues).join('\n')}`)
  return {
    ...structuredClone(catalog),
    entries: catalog.entries.map(entry => ({ ...entry, status: 'accepted' })),
  }
}

export function mergeNodeSemanticCatalogs({ catalogs = [], snapshotId, expectedFilePaths = [], generatedAt = new Date().toISOString() } = {}) {
  if (!snapshotId) throw new Error('mergeNodeSemanticCatalogs requires snapshotId')
  const entriesByPath = new Map()
  for (const catalog of catalogs) {
    if (catalog?.schemaVersion !== NODE_SEMANTIC_CATALOG_SCHEMA) throw new Error('Cannot merge a non-v1 node semantic catalog')
    if (catalog.snapshotId !== snapshotId) throw new Error('Cannot merge node semantic catalogs from different snapshots')
    for (const entry of catalog.entries || []) {
      const filePath = portable(entry.filePath)
      const existing = entriesByPath.get(filePath)
      if (!existing || semanticStatusRank(entry.status) > semanticStatusRank(existing.status)) entriesByPath.set(filePath, entry)
      else if (semanticStatusRank(entry.status) === semanticStatusRank(existing.status) && JSON.stringify(entry) !== JSON.stringify(existing)) {
        throw new Error(`Conflicting node semantic entries for ${filePath}`)
      }
    }
  }
  const entries = [...entriesByPath.values()].sort((left, right) => left.filePath.localeCompare(right.filePath))
  const expected = [...new Set(expectedFilePaths.map(portable).filter(Boolean))]
  const accepted = new Set(entries.filter(entry => entry.status === 'accepted').map(entry => portable(entry.filePath)))
  return {
    schemaVersion: NODE_SEMANTIC_CATALOG_SCHEMA,
    snapshotId,
    status: expected.length > 0 && expected.every(filePath => accepted.has(filePath)) ? 'complete' : entries.length ? 'partial' : 'empty',
    entries,
    generatedAt,
  }
}

export function writeNodeSemanticCatalog({ packageDir, catalog, staticProgramGraph, inventory } = {}) {
  if (!packageDir) throw new Error('writeNodeSemanticCatalog requires packageDir')
  const validation = validateNodeSemanticCatalog({ catalog, staticProgramGraph, inventory })
  if (!validation.valid) throw new Error(`Invalid Node Semantic Catalog:\n${validation.issues.join('\n')}`)
  const filePath = path.join(path.resolve(packageDir), 'store', 'node-semantics.json')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, filePath)
  return { path: filePath, catalog, validation }
}

function validateEvidence(issues, pointer, evidence, scopeFiles, inventoryByPath) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    issues.push(`${pointer}.evidence must not be empty`)
    return
  }
  for (const [index, range] of evidence.entries()) {
    const sourcePath = portable(range?.sourcePath)
    const file = inventoryByPath.get(sourcePath)
    if (!scopeFiles.has(sourcePath)) issues.push(`${pointer}.evidence[${index}] is outside scopeFiles: ${sourcePath}`)
    if (!file) {
      issues.push(`${pointer}.evidence[${index}] references an unknown file: ${sourcePath}`)
      continue
    }
    if (!Number.isInteger(range?.startLine) || !Number.isInteger(range?.endLine) || range.startLine < 1 || range.endLine < range.startLine) {
      issues.push(`${pointer}.evidence[${index}] has an invalid line range`)
      continue
    }
    if (Number.isInteger(file.lines) && file.lines > 0 && range.endLine > file.lines) issues.push(`${pointer}.evidence[${index}] exceeds ${sourcePath} line count`)
  }
}

function validateConfidence(issues, pointer, value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) issues.push(`${pointer} must be between 0 and 1`)
}

function semanticStatusRank(status) {
  return { blocked: 0, draft: 1, accepted: 2 }[status] ?? -1
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right), 'en'))
}

function sameStrings(left, right) {
  const normalizedLeft = uniqueSorted(Array.isArray(left) ? left : [])
  const normalizedRight = uniqueSorted(Array.isArray(right) ? right : [])
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index])
}

function portable(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//, '') : null
}
