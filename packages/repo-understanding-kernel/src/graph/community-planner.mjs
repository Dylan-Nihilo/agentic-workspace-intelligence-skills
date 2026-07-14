import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { UndirectedGraph } from 'graphology'
import louvain from 'graphology-communities-louvain'

import { validateStaticProgramGraph } from '../census/static-program-graph.mjs'

export const REPO_COMMUNITY_MAP_SCHEMA = 'repo-community-map/v1'
export const REPO_NEIGHBOR_MAP_SCHEMA = 'repo-neighbor-map/v1'

const require = createRequire(import.meta.url)
const LOUVAIN_VERSION = require('graphology-communities-louvain/package.json').version
const COMMUNITY_MAP_JSON_SCHEMA = readSchema('../../schemas/community-map.schema.json')
const NEIGHBOR_MAP_JSON_SCHEMA = readSchema('../../schemas/neighbor-map.schema.json')
const EXCLUDED_NODE_KINDS = new Set(['external-package', 'unresolved-module'])

/**
 * Partition source-backed program entities into deterministic Louvain communities.
 * External packages and unresolved placeholders are intentionally not partitioned:
 * shared framework dependencies would otherwise collapse unrelated source areas.
 */
export function buildCommunityMap(input = {}) {
  const staticProgramGraph = resolveStaticProgramGraph(input)
  assertStaticProgramGraph(staticProgramGraph)

  const resolution = positiveNumber(input.resolution, 1)
  const generatedAt = String(input.generatedAt || staticProgramGraph.generatedAt)
  const algorithm = algorithmRecord(resolution)
  const allNodes = sorted(staticProgramGraph.nodes || [], item => item.nodeId)
  const selectedNodes = allNodes.filter(isCommunityNode)
  const selectedIds = new Set(selectedNodes.map(item => item.nodeId))
  const unassignedNodeIds = allNodes.filter(item => !selectedIds.has(item.nodeId)).map(item => item.nodeId)

  if (staticProgramGraph.supportLevel === 'unsupported') {
    return finalizeCommunityMap({
      staticProgramGraph,
      generatedAt,
      algorithm,
      status: 'unsupported',
      selectedNodes: [],
      unassignedNodeIds: allNodes.map(item => item.nodeId),
      communities: [],
      membership: [],
      crossCommunityEdges: [],
      isolatedNodeCount: 0,
      diagnostics: [diagnostic(
        'unsupported-static-program-graph',
        'error',
        'Community planning is fail-closed because the Static Program Graph is unsupported.',
      )],
    })
  }

  if (selectedNodes.length === 0) {
    return finalizeCommunityMap({
      staticProgramGraph,
      generatedAt,
      algorithm,
      status: 'empty',
      selectedNodes,
      unassignedNodeIds,
      communities: [],
      membership: [],
      crossCommunityEdges: [],
      isolatedNodeCount: 0,
      diagnostics: [diagnostic(
        'empty-static-program-graph',
        'warning',
        'Community planning is fail-closed because the Static Program Graph has no source-backed program entities.',
      )],
    })
  }

  const nodeById = new Map(selectedNodes.map(item => [item.nodeId, item]))
  const eligibleEdges = eligibleProgramEdges(staticProgramGraph.edges, selectedIds)
  const analysisGraph = buildUndirectedAnalysisGraph(selectedNodes, eligibleEdges)
  const rawPartition = louvain(analysisGraph, {
    fastLocalMoves: false,
    getEdgeWeight: 'weight',
    randomWalk: false,
    resolution,
  })
  const groups = canonicalGroups(selectedNodes, rawPartition)
  const communityIdByNode = new Map()

  for (const group of groups) {
    for (const nodeId of group.memberNodeIds) communityIdByNode.set(nodeId, group.communityId)
  }

  const edgeIndex = indexCommunityEdges(eligibleEdges, communityIdByNode)
  const communities = groups.map((group, ordinal) => {
    const memberSet = new Set(group.memberNodeIds)
    return {
      communityId: group.communityId,
      ordinal,
      memberNodeIds: group.memberNodeIds,
      entryEntityIds: selectEntryEntities({
        memberNodeIds: group.memberNodeIds,
        nodeById,
        eligibleEdges,
        communityIdByNode,
      }),
      allowedFiles: uniqueSorted(group.memberNodeIds.map(nodeId => nodeById.get(nodeId)?.source?.sourcePath).filter(Boolean)),
      internalEdgeIds: edgeIndex.internalByCommunity.get(group.communityId) || [],
      crossCommunityEdgeIds: edgeIndex.crossByCommunity.get(group.communityId) || [],
      _memberSet: memberSet,
    }
  }).map(({ _memberSet, ...community }) => community)

  const membership = selectedNodes.map(node => ({
    nodeId: node.nodeId,
    communityId: communityIdByNode.get(node.nodeId),
    nodeKind: node.kind,
    sourcePath: node.source.sourcePath,
  }))
  const isolatedNodeIds = selectedNodes
    .filter(node => analysisGraph.degree(node.nodeId) === 0)
    .map(node => node.nodeId)
  const diagnostics = isolatedNodeIds.length
    ? [diagnostic(
        'isolated-program-entities',
        'info',
        `${isolatedNodeIds.length} source-backed program ${isolatedNodeIds.length === 1 ? 'entity is' : 'entities are'} isolated and retained as singleton communities.`,
        uniqueSorted(isolatedNodeIds.flatMap(nodeId => nodeById.get(nodeId)?.evidenceRefs || [])),
      )]
    : []

  return finalizeCommunityMap({
    staticProgramGraph,
    generatedAt,
    algorithm,
    status: 'ready',
    selectedNodes,
    unassignedNodeIds,
    communities,
    membership,
    crossCommunityEdges: edgeIndex.crossCommunityEdges,
    isolatedNodeCount: isolatedNodeIds.length,
    diagnostics,
  })
}

