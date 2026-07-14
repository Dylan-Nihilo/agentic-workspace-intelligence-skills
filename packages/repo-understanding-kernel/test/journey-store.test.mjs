import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  UNRESOLVED_PRODUCT_OUTCOME,
  buildJourneyStore,
  computeJourneySetHash,
  deriveJourneyCandidates,
  journeyStorePaths,
  loadJourneyStore,
  rebuildJourneyStore,
  validateJourneyStoreManifest,
  writeJourneyStore,
} from '../src/knowledge/journey-store.mjs'
import {
  JOURNEY_CLOSURE_DIMENSIONS,
  evaluateJourneyClosure,
  validateJourneyIntegrity,
} from '../src/planning/journey-closure.mjs'

const generatedAt = '2026-07-13T00:00:00.000Z'

test('derives deterministic candidates without inventing actor, goal, or product outcome', () => {
  const staticProgramGraph = {
    snapshotId: 'snapshot:candidate',
    supportLevel: 'supported-frontend',
    generatedAt,
    nodes: [{
      nodeId: 'route:checkout',
      kind: 'route',
      label: '/checkout',
      source: { sourcePath: 'src/routes.ts' },
      evidenceRefs: ['evidence:route'],
      attributes: {},
    }],
    edges: [],
  }
  const investigationFrame = {
    snapshotId: 'snapshot:candidate',
    generatedAt,
    coreFlowCandidates: [{
      candidateId: 'flow:checkout',
      title: '/checkout',
      entryEntityIds: ['route:checkout'],
      evidenceRefs: ['evidence:route'],
      confidence: 0.8,
    }],
    pageCandidates: [],
  }

  const first = deriveJourneyCandidates({ staticProgramGraph, investigationFrame })
  const second = deriveJourneyCandidates({ staticProgramGraph, investigationFrame })
  assert.deepEqual(second, first)
  assert.equal(first.definitions.length, 1)
  assert.equal(first.definitions[0].actor, 'unknown-actor')
  assert.match(first.definitions[0].goal, /^Unresolved product goal/)
  assert.equal(first.definitions[0].successOutcome.description, UNRESOLVED_PRODUCT_OUTCOME)
  assert.deepEqual(first.definitions[0].successOutcome.evidenceIds, [])
  assert.deepEqual(first.definitions[0].successOutcome.claimIds, [])

  const built = buildJourneyStore({
    snapshotId: 'snapshot:candidate',
    generatedAt,
    definitions: first.definitions,
    bindingSets: first.bindingSets,
  })
  assert.equal(built.validation.valid, true)
  assert.equal(built.manifest.entries[0].status, 'candidate')
  assert.equal(built.closureSet.canComplete, false)
  assert.equal(built.closureReports[0].dimensions.find(item => item.dimension === 'outcome').status, 'open')
})

test('resolves census file page candidates to confirmed Static Program Graph entities', () => {
  const staticProgramGraph = {
    snapshotId: 'snapshot:file-page',
    supportLevel: 'supported-frontend',
    generatedAt,
    nodes: [
      { nodeId: 'module:src/pages/Home.tsx', kind: 'module', source: { sourcePath: 'src/pages/Home.tsx' }, evidenceRefs: ['evidence:file:src/pages/Home.tsx'] },
      { nodeId: 'page:src/pages/Home.tsx:home', kind: 'page', source: { sourcePath: 'src/pages/Home.tsx' }, evidenceRefs: ['evidence:file:src/pages/Home.tsx'] },
    ],
    edges: [],
  }
  const investigationFrame = {
    snapshotId: 'snapshot:file-page',
    generatedAt,
    pageCandidates: [{
      entityId: 'file:src/pages/Home.tsx',
      sourcePath: 'src/pages/Home.tsx',
      evidenceRefs: ['evidence:file:src/pages/Home.tsx'],
      confidence: 0.75,
    }],
    coreFlowCandidates: [{
      candidateId: 'flow:home',
      title: 'Home',
      entryEntityIds: ['file:src/pages/Home.tsx'],
      evidenceRefs: ['evidence:file:src/pages/Home.tsx'],
      confidence: 0.55,
    }],
  }

  const derived = deriveJourneyCandidates({ staticProgramGraph, investigationFrame })
  assert.equal(derived.bindingSets[0].bindings[0].entityId, 'page:src/pages/Home.tsx:home')
  const built = buildJourneyStore({
    snapshotId: staticProgramGraph.snapshotId,
    generatedAt,
    staticProgramGraph,
    definitions: derived.definitions,
    bindingSets: derived.bindingSets,
  })
  assert.equal(built.validation.valid, true)
})

