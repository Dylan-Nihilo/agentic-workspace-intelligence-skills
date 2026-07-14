#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildResearchContracts,
  qualifyOpenQuestions,
} from '../../packages/repo-understanding-kernel/src/planning/research-contract-planner.mjs'
import { staticProgramGraphContentHash } from '../../packages/repo-understanding-kernel/src/census/static-program-graph.mjs'
import { validateTaskOutcome } from '../../packages/repo-understanding-kernel/src/validation/task-outcome-validator.mjs'
import {
  installSemanticContracts,
  writeAcceptedNodeSemanticFixtureResults,
  writeSatisfiedWorkResult,
} from '../helpers/v3-workflow-fixture.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const harnessScript = path.join(repoRoot, 'packages', 'repo-understanding-cli', 'src', 'cli.mjs')
const fixtures = path.join(repoRoot, 'evals', 'fixtures')
const reactFixture = path.join(fixtures, 'react-mini-repo')
const journeyFixture = path.join(fixtures, 'journey-react-mini-repo')
const backendFixture = path.join(fixtures, 'node-api-mini-repo')
const fullstackFixture = path.join(fixtures, 'fullstack-mini-repo')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-v3-contract-eval-'))
const passedChecks = []

try {
  if (process.env.REPO_CONTRACT_EVAL_FORCE_FAILURE === '1') {
    throw new Error('Forced contract-eval failure for exit-code verification.')
  }
  assertBackendFailsClosed()
  assertFullstackScopesToFrontendSubtree()
  assertDeterministicGraphProvenance()
  assertQuestionRoutingAndResearchContracts()
  assertPartialTaskOutcomeIsRejected()
  assertPartialTaskOutcomeIsRejectedByCli()
  assertAnalyzeProducesOnlyV3Artifacts()
  assertProductMapsJourneyClosureAndFreshness()

  console.log(JSON.stringify({
    schemaVersion: 'repo-understanding-contract-eval/v3',
    passed: true,
    checks: passedChecks,
  }, null, 2))
  fs.rmSync(workDir, { recursive: true, force: true })
} catch (error) {
  console.error(error.stack || error.message || String(error))
  console.error(`Contract eval workDir: ${workDir}`)
  process.exitCode = 1
}

function assertBackendFailsClosed() {
  const scoutPackage = path.join(workDir, 'backend-scout')
  const scout = runHarnessJson(['scout', '--repo', backendFixture, '--out', scoutPackage])

  assert.equal(scout.schemaVersion, 'repo-frontend-scout/v1')
  assert.equal(scout.nextAction, 'unsupported')
  assert.equal(scout.supportDecision.supportLevel, 'unsupported')
  assert.equal(scout.supportDecision.repoKind, 'backend')
  assert.equal(scout.supportDecision.unsupportedReason, 'backend-repository')
  assert.deepEqual(scout.staticProgramGraph.nodes, [])
  assert.deepEqual(scout.staticProgramGraph.edges, [])
  assert(scout.staticProgramGraph.diagnostics.some(item => item.kind === 'unsupported-repository'))

  const analyzePackage = path.join(workDir, 'backend-analyze')
  runHarness(['analyze', '--repo', backendFixture, '--out', analyzePackage])
  assert.equal(fs.existsSync(path.join(analyzePackage, 'planning', 'manifest.json')), false)
  const backendState = readJson(path.join(analyzePackage, 'state', 'run-state.json'))
  assert.equal(Object.keys(backendState.workItems || {}).length, 0)
  assert.equal(listFiles(analyzePackage).some(file => file.startsWith('work/items/') || file.startsWith('work/results/')), false)
  assert.equal(fs.existsSync(path.join(analyzePackage, 'projections')), false)
  runHarness(['project', '--package', analyzePackage, '--only', 'maps'], { expectNonZero: true })
  pass('backend:fail-closed')
}

function assertFullstackScopesToFrontendSubtree() {
  const packageDir = path.join(workDir, 'fullstack-scout')
  const scout = runHarnessJson(['scout', '--repo', fullstackFixture, '--out', packageDir])
  const decision = scout.supportDecision
  const graph = scout.staticProgramGraph

  assert.equal(decision.supportLevel, 'frontend-subtree-only')
  assert.equal(decision.repoKind, 'fullstack')
  assert.deepEqual(decision.frontendRoots, ['apps/web'])
  assert(decision.backendRoots.includes('services/api'))
  assert.deepEqual(graph.roots, ['apps/web'])
  assert(graph.files.length > 0)

  for (const file of graph.files) {
    assert(isInsideRepoRoot(file.sourcePath, 'apps/web'), `Static graph parsed a non-frontend file: ${file.sourcePath}`)
  }
  for (const item of [...graph.nodes, ...graph.edges]) {
    const sourcePath = item.source?.sourcePath
    if (sourcePath) assert(isInsideRepoRoot(sourcePath, 'apps/web'), `Graph provenance escaped frontend subtree: ${sourcePath}`)
    assert.equal(String(item.nodeId || item.edgeId).includes('services/api'), false)
  }
  pass('fullstack:frontend-subtree-only')
}

