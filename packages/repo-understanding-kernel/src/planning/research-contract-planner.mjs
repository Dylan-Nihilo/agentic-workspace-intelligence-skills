import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const FRONTEND_MAP_DIMENSIONS = Object.freeze([
  'application-bootstrap',
  'route-layout-page',
  'component-composition',
  'state-ownership-data-flow',
  'api-client',
  'auth-permission',
  'build-deploy',
  'testing-quality',
  'core-journeys',
])

export const FRONTEND_PRODUCT_MAPS = Object.freeze(['application', 'experience', 'runtime-flow', 'change'])

const QUESTION_TYPES = new Set([
  'semantic-ambiguity',
  'runtime-external-blocked',
  'product-intent',
])

const DETERMINISTIC_DIAGNOSTIC_PATTERN = /(?:parse|parser|syntax|import|module|resolution|protected|unsupported|missing-file|unresolved-path|line-range)/i

export function classifyQuestion(candidate = {}) {
  const explicit = candidate.type || candidate.questionType || candidate.kind
  if (QUESTION_TYPES.has(explicit)) return explicit
  const code = `${candidate.code || ''} ${candidate.category || ''} ${candidate.source || ''}`
  if (DETERMINISTIC_DIAGNOSTIC_PATTERN.test(code)) return 'deterministic-diagnostic'
  if (candidate.runtimeRequired || candidate.externalRuntime || candidate.category === 'runtime') return 'runtime-external-blocked'
  if (candidate.productIntentRequired || candidate.category === 'product-intent') return 'product-intent'
  const hypotheses = normalizeHypotheses(candidate)
  if (hypotheses.length >= 2) return 'semantic-ambiguity'
  if (candidate.semanticAmbiguity === true && hypotheses.length >= 2) return 'semantic-ambiguity'
  if (candidate.conflictingEvidence === true && hypotheses.length >= 2) return 'semantic-ambiguity'
  return 'deterministic-diagnostic'
}

export function qualifyOpenQuestions({
  investigationFrame,
  snapshotId,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!investigationFrame?.frameId) throw new Error('investigationFrame.frameId is required')
  if (!snapshotId) throw new Error('snapshotId is required')
  const candidates = investigationFrame.unresolvedSemanticAmbiguities || []
  const openQuestions = []
  const deterministicDiagnostics = [...(investigationFrame.deterministicDiagnostics || [])]

  for (const candidateValue of candidates) {
    const candidate = typeof candidateValue === 'string' ? { question: candidateValue } : candidateValue || {}
    const type = classifyQuestion(candidate)
    if (type === 'deterministic-diagnostic') {
      deterministicDiagnostics.push({
        diagnosticId: `diagnostic:${hash(`${investigationFrame.frameId}|${candidate.question || candidate.message || 'unqualified'}`).slice(0, 20)}`,
        kind: candidate.code || 'unqualified-semantic-candidate',
        severity: 'warning',
        message: candidate.question || candidate.message || 'Candidate lacks competing semantic hypotheses.',
        sourcePath: null,
        evidenceRefs: dedupe(candidate.evidenceRefs || []),
      })
      continue
    }
    const statement = String(candidate.question || candidate.statement || candidate.message || '').trim()
    if (!statement) continue
    const hypotheses = normalizeHypotheses(candidate)
    if (type === 'semantic-ambiguity' && hypotheses.length < 2) {
      deterministicDiagnostics.push({
        diagnosticId: `diagnostic:${hash(`${investigationFrame.frameId}|${statement}|missing-hypotheses`).slice(0, 20)}`,
        kind: 'semantic-question-without-competing-hypotheses',
        severity: 'warning',
        message: statement,
        sourcePath: null,
        evidenceRefs: dedupe(candidate.evidenceRefs || []),
      })
      continue
    }
    const targetMapDimensions = normalizeMapDimensions(candidate.targetMapDimensions || candidate.mapDimensions)
    const targetMaps = normalizeTargetMaps(candidate.targetMaps, targetMapDimensions)
    const targetJourneys = dedupe(candidate.targetJourneyIds || candidate.targetJourneys || candidate.journeyIds || [])
    const questionId = candidate.questionId || `question:${hash([
      investigationFrame.frameId,
      type,
      statement,
      ...targetMaps,
      ...targetJourneys,
    ].join('|')).slice(0, 20)}`
    openQuestions.push({
      schemaVersion: 'repo-open-question/v1',
      questionId,
      snapshotId,
      category: type,
      question: statement,
      rationale: String(candidate.rationale || candidate.whyItMatters || 'This ambiguity blocks a declared frontend map or journey.').trim(),
      valueScore: questionValueScore(candidate, targetMaps, targetJourneys),
      criticality: normalizeCriticality(candidate.criticality || candidate.priority),
      blocking: candidate.blocking !== false,
      targetMaps,
      targetMapDimensions,
      targetJourneyIds: targetJourneys,
      relatedEntityIds: dedupe(candidate.relatedEntityIds || candidate.relatedEntities || []),
      evidenceIds: dedupe(candidate.evidenceIds || candidate.evidenceRefs || []),
      competingHypotheses: hypotheses,
      communityIds: dedupe(candidate.communityIds || []),
      allowedFiles: dedupe(candidate.allowedFiles || filesFromEntities(candidate.relatedEntityIds || candidate.relatedEntities || [])),
      lifecycleStatus: type === 'semantic-ambiguity' ? 'qualified' : 'blocked',
      sourceContractIds: [],
      resolutionSummary: null,
      resolvedByClaimIds: [],
      raisedAt: generatedAt,
      updatedAt: generatedAt,
    })
  }

  return {
    openQuestions: uniqueBy(openQuestions, question => question.questionId),
    deterministicDiagnostics: uniqueBy(deterministicDiagnostics, diagnostic => `${diagnostic.kind || diagnostic.code || ''}|${diagnostic.message || ''}`),
  }
}

