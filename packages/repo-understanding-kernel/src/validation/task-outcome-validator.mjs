import path from 'node:path'

export const TASK_OUTCOME_SCHEMA_VERSION = 'repo-task-outcome/v1'

const CONTRACT_SCHEMA_VERSION = 'repo-research-contract/v1'
const WORK_RESULT_SCHEMA_VERSION = 'repo-work-result/v3'
const OUTCOME_STATUSES = new Set(['satisfied', 'partially-satisfied', 'blocked', 'failed'])
const HYPOTHESIS_STATUSES = new Set(['proposed', 'supported', 'refuted', 'inconclusive'])
const DETERMINISTIC_FAILURE = /(?:parse|parser|syntax|import|module|file|ast|compiler|resolution|resolve|\u89e3\u6790|\u7f16\u8bd1|\u8bed\u6cd5|\u5bfc\u5165|\u6587\u4ef6|\u6a21\u5757).{0,48}(?:fail|error|missing|unresolved|unsupported|cannot|could not|not found|\u5931\u8d25|\u9519\u8bef|\u7f3a\u5931|\u4e0d\u652f\u6301|\u65e0\u6cd5|\u627e\u4e0d\u5230)|(?:fail|error|missing|unresolved|unsupported|cannot|could not|not found|\u5931\u8d25|\u9519\u8bef|\u7f3a\u5931|\u4e0d\u652f\u6301|\u65e0\u6cd5|\u627e\u4e0d\u5230).{0,48}(?:parse|parser|syntax|import|module|file|ast|compiler|resolution|resolve|\u89e3\u6790|\u7f16\u8bd1|\u8bed\u6cd5|\u5bfc\u5165|\u6587\u4ef6|\u6a21\u5757)/i

/**
 * Validate a TaskOutcome against the ResearchContract that produced it.
 *
 * `valid` means the payload is internally consistent and contract-aligned.
 * `acceptance.accepted` is intentionally stricter: completed worker execution
 * does not close a contract unless its semantic outcome is fully satisfied.
 */
export function validateTaskOutcome(input = {}, positionalOutcome, positionalWorkResult) {
  const { contract, outcome, workResult, governedEvidenceIds } = positionalOutcome === undefined
    ? input
    : { contract: input, outcome: positionalOutcome, workResult: positionalWorkResult, governedEvidenceIds: undefined }
  const issues = []
  const warnings = []
  const addIssue = (code, pathRef, message) => issues.push({ code, path: pathRef, message })
  const addWarning = (code, pathRef, message) => warnings.push({ code, path: pathRef, message })

  validateEnvelope({ contract, outcome, workResult, addIssue })

  const contractQuestions = indexUnique(contract?.questions, 'questionId', 'contract.questions', addIssue)
  const outcomeQuestions = indexUnique(outcome?.questionOutcomes, 'questionId', 'outcome.questionOutcomes', addIssue)
  const contractHypotheses = indexUnique(contract?.hypotheses, 'hypothesisId', 'contract.hypotheses', addIssue)
  const outcomeHypotheses = indexUnique(outcome?.hypotheses, 'hypothesisId', 'outcome.hypotheses', addIssue)
  const completionEvidence = uniqueStrings(outcome?.completionEvidence)
  const completionEvidenceSet = new Set(completionEvidence)
  const referencedEvidence = new Set()

  validateQuestions({
    contract,
    outcome,
    contractQuestions,
    outcomeQuestions,
    contractHypotheses,
    outcomeHypotheses,
    referencedEvidence,
    addIssue,
  })
  validateHypotheses({
    contract,
    outcome,
    contractHypotheses,
    outcomeHypotheses,
    outcomeQuestions,
    referencedEvidence,
    addIssue,
  })

  const followUps = validateFollowUps({ outcome, referencedEvidence, addIssue, addWarning })
  for (const evidenceId of referencedEvidence) {
    if (!completionEvidenceSet.has(evidenceId)) {
      addIssue('EVIDENCE_NOT_DECLARED', 'outcome.completionEvidence', `Referenced evidence is missing from completionEvidence: ${evidenceId}`)
    }
  }
  validateGovernedEvidence({ governedEvidenceIds, completionEvidence, addIssue })

  const criteria = evaluateAcceptanceCriteria({
    contract,
    outcomeQuestions,
    outcomeHypotheses,
    addIssue,
  })
  const scope = validateScope({ contract, outcome, workResult, addIssue })
  const completion = evaluateCompletion({ contract, outcome, workResult, outcomeQuestions, criteria, followUps, addIssue })

  const valid = issues.length === 0
  const accepted = valid && completion.contractSatisfied && completion.wrapperConsistent && scope.compliant
  const decision = accepted ? 'accept' : completion.hasBlockingExternalQuestion || outcome?.status === 'blocked' ? 'block' : 'reject'
  const acceptance = {
    accepted,
    decision,
    contractSatisfied: completion.contractSatisfied,
    wrapperConsistent: completion.wrapperConsistent,
    allQuestionsSatisfied: completion.allQuestionsSatisfied,
    blockingQuestionsSatisfied: completion.blockingQuestionsSatisfied,
    blockingCriteriaSatisfied: completion.blockingCriteriaSatisfied,
    evidenceComplete: [...referencedEvidence].every(id => completionEvidenceSet.has(id)),
    scopeCompliant: scope.compliant,
    unresolvedQuestionIds: completion.unresolvedQuestionIds,
    unresolvedBlockingQuestionIds: completion.unresolvedBlockingQuestionIds,
    unmetCriterionIds: criteria.filter(item => !item.satisfied).map(item => item.criterionId),
    unmetBlockingCriterionIds: criteria.filter(item => item.blocking && !item.satisfied).map(item => item.criterionId),
  }
  const events = buildAcceptanceEvents({ contract, outcome, acceptance, followUps, issues })

  return {
    valid,
    issues,
    warnings,
    acceptance,
    events,
    acceptedData: accepted ? {
      contractId: contract.contractId,
      questionOutcomes: outcome.questionOutcomes,
      hypotheses: outcome.hypotheses.filter(item => ['supported', 'refuted'].includes(item.status)),
      completionEvidenceIds: completionEvidence,
    } : null,
    followUps,
    evidence: {
      completionEvidenceIds: completionEvidence,
      referencedEvidenceIds: [...referencedEvidence].sort(),
      missingEvidenceIds: [...referencedEvidence].filter(id => !completionEvidenceSet.has(id)).sort(),
      criteria,
    },
    scope,
  }
}

