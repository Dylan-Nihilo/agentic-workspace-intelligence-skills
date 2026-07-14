import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { snapshotIdForInventory } from '../snapshot/repo-snapshot.mjs'

const WORK_ITEM_STATES = new Set(['ready', 'issued', 'result-produced', 'accepted', 'rejected', 'abandoned', 'waived'])
const TRACE_EVENT_TYPES = new Set(['work-issued', 'agent-started', 'agent-completed', 'agent-failed', 'result-accepted', 'result-rejected'])
const RUN_EVENT_SCHEMA = readBundledSchema('../../schemas/run-event.schema.json')
const WORK_ITEM_SCHEMA = readBundledSchema('../../schemas/work-item.schema.json')
const RUN_EVENT_TYPES = new Set(RUN_EVENT_SCHEMA.properties.eventType.enum)
const RUN_EVENT_FIELDS = new Set(Object.keys(RUN_EVENT_SCHEMA.properties))
const RUN_EVENT_REQUIRED_FIELDS = new Set(RUN_EVENT_SCHEMA.required)
const WORK_ITEM_FIELDS = new Set(Object.keys(WORK_ITEM_SCHEMA.properties))
const WORK_ITEM_REQUIRED_FIELDS = new Set(WORK_ITEM_SCHEMA.required)
const WORK_KINDS = new Set(WORK_ITEM_SCHEMA.properties.kind.enum)
const QUALITY_CLASSES = new Set(WORK_ITEM_SCHEMA.properties.qualityClass.enum)
const CRITICALITIES = new Set(WORK_ITEM_SCHEMA.properties.criticality.enum)
const BLOCKING_MAP_DIMENSIONS = new Set(WORK_ITEM_SCHEMA.properties.blockingMapDimensions.items.enum)
const BUDGET_HINT_FIELDS = new Set(Object.keys(WORK_ITEM_SCHEMA.properties.budgetHints.properties))

export function workflowPaths(packageDir) {
  const root = path.resolve(packageDir)
  return {
    root,
    workItems: path.join(root, 'work', 'items'),
    workResults: path.join(root, 'work', 'results'),
    events: path.join(root, 'store', 'run-events.jsonl'),
    state: path.join(root, 'state', 'run-state.json'),
    trace: path.join(root, 'debug', 'agent-trace.jsonl'),
  }
}

export function ensureWorkflow(packageDir, metadata = {}) {
  const paths = workflowPaths(packageDir)
  ensureDirectories(paths)
  let events = readJsonLines(paths.events)
  if (events.length) verifyEventChain(events)
  const desiredSnapshotId = metadata.snapshotId || snapshotIdForPackage(paths.root)
  if (events.length && events[0].payload.snapshotId !== desiredSnapshotId) {
    if (!metadata.allowSnapshotTransition) {
      throw new Error(`Package Snapshot changed: active ${events[0].payload.snapshotId}, current ${desiredSnapshotId}. Start a new analyze run before continuing.`)
    }
    archiveWorkflowRun(paths, events, {
      nextSnapshotId: desiredSnapshotId,
      reason: metadata.transitionReason || 'snapshot-changed',
    })
    events = []
  }
  if (!events.length) {
    const createdAt = new Date().toISOString()
    const snapshotId = desiredSnapshotId
    const runId = metadata.runId || `run:${hashText(`${paths.root}|${snapshotId}|${createdAt}`).slice(0, 20)}`
    const event = createEvent({
      runId,
      sequence: 1,
      eventType: 'run-created',
      actor: 'kernel',
      payload: {
        snapshotId,
        packageDir: paths.root,
        debug: true,
        ...(metadata.transitionReason ? { transitionReason: metadata.transitionReason } : {}),
      },
      previousEventHash: null,
      occurredAt: createdAt,
    })
    assertValidRunEvent(event)
    appendJsonLine(paths.events, event)
    events = [event]
  }
  return writeMaterializedState(paths, events)
}

function archiveWorkflowRun(paths, events, transition) {
  const state = materializeRunState(events)
  const active = Object.values(state.workItems).filter(item => ['ready', 'issued', 'result-produced'].includes(item.status))
  if (active.length) {
    throw new Error(`Cannot change Snapshot while ${active.length} WorkItems are in flight: ${active.map(item => item.itemId).join(', ')}`)
  }
  const archiveDir = path.join(paths.root, 'store', 'runs', safeId(state.runId))
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.copyFileSync(paths.events, path.join(archiveDir, 'run-events.jsonl'))
  if (fs.existsSync(paths.state)) fs.copyFileSync(paths.state, path.join(archiveDir, 'run-state.json'))
  if (fs.existsSync(paths.trace)) fs.copyFileSync(paths.trace, path.join(archiveDir, 'agent-trace.jsonl'))
  if (fs.existsSync(paths.workItems)) fs.cpSync(paths.workItems, path.join(archiveDir, 'work-items'), { recursive: true })
  if (fs.existsSync(paths.workResults)) fs.cpSync(paths.workResults, path.join(archiveDir, 'work-results'), { recursive: true })
  writeJsonAtomic(path.join(archiveDir, 'transition.json'), {
    schemaVersion: 'repo-run-transition/v1',
    previousRunId: state.runId,
    previousSnapshotId: state.snapshotId,
    nextSnapshotId: transition.nextSnapshotId,
    reason: transition.reason,
    archivedAt: new Date().toISOString(),
  })
  fs.rmSync(paths.events, { force: true })
  fs.rmSync(paths.state, { force: true })
  fs.rmSync(paths.trace, { force: true })
  fs.rmSync(paths.workItems, { recursive: true, force: true })
  fs.rmSync(paths.workResults, { recursive: true, force: true })
  ensureDirectories(paths)
}