function assertDeterministicGraphProvenance() {
  const first = runHarnessJson([
    'scout', '--repo', reactFixture, '--out', path.join(workDir, 'react-scout-a'),
  ]).staticProgramGraph
  const second = runHarnessJson([
    'scout', '--repo', reactFixture, '--out', path.join(workDir, 'react-scout-b'),
  ]).staticProgramGraph

  assert.equal(first.schemaVersion, 'repo-static-program-graph/v1')
  assert.equal(first.parser.mode, 'compiler')
  assert(first.files.some(file => ['compiler-ast', 'parser-ast'].includes(file.sourceKind)))
  assert(first.edges.some(edge => edge.type === 'imports'))
  assert.equal(staticProgramGraphContentHash(first), staticProgramGraphContentHash(second))

  for (const item of [...first.nodes, ...first.edges]) assertSourceProvenance(item)
  pass('static-program-graph:deterministic-provenance')
}

function assertQuestionRoutingAndResearchContracts() {
  const generatedAt = '2026-07-13T00:00:00.000Z'
  const frame = {
    schemaVersion: 'repo-investigation-frame/v1',
    frameId: 'frame:v3-contract-eval',
    snapshotId: 'snapshot:v3-contract-eval',
    applicationRoot: { entityId: 'file:src/AuthProvider.tsx', sourcePath: 'src/AuthProvider.tsx' },
    browserBootstrap: { entryEntityId: 'bootstrap:src/main.tsx', entryPath: 'src/main.tsx' },
    pageCandidates: [],
    routeRoots: [],
    deterministicDiagnostics: [{
      diagnosticId: 'diagnostic:existing-parser-failure',
      kind: 'parser-failure',
      severity: 'warning',
      message: 'A parser diagnostic remains deterministic work.',
      sourcePath: 'src/Broken.tsx',
      evidenceRefs: ['evidence:file:src/Broken.tsx'],
    }],
    unresolvedSemanticAmbiguities: [
      {
        type: 'semantic-ambiguity',
        question: 'Which component owns the authenticated user state?',
        rationale: 'The owner changes Application and Runtime Flow maps.',
        relatedEntityIds: ['file:src/AuthProvider.tsx', 'file:src/store.ts'],
        allowedFiles: ['src/AuthProvider.tsx', 'src/store.ts'],
        targetMaps: ['application', 'runtime-flow'],
        targetMapDimensions: ['state-ownership-data-flow', 'auth-permission'],
        competingHypotheses: [
          hypothesis('AuthProvider owns authenticated user state.', 'src/AuthProvider.tsx'),
          hypothesis('The global store owns authenticated user state.', 'src/store.ts'),
        ],
      },
      {
        type: 'runtime-external-blocked',
        question: 'Which auth provider is active in the deployed browser session?',
        rationale: 'This requires a live authenticated runtime trace.',
        runtimeRequired: true,
        targetMaps: ['runtime-flow'],
        targetMapDimensions: ['auth-permission'],
        relatedEntityIds: ['file:src/AuthProvider.tsx'],
        competingHypotheses: [
          hypothesis('The local provider is active.', 'src/AuthProvider.tsx'),
          hypothesis('An injected provider is active.', 'runtime:provider'),
        ],
      },
      {
        type: 'product-intent',
        question: 'What business outcome defines a successful sign-in?',
        rationale: 'Product intent cannot be invented from source structure.',
        productIntentRequired: true,
        targetMaps: ['experience'],
        targetMapDimensions: ['core-journeys'],
        relatedEntityIds: ['file:src/Login.tsx'],
      },
      {
        code: 'import-resolution-failure',
        question: 'Why did an import fail to resolve?',
        evidenceRefs: ['evidence:file:src/Broken.tsx'],
      },
    ],
  }

  const qualified = qualifyOpenQuestions({
    investigationFrame: frame,
    snapshotId: frame.snapshotId,
    generatedAt,
  })
  const contracts = buildResearchContracts({
    snapshotId: frame.snapshotId,
    investigationFrame: frame,
    openQuestions: qualified.openQuestions,
    generatedAt,
  })

  const semantic = qualified.openQuestions.filter(item => item.category === 'semantic-ambiguity')
  const external = qualified.openQuestions.filter(item => ['runtime-external-blocked', 'product-intent'].includes(item.category))
  assert.equal(semantic.length, 1)
  assert.equal(external.length, 2)
  assert(external.every(item => item.lifecycleStatus === 'blocked'))
  assert.equal(contracts.length, 1)
  assert.deepEqual(contracts[0].questions.map(item => item.questionId), [semantic[0].questionId])
  assert(contracts[0].hypotheses.length >= 2)
  assert.equal(contracts.some(contract => contract.questions.some(question => external.some(item => item.questionId === question.questionId))), false)
  assert(qualified.deterministicDiagnostics.some(item => item.kind === 'import-resolution-failure'))
  pass('research-contract:semantic-only')
  pass('questions:runtime-and-product-intent-not-dispatched')
}