function validateGovernedEvidence({ governedEvidenceIds, completionEvidence, addIssue }) {
  if (governedEvidenceIds === undefined) return
  if (!Array.isArray(governedEvidenceIds) && !(governedEvidenceIds instanceof Set)) {
    addIssue('GOVERNED_EVIDENCE_SET_INVALID', 'governedEvidenceIds', 'governedEvidenceIds must be an array or Set')
    return
  }
  const governed = new Set(governedEvidenceIds)
  for (const [index, evidenceId] of completionEvidence.entries()) {
    if (!governed.has(evidenceId)) {
      addIssue('EVIDENCE_NOT_GOVERNED', `outcome.completionEvidence.${index}`, `Unknown governed Evidence: ${evidenceId}`)
    }
  }
}

function validateEnvelope({ contract, outcome, workResult, addIssue }) {
  if (contract?.schemaVersion !== CONTRACT_SCHEMA_VERSION) {
    addIssue('CONTRACT_SCHEMA_INVALID', 'contract.schemaVersion', `Expected ${CONTRACT_SCHEMA_VERSION}`)
  }
  if (!nonEmpty(contract?.contractId)) addIssue('CONTRACT_ID_MISSING', 'contract.contractId', 'contractId is required')
  if (outcome?.schemaVersion !== TASK_OUTCOME_SCHEMA_VERSION) {
    addIssue('OUTCOME_SCHEMA_INVALID', 'outcome.schemaVersion', `Expected ${TASK_OUTCOME_SCHEMA_VERSION}`)
  }
  if (outcome?.contractId !== contract?.contractId) {
    addIssue('CONTRACT_ID_MISMATCH', 'outcome.contractId', `Expected ${contract?.contractId || 'a contractId'}`)
  }
  if (!OUTCOME_STATUSES.has(outcome?.status)) addIssue('OUTCOME_STATUS_INVALID', 'outcome.status', 'TaskOutcome status is invalid')
  for (const field of ['questionOutcomes', 'hypotheses', 'newSemanticQuestions', 'deterministicDiagnostics', 'runtimeBlockers', 'productIntentQuestions', 'completionEvidence', 'unmetCriteria']) {
    if (!Array.isArray(outcome?.[field])) addIssue('OUTCOME_FIELD_INVALID', `outcome.${field}`, `${field} must be an array`)
  }
  if (!outcome?.scopeObserved || typeof outcome.scopeObserved !== 'object') {
    addIssue('SCOPE_OBSERVED_MISSING', 'outcome.scopeObserved', 'scopeObserved is required')
  }
  if (workResult == null) return
  if (workResult.schemaVersion !== WORK_RESULT_SCHEMA_VERSION) {
    addIssue('WORK_RESULT_SCHEMA_INVALID', 'workResult.schemaVersion', `Expected ${WORK_RESULT_SCHEMA_VERSION}`)
  }
  if (workResult.contractId !== contract?.contractId) {
    addIssue('WORK_RESULT_CONTRACT_MISMATCH', 'workResult.contractId', `Expected ${contract?.contractId || 'a contractId'}`)
  }
  if (workResult.outcomeStatus !== outcome?.status) {
    addIssue('WORK_RESULT_OUTCOME_MISMATCH', 'workResult.outcomeStatus', `Expected ${outcome?.status || 'the TaskOutcome status'}`)
  }
  if (outcome?.status === 'satisfied' && workResult.status !== 'completed') {
    addIssue('SATISFIED_RESULT_NOT_COMPLETED', 'workResult.status', 'A satisfied TaskOutcome requires a completed WorkResult')
  }
}