export function appendRunEvent(packageDir, eventType, payload = {}, options = {}) {
  assertValidRunEventInput(eventType, payload)
  const paths = workflowPaths(packageDir)
  const current = ensureWorkflow(paths.root)
  const events = readJsonLines(paths.events)
  const previous = events.at(-1)
  const event = createEvent({
    runId: current.runId,
    sequence: (previous?.sequence || 0) + 1,
    eventType,
    actor: options.actor || 'kernel',
    payload,
    previousEventHash: previous?.eventHash || null,
    occurredAt: options.occurredAt || new Date().toISOString(),
  })
  assertValidRunEvent(event)
  const nextEvents = [...events, event]
  const state = materializeRunState(nextEvents)
  appendJsonLine(paths.events, event)
  writeJsonAtomic(paths.state, state)
  return { event, state }
}

export function createWorkItem(packageDir, input) {
  const paths = workflowPaths(packageDir)
  const state = ensureWorkflow(paths.root)
  const attempt = Number(input.attempt || 1)
  const communityIds = [...new Set(input.communityIds || [])]
  const idempotencyKey = input.idempotencyKey || hashText([
    state.snapshotId,
    input.kind,
    input.role,
    input.contractRef,
    ...communityIds,
  ].join('|'))
  const itemId = input.itemId || `work:${hashText(`${idempotencyKey}|${attempt}`).slice(0, 20)}`
  const item = {
    schemaVersion: 'repo-work-item/v3',
    itemId,
    runId: state.runId,
    snapshotId: state.snapshotId,
    attempt,
    kind: input.kind,
    role: input.role,
    contractRef: input.contractRef,
    objectiveSummary: String(input.objectiveSummary || '').trim(),
    blocking: input.blocking !== false,
    dependencies: [...new Set(input.dependencies || [])],
    completionPolicyRef: input.completionPolicyRef,
    inputArtifactRefs: [...new Set(input.inputArtifactRefs || [])],
    outputArtifactPath: input.outputArtifactPath,
    outputSchemaRef: input.outputSchemaRef,
    communityIds,
    neighborMapRef: input.neighborMapRef ?? null,
    blockingMapDimensions: [...new Set(input.blockingMapDimensions || [])],
    blockingJourneyIds: [...new Set(input.blockingJourneyIds || [])],
    qualityClass: input.qualityClass || 'analytical',
    criticality: input.criticality || 'medium',
    budgetHints: input.budgetHints || {},
    idempotencyKey,
    ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    createdAt: input.createdAt || new Date().toISOString(),
  }
  const issues = validateWorkItem(item)
  if (issues.length) throw new Error(`Invalid WorkItem:\n${issues.map(issue => `- ${issue}`).join('\n')}`)
  return item
}

export function planAndIssueWorkItem(packageDir, item) {
  const issues = validateWorkItem(item)
  if (issues.length) throw new Error(`Invalid WorkItem:\n${issues.map(issue => `- ${issue}`).join('\n')}`)
  const paths = workflowPaths(packageDir)
  const state = ensureWorkflow(paths.root)
  if (item.runId !== state.runId || item.snapshotId !== state.snapshotId) {
    throw new Error(`WorkItem ${item.itemId} does not belong to active run/snapshot`)
  }
  const itemPath = path.join(paths.workItems, `${safeId(item.itemId)}.json`)
  if (!fs.existsSync(itemPath)) {
    writeJsonAtomic(itemPath, item)
    appendRunEvent(paths.root, 'work-planned', { item, itemPath })
  }
  const nextState = ensureWorkflow(paths.root)
  const current = nextState.workItems[item.itemId]
  if (current?.status === 'ready') {
    appendRunEvent(paths.root, 'work-issued', { itemId: item.itemId, attempt: item.attempt })
    recordAgentTrace(paths.root, {
      itemId: item.itemId,
      eventType: 'work-issued',
      role: item.role,
      usage: { status: 'pending' },
      message: 'WorkItem issued to host runtime; agent execution has not been confirmed yet.',
    })
  }
  return { itemPath, workResultPath: workResultPathForItem(paths, item), item, state: ensureWorkflow(paths.root) }
}

export function syncProducedResults(packageDir) {
  const paths = workflowPaths(packageDir)
  let state = ensureWorkflow(paths.root)
  for (const item of Object.values(state.workItems)) {
    if (item.status !== 'issued') continue
    const resultPath = workResultPathForItem(paths, item)
    if (!fs.existsSync(resultPath)) continue
    appendRunEvent(paths.root, 'result-detected', {
      itemId: item.itemId,
      attempt: item.attempt,
      resultPath,
    })
    state = ensureWorkflow(paths.root)
  }
  return state
}

export function acceptWorkResult(packageDir, itemId, details = {}) {
  const state = syncProducedResults(packageDir)
  const item = state.workItems[itemId]
  if (!item) throw new Error(`Unknown WorkItem: ${itemId}`)
  if (item.status !== 'result-produced') throw new Error(`WorkItem ${itemId} is ${item.status}, expected result-produced`)
  const next = appendRunEvent(packageDir, 'result-accepted', {
    itemId,
    attempt: item.attempt,
    ...details,
  }).state
  recordAgentTrace(packageDir, {
    itemId,
    eventType: 'result-accepted',
    role: item.role,
    usage: { status: 'unavailable' },
    message: details.message || 'WorkResult passed kernel validation and ingest.',
  })
  return next
}