export function buildResearchContracts({
  snapshotId,
  investigationFrame,
  openQuestions,
  deterministicContextRefs = [],
  neighborMapRef = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!snapshotId) throw new Error('snapshotId is required')
  if (!investigationFrame?.frameId) throw new Error('investigationFrame.frameId is required')
  const eligible = (openQuestions || []).filter(question => question.category === 'semantic-ambiguity' && question.lifecycleStatus === 'qualified')
  const groups = groupBy(eligible, question => dedupe(question.communityIds || []).sort().join('|') || `question:${question.questionId}`)
  return [...groups.values()].map(questions => {
    const communityIds = dedupe(questions.flatMap(question => question.communityIds || []))
    const targetMaps = dedupe(questions.flatMap(question => question.targetMaps || [])).filter(value => FRONTEND_PRODUCT_MAPS.includes(value))
    const targetJourneys = dedupe(questions.flatMap(question => question.targetJourneyIds || []))
    const entryEntities = dedupe(questions.flatMap(question => question.relatedEntityIds || []))
    const allowedFiles = dedupe(questions.flatMap(question => question.allowedFiles || filesFromEntities(question.relatedEntityIds || [])))
    const contractId = `contract:${hash([
      snapshotId,
      investigationFrame.frameId,
      ...questions.map(question => question.questionId).sort(),
    ].join('|')).slice(0, 20)}`
    return {
      schemaVersion: 'repo-research-contract/v1',
      contractId,
      snapshotId,
      investigationFrameId: investigationFrame.frameId,
      questions: questions.map(contractQuestion),
      hypotheses: questions.flatMap(question => question.competingHypotheses.map((hypothesis, index) => ({
        hypothesisId: hypothesis.hypothesisId || `hypothesis:${hash(`${contractId}|${question.questionId}|${index}|${hypothesis.statement}`).slice(0, 20)}`,
        questionId: question.questionId,
        statement: hypothesis.statement,
        subject: hypothesis.subject,
        predicate: hypothesis.predicate,
        object: hypothesis.object,
        hypothesisType: hypothesis.hypothesisType,
        expectedSupportEvidence: hypothesis.expectedSupportEvidence,
        expectedCounterEvidence: hypothesis.expectedCounterEvidence,
        qualifiers: hypothesis.qualifiers,
        initialConfidence: hypothesis.initialConfidence,
      }))),
      targetMaps,
      targetJourneys,
      scope: {
        communityIds: communityIds.length ? communityIds : [`community:${hash(contractId).slice(0, 16)}`],
        entryEntities: entryEntities.length ? entryEntities : fallbackEntryEntities(investigationFrame),
        allowedFiles: allowedFiles.length ? allowedFiles : fallbackAllowedFiles(investigationFrame),
        neighborDepth: 1,
      },
      deterministicContextRefs: dedupe(deterministicContextRefs).length
        ? dedupe(deterministicContextRefs)
        : ['static/investigation-frame.json'],
      acceptanceCriteria: questions.map((question, index) => ({
        criterionId: `criterion:${hash(`${contractId}|${question.questionId}|${index}`).slice(0, 20)}`,
        description: `Answer ${question.questionId} with supporting or counter evidence inside the declared scope.`,
        questionIds: [question.questionId],
        hypothesisIds: question.competingHypotheses.map((hypothesis, hypothesisIndex) => hypothesis.hypothesisId || `hypothesis:${hash(`${contractId}|${question.questionId}|${hypothesisIndex}|${hypothesis.statement}`).slice(0, 20)}`),
        blocking: question.blocking,
        minimumEvidenceCount: 1,
      })),
      completionRules: [{
        ruleId: `completion:${hash(`${contractId}|blocking-questions`).slice(0, 20)}`,
        description: 'Every blocking question is supported, refuted, or explicitly inconclusive with evidence.',
        blockingMapDimensions: dedupe(questions.flatMap(question => question.targetMapDimensions || [])),
        blockingJourneyIds: targetJourneys,
      }],
      stopRules: [
        { ruleId: `stop:${hash(`${contractId}|complete`).slice(0, 20)}`, condition: 'All acceptance criteria are met.', action: 'stop' },
        { ruleId: `stop:${hash(`${contractId}|scope`).slice(0, 20)}`, condition: 'Required evidence is outside scope or runtime-only.', action: 'block' },
        { ruleId: `stop:${hash(`${contractId}|continue`).slice(0, 20)}`, condition: 'A blocking hypothesis remains testable inside scope.', action: 'continue' },
      ],
      blockedPolicies: [
        { category: 'runtime-external-blocked', action: 'block', description: 'Record runtime-only evidence as a blocker; do not widen repository scope.' },
        { category: 'product-intent', action: 'request-input', description: 'Route product intent to the user or product evidence; do not ask repo-explorer.' },
        { category: 'budget-exhausted', action: 'defer', description: 'Defer non-blocking research without declaring the contract satisfied.' },
      ],
      budgetHints: {
        maxFiles: Math.max(1, allowedFiles.length || fallbackAllowedFiles(investigationFrame).length),
        maxContextBytes: 120000,
        maxOutputBytes: 32000,
        maxTokens: 12000,
        maxDurationMs: 900000,
      },
    }
  })
}