test('closes a critical journey only when all nine grounded dimensions are complete', () => {
  const { definition, bindingSet } = completeCriticalJourney()
  const report = evaluateJourneyClosure({ definition, bindingSet, evaluatedAt: generatedAt })

  assert.equal(report.status, 'closed')
  assert.equal(report.canClose, true)
  assert.equal(report.criticalGatePassed, true)
  assert.deepEqual(report.dimensions.map(item => item.dimension), JOURNEY_CLOSURE_DIMENSIONS)
  assert.ok(report.dimensions.every(item => item.required && item.status === 'closed'))
  assert.equal(report.metrics.closureRate, 1)
  assert.deepEqual(report.integrityIssues, [])
})

test('does not accept a declared closed critical journey with an open response dimension', () => {
  const { definition, bindingSet } = completeCriticalJourney()
  bindingSet.bindings = bindingSet.bindings.filter(binding => binding.bindingType !== 'response')
  bindingSet.relations = bindingSet.relations.filter(relation => !relation.fromBindingId.includes('response') && !relation.toBindingId.includes('response'))

  const report = evaluateJourneyClosure({ definition, bindingSet, evaluatedAt: generatedAt })
  assert.equal(report.canClose, false)
  assert.equal(report.status, 'open')
  assert.equal(report.criticalGatePassed, false)
  assert.equal(report.dimensions.find(item => item.dimension === 'response').status, 'open')
  assert(report.integrityIssues.some(item => item.code === 'CRITICAL_JOURNEY_CLOSED_WITH_GAPS'))

  const built = buildJourneyStore({
    snapshotId: definition.snapshotId,
    generatedAt,
    definitions: [definition],
    bindingSets: [bindingSet],
  })
  assert.equal(built.validation.valid, false)
  assert(built.validation.issues.some(item => item.includes('CRITICAL_JOURNEY_CLOSED_WITH_GAPS')))
})

test('requires confirmed static bindings to resolve to graph entities when a graph is supplied', () => {
  const { definition, bindingSet } = completeCriticalJourney()
  const staticProgramGraph = {
    nodes: bindingSet.bindings
      .filter(binding => binding.bindingId !== 'binding:event')
      .map(binding => ({ nodeId: binding.entityId })),
  }

  const report = evaluateJourneyClosure({
    definition,
    bindingSet,
    staticProgramGraph,
    evaluatedAt: generatedAt,
  })

  assert.equal(report.canClose, false)
  assert(report.integrityIssues.some(item => (
    item.code === 'BINDING_ENTITY_NOT_IN_STATIC_GRAPH'
    && item.message.includes('event:submit')
  )))
})

test('rejects broken step order, branch ownership, binding order, and relation endpoints', () => {
  const { definition, bindingSet } = completeCriticalJourney()
  definition.steps[1].order = 7
  definition.branches[0].nextStepId = 'step:ghost'
  definition.steps[4].branchIds = []
  bindingSet.bindings[0].order = 2
  bindingSet.relations.push({
    fromBindingId: 'binding:ghost',
    toBindingId: 'binding:outcome',
    kind: 'next',
    branchId: null,
    evidenceIds: ['evidence:ghost'],
    claimIds: [],
  })

  const codes = new Set(validateJourneyIntegrity({ definition, bindingSet }).map(item => item.code))
  assert(codes.has('STEP_ORDER_NOT_CONTIGUOUS'))
  assert(codes.has('BRANCH_NEXT_STEP_UNKNOWN'))
  assert(codes.has('BRANCH_NOT_OWNED_BY_SOURCE_STEP'))
  assert(codes.has('BINDING_ORDER_MISMATCH'))
  assert(codes.has('RELATION_FROM_BINDING_UNKNOWN'))
})