/**
 * Build community-centric neighborhoods. Depth 0 is the complete home community;
 * depth 1 is the directly adjacent program entities across its boundary.
 */
export function buildNeighborMap(input = {}) {
  const staticProgramGraph = resolveStaticProgramGraph(input)
  const communityMap = input.communityMap
  assertStaticProgramGraph(staticProgramGraph)
  assertCommunityMap(communityMap)
  assertMatchingArtifacts(staticProgramGraph, communityMap)

  const maxDepth = nonNegativeInteger(input.maxDepth, 1)
  const communityMapRef = String(input.communityMapRef || 'static/community-map.json')
  const generatedAt = String(input.generatedAt || communityMap.generatedAt || staticProgramGraph.generatedAt)
  const diagnostics = []

  if (communityMap.status !== 'ready') {
    diagnostics.push(diagnostic(
      communityMap.status === 'unsupported' ? 'unsupported-community-map' : 'empty-community-map',
      communityMap.status === 'unsupported' ? 'error' : 'warning',
      `Neighbor planning is fail-closed because the Community Map status is ${communityMap.status}.`,
    ))
    return finalizeNeighborMap({
      staticProgramGraph,
      communityMap,
      communityMapRef,
      generatedAt,
      maxDepth,
      entries: [],
      edges: [],
      diagnostics,
    })
  }

  const membershipByNode = new Map(communityMap.membership.map(item => [item.nodeId, item]))
  const selectedIds = new Set(membershipByNode.keys())
  const nodeById = new Map((staticProgramGraph.nodes || []).map(item => [item.nodeId, item]))
  const eligibleEdges = eligibleProgramEdges(staticProgramGraph.edges, selectedIds)
  const edgeById = new Map(eligibleEdges.map(item => [item.edgeId, item]))
  const adjacency = buildAdjacency(selectedIds, eligibleEdges)
  const entries = communityMap.communities.map(community => buildCommunityNeighborhood({
    community,
    maxDepth,
    adjacency,
    eligibleEdges,
    membershipByNode,
    nodeById,
  }))

  const referencedEdgeIds = new Set(entries.flatMap(item => item.edgeIds))
  const edges = [...referencedEdgeIds]
    .sort(compareText)
    .map(edgeId => {
      const edge = edgeById.get(edgeId)
      const fromCommunityId = membershipByNode.get(edge.from).communityId
      const toCommunityId = membershipByNode.get(edge.to).communityId
      return {
        edgeId: edge.edgeId,
        type: edge.type,
        from: edge.from,
        to: edge.to,
        fromCommunityId,
        toCommunityId,
        crossCommunity: fromCommunityId !== toCommunityId,
        sourcePath: edge.source?.sourcePath || null,
      }
    })

  return finalizeNeighborMap({
    staticProgramGraph,
    communityMap,
    communityMapRef,
    generatedAt,
    maxDepth,
    entries,
    edges,
    diagnostics,
  })
}

