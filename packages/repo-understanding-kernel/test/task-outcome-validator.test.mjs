import assert from 'node:assert/strict'
import test from 'node:test'

import { validateTaskOutcome } from '../src/validation/task-outcome-validator.mjs'

test('accepts only a fully satisfied, evidenced, in-scope contract outcome', () => {
  const { contract, outcome, workResult } = fixture()
  const result = validateTaskOutcome({ contract, outcome, workResult })

  assert.equal(result.valid, true)
  assert.equal(result.acceptance.accepted, true)
  assert.equal(result.acceptance.decision, 'accept')
  assert.deepEqual(result.events.map(event => event.eventType), [
    'task-outcome-accepted',
    'question-resolved',
    'hypothesis-refuted',
    'hypothesis-supported',
  ])
  assert.equal(result.acceptedData.hypotheses.length, 2)
})

test('accepts deterministic context reads recorded by WorkResult without charging them to the source file budget', () => {
  const { contract, outcome, workResult } = fixture()
  contract.deterministicContextRefs = ['static/static-program-graph.json', 'static/neighbor-map.json']
  contract.budgetHints = { maxFiles: 2 }
  workResult.readSet.push(...contract.deterministicContextRefs.map(path => ({ path })))

  const result = validateTaskOutcome({ contract, outcome, workResult })

  assert.equal(result.acceptance.accepted, true, JSON.stringify(result.issues, null, 2))
  assert.deepEqual(result.scope.allowedContextRefs, [...contract.deterministicContextRefs].sort())
  assert.deepEqual(result.scope.filesRead, [
    'src/AuthProvider.tsx',
    'src/store.ts',
  ])
})

test('rejects TaskOutcome evidence that is absent from the governed Evidence store', () => {
  const { contract, outcome, workResult } = fixture()
  const governedEvidenceIds = outcome.completionEvidence.slice(0, -1)

  const result = validateTaskOutcome({ contract, outcome, workResult, governedEvidenceIds })

  assert.equal(result.acceptance.accepted, false)
  assert(result.issues.some(issue => issue.code === 'EVIDENCE_NOT_GOVERNED'))
})

test('does not treat completed execution as contract completion when the outcome is partial', () => {
  const { contract, outcome, workResult } = fixture()
  outcome.status = 'partially-satisfied'
  outcome.questionOutcomes[0].status = 'partially-satisfied'
  outcome.questionOutcomes[0].unmetCriteria = ['Resolve the competing runtime owner.']
  outcome.unmetCriteria = ['Resolve the competing runtime owner.']
  workResult.outcomeStatus = 'partially-satisfied'

  const result = validateTaskOutcome(contract, outcome, workResult)

  assert.equal(result.acceptance.accepted, false)
  assert.equal(result.acceptance.decision, 'reject')
  assert(result.issues.some(issue => issue.code === 'COMPLETED_RESULT_DID_NOT_SATISFY_CONTRACT'))
  assert.equal(result.events[0].eventType, 'task-outcome-rejected')
})

test('preserves a valid blocked outcome and emits blocking lifecycle events', () => {
  const { contract, outcome, workResult } = fixture()
  outcome.status = 'blocked'
  outcome.questionOutcomes[0].status = 'blocked'
  outcome.questionOutcomes[0].answer = null
  outcome.questionOutcomes[0].satisfiedCriteria = []
  outcome.questionOutcomes[0].unmetCriteria = ['Observe an authenticated browser session.']
  outcome.questionOutcomes[0].blockerQuestionIds = ['question:runtime-session']
  outcome.unmetCriteria = ['Observe an authenticated browser session.']
  outcome.runtimeBlockers.push({
    questionId: 'question:runtime-session',
    question: 'Which auth owner is active in a real browser session?',
    rationale: 'Static evidence cannot observe the deployed runtime state.',
    requiredExternalInput: 'An authenticated browser trace.',
    valueScore: 0.9,
    criticality: 'high',
    blocking: true,
    targetMaps: ['runtime-flow'],
    targetJourneyIds: [],
    relatedEntityIds: ['src/AuthProvider.tsx'],
    evidenceIds: ['evidence:provider'],
  })
  workResult.status = 'blocked'
  workResult.outcomeStatus = 'blocked'

  const result = validateTaskOutcome({ contract, outcome, workResult })

  assert.equal(result.valid, true)
  assert.equal(result.acceptance.accepted, false)
  assert.equal(result.acceptance.decision, 'block')
  assert.deepEqual(result.events.map(event => event.eventType), [
    'task-outcome-rejected',
    'question-blocked',
    'question-blocked',
  ])
})