function validateQuestions(context) {
  const {
    contractQuestions,
    outcomeQuestions,
    contractHypotheses,
    outcomeHypotheses,
    referencedEvidence,
    addIssue,
  } = context
  for (const [questionId, question] of contractQuestions) {
    const result = outcomeQuestions.get(questionId)
    if (!result) {
      addIssue('CONTRACT_QUESTION_MISSING', 'outcome.questionOutcomes', `Missing outcome for contract question ${questionId}`)
      continue
    }
    if (!OUTCOME_STATUSES.has(result.status)) {
      addIssue('QUESTION_STATUS_INVALID', `outcome.questionOutcomes.${questionId}.status`, `Question ${questionId} has an invalid status`)
    }
    for (const field of ['supportEvidenceIds', 'counterEvidenceIds', 'hypothesisIds', 'satisfiedCriteria', 'unmetCriteria', 'blockerQuestionIds']) {
      if (!Array.isArray(result[field])) addIssue('QUESTION_FIELD_INVALID', `outcome.questionOutcomes.${questionId}.${field}`, `${field} must be an array`)
    }
    if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
      addIssue('QUESTION_CONFIDENCE_INVALID', `outcome.questionOutcomes.${questionId}.confidence`, 'confidence must be between 0 and 1')
    }
    addEvidence(referencedEvidence, result.supportEvidenceIds)
    addEvidence(referencedEvidence, result.counterEvidenceIds)

    if (result.status === 'satisfied') {
      if (!nonEmpty(result.answer)) addIssue('SATISFIED_QUESTION_NO_ANSWER', `outcome.questionOutcomes.${questionId}.answer`, 'A satisfied question requires an answer')
      if (result.unmetCriteria?.length) addIssue('SATISFIED_QUESTION_HAS_UNMET_CRITERIA', `outcome.questionOutcomes.${questionId}.unmetCriteria`, 'A satisfied question cannot have unmet criteria')
      if (result.blockerQuestionIds?.length) addIssue('SATISFIED_QUESTION_HAS_BLOCKERS', `outcome.questionOutcomes.${questionId}.blockerQuestionIds`, 'A satisfied question cannot have blockers')
      for (const criterion of question.completionCriteria || []) {
        if (!result.satisfiedCriteria?.includes(criterion)) {
          addIssue('QUESTION_COMPLETION_CRITERION_MISSING', `outcome.questionOutcomes.${questionId}.satisfiedCriteria`, `Missing completion criterion: ${criterion}`)
        }
      }
      if (!(result.supportEvidenceIds?.length || result.counterEvidenceIds?.length)) {
        addIssue('SATISFIED_QUESTION_NO_EVIDENCE', `outcome.questionOutcomes.${questionId}`, 'A satisfied question requires evidence')
      }
    }

    const expectedHypothesisIds = [...contractHypotheses.values()]
      .filter(item => item.questionId === questionId)
      .map(item => item.hypothesisId)
    for (const hypothesisId of result.hypothesisIds || []) {
      if (!contractHypotheses.has(hypothesisId)) {
        addIssue('QUESTION_HYPOTHESIS_NOT_CONTRACTED', `outcome.questionOutcomes.${questionId}.hypothesisIds`, `Hypothesis is not in the contract: ${hypothesisId}`)
      }
      const hypothesis = outcomeHypotheses.get(hypothesisId)
      if (!hypothesis) addIssue('QUESTION_HYPOTHESIS_MISSING', `outcome.questionOutcomes.${questionId}.hypothesisIds`, `Missing hypothesis result: ${hypothesisId}`)
      else if (hypothesis.questionId !== questionId) addIssue('QUESTION_HYPOTHESIS_MISMATCH', `outcome.hypotheses.${hypothesisId}.questionId`, `Expected ${questionId}`)
    }
    if (result.status === 'satisfied') {
      for (const hypothesisId of expectedHypothesisIds) {
        if (!result.hypothesisIds?.includes(hypothesisId)) {
          addIssue('SATISFIED_QUESTION_HYPOTHESIS_MISSING', `outcome.questionOutcomes.${questionId}.hypothesisIds`, `Satisfied question did not adjudicate ${hypothesisId}`)
        }
        const hypothesis = outcomeHypotheses.get(hypothesisId)
        if (hypothesis && !['supported', 'refuted'].includes(hypothesis.status)) {
          addIssue('SATISFIED_QUESTION_HYPOTHESIS_INCONCLUSIVE', `outcome.hypotheses.${hypothesisId}.status`, 'A satisfied question must adjudicate each contracted hypothesis')
        }
      }
    }
  }
  for (const questionId of outcomeQuestions.keys()) {
    if (!contractQuestions.has(questionId)) {
      addIssue('QUESTION_NOT_CONTRACTED', `outcome.questionOutcomes.${questionId}`, `Question is not in the ResearchContract: ${questionId}`)
    }
  }
}