export function buildCommunityArtifacts(input = {}) {
  const staticProgramGraph = resolveStaticProgramGraph(input)
  const communityMap = input.communityMap || buildCommunityMap(input)
  const neighborMap = buildNeighborMap({
    staticProgramGraph,
    communityMap,
    communityMapRef: input.communityMapRef,
    generatedAt: input.generatedAt,
    maxDepth: input.maxDepth,
  })
  return { communityMap, neighborMap }
}

export function validateCommunityMap(value) {
  const issues = validateJsonSchema(value, COMMUNITY_MAP_JSON_SCHEMA)
  const communityIds = new Set()
  const memberIds = new Set()

  for (const community of array(value?.communities)) {
    if (communityIds.has(community.communityId)) issues.push(`duplicate communityId: ${community.communityId}`)
    communityIds.add(community.communityId)
    if (!array(community.memberNodeIds).includes(community.entryEntityIds?.[0])) {
      issues.push(`entryEntityIds must belong to community: ${community.communityId}`)
    }
    for (const nodeId of array(community.memberNodeIds)) {
      if (memberIds.has(nodeId)) issues.push(`node belongs to multiple communities: ${nodeId}`)
      memberIds.add(nodeId)
    }
    for (const entryId of array(community.entryEntityIds)) {
      if (!array(community.memberNodeIds).includes(entryId)) issues.push(`entry entity is not a community member: ${entryId}`)
    }
  }

  const membershipIds = new Set()
  for (const member of array(value?.membership)) {
    if (membershipIds.has(member.nodeId)) issues.push(`duplicate membership nodeId: ${member.nodeId}`)
    membershipIds.add(member.nodeId)
    if (!communityIds.has(member.communityId)) issues.push(`membership references unknown community: ${member.communityId}`)
    if (!memberIds.has(member.nodeId)) issues.push(`membership node is absent from community members: ${member.nodeId}`)
  }
  for (const nodeId of memberIds) if (!membershipIds.has(nodeId)) issues.push(`community member is missing membership: ${nodeId}`)

  for (const edge of array(value?.crossCommunityEdges)) {
    if (!communityIds.has(edge.fromCommunityId)) issues.push(`cross-community edge references unknown source community: ${edge.edgeId}`)
    if (!communityIds.has(edge.toCommunityId)) issues.push(`cross-community edge references unknown target community: ${edge.edgeId}`)
    if (edge.fromCommunityId === edge.toCommunityId) issues.push(`cross-community edge cannot remain inside one community: ${edge.edgeId}`)
  }

  if (value?.status === 'ready' && communityIds.size === 0) issues.push('ready Community Map must contain communities')
  if (value?.status !== 'ready' && communityIds.size > 0) issues.push(`${value.status} Community Map cannot contain communities`)
  compareMetric(issues, value, 'selectedNodeCount', membershipIds.size)
  compareMetric(issues, value, 'unassignedNodeCount', array(value?.unassignedNodeIds).length)
  compareMetric(issues, value, 'communityCount', array(value?.communities).length)
  compareMetric(issues, value, 'crossCommunityEdgeCount', array(value?.crossCommunityEdges).length)
  forbidAgentQuestionFields(value, issues, 'Community Map')
  return uniqueSorted(issues)
}