test('writes, loads, and rebuilds the authoritative store serially and deterministically', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-journey-store-'))
  const { definition, bindingSet } = completeCriticalJourney()
  const input = {
    packageDir,
    snapshotId: definition.snapshotId,
    generatedAt,
    definitions: [definition],
    bindingSets: [bindingSet],
  }

  const first = writeJourneyStore(input)
  const firstBytes = captureStoreBytes(first.paths.root)
  const second = writeJourneyStore(input)
  const secondBytes = captureStoreBytes(second.paths.root)
  assert.deepEqual(secondBytes, firstBytes)
  assert.equal(second.manifest.journeySetHash, first.manifest.journeySetHash)

  const loaded = loadJourneyStore(packageDir)
  assert.equal(loaded.validation.valid, true)
  assert.equal(loaded.manifest.counts.critical, 1)
  assert.equal(loaded.manifest.counts.criticalClosed, 1)
  assert.equal(validateJourneyStoreManifest({ ...loaded.manifest, unexpected: true }).some(item => item.includes('unexpected')), true)

  const temporallyChanged = {
    ...definition,
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
  }
  assert.equal(
    computeJourneySetHash({ definitions: [temporallyChanged], bindingSets: [{ ...bindingSet, generatedAt: '2030-01-01T00:00:00.000Z' }] }),
    computeJourneySetHash({ definitions: [definition], bindingSets: [bindingSet] }),
  )

  const paths = journeyStorePaths(packageDir)
  const entry = loaded.manifest.entries[0]
  const closureFile = path.resolve(packageDir, entry.closureReportPath)
  const tampered = JSON.parse(fs.readFileSync(closureFile, 'utf8'))
  tampered.status = 'open'
  fs.writeFileSync(closureFile, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
  assert.equal(loadJourneyStore(packageDir, { strict: false }).validation.valid, false)
  const rebuilt = rebuildJourneyStore(packageDir)
  assert.equal(rebuilt.manifest.journeySetHash, loaded.manifest.journeySetHash)
  assert.equal(loadJourneyStore(packageDir).validation.valid, true)

  fs.writeFileSync(path.join(paths.definitions, 'stale.json'), '{}\n', 'utf8')
  writeJourneyStore(input)
  assert.equal(fs.existsSync(path.join(paths.definitions, 'stale.json')), false)

  fs.writeFileSync(paths.lock, 'held\n', 'utf8')
  assert.throws(() => writeJourneyStore(input), /writer lock is already held/)
  fs.rmSync(paths.lock, { force: true })
  fs.rmSync(packageDir, { recursive: true, force: true })
})