export function writeResearchPlan(packageDir, value) {
  const root = path.resolve(packageDir)
  const planningDir = path.join(root, 'planning')
  const contractsDir = path.join(planningDir, 'contracts')
  fs.mkdirSync(contractsDir, { recursive: true })
  const questions = value.openQuestions || []
  const contracts = value.contracts || []
  const contractIdsByQuestion = new Map()
  for (const contract of contracts) {
    for (const question of contract.questions || []) {
      contractIdsByQuestion.set(question.questionId, [...(contractIdsByQuestion.get(question.questionId) || []), contract.contractId])
    }
  }
  const persistedQuestions = questions.map(question => {
    const contractIds = contractIdsByQuestion.get(question.questionId) || []
    return contractIds.length
      ? { ...question, lifecycleStatus: 'planned', sourceContractIds: contractIds, updatedAt: value.generatedAt || new Date().toISOString() }
      : question
  })
  writeJsonAtomic(path.join(planningDir, 'open-questions.json'), {
    schemaVersion: 'repo-open-question-set/v1',
    snapshotId: value.snapshotId,
    investigationFrameId: value.investigationFrameId,
    questions: persistedQuestions,
    generatedAt: value.generatedAt || new Date().toISOString(),
  })
  for (const contract of contracts) {
    writeJsonAtomic(path.join(contractsDir, `${safeId(contract.contractId)}.json`), contract)
  }
  const manifest = {
    schemaVersion: 'repo-research-plan/v1',
    snapshotId: value.snapshotId,
    investigationFrameId: value.investigationFrameId,
    questionCounts: countBy(persistedQuestions, question => `${question.category}:${question.lifecycleStatus}`),
    contractRefs: contracts.map(contract => ({
      contractId: contract.contractId,
      path: path.relative(root, path.join(contractsDir, `${safeId(contract.contractId)}.json`)),
      questionIds: contract.questions.map(question => question.questionId),
    })),
    deterministicDiagnostics: value.deterministicDiagnostics || [],
    generatedAt: value.generatedAt || new Date().toISOString(),
  }
  writeJsonAtomic(path.join(planningDir, 'manifest.json'), manifest)
  return manifest
}