function assertPartialTaskOutcomeIsRejected() {
  const { contract, outcome, workResult } = taskOutcomeFixture()
  outcome.status = 'partially-satisfied'
  outcome.questionOutcomes[0].status = 'partially-satisfied'
  outcome.questionOutcomes[0].unmetCriteria = ['Adjudicate the remaining owner hypothesis.']
  outcome.unmetCriteria = ['Adjudicate the remaining owner hypothesis.']
  workResult.outcomeStatus = 'partially-satisfied'

  const validation = validateTaskOutcome({ contract, outcome, workResult })
  assert.equal(validation.acceptance.accepted, false)
  assert.equal(validation.acceptance.decision, 'reject')
  assert(validation.issues.some(issue => issue.code === 'COMPLETED_RESULT_DID_NOT_SATISFY_CONTRACT'))
  assert.equal(validation.events[0].eventType, 'task-outcome-rejected')
  pass('task-outcome:partial-completion-rejected')
}

function assertPartialTaskOutcomeIsRejectedByCli() {
  const packageDir = path.join(workDir, 'partial-outcome-cli')
  runHarness(['analyze', '--repo', fullstackFixture, '--out', packageDir])
  installSemanticContracts(packageDir)
  const dispatch = runHarnessJson(['dispatch', '--package', packageDir])
  assert.equal(dispatch.workItems.length, 1)
  const item = readJson(dispatch.workItems[0].workItemPath)
  const produced = writeSatisfiedWorkResult(packageDir, item)

  produced.outcome.status = 'partially-satisfied'
  produced.outcome.questionOutcomes[0].status = 'partially-satisfied'
  produced.outcome.questionOutcomes[0].unmetCriteria = ['Adjudicate the remaining owner hypothesis.']
  produced.outcome.unmetCriteria = ['Adjudicate the remaining owner hypothesis.']
  writeJson(item.outputArtifactPath, produced.outcome)
  produced.workResult.outcomeStatus = 'partially-satisfied'
  produced.workResult.artifactHashes[0].value = hashFile(item.outputArtifactPath)
  writeJson(produced.workResultPath, produced.workResult)

  const rejected = runHarnessJson([
    'ingest', '--package', packageDir, '--work-result', produced.workResultPath,
  ], { expectExit: 2 })
  assert.equal(rejected.merged, false)
  assert.equal(rejected.workStatus, 'rejected')
  assert(rejected.issues.some(issue => issue.code === 'COMPLETED_RESULT_DID_NOT_SATISFY_CONTRACT'))
  const state = readJson(path.join(packageDir, 'state', 'run-state.json'))
  assert.equal(state.workItems[item.itemId].status, 'rejected')
  assert.equal(fs.readFileSync(path.join(packageDir, 'store', 'claims.jsonl'), 'utf8').trim(), '')
  pass('task-outcome:partial-completion-rejected-by-cli')
}

function assertAnalyzeProducesOnlyV3Artifacts() {
  const packageDir = path.join(workDir, 'react-analyze')
  runHarness(['analyze', '--repo', reactFixture, '--out', packageDir])

  const plan = readJson(path.join(packageDir, 'planning', 'manifest.json'))
  const questions = readJson(path.join(packageDir, 'planning', 'open-questions.json'))
  const state = readJson(path.join(packageDir, 'state', 'run-state.json'))
  const productIntent = questions.questions.filter(question => question.category === 'product-intent')

  assert.equal(productIntent.length, 0, 'Analyze must not manufacture one product-intent template per Journey candidate.')
  assert.equal(plan.contractRefs.length, 0)
  assert.equal(Object.keys(state.workItems || {}).length, 0)
  runHarness(['dispatch', '--package', packageDir], { expectNonZero: true })
  assertNoLegacyGapOrCoverageArtifacts(packageDir)
  pass('analyze:no-template-product-intent-work')
  pass('artifacts:no-gap-or-coverage-v2')
}