test('rejects hypothesis drift, ghost evidence, and reads outside allowedFiles', () => {
  const { contract, outcome, workResult } = fixture()
  outcome.hypotheses[0].predicate = 'silently-changed'
  outcome.hypotheses[0].supportEvidenceIds = ['evidence:ghost']
  outcome.scopeObserved.filesRead.push('src/secret.ts')
  workResult.readSet.push({ path: 'src/secret.ts' })

  const result = validateTaskOutcome({ contract, outcome, workResult })
  const codes = new Set(result.issues.map(issue => issue.code))

  assert.equal(result.acceptance.accepted, false)
  assert(codes.has('HYPOTHESIS_DEFINITION_DRIFT'))
  assert(codes.has('EVIDENCE_NOT_DECLARED'))
  assert(codes.has('FILE_OUTSIDE_CONTRACT_SCOPE'))
})

test('keeps deterministic failures out of semantic OpenQuestions and out of question events', () => {
  const { contract, outcome, workResult } = fixture()
  outcome.newSemanticQuestions.push({
    questionId: 'question:parser-failure',
    question: 'Why did the TypeScript parser fail on src/App.tsx?',
    rationale: 'The compiler reported an unsupported syntax error.',
    evidenceIds: ['evidence:parser'],
    blocking: false,
  })
  outcome.deterministicDiagnostics.push({
    diagnosticId: 'diagnostic:parser-failure',
    evidenceRefs: ['evidence:parser'],
  })
  outcome.completionEvidence.push('evidence:parser')

  const result = validateTaskOutcome({ contract, outcome, workResult })

  assert.equal(result.acceptance.accepted, false)
  assert(result.issues.some(issue => issue.code === 'DETERMINISTIC_FAILURE_MISCLASSIFIED'))
  assert(result.issues.some(issue => issue.code === 'DIAGNOSTIC_EVIDENCE_MISCLASSIFIED'))
  assert.equal(result.events.some(event => event.eventType === 'question-qualified'), false)
  assert.equal(result.followUps.deterministicDiagnostics.length, 1)
})

test('returns structured issues instead of throwing for malformed input', () => {
  const result = validateTaskOutcome({
    contract: { schemaVersion: 'invalid', questions: {}, acceptanceCriteria: {} },
    outcome: { schemaVersion: 'invalid', questionOutcomes: {}, hypotheses: {} },
    workResult: { schemaVersion: 'invalid', readSet: {}, scopeViolations: {} },
  })

  assert.equal(result.valid, false)
  assert.equal(result.acceptance.accepted, false)
  assert.equal(result.events[0].eventType, 'task-outcome-rejected')
  assert(result.issues.length > 5)
})

function fixture() {
  const contract = {
    schemaVersion: 'repo-research-contract/v1',
    contractId: 'contract:auth-owner',
    questions: [{
      questionId: 'question:auth-owner',
      blocking: true,
      completionCriteria: ['Identify the owner and adjudicate both hypotheses.'],
    }],
    hypotheses: [
      {
        hypothesisId: 'hypothesis:store',
        questionId: 'question:auth-owner',
        statement: 'The store owns auth state.',
        subject: 'src/store.ts',
        predicate: 'owns',
        object: 'auth-state',
        hypothesisType: 'state-owner',
      },
      {
        hypothesisId: 'hypothesis:provider',
        questionId: 'question:auth-owner',
        statement: 'The provider owns auth state.',
        subject: 'src/AuthProvider.tsx',
        predicate: 'owns',
        object: 'auth-state',
        hypothesisType: 'state-owner',
      },
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
      answer: 'AuthProvider owns auth state; the store only consumes it.',
      supportEvidenceIds: ['evidence:provider'],
      counterEvidenceIds: ['evidence:store'],
      hypothesisIds: ['hypothesis:store', 'hypothesis:provider'],
      satisfiedCriteria: ['Identify the owner and adjudicate both hypotheses.'],
      unmetCriteria: [],
      blockerQuestionIds: [],
      confidence: 0.95,
    }],
    hypotheses: [
      {
        schemaVersion: 'repo-hypothesis/v1',
        hypothesisId: 'hypothesis:store',
        contractId: contract.contractId,
        questionId: 'question:auth-owner',
        statement: 'The store owns auth state.',
        subject: 'src/store.ts',
        predicate: 'owns',
        object: 'auth-state',
        hypothesisType: 'state-owner',
        supportEvidenceIds: [],
        counterEvidenceIds: ['evidence:store'],
        qualifiers: {},
        confidence: 0.95,
        status: 'refuted',
        impact: { mapDimensions: ['auth-permission'], journeyIds: [] },
        followUpQuestionIds: [],
      },
      {
        schemaVersion: 'repo-hypothesis/v1',
        hypothesisId: 'hypothesis:provider',
        contractId: contract.contractId,
        questionId: 'question:auth-owner',
        statement: 'The provider owns auth state.',
        subject: 'src/AuthProvider.tsx',
        predicate: 'owns',
        object: 'auth-state',
        hypothesisType: 'state-owner',
        supportEvidenceIds: ['evidence:provider'],
        counterEvidenceIds: [],
        qualifiers: {},
        confidence: 0.95,
        status: 'supported',
        impact: { mapDimensions: ['auth-permission'], journeyIds: [] },
        followUpQuestionIds: [],
      },
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
