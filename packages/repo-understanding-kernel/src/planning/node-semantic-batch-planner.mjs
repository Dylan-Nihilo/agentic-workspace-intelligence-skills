import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const NODE_SEMANTIC_BATCH_PLAN_SCHEMA = 'repo-node-semantic-batch-plan/v1'

const CODE_EXTENSIONS = Object.freeze([
  '.cjs',
  '.cts',
  '.htm',
  '.html',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
  '.vue',
])
const CODE_EXTENSION_SET = new Set(CODE_EXTENSIONS)

/**
 * Build deterministic, bounded file batches for node-level semantic Agents.
 * Inventory defines the complete eligible file set. The Static Program Graph
 * enriches that set with entities and direct cross-file relations, but does not
 * decide whether an otherwise analyzable HTML/Vue/JS/TS file is omitted.
 */
export function buildNodeSemanticBatchPlan({
  inventory,
  staticProgramGraph,
  communityMap = null,
  neighborMap = null,
  repoPath,
  maxFilesPerBatch = 8,
  maxSourceBytesPerBatch = 256000,
  outputBaseRef = 'research/node-semantics',
} = {}) {
  assertPlannerInputs({ inventory, staticProgramGraph, communityMap, neighborMap, repoPath })
  const limits = {
    maxFiles: positiveInteger(maxFilesPerBatch, 'maxFilesPerBatch'),
    maxSourceBytes: positiveInteger(maxSourceBytesPerBatch, 'maxSourceBytesPerBatch'),
  }
  const root = path.resolve(repoPath)
  const normalizedOutputBaseRef = normalizeOutputBaseRef(outputBaseRef)
  const graphFileByPath = new Map(array(staticProgramGraph.files).map(file => [portable(file.sourcePath), file]))
  const nodesByPath = groupBySourcePath(staticProgramGraph.nodes)
  const nodeById = new Map(array(staticProgramGraph.nodes).map(node => [node.nodeId, node]))
  const primaryCommunityByPath = indexPrimaryCommunities(communityMap)
  const communityOrdinalById = new Map(array(communityMap?.communities).map(item => [item.communityId, item.ordinal]))
  const communityByNode = new Map(array(communityMap?.membership).map(item => [item.nodeId, item.communityId]))
  const neighborEdgeById = new Map(array(neighborMap?.edges).map(edge => [edge.edgeId, edge]))

  const fingerprints = eligibleInventoryFiles(inventory)
    .map(file => fingerprintSource({ root, file, graphFile: graphFileByPath.get(portable(file.path)) }))
    .sort((left, right) => comparePlannedFiles(left, right, primaryCommunityByPath, communityOrdinalById))

  for (const fingerprint of fingerprints) {
    if (fingerprint.sourceBytes > limits.maxSourceBytes) {
      throw new Error(`${fingerprint.filePath} is ${fingerprint.sourceBytes} bytes and exceeds maxSourceBytesPerBatch (${limits.maxSourceBytes})`)
    }
  }

  const primaryGroups = packPrimaryFiles(fingerprints, limits)
  const batches = primaryGroups.map((primaryFingerprints, index) => {
    const ordinal = index + 1
    const sourceFingerprints = [...primaryFingerprints].sort(compareFingerprintPaths)
    const primaryFiles = sourceFingerprints.map(item => item.filePath)
    const allowedFiles = [...primaryFiles]
    const allowedSet = new Set(allowedFiles)
    const entityIds = uniqueSorted(allowedFiles.flatMap(filePath => array(nodesByPath.get(filePath)).map(node => node.nodeId)))
    const communityIds = uniqueSorted(entityIds.map(entityId => communityByNode.get(entityId)).filter(Boolean))
    const graphNeighborContext = buildGraphNeighborContext({
      staticProgramGraph,
      nodeById,
      allowedSet,
      communityByNode,
      neighborEdgeById,
    })
    const sourceBytes = sourceFingerprints.reduce((sum, item) => sum + item.sourceBytes, 0)
    const batchId = expectedBatchId({
      snapshotId: staticProgramGraph.snapshotId,
      ordinal,
      primaryFiles,
      allowedFiles,
      sourceFingerprints,
    })
    return {
      batchId,
      ordinal,
      primaryFiles,
      allowedFiles,
      entityIds,
      communityIds,
      graphNeighborContext,
      sourceFingerprints,
      sourceBytes,
      outputRef: expectedOutputRef(normalizedOutputBaseRef, ordinal),
    }
  })

  const plan = {
    schemaVersion: NODE_SEMANTIC_BATCH_PLAN_SCHEMA,
    planId: expectedPlanId({
      graphId: staticProgramGraph.graphId,
      snapshotId: staticProgramGraph.snapshotId,
      limits,
      batchIds: batches.map(batch => batch.batchId),
    }),
    graphId: staticProgramGraph.graphId,
    snapshotId: staticProgramGraph.snapshotId,
    repoPath: root,
    outputBaseRef: normalizedOutputBaseRef,
    ordering: communityMap ? 'community-ordinal-then-source-path' : 'source-path',
    limits,
    eligibleExtensions: [...CODE_EXTENSIONS],
    eligibleFileCount: fingerprints.length,
    eligibleSourceBytes: fingerprints.reduce((sum, item) => sum + item.sourceBytes, 0),
    batchCount: batches.length,
    batches,
  }
  const validation = validateNodeSemanticBatchPlan({ plan, inventory, staticProgramGraph, repoPath: root })
  if (!validation.valid) throw new Error(`Generated invalid Node Semantic Batch Plan:\n- ${validation.issues.join('\n- ')}`)
  return plan
}