export function rejectWorkResult(packageDir, itemId, details = {}) {
  const state = syncProducedResults(packageDir)
  const item = state.workItems[itemId]
  if (!item) throw new Error(`Unknown WorkItem: ${itemId}`)
  if (!['issued', 'result-produced'].includes(item.status)) {
    throw new Error(`WorkItem ${itemId} is ${item.status}, cannot reject result`)
  }
  const next = appendRunEvent(packageDir, 'result-rejected', {
    itemId,
    attempt: item.attempt,
    ...details,
  }).state
  recordAgentTrace(packageDir, {
    itemId,
    eventType: 'result-rejected',
    role: item.role,
    usage: { status: 'unavailable' },
    message: details.message || 'WorkResult was rejected by kernel validation.',
  })
  return next
}

export function validateWorkResultEnvelope(packageDir, value) {
  const paths = workflowPaths(packageDir)
  const state = syncProducedResults(paths.root)
  const issues = []
  if (value?.schemaVersion !== 'repo-work-result/v3') issues.push('schemaVersion must be repo-work-result/v3')
  const item = state.workItems[value?.itemId]
  if (!item) issues.push(`itemId is not active: ${value?.itemId || 'missing'}`)
  if (item && !['issued', 'result-produced'].includes(item.status)) {
    issues.push(`WorkItem ${item.itemId} is ${item.status}; expected issued or result-produced`)
  }
  if (item && value.runId !== item.runId) issues.push(`runId mismatch: expected ${item.runId}`)
  if (item && value.snapshotId !== item.snapshotId) issues.push(`snapshotId mismatch: expected ${item.snapshotId}`)
  if (item && Number(value.attempt) !== item.attempt) issues.push(`attempt mismatch: expected ${item.attempt}`)
  const expectedContractId = item ? contractIdForItem(paths.root, item) : null
  if (item && !expectedContractId) issues.push(`contractRef is unreadable or missing contractId: ${item.contractRef}`)
  if (item && expectedContractId && value?.contractId !== expectedContractId) {
    issues.push(`contractId mismatch: expected ${expectedContractId}`)
  }
  if (!['completed', 'failed', 'blocked'].includes(value?.status)) issues.push('status must be completed, failed, or blocked')
  if (!['satisfied', 'partially-satisfied', 'blocked', 'failed'].includes(value?.outcomeStatus)) {
    issues.push('outcomeStatus must be satisfied, partially-satisfied, blocked, or failed')
  }
  if (!String(value?.completionSummary || '').trim()) issues.push('completionSummary is required')
  if (!value?.producer?.role) issues.push('producer.role is required')
  if (item && value?.producer?.role && value.producer.role !== item.role) {
    issues.push(`producer.role mismatch: expected ${item.role}`)
  }
  if (!['reported', 'unavailable'].includes(value?.producer?.usage?.status)) issues.push('producer.usage.status must be reported or unavailable')
  if (!Array.isArray(value?.artifactHashes)) issues.push('artifactHashes must be an array')
  if (!Array.isArray(value?.readSet)) issues.push('readSet must be an array')
  if (!Array.isArray(value?.scopeViolations)) issues.push('scopeViolations must be an array')
  if (!Array.isArray(value?.errors)) issues.push('errors must be an array')
  if (!value?.producedAt) issues.push('producedAt is required')
  if (item && Array.isArray(value?.readSet)) validateReadSet(paths.root, item, value.readSet, issues)
  if (value?.status === 'completed') {
    if (!value?.output?.path) issues.push('completed result requires output.path')
    if (!value?.output?.schemaVersion) issues.push('completed result requires output.schemaVersion')
    if (item && value?.output?.path && path.resolve(value.output.path) !== path.resolve(item.outputArtifactPath)) {
      issues.push(`output.path mismatch: expected ${item.outputArtifactPath}`)
    }
    if (item && value?.output?.schemaVersion) {
      const outputSchemaPath = path.isAbsolute(item.outputSchemaRef) ? item.outputSchemaRef : path.resolve(paths.root, item.outputSchemaRef)
      const outputSchema = readJsonIfExists(outputSchemaPath)
      const expectedOutputVersion = outputSchema?.properties?.schemaVersion?.const
      if (expectedOutputVersion && value.output.schemaVersion !== expectedOutputVersion) {
        issues.push(`output.schemaVersion mismatch: expected ${expectedOutputVersion}`)
      }
    }
    if (value?.output?.path && !isInside(paths.root, value.output.path)) issues.push('output.path must stay inside package')
    if (value?.output?.path && !fs.existsSync(path.resolve(value.output.path))) issues.push(`output.path does not exist: ${value.output.path}`)
    if (value?.scopeViolations?.length) issues.push('completed result cannot contain scopeViolations')
    validateArtifactHashes(paths.root, value, issues)
  }
  return { valid: issues.length === 0, issues, item }
}

