import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  appendRunEvent,
  ensureWorkflow,
  materializeRunState,
  planAndIssueWorkItem,
  workflowPaths,
} from '../src/workflow/workflow-store.mjs'

test('rejects a legacy v2 RunEvent stream before materializing or continuing it', t => {
  const packageDir = temporaryPackage(t)
  ensureWorkflow(packageDir)
  const paths = workflowPaths(packageDir)
  const [created] = readEvents(paths.events)
  const legacy = rehash({ ...created, schemaVersion: 'repo-run-event/v2' })
  fs.writeFileSync(paths.events, `${JSON.stringify(legacy)}\n`, 'utf8')

  assert.throws(() => materializeRunState([legacy]), /schemaVersion must be repo-run-event\/v3/)
  assert.throws(() => ensureWorkflow(packageDir), /schemaVersion must be repo-run-event\/v3/)
})

test('appendRunEvent rejects an event type outside the bundled v3 enum without creating a workflow', t => {
  const packageDir = temporaryPackage(t)

  assert.throws(
    () => appendRunEvent(packageDir, 'coverage-gap-added', { gapId: 'legacy:gap' }),
    /eventType is invalid: coverage-gap-added/,
  )
  assert.equal(fs.existsSync(workflowPaths(packageDir).events), false)
})

test('appendRunEvent rejects malformed critical lifecycle payloads', t => {
  const packageDir = temporaryPackage(t)
  ensureWorkflow(packageDir)
  const paths = workflowPaths(packageDir)

  assert.throws(
    () => appendRunEvent(packageDir, 'work-planned', {
      item: { schemaVersion: 'repo-work-item/v2', itemId: 'legacy:item' },
      itemPath: path.join(packageDir, 'work', 'items', 'legacy-item.json'),
    }),
    /work-planned payload\.item: schemaVersion must be repo-work-item\/v3/,
  )
  assert.throws(() => appendRunEvent(packageDir, 'work-issued', {}), /payload\.itemId must be a non-empty string/)
  assert.throws(() => appendRunEvent(packageDir, 'work-issued', { itemId: 'work:missing' }), /unknown WorkItem: work:missing/)
  assert.equal(readEvents(paths.events).length, 1)
})

test('planAndIssueWorkItem revalidates a caller-supplied item before writing or appending', t => {
  const packageDir = temporaryPackage(t)
  const state = ensureWorkflow(packageDir)
  const paths = workflowPaths(packageDir)
  const forged = {
    ...validWorkItem(state),
    bypassedCreateWorkItem: true,
  }

  assert.throws(() => planAndIssueWorkItem(packageDir, forged), /bypassedCreateWorkItem is not allowed/)
  assert.deepEqual(fs.readdirSync(paths.workItems), [])
  assert.equal(readEvents(paths.events).length, 1)
})

function temporaryPackage(t) {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-event-validation-'))
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }))
  return packageDir
}

function validWorkItem(state) {
  return {
    schemaVersion: 'repo-work-item/v3',
    itemId: 'work:caller-supplied',
    runId: state.runId,
    snapshotId: state.snapshotId,
    attempt: 1,
    kind: 'semantic-research',
    role: 'repo-explorer',
    contractRef: 'planning/contracts/contract.json',
    objectiveSummary: 'Resolve one bounded semantic question.',
    blocking: true,
    dependencies: [],
    completionPolicyRef: 'planning/contracts/contract.json#completionRules',
    inputArtifactRefs: ['planning/contracts/contract.json'],
    outputArtifactPath: 'research/outcome.json',
    outputSchemaRef: 'schemas/task-outcome.schema.json',
    communityIds: ['community:test'],
    neighborMapRef: null,
    blockingMapDimensions: ['core-journeys'],
    blockingJourneyIds: [],
    qualityClass: 'analytical',
    criticality: 'high',
    budgetHints: {},
    idempotencyKey: 'caller-supplied-idempotency-key',
    createdAt: '2026-07-13T00:00:00.000Z',
  }
}

function readEvents(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
}

function rehash(event) {
  const { eventHash: _eventHash, ...base } = event
  return {
    ...base,
    eventHash: createHash('sha256').update(JSON.stringify(base)).digest('hex'),
  }
}
