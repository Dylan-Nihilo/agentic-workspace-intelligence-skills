import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyNodeSemanticCoverage } from '../../repo-understanding-kernel/src/verification/frontend-package-verifier.mjs'
import { nodeSemanticCatalogHash } from '../../repo-understanding-kernel/src/knowledge/node-semantic-review.mjs'

const cliPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(cliPackageDir, 'src', 'cli.mjs')

test('semantic-plan and semantic-ingest close Stage 6 coverage and refresh the Atlas', t => {
  const fixture = createStage6Fixture(t)

  const planResult = runCli([
    'semantic-plan',
    '--package', fixture.packageDir,
    '--max-files', '4',
    '--max-source-bytes', '1024',
  ])
  assert.equal(planResult.schemaVersion, 'repo-node-semantic-plan-result/v1')
  assert.equal(planResult.eligibleFileCount, 4)
  assert.equal(planResult.batchCount, 1)

  const plan = readJson(path.join(fixture.packageDir, 'planning', 'node-semantic-batches.json'))
  assert.equal(plan.schemaVersion, 'repo-node-semantic-batch-plan/v1')
  assert.deepEqual(plan.batches.flatMap(batch => batch.primaryFiles).sort(), [
    'public/index.html',
    'src/App.vue',
    'src/helper.js',
    'src/model.ts',
  ])
  assert(plan.batches.every(batch => batch.allowedFiles.length <= 4))
  assert(plan.batches.every(batch => batch.sourceBytes <= 1024))
  assert(plan.batches.every(batch => batch.sourceFingerprints.length === batch.allowedFiles.length))

  const batch = plan.batches[0]
  const contextPath = path.join(fixture.packageDir, 'research', 'node-semantics', 'contexts', 'batch-0001.json')
  const dispatch = readJson(contextPath)
  assert.equal(dispatch.schemaVersion, 'repo-node-semantic-agent-batch/v1')
  assert.equal(dispatch.planId, plan.planId)
  assert.deepEqual(dispatch.batch, batch)
  assert.deepEqual(dispatch.context.files.map(file => file.filePath), batch.allowedFiles)
  assert.equal(dispatch.context.snapshotId, fixture.snapshotId)
  assert.equal(dispatch.outputPath, path.resolve(fixture.packageDir, batch.outputRef))
  assert.equal(dispatch.reviewPath, path.resolve(fixture.packageDir, 'research', 'node-semantics', 'reviews', 'batch-0001.review.json'))
  assert(dispatch.context.files.find(file => file.filePath === 'src/App.vue').signals.length > 0)
  assert.deepEqual(dispatch.context.files.find(file => file.filePath === 'public/index.html').entities, [])

  const atlasPath = path.join(fixture.packageDir, 'repository-atlas.html')
  const atlasBeforeIngest = fs.readFileSync(atlasPath, 'utf8')
  const workerCatalog = buildDraftCatalog({ fixture, batch })
  fs.mkdirSync(path.dirname(dispatch.outputPath), { recursive: true })
  fs.writeFileSync(dispatch.outputPath, `${JSON.stringify(workerCatalog, null, 2)}\n`, 'utf8')
  const reviewPlanResult = runCli(['semantic-review-plan', '--package', fixture.packageDir])
  assert.equal(reviewPlanResult.schemaVersion, 'repo-node-semantic-review-plan-result/v1')
  assert.equal(reviewPlanResult.dispatches.length, 1)
  const reviewDispatch = readJson(reviewPlanResult.dispatches[0].dispatchPath)
  assert.equal(reviewDispatch.schemaVersion, 'repo-node-semantic-review-dispatch/v1')
  assert.equal(reviewDispatch.catalogHash, nodeSemanticCatalogHash(workerCatalog))
  assert.equal(reviewDispatch.reviewPath, dispatch.reviewPath)
  writeJson(reviewDispatch.reviewPath, buildAcceptedReview({ plan, batch, catalog: workerCatalog }))

  const ingestResult = runCli(['semantic-ingest', '--package', fixture.packageDir])
  assert.equal(ingestResult.schemaVersion, 'repo-node-semantic-ingest-result/v1')
  assert.equal(ingestResult.planId, plan.planId)
  assert.equal(ingestResult.status, 'complete')
  assert.equal(ingestResult.acceptedFiles, 4)
  assert.equal(ingestResult.eligibleFiles, 4)
  assert.equal(ingestResult.acceptedBatches, 1)
  assert.deepEqual(ingestResult.missingBatches, [])
  assert.deepEqual(ingestResult.unreviewedBatches, [])
  assert.deepEqual(ingestResult.changesRequestedBatches, [])
  assert.deepEqual(ingestResult.invalidReviewBatches, [])

  const acceptedCatalog = readJson(path.join(fixture.packageDir, 'store', 'node-semantics.json'))
  assert.equal(acceptedCatalog.status, 'complete')
  assert.equal(acceptedCatalog.entries.length, 4)
  assert(acceptedCatalog.entries.every(entry => entry.status === 'accepted'))
  assert.deepEqual(acceptedCatalog.entries.map(entry => entry.filePath).sort(), batch.primaryFiles)
  const verificationIssues = []
  const nodeSemanticGate = verifyNodeSemanticCoverage({
    root: fixture.packageDir,
    inventory: fixture.inventory,
    graph: fixture.staticProgramGraph,
    phase: 'projection',
    issues: verificationIssues,
  })
  assert.equal(nodeSemanticGate.current, true)
  assert.equal(nodeSemanticGate.acceptedFiles, 4)
  assert.deepEqual(verificationIssues, [])

  const atlasAfterIngest = fs.readFileSync(atlasPath, 'utf8')
  assert.notEqual(atlasAfterIngest, atlasBeforeIngest)
  assert.match(atlasAfterIngest, /Fixture semantic:/)
  assert.match(atlasAfterIngest, /accepted/)
})

