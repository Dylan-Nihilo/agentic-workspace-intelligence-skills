import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  buildResearchContracts,
  qualifyOpenQuestions,
  writeResearchPlan,
} from '../../packages/repo-understanding-kernel/src/planning/research-contract-planner.mjs'
import { writeJourneyStore } from '../../packages/repo-understanding-kernel/src/knowledge/journey-store.mjs'
import { appendRunEvent } from '../../packages/repo-understanding-kernel/src/workflow/workflow-store.mjs'

export function installSemanticContracts(packageDir, options = {}) {
  const root = path.resolve(packageDir)
  const framePath = path.join(root, 'static', 'investigation-frame.json')
  const graph = readJson(path.join(root, 'static', 'static-program-graph.json'))
  const frame = readJson(framePath)
  const sourcePaths = (graph.files || []).map(file => file.sourcePath).filter(Boolean)
  if (sourcePaths.length < 2) throw new Error('v3 workflow fixture requires at least two parsed source files')
  const count = Number(options.count || 1)
  const generatedAt = options.generatedAt || graph.generatedAt
  const ambiguities = Array.from({ length: count }, (_, index) => {
    const leftPath = sourcePaths[index % sourcePaths.length]
    const rightPath = sourcePaths[(index + 1) % sourcePaths.length]
    return {
      ambiguityId: `ambiguity:eval:${index + 1}`,
      question: `Which source owns semantic responsibility ${index + 1}?`,
      rationale: 'The answer changes the Application and Change Product Maps.',
      competingHypotheses: [
        hypothesis(`hypothesis:eval:${index + 1}:left`, leftPath, `semantic-responsibility-${index + 1}`),
        hypothesis(`hypothesis:eval:${index + 1}:right`, rightPath, `semantic-responsibility-${index + 1}`),
      ],
      relatedEntityIds: [`module:${leftPath}`, `module:${rightPath}`],
      evidenceRefs: [`evidence:file:${leftPath}`, `evidence:file:${rightPath}`],
      targetMaps: ['application', 'change'],
      targetMapDimensions: ['component-composition'],
      targetJourneyIds: [],
      communityIds: [`community:eval:${index + 1}`],
      allowedFiles: [leftPath, rightPath],
      criticality: options.criticality || 'high',
      blocking: options.blocking !== false,
    }
  })
  const nextFrame = { ...frame, unresolvedSemanticAmbiguities: ambiguities }
  writeJson(framePath, nextFrame)
  const qualified = qualifyOpenQuestions({
    investigationFrame: nextFrame,
    snapshotId: graph.snapshotId,
    generatedAt,
  })
  const contracts = buildResearchContracts({
    snapshotId: graph.snapshotId,
    investigationFrame: nextFrame,
    openQuestions: qualified.openQuestions,
    deterministicContextRefs: [
      'static/support-decision.json',
      'static/investigation-frame.json',
      'static/static-program-graph.json',
      'static/community-map.json',
      'static/neighbor-map.json',
      'static/inventory.json',
    ],
    generatedAt,
  })
  if (contracts.length !== count) throw new Error(`Expected ${count} ResearchContracts, got ${contracts.length}`)
  const nodeSemanticPlanPath = path.join(root, 'planning', 'node-semantic-batches.json')
  const nodeSemanticPlan = fs.existsSync(nodeSemanticPlanPath) ? readJson(nodeSemanticPlanPath) : null
  fs.rmSync(path.join(root, 'planning'), { recursive: true, force: true })
  const manifest = writeResearchPlan(root, {
    snapshotId: graph.snapshotId,
    investigationFrameId: nextFrame.frameId,
    openQuestions: qualified.openQuestions,
    deterministicDiagnostics: qualified.deterministicDiagnostics,
    contracts,
    generatedAt,
  })
  if (nodeSemanticPlan) writeJson(nodeSemanticPlanPath, nodeSemanticPlan)
  for (const question of qualified.openQuestions) appendRunEvent(root, 'question-qualified', { question })
  for (const ref of manifest.contractRefs) {
    const contract = readJson(path.resolve(root, ref.path))
    appendRunEvent(root, 'research-contracted', { contract, path: ref.path })
    for (const questionId of ref.questionIds) appendRunEvent(root, 'question-planned', { questionId, contractId: ref.contractId })
  }
  return { graph, frame: nextFrame, questions: qualified.openQuestions, contracts, manifest }
}