function validateHypotheses(context) {
  const {
    contract,
    contractHypotheses,
    outcomeHypotheses,
    outcomeQuestions,
    referencedEvidence,
    addIssue,
  } = context
  for (const [hypothesisId, hypothesis] of outcomeHypotheses) {
    const expected = contractHypotheses.get(hypothesisId)
    if (!expected) {
      addIssue('HYPOTHESIS_NOT_CONTRACTED', `outcome.hypotheses.${hypothesisId}`, `Hypothesis is not in the ResearchContract: ${hypothesisId}`)
      continue
    }
    if (hypothesis.schemaVersion !== 'repo-hypothesis/v1') {
      addIssue('HYPOTHESIS_SCHEMA_INVALID', `outcome.hypotheses.${hypothesisId}.schemaVersion`, 'Expected repo-hypothesis/v1')
    }
    if (hypothesis.contractId !== contract?.contractId) {
      addIssue('HYPOTHESIS_CONTRACT_MISMATCH', `outcome.hypotheses.${hypothesisId}.contractId`, `Expected ${contract?.contractId}`)
    }
    if (hypothesis.questionId !== expected.questionId) {
      addIssue('HYPOTHESIS_QUESTION_MISMATCH', `outcome.hypotheses.${hypothesisId}.questionId`, `Expected ${expected.questionId}`)
    }
    for (const field of ['statement', 'subject', 'predicate', 'object', 'hypothesisType']) {
      if (!sameValue(hypothesis[field], expected[field])) {
        addIssue('HYPOTHESIS_DEFINITION_DRIFT', `outcome.hypotheses.${hypothesisId}.${field}`, `Contracted hypothesis field changed: ${field}`)
      }
    }
    if (!HYPOTHESIS_STATUSES.has(hypothesis.status)) {
      addIssue('HYPOTHESIS_STATUS_INVALID', `outcome.hypotheses.${hypothesisId}.status`, 'Hypothesis status is invalid')
    }
    for (const field of ['supportEvidenceIds', 'counterEvidenceIds', 'followUpQuestionIds']) {
      if (!Array.isArray(hypothesis[field])) addIssue('HYPOTHESIS_FIELD_INVALID', `outcome.hypotheses.${hypothesisId}.${field}`, `${field} must be an array`)
    }
    if (!hypothesis.qualifiers || typeof hypothesis.qualifiers !== 'object' || Array.isArray(hypothesis.qualifiers)) {
      addIssue('HYPOTHESIS_QUALIFIERS_INVALID', `outcome.hypotheses.${hypothesisId}.qualifiers`, 'qualifiers must be an object')
    }
    if (!Number.isFinite(hypothesis.confidence) || hypothesis.confidence < 0 || hypothesis.confidence > 1) {
      addIssue('HYPOTHESIS_CONFIDENCE_INVALID', `outcome.hypotheses.${hypothesisId}.confidence`, 'confidence must be between 0 and 1')
    }
    if (!hypothesis.impact || !Array.isArray(hypothesis.impact.mapDimensions) || !Array.isArray(hypothesis.impact.journeyIds)) {
      addIssue('HYPOTHESIS_IMPACT_INVALID', `outcome.hypotheses.${hypothesisId}.impact`, 'impact requires mapDimensions and journeyIds arrays')
    }
    if (!outcomeQuestions.get(expected.questionId)?.hypothesisIds?.includes(hypothesisId)) {
      addIssue('HYPOTHESIS_NOT_LINKED_FROM_QUESTION', `outcome.hypotheses.${hypothesisId}`, `Question outcome ${expected.questionId} does not reference ${hypothesisId}`)
    }
    addEvidence(referencedEvidence, hypothesis.supportEvidenceIds)
    addEvidence(referencedEvidence, hypothesis.counterEvidenceIds)
    if (hypothesis.status === 'supported' && !hypothesis.supportEvidenceIds?.length) {
      addIssue('SUPPORTED_HYPOTHESIS_NO_EVIDENCE', `outcome.hypotheses.${hypothesisId}.supportEvidenceIds`, 'A supported hypothesis requires support evidence')
    }
    if (hypothesis.status === 'refuted' && !hypothesis.counterEvidenceIds?.length) {
      addIssue('REFUTED_HYPOTHESIS_NO_EVIDENCE', `outcome.hypotheses.${hypothesisId}.counterEvidenceIds`, 'A refuted hypothesis requires counter evidence')
    }
  }
}

