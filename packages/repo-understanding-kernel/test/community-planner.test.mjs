import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildCommunityArtifacts,
  validateCommunityMap,
  validateNeighborMap,
  writeCommunityArtifacts,
} from '../src/graph/community-planner.mjs'

const STRUCTURE_FINGERPRINT = `structure:sha256:${'a'.repeat(64)}`

test('community and depth-neighbor planning is deterministic across input ordering', () => {
  const graph = staticProgramGraphFixture()
  const first = buildCommunityArtifacts({ staticProgramGraph: graph, maxDepth: 1 })
  const second = buildCommunityArtifacts({
    staticProgramGraph: {
      ...graph,
      files: [...graph.files].reverse(),
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    },
    maxDepth: 1,
  })

  assert.deepEqual(second, first)
  assert.deepEqual(validateCommunityMap(first.communityMap), [])
  assert.deepEqual(validateNeighborMap(first.neighborMap), [])
  assert.equal(first.communityMap.status, 'ready')
  assert.equal(first.communityMap.algorithm.randomWalk, false)
  assert.equal(first.neighborMap.maxDepth, 1)
  assert.equal(first.neighborMap.entries.every(entry => entry.layers[0].depth === 0), true)
  assert.equal(first.neighborMap.entries.every(entry => entry.layers[0].entityIds.length === entry.homeEntityIds.length), true)
  assert.equal(JSON.stringify(first).includes('openQuestion'), false)
  assert.deepEqual(buildCommunityArtifacts(graph), first)
})

test('isolated source entities remain actionable singleton communities without questions', () => {
  const { communityMap, neighborMap } = buildCommunityArtifacts({
    staticProgramGraph: staticProgramGraphFixture(),
    maxDepth: 2,
  })
  const membership = communityMap.membership.find(item => item.nodeId === 'module:src/isolated.ts')
  const community = communityMap.communities.find(item => item.communityId === membership.communityId)
  const neighbors = neighborMap.entries.find(item => item.communityId === membership.communityId)

  assert.deepEqual(community.memberNodeIds, ['module:src/isolated.ts'])
  assert.deepEqual(community.entryEntityIds, ['module:src/isolated.ts'])
  assert.deepEqual(community.allowedFiles, ['src/isolated.ts'])
  assert.deepEqual(neighbors.layers, [{
    depth: 0,
    entityIds: ['module:src/isolated.ts'],
    communityIds: [membership.communityId],
    sourceFiles: ['src/isolated.ts'],
    edgeIds: [],
  }])
  assert.deepEqual(neighbors.allowedFiles, ['src/isolated.ts'])
  assert.ok(communityMap.diagnostics.some(item => item.kind === 'isolated-program-entities'))
})

test('unsupported and source-empty graphs fail closed and persist strict artifacts', () => {
  for (const [supportLevel, expectedStatus] of [
    ['unsupported', 'unsupported'],
    ['supported-frontend', 'empty'],
  ]) {
    const graph = emptyStaticProgramGraph(supportLevel)
    const artifacts = buildCommunityArtifacts({ staticProgramGraph: graph })

    assert.equal(artifacts.communityMap.status, expectedStatus)
    assert.equal(artifacts.neighborMap.status, expectedStatus)
    assert.deepEqual(artifacts.communityMap.communities, [])
    assert.deepEqual(artifacts.neighborMap.entries, [])
    assert.equal(artifacts.communityMap.diagnostics.length, 1)
    assert.equal(artifacts.neighborMap.diagnostics.length, 1)
    assert.deepEqual(validateCommunityMap(artifacts.communityMap), [])
    assert.deepEqual(validateNeighborMap(artifacts.neighborMap), [])

    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-plan-'))
    try {
      const written = writeCommunityArtifacts({ ...artifacts, packageDir })
      assert.equal(path.relative(packageDir, written.communityMapPath), 'static/community-map.json')
      assert.equal(path.relative(packageDir, written.neighborMapPath), 'static/neighbor-map.json')
      assert.equal(JSON.parse(fs.readFileSync(written.communityMapPath, 'utf8')).status, expectedStatus)
      assert.equal(JSON.parse(fs.readFileSync(written.neighborMapPath, 'utf8')).status, expectedStatus)
    } finally {
      fs.rmSync(packageDir, { recursive: true, force: true })
    }
  }
})

test('strict validators reject extra agent-planning fields', () => {
  const artifacts = buildCommunityArtifacts({ staticProgramGraph: staticProgramGraphFixture() })
  assert.ok(validateCommunityMap({ ...artifacts.communityMap, openQuestions: [] }).some(issue => issue.includes('openQuestions')))
  assert.ok(validateNeighborMap({ ...artifacts.neighborMap, researchContracts: [] }).some(issue => issue.includes('researchContracts')))
})