function completeCriticalJourney() {
  const definition = {
    schemaVersion: 'repo-journey-definition/v1',
    journeyId: 'journey:checkout',
    snapshotId: 'snapshot:checkout',
    title: 'Complete checkout',
    actor: 'authenticated-customer',
    goal: 'Submit an order and receive confirmation.',
    trigger: {
      kind: 'user-action',
      description: 'The customer selects checkout.',
      entityId: 'ui:checkout-button',
      evidenceIds: ['evidence:trigger'],
      claimIds: ['claim:trigger-meaning'],
    },
    entry: {
      routeId: 'route:checkout',
      pageId: 'page:checkout',
      sourcePath: 'src/pages/Checkout.tsx',
      evidenceIds: ['evidence:entry'],
      claimIds: [],
    },
    steps: [
      step('step:entry', 1, 'Enter checkout'),
      step('step:action', 2, 'Submit checkout'),
      step('step:handler', 3, 'Handle submit'),
      step('step:state', 4, 'Store pending state'),
      { ...step('step:request', 5, 'Dispatch request'), branchIds: ['branch:failure'] },
      step('step:response', 6, 'Receive response'),
      step('step:feedback', 7, 'Show confirmation'),
      step('step:outcome', 8, 'Complete order'),
      step('step:failure', 9, 'Show failure'),
    ],
    branches: [{
      branchId: 'branch:failure',
      fromStepId: 'step:request',
      condition: 'The endpoint rejects the request.',
      nextStepId: 'step:failure',
      kind: 'failure',
      evidenceIds: ['evidence:failure-branch'],
      claimIds: [],
    }],
    visibleFeedback: [{
      feedbackId: 'feedback:confirmation',
      stepId: 'step:feedback',
      kind: 'success',
      description: 'The order confirmation is visible.',
      evidenceIds: ['evidence:feedback'],
      claimIds: ['claim:feedback-meaning'],
    }],
    successOutcome: {
      outcomeId: 'outcome:order-created',
      stepId: 'step:outcome',
      description: 'The order is created and the customer sees its identifier.',
      evidenceIds: ['evidence:outcome'],
      claimIds: ['claim:outcome-meaning'],
    },
    failureOutcomes: [{
      outcomeId: 'outcome:order-rejected',
      stepId: 'step:failure',
      branchId: 'branch:failure',
      description: 'The order remains uncreated and an error is shown.',
      evidenceIds: ['evidence:failure-outcome'],
      claimIds: ['claim:failure-meaning'],
    }],
    evidenceIds: ['evidence:entry', 'evidence:outcome'],
    claimIds: ['claim:outcome-meaning'],
    criticality: 'critical',
    status: 'closed',
    createdAt: generatedAt,
    updatedAt: generatedAt,
  }
  const bindings = [
    binding('binding:page', 'step:entry', 1, 'page', 'page:checkout'),
    binding('binding:event', 'step:action', 2, 'event', 'event:submit'),
    binding('binding:handler', 'step:handler', 3, 'handler', 'handler:submit'),
    binding('binding:state', 'step:state', 4, 'state-transition', 'state:pending'),
    binding('binding:request', 'step:request', 5, 'request', 'request:create-order'),
    binding('binding:endpoint', 'step:request', 5, 'endpoint', 'endpoint:create-order'),
    binding('binding:response', 'step:response', 6, 'response', 'response:create-order'),
    binding('binding:feedback', 'step:feedback', 7, 'feedback', 'feedback:confirmation'),
    binding('binding:outcome', 'step:outcome', 8, 'outcome', 'outcome:order-created', ['claim:outcome-meaning']),
    binding('binding:failure-outcome', 'step:failure', 9, 'outcome', 'outcome:order-rejected', ['claim:failure-meaning']),
  ]
  const bindingSet = {
    schemaVersion: 'repo-journey-binding/v1',
    bindingSetId: 'binding-set:checkout',
    journeyId: definition.journeyId,
    snapshotId: definition.snapshotId,
    bindings,
    relations: [
      relation('binding:page', 'binding:event', 'next'),
      relation('binding:event', 'binding:handler', 'handles'),
      relation('binding:handler', 'binding:state', 'writes'),
      relation('binding:state', 'binding:request', 'requests'),
      relation('binding:request', 'binding:endpoint', 'requests'),
      relation('binding:endpoint', 'binding:response', 'resolves'),
      relation('binding:response', 'binding:feedback', 'shows'),
      relation('binding:feedback', 'binding:outcome', 'produces'),
      relation('binding:request', 'binding:failure-outcome', 'produces', 'branch:failure', ['evidence:failure-binding']),
    ],
    status: 'closed',
    generatedAt,
  }
  return { definition, bindingSet }
}

function step(stepId, order, title) {
  return {
    stepId,
    order,
    title,
    description: `${title} with grounded repository evidence.`,
    branchIds: [],
    blocking: true,
    evidenceIds: [`evidence:${stepId}`],
    claimIds: [],
  }
}

function binding(bindingId, stepId, order, bindingType, entityId, claimIds = []) {
  return {
    bindingId,
    stepId,
    order,
    branchId: null,
    bindingType,
    entityId,
    entityType: bindingType,
    sourcePath: 'src/pages/Checkout.tsx',
    evidenceIds: [`evidence:${bindingId}`],
    claimIds,
    confidence: 0.95,
    status: 'confirmed',
  }
}

function relation(fromBindingId, toBindingId, kind, branchId = null, evidenceIds = ['evidence:relation']) {
  return { fromBindingId, toBindingId, kind, branchId, evidenceIds, claimIds: [] }
}

function captureStoreBytes(root) {
  const result = {}
  for (const directory of ['definitions', 'bindings', 'closure']) {
    for (const entry of fs.readdirSync(path.join(root, directory)).sort()) {
      result[`${directory}/${entry}`] = fs.readFileSync(path.join(root, directory, entry), 'utf8')
    }
  }
  result['manifest.json'] = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')
  return result
}