function validateFollowUps({ outcome, referencedEvidence, addIssue, addWarning }) {
  const semanticQuestions = Array.isArray(outcome?.newSemanticQuestions) ? outcome.newSemanticQuestions : []
  const deterministicDiagnostics = Array.isArray(outcome?.deterministicDiagnostics) ? outcome.deterministicDiagnostics : []
  const runtimeBlockers = Array.isArray(outcome?.runtimeBlockers) ? outcome.runtimeBlockers : []
  const productIntentQuestions = Array.isArray(outcome?.productIntentQuestions) ? outcome.productIntentQuestions : []
  const diagnosticIds = new Set()
  const diagnosticEvidence = new Set()
  for (const [index, diagnostic] of deterministicDiagnostics.entries()) {
    if (!nonEmpty(diagnostic?.diagnosticId)) addIssue('DIAGNOSTIC_ID_MISSING', `outcome.deterministicDiagnostics.${index}.diagnosticId`, 'diagnosticId is required')
    if (diagnosticIds.has(diagnostic?.diagnosticId)) addIssue('DIAGNOSTIC_ID_DUPLICATE', `outcome.deterministicDiagnostics.${index}.diagnosticId`, `Duplicate diagnosticId: ${diagnostic.diagnosticId}`)
    diagnosticIds.add(diagnostic?.diagnosticId)
    if (!nonEmpty(diagnostic?.kind) || !['info', 'warning', 'error'].includes(diagnostic?.severity) || !nonEmpty(diagnostic?.message) || !Array.isArray(diagnostic?.evidenceRefs)) {
      addIssue('DIAGNOSTIC_INVALID', `outcome.deterministicDiagnostics.${index}`, 'Diagnostic requires kind, severity, message, and evidenceRefs')
    }
    addEvidence(diagnosticEvidence, diagnostic?.evidenceRefs)
  }
  const followUpIds = new Set()
  for (const [category, values] of [
    ['semantic-ambiguity', semanticQuestions],
    ['runtime-external-blocked', runtimeBlockers],
    ['product-intent', productIntentQuestions],
  ]) {
    for (const [index, question] of values.entries()) {
      const basePath = `outcome.${category === 'semantic-ambiguity' ? 'newSemanticQuestions' : category === 'runtime-external-blocked' ? 'runtimeBlockers' : 'productIntentQuestions'}.${index}`
      if (!nonEmpty(question?.questionId)) addIssue('FOLLOW_UP_ID_MISSING', `${basePath}.questionId`, 'questionId is required')
      if (followUpIds.has(question?.questionId)) addIssue('FOLLOW_UP_ID_DUPLICATE', `${basePath}.questionId`, `Follow-up question appears in more than one category: ${question.questionId}`)
      if (diagnosticIds.has(question?.questionId)) addIssue('DIAGNOSTIC_QUESTION_ID_COLLISION', `${basePath}.questionId`, 'A diagnostic cannot also be an OpenQuestion')
      followUpIds.add(question?.questionId)
      if (!nonEmpty(question?.question) || !nonEmpty(question?.rationale)) addIssue('FOLLOW_UP_TEXT_MISSING', basePath, 'Follow-up question and rationale are required')
      if (!question?.evidenceIds?.length) addIssue('FOLLOW_UP_NO_EVIDENCE', `${basePath}.evidenceIds`, 'A follow-up question requires evidence')
      addEvidence(referencedEvidence, question?.evidenceIds)
      if (category === 'semantic-ambiguity') {
        const text = `${question?.question || ''} ${question?.rationale || ''}`
        if (DETERMINISTIC_FAILURE.test(text)) {
          addIssue('DETERMINISTIC_FAILURE_MISCLASSIFIED', basePath, 'Parser, compiler, import, and file failures belong in deterministicDiagnostics')
        }
        if ((question?.evidenceIds || []).some(id => diagnosticEvidence.has(id))) {
          addIssue('DIAGNOSTIC_EVIDENCE_MISCLASSIFIED', `${basePath}.evidenceIds`, 'A deterministic diagnostic evidence reference cannot be promoted directly into a semantic question')
        }
        addWarning('SEMANTIC_QUESTION_REQUIRES_QUALIFICATION', basePath, 'The TaskOutcome schema does not carry competing hypotheses; qualify this candidate before emitting question-qualified')
      }
    }
  }
  return {
    semanticQuestions,
    deterministicDiagnostics,
    runtimeBlockers,
    productIntentQuestions,
  }
}