function createStage6Fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-understanding-cli-stage6-'))
  const repoPath = path.join(root, 'repo')
  const packageDir = path.join(root, 'package')
  const snapshotId = 'snapshot:cli-stage6'
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const sources = new Map([
    ['src/App.vue', '<template><main>Fixture app</main></template>\n<script>\nimport { format } from "./helper"\nexport default { name: "FixtureApp", methods: { format } }\n</script>\n'],
    ['src/helper.js', 'export function format(value) { return String(value) }\n'],
    ['src/model.ts', 'export type FixtureModel = { id: string }\n'],
    ['public/index.html', '<main id="app">Fixture shell</main>\n'],
    ['src/style.css', 'main { color: black; }\n'],
  ])
  for (const [filePath, content] of sources) write(path.join(repoPath, filePath), content)

  const inventoryFiles = [...sources].map(([filePath, content]) => ({
    path: filePath,
    size: Buffer.byteLength(content),
    lines: content.split(/\r?\n/).length,
    hash: digest('sha1', content),
    hashKind: 'content',
    language: languageFor(filePath),
    category: filePath.endsWith('.css') ? 'markup' : filePath.endsWith('.html') ? 'markup' : 'source',
    binary: false,
    large: false,
    contentAnalyzable: true,
    protected: false,
    protectionReason: '',
  }))
  const inventory = {
    schemaVersion: 'repo-inventory/v1',
    repo: { name: 'cli-stage6-fixture', path: repoPath, generatedAt: '2026-07-14T00:00:00Z', git: {} },
    scan: { maxFiles: 100, truncated: false, clean: true, dirtyFingerprint: 'clean' },
    files: inventoryFiles,
    counts: { files: inventoryFiles.length, categories: { source: 3, markup: 2 } },
  }
  const graphPaths = ['src/App.vue', 'src/helper.js', 'src/model.ts']
  const nodes = graphPaths.map(filePath => ({
    nodeId: `module:${filePath}`,
    kind: 'module',
    label: filePath,
    language: languageFor(filePath),
    frameworks: ['fixture'],
    source: { sourcePath: filePath, line: 1 },
    evidenceRefs: [`evidence:file:${filePath}`],
    attributes: {},
  }))
  const staticProgramGraph = {
    schemaVersion: 'repo-static-program-graph/v1',
    graphId: 'graph:cli-stage6',
    snapshotId,
    structureFingerprint: `structure:sha256:${digest('sha256', 'cli-stage6-graph')}`,
    files: graphPaths.map(filePath => ({
      sourcePath: filePath,
      contentHash: inventoryFiles.find(file => file.path === filePath).hash,
      structureFingerprint: `structure:sha256:${digest('sha256', `structure:${filePath}`)}`,
      parseStatus: 'parsed',
    })),
    nodes,
    edges: [{
      edgeId: 'edge:app-helper',
      type: 'imports',
      from: 'module:src/App.vue',
      to: 'module:src/helper.js',
      source: { sourcePath: 'src/App.vue', line: 3 },
    }],
    diagnostics: [],
  }
  writeJson(path.join(packageDir, 'static', 'inventory.json'), inventory)
  writeJson(path.join(packageDir, 'static', 'static-program-graph.json'), staticProgramGraph)
  return { packageDir, repoPath, snapshotId, inventory, staticProgramGraph }
}

