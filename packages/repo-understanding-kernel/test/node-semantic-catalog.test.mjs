import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acceptNodeSemanticBatchCatalog,
  mergeNodeSemanticCatalogs,
  validateNodeSemanticCatalog,
} from '../src/knowledge/node-semantic-catalog.mjs'
import { nodeSemanticCatalogHash } from '../src/knowledge/node-semantic-review.mjs'

const sourcePath = 'src/views/Detail.vue'
const graph = {
  snapshotId: 'snapshot:test',
  nodes: [{ nodeId: `module:${sourcePath}`, source: { sourcePath } }],
}
const inventory = {
  files: [{ path: sourcePath, lines: 100, protected: false }],
}

test('accepts an evidence-backed node semantic entry', () => {
  const validation = validateNodeSemanticCatalog({
    catalog: catalog(),
    staticProgramGraph: graph,
    inventory,
  })
  assert.equal(validation.valid, true)
  assert.deepEqual(validation.issues, [])
})

test('rejects out-of-scope and impossible evidence ranges', () => {
  const value = catalog()
  value.entries[0].responsibility.evidence[0] = { sourcePath: 'src/Other.vue', startLine: 50, endLine: 20 }
  const validation = validateNodeSemanticCatalog({ catalog: value, staticProgramGraph: graph, inventory })
  assert.equal(validation.valid, false)
  assert(validation.issues.some(issue => issue.includes('outside scopeFiles')))
  assert(validation.issues.some(issue => issue.includes('unknown file')))
})

test('merges accepted entries deterministically and closes complete coverage', () => {
  const first = catalog()
  const accepted = structuredClone(first.entries[0])
  accepted.status = 'accepted'
  const second = { ...catalog(), entries: [accepted] }
  const merged = mergeNodeSemanticCatalogs({
    catalogs: [first, second],
    snapshotId: 'snapshot:test',
    expectedFilePaths: [sourcePath],
    generatedAt: '2026-07-14T01:00:00Z',
  })
  assert.equal(merged.status, 'complete')
  assert.equal(merged.entries.length, 1)
  assert.equal(merged.entries[0].status, 'accepted')
})

test('accepts an inventory-only code file without a graph entity', () => {
  const value = catalog()
  value.entries[0].filePath = 'public/index.html'
  value.entries[0].entityIds = []
  value.entries[0].scopeFiles = ['public/index.html']
  value.entries[0].responsibility.evidence = [{ sourcePath: 'public/index.html', startLine: 1, endLine: 1 }]
  value.entries[0].inputs = []
  const validation = validateNodeSemanticCatalog({
    catalog: value,
    staticProgramGraph: graph,
    inventory: { files: [...inventory.files, { path: 'public/index.html', lines: 10, protected: false }] },
  })
  assert.equal(validation.valid, true)
})

test('accepts only exact draft coverage from the planned batch', () => {
  const value = catalog()
  value.entries[0].producer.workItemId = 'node-semantic-batch:test'
  const review = acceptedReview(value)
  const accepted = acceptNodeSemanticBatchCatalog({
    catalog: value,
    review,
    planId: 'node-semantic-plan:test',
    batch: {
      batchId: 'node-semantic-batch:test',
      primaryFiles: [sourcePath],
      allowedFiles: [sourcePath],
    },
    staticProgramGraph: graph,
    inventory,
  })
  assert.equal(accepted.entries[0].status, 'accepted')

  const incomplete = catalog()
  incomplete.entries = []
  assert.throws(() => acceptNodeSemanticBatchCatalog({
    catalog: incomplete,
    review: acceptedReview(incomplete),
    planId: 'node-semantic-plan:test',
    batch: { batchId: 'node-semantic-batch:test', primaryFiles: [sourcePath], allowedFiles: [sourcePath] },
    staticProgramGraph: graph,
    inventory,
  }), /cover every batch primary file/)
})

function acceptedReview(value) {
  return {
    schemaVersion: 'repo-node-semantic-review/v1',
    planId: 'node-semantic-plan:test',
    snapshotId: value.snapshotId,
    batchId: 'node-semantic-batch:test',
    catalogHash: nodeSemanticCatalogHash(value),
    status: 'accepted',
    entries: value.entries.map(entry => ({
      filePath: entry.filePath,
      status: 'accepted',
      checks: { responsibilityEvidence: true, semanticKind: true, noUnsupportedClaims: true },
      issues: [],
    })),
    reviewer: { kind: 'agent', reviewId: 'review:test' },
    generatedAt: '2026-07-14T00:00:00Z',
  }
}

function catalog() {
  return {
    schemaVersion: 'repo-node-semantic-catalog/v1',
    snapshotId: 'snapshot:test',
    status: 'partial',
    entries: [{
      filePath: sourcePath,
      entityIds: [`module:${sourcePath}`],
      scopeFiles: [sourcePath],
      semanticKind: 'view',
      title: 'Detail view',
      responsibility: { summary: 'Displays a detail record.', confidence: 0.9, evidence: [evidence(1, 20)] },
      inputs: [{ name: 'record id', description: 'Reads the route record id.', confidence: 0.9, evidence: [evidence(22, 24)] }],
      actions: [],
      state: [],
      outputs: [],
      conditions: [],
      boundaries: [],
      collaborators: [],
      unknowns: [],
      confidence: 0.9,
      status: 'draft',
      producer: { kind: 'agent', workItemId: 'work:prototype' },
    }],
    generatedAt: '2026-07-14T00:00:00Z',
  }
}

function evidence(startLine, endLine) {
  return { sourcePath, startLine, endLine }
}