export function recordCompletionFromWorkResult(packageDir, value) {
  const traces = readAgentTraces(packageDir)
  const hasCompletion = traces.some(trace => trace.itemId === value.itemId
    && trace.attempt === Number(value.attempt)
    && ['agent-completed', 'agent-failed'].includes(trace.eventType))
  if (hasCompletion) return null
  const eventType = value.status === 'completed' ? 'agent-completed' : 'agent-failed'
  return recordAgentTrace(packageDir, {
    itemId: value.itemId,
    eventType,
    role: value.producer?.role,
    runtime: value.producer?.runtime,
    model: value.producer?.model,
    effort: value.producer?.effort,
    sessionId: value.producer?.sessionId,
    durationMs: value.producer?.usage?.durationMs,
    usage: value.producer?.usage,
    message: value.status === 'completed'
      ? 'Completion inferred from WorkResult because host did not emit an explicit completion trace.'
      : `Worker reported ${value.status}.`,
  })
}

export function recordAgentTrace(packageDir, input) {
  const paths = workflowPaths(packageDir)
  const state = ensureWorkflow(paths.root)
  if (!TRACE_EVENT_TYPES.has(input.eventType)) throw new Error(`Unsupported agent trace event: ${input.eventType}`)
  const item = state.workItems[input.itemId]
  if (!item) throw new Error(`Unknown WorkItem for trace: ${input.itemId}`)
  const existing = readJsonLines(paths.trace)
  const started = [...existing].reverse().find(trace => trace.itemId === item.itemId
    && trace.attempt === item.attempt
    && trace.eventType === 'agent-started')
  const occurredAt = input.occurredAt || new Date().toISOString()
  const durationMs = numberOrUndefined(input.durationMs)
    ?? (started && ['agent-completed', 'agent-failed'].includes(input.eventType)
      ? Math.max(0, Date.parse(occurredAt) - Date.parse(started.occurredAt))
      : undefined)
  const trace = compactObject({
    schemaVersion: 'repo-agent-trace/v1',
    traceId: `trace:${randomUUID()}`,
    runId: state.runId,
    itemId: item.itemId,
    attempt: item.attempt,
    eventType: input.eventType,
    occurredAt,
    role: input.role || item.role,
    runtime: input.runtime,
    model: input.model,
    effort: input.effort,
    sessionId: input.sessionId,
    durationMs,
    usage: normalizeUsage(input.usage, input.eventType),
    message: input.message,
  })
  appendJsonLine(paths.trace, trace)
  return trace
}

export function buildAgentDebugSummary(packageDir) {
  const state = syncProducedResults(packageDir)
  const traces = readAgentTraces(packageDir)
  const completed = traces.filter(trace => ['agent-completed', 'agent-failed'].includes(trace.eventType))
  const usageRecords = completed.filter(trace => trace.usage?.status === 'reported')
  const aggregateUsage = {
    inputTokens: sum(usageRecords, 'inputTokens'),
    outputTokens: sum(usageRecords, 'outputTokens'),
    cachedInputTokens: sum(usageRecords, 'cachedInputTokens'),
    reasoningTokens: sum(usageRecords, 'reasoningTokens'),
    totalTokens: sum(usageRecords, 'totalTokens'),
    costUsd: sum(usageRecords, 'costUsd'),
  }
  const byItem = Object.values(state.workItems).map(item => {
    const itemTraces = traces.filter(trace => trace.itemId === item.itemId && trace.attempt === item.attempt)
    const last = itemTraces.at(-1)
    const completion = [...itemTraces].reverse().find(trace => ['agent-completed', 'agent-failed'].includes(trace.eventType))
    return {
      itemId: item.itemId,
      attempt: item.attempt,
      role: item.role,
      status: item.status,
      qualityClass: item.qualityClass,
      criticality: item.criticality,
      lastTraceEvent: last?.eventType || null,
      runtime: completion?.runtime || null,
      model: completion?.model || null,
      durationMs: completion?.durationMs ?? null,
      usage: completion?.usage || { status: 'pending' },
      resultPath: workResultPathForItem(workflowPaths(packageDir), item),
    }
  })
  return {
    schemaVersion: 'repo-agent-debug-summary/v1',
    generatedAt: new Date().toISOString(),
    runId: state.runId,
    snapshotId: state.snapshotId,
    invocations: {
      issued: traces.filter(trace => trace.eventType === 'work-issued').length,
      started: traces.filter(trace => trace.eventType === 'agent-started').length,
      completed: traces.filter(trace => trace.eventType === 'agent-completed').length,
      failed: traces.filter(trace => trace.eventType === 'agent-failed').length,
      usageReported: usageRecords.length,
      usageUnavailable: completed.filter(trace => trace.usage?.status === 'unavailable').length,
    },
    aggregateUsage,
    workStateCounts: state.counts,
    byItem,
    timeline: traces,
    files: workflowPaths(packageDir),
  }
}

export function readAgentTraces(packageDir) {
  return readJsonLines(workflowPaths(packageDir).trace)
}