function evaluateAcceptanceCriteria({ contract, outcomeQuestions, outcomeHypotheses, addIssue }) {
  const result = []
  for (const [index, criterion] of asArray(contract?.acceptanceCriteria).entries()) {
    const evidenceIds = new Set()
    for (const questionId of criterion.questionIds || []) {
      const question = outcomeQuestions.get(questionId)
      if (!question) addIssue('CRITERION_QUESTION_UNKNOWN', `contract.acceptanceCriteria.${index}.questionIds`, `Unknown question ${questionId}`)
      addEvidence(evidenceIds, question?.supportEvidenceIds)
      addEvidence(evidenceIds, question?.counterEvidenceIds)
    }
    for (const hypothesisId of criterion.hypothesisIds || []) {
      const hypothesis = outcomeHypotheses.get(hypothesisId)
      if (!hypothesis) addIssue('CRITERION_HYPOTHESIS_MISSING', `outcome.hypotheses.${hypothesisId}`, `Acceptance criterion requires hypothesis ${hypothesisId}`)
      addEvidence(evidenceIds, hypothesis?.supportEvidenceIds)
      addEvidence(evidenceIds, hypothesis?.counterEvidenceIds)
    }
    const minimumEvidenceCount = Number.isInteger(criterion.minimumEvidenceCount) ? criterion.minimumEvidenceCount : 0
    result.push({
      criterionId: criterion.criterionId,
      blocking: Boolean(criterion.blocking),
      minimumEvidenceCount,
      evidenceIds: [...evidenceIds].sort(),
      satisfied: evidenceIds.size >= minimumEvidenceCount,
    })
  }
  return result
}

function validateScope({ contract, outcome, workResult, addIssue }) {
  let scopeIssueCount = 0
  const addScopeIssue = (...args) => {
    scopeIssueCount += 1
    addIssue(...args)
  }
  const allowedSourceFiles = normalizePathSet(contract?.scope?.allowedFiles, 'contract.scope.allowedFiles', addScopeIssue)
  const allowedContextRefs = normalizePathSet(asArray(contract?.deterministicContextRefs), 'contract.deterministicContextRefs', addScopeIssue)
  const allowedFiles = new Set([...allowedSourceFiles, ...allowedContextRefs])
  const filesRead = normalizePathSet(outcome?.scopeObserved?.filesRead, 'outcome.scopeObserved.filesRead', addScopeIssue)
  const readSet = asArray(workResult?.readSet)
  const readSetFiles = normalizePathSet(readSet.map(item => item?.path), 'workResult.readSet', addScopeIssue)
  const violations = []
  for (const file of new Set([...filesRead, ...readSetFiles])) {
    if (!allowedFiles.has(file)) {
      violations.push(file)
      addScopeIssue('FILE_OUTSIDE_CONTRACT_SCOPE', 'outcome.scopeObserved.filesRead', `File is outside ResearchContract scope: ${file}`)
    }
  }
  if (Array.isArray(workResult?.readSet)) {
    for (const file of filesRead) {
      if (!readSetFiles.has(file)) addScopeIssue('OBSERVED_FILE_MISSING_FROM_READ_SET', 'workResult.readSet', `Observed file is missing from WorkResult.readSet: ${file}`)
    }
    for (const file of readSetFiles) {
      if (!filesRead.has(file) && !allowedContextRefs.has(file)) {
        addScopeIssue('READ_SET_FILE_NOT_DISCLOSED', 'outcome.scopeObserved.filesRead', `WorkResult source read was not disclosed in scopeObserved: ${file}`)
      }
    }
  }
  const allowedCommunities = new Set(contract?.scope?.communityIds || [])
  for (const communityId of asArray(outcome?.scopeObserved?.communityIds)) {
    if (!allowedCommunities.has(communityId)) addScopeIssue('COMMUNITY_OUTSIDE_CONTRACT_SCOPE', 'outcome.scopeObserved.communityIds', `Community is outside ResearchContract scope: ${communityId}`)
  }
  const allowedEntries = new Set(contract?.scope?.entryEntities || [])
  for (const entityId of asArray(outcome?.scopeObserved?.entryEntities)) {
    if (!allowedEntries.has(entityId)) addScopeIssue('ENTRY_OUTSIDE_CONTRACT_SCOPE', 'outcome.scopeObserved.entryEntities', `Entry entity is outside ResearchContract scope: ${entityId}`)
  }
  const observedDepth = Number(outcome?.scopeObserved?.neighborDepth)
  if (!Number.isInteger(observedDepth) || observedDepth < 0) addScopeIssue('NEIGHBOR_DEPTH_INVALID', 'outcome.scopeObserved.neighborDepth', 'neighborDepth must be a non-negative integer')
  if (Number.isInteger(observedDepth) && observedDepth > Number(contract?.scope?.neighborDepth)) {
    addScopeIssue('NEIGHBOR_DEPTH_EXCEEDED', 'outcome.scopeObserved.neighborDepth', `Observed depth ${observedDepth} exceeds contract depth ${contract?.scope?.neighborDepth}`)
  }
  const sourceFilesRead = new Set([...filesRead].filter(file => allowedSourceFiles.has(file)))
  if (Number.isInteger(contract?.budgetHints?.maxFiles) && sourceFilesRead.size > contract.budgetHints.maxFiles) {
    addScopeIssue('FILE_BUDGET_EXCEEDED', 'outcome.scopeObserved.filesRead', `Read ${sourceFilesRead.size} source files; contract allows ${contract.budgetHints.maxFiles}`)
  }
  if (Array.isArray(workResult?.scopeViolations) && workResult.scopeViolations.length) {
    for (const violation of workResult.scopeViolations) if (nonEmpty(violation?.path)) violations.push(violation.path)
    addScopeIssue('WORK_RESULT_SCOPE_VIOLATIONS', 'workResult.scopeViolations', 'WorkResult reports scope violations')
  }
  return {
    compliant: scopeIssueCount === 0,
    allowedFiles: [...allowedSourceFiles].sort(),
    allowedContextRefs: [...allowedContextRefs].sort(),
    filesRead: [...filesRead].sort(),
    readSetFiles: [...readSetFiles].sort(),
    violations: uniqueStrings(violations).sort(),
  }
}