export function validateNeighborMap(value) {
  const issues = validateJsonSchema(value, NEIGHBOR_MAP_JSON_SCHEMA)
  const communityIds = new Set()

  for (const entry of array(value?.entries)) {
    if (communityIds.has(entry.communityId)) issues.push(`duplicate neighbor entry communityId: ${entry.communityId}`)
    communityIds.add(entry.communityId)
    const layerEntityIds = new Set()
    const depths = new Set()
    for (const layer of array(entry.layers)) {
      if (depths.has(layer.depth)) issues.push(`duplicate neighbor depth ${layer.depth} for ${entry.communityId}`)
      depths.add(layer.depth)
      for (const entityId of array(layer.entityIds)) {
        if (layerEntityIds.has(entityId)) issues.push(`entity occurs at multiple neighbor depths: ${entry.communityId} -> ${entityId}`)
        layerEntityIds.add(entityId)
      }
    }
    if (!depths.has(0)) issues.push(`neighbor entry requires depth 0: ${entry.communityId}`)
    if (!sameStrings([...layerEntityIds], entry.entityIds)) issues.push(`entityIds must equal the union of depth layers: ${entry.communityId}`)
    if (!sameStrings(entry.layers?.find(layer => layer.depth === 0)?.entityIds, entry.homeEntityIds)) {
      issues.push(`depth 0 must equal homeEntityIds: ${entry.communityId}`)
    }
    for (const entryId of array(entry.entryEntityIds)) {
      if (!array(entry.homeEntityIds).includes(entryId)) issues.push(`entry entity is outside the home community: ${entry.communityId} -> ${entryId}`)
    }
  }

  if (value?.status === 'ready' && communityIds.size === 0) issues.push('ready Neighbor Map must contain entries')
  if (value?.status !== 'ready' && communityIds.size > 0) issues.push(`${value.status} Neighbor Map cannot contain entries`)
  compareMetric(issues, value, 'communityCount', array(value?.entries).length)
  compareMetric(issues, value, 'entryEntityCount', array(value?.entries).reduce((sum, item) => sum + array(item.entryEntityIds).length, 0))
  compareMetric(issues, value, 'entityReferenceCount', array(value?.entries).reduce((sum, item) => sum + array(item.entityIds).length, 0))
  compareMetric(issues, value, 'edgeReferenceCount', array(value?.edges).length)
  compareMetric(issues, value, 'boundaryEdgeCount', array(value?.edges).filter(item => item.crossCommunity).length)
  forbidAgentQuestionFields(value, issues, 'Neighbor Map')
  return uniqueSorted(issues)
}

export function writeCommunityMap({ communityMap, packageDir, outputPath = 'static/community-map.json' }) {
  const issues = validateCommunityMap(communityMap)
  if (issues.length) throw new Error(`Invalid Community Map:\n- ${issues.join('\n- ')}`)
  return writeJson(packageDir, outputPath, communityMap)
}

export function writeNeighborMap({ neighborMap, packageDir, outputPath = 'static/neighbor-map.json' }) {
  const issues = validateNeighborMap(neighborMap)
  if (issues.length) throw new Error(`Invalid Neighbor Map:\n- ${issues.join('\n- ')}`)
  return writeJson(packageDir, outputPath, neighborMap)
}

export function writeCommunityArtifacts({
  communityMap,
  neighborMap,
  packageDir,
  communityMapPath = 'static/community-map.json',
  neighborMapPath = 'static/neighbor-map.json',
}) {
  const communityIssues = validateCommunityMap(communityMap)
  const neighborIssues = validateNeighborMap(neighborMap)
  if (communityIssues.length || neighborIssues.length) {
    throw new Error([
      ...communityIssues.map(issue => `Community Map: ${issue}`),
      ...neighborIssues.map(issue => `Neighbor Map: ${issue}`),
    ].join('\n'))
  }
  if (neighborMap.communityMapId !== communityMap.communityMapId) throw new Error('Neighbor Map does not reference the supplied Community Map')
  return {
    communityMapPath: writeJson(packageDir, communityMapPath, communityMap),
    neighborMapPath: writeJson(packageDir, neighborMapPath, neighborMap),
  }
}