export function validateWorkItem(item) {
  const issues = []
  if (!isPlainObject(item)) return ['WorkItem must be an object']
  for (const field of Object.keys(item)) {
    if (!WORK_ITEM_FIELDS.has(field)) issues.push(`${field} is not allowed`)
  }
  for (const field of WORK_ITEM_REQUIRED_FIELDS) {
    if (!Object.hasOwn(item, field)) issues.push(`${field} is required`)
  }
  if (item.schemaVersion !== 'repo-work-item/v3') issues.push('schemaVersion must be repo-work-item/v3')
  for (const field of ['itemId', 'runId', 'snapshotId', 'role', 'contractRef', 'objectiveSummary', 'completionPolicyRef', 'outputArtifactPath', 'outputSchemaRef', 'idempotencyKey', 'createdAt']) {
    if (Object.hasOwn(item, field) && !nonEmptyString(item[field])) issues.push(`${field} must be a non-empty string`)
  }
  if (Object.hasOwn(item, 'retryOf') && !nonEmptyString(item.retryOf)) issues.push('retryOf must be a non-empty string')
  if (!Number.isInteger(item?.attempt) || item.attempt < 1) issues.push('attempt must be an integer >= 1')
  if (!WORK_KINDS.has(item?.kind)) issues.push(`kind is invalid: ${item?.kind || 'missing'}`)
  if (!QUALITY_CLASSES.has(item?.qualityClass)) issues.push(`qualityClass is invalid: ${item?.qualityClass || 'missing'}`)
  if (!CRITICALITIES.has(item?.criticality)) issues.push(`criticality is invalid: ${item?.criticality || 'missing'}`)
  if (typeof item?.blocking !== 'boolean') issues.push('blocking must be boolean')
  validateStringArray(item, 'dependencies', issues)
  validateStringArray(item, 'inputArtifactRefs', issues, { minItems: 1 })
  validateStringArray(item, 'communityIds', issues)
  validateStringArray(item, 'blockingJourneyIds', issues)
  if (!Array.isArray(item?.blockingMapDimensions)) {
    issues.push('blockingMapDimensions must be an array')
  } else {
    for (const value of item.blockingMapDimensions) {
      if (!BLOCKING_MAP_DIMENSIONS.has(value)) issues.push(`blockingMapDimensions contains invalid value: ${value}`)
    }
  }
  if (item?.neighborMapRef !== null && !nonEmptyString(item?.neighborMapRef)) {
    issues.push('neighborMapRef must be a non-empty string or null')
  }
  if (!isPlainObject(item?.budgetHints)) {
    issues.push('budgetHints must be an object')
  } else {
    for (const [field, value] of Object.entries(item.budgetHints)) {
      if (!BUDGET_HINT_FIELDS.has(field)) issues.push(`budgetHints.${field} is not allowed`)
      else if (!Number.isInteger(value) || value < 1) issues.push(`budgetHints.${field} must be an integer >= 1`)
    }
  }
  return issues
}

export function materializeRunState(events) {
  if (!events.length) throw new Error('Run event stream must start with run-created')
  verifyEventChain(events)
  if (events[0].eventType !== 'run-created') throw new Error('Run event stream must start with run-created')
  const first = events[0]
  const state = {
    schemaVersion: 'repo-run-state/v3',
    runId: first.runId,
    snapshotId: first.payload.snapshotId,
    createdAt: first.occurredAt,
    updatedAt: first.occurredAt,
    lastSequence: first.sequence,
    workItems: {},
    counts: {},
    supportDecision: null,
    investigationFrame: null,
    researchContracts: {},
    questions: {},
    hypotheses: {},
    journeys: {},
    projections: {},
    terminal: null,
  }
  for (const event of events) {
    state.updatedAt = event.occurredAt
    state.lastSequence = event.sequence
    if (event.eventType === 'support-decided') state.supportDecision = event.payload.decision || event.payload
    if (event.eventType === 'investigation-frame-built') state.investigationFrame = event.payload.frame || event.payload
    if (event.eventType === 'research-contracted') {
      const contract = event.payload.contract || event.payload
      const contractId = contract.contractId || event.payload.contractId
      if (contractId) state.researchContracts[contractId] = contract
    }
    if (event.eventType === 'work-planned') {
      const item = event.payload.item
      state.workItems[item.itemId] = { ...item, status: 'ready', itemPath: event.payload.itemPath }
    }
    if (event.eventType === 'work-issued') setWorkState(state, event.payload.itemId, 'issued')
    if (event.eventType === 'result-detected') setWorkState(state, event.payload.itemId, 'result-produced')
    if (event.eventType === 'result-accepted') setWorkState(state, event.payload.itemId, 'accepted', event.payload)
    if (event.eventType === 'result-rejected') setWorkState(state, event.payload.itemId, 'rejected', event.payload)
    if (event.eventType === 'work-abandoned') setWorkState(state, event.payload.itemId, 'abandoned', event.payload)
    if (event.eventType === 'work-waived') setWorkState(state, event.payload.itemId, 'waived', event.payload)
    if (event.eventType.startsWith('question-')) materializeQuestionEvent(state, event)
    if (event.eventType.startsWith('hypothesis-')) materializeHypothesisEvent(state, event)
    if (event.eventType.startsWith('journey-')) materializeJourneyEvent(state, event)
    if (event.eventType === 'projection-built') {
      const projection = event.payload.projection || event.payload.name
      if (projection) state.projections[projection] = event.payload
    }
    if (event.eventType === 'run-unsupported') state.terminal = 'unsupported'
    if (event.eventType === 'run-blocked') state.terminal = 'blocked'
    if (event.eventType === 'run-completed') state.terminal = 'completed'
  }
  state.counts = countBy(Object.values(state.workItems), item => item.status)
  return state
}

function materializeQuestionEvent(state, event) {
  const question = event.payload.question || event.payload
  const questionId = question.questionId || event.payload.questionId
  if (!questionId) return
  const statusByEvent = {
    'question-qualified': 'qualified',
    'question-planned': 'planned',
    'question-resolved': 'resolved',
    'question-blocked': 'blocked',
    'question-invalidated': 'invalidated',
  }
  state.questions[questionId] = {
    ...(state.questions[questionId] || {}),
    ...question,
    questionId,
    status: statusByEvent[event.eventType] || question.status,
    lastEventSequence: event.sequence,
  }
}