export function validateNodeSemanticBatchPlan({ plan, inventory, staticProgramGraph, repoPath } = {}) {
  const issues = []
  if (plan?.schemaVersion !== NODE_SEMANTIC_BATCH_PLAN_SCHEMA) issues.push(`schemaVersion must be ${NODE_SEMANTIC_BATCH_PLAN_SCHEMA}`)
  if (!plan?.planId) issues.push('planId is required')
  if (!plan?.graphId) issues.push('graphId is required')
  if (!plan?.snapshotId) issues.push('snapshotId is required')
  if (!plan?.repoPath) issues.push('repoPath is required')
  if (!plan?.outputBaseRef) issues.push('outputBaseRef is required')
  if (!['source-path', 'community-ordinal-then-source-path'].includes(plan?.ordering)) issues.push('ordering is invalid')
  if (!sameExactStrings(plan?.eligibleExtensions, CODE_EXTENSIONS)) issues.push('eligibleExtensions must equal the supported code extension set')
  if (!Number.isInteger(plan?.limits?.maxFiles) || plan.limits.maxFiles < 1) issues.push('limits.maxFiles must be a positive integer')
  if (!Number.isInteger(plan?.limits?.maxSourceBytes) || plan.limits.maxSourceBytes < 1) issues.push('limits.maxSourceBytes must be a positive integer')
  if (!Array.isArray(plan?.batches)) issues.push('batches must be an array')
  if (staticProgramGraph?.graphId && plan?.graphId !== staticProgramGraph.graphId) issues.push('graphId does not match Static Program Graph')
  if (staticProgramGraph?.snapshotId && plan?.snapshotId !== staticProgramGraph.snapshotId) issues.push('snapshotId does not match Static Program Graph')

  const inventoryByPath = new Map(array(inventory?.files).map(file => [portable(file.path), file]))
  const eligibleFiles = inventory ? eligibleInventoryFiles(inventory) : []
  const eligiblePaths = uniqueSorted(eligibleFiles.map(file => portable(file.path)))
  const graphFileByPath = new Map(array(staticProgramGraph?.files).map(file => [portable(file.sourcePath), file]))
  const nodesByPath = groupBySourcePath(staticProgramGraph?.nodes)
  const graphNodeIds = new Set(array(staticProgramGraph?.nodes).map(node => node.nodeId))
  const edgeById = new Map(array(staticProgramGraph?.edges).map(edge => [edge.edgeId, edge]))
  const seenPrimary = new Set()
  const seenBatchIds = new Set()
  const seenOutputRefs = new Set()
  const batches = array(plan?.batches)
  const sourceRoot = path.resolve(repoPath || plan?.repoPath || '.')

  for (const [index, batch] of batches.entries()) {
    const pointer = `batches[${index}]`
    if (batch?.ordinal !== index + 1) issues.push(`${pointer}.ordinal must be ${index + 1}`)
    if (!batch?.batchId) issues.push(`${pointer}.batchId is required`)
    if (seenBatchIds.has(batch?.batchId)) issues.push(`${pointer}.batchId is duplicated: ${batch?.batchId}`)
    seenBatchIds.add(batch?.batchId)
    if (!Array.isArray(batch?.primaryFiles) || batch.primaryFiles.length === 0) issues.push(`${pointer}.primaryFiles must not be empty`)
    if (!Array.isArray(batch?.allowedFiles) || batch.allowedFiles.length === 0) issues.push(`${pointer}.allowedFiles must not be empty`)
    requireSortedUnique(issues, `${pointer}.primaryFiles`, batch?.primaryFiles)
    requireSortedUnique(issues, `${pointer}.allowedFiles`, batch?.allowedFiles)
    requireSortedUnique(issues, `${pointer}.entityIds`, batch?.entityIds)
    requireSortedUnique(issues, `${pointer}.communityIds`, batch?.communityIds)
    const allowedSet = new Set(array(batch?.allowedFiles).map(portable))
    for (const filePath of array(batch?.primaryFiles).map(portable)) {
      if (!allowedSet.has(filePath)) issues.push(`${pointer}.allowedFiles must include primary file: ${filePath}`)
      if (!inventoryByPath.has(filePath)) issues.push(`${pointer}.primaryFiles is absent from inventory: ${filePath}`)
      if (seenPrimary.has(filePath)) issues.push(`${pointer}.primaryFiles is duplicated across batches: ${filePath}`)
      seenPrimary.add(filePath)
    }
    if (array(batch?.allowedFiles).length > (plan?.limits?.maxFiles ?? 0)) issues.push(`${pointer} exceeds limits.maxFiles`)
    if (!Number.isInteger(batch?.sourceBytes) || batch.sourceBytes < 0) issues.push(`${pointer}.sourceBytes must be a non-negative integer`)
    if (batch?.sourceBytes > (plan?.limits?.maxSourceBytes ?? 0)) issues.push(`${pointer} exceeds limits.maxSourceBytes`)

    const fingerprints = array(batch?.sourceFingerprints)
    requireSortedUnique(issues, `${pointer}.sourceFingerprints file paths`, fingerprints.map(item => item?.filePath))
    if (!sameStrings(fingerprints.map(item => item?.filePath), batch?.allowedFiles)) issues.push(`${pointer}.sourceFingerprints must cover allowedFiles exactly`)
    let measuredBytes = 0
    for (const [fingerprintIndex, fingerprint] of fingerprints.entries()) {
      const fingerprintPointer = `${pointer}.sourceFingerprints[${fingerprintIndex}]`
      const filePath = portable(fingerprint?.filePath)
      if (!inventoryByPath.has(filePath)) issues.push(`${fingerprintPointer}.filePath is absent from inventory: ${filePath}`)
      if (!Number.isInteger(fingerprint?.sourceBytes) || fingerprint.sourceBytes < 0) issues.push(`${fingerprintPointer}.sourceBytes must be a non-negative integer`)
      measuredBytes += Number.isInteger(fingerprint?.sourceBytes) ? fingerprint.sourceBytes : 0
      if (!/^content:sha256:[a-f0-9]{64}$/.test(fingerprint?.contentFingerprint || '')) issues.push(`${fingerprintPointer}.contentFingerprint is invalid`)
      const graphFile = graphFileByPath.get(filePath)
      if ((fingerprint?.staticContentHash ?? null) !== (graphFile?.contentHash ?? null)) issues.push(`${fingerprintPointer}.staticContentHash does not match Static Program Graph`)
      if ((fingerprint?.structureFingerprint ?? null) !== (graphFile?.structureFingerprint ?? null)) issues.push(`${fingerprintPointer}.structureFingerprint does not match Static Program Graph`)
      if (fingerprint?.parseStatus !== (graphFile?.parseStatus || 'not-indexed')) issues.push(`${fingerprintPointer}.parseStatus does not match Static Program Graph`)
      const fullPath = resolveSourcePath(sourceRoot, filePath, issues, fingerprintPointer)
      if (fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const content = fs.readFileSync(fullPath)
        if (content.length !== fingerprint?.sourceBytes) issues.push(`${fingerprintPointer}.sourceBytes does not match source`)
        if (`content:sha256:${digest('sha256', content)}` !== fingerprint?.contentFingerprint) issues.push(`${fingerprintPointer}.contentFingerprint does not match source`)
      } else if (fullPath) {
        issues.push(`${fingerprintPointer}.filePath does not exist: ${filePath}`)
      }
    }
    if (measuredBytes !== batch?.sourceBytes) issues.push(`${pointer}.sourceBytes does not equal sourceFingerprints total`)

    const expectedEntityIds = uniqueSorted(array(batch?.allowedFiles).flatMap(filePath => array(nodesByPath.get(portable(filePath))).map(node => node.nodeId)))
    if (!sameStrings(batch?.entityIds, expectedEntityIds)) issues.push(`${pointer}.entityIds must equal graph entities for allowedFiles`)
    for (const entityId of array(batch?.entityIds)) if (!graphNodeIds.has(entityId)) issues.push(`${pointer}.entityIds references an unknown graph entity: ${entityId}`)
    const graphNeighborContext = array(batch?.graphNeighborContext)
    requireSortedUnique(issues, `${pointer}.graphNeighborContext edge IDs`, graphNeighborContext.map(item => item?.edgeId))
    for (const [contextIndex, context] of graphNeighborContext.entries()) {
      const contextPointer = `${pointer}.graphNeighborContext[${contextIndex}]`
      const edge = edgeById.get(context?.edgeId)
      if (!edge) issues.push(`${contextPointer}.edgeId references an unknown graph edge: ${context?.edgeId}`)
      if (edge && (context.fromEntityId !== edge.from || context.toEntityId !== edge.to || context.type !== edge.type)) issues.push(`${contextPointer} does not match Static Program Graph edge`)
      if (!allowedSet.has(portable(context?.fromFile)) || !allowedSet.has(portable(context?.toFile))) issues.push(`${contextPointer} references a file outside allowedFiles`)
      if (portable(context?.fromFile) === portable(context?.toFile)) issues.push(`${contextPointer} must connect distinct source files`)
    }
    if (seenOutputRefs.has(batch?.outputRef)) issues.push(`${pointer}.outputRef is duplicated: ${batch?.outputRef}`)
    seenOutputRefs.add(batch?.outputRef)
    if (batch?.outputRef !== expectedOutputRef(plan?.outputBaseRef, index + 1)) issues.push(`${pointer}.outputRef is not canonical`)
    const expectedId = expectedBatchId({
      snapshotId: plan?.snapshotId,
      ordinal: index + 1,
      primaryFiles: array(batch?.primaryFiles),
      allowedFiles: array(batch?.allowedFiles),
      sourceFingerprints: fingerprints,
    })
    if (batch?.batchId !== expectedId) issues.push(`${pointer}.batchId is not deterministic for its content`)
  }

  if (inventory && !sameStrings([...seenPrimary], eligiblePaths)) issues.push('primaryFiles must cover every eligible inventory code file exactly once')
  if (plan?.eligibleFileCount !== eligiblePaths.length) issues.push('eligibleFileCount does not match inventory')
  const totalBytes = batches.reduce((sum, batch) => sum + (Number.isInteger(batch?.sourceBytes) ? batch.sourceBytes : 0), 0)
  if (plan?.eligibleSourceBytes !== totalBytes) issues.push('eligibleSourceBytes does not match batch source bytes')
  if (plan?.batchCount !== batches.length) issues.push('batchCount does not match batches.length')
  const expectedId = expectedPlanId({
    graphId: plan?.graphId,
    snapshotId: plan?.snapshotId,
    limits: plan?.limits,
    batchIds: batches.map(batch => batch?.batchId),
  })
  if (plan?.planId !== expectedId) issues.push('planId is not deterministic for its content')
  forbidResearchPromptFields(plan, issues)
  return { valid: issues.length === 0, issues: uniqueSorted(issues) }
}