function resolveStaticProgramGraph(input) {
  if (input?.schemaVersion === 'repo-static-program-graph/v1') return input
  return input?.staticProgramGraph || input?.graph || null
}

function assertStaticProgramGraph(value) {
  const issues = validateStaticProgramGraph(value)
  if (issues.length) throw new Error(`Invalid Static Program Graph:\n- ${issues.join('\n- ')}`)
}

function assertCommunityMap(value) {
  const issues = validateCommunityMap(value)
  if (issues.length) throw new Error(`Invalid Community Map:\n- ${issues.join('\n- ')}`)
}

function assertMatchingArtifacts(staticProgramGraph, communityMap) {
  if (communityMap.graphId !== staticProgramGraph.graphId) throw new Error('Community Map graphId does not match Static Program Graph')
  if (communityMap.snapshotId !== staticProgramGraph.snapshotId) throw new Error('Community Map snapshotId does not match Static Program Graph')
  if (communityMap.supportLevel !== staticProgramGraph.supportLevel) throw new Error('Community Map supportLevel does not match Static Program Graph')
}

function isCommunityNode(node) {
  return Boolean(
    node?.nodeId
      && !EXCLUDED_NODE_KINDS.has(node.kind)
      && typeof node?.source?.sourcePath === 'string'
      && node.source.sourcePath.length,
  )
}

function eligibleProgramEdges(edges, selectedIds) {
  return sorted(array(edges).filter(edge => selectedIds.has(edge?.from) && selectedIds.has(edge?.to)), item => item.edgeId)
}

function buildUndirectedAnalysisGraph(nodes, edges) {
  const graph = new UndirectedGraph({ allowSelfLoops: false })
  for (const node of nodes) graph.addNode(node.nodeId)
  const pairs = new Map()
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    const pair = [edge.from, edge.to].sort(compareText)
    const key = JSON.stringify(pair)
    const current = pairs.get(key) || { pair, weight: 0 }
    current.weight += 1
    pairs.set(key, current)
  }
  for (const [key, item] of [...pairs.entries()].sort(([left], [right]) => compareText(left, right))) {
    graph.addEdgeWithKey(`pair:${stableHash(key)}`, item.pair[0], item.pair[1], { weight: item.weight })
  }
  return graph
}

function canonicalGroups(nodes, rawPartition) {
  const byRawCommunity = new Map()
  for (const node of nodes) {
    const rawCommunity = String(rawPartition[node.nodeId] ?? `isolated:${node.nodeId}`)
    const current = byRawCommunity.get(rawCommunity) || []
    current.push(node.nodeId)
    byRawCommunity.set(rawCommunity, current)
  }
  return [...byRawCommunity.values()]
    .map(memberNodeIds => uniqueSorted(memberNodeIds))
    .sort(compareStringArrays)
    .map(memberNodeIds => ({
      communityId: `community:${stableHash(memberNodeIds.join('\u0000'))}`,
      memberNodeIds,
    }))
}

function indexCommunityEdges(edges, communityIdByNode) {
  const internalByCommunity = new Map()
  const crossByCommunity = new Map()
  const crossCommunityEdges = []

  for (const edge of edges) {
    const fromCommunityId = communityIdByNode.get(edge.from)
    const toCommunityId = communityIdByNode.get(edge.to)
    if (fromCommunityId === toCommunityId) {
      appendMapArray(internalByCommunity, fromCommunityId, edge.edgeId)
      continue
    }
    appendMapArray(crossByCommunity, fromCommunityId, edge.edgeId)
    appendMapArray(crossByCommunity, toCommunityId, edge.edgeId)
    crossCommunityEdges.push({
      edgeId: edge.edgeId,
      type: edge.type,
      from: edge.from,
      to: edge.to,
      fromCommunityId,
      toCommunityId,
      sourcePath: edge.source?.sourcePath || null,
    })
  }
  for (const values of internalByCommunity.values()) values.sort(compareText)
  for (const values of crossByCommunity.values()) values.sort(compareText)
  crossCommunityEdges.sort((left, right) => compareText(left.edgeId, right.edgeId))
  return { internalByCommunity, crossByCommunity, crossCommunityEdges }
}