function materializeHypothesisEvent(state, event) {
  const hypothesis = event.payload.hypothesis || event.payload
  const hypothesisId = hypothesis.hypothesisId || event.payload.hypothesisId
  if (!hypothesisId) return
  state.hypotheses[hypothesisId] = {
    ...(state.hypotheses[hypothesisId] || {}),
    ...hypothesis,
    hypothesisId,
    status: event.eventType === 'hypothesis-supported' ? 'supported' : 'refuted',
    lastEventSequence: event.sequence,
  }
}

function materializeJourneyEvent(state, event) {
  const journey = event.payload.journey || event.payload
  const journeyId = journey.journeyId || event.payload.journeyId
  if (!journeyId) return
  state.journeys[journeyId] = {
    ...(state.journeys[journeyId] || {}),
    ...journey,
    journeyId,
    status: event.eventType === 'journey-closed' ? 'closed' : 'open',
    lastEventSequence: event.sequence,
  }
}

function writeMaterializedState(paths, events) {
  const state = materializeRunState(events)
  writeJsonAtomic(paths.state, state)
  return state
}

function createEvent({ runId, sequence, eventType, actor, payload, previousEventHash, occurredAt }) {
  const base = {
    schemaVersion: 'repo-run-event/v3',
    eventId: `event:${randomUUID()}`,
    runId,
    sequence,
    eventType,
    occurredAt,
    actor,
    payload,
    previousEventHash,
  }
  return { ...base, eventHash: hashText(JSON.stringify(base)) }
}

function verifyEventChain(events) {
  let previousHash = null
  let previousSequence = 0
  let runId = null
  let snapshotId = null
  const eventIds = new Set()
  for (const event of events) {
    assertValidRunEvent(event)
    if (previousSequence === 0) {
      if (event.eventType !== 'run-created') throw new Error('Run event stream must start with run-created')
      runId = event.runId
      snapshotId = event.payload.snapshotId
    } else if (event.eventType === 'run-created') {
      throw new Error(`Run event stream contains a second run-created event at sequence ${event.sequence}`)
    }
    if (event.runId !== runId) throw new Error(`Run event runId mismatch at sequence ${event.sequence}`)
    if (eventIds.has(event.eventId)) throw new Error(`Run eventId is duplicated at sequence ${event.sequence}: ${event.eventId}`)
    eventIds.add(event.eventId)
    if (event.eventType === 'work-planned' && event.payload.item.snapshotId !== snapshotId) {
      throw new Error(`Run event work-planned snapshotId mismatch at sequence ${event.sequence}`)
    }
    const { eventHash, ...base } = event
    if (event.sequence !== previousSequence + 1) throw new Error(`Run event sequence gap at ${event.sequence}`)
    if (event.previousEventHash !== previousHash) throw new Error(`Run event previousEventHash mismatch at ${event.sequence}`)
    if (hashText(JSON.stringify(base)) !== eventHash) throw new Error(`Run event hash mismatch at ${event.sequence}`)
    previousSequence = event.sequence
    previousHash = eventHash
  }
}

function assertValidRunEventInput(eventType, payload) {
  const issues = validateRunEventPayload(eventType, payload)
  if (issues.length) throw new Error(`Invalid RunEvent input:\n${issues.map(issue => `- ${issue}`).join('\n')}`)
}

function assertValidRunEvent(event) {
  const issues = validateRunEvent(event)
  if (issues.length) {
    const sequence = Number.isInteger(event?.sequence) ? event.sequence : 'unknown'
    throw new Error(`Invalid RunEvent at sequence ${sequence}:\n${issues.map(issue => `- ${issue}`).join('\n')}`)
  }
}

function validateRunEvent(event) {
  const issues = []
  if (!isPlainObject(event)) return ['RunEvent must be an object']
  for (const field of Object.keys(event)) {
    if (!RUN_EVENT_FIELDS.has(field)) issues.push(`${field} is not allowed`)
  }
  for (const field of RUN_EVENT_REQUIRED_FIELDS) {
    if (!Object.hasOwn(event, field)) issues.push(`${field} is required`)
  }
  if (event.schemaVersion !== 'repo-run-event/v3') issues.push('schemaVersion must be repo-run-event/v3')
  for (const field of ['eventId', 'runId', 'actor', 'eventHash']) {
    if (Object.hasOwn(event, field) && !nonEmptyString(event[field])) issues.push(`${field} must be a non-empty string`)
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 1) issues.push('sequence must be an integer >= 1')
  if (!RUN_EVENT_TYPES.has(event.eventType)) issues.push(`eventType is invalid: ${event.eventType || 'missing'}`)
  if (!nonEmptyString(event.occurredAt) || Number.isNaN(Date.parse(event.occurredAt))) {
    issues.push('occurredAt must be a valid date-time string')
  }
  if (event.previousEventHash !== null && !nonEmptyString(event.previousEventHash)) {
    issues.push('previousEventHash must be a non-empty string or null')
  }
  issues.push(...validateRunEventPayload(event.eventType, event.payload))
  if (event.eventType === 'work-planned' && isPlainObject(event.payload?.item) && event.payload.item.runId !== event.runId) {
    issues.push('work-planned item.runId must match RunEvent runId')
  }
  return issues
}