function assertProductMapsJourneyClosureAndFreshness() {
  const packageDir = path.join(workDir, 'product-maps')
  runHarness(['analyze', '--repo', journeyFixture, '--out', packageDir])
  installAcceptedNodeSemanticFixture(packageDir)
  const graph = readJson(path.join(packageDir, 'static', 'static-program-graph.json'))
  const journeyId = readJson(path.join(packageDir, 'store', 'journeys', 'manifest.json')).entries[0]?.journeyId
  assert(journeyId, 'Journey fixture must expose a deterministic Journey candidate.')

  const openStatus = runHarnessJson(['status', '--package', packageDir])
  assert.equal(openStatus.nextAction, 'blocked')
  assert.equal(openStatus.workflow.stopReason, 'journey-closure-incomplete')
  assert.equal(openStatus.validation.gates.journeys.current, false)
  const openJourneyVerification = runHarnessJson(['verify', '--package', packageDir], { expectExit: 2 })
  assert.equal(openJourneyVerification.passed, false)
  assert(openJourneyVerification.issues.some(issue => issue.code === 'journey-closure-incomplete'))
  const eventFile = path.join(packageDir, 'store', 'run-events.jsonl')
  const eventsBeforeRejectedProjection = fs.readFileSync(eventFile, 'utf8')
  const rejectedProjection = runHarness(['project', '--package', packageDir, '--only', 'maps'], { expectNonZero: true })
  assert.match(`${rejectedProjection.stdout}${rejectedProjection.stderr}`, /Journey closure is incomplete/i)
  assert.equal(fs.existsSync(path.join(packageDir, 'projections', 'manifest.json')), false)
  assert.equal(fs.readFileSync(eventFile, 'utf8'), eventsBeforeRejectedProjection)

  const closed = completeCriticalJourney(graph, journeyId)
  const definitionsPath = path.join(workDir, 'closed-journey-definitions.json')
  const bindingsPath = path.join(workDir, 'closed-journey-bindings.json')
  writeJson(definitionsPath, [closed.definition])
  writeJson(bindingsPath, [closed.bindingSet])
  const imported = runHarnessJson(['journeys', '--package', packageDir, '--definitions', definitionsPath, '--bindings', bindingsPath])
  assert.equal(imported.schemaVersion, 'repo-journey-import-result/v1')
  assert.deepEqual(imported.resolvedQuestionIds, [])
  assert.equal(imported.nextAction, 'project')
  const repeated = runHarnessJson(['journeys', '--package', packageDir, '--definitions', definitionsPath, '--bindings', bindingsPath])
  assert.deepEqual(repeated.resolvedQuestionIds, [])

  assert.equal(runHarnessJson(['status', '--package', packageDir]).nextAction, 'project')
  const projected = runHarnessJson(['project', '--package', packageDir, '--only', 'maps'])
  assert.equal(projected.schemaVersion, 'repo-product-projection-result/v1')
  assert.equal(projected.maps.verificationPath, path.join(packageDir, 'verification', 'frontend-verification.json'))
  const manifest = readJson(path.join(packageDir, 'projections', 'manifest.json'))
  const persistedProjectionVerification = readJson(projected.maps.verificationPath)
  assert.equal(persistedProjectionVerification.phase, 'projection')
  assert.equal(persistedProjectionVerification.passed, true)
  assert.equal(persistedProjectionVerification.gates.journeys.current, true)
  assert.equal(persistedProjectionVerification.gates.productMaps.current, true)
  const expectedMaps = {
    application: ['application-map.json', 'repo-application-map/v1'],
    experience: ['experience-map.json', 'repo-experience-map/v1'],
    runtimeFlow: ['runtime-flow-map.json', 'repo-runtime-flow-map/v1'],
    change: ['change-map.json', 'repo-change-map/v1'],
  }
  assert.deepEqual(Object.keys(manifest.projections).sort(), Object.keys(expectedMaps).sort())
  for (const [key, [fileName, schemaVersion]] of Object.entries(expectedMaps)) {
    const entry = manifest.projections[key]
    assert.equal(path.basename(entry.path), fileName)
    assert.equal(entry.schemaVersion, schemaVersion)
    assert.match(entry.contentHash, /^[a-f0-9]{64}$/)
    assert.equal(readJson(path.resolve(packageDir, entry.path)).schemaVersion, schemaVersion)
  }

  const secondPackageDir = path.join(workDir, 'product-maps-determinism')
  runHarness(['analyze', '--repo', journeyFixture, '--out', secondPackageDir])
  installAcceptedNodeSemanticFixture(secondPackageDir)
  const secondGraph = readJson(path.join(secondPackageDir, 'static', 'static-program-graph.json'))
  const secondJourneyId = readJson(path.join(secondPackageDir, 'store', 'journeys', 'manifest.json')).entries[0]?.journeyId
  assert(secondJourneyId, 'Second deterministic package has no Journey candidate.')
  const secondClosed = completeCriticalJourney(secondGraph, secondJourneyId)
  const secondDefinitionsPath = path.join(workDir, 'closed-journey-definitions-second.json')
  const secondBindingsPath = path.join(workDir, 'closed-journey-bindings-second.json')
  writeJson(secondDefinitionsPath, [secondClosed.definition])
  writeJson(secondBindingsPath, [secondClosed.bindingSet])
  runHarnessJson(['journeys', '--package', secondPackageDir, '--definitions', secondDefinitionsPath, '--bindings', secondBindingsPath])
  runHarnessJson(['project', '--package', secondPackageDir, '--only', 'maps'])
  const secondManifest = readJson(path.join(secondPackageDir, 'projections', 'manifest.json'))
  assert.deepEqual(secondManifest.projectionKey, manifest.projectionKey)
  for (const key of Object.keys(expectedMaps)) {
    assert.equal(secondManifest.projections[key].contentHash, manifest.projections[key].contentHash, `${key} Product Map changed across identical snapshots.`)
  }

  const closedVerification = runHarnessJson(['verify', '--package', packageDir])
  assert.equal(closedVerification.passed, true)
  assert.equal(closedVerification.gates.journeys.current, true)
  assert.equal(closedVerification.gates.productMaps.current, true)

  const applicationPath = path.join(packageDir, 'projections', 'application-map.json')
  const tamperedApplication = readJson(applicationPath)
  tamperedApplication.application.kind = 'tampered-contract-eval'
  writeJson(applicationPath, tamperedApplication)
  const contentHashFailure = runHarnessJson(['verify', '--package', packageDir], { expectExit: 2 })
  assert(contentHashFailure.issues.some(issue => issue.code === 'product-map-hash-mismatch'))

  runHarnessJson(['project', '--package', packageDir, '--only', 'maps'])
  const changedDefinition = {
    ...closed.definition,
    title: 'Complete checkout with changed authoritative intent',
    goal: 'Submit an order and observe the changed authoritative outcome.',
  }
  writeJson(definitionsPath, [changedDefinition])
  runHarnessJson(['journeys', '--package', packageDir, '--definitions', definitionsPath, '--bindings', bindingsPath])
  const staleKeyFailure = runHarnessJson(['verify', '--package', packageDir], { expectExit: 2 })
  assert(staleKeyFailure.issues.some(issue => issue.code === 'product-map-key-stale'))

  runHarnessJson(['project', '--package', packageDir, '--only', 'maps'])
  assert.equal(runHarnessJson(['verify', '--package', packageDir]).passed, true)
  pass('journeys:closure-gates-projection')
  pass('product-maps:four-current-projections')
  pass('product-maps:cross-run-deterministic')
  pass('product-maps:content-and-input-hash-staleness')
}