function selectEntryEntities({ memberNodeIds, nodeById, eligibleEdges, communityIdByNode }) {
  const communityId = communityIdByNode.get(memberNodeIds[0])
  const internalIncoming = new Map(memberNodeIds.map(nodeId => [nodeId, 0]))
  const boundary = new Set()

  for (const edge of eligibleEdges) {
    const fromCommunityId = communityIdByNode.get(edge.from)
    const toCommunityId = communityIdByNode.get(edge.to)
    if (fromCommunityId === communityId && toCommunityId === communityId && edge.from !== edge.to) {
      internalIncoming.set(edge.to, (internalIncoming.get(edge.to) || 0) + 1)
    } else if (fromCommunityId !== toCommunityId) {
      if (fromCommunityId === communityId) boundary.add(edge.from)
      if (toCommunityId === communityId) boundary.add(edge.to)
    }
  }

  const candidates = new Set(boundary)
  for (const nodeId of memberNodeIds) {
    const node = nodeById.get(nodeId)
    if (node.kind === 'route' || (node.kind === 'module' && internalIncoming.get(nodeId) === 0)) candidates.add(nodeId)
  }
  if (candidates.size === 0) candidates.add([...memberNodeIds].sort((left, right) => compareEntryPriority(nodeById.get(left), nodeById.get(right)))[0])
  return uniqueSorted([...candidates])
}

function compareEntryPriority(left, right) {
  const rank = new Map([['route', 0], ['module', 1], ['symbol', 2], ['component-reference', 3]])
  return (rank.get(left?.kind) ?? 9) - (rank.get(right?.kind) ?? 9) || compareText(left?.nodeId, right?.nodeId)
}

function buildAdjacency(selectedIds, edges) {
  const adjacency = new Map([...selectedIds].map(nodeId => [nodeId, []]))
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    adjacency.get(edge.from).push({ nodeId: edge.to, edgeId: edge.edgeId })
    adjacency.get(edge.to).push({ nodeId: edge.from, edgeId: edge.edgeId })
  }
  for (const links of adjacency.values()) links.sort((left, right) => compareText(left.nodeId, right.nodeId) || compareText(left.edgeId, right.edgeId))
  return adjacency
}

function buildCommunityNeighborhood({ community, maxDepth, adjacency, eligibleEdges, membershipByNode, nodeById }) {
  const distance = new Map()
  const queue = [...community.memberNodeIds]
  for (const nodeId of queue) distance.set(nodeId, 0)

  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]
    const depth = distance.get(nodeId)
    if (depth >= maxDepth) continue
    for (const link of adjacency.get(nodeId) || []) {
      if (distance.has(link.nodeId)) continue
      distance.set(link.nodeId, depth + 1)
      queue.push(link.nodeId)
    }
  }

  const reachedIds = [...distance.keys()].sort(compareText)
  const reachedSet = new Set(reachedIds)
  const scopedEdges = eligibleEdges.filter(edge => reachedSet.has(edge.from) && reachedSet.has(edge.to))
  const layers = []
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const entityIds = reachedIds.filter(nodeId => distance.get(nodeId) === depth)
    if (entityIds.length === 0) continue
    const layerSet = new Set(entityIds)
    layers.push({
      depth,
      entityIds,
      communityIds: uniqueSorted(entityIds.map(nodeId => membershipByNode.get(nodeId).communityId)),
      sourceFiles: uniqueSorted(entityIds.map(nodeId => nodeById.get(nodeId)?.source?.sourcePath).filter(Boolean)),
      edgeIds: scopedEdges
        .filter(edge => layerSet.has(edge.from) || layerSet.has(edge.to))
        .map(edge => edge.edgeId)
        .sort(compareText),
    })
  }

  const neighborCommunityIds = uniqueSorted(reachedIds
    .map(nodeId => membershipByNode.get(nodeId).communityId)
    .filter(communityId => communityId !== community.communityId))
  const boundaryEdgeIds = scopedEdges
    .filter(edge => membershipByNode.get(edge.from).communityId !== membershipByNode.get(edge.to).communityId)
    .map(edge => edge.edgeId)
    .sort(compareText)

  return {
    communityId: community.communityId,
    entryEntityIds: community.entryEntityIds,
    homeEntityIds: community.memberNodeIds,
    entityIds: reachedIds,
    neighborCommunityIds,
    allowedFiles: uniqueSorted(reachedIds.map(nodeId => nodeById.get(nodeId)?.source?.sourcePath).filter(Boolean)),
    layers,
    edgeIds: scopedEdges.map(edge => edge.edgeId).sort(compareText),
    boundaryEdgeIds,
  }
}

