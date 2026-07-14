import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createWorkItem,
  ensureWorkflow,
  planAndIssueWorkItem,
  validateWorkResultEnvelope,
} from '../src/workflow/workflow-store.mjs'
import { snapshotIdForInventory } from '../src/snapshot/repo-snapshot.mjs'

const STRUCTURE = `structure:sha256:${'a'.repeat(64)}`

test('accepts current source structure fingerprints and rejects stale or missing ones', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-read-set-'))
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-source-'))
  const sourcePath = path.join(repoDir, 'src', 'App.tsx')
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  fs.writeFileSync(sourcePath, 'export function App() { return <main /> }\n', 'utf8')

  const inventory = {
    repo: { path: repoDir },
    files: [{ path: 'src/App.tsx' }],
  }
  const snapshotId = snapshotIdForInventory(inventory)
  writeJson(path.join(packageDir, 'static', 'inventory.json'), inventory)
  writeJson(path.join(packageDir, 'static', 'static-program-graph.json'), {
    schemaVersion: 'repo-static-program-graph/v1',
    snapshotId,
    structureFingerprint: `structure:sha256:${'b'.repeat(64)}`,
    files: [{ sourcePath: 'src/App.tsx', structureFingerprint: STRUCTURE }],
  })
  writeJson(path.join(packageDir, 'planning', 'contracts', 'contract.json'), {
    contractId: 'contract:read-set',
    snapshotId,
    scope: { allowedFiles: ['src/App.tsx'] },
    deterministicContextRefs: [],
  })
  writeJson(path.join(packageDir, 'schemas', 'output.schema.json'), {
    properties: { schemaVersion: { const: 'repo-task-outcome/v1' } },
  })
  const outputPath = path.join(packageDir, 'research', 'outcome.json')
  writeJson(outputPath, { schemaVersion: 'repo-task-outcome/v1' })

  ensureWorkflow(packageDir, { snapshotId })
  const item = createWorkItem(packageDir, {
    kind: 'semantic-research',
    role: 'repo-explorer',
    contractRef: 'planning/contracts/contract.json',
    objectiveSummary: 'Resolve a bounded semantic question.',
    completionPolicyRef: 'planning/contracts/contract.json#completionRules',
    inputArtifactRefs: ['planning/contracts/contract.json'],
    outputArtifactPath: outputPath,
    outputSchemaRef: 'schemas/output.schema.json',
    communityIds: ['community:test'],
    neighborMapRef: null,
    blockingMapDimensions: ['core-journeys'],
    blockingJourneyIds: [],
    qualityClass: 'analytical',
    criticality: 'high',
    budgetHints: {},
  })
  planAndIssueWorkItem(packageDir, item)

  const envelope = {
    schemaVersion: 'repo-work-result/v3',
    itemId: item.itemId,
    runId: item.runId,
    snapshotId: item.snapshotId,
    attempt: item.attempt,
    contractId: 'contract:read-set',
    status: 'completed',
    outcomeStatus: 'satisfied',
    completionSummary: 'The contracted semantic question was resolved.',
    output: { path: outputPath, schemaVersion: 'repo-task-outcome/v1' },
    producer: { role: 'repo-explorer', usage: { status: 'unavailable' } },
    artifactHashes: [{ artifactRef: outputPath, algorithm: 'sha256', value: hashFile(outputPath) }],
    readSet: [{
      path: 'src/App.tsx',
      fingerprintAlgorithm: 'sha256',
      contentFingerprint: hashFile(sourcePath),
      structureFingerprint: STRUCTURE,
    }],
    scopeViolations: [],
    errors: [],
    producedAt: '2026-07-13T00:00:00.000Z',
  }

  assert.deepEqual(validateWorkResultEnvelope(packageDir, envelope).issues, [])

  const stale = structuredClone(envelope)
  stale.readSet[0].structureFingerprint = `structure:sha256:${'c'.repeat(64)}`
  assert.match(validateWorkResultEnvelope(packageDir, stale).issues.join('\n'), /structureFingerprint is stale or missing/)

  const missing = structuredClone(envelope)
  missing.readSet[0].structureFingerprint = null
  assert.match(validateWorkResultEnvelope(packageDir, missing).issues.join('\n'), /structureFingerprint is stale or missing/)
})

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