export function writeNodeSemanticBatchPlan({
  packageDir,
  plan,
  inventory,
  staticProgramGraph,
  outputPath = 'planning/node-semantic-batches.json',
} = {}) {
  if (!packageDir) throw new Error('writeNodeSemanticBatchPlan requires packageDir')
  const validation = validateNodeSemanticBatchPlan({ plan, inventory, staticProgramGraph, repoPath: plan?.repoPath })
  if (!validation.valid) throw new Error(`Invalid Node Semantic Batch Plan:\n- ${validation.issues.join('\n- ')}`)
  const target = path.resolve(packageDir, outputPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, target)
  return { path: target, plan, validation }
}

export function isNodeSemanticEligibleFile(file = {}) {
  const filePath = portable(file.path)
  if (!filePath || !isSafeRelativePath(filePath)) return false
  if (!CODE_EXTENSION_SET.has(path.posix.extname(filePath).toLowerCase())) return false
  if (file.binary || file.protected || file.contentAnalyzable === false) return false
  if (file.category === 'resource' || file.category === 'docs') return false
  return true
}

function assertPlannerInputs({ inventory, staticProgramGraph, communityMap, neighborMap, repoPath }) {
  if (inventory?.schemaVersion !== 'repo-inventory/v1') throw new Error('inventory must be repo-inventory/v1')
  if (staticProgramGraph?.schemaVersion !== 'repo-static-program-graph/v1') throw new Error('staticProgramGraph must be repo-static-program-graph/v1')
  if (!staticProgramGraph.graphId || !staticProgramGraph.snapshotId) throw new Error('staticProgramGraph requires graphId and snapshotId')
  if (!repoPath) throw new Error('repoPath is required')
  const root = path.resolve(repoPath)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`repoPath is not a directory: ${root}`)
  if (communityMap) {
    if (communityMap.schemaVersion !== 'repo-community-map/v1') throw new Error('communityMap must be repo-community-map/v1')
    if (communityMap.graphId !== staticProgramGraph.graphId || communityMap.snapshotId !== staticProgramGraph.snapshotId) throw new Error('communityMap does not match Static Program Graph')
  }
  if (neighborMap) {
    if (neighborMap.schemaVersion !== 'repo-neighbor-map/v1') throw new Error('neighborMap must be repo-neighbor-map/v1')
    if (neighborMap.graphId !== staticProgramGraph.graphId || neighborMap.snapshotId !== staticProgramGraph.snapshotId) throw new Error('neighborMap does not match Static Program Graph')
    if (communityMap && neighborMap.communityMapId !== communityMap.communityMapId) throw new Error('neighborMap does not match Community Map')
  }
}