function buildDraftCatalog({ fixture, batch }) {
  const nodeIdsByPath = new Map()
  for (const node of fixture.staticProgramGraph.nodes) {
    const values = nodeIdsByPath.get(node.source.sourcePath) || []
    values.push(node.nodeId)
    nodeIdsByPath.set(node.source.sourcePath, values)
  }
  return {
    schemaVersion: 'repo-node-semantic-catalog/v1',
    snapshotId: fixture.snapshotId,
    status: 'partial',
    entries: batch.primaryFiles.map(filePath => ({
      filePath,
      entityIds: nodeIdsByPath.get(filePath) || [],
      scopeFiles: [filePath],
      semanticKind: semanticKindFor(filePath),
      title: path.basename(filePath),
      responsibility: {
        summary: `Fixture semantic: ${filePath}`,
        confidence: 0.9,
        evidence: [{ sourcePath: filePath, startLine: 1, endLine: 1 }],
      },
      inputs: [],
      actions: [],
      state: [],
      outputs: [],
      conditions: [],
      boundaries: [],
      collaborators: [],
      unknowns: [],
      confidence: 0.9,
      status: 'draft',
      producer: { kind: 'agent', workItemId: batch.batchId },
    })),
    generatedAt: '2026-07-14T00:00:00Z',
  }
}

function semanticKindFor(filePath) {
  if (filePath.endsWith('.vue')) return 'component'
  if (filePath.endsWith('.html')) return 'view'
  if (filePath.endsWith('.js')) return 'shared-utility'
  return 'other'
}

function buildAcceptedReview({ plan, batch, catalog }) {
  return {
    schemaVersion: 'repo-node-semantic-review/v1',
    planId: plan.planId,
    snapshotId: catalog.snapshotId,
    batchId: batch.batchId,
    catalogHash: nodeSemanticCatalogHash(catalog),
    status: 'accepted',
    entries: catalog.entries.map(entry => ({
      filePath: entry.filePath,
      status: 'accepted',
      checks: { responsibilityEvidence: true, semanticKind: true, noUnsupportedClaims: true },
      issues: [],
    })),
    reviewer: { kind: 'agent', reviewId: 'review:cli-stage6' },
    generatedAt: '2026-07-14T00:00:00Z',
  }
}

function runCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: cliPackageDir,
    encoding: 'utf8',
    timeout: 15000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

function languageFor(filePath) {
  if (filePath.endsWith('.vue')) return 'Vue'
  if (filePath.endsWith('.ts')) return 'TypeScript'
  if (filePath.endsWith('.js')) return 'JavaScript'
  if (filePath.endsWith('.html')) return 'HTML'
  return 'CSS'
}

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest('hex')
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function write(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}
