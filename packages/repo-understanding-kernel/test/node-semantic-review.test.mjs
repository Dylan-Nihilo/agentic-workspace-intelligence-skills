import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nodeSemanticCatalogHash,
  validateNodeSemanticReview,
} from '../src/knowledge/node-semantic-review.mjs'

test('binds an independent accepted review to the exact batch catalog', () => {
  const catalog = { snapshotId: 'snapshot:test', entries: [{ filePath: 'src/App.vue' }] }
  const batch = { batchId: 'batch:test', primaryFiles: ['src/App.vue'] }
  const review = {
    schemaVersion: 'repo-node-semantic-review/v1',
    planId: 'plan:test',
    snapshotId: 'snapshot:test',
    batchId: 'batch:test',
    catalogHash: nodeSemanticCatalogHash(catalog),
    status: 'accepted',
    entries: [{
      filePath: 'src/App.vue',
      status: 'accepted',
      checks: { responsibilityEvidence: true, semanticKind: true, noUnsupportedClaims: true },
      issues: [],
    }],
    reviewer: { kind: 'agent', reviewId: 'review:test' },
    generatedAt: '2026-07-14T00:00:00Z',
  }
  assert.deepEqual(validateNodeSemanticReview({ review, planId: 'plan:test', batch, catalog }), { valid: true, issues: [] })
  catalog.entries[0].filePath = 'src/Changed.vue'
  assert.equal(validateNodeSemanticReview({ review, planId: 'plan:test', batch, catalog }).valid, false)
})