function installAcceptedNodeSemanticFixture(packageDir) {
  const planResult = runHarnessJson(['semantic-plan', '--package', packageDir])
  const plan = readJson(planResult.planPath)
  writeAcceptedNodeSemanticFixtureResults(packageDir, plan)
  const ingest = runHarnessJson(['semantic-ingest', '--package', packageDir])
  assert.equal(ingest.status, 'complete')
  assert.equal(ingest.acceptedFiles, plan.eligibleFileCount)
}

function completeCriticalJourney(graph, journeyId) {
  const snapshotId = graph.snapshotId
  const generatedAt = graph.generatedAt
  const entities = {
    page: requireGraphNode(graph, 'page'),
    event: requireGraphNode(graph, 'ui-event'),
    handler: requireGraphNode(graph, 'handler'),
    state: requireGraphNode(graph, 'state'),
    request: requireGraphNode(graph, 'request'),
    endpoint: requireGraphNode(graph, 'endpoint'),
    response: requireGraphNode(graph, 'response'),
    feedback: requireGraphNode(graph, 'feedback-candidate', node => /order created/i.test(node.label)),
    outcome: requireGraphNode(graph, 'outcome-candidate', node => /checkout complete/i.test(node.label)),
    failure: requireGraphNode(graph, 'outcome-candidate', node => /checkout failed/i.test(node.label)),
  }
  const evidenceIds = journeyEvidence(Object.values(entities))
  const steps = [
    step('entry', 1, 'Enter checkout'),
    step('action', 2, 'Submit checkout'),
    step('handler', 3, 'Handle checkout'),
    step('state', 4, 'Record pending state'),
    { ...step('request', 5, 'Request order creation'), branchIds: ['branch:failure'] },
    step('response', 6, 'Receive order response'),
    step('feedback', 7, 'Show order feedback'),
    step('outcome', 8, 'Complete order'),
    step('failure', 9, 'Show order failure'),
  ]
  const bindings = [
    binding('page', 'entry', 1, 'page', entities.page),
    binding('event', 'action', 2, 'event', entities.event),
    binding('handler', 'handler', 3, 'handler', entities.handler),
    binding('state', 'state', 4, 'state-transition', entities.state),
    binding('request', 'request', 5, 'request', entities.request),
    binding('endpoint', 'request', 5, 'endpoint', entities.endpoint),
    binding('response', 'response', 6, 'response', entities.response),
    binding('feedback', 'feedback', 7, 'feedback', entities.feedback),
    binding('outcome', 'outcome', 8, 'outcome', entities.outcome),
    binding('failure', 'failure', 9, 'outcome', entities.failure, 'branch:failure'),
  ]
  const definition = {
    schemaVersion: 'repo-journey-definition/v1',
    journeyId,
    snapshotId,
    title: 'Complete checkout',
    actor: 'authenticated-customer',
    goal: 'Submit an order and receive visible confirmation.',
    trigger: {
      kind: 'user-action',
      description: 'The customer submits checkout.',
      entityId: entities.event.nodeId,
      evidenceIds: entities.event.evidenceRefs,
      claimIds: [],
    },
    entry: {
      routeId: null,
      pageId: entities.page.nodeId,
      sourcePath: entities.page.source.sourcePath,
      evidenceIds: entities.page.evidenceRefs,
      claimIds: [],
    },
    steps,
    branches: [{
      branchId: 'branch:failure',
      fromStepId: 'step:request',
      condition: 'The order request fails.',
      nextStepId: 'step:failure',
      kind: 'failure',
      evidenceIds,
      claimIds: [],
    }],
    visibleFeedback: [{
      feedbackId: 'feedback:order-created',
      stepId: 'step:feedback',
      kind: 'success',
      description: 'Order confirmation is visible.',
      evidenceIds,
      claimIds: [],
    }],
    successOutcome: {
      outcomeId: 'outcome:order-created',
      stepId: 'step:outcome',
      description: 'The order is created and confirmation is visible.',
      evidenceIds,
      claimIds: [],
    },
    failureOutcomes: [{
      outcomeId: 'outcome:order-failed',
      stepId: 'step:failure',
      branchId: 'branch:failure',
      description: 'The order remains uncreated and failure feedback is visible.',
      evidenceIds,
      claimIds: [],
    }],
    evidenceIds,
    claimIds: [],
    criticality: 'critical',
    status: 'closed',
    createdAt: generatedAt,
    updatedAt: generatedAt,
  }
  const bindingSet = {
    schemaVersion: 'repo-journey-binding/v1',
    bindingSetId: `binding-set:${journeyId.replace(/^journey:/, '')}`,
    journeyId: definition.journeyId,
    snapshotId,
    bindings,
    relations: [
      relation('page', 'event', 'next'),
      relation('event', 'handler', 'handles'),
      relation('handler', 'state', 'writes'),
      relation('handler', 'request', 'requests'),
      relation('request', 'endpoint', 'requests'),
      relation('endpoint', 'response', 'resolves'),
      relation('response', 'feedback', 'shows'),
      relation('feedback', 'outcome', 'produces'),
      relation('request', 'failure', 'produces', 'branch:failure'),
    ],
    status: 'closed',
    generatedAt,
  }
  return { definition, bindingSet }
}