function finalizeCommunityMap({
  staticProgramGraph,
  generatedAt,
  algorithm,
  status,
  selectedNodes,
  unassignedNodeIds,
  communities,
  membership,
  crossCommunityEdges,
  isolatedNodeCount,
  diagnostics,
}) {
  const identity = {
    graphId: staticProgramGraph.graphId,
    status,
    algorithm,
    membership: membership.map(item => [item.nodeId, item.communityId]),
    unassignedNodeIds,
  }
  const value = {
    schemaVersion: REPO_COMMUNITY_MAP_SCHEMA,
    communityMapId: `community-map:${stableHash(JSON.stringify(identity))}`,
    graphId: staticProgramGraph.graphId,
    snapshotId: staticProgramGraph.snapshotId,
    supportLevel: staticProgramGraph.supportLevel,
    status,
    algorithm,
    communities,
    membership,
    crossCommunityEdges,
    unassignedNodeIds,
    diagnostics,
    metrics: {
      inputNodeCount: array(staticProgramGraph.nodes).length,
      selectedNodeCount: selectedNodes.length,
      unassignedNodeCount: unassignedNodeIds.length,
      communityCount: communities.length,
      crossCommunityEdgeCount: crossCommunityEdges.length,
      isolatedNodeCount,
    },
    generatedAt,
  }
  const issues = validateCommunityMap(value)
  if (issues.length) throw new Error(`Generated invalid Community Map:\n- ${issues.join('\n- ')}`)
  return value
}

function finalizeNeighborMap({
  staticProgramGraph,
  communityMap,
  communityMapRef,
  generatedAt,
  maxDepth,
  entries,
  edges,
  diagnostics,
}) {
  const value = {
    schemaVersion: REPO_NEIGHBOR_MAP_SCHEMA,
    neighborMapId: `neighbor-map:${stableHash(JSON.stringify({ communityMapId: communityMap.communityMapId, maxDepth, entries }))}`,
    communityMapId: communityMap.communityMapId,
    communityMapRef,
    graphId: staticProgramGraph.graphId,
    snapshotId: staticProgramGraph.snapshotId,
    supportLevel: staticProgramGraph.supportLevel,
    status: communityMap.status,
    maxDepth,
    entries,
    edges,
    diagnostics,
    metrics: {
      communityCount: entries.length,
      entryEntityCount: entries.reduce((sum, item) => sum + item.entryEntityIds.length, 0),
      entityReferenceCount: entries.reduce((sum, item) => sum + item.entityIds.length, 0),
      edgeReferenceCount: edges.length,
      boundaryEdgeCount: edges.filter(item => item.crossCommunity).length,
    },
    generatedAt,
  }
  const issues = validateNeighborMap(value)
  if (issues.length) throw new Error(`Generated invalid Neighbor Map:\n- ${issues.join('\n- ')}`)
  return value
}

function algorithmRecord(resolution) {
  return {
    name: 'louvain',
    provider: 'graphology-communities-louvain',
    providerVersion: LOUVAIN_VERSION,
    graphType: 'undirected-simple',
    resolution,
    randomWalk: false,
    weightPolicy: 'parallel-edge-count',
    nodeSelection: 'source-backed-program-entities',
  }
}