function contractQuestion(question) {
  return {
    questionId: question.questionId,
    question: question.question,
    rationale: question.rationale,
    criticality: question.criticality,
    blocking: question.blocking,
    targetMaps: question.targetMaps,
    targetJourneyIds: question.targetJourneyIds,
    evidenceIds: dedupe(question.evidenceIds || []),
    supportEvidenceRequirements: dedupe(question.competingHypotheses.flatMap(item => item.expectedSupportEvidence)).length
      ? dedupe(question.competingHypotheses.flatMap(item => item.expectedSupportEvidence))
      : ['Direct source evidence supporting at least one competing hypothesis.'],
    counterEvidenceRequirements: dedupe(question.competingHypotheses.flatMap(item => item.expectedCounterEvidence)).length
      ? dedupe(question.competingHypotheses.flatMap(item => item.expectedCounterEvidence))
      : ['Direct source evidence capable of refuting each competing hypothesis.'],
    completionCriteria: ['Return an explicit satisfied, partially-satisfied, blocked, or failed outcome for this question.'],
    blockedConditions: ['Required evidence is runtime-only, product-intent-only, or outside the declared file scope.'],
  }
}

function normalizeHypotheses(candidate) {
  const raw = candidate.competingHypotheses || candidate.hypotheses || []
  return raw.map((value, index) => {
    const item = typeof value === 'string' ? { statement: value } : value || {}
    const statement = String(item.statement || item.hypothesis || item.label || '').trim()
    if (!statement) return null
    return {
      ...(item.hypothesisId ? { hypothesisId: item.hypothesisId } : {}),
      statement,
      subject: String(item.subject || candidate.subject || `semantic-subject:${index + 1}`),
      predicate: String(item.predicate || candidate.predicate || 'has-semantic-role'),
      object: item.object ?? candidate.object ?? statement,
      hypothesisType: String(item.hypothesisType || candidate.hypothesisType || 'semantic-classification'),
      expectedSupportEvidence: dedupe(item.expectedSupportEvidence || item.expectedEvidence || item.supportingEvidence || []),
      expectedCounterEvidence: dedupe(item.expectedCounterEvidence || item.falsifiers || item.counterEvidence || []),
      qualifiers: item.qualifiers && typeof item.qualifiers === 'object' ? item.qualifiers : {},
      initialConfidence: clamp(item.initialConfidence ?? item.confidence ?? 0.5),
    }
  }).filter(Boolean)
}