function step(id, order, title) {
  return {
    stepId: `step:${id}`,
    order,
    title,
    description: title,
    branchIds: [],
    blocking: true,
    evidenceIds: ['evidence:file:src/pages/CheckoutPage.tsx'],
    claimIds: [],
  }
}

function binding(id, stepId, order, bindingType, entity, branchId = null) {
  return {
    bindingId: `binding:${id}`,
    stepId: `step:${stepId}`,
    order,
    branchId,
    bindingType,
    entityId: entity.nodeId,
    entityType: entity.kind,
    sourcePath: entity.source.sourcePath,
    evidenceIds: entity.evidenceRefs,
    claimIds: [],
    confidence: 1,
    status: 'confirmed',
  }
}

function relation(from, to, kind, branchId = null) {
  return {
    fromBindingId: `binding:${from}`,
    toBindingId: `binding:${to}`,
    kind,
    branchId,
    evidenceIds: ['evidence:file:src/pages/CheckoutPage.tsx'],
    claimIds: [],
  }
}

function requireGraphNode(graph, kind, predicate = () => true) {
  const node = graph.nodes.find(candidate => candidate.kind === kind && predicate(candidate))
  assert(node, `Journey fixture Static Program Graph is missing ${kind}.`)
  assert(node.evidenceRefs?.length, `Journey fixture ${node.nodeId} has no evidence.`)
  return node
}

