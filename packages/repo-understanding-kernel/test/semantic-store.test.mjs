import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ingestGovernedHypotheses,
  initializeSemanticStore,
  loadSemanticStore,
} from '../src/knowledge/semantic-store.mjs'

test('initializes governed Evidence and serially materializes accepted and refuted semantic Claims', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-store-'))
  const initialized = initializeSemanticStore({
    packageDir,
    staticProgramGraph: graph(),
    inventory: inventory(),
  })

  assert.deepEqual(initialized.evidence.map(item => item.evidenceId), [
    'evidence:manifest:package.json',
    'evidence:file:src/App.tsx',
  ])
  assert.equal(initialized.manifest.counts.claims, 0)

  const result = ingestGovernedHypotheses({
    packageDir,
    contract: contract(),
    workItem: { itemId: 'work:semantic', snapshotId: 'snapshot:test', criticality: 'high' },
    acceptedData: {
      hypotheses: [
        hypothesis('hypothesis:supported', 'supported', ['evidence:file:src/App.tsx'], []),
        hypothesis('hypothesis:refuted', 'refuted', [], ['evidence:manifest:package.json']),
      ],
    },
    generatedAt: '2026-07-13T00:01:00.000Z',
  })

  assert.equal(result.manifest.counts.acceptedClaims, 1)
  assert.equal(result.manifest.counts.refutedClaims, 1)
  assert.deepEqual(result.claims.map(item => item.status), ['accepted', 'refuted'])
  assert.deepEqual(result.claims[0].qualifiers.targetMaps, ['experience'])
  assert.equal(result.claims[0].createdByItemId, 'work:semantic')

  const loaded = loadSemanticStore(packageDir)
  assert.equal(loaded.validation.valid, true)
  assert.equal(loaded.manifest.hashes.claims, result.manifest.hashes.claims)
})

test('rejects hypotheses that cite Evidence outside the governed store', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-store-'))
  initializeSemanticStore({ packageDir, staticProgramGraph: graph(), inventory: inventory() })

  assert.throws(() => ingestGovernedHypotheses({
    packageDir,
    contract: contract(),
    workItem: { itemId: 'work:semantic', snapshotId: 'snapshot:test', criticality: 'medium' },
    acceptedData: { hypotheses: [hypothesis('hypothesis:ghost', 'supported', ['evidence:ghost'], [])] },
  }), /Unknown governed Evidence/)

  assert.equal(loadSemanticStore(packageDir).manifest.counts.claims, 0)
})

function graph() {
  return {
    schemaVersion: 'repo-static-program-graph/v1',
    snapshotId: 'snapshot:test',
    generatedAt: '2026-07-13T00:00:00.000Z',
    files: [{ sourcePath: 'src/App.tsx', contentHash: 'app-hash' }],
  }
}

function inventory() {
  return {
    files: [{ path: 'src/App.tsx', lines: 24, hash: 'app-hash', protected: false }],
    manifests: [{ path: 'package.json' }],
  }
}

function contract() {
  return {
    schemaVersion: 'repo-research-contract/v1',
    contractId: 'contract:test',
    snapshotId: 'snapshot:test',
    questions: [{
      questionId: 'question:role',
      targetMaps: ['experience'],
      targetJourneyIds: ['journey:checkout'],
    }],
  }
}

function hypothesis(hypothesisId, status, supportEvidenceIds, counterEvidenceIds) {
  return {
    hypothesisId,
    questionId: 'question:role',
    hypothesisType: 'business-role',
    subject: 'page:checkout',
    predicate: 'has-goal',
    object: status === 'supported' ? 'submit order' : 'browse catalog',
    supportEvidenceIds,
    counterEvidenceIds,
    confidence: 0.9,
    status,
    impact: { mapDimensions: ['core-journeys'], journeyIds: ['journey:checkout'] },
  }
}