function validateRunEventPayload(eventType, payload) {
  const issues = []
  if (!RUN_EVENT_TYPES.has(eventType)) issues.push(`eventType is invalid: ${eventType || 'missing'}`)
  if (!isPlainObject(payload)) return [...issues, 'payload must be an object']
  const requireText = field => {
    if (!nonEmptyString(payload[field])) issues.push(`${eventType} payload.${field} must be a non-empty string`)
  }
  const requireInteger = field => {
    if (!Number.isInteger(payload[field]) || payload[field] < 0) issues.push(`${eventType} payload.${field} must be an integer >= 0`)
  }
  const requireObject = field => {
    if (!isPlainObject(payload[field])) issues.push(`${eventType} payload.${field} must be an object`)
  }
  const requireNestedId = (container, field) => {
    if (!nonEmptyString(payload[field]) && !nonEmptyString(payload[container]?.[field])) {
      issues.push(`${eventType} payload must identify ${field}`)
    }
  }

  if (eventType === 'run-created') {
    requireText('snapshotId')
    requireText('packageDir')
  } else if (eventType === 'snapshot-created') {
    requireText('snapshotId')
    requireText('inventoryPath')
  } else if (eventType === 'support-decided') {
    requireObject('decision')
  } else if (eventType === 'census-completed') {
    requireText('inventoryPath')
    requireInteger('fileCount')
  } else if (eventType === 'static-graph-built') {
    requireText('graphPath')
    requireText('graphId')
  } else if (eventType === 'investigation-frame-built') {
    requireObject('frame')
    if (isPlainObject(payload.frame) && !nonEmptyString(payload.frame.frameId)) issues.push('investigation-frame-built payload.frame.frameId must be a non-empty string')
  } else if (eventType === 'research-contracted') {
    requireObject('contract')
    if (isPlainObject(payload.contract) && !nonEmptyString(payload.contract.contractId)) issues.push('research-contracted payload.contract.contractId must be a non-empty string')
  } else if (eventType === 'work-planned') {
    requireObject('item')
    requireText('itemPath')
    if (isPlainObject(payload.item)) {
      for (const issue of validateWorkItem(payload.item)) issues.push(`work-planned payload.item: ${issue}`)
    }
  } else if (['work-issued', 'result-accepted', 'result-rejected', 'work-abandoned', 'work-waived'].includes(eventType)) {
    requireText('itemId')
  } else if (eventType === 'result-detected') {
    requireText('itemId')
    requireText('resultPath')
  } else if (['task-outcome-accepted', 'task-outcome-rejected'].includes(eventType)) {
    requireText('contractId')
  } else if (['question-qualified', 'question-planned', 'question-resolved', 'question-blocked', 'question-invalidated'].includes(eventType)) {
    requireNestedId('question', 'questionId')
  } else if (['hypothesis-supported', 'hypothesis-refuted'].includes(eventType)) {
    requireNestedId('hypothesis', 'hypothesisId')
  } else if (['claim-accepted', 'claim-refuted'].includes(eventType)) {
    requireText('claimId')
  } else if (['journey-closed', 'journey-reopened'].includes(eventType)) {
    requireNestedId('journey', 'journeyId')
  } else if (['verification-passed', 'verification-failed'].includes(eventType)) {
    requireText('phase')
    requireInteger('issueCount')
  } else if (eventType === 'synthesis-accepted') {
    requireText('itemId')
    requireText('narrativePath')
  } else if (eventType === 'projection-built') {
    requireText('projection')
  } else if (eventType === 'run-unsupported' || eventType === 'run-blocked') {
    requireText('reason')
  } else if (eventType === 'run-completed') {
    for (const field of ['narrativePath', 'humanReadablePath', 'mapManifestPath', 'verificationPath']) requireText(field)
    requireObject('projectionKey')
  }
  return issues
}

function setWorkState(state, itemId, status, details = {}) {
  if (!WORK_ITEM_STATES.has(status)) throw new Error(`Invalid WorkItem state: ${status}`)
  const item = state.workItems[itemId]
  if (!item) throw new Error(`Run event references unknown WorkItem: ${itemId}`)
  item.status = status
  item.lastTransition = details
}

function snapshotIdForPackage(packageDir) {
  const inventoryPath = path.join(packageDir, 'static', 'inventory.json')
  const inventory = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) : {}
  if (!inventory.repo?.path) inventory.repo = { ...(inventory.repo || {}), path: packageDir }
  return snapshotIdForInventory(inventory)
}

function workResultPathForItem(paths, item) {
  return path.join(paths.workResults, `${safeId(item.itemId)}.result.json`)
}

function contractIdForItem(packageDir, item) {
  return readContractForItem(packageDir, item)?.contractId || null
}

function readContractForItem(packageDir, item) {
  const contractPath = path.isAbsolute(item.contractRef) ? item.contractRef : path.resolve(packageDir, item.contractRef)
  if (!isInside(packageDir, contractPath) || !fs.existsSync(contractPath)) return null
  try {
    return JSON.parse(fs.readFileSync(contractPath, 'utf8'))
  } catch {
    return null
  }
}

