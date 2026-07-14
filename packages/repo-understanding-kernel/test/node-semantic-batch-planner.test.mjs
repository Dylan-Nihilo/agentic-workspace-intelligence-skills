import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildNodeSemanticBatchPlan,
  isNodeSemanticEligibleFile,
  validateNodeSemanticBatchPlan,
  writeNodeSemanticBatchPlan,
} from '../src/planning/node-semantic-batch-planner.mjs'

test('plans every analyzable Vue, JS, TS, and HTML file exactly once', t => {
  const fixture = createFixture(t)
  const plan = buildNodeSemanticBatchPlan({
    ...fixture,
    maxFilesPerBatch: 2,
    maxSourceBytesPerBatch: 1000,
  })

  assert.equal(plan.schemaVersion, 'repo-node-semantic-batch-plan/v1')
  assert.equal(plan.ordering, 'community-ordinal-then-source-path')
  assert.deepEqual(plan.batches.flatMap(batch => batch.primaryFiles).sort(), [
    'babel.config.js',
    'config/plugin.config.ts',
    'public/index.html',
    'src/App.vue',
    'src/Page.ts',
    'src/util.js',
  ])
  assert.equal(plan.eligibleFileCount, 6)
  assert.equal(plan.batchCount, 3)
  assert(plan.batches.every(batch => batch.allowedFiles.length <= 2))
  assert(plan.batches.every(batch => batch.sourceBytes <= 1000))
  assert(plan.batches.every(batch => batch.allowedFiles.every(filePath => batch.primaryFiles.includes(filePath))))
  assert(plan.batches.every(batch => batch.sourceFingerprints.every(source => /^content:sha256:[a-f0-9]{64}$/.test(source.contentFingerprint))))
  assert.equal(JSON.stringify(plan).includes('questions'), false)
  assert.equal(JSON.stringify(plan).includes('hypotheses'), false)
  assert.equal(JSON.stringify(plan).includes('journey'), false)

  const relatedBatch = plan.batches.find(batch => batch.primaryFiles.includes('src/App.vue'))
  assert(relatedBatch.primaryFiles.includes('src/Page.ts'))
  assert.deepEqual(relatedBatch.entityIds, ['module:src/App.vue', 'module:src/Page.ts'])
  assert.deepEqual(relatedBatch.communityIds, ['community:ui'])
  assert.deepEqual(relatedBatch.graphNeighborContext, [{
    edgeId: 'edge:app-page',
    type: 'imports',
    fromEntityId: 'module:src/App.vue',
    toEntityId: 'module:src/Page.ts',
    fromFile: 'src/App.vue',
    toFile: 'src/Page.ts',
    fromCommunityId: 'community:ui',
    toCommunityId: 'community:ui',
    crossCommunity: false,
    sourcePath: 'src/App.vue',
    sourceLine: 2,
  }])

  assert.deepEqual(validateNodeSemanticBatchPlan({ plan, ...fixture }), { valid: true, issues: [] })
})

test('planning output is stable when input arrays are reordered', t => {
  const fixture = createFixture(t)
  const first = buildNodeSemanticBatchPlan({ ...fixture, maxFilesPerBatch: 2, maxSourceBytesPerBatch: 1000 })
  const reordered = {
    ...fixture,
    inventory: { ...fixture.inventory, files: [...fixture.inventory.files].reverse() },
    staticProgramGraph: {
      ...fixture.staticProgramGraph,
      files: [...fixture.staticProgramGraph.files].reverse(),
      nodes: [...fixture.staticProgramGraph.nodes].reverse(),
      edges: [...fixture.staticProgramGraph.edges].reverse(),
    },
    communityMap: {
      ...fixture.communityMap,
      communities: [...fixture.communityMap.communities].reverse(),
      membership: [...fixture.communityMap.membership].reverse(),
    },
    neighborMap: { ...fixture.neighborMap, edges: [...fixture.neighborMap.edges].reverse() },
  }
  const second = buildNodeSemanticBatchPlan({ ...reordered, maxFilesPerBatch: 2, maxSourceBytesPerBatch: 1000 })
  assert.deepEqual(second, first)
})

test('rejects a source file that cannot fit within the hard byte bound', t => {
  const fixture = createFixture(t)
  assert.throws(
    () => buildNodeSemanticBatchPlan({ ...fixture, maxFilesPerBatch: 2, maxSourceBytesPerBatch: 10 }),
    /exceeds maxSourceBytesPerBatch/,
  )
})

test('validator detects coverage, fingerprint, and deterministic identity tampering', t => {
  const fixture = createFixture(t)
  const plan = buildNodeSemanticBatchPlan({ ...fixture, maxFilesPerBatch: 2, maxSourceBytesPerBatch: 1000 })
  const tampered = structuredClone(plan)
  tampered.batches[0].sourceFingerprints[0].contentFingerprint = `content:sha256:${'0'.repeat(64)}`
  tampered.batches[0].primaryFiles.pop()

  const validation = validateNodeSemanticBatchPlan({ plan: tampered, ...fixture })
  assert.equal(validation.valid, false)
  assert(validation.issues.some(issue => issue.includes('contentFingerprint does not match source')))
  assert(validation.issues.some(issue => issue.includes('cover every eligible inventory code file')))
  assert(validation.issues.some(issue => issue.includes('batchId is not deterministic')))
})

test('writes a validated batch plan atomically', t => {
  const fixture = createFixture(t)
  const plan = buildNodeSemanticBatchPlan({ ...fixture, maxFilesPerBatch: 2, maxSourceBytesPerBatch: 1000 })
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-semantic-package-'))
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }))

  const result = writeNodeSemanticBatchPlan({ packageDir, plan, ...fixture })
  assert.equal(result.validation.valid, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(result.path, 'utf8')), plan)
})