function eligibleInventoryFiles(inventory) {
  const result = []
  const seen = new Set()
  for (const file of array(inventory?.files)) {
    if (!isNodeSemanticEligibleFile(file)) continue
    const filePath = portable(file.path)
    if (seen.has(filePath)) throw new Error(`inventory contains duplicate eligible path: ${filePath}`)
    seen.add(filePath)
    result.push({ ...file, path: filePath })
  }
  return result
}

function fingerprintSource({ root, file, graphFile }) {
  const filePath = portable(file.path)
  const fullPath = resolveSourcePathOrThrow(root, filePath)
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) throw new Error(`eligible source file does not exist: ${filePath}`)
  const content = fs.readFileSync(fullPath)
  if (Number.isInteger(file.size) && file.size !== content.length) throw new Error(`inventory size is stale for ${filePath}: expected ${file.size}, found ${content.length}`)
  assertInventoryHash(file, content)
  return {
    filePath,
    sourceBytes: content.length,
    contentFingerprint: `content:sha256:${digest('sha256', content)}`,
    inventoryContentHash: typeof file.hash === 'string' && file.hash.length ? file.hash : null,
    staticContentHash: graphFile?.contentHash ?? null,
    structureFingerprint: graphFile?.structureFingerprint ?? null,
    parseStatus: graphFile?.parseStatus || 'not-indexed',
  }
}