function validateReadSet(packageDir, item, readSet, issues) {
  const contract = readContractForItem(packageDir, item)
  const allowedFiles = new Set([
    ...(contract?.scope?.allowedFiles || []),
    ...(contract?.deterministicContextRefs || []),
    ...(item.inputArtifactRefs || []),
    item.contractRef,
  ].map(normalizePortablePath).filter(Boolean))
  const inventoryPath = path.join(packageDir, 'static', 'inventory.json')
  const inventory = fs.existsSync(inventoryPath) ? JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) : null
  const repoRoot = inventory?.repo?.path ? path.resolve(inventory.repo.path) : null
  const graphPath = path.join(packageDir, 'static', 'static-program-graph.json')
  const graph = fs.existsSync(graphPath) ? JSON.parse(fs.readFileSync(graphPath, 'utf8')) : null
  const sourceStructures = new Map((graph?.files || []).map(file => [normalizePortablePath(file.sourcePath), file.structureFingerprint]))
  for (const entry of readSet) {
    if (!entry?.path) {
      issues.push('readSet entry path is required')
      continue
    }
    if (entry.fingerprintAlgorithm !== 'sha256') issues.push(`readSet ${entry.path} fingerprintAlgorithm must be sha256`)
    if (!/^[a-f0-9]{64}$/i.test(String(entry.contentFingerprint || ''))) {
      issues.push(`readSet ${entry.path} contentFingerprint is invalid`)
      continue
    }
    if (entry.structureFingerprint !== null && !/^structure:sha256:[a-f0-9]{64}$/i.test(String(entry.structureFingerprint || ''))) {
      issues.push(`readSet ${entry.path} structureFingerprint must use structure:sha256:<64 hex>`)
    }
    const absolute = path.isAbsolute(entry.path)
      ? path.resolve(entry.path)
      : repoRoot && fs.existsSync(path.resolve(repoRoot, entry.path))
        ? path.resolve(repoRoot, entry.path)
        : path.resolve(packageDir, entry.path)
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      issues.push(`readSet path does not exist: ${entry.path}`)
      continue
    }
    if (hashFile(absolute) !== entry.contentFingerprint) issues.push(`readSet fingerprint is stale: ${entry.path}`)
    const relative = repoRoot && isInside(repoRoot, absolute)
      ? path.relative(repoRoot, absolute).split(path.sep).join('/')
      : isInside(packageDir, absolute)
        ? path.relative(packageDir, absolute).split(path.sep).join('/')
        : null
    if (!relative || !allowedFiles.has(normalizePortablePath(relative))) {
      issues.push(`readSet path is outside WorkItem/ResearchContract scope: ${entry.path}`)
    }
    const normalizedRelative = normalizePortablePath(relative)
    const expectedSourceStructure = sourceStructures.get(normalizedRelative)
    const expectedArtifactStructure = normalizedRelative === 'static/static-program-graph.json'
      ? graph?.structureFingerprint
      : null
    const expectedStructure = expectedSourceStructure || expectedArtifactStructure
    if (expectedStructure && entry.structureFingerprint !== expectedStructure) {
      issues.push(`readSet structureFingerprint is stale or missing: ${entry.path}`)
    }
  }
}

function validateArtifactHashes(packageDir, value, issues) {
  const outputPath = path.resolve(value.output.path)
  const outputHash = (value.artifactHashes || []).find(item => {
    const artifactPath = path.isAbsolute(item.artifactRef) ? item.artifactRef : path.resolve(packageDir, item.artifactRef)
    return path.resolve(artifactPath) === outputPath
  })
  if (!outputHash) {
    issues.push('artifactHashes must include the completed output artifact')
    return
  }
  if (outputHash.algorithm !== 'sha256') issues.push('artifact hash algorithm must be sha256')
  if (!/^[a-f0-9]{64}$/i.test(String(outputHash.value || ''))) {
    issues.push(`artifact hash is invalid for ${outputHash.artifactRef}`)
    return
  }
  if (fs.existsSync(outputPath) && hashFile(outputPath) !== outputHash.value) {
    issues.push(`artifact hash mismatch for ${outputHash.artifactRef}`)
  }
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function normalizeUsage(value, eventType) {
  const source = value && typeof value === 'object' ? value : {}
  const numeric = {}
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'totalTokens', 'costUsd']) {
    const normalized = numberOrUndefined(source[key])
    if (normalized !== undefined && normalized >= 0) numeric[key] = normalized
  }
  if (numeric.totalTokens === undefined && numeric.inputTokens !== undefined && numeric.outputTokens !== undefined) {
    numeric.totalTokens = numeric.inputTokens + numeric.outputTokens
  }
  const terminal = ['agent-completed', 'agent-failed'].includes(eventType)
  const status = source.status || (Object.keys(numeric).length ? 'reported' : terminal ? 'unavailable' : 'pending')
  return { status, ...numeric }
}

function sum(records, field) {
  return records.reduce((total, record) => total + (Number(record.usage?.[field]) || 0), 0)
}

function countBy(values, keyFn) {
  const counts = {}
  for (const value of values) {
    const key = keyFn(value)
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function validateStringArray(value, field, issues, options = {}) {
  if (!Array.isArray(value?.[field])) {
    issues.push(`${field} must be an array`)
    return
  }
  if ((options.minItems || 0) > value[field].length) issues.push(`${field} must contain at least ${options.minItems} item(s)`)
  for (const item of value[field]) {
    if (!nonEmptyString(item)) issues.push(`${field} must contain only non-empty strings`)
  }
}

function readBundledSchema(relativePath) {
  return JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function ensureDirectories(paths) {
  for (const dir of [paths.workItems, paths.workResults, path.dirname(paths.events), path.dirname(paths.state), path.dirname(paths.trace)]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`Invalid JSONL at ${file}:${index + 1}: ${error.message}`)
    }
  })
}

function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

function isInside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizePortablePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const portable = value.replaceAll('\\', '/').replace(/^\.\//, '')
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)) return null
  const normalized = path.posix.normalize(portable)
  return normalized === '..' || normalized.startsWith('../') ? null : normalized
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function hashText(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