function diagnostic(kind, severity, message, evidenceRefs = []) {
  const identity = JSON.stringify({ kind, severity, message, evidenceRefs })
  return {
    diagnosticId: `community-diagnostic:${stableHash(identity)}`,
    kind,
    severity,
    message,
    evidenceRefs: uniqueSorted(evidenceRefs),
  }
}

function writeJson(packageDir, outputPath, value) {
  if (!packageDir) throw new Error('packageDir is required')
  const target = path.resolve(packageDir, outputPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return target
}

function readSchema(relativePath) {
  return JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

function validateJsonSchema(value, schema, root = schema, pointer = '$') {
  if (schema.$ref) return validateJsonSchema(value, resolveSchemaRef(root, schema.$ref), root, pointer)
  const issues = []
  if (Object.hasOwn(schema, 'const') && value !== schema.const) issues.push(`${pointer} must equal ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.some(candidate => candidate === value)) issues.push(`${pointer} must be one of ${schema.enum.map(JSON.stringify).join(', ')}`)
  if (schema.type && !jsonTypeMatches(value, schema.type)) {
    issues.push(`${pointer} must be ${scalarArray(schema.type).join(' or ')}`)
    return issues
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${pointer} must have length >= ${schema.minLength}`)
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${pointer} must be >= ${schema.minimum}`)
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) issues.push(`${pointer} must be > ${schema.exclusiveMinimum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${pointer} must contain at least ${schema.minItems} items`)
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) issues.push(`${pointer} must contain unique items`)
    if (schema.items) value.forEach((item, index) => issues.push(...validateJsonSchema(item, schema.items, root, `${pointer}[${index}]`)))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) issues.push(`${pointer}.${key} is required`)
    const properties = schema.properties || {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) issues.push(`${pointer}.${key} is not allowed`)
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) issues.push(...validateJsonSchema(value[key], childSchema, root, `${pointer}.${key}`))
    }
  }
  return issues
}

function resolveSchemaRef(root, reference) {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported JSON Schema reference: ${reference}`)
  return reference.slice(2).split('/').reduce((current, part) => current?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], root)
}

function jsonTypeMatches(value, expected) {
  return scalarArray(expected).some(type => {
    if (type === 'null') return value === null
    if (type === 'array') return Array.isArray(value)
    if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    if (type === 'integer') return Number.isInteger(value)
    return typeof value === type
  })
}

function compareMetric(issues, value, key, expected) {
  if (value?.metrics?.[key] !== expected) issues.push(`metrics.${key} must equal ${expected}`)
}

function forbidAgentQuestionFields(value, issues, label) {
  for (const key of ['openQuestion', 'openQuestions', 'researchContract', 'researchContracts']) {
    if (Object.hasOwn(value || {}, key)) issues.push(`${key} is forbidden in ${label}`)
  }
}

function appendMapArray(map, key, value) {
  const current = map.get(key) || []
  current.push(value)
  map.set(key, current)
}

function positiveNumber(value, fallback) {
  const selected = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(selected) || selected <= 0) throw new Error('resolution must be a positive finite number')
  return selected
}

function nonNegativeInteger(value, fallback) {
  const selected = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(selected) || selected < 0) throw new Error('maxDepth must be a non-negative safe integer')
  return selected
}

function stableHash(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function sorted(values, keyFor) {
  return [...array(values)].sort((left, right) => compareText(keyFor(left), keyFor(right)))
}

function uniqueSorted(values) {
  return [...new Set(array(values).filter(value => typeof value === 'string' && value.length))].sort(compareText)
}

function sameStrings(left, right) {
  return JSON.stringify(uniqueSorted(left)) === JSON.stringify(uniqueSorted(right))
}

function compareStringArrays(left, right) {
  return compareText(left.join('\u0000'), right.join('\u0000'))
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en')
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function scalarArray(value) {
  return Array.isArray(value) ? value : [value]
}