export function writeAcceptedNodeSemanticFixtureResults(packageDir, plan) {
  for (const batch of plan.batches) {
    const contextPath = path.join(
      packageDir,
      'research',
      'node-semantics',
      'contexts',
      `batch-${String(batch.ordinal).padStart(4, '0')}.json`,
    )
    const dispatch = readJson(contextPath)
    const contextByPath = new Map(dispatch.context.files.map(file => [file.filePath, file]))
    const catalog = {
      schemaVersion: 'repo-node-semantic-catalog/v1',
      snapshotId: plan.snapshotId,
      status: 'partial',
      entries: batch.primaryFiles.map(filePath => {
        const context = contextByPath.get(filePath)
        return {
          filePath,
          entityIds: (context?.entities || []).map(entity => entity.entityId),
          scopeFiles: [filePath],
          semanticKind: semanticKindForFixture(filePath),
          title: path.basename(filePath),
          responsibility: {
            summary: `Fixture semantic for ${filePath}`,
            confidence: 0.9,
            evidence: [{ sourcePath: filePath, startLine: 1, endLine: 1 }],
          },
          inputs: [],
          actions: [],
          state: [],
          outputs: [],
          conditions: [],
          boundaries: [],
          collaborators: [],
          unknowns: [],
          confidence: 0.9,
          status: 'draft',
          producer: { kind: 'agent', workItemId: batch.batchId },
        }
      }),
      generatedAt: '2026-07-14T00:00:00Z',
    }
    const resultPath = path.resolve(packageDir, batch.outputRef)
    fs.mkdirSync(path.dirname(resultPath), { recursive: true })
    fs.writeFileSync(resultPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
    const review = {
      schemaVersion: 'repo-node-semantic-review/v1',
      planId: plan.planId,
      snapshotId: plan.snapshotId,
      batchId: batch.batchId,
      catalogHash: `sha256:${createHash('sha256').update(JSON.stringify(catalog)).digest('hex')}`,
      status: 'accepted',
      entries: batch.primaryFiles.map(filePath => ({
        filePath,
        status: 'accepted',
        checks: { responsibilityEvidence: true, semanticKind: true, noUnsupportedClaims: true },
        issues: [],
      })),
      reviewer: { kind: 'agent', reviewId: 'review:workflow-fixture' },
      generatedAt: '2026-07-14T00:00:00Z',
    }
    fs.mkdirSync(path.dirname(dispatch.reviewPath), { recursive: true })
    fs.writeFileSync(dispatch.reviewPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8')
  }
}

function semanticKindForFixture(filePath) {
  if (filePath.endsWith('.html')) return 'config'
  if (/[/\\](pages|views)[/\\]/.test(filePath)) return 'page'
  if (/[/\\](components)[/\\]/.test(filePath)) return 'component'
  if (/[/\\](api|services?)[/\\]/.test(filePath)) return 'service'
  if (/[/\\](store|state)[/\\]/.test(filePath)) return 'state'
  if (/[/\\](router|routes)[/\\]/.test(filePath)) return 'route'
  return 'other'
}

export function writeSatisfiedWorkResult(packageDir, item, options = {}) {
  const root = path.resolve(packageDir)
  const contract = readJson(path.resolve(root, item.contractRef))
  const evidence = readJsonLines(path.join(root, 'store', 'evidence.jsonl'))
  const evidenceBySourcePath = new Map(evidence.map(value => [value.sourcePath, value]))
  if (!evidenceBySourcePath.size) throw new Error('Semantic store has no governed Evidence')
  const usedEvidence = new Set()
  const winnerByQuestion = new Map()
  for (const value of contract.hypotheses) if (!winnerByQuestion.has(value.questionId)) winnerByQuestion.set(value.questionId, value)
  const outcomeHypotheses = contract.hypotheses.map(value => {
    const sourcePath = hypothesisSourcePath(value, contract.scope.allowedFiles)
    const sourceEvidence = evidenceBySourcePath.get(sourcePath)
    if (!sourceEvidence) throw new Error(`No governed Evidence matches Hypothesis source: ${sourcePath}`)
    const winner = winnerByQuestion.get(value.questionId)
    const winnerPath = hypothesisSourcePath(winner, contract.scope.allowedFiles)
    const winnerEvidence = evidenceBySourcePath.get(winnerPath)
    if (!winnerEvidence) throw new Error(`No governed Evidence matches winning Hypothesis source: ${winnerPath}`)
    const supported = value.hypothesisId === winner.hypothesisId
    const evidenceId = supported ? sourceEvidence.evidenceId : winnerEvidence.evidenceId
    usedEvidence.add(evidenceId)
    return {
      schemaVersion: 'repo-hypothesis/v1',
      hypothesisId: value.hypothesisId,
      contractId: contract.contractId,
      questionId: value.questionId,
      statement: value.statement,
      subject: value.subject,
      predicate: value.predicate,
      object: value.object,
      hypothesisType: value.hypothesisType,
      supportEvidenceIds: supported ? [evidenceId] : [],
      counterEvidenceIds: supported ? [] : [evidenceId],
      qualifiers: value.qualifiers || {},
      confidence: 0.95,
      status: supported ? 'supported' : 'refuted',
      impact: { mapDimensions: ['component-composition'], journeyIds: [] },
      followUpQuestionIds: [],
    }
  })
  const byQuestion = new Map()
  for (const hypothesis of outcomeHypotheses) {
    byQuestion.set(hypothesis.questionId, [...(byQuestion.get(hypothesis.questionId) || []), hypothesis])
  }
  const questionOutcomes = contract.questions.map(question => {
    const hypotheses = byQuestion.get(question.questionId) || []
    return {
      questionId: question.questionId,
      status: 'satisfied',
      answer: `Semantic responsibility for ${question.questionId} was adjudicated within contract scope.`,
      supportEvidenceIds: unique(hypotheses.flatMap(value => value.supportEvidenceIds)),
      counterEvidenceIds: unique(hypotheses.flatMap(value => value.counterEvidenceIds)),
      hypothesisIds: hypotheses.map(value => value.hypothesisId),
      satisfiedCriteria: [...(question.completionCriteria || [])],
      unmetCriteria: [],
      blockerQuestionIds: [],
      confidence: 0.95,
    }
  })
  const usage = options.usage || { status: 'unavailable' }
  const outcome = {
    schemaVersion: 'repo-task-outcome/v1',
    contractId: contract.contractId,
    status: 'satisfied',
    questionOutcomes,
    hypotheses: outcomeHypotheses,
    newSemanticQuestions: [],
    deterministicDiagnostics: [],
    runtimeBlockers: [],
    productIntentQuestions: [],
    completionEvidence: [...usedEvidence].sort(),
    unmetCriteria: [],
    scopeObserved: {
      communityIds: [...contract.scope.communityIds],
      entryEntities: [...contract.scope.entryEntities],
      filesRead: [...contract.scope.allowedFiles],
      neighborDepth: contract.scope.neighborDepth,
    },
    cost: {
      usageStatus: usage.status,
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
    },
  }
  writeJson(item.outputArtifactPath, outcome)
  const workResultPath = options.workResultPath || path.join(root, 'work', 'results', `${safeId(item.itemId)}.result.json`)
  const workResult = {
    schemaVersion: 'repo-work-result/v3',
    itemId: item.itemId,
    runId: item.runId,
    snapshotId: options.snapshotId || item.snapshotId,
    attempt: item.attempt,
    contractId: contract.contractId,
    status: 'completed',
    outcomeStatus: 'satisfied',
    completionSummary: 'All ResearchContract questions and hypotheses were adjudicated with governed evidence.',
    output: { path: item.outputArtifactPath, schemaVersion: outcome.schemaVersion },
    producer: {
      role: item.role,
      runtime: options.runtime || 'v3-eval-runtime',
      ...(options.model ? { model: options.model } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      usage,
    },
    artifactHashes: [{ artifactRef: item.outputArtifactPath, algorithm: 'sha256', value: hashFile(item.outputArtifactPath) }],
    readSet: buildReadSet(root, contract.scope.allowedFiles),
    scopeViolations: [],
    errors: [],
    producedAt: options.producedAt || new Date().toISOString(),
  }
  writeJson(workResultPath, workResult)
  return { contract, outcome, workResult, workResultPath }
}

function hypothesisSourcePath(hypothesis, allowedFiles) {
  const subject = String(hypothesis?.subject || '')
  if (subject.startsWith('module:')) return subject.slice('module:'.length)
  const matched = (allowedFiles || []).find(file => subject.includes(file))
  if (!matched) throw new Error(`Hypothesis subject does not identify a contract-scoped source file: ${subject}`)
  return matched
}

export function writeFailedWorkResult(packageDir, item, options = {}) {
  const root = path.resolve(packageDir)
  const contract = readJson(path.resolve(root, item.contractRef))
  const workResultPath = options.workResultPath || path.join(root, 'work', 'results', `${safeId(item.itemId)}.result.json`)
  const value = {
    schemaVersion: 'repo-work-result/v3',
    itemId: item.itemId,
    runId: item.runId,
    snapshotId: options.snapshotId || item.snapshotId,
    attempt: item.attempt,
    contractId: contract.contractId,
    status: 'failed',
    outcomeStatus: 'failed',
    completionSummary: options.summary || 'Synthetic v3 worker failure.',
    producer: { role: item.role, runtime: options.runtime || 'v3-eval-runtime', usage: options.usage || { status: 'unavailable' } },
    artifactHashes: [],
    readSet: [],
    scopeViolations: [],
    errors: [{ code: 'synthetic-worker-failure', message: options.message || 'Synthetic worker failure.', retryable: true }],
    producedAt: options.producedAt || new Date().toISOString(),
  }
  writeJson(workResultPath, value)
  return { contract, workResult: value, workResultPath }
}

export function writeSynthesisWorkResult(packageDir, item, options = {}) {
  const root = path.resolve(packageDir)
  const contract = readJson(path.resolve(root, item.contractRef))
  const mapManifest = readJson(path.join(root, 'projections', 'manifest.json'))
  const journeyManifest = readJson(path.join(root, 'store', 'journeys', 'manifest.json'))
  const state = readJson(path.join(root, 'state', 'run-state.json'))
  const unresolvedQuestions = Object.values(state.questions || {})
    .filter(question => !['resolved', 'waived', 'invalidated'].includes(question.status))
  const journeyEntries = journeyManifest.entries || []
  const narrative = {
    schemaVersion: 'repo-synthesis-narrative/v3',
    snapshotId: item.snapshotId,
    mapManifestRef: 'projections/manifest.json',
    projectionKey: mapManifest.projectionKey,
    title: 'Frontend repository understanding',
    executiveSummary: 'The verified Product Maps describe the current frontend repository without adding ungoverned facts.',
    applicationSummary: 'The Application Map identifies bootstrap, route, page, boundary, and dependency structure.',
    experienceSummary: 'The Experience Map preserves governed Journeys and their current closure state.',
    runtimeFlowSummary: 'The Runtime Flow Map keeps the ordered page, event, handler, state, request, response, feedback, and outcome chain.',
    changeSummary: 'The Change Map identifies evidence-backed impact surfaces and unresolved dimensions.',
    journeySummaries: journeyEntries.map(entry => ({
      journeyId: entry.journeyId,
      summary: `Journey ${entry.journeyId} is ${entry.status}.`,
      status: normalizeJourneyStatus(entry.status),
      evidenceRefs: [],
    })),
    limitations: unresolvedQuestions.map(question => ({
      limitationId: `limitation:${safeId(question.questionId)}`,
      category: normalizeLimitationCategory(question.category),
      summary: question.question || question.rationale || `Question ${question.questionId} remains unresolved.`,
      mapDimensions: ['core-journeys'],
      journeyIds: [],
      questionIds: [question.questionId],
      evidenceRefs: [],
    })),
    mapRefs: Object.fromEntries(Object.entries(mapManifest.projections).map(([key, entry]) => [key, entry.path])),
    journeyRefs: journeyEntries.map(entry => entry.journeyId),
    claimRefs: [],
    evidenceRefs: [],
    questionRefs: Object.keys(state.questions || {}).sort(),
    generatedAt: options.producedAt || new Date().toISOString(),
  }
  writeJson(item.outputArtifactPath, narrative)
  const workResultPath = options.workResultPath || path.join(root, 'work', 'results', `${safeId(item.itemId)}.result.json`)
  const workResult = {
    schemaVersion: 'repo-work-result/v3',
    itemId: item.itemId,
    runId: item.runId,
    snapshotId: item.snapshotId,
    attempt: item.attempt,
    contractId: contract.contractId,
    status: 'completed',
    outcomeStatus: 'satisfied',
    completionSummary: 'The four current Product Maps and governed Journeys were synthesized without adding facts.',
    output: { path: item.outputArtifactPath, schemaVersion: narrative.schemaVersion },
    producer: {
      role: item.role,
      runtime: options.runtime || 'v3-eval-runtime',
      usage: options.usage || { status: 'unavailable' },
    },
    artifactHashes: [{ artifactRef: item.outputArtifactPath, algorithm: 'sha256', value: hashFile(item.outputArtifactPath) }],
    readSet: [],
    scopeViolations: [],
    errors: [],
    producedAt: narrative.generatedAt,
  }
  writeJson(workResultPath, workResult)
  return { contract, narrative, workResult, workResultPath }
}

export function installClosedJourney(packageDir, options = {}) {
  const root = path.resolve(packageDir)
  const graph = readJson(path.join(root, 'static', 'static-program-graph.json'))
  const page = graph.nodes.find(node => node.kind === 'page') || graph.nodes[0]
  if (!page) throw new Error('Closed Journey fixture requires at least one Static Program Graph node')
  const generatedAt = options.generatedAt || graph.generatedAt || new Date().toISOString()
  const evidenceId = page.evidenceRefs?.[0] || `evidence:file:${page.source?.sourcePath || 'fixture'}`
  const journeyId = options.journeyId || 'journey:eval:closed'
  const stepId = `${journeyId}:step:1`
  const pageBindingId = `${journeyId}:binding:page`
  const outcomeBindingId = `${journeyId}:binding:outcome`
  const definition = {
    schemaVersion: 'repo-journey-definition/v1',
    journeyId,
    snapshotId: graph.snapshotId,
    title: 'Open the governed frontend page',
    actor: 'frontend-user',
    goal: 'Reach the page and observe its rendered outcome.',
    trigger: {
      kind: 'route-entry',
      description: 'Enter the governed frontend page.',
      entityId: page.nodeId,
      evidenceIds: [evidenceId],
      claimIds: [],
    },
    entry: {
      routeId: null,
      pageId: page.nodeId,
      sourcePath: page.source?.sourcePath || null,
      evidenceIds: [evidenceId],
      claimIds: [],
    },
    steps: [{
      stepId,
      order: 1,
      title: 'Render page',
      description: 'The governed page renders its observable frontend outcome.',
      branchIds: [],
      blocking: false,
      evidenceIds: [evidenceId],
      claimIds: [],
    }],
    branches: [],
    visibleFeedback: [],
    successOutcome: {
      outcomeId: `${journeyId}:outcome:success`,
      stepId,
      description: 'The governed frontend page is rendered.',
      evidenceIds: [evidenceId],
      claimIds: [],
    },
    failureOutcomes: [],
    evidenceIds: [evidenceId],
    claimIds: [],
    criticality: 'medium',
    status: 'closed',
    createdAt: generatedAt,
    updatedAt: generatedAt,
  }
  const bindingSet = {
    schemaVersion: 'repo-journey-binding/v1',
    bindingSetId: `binding-set:${safeId(journeyId)}`,
    journeyId,
    snapshotId: graph.snapshotId,
    bindings: [
      {
        bindingId: pageBindingId,
        stepId,
        order: 1,
        branchId: null,
        bindingType: 'page',
        entityId: page.nodeId,
        entityType: page.kind,
        sourcePath: page.source?.sourcePath || null,
        evidenceIds: [evidenceId],
        claimIds: [],
        confidence: 1,
        status: 'confirmed',
      },
      {
        bindingId: outcomeBindingId,
        stepId,
        order: 1,
        branchId: null,
        bindingType: 'outcome',
        entityId: page.nodeId,
        entityType: page.kind,
        sourcePath: page.source?.sourcePath || null,
        evidenceIds: [evidenceId],
        claimIds: [],
        confidence: 1,
        status: 'confirmed',
      },
    ],
    relations: [{
      fromBindingId: pageBindingId,
      toBindingId: outcomeBindingId,
      kind: 'produces',
      branchId: null,
      evidenceIds: [evidenceId],
      claimIds: [],
    }],
    status: 'closed',
    generatedAt,
  }
  const store = writeJourneyStore({
    packageDir: root,
    definitions: [definition],
    bindingSets: [bindingSet],
    staticProgramGraph: graph,
    snapshotId: graph.snapshotId,
    generatedAt,
  })
  const closure = store.closureReports[0]
  if (closure?.status !== 'closed') throw new Error(`Closed Journey fixture did not close: ${JSON.stringify(closure)}`)
  appendRunEvent(root, 'journey-closed', { journey: definition, closure }, { actor: 'kernel' })
  return { definition, bindingSet, closure, store }
}

function hypothesis(hypothesisId, sourcePath, object) {
  return {
    hypothesisId,
    statement: `${sourcePath} owns ${object}.`,
    subject: `module:${sourcePath}`,
    predicate: 'owns-semantic-responsibility',
    object,
    hypothesisType: 'semantic-owner',
    expectedSupportEvidence: [`Direct source evidence from ${sourcePath}.`],
    expectedCounterEvidence: [`Counter evidence from the competing source.`],
    qualifiers: {},
    initialConfidence: 0.5,
  }
}

function buildReadSet(packageDir, files) {
  const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
  const graph = readJson(path.join(packageDir, 'static', 'static-program-graph.json'))
  const structureByPath = new Map((graph.files || []).map(file => [file.sourcePath, file.structureFingerprint]))
  const repoRoot = path.resolve(inventory.repo.path)
  return files.map(relativePath => {
    const absolute = path.resolve(repoRoot, relativePath)
    if (!fs.existsSync(absolute)) throw new Error(`ResearchContract file does not exist: ${relativePath}`)
    const structureFingerprint = structureByPath.get(relativePath)
    if (!structureFingerprint) throw new Error(`Static Program Graph has no governed structure fingerprint for: ${relativePath}`)
    return {
      path: relativePath,
      fingerprintAlgorithm: 'sha256',
      contentFingerprint: hashFile(absolute),
      structureFingerprint,
    }
  })
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function normalizeJourneyStatus(value) {
  if (value === 'closed') return 'closed'
  if (value === 'blocked' || value === 'invalidated') return 'blocked'
  return 'open'
}

function normalizeLimitationCategory(value) {
  if (value === 'runtime-external-blocked') return 'runtime'
  if (value === 'product-intent') return 'product-intent'
  if (value === 'deterministic-diagnostic') return 'deterministic-diagnostic'
  if (value === 'journey-closure') return 'journey-closure'
  return 'semantic'
}

function unique(values) {
  return [...new Set(values)]
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