function evaluateCompletion({ contract, outcome, workResult, outcomeQuestions, criteria, followUps, addIssue }) {
  const unresolvedQuestionIds = asArray(contract?.questions)
    .filter(question => outcomeQuestions.get(question.questionId)?.status !== 'satisfied')
    .map(question => question.questionId)
  const unresolvedBlockingQuestionIds = asArray(contract?.questions)
    .filter(question => question.blocking && outcomeQuestions.get(question.questionId)?.status !== 'satisfied')
    .map(question => question.questionId)
  const allQuestionsSatisfied = unresolvedQuestionIds.length === 0
  const blockingQuestionsSatisfied = unresolvedBlockingQuestionIds.length === 0
  const blockingCriteriaSatisfied = criteria.every(item => !item.blocking || item.satisfied)
  const allCriteriaSatisfied = criteria.every(item => item.satisfied)
  const unmetCriteriaEmpty = Array.isArray(outcome?.unmetCriteria) && outcome.unmetCriteria.length === 0
  const hasBlockingExternalQuestion = [...followUps.semanticQuestions, ...followUps.runtimeBlockers, ...followUps.productIntentQuestions]
    .some(question => question.blocking)
  const wrapperConsistent = workResult == null || (
    workResult.status === 'completed'
    && workResult.outcomeStatus === outcome?.status
  )
  const contractSatisfied = outcome?.status === 'satisfied'
    && allQuestionsSatisfied
    && blockingQuestionsSatisfied
    && blockingCriteriaSatisfied
    && allCriteriaSatisfied
    && unmetCriteriaEmpty
    && !hasBlockingExternalQuestion

  if (outcome?.status === 'satisfied' && !allQuestionsSatisfied) addIssue('SATISFIED_OUTCOME_HAS_OPEN_QUESTIONS', 'outcome.status', 'A satisfied TaskOutcome cannot contain unresolved contract questions')
  if (outcome?.status === 'satisfied' && !allCriteriaSatisfied) addIssue('SATISFIED_OUTCOME_HAS_UNMET_ACCEPTANCE', 'outcome.status', 'A satisfied TaskOutcome must meet every acceptance criterion')
  if (outcome?.status === 'satisfied' && !unmetCriteriaEmpty) addIssue('SATISFIED_OUTCOME_HAS_UNMET_CRITERIA', 'outcome.unmetCriteria', 'A satisfied TaskOutcome cannot declare unmet criteria')
  if (outcome?.status === 'satisfied' && hasBlockingExternalQuestion) addIssue('SATISFIED_OUTCOME_HAS_BLOCKING_FOLLOW_UP', 'outcome.status', 'A satisfied TaskOutcome cannot emit a blocking follow-up question')
  if (workResult?.status === 'completed' && outcome?.status !== 'satisfied') {
    addIssue('COMPLETED_RESULT_DID_NOT_SATISFY_CONTRACT', 'workResult.status', 'Completed execution is not accepted until the contract outcome is satisfied')
  }
  return {
    contractSatisfied,
    wrapperConsistent,
    allQuestionsSatisfied,
    blockingQuestionsSatisfied,
    blockingCriteriaSatisfied,
    hasBlockingExternalQuestion,
    unresolvedQuestionIds,
    unresolvedBlockingQuestionIds,
  }
}