function normalizeTargetMaps(values, dimensions = []) {
  const explicit = dedupe(values || []).map(value => value === 'runtime' ? 'runtime-flow' : value).filter(value => FRONTEND_PRODUCT_MAPS.includes(value))
  if (explicit.length) return explicit
  const dimensionToMaps = {
    'application-bootstrap': ['application', 'runtime-flow'],
    'route-layout-page': ['application', 'experience', 'runtime-flow', 'change'],
    'component-composition': ['application', 'runtime-flow', 'change'],
    'state-ownership-data-flow': ['application', 'runtime-flow', 'change'],
    'api-client': ['application', 'runtime-flow', 'change'],
    'auth-permission': ['application', 'experience', 'runtime-flow', 'change'],
    'build-deploy': ['application', 'change'],
    'testing-quality': ['application', 'change'],
    'core-journeys': ['experience', 'runtime-flow', 'change'],
  }
  return dedupe(dimensions.flatMap(value => dimensionToMaps[value] || [])).length
    ? dedupe(dimensions.flatMap(value => dimensionToMaps[value] || []))
    : ['application']
}

function normalizeMapDimensions(values) {
  const normalized = dedupe(values || []).filter(value => FRONTEND_MAP_DIMENSIONS.includes(value))
  return normalized.length ? normalized : ['core-journeys']
}

function questionValueScore(candidate, targetMaps, targetJourneys) {
  const explicit = Number(candidate.valueScore)
  if (Number.isFinite(explicit)) return clamp(explicit)
  const mapWeight = Math.min(0.45, targetMaps.length * 0.1)
  const journeyWeight = Math.min(0.35, targetJourneys.length * 0.15)
  const riskWeight = candidate.riskClass === 'high' || candidate.priority === 'critical' ? 0.2 : 0.05
  return round(Math.min(1, mapWeight + journeyWeight + riskWeight))
}

function normalizeCriticality(value) {
  if (['low', 'medium', 'high', 'critical'].includes(value)) return value
  return value === 'urgent' ? 'critical' : 'medium'
}

function normalizeCost(value) {
  const number = Number(typeof value === 'object' ? value?.score : value)
  return Number.isFinite(number) ? Math.max(0, number) : 1
}

function filesFromEntities(entities) {
  return (entities || []).flatMap(entity => {
    const value = typeof entity === 'string' ? entity : entity?.path || entity?.id || ''
    const match = String(value).match(/(?:file:)?([^\s]+\.(?:[cm]?[jt]sx?|vue|json|html|css))$/i)
    return match ? [match[1]] : []
  })
}

function fallbackEntryEntities(frame) {
  return dedupe([
    frame.applicationRoot?.entityId,
    frame.browserBootstrap?.entryEntityId,
    ...(frame.pageCandidates || []).map(candidate => candidate.entityId),
  ]).slice(0, 20).length
    ? dedupe([
        frame.applicationRoot?.entityId,
        frame.browserBootstrap?.entryEntityId,
        ...(frame.pageCandidates || []).map(candidate => candidate.entityId),
      ]).slice(0, 20)
    : [`application:${frame.frameId}`]
}

function fallbackAllowedFiles(frame) {
  const files = dedupe([
    frame.browserBootstrap?.entryPath,
    frame.applicationRoot?.sourcePath,
    ...(frame.routeRoots || []).map(candidate => candidate.sourcePath),
    ...(frame.pageCandidates || []).map(candidate => candidate.sourcePath),
  ]).slice(0, 40)
  return files.length ? files : ['package.json']
}

function dedupe(values) {
  return [...new Set((values || []).filter(value => value !== null && value !== undefined && value !== ''))]
}

function uniqueBy(values, keyFn) {
  const seen = new Set()
  return values.filter(value => {
    const key = keyFn(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function groupBy(values, keyFn) {
  const groups = new Map()
  for (const value of values) {
    const key = keyFn(value)
    groups.set(key, [...(groups.get(key) || []), value])
  }
  return groups
}

function countBy(values, keyFn) {
  const counts = {}
  for (const value of values) {
    const key = keyFn(value)
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function clamp(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(1, number))
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}