test('eligibility includes config code and excludes resources, styles, docs, and protected files', () => {
  assert.equal(isNodeSemanticEligibleFile({ path: 'src/view.vue', contentAnalyzable: true }), true)
  assert.equal(isNodeSemanticEligibleFile({ path: 'src/view.tsx', contentAnalyzable: true }), true)
  assert.equal(isNodeSemanticEligibleFile({ path: 'public/index.html', contentAnalyzable: true }), true)
  assert.equal(isNodeSemanticEligibleFile({ path: 'babel.config.js', contentAnalyzable: true }), true)
  assert.equal(isNodeSemanticEligibleFile({ path: 'config/plugin.config.ts', contentAnalyzable: true }), true)
  assert.equal(isNodeSemanticEligibleFile({ path: '.eslintrc.js', contentAnalyzable: true }), true)
  assert.equal(isNodeSemanticEligibleFile({ path: 'src/theme.css', contentAnalyzable: true }), false)
  assert.equal(isNodeSemanticEligibleFile({ path: 'README.md', category: 'docs', contentAnalyzable: true }), false)
  assert.equal(isNodeSemanticEligibleFile({ path: 'src/logo.png', binary: true }), false)
  assert.equal(isNodeSemanticEligibleFile({ path: 'src/secret.ts', protected: true }), false)
})

function createFixture(t) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'node-semantic-repo-'))
  t.after(() => fs.rmSync(repoPath, { recursive: true, force: true }))
  const sources = new Map([
    ['src/App.vue', '<template><Page /></template>\n<script setup>\nimport Page from "./Page"\n</script>\n'],
    ['src/Page.ts', 'export const Page = "merchant"\n'],
    ['src/util.js', 'export const format = value => String(value)\n'],
    ['public/index.html', '<main id="app"></main>\n'],
    ['src/theme.css', 'main { color: black; }\n'],
    ['README.md', '# fixture\n'],
    ['babel.config.js', 'module.exports = {}\n'],
    ['config/plugin.config.ts', 'export default {}\n'],
    ['src/secret.ts', 'export const secret = true\n'],
    ['src/logo.png', Buffer.from([0, 1, 2, 3])],
  ])
  for (const [filePath, content] of sources) {
    const target = path.join(repoPath, filePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }

  const inventoryFiles = [...sources].map(([filePath, value]) => {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value)
    return {
      path: filePath,
      size: content.length,
      hash: createHash('sha1').update(content).digest('hex'),
      hashKind: 'content',
      category: filePath.endsWith('.md') ? 'docs' : filePath.endsWith('.png') ? 'resource' : filePath.endsWith('.css') ? 'markup' : 'source',
      binary: filePath.endsWith('.png'),
      protected: filePath === 'src/secret.ts',
      contentAnalyzable: filePath !== 'src/logo.png' && filePath !== 'src/secret.ts',
    }
  })
  const inventory = {
    schemaVersion: 'repo-inventory/v1',
    repo: { name: 'fixture', path: repoPath },
    files: inventoryFiles,
  }

  const graphSources = ['src/App.vue', 'src/Page.ts', 'src/util.js']
  const graphFiles = graphSources.map(filePath => {
    const inventoryFile = inventoryFiles.find(file => file.path === filePath)
    return {
      sourcePath: filePath,
      contentHash: inventoryFile.hash,
      structureFingerprint: `structure:sha256:${createHash('sha256').update(`structure:${filePath}`).digest('hex')}`,
      parseStatus: filePath === 'src/util.js' ? 'partial' : 'parsed',
    }
  })
  const nodes = graphSources.map(filePath => ({
    nodeId: `module:${filePath}`,
    kind: 'module',
    source: { sourcePath: filePath },
  }))
  const staticProgramGraph = {
    schemaVersion: 'repo-static-program-graph/v1',
    graphId: 'graph:fixture',
    snapshotId: 'snapshot:fixture',
    files: graphFiles,
    nodes,
    edges: [{
      edgeId: 'edge:app-page',
      type: 'imports',
      from: 'module:src/App.vue',
      to: 'module:src/Page.ts',
      source: { sourcePath: 'src/App.vue', line: 2 },
    }],
  }
  const communityMap = {
    schemaVersion: 'repo-community-map/v1',
    communityMapId: 'community-map:fixture',
    graphId: 'graph:fixture',
    snapshotId: 'snapshot:fixture',
    communities: [
      { communityId: 'community:ui', ordinal: 0 },
      { communityId: 'community:utility', ordinal: 1 },
    ],
    membership: [
      { nodeId: 'module:src/App.vue', communityId: 'community:ui', sourcePath: 'src/App.vue' },
      { nodeId: 'module:src/Page.ts', communityId: 'community:ui', sourcePath: 'src/Page.ts' },
      { nodeId: 'module:src/util.js', communityId: 'community:utility', sourcePath: 'src/util.js' },
    ],
  }
  const neighborMap = {
    schemaVersion: 'repo-neighbor-map/v1',
    neighborMapId: 'neighbor-map:fixture',
    communityMapId: 'community-map:fixture',
    graphId: 'graph:fixture',
    snapshotId: 'snapshot:fixture',
    edges: [{
      edgeId: 'edge:app-page',
      fromCommunityId: 'community:ui',
      toCommunityId: 'community:ui',
      crossCommunity: false,
    }],
  }
  return { inventory, staticProgramGraph, communityMap, neighborMap, repoPath }
}