function journeyEvidence(nodes) {
  return [...new Set(nodes.flatMap(node => node.evidenceRefs || []))].sort()
}

function questionResolutionCount(packageDir, questionId) {
  return fs.readFileSync(path.join(packageDir, 'store', 'run-events.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse)
    .filter(event => event.eventType === 'question-resolved' && event.payload.questionId === questionId)
    .length
}

function taskOutcomeFixture() {
  const contract = {
    schemaVersion: 'repo-research-contract/v1',
    contractId: 'contract:auth-owner',
    questions: [{
      questionId: 'question:auth-owner',
      blocking: true,
      completionCriteria: ['Identify the owner and adjudicate both hypotheses.'],
    }],
    hypotheses: [
      contractHypothesis('hypothesis:store', 'The store owns auth state.', 'src/store.ts'),
      contractHypothesis('hypothesis:provider', 'The provider owns auth state.', 'src/AuthProvider.tsx'),
    ],
    scope: {
      communityIds: ['community:auth'],
      entryEntities: ['src/AuthProvider.tsx'],
      allowedFiles: ['src/AuthProvider.tsx', 'src/store.ts'],
      neighborDepth: 1,
    },
    acceptanceCriteria: [{
      criterionId: 'criterion:auth-owner',
      questionIds: ['question:auth-owner'],
      hypothesisIds: ['hypothesis:store', 'hypothesis:provider'],
      blocking: true,
      minimumEvidenceCount: 2,
    }],
    budgetHints: { maxFiles: 2 },
  }
  const outcome = {
    schemaVersion: 'repo-task-outcome/v1',
    contractId: contract.contractId,
    status: 'satisfied',
    questionOutcomes: [{
      questionId: 'question:auth-owner',
      status: 'satisfied',
      answer: 'AuthProvider owns auth state.',
      supportEvidenceIds: ['evidence:provider'],
      counterEvidenceIds: ['evidence:store'],
      hypothesisIds: ['hypothesis:store', 'hypothesis:provider'],
      satisfiedCriteria: ['Identify the owner and adjudicate both hypotheses.'],
      unmetCriteria: [],
      blockerQuestionIds: [],
      confidence: 0.95,
    }],
    hypotheses: [
      outcomeHypothesis(contract, 'hypothesis:store', 'The store owns auth state.', 'src/store.ts', 'refuted', [], ['evidence:store']),
      outcomeHypothesis(contract, 'hypothesis:provider', 'The provider owns auth state.', 'src/AuthProvider.tsx', 'supported', ['evidence:provider'], []),
    ],
    newSemanticQuestions: [],
    deterministicDiagnostics: [],
    runtimeBlockers: [],
    productIntentQuestions: [],
    completionEvidence: ['evidence:provider', 'evidence:store'],
    unmetCriteria: [],
    scopeObserved: {
      communityIds: ['community:auth'],
      entryEntities: ['src/AuthProvider.tsx'],
      filesRead: ['src/AuthProvider.tsx', 'src/store.ts'],
      neighborDepth: 1,
    },
  }
  const workResult = {
    schemaVersion: 'repo-work-result/v3',
    contractId: contract.contractId,
    status: 'completed',
    outcomeStatus: 'satisfied',
    readSet: [{ path: 'src/AuthProvider.tsx' }, { path: 'src/store.ts' }],
    scopeViolations: [],
  }
  return { contract, outcome, workResult }
}

function contractHypothesis(hypothesisId, statement, subject) {
  return {
    hypothesisId,
    questionId: 'question:auth-owner',
    statement,
    subject,
    predicate: 'owns',
    object: 'auth-state',
    hypothesisType: 'state-owner',
  }
}

function outcomeHypothesis(contract, hypothesisId, statement, subject, status, supportEvidenceIds, counterEvidenceIds) {
  return {
    schemaVersion: 'repo-hypothesis/v1',
    hypothesisId,
    contractId: contract.contractId,
    questionId: 'question:auth-owner',
    statement,
    subject,
    predicate: 'owns',
    object: 'auth-state',
    hypothesisType: 'state-owner',
    supportEvidenceIds,
    counterEvidenceIds,
    qualifiers: {},
    confidence: 0.95,
    status,
    impact: { mapDimensions: ['auth-permission'], journeyIds: [] },
    followUpQuestionIds: [],
  }
}

function hypothesis(statement, subject) {
  return {
    statement,
    subject,
    predicate: 'owns',
    object: 'authenticated-user-state',
    hypothesisType: 'state-owner',
    expectedSupportEvidence: [`Direct source evidence in ${subject}.`],
    expectedCounterEvidence: [`Direct source evidence contradicting ownership in ${subject}.`],
    initialConfidence: 0.5,
  }
}

function assertSourceProvenance(item) {
  const id = item.nodeId || item.edgeId
  const source = item.source
  assert(source && typeof source === 'object', `${id} has no source provenance.`)
  assert(Object.hasOwn(source, 'range'), `${id} source provenance omits range.`)
  assert.equal(typeof source.provider, 'string', `${id} source provider is missing.`)
  assert(source.provider.length > 0, `${id} source provider is empty.`)
  assert.equal(typeof source.sourceKind, 'string', `${id} sourceKind is missing.`)
  assert(source.sourceKind.length > 0, `${id} sourceKind is empty.`)
  assert.match(source.structureFingerprint, /^structure:sha256:[a-f0-9]{64}$/)
  if (['compiler-ast', 'parser-ast'].includes(source.sourceKind)) assert(source.range, `${id} parser provenance omits its exact source range.`)
  if (!source.range) return
  for (const boundary of ['start', 'end']) {
    const position = source.range[boundary]
    assert(Number.isInteger(position.offset) && position.offset >= 0, `${id} ${boundary}.offset is invalid.`)
    assert(Number.isInteger(position.line) && position.line >= 1, `${id} ${boundary}.line is invalid.`)
    assert(Number.isInteger(position.column) && position.column >= 0, `${id} ${boundary}.column is invalid.`)
  }
  assert(source.range.end.offset >= source.range.start.offset, `${id} source range is reversed.`)
}

function assertNoLegacyGapOrCoverageArtifacts(packageDir) {
  const files = listFiles(packageDir)
  const forbiddenPaths = [
    'gap-queue.json',
    'store/gaps.jsonl',
    'store/knowledge-manifest.json',
    'verification.json',
    'views/fact-graph.json',
    'views/render-graph.json',
    'views/architecture.json',
    'views/domain.json',
    'views/flow.json',
  ]
  for (const relativePath of forbiddenPaths) {
    assert.equal(files.includes(relativePath), false, `Legacy artifact must not be generated: ${relativePath}`)
  }
  assert.equal(files.some(file => file.startsWith('exploration/')), false, 'Legacy exploration artifacts must not be generated.')

  const forbiddenContent = /repo-gap(?:-queue)?\/v\d|coverage-directed|"coverageScore"|"coverageThreshold"|"coverageEligible"|"gapQueue"|"openGaps"|"gapTasks"/i
  for (const relativePath of files.filter(file => /\.(?:json|jsonl|md|txt)$/i.test(file))) {
    const file = path.join(packageDir, relativePath)
    if (fs.statSync(file).size > 2 * 1024 * 1024) continue
    const match = fs.readFileSync(file, 'utf8').match(forbiddenContent)
    assert.equal(Boolean(match), false, `Legacy gap/coverage content remains in ${relativePath}: ${match?.[0] || ''}`)
  }
}

function runHarness(args, options = {}) {
  const result = spawnSync(process.execPath, [harnessScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (options.expectNonZero) {
    if (result.status === 0) throw commandFailure(args, result, 'a non-zero exit')
  } else {
    const expected = options.expectExit ?? 0
    if (result.status !== expected) throw commandFailure(args, result, `exit ${expected}`)
  }
  return result
}

function runHarnessJson(args, options = {}) {
  const result = runHarness(args, options)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`Expected JSON from harness ${args.join(' ')}:\n${result.stdout}\n${result.stderr}`)
  }
}

function commandFailure(args, result, expectation) {
  return new Error([
    `harness ${args.join(' ')} exited ${result.status}; expected ${expectation}.`,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n'))
}

function listFiles(root) {
  const output = []
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'))
    }
  }
  visit(root)
  return output.sort()
}

function isInsideRepoRoot(file, root) {
  return file === root || file.startsWith(`${root}/`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function pass(check) {
  passedChecks.push(check)
}