function assertInventoryHash(file, content) {
  if (file.hashKind !== 'content' || typeof file.hash !== 'string') return
  const algorithm = file.hash.length === 40 ? 'sha1' : file.hash.length === 64 ? 'sha256' : null
  if (algorithm && digest(algorithm, content) !== file.hash) throw new Error(`inventory content hash is stale for ${portable(file.path)}`)
}

function packPrimaryFiles(fingerprints, limits) {
  const groups = []
  let current = []
  let currentBytes = 0
  for (const fingerprint of fingerprints) {
    const exceedsFiles = current.length >= limits.maxFiles
    const exceedsBytes = current.length > 0 && currentBytes + fingerprint.sourceBytes > limits.maxSourceBytes
    if (exceedsFiles || exceedsBytes) {
      groups.push(current)
      current = []
      currentBytes = 0
    }
    current.push(fingerprint)
    currentBytes += fingerprint.sourceBytes
  }
  if (current.length) groups.push(current)
  return groups
}

function buildGraphNeighborContext({ staticProgramGraph, nodeById, allowedSet, communityByNode, neighborEdgeById }) {
  return array(staticProgramGraph.edges).flatMap(edge => {
    const fromFile = portable(nodeById.get(edge.from)?.source?.sourcePath)
    const toFile = portable(nodeById.get(edge.to)?.source?.sourcePath)
    if (!fromFile || !toFile || fromFile === toFile || !allowedSet.has(fromFile) || !allowedSet.has(toFile)) return []
    const neighborEdge = neighborEdgeById.get(edge.edgeId)
    return [{
      edgeId: edge.edgeId,
      type: edge.type,
      fromEntityId: edge.from,
      toEntityId: edge.to,
      fromFile,
      toFile,
      fromCommunityId: neighborEdge?.fromCommunityId || communityByNode.get(edge.from) || null,
      toCommunityId: neighborEdge?.toCommunityId || communityByNode.get(edge.to) || null,
      crossCommunity: neighborEdge?.crossCommunity ?? ((communityByNode.get(edge.from) || null) !== (communityByNode.get(edge.to) || null)),
      sourcePath: portable(edge.source?.sourcePath),
      sourceLine: Number.isInteger(edge.source?.line) ? edge.source.line : null,
    }]
  }).sort((left, right) => compareText(left.edgeId, right.edgeId))
}