function staticProgramGraphFixture() {
  const sourcePaths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/isolated.ts']
  const nodes = [
    node('module:src/a.ts', 'module', 'src/a.ts', 'src/a.ts'),
    node('symbol:src/a.ts:A', 'symbol', 'A', 'src/a.ts'),
    node('module:src/b.ts', 'module', 'src/b.ts', 'src/b.ts'),
    node('symbol:src/b.ts:B', 'symbol', 'B', 'src/b.ts'),
    node('module:src/c.ts', 'module', 'src/c.ts', 'src/c.ts'),
    node('symbol:src/c.ts:C', 'symbol', 'C', 'src/c.ts'),
    node('module:src/d.ts', 'module', 'src/d.ts', 'src/d.ts'),
    node('symbol:src/d.ts:D', 'symbol', 'D', 'src/d.ts'),
    node('module:src/isolated.ts', 'module', 'src/isolated.ts', 'src/isolated.ts'),
    node('package:react', 'external-package', 'react', null),
  ]
  const edges = [
    edge('edge:a-declares', 'declares', 'module:src/a.ts', 'symbol:src/a.ts:A', 'src/a.ts'),
    edge('edge:a-imports-b', 'imports', 'module:src/a.ts', 'module:src/b.ts', 'src/a.ts'),
    edge('edge:a-renders-b', 'renders-component', 'symbol:src/a.ts:A', 'symbol:src/b.ts:B', 'src/a.ts'),
    edge('edge:b-declares', 'declares', 'module:src/b.ts', 'symbol:src/b.ts:B', 'src/b.ts'),
    edge('edge:b-imports-react', 'imports', 'module:src/b.ts', 'package:react', 'src/b.ts'),
    edge('edge:bridge', 'imports', 'module:src/b.ts', 'module:src/c.ts', 'src/b.ts'),
    edge('edge:c-declares', 'declares', 'module:src/c.ts', 'symbol:src/c.ts:C', 'src/c.ts'),
    edge('edge:c-imports-d', 'imports', 'module:src/c.ts', 'module:src/d.ts', 'src/c.ts'),
    edge('edge:c-renders-d', 'renders-component', 'symbol:src/c.ts:C', 'symbol:src/d.ts:D', 'src/c.ts'),
    edge('edge:d-declares', 'declares', 'module:src/d.ts', 'symbol:src/d.ts:D', 'src/d.ts'),
  ]
  return {
    schemaVersion: 'repo-static-program-graph/v1',
    graphId: 'static-program-graph:test-community',
    structureFingerprint: STRUCTURE_FINGERPRINT,
    snapshotId: 'snapshot:test-community',
    supportDecisionRef: 'static/support-decision.json',
    supportLevel: 'supported-frontend',
    roots: ['.'],
    frameworks: ['react'],
    languages: [{ name: 'TypeScript', fileCount: sourcePaths.length }],
    parser: {
      mode: 'compiler',
      providers: [{ name: 'typescript', available: true, version: '6.0.3' }],
      toolchainFingerprint: 'toolchain:test',
    },
    files: sourcePaths.map(sourcePath => ({
      sourcePath,
      language: 'TypeScript',
      contentHash: `hash:${sourcePath}`,
      structureFingerprint: STRUCTURE_FINGERPRINT,
      parser: 'typescript',
      parseStatus: 'parsed',
      sourceKind: 'compiler-ast',
      evidenceRefs: [`evidence:file:${sourcePath}`],
    })),
    nodes,
    edges,
    diagnostics: [],
    metrics: {
      sourceFiles: sourcePaths.length,
      parsedFiles: sourcePaths.length,
      compilerParsedFiles: sourcePaths.length,
      fallbackParsedFiles: 0,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      diagnosticCount: 0,
      parseFailureCount: 0,
      importResolutionFailureCount: 0,
    },
    generatedAt: '2026-07-13T00:00:00.000Z',
  }
}

function emptyStaticProgramGraph(supportLevel) {
  return {
    schemaVersion: 'repo-static-program-graph/v1',
    graphId: `static-program-graph:${supportLevel}:empty`,
    structureFingerprint: STRUCTURE_FINGERPRINT,
    snapshotId: `snapshot:${supportLevel}:empty`,
    supportDecisionRef: 'static/support-decision.json',
    supportLevel,
    roots: supportLevel === 'unsupported' ? [] : ['.'],
    frameworks: ['unknown'],
    languages: [],
    parser: {
      mode: 'fallback',
      providers: [],
      toolchainFingerprint: 'toolchain:empty',
    },
    files: [],
    nodes: [],
    edges: [],
    diagnostics: [],
    metrics: {
      sourceFiles: 0,
      parsedFiles: 0,
      compilerParsedFiles: 0,
      fallbackParsedFiles: 0,
      nodeCount: 0,
      edgeCount: 0,
      diagnosticCount: 0,
      parseFailureCount: 0,
      importResolutionFailureCount: 0,
    },
    generatedAt: '2026-07-13T00:00:00.000Z',
  }
}

function node(nodeId, kind, label, sourcePath) {
  return {
    nodeId,
    kind,
    label,
    language: sourcePath ? 'TypeScript' : 'package',
    frameworks: ['react'],
    source: {
      sourcePath,
      line: sourcePath ? 1 : null,
      range: sourcePath ? sourceRange() : null,
      provider: sourcePath ? 'typescript' : 'package-manifest',
      sourceKind: sourcePath ? 'compiler-ast' : 'manifest',
      structureFingerprint: `structure:test:${nodeId}`,
    },
    evidenceRefs: sourcePath ? [`evidence:file:${sourcePath}`] : ['evidence:package:react'],
    attributes: {},
  }
}

function edge(edgeId, type, from, to, sourcePath) {
  return {
    edgeId,
    type,
    from,
    to,
    source: {
      sourcePath,
      line: 1,
      range: sourceRange(),
      provider: 'typescript',
      sourceKind: 'compiler-ast',
      structureFingerprint: `structure:test:${edgeId}`,
    },
    evidenceRefs: [`evidence:file:${sourcePath}`],
    confidence: 1,
    attributes: {},
  }
}

function sourceRange() {
  return {
    start: { offset: 0, line: 1, column: 0 },
    end: { offset: 1, line: 1, column: 1 },
  }
}