function buildAcceptanceEvents({ contract, outcome, acceptance, followUps, issues }) {
  const contractId = contract?.contractId || outcome?.contractId || null
  const events = [{
    eventType: acceptance.accepted ? 'task-outcome-accepted' : 'task-outcome-rejected',
    payload: {
      contractId,
      status: outcome?.status || 'failed',
      decision: acceptance.decision,
      issueCodes: issues.map(issue => issue.code),
      completionEvidenceIds: uniqueStrings(outcome?.completionEvidence),
    },
  }]
  if (issues.length) return events
  if (acceptance.accepted) {
    for (const question of outcome.questionOutcomes || []) {
      events.push({
        eventType: 'question-resolved',
        payload: {
          contractId,
          questionId: question.questionId,
          resolutionSummary: question.answer,
          evidenceIds: uniqueStrings([...(question.supportEvidenceIds || []), ...(question.counterEvidenceIds || [])]),
          hypothesisIds: uniqueStrings(question.hypothesisIds),
        },
      })
    }
    for (const hypothesis of outcome.hypotheses || []) {
      if (!['supported', 'refuted'].includes(hypothesis.status)) continue
      events.push({
        eventType: hypothesis.status === 'supported' ? 'hypothesis-supported' : 'hypothesis-refuted',
        payload: { contractId, hypothesisId: hypothesis.hypothesisId, hypothesis },
      })
    }
  } else {
    for (const question of outcome?.questionOutcomes || []) {
      if (question.status !== 'blocked') continue
      events.push({
        eventType: 'question-blocked',
        payload: { contractId, questionId: question.questionId, blockerQuestionIds: uniqueStrings(question.blockerQuestionIds) },
      })
    }
  }
  for (const blocker of followUps.runtimeBlockers) {
    events.push({
      eventType: 'question-blocked',
      payload: { contractId, question: { ...blocker, category: 'runtime-external-blocked' } },
    })
  }
  for (const question of followUps.productIntentQuestions) {
    events.push({
      eventType: 'question-qualified',
      payload: { contractId, question: { ...question, category: 'product-intent' } },
    })
  }
  return events
}

function indexUnique(values, key, pathRef, addIssue) {
  const result = new Map()
  if (!Array.isArray(values)) return result
  for (const [index, value] of values.entries()) {
    const id = value?.[key]
    if (!nonEmpty(id)) {
      addIssue('IDENTIFIER_MISSING', `${pathRef}.${index}.${key}`, `${key} is required`)
      continue
    }
    if (result.has(id)) addIssue('IDENTIFIER_DUPLICATE', `${pathRef}.${index}.${key}`, `Duplicate ${key}: ${id}`)
    else result.set(id, value)
  }
  return result
}

function normalizePathSet(values, pathRef, addIssue) {
  const result = new Set()
  if (!Array.isArray(values)) {
    addIssue('PATH_LIST_INVALID', pathRef, 'Expected an array of repository-relative paths')
    return result
  }
  for (const [index, value] of values.entries()) {
    const normalized = normalizeRepoPath(value)
    if (!normalized) {
      addIssue('REPO_PATH_INVALID', `${pathRef}.${index}`, `Invalid repository-relative path: ${String(value)}`)
      continue
    }
    if (result.has(normalized)) addIssue('REPO_PATH_DUPLICATE', `${pathRef}.${index}`, `Duplicate repository path: ${normalized}`)
    result.add(normalized)
  }
  return result
}

function normalizeRepoPath(value) {
  if (!nonEmpty(value)) return null
  const portable = value.replaceAll('\\', '/')
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)) return null
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
  return normalized
}

function addEvidence(target, values) {
  for (const value of asArray(values)) if (nonEmpty(value)) target.add(value)
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).filter(nonEmpty))]
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function sameValue(left, right) {
  if (left === right) return true
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') return false
  return stableStringify(left) === stableStringify(right)
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