function indexPrimaryCommunities(communityMap) {
  const countsByPath = new Map()
  for (const membership of array(communityMap?.membership)) {
    const filePath = portable(membership.sourcePath)
    if (!filePath || !membership.communityId) continue
    const counts = countsByPath.get(filePath) || new Map()
    counts.set(membership.communityId, (counts.get(membership.communityId) || 0) + 1)
    countsByPath.set(filePath, counts)
  }
  const result = new Map()
  for (const [filePath, counts] of countsByPath) {
    const [primary] = [...counts.entries()].sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    if (primary) result.set(filePath, primary[0])
  }
  return result
}

function comparePlannedFiles(left, right, primaryCommunityByPath, communityOrdinalById) {
  const leftCommunity = primaryCommunityByPath.get(left.filePath)
  const rightCommunity = primaryCommunityByPath.get(right.filePath)
  const leftOrdinal = leftCommunity ? (communityOrdinalById.get(leftCommunity) ?? Number.MAX_SAFE_INTEGER - 1) : Number.MAX_SAFE_INTEGER
  const rightOrdinal = rightCommunity ? (communityOrdinalById.get(rightCommunity) ?? Number.MAX_SAFE_INTEGER - 1) : Number.MAX_SAFE_INTEGER
  return leftOrdinal - rightOrdinal || compareText(leftCommunity || '', rightCommunity || '') || compareText(left.filePath, right.filePath)
}

function groupBySourcePath(nodes) {
  const result = new Map()
  for (const node of array(nodes)) {
    const filePath = portable(node?.source?.sourcePath)
    if (!filePath || !node?.nodeId) continue
    result.set(filePath, [...array(result.get(filePath)), node])
  }
  return result
}

function expectedBatchId({ snapshotId, ordinal, primaryFiles, allowedFiles, sourceFingerprints }) {
  const identity = JSON.stringify({
    snapshotId,
    ordinal,
    primaryFiles,
    allowedFiles,
    sources: array(sourceFingerprints).map(item => [item.filePath, item.sourceBytes, item.contentFingerprint]),
  })
  return `node-semantic-batch:${String(ordinal).padStart(4, '0')}:${digest('sha256', identity).slice(0, 20)}`
}

function expectedPlanId({ graphId, snapshotId, limits, batchIds }) {
  return `node-semantic-plan:${digest('sha256', JSON.stringify({ graphId, snapshotId, limits, batchIds })).slice(0, 24)}`
}

function expectedOutputRef(outputBaseRef, ordinal) {
  return `${normalizeOutputBaseRef(outputBaseRef)}/batch-${String(ordinal).padStart(4, '0')}.json`
}

function normalizeOutputBaseRef(value) {
  const normalized = portable(String(value || '')).replace(/\/$/, '')
  if (!normalized || !isSafeRelativePath(normalized)) throw new Error('outputBaseRef must be a safe relative path')
  return normalized
}

function resolveSourcePathOrThrow(root, filePath) {
  if (!isSafeRelativePath(filePath)) throw new Error(`unsafe source path: ${filePath}`)
  const fullPath = path.resolve(root, filePath)
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) throw new Error(`source path escapes repoPath: ${filePath}`)
  return fullPath
}

function resolveSourcePath(root, filePath, issues, pointer) {
  try {
    return resolveSourcePathOrThrow(root, filePath)
  } catch (error) {
    issues.push(`${pointer}.${error.message}`)
    return null
  }
}

function isSafeRelativePath(value) {
  if (!value || path.posix.isAbsolute(value)) return false
  return !value.split('/').some(segment => segment === '..' || segment === '')
}

function forbidResearchPromptFields(value, issues) {
  const forbidden = new Set(['questions', 'openQuestions', 'hypotheses', 'competingHypotheses', 'journeys', 'targetJourneys', 'targetJourneyIds'])
  visit(value, (key, pointer) => {
    if (forbidden.has(key)) issues.push(`${pointer}.${key} is forbidden in a node-semantic batch plan`)
  })
}

function visit(value, callback, pointer = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => visit(item, callback, `${pointer}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    callback(key, pointer)
    visit(child, callback, `${pointer}.${key}`)
  }
}

function requireSortedUnique(issues, pointer, values) {
  if (!Array.isArray(values)) {
    issues.push(`${pointer} must be an array`)
    return
  }
  if (!sameExactStrings(values, uniqueSorted(values))) issues.push(`${pointer} must be sorted and unique`)
}

function positiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`)
  return number
}

function portable(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//, '') : null
}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest('hex')
}

function uniqueSorted(values) {
  return [...new Set(array(values).filter(value => typeof value === 'string' && value.length))].sort(compareText)
}

function sameStrings(left, right) {
  return sameExactStrings(uniqueSorted(left), uniqueSorted(right))
}

function sameExactStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index])
}

function compareFingerprintPaths(left, right) {
  return compareText(left.filePath, right.filePath)
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en')
}

function array(value) {
  return Array.isArray(value) ? value : []
}
