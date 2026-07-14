export const REPO_JOURNEY_CLOSURE_REPORT_SCHEMA = 'repo-journey-closure-report/v1'

export const JOURNEY_CLOSURE_DIMENSIONS = Object.freeze([
  'entry',
  'action',
  'handler',
  'state',
  'request',
  'response',
  'feedback',
  'outcome',
  'branch-failure',
])

const FAILURE_BRANCH_KINDS = new Set(['failure', 'retry', 'exit'])

/**
 * Evaluate one authoritative JourneyDefinition/JourneyBinding pair.
 * Closure is derived from grounded bindings and never inferred from labels.
 */
export function evaluateJourneyClosure(input = {}, maybeBindingSet, maybeOptions = {}) {
  const { definition, bindingSet, staticProgramGraph, evaluatedAt } = normalizeInput(input, maybeBindingSet, maybeOptions)
  const integrityIssues = validateJourneyIntegrity({
    definition,
    bindingSet,
    staticProgramGraph,
    requireGraphEntities: Boolean(staticProgramGraph),
  })
  const bindings = array(bindingSet?.bindings)
  const critical = definition?.criticality === 'critical'
  const definitionStatus = validJourneyStatus(definition?.status) ? definition.status : 'open'
  const context = {
    definition,
    bindingSet,
    bindings,
    critical,
    globallyBlocked: definitionStatus === 'blocked' || bindingSet?.status === 'blocked',
  }

  const dimensions = JOURNEY_CLOSURE_DIMENSIONS.map(dimension => evaluateDimension(dimension, context))
  const required = dimensions.filter(item => item.required)
  const closedRequired = required.filter(item => item.status === 'closed')
  const canClose = integrityIssues.length === 0 && required.length > 0 && closedRequired.length === required.length
  const criticalGatePassed = !critical || canClose
  const status = computedStatus({ definitionStatus, canClose, integrityIssues })
  const blockingSteps = array(definition?.steps).filter(step => step?.blocking)
  const closedBlockingSteps = blockingSteps.filter(step => blockingStepClosed(step, dimensions, bindings)).length

  if (definitionStatus === 'closed' && !canClose) {
    integrityIssues.push(issue(
      critical ? 'CRITICAL_JOURNEY_CLOSED_WITH_GAPS' : 'JOURNEY_CLOSED_WITH_GAPS',
      '$.definition.status',
      critical
        ? 'A critical journey cannot be closed while any required closure dimension remains open.'
        : 'A journey cannot be closed while a required closure dimension remains open.',
    ))
  }

  return {
    schemaVersion: REPO_JOURNEY_CLOSURE_REPORT_SCHEMA,
    journeyId: String(definition?.journeyId || bindingSet?.journeyId || 'invalid-journey'),
    snapshotId: String(definition?.snapshotId || bindingSet?.snapshotId || 'invalid-snapshot'),
    criticality: normalizeCriticality(definition?.criticality),
    declaredStatus: definitionStatus,
    status: definitionStatus === 'closed' && !canClose ? 'open' : status,
    canClose,
    criticalGatePassed,
    dimensions,
    integrityIssues: sortIssues(integrityIssues),
    metrics: {
      requiredDimensions: required.length,
      closedRequiredDimensions: closedRequired.length,
      closureRate: required.length ? round(closedRequired.length / required.length) : 0,
      blockingSteps: blockingSteps.length,
      closedBlockingSteps,
    },
    evaluatedAt: String(
      evaluatedAt
      || definition?.updatedAt
      || bindingSet?.generatedAt
      || '1970-01-01T00:00:00.000Z',
    ),
  }
}

export function evaluateJourneySetClosure(input = {}) {
  const definitions = array(input.definitions).slice().sort((left, right) => String(left?.journeyId).localeCompare(String(right?.journeyId)))
  const bindingByJourney = new Map(array(input.bindingSets || input.bindings).map(item => [item?.journeyId, item]))
  const reports = definitions.map(definition => evaluateJourneyClosure({
    definition,
    bindingSet: bindingByJourney.get(definition?.journeyId),
    staticProgramGraph: input.staticProgramGraph,
    evaluatedAt: input.evaluatedAt,
  }))
  const dimensionMetrics = Object.fromEntries(JOURNEY_CLOSURE_DIMENSIONS.map(dimension => {
    const values = reports.map(report => report.dimensions.find(item => item.dimension === dimension)).filter(Boolean)
    const required = values.filter(item => item.required)
    const closed = required.filter(item => item.status === 'closed')
    return [dimension, {
      required: required.length,
      closed: closed.length,
      closureRate: required.length ? round(closed.length / required.length) : 1,
    }]
  }))
  const critical = reports.filter(report => report.criticality === 'critical')
  const closed = reports.filter(report => report.status === 'closed')
  const criticalGatePassed = critical.every(report => report.status === 'closed')
  const minimumJourneyClosureRate = clampRate(input.minimumJourneyClosureRate ?? 1)
  const journeyClosureRate = reports.length ? round(closed.length / reports.length) : 0
  return {
    schemaVersion: 'repo-journey-closure-set/v1',
    snapshotId: String(input.snapshotId || definitions[0]?.snapshotId || 'invalid-snapshot'),
    reports,
    criticalOpenJourneyIds: critical.filter(report => report.status !== 'closed').map(report => report.journeyId),
    criticalGatePassed,
    minimumJourneyClosureRate,
    journeyClosureRate,
    canComplete: reports.length > 0 && criticalGatePassed && journeyClosureRate >= minimumJourneyClosureRate,
    counts: {
      journeys: reports.length,
      closed: closed.length,
      open: reports.filter(report => report.status === 'open').length,
      blocked: reports.filter(report => report.status === 'blocked').length,
      candidate: reports.filter(report => report.status === 'candidate').length,
      invalidated: reports.filter(report => report.status === 'invalidated').length,
      critical: critical.length,
      criticalClosed: critical.filter(report => report.status === 'closed').length,
    },
    dimensions: dimensionMetrics,
    evaluatedAt: String(input.evaluatedAt || reports[0]?.evaluatedAt || '1970-01-01T00:00:00.000Z'),
  }
}

/**
 * Validate stable step order, branch ownership and binding/relation references.
 * Missing semantic closure is reported by evaluateJourneyClosure, not here.
 */
export function validateJourneyIntegrity(input = {}) {
  const definition = input.definition
  const bindingSet = input.bindingSet
  const issues = []
  if (!definition || typeof definition !== 'object') return [issue('DEFINITION_MISSING', '$.definition', 'JourneyDefinition is required.')]
  if (!bindingSet || typeof bindingSet !== 'object') return [issue('BINDING_SET_MISSING', '$.bindingSet', 'JourneyBinding is required.')]

  if (definition.journeyId !== bindingSet.journeyId) {
    issues.push(issue('JOURNEY_ID_MISMATCH', '$.bindingSet.journeyId', 'JourneyBinding journeyId must match JourneyDefinition.'))
  }
  if (definition.snapshotId !== bindingSet.snapshotId) {
    issues.push(issue('SNAPSHOT_ID_MISMATCH', '$.bindingSet.snapshotId', 'JourneyBinding snapshotId must match JourneyDefinition.'))
  }

  const steps = array(definition.steps)
  const stepById = new Map()
  const orderSet = new Set()
  steps.forEach((step, index) => {
    const stepPath = `$.definition.steps[${index}]`
    if (!step?.stepId) issues.push(issue('STEP_ID_MISSING', `${stepPath}.stepId`, 'Journey steps require a stable stepId.'))
    else if (stepById.has(step.stepId)) issues.push(issue('STEP_ID_DUPLICATE', `${stepPath}.stepId`, `Duplicate stepId: ${step.stepId}`))
    else stepById.set(step.stepId, step)
    if (!Number.isInteger(step?.order) || step.order !== index + 1) {
      issues.push(issue('STEP_ORDER_NOT_CONTIGUOUS', `${stepPath}.order`, 'Step order must be contiguous, one-based, and match array order.'))
    }
    if (orderSet.has(step?.order)) issues.push(issue('STEP_ORDER_DUPLICATE', `${stepPath}.order`, `Duplicate step order: ${step?.order}`))
    orderSet.add(step?.order)
    if (unique(array(step?.branchIds)).length !== array(step?.branchIds).length) {
      issues.push(issue('STEP_BRANCH_DUPLICATE', `${stepPath}.branchIds`, 'A step cannot reference the same branch more than once.'))
    }
  })

  const branches = array(definition.branches)
  const branchById = new Map()
  branches.forEach((branch, index) => {
    const branchPath = `$.definition.branches[${index}]`
    if (!branch?.branchId) issues.push(issue('BRANCH_ID_MISSING', `${branchPath}.branchId`, 'Branches require a stable branchId.'))
    else if (branchById.has(branch.branchId)) issues.push(issue('BRANCH_ID_DUPLICATE', `${branchPath}.branchId`, `Duplicate branchId: ${branch.branchId}`))
    else branchById.set(branch.branchId, branch)
    if (!stepById.has(branch?.fromStepId)) issues.push(issue('BRANCH_FROM_STEP_UNKNOWN', `${branchPath}.fromStepId`, `Unknown branch source step: ${branch?.fromStepId}`))
    if (branch?.nextStepId !== null && !stepById.has(branch?.nextStepId)) {
      issues.push(issue('BRANCH_NEXT_STEP_UNKNOWN', `${branchPath}.nextStepId`, `Unknown branch target step: ${branch?.nextStepId}`))
    }
    const owner = stepById.get(branch?.fromStepId)
    if (owner && !array(owner.branchIds).includes(branch?.branchId)) {
      issues.push(issue('BRANCH_NOT_OWNED_BY_SOURCE_STEP', `${branchPath}.branchId`, 'The source step must list the branchId.'))
    }
    if (branch?.nextStepId && branch?.kind !== 'retry') {
      const fromOrder = stepById.get(branch.fromStepId)?.order
      const nextOrder = stepById.get(branch.nextStepId)?.order
      if (Number.isInteger(fromOrder) && Number.isInteger(nextOrder) && nextOrder <= fromOrder) {
        issues.push(issue('BRANCH_TARGET_NOT_FORWARD', `${branchPath}.nextStepId`, 'Only retry branches may point to the same or an earlier step.'))
      }
    }
  })
  for (const [stepId, step] of stepById) {
    for (const branchId of array(step.branchIds)) {
      const branch = branchById.get(branchId)
      if (!branch) issues.push(issue('STEP_BRANCH_UNKNOWN', `$.definition.steps.${stepId}.branchIds`, `Unknown branchId: ${branchId}`))
      else if (branch.fromStepId !== stepId) issues.push(issue('STEP_BRANCH_WRONG_OWNER', `$.definition.steps.${stepId}.branchIds`, `Branch ${branchId} belongs to ${branch.fromStepId}.`))
    }
  }

  array(definition.visibleFeedback).forEach((feedback, index) => {
    if (!stepById.has(feedback?.stepId)) issues.push(issue('FEEDBACK_STEP_UNKNOWN', `$.definition.visibleFeedback[${index}].stepId`, `Unknown feedback step: ${feedback?.stepId}`))
  })
  if (!stepById.has(definition.successOutcome?.stepId)) {
    issues.push(issue('SUCCESS_OUTCOME_STEP_UNKNOWN', '$.definition.successOutcome.stepId', `Unknown success outcome step: ${definition.successOutcome?.stepId}`))
  }
  array(definition.failureOutcomes).forEach((outcome, index) => {
    if (!stepById.has(outcome?.stepId)) issues.push(issue('FAILURE_OUTCOME_STEP_UNKNOWN', `$.definition.failureOutcomes[${index}].stepId`, `Unknown failure outcome step: ${outcome?.stepId}`))
    if (outcome?.branchId !== null && !branchById.has(outcome?.branchId)) {
      issues.push(issue('FAILURE_OUTCOME_BRANCH_UNKNOWN', `$.definition.failureOutcomes[${index}].branchId`, `Unknown failure outcome branch: ${outcome?.branchId}`))
    }
  })

  const bindingById = new Map()
  array(bindingSet.bindings).forEach((binding, index) => {
    const bindingPath = `$.bindingSet.bindings[${index}]`
    if (!binding?.bindingId) issues.push(issue('BINDING_ID_MISSING', `${bindingPath}.bindingId`, 'Bindings require a stable bindingId.'))
    else if (bindingById.has(binding.bindingId)) issues.push(issue('BINDING_ID_DUPLICATE', `${bindingPath}.bindingId`, `Duplicate bindingId: ${binding.bindingId}`))
    else bindingById.set(binding.bindingId, binding)
    const step = stepById.get(binding?.stepId)
    if (!step) issues.push(issue('BINDING_STEP_UNKNOWN', `${bindingPath}.stepId`, `Unknown binding step: ${binding?.stepId}`))
    else if (binding.order !== step.order) issues.push(issue('BINDING_ORDER_MISMATCH', `${bindingPath}.order`, `Binding order must equal step order ${step.order}.`))
    if (binding?.branchId !== null && !branchById.has(binding?.branchId)) {
      issues.push(issue('BINDING_BRANCH_UNKNOWN', `${bindingPath}.branchId`, `Unknown binding branch: ${binding?.branchId}`))
    }
  })

  const relationKeys = new Set()
  array(bindingSet.relations).forEach((relation, index) => {
    const relationPath = `$.bindingSet.relations[${index}]`
    const from = bindingById.get(relation?.fromBindingId)
    const to = bindingById.get(relation?.toBindingId)
    if (!from) issues.push(issue('RELATION_FROM_BINDING_UNKNOWN', `${relationPath}.fromBindingId`, `Unknown relation source binding: ${relation?.fromBindingId}`))
    if (!to) issues.push(issue('RELATION_TO_BINDING_UNKNOWN', `${relationPath}.toBindingId`, `Unknown relation target binding: ${relation?.toBindingId}`))
    const key = `${relation?.fromBindingId}|${relation?.toBindingId}|${relation?.kind}|${relation?.branchId || ''}`
    if (relationKeys.has(key)) issues.push(issue('RELATION_DUPLICATE', relationPath, `Duplicate binding relation: ${key}`))
    relationKeys.add(key)
    if (relation?.branchId !== null && !branchById.has(relation?.branchId)) {
      issues.push(issue('RELATION_BRANCH_UNKNOWN', `${relationPath}.branchId`, `Unknown relation branch: ${relation?.branchId}`))
    }
    if (from && to && relation?.kind === 'next' && to.order < from.order) {
      const branch = relation?.branchId ? branchById.get(relation.branchId) : null
      if (branch?.kind !== 'retry') issues.push(issue('RELATION_NEXT_REVERSES_ORDER', relationPath, 'A next relation cannot reverse step order unless it is a retry branch.'))
    }
  })

  if (input.staticProgramGraph && input.requireGraphEntities) {
    const nodeIds = new Set(array(input.staticProgramGraph.nodes).map(node => node?.nodeId))
    array(bindingSet.bindings).forEach((binding, index) => {
      if (binding?.status === 'confirmed' && array(binding?.claimIds).length === 0 && !nodeIds.has(binding?.entityId)) {
        issues.push(issue('BINDING_ENTITY_NOT_IN_STATIC_GRAPH', `$.bindingSet.bindings[${index}].entityId`, `Confirmed static binding entity is absent from StaticProgramGraph: ${binding?.entityId}`))
      }
    })
  }
  return sortIssues(issues)
}

function evaluateDimension(dimension, context) {
  const handlers = {
    entry: evaluateEntry,
    action: evaluateAction,
    handler: evaluateHandler,
    state: evaluateState,
    request: evaluateRequest,
    response: evaluateResponse,
    feedback: evaluateFeedback,
    outcome: evaluateOutcome,
    'branch-failure': evaluateBranchFailure,
  }
  return handlers[dimension](context)
}

function evaluateEntry(context) {
  const entry = context.definition?.entry || {}
  const entryBindings = groundedBindings(context.bindings, ['page'])
  const definitionGrounded = Boolean(entry.routeId || entry.pageId || entry.sourcePath) && grounded(entry)
  return dimensionResult('entry', true, definitionGrounded || entryBindings.length > 0, {
    bindings: entryBindings,
    stepIds: entryBindings.map(item => item.stepId),
    evidenceIds: [...array(entry.evidenceIds), ...entryBindings.flatMap(item => array(item.evidenceIds))],
    claimIds: [...array(entry.claimIds), ...entryBindings.flatMap(item => array(item.claimIds))],
    reasonCodes: definitionGrounded || entryBindings.length ? [] : ['ENTRY_NOT_GROUNDED'],
    context,
  })
}

function evaluateAction(context) {
  const candidates = bindingsOfType(context.bindings, ['ui-element', 'event'])
  const confirmed = candidates.filter(groundedConfirmedBinding)
  const required = context.critical || context.definition?.trigger?.kind === 'user-action' || candidates.length > 0
  return dimensionResult('action', required, confirmed.length > 0, {
    bindings: confirmed,
    reasonCodes: confirmed.length ? [] : ['ACTION_BINDING_MISSING'],
    context,
  })
}

function evaluateHandler(context) {
  const candidates = bindingsOfType(context.bindings, ['handler'])
  const confirmed = candidates.filter(groundedConfirmedBinding)
  const actionRequired = context.critical || context.definition?.trigger?.kind === 'user-action' || bindingsOfType(context.bindings, ['ui-element', 'event']).length > 0
  const required = actionRequired || candidates.length > 0
  return dimensionResult('handler', required, confirmed.length > 0, {
    bindings: confirmed,
    reasonCodes: confirmed.length ? [] : ['HANDLER_BINDING_MISSING'],
    context,
  })
}

function evaluateState(context) {
  const candidates = bindingsOfType(context.bindings, ['effect', 'state-transition'])
  const confirmed = groundedBindings(context.bindings, ['state-transition'])
  const required = context.critical || candidates.length > 0
  return dimensionResult('state', required, confirmed.length > 0, {
    bindings: confirmed,
    reasonCodes: confirmed.length ? [] : ['STATE_TRANSITION_BINDING_MISSING'],
    context,
  })
}

function evaluateRequest(context) {
  const candidates = bindingsOfType(context.bindings, ['request', 'endpoint'])
  const requests = groundedBindings(context.bindings, ['request'])
  const endpoints = groundedBindings(context.bindings, ['endpoint'])
  const required = context.critical || candidates.length > 0
  return dimensionResult('request', required, requests.length > 0 && endpoints.length > 0, {
    bindings: [...requests, ...endpoints],
    reasonCodes: [
      ...(requests.length ? [] : ['REQUEST_BINDING_MISSING']),
      ...(endpoints.length ? [] : ['ENDPOINT_BINDING_MISSING']),
    ],
    context,
  })
}

function evaluateResponse(context) {
  const candidates = bindingsOfType(context.bindings, ['response'])
  const confirmed = candidates.filter(groundedConfirmedBinding)
  const required = context.critical || candidates.length > 0 || bindingsOfType(context.bindings, ['request', 'endpoint']).length > 0
  return dimensionResult('response', required, confirmed.length > 0, {
    bindings: confirmed,
    reasonCodes: confirmed.length ? [] : ['RESPONSE_BINDING_MISSING'],
    context,
  })
}

function evaluateFeedback(context) {
  const candidates = bindingsOfType(context.bindings, ['feedback'])
  const confirmed = candidates.filter(groundedConfirmedBinding)
  const groundedDefinitions = array(context.definition?.visibleFeedback).filter(grounded)
  const required = context.critical || candidates.length > 0 || array(context.definition?.visibleFeedback).length > 0
  const closed = confirmed.length > 0 && groundedDefinitions.length > 0
  return dimensionResult('feedback', required, closed, {
    bindings: confirmed,
    stepIds: groundedDefinitions.map(item => item.stepId),
    evidenceIds: groundedDefinitions.flatMap(item => array(item.evidenceIds)),
    claimIds: groundedDefinitions.flatMap(item => array(item.claimIds)),
    reasonCodes: [
      ...(confirmed.length ? [] : ['FEEDBACK_BINDING_MISSING']),
      ...(groundedDefinitions.length ? [] : ['FEEDBACK_SEMANTICS_MISSING']),
    ],
    context,
  })
}

function evaluateOutcome(context) {
  const confirmed = groundedBindings(context.bindings, ['outcome'])
  const outcome = context.definition?.successOutcome
  const definitionGrounded = grounded(outcome) && !/^unresolved product outcome\b/i.test(String(outcome?.description || ''))
  return dimensionResult('outcome', true, confirmed.length > 0 && definitionGrounded, {
    bindings: confirmed,
    stepIds: outcome?.stepId ? [outcome.stepId] : [],
    evidenceIds: array(outcome?.evidenceIds),
    claimIds: array(outcome?.claimIds),
    reasonCodes: [
      ...(confirmed.length ? [] : ['OUTCOME_BINDING_MISSING']),
      ...(definitionGrounded ? [] : ['PRODUCT_OUTCOME_UNRESOLVED']),
    ],
    context,
  })
}

function evaluateBranchFailure(context) {
  const branches = array(context.definition?.branches).filter(branch => FAILURE_BRANCH_KINDS.has(branch?.kind))
  const failureOutcomes = array(context.definition?.failureOutcomes)
  const relations = array(context.bindingSet?.relations)
  const required = context.critical || branches.length > 0 || failureOutcomes.length > 0
  const closedBranches = branches.filter(branch => {
    const outcome = failureOutcomes.find(item => item?.branchId === branch.branchId)
    const relation = relations.find(item => item?.branchId === branch.branchId)
    return grounded(branch) && grounded(outcome) && grounded(relation)
  })
  const closed = branches.length > 0 && closedBranches.length === branches.length
  return dimensionResult('branch-failure', required, closed, {
    bindings: [],
    stepIds: unique([
      ...branches.flatMap(branch => [branch.fromStepId, branch.nextStepId].filter(Boolean)),
      ...failureOutcomes.map(item => item?.stepId).filter(Boolean),
    ]),
    evidenceIds: [...branches, ...failureOutcomes, ...relations.filter(item => item?.branchId)].flatMap(item => array(item?.evidenceIds)),
    claimIds: [...branches, ...failureOutcomes, ...relations.filter(item => item?.branchId)].flatMap(item => array(item?.claimIds)),
    reasonCodes: [
      ...(branches.length ? [] : ['FAILURE_BRANCH_MISSING']),
      ...(closed ? [] : ['FAILURE_BRANCH_NOT_GROUNDED']),
    ],
    context,
  })
}

function dimensionResult(dimension, required, closed, details) {
  const bindings = uniqueObjects(details.bindings || [], item => item.bindingId)
  const hasConflict = bindingsOfType(details.context.bindings, bindingTypesForDimension(dimension))
    .some(item => item?.status === 'conflicted')
  let status = !required ? 'not-applicable' : closed ? 'closed' : hasConflict || details.context.globallyBlocked ? 'blocked' : 'open'
  if (!required) status = 'not-applicable'
  return {
    dimension,
    required: Boolean(required),
    status,
    bindingIds: unique(bindings.map(item => item.bindingId)),
    stepIds: unique([...(details.stepIds || []), ...bindings.map(item => item.stepId).filter(Boolean)]),
    evidenceIds: unique([...(details.evidenceIds || []), ...bindings.flatMap(item => array(item.evidenceIds))]),
    claimIds: unique([...(details.claimIds || []), ...bindings.flatMap(item => array(item.claimIds))]),
    reasonCodes: status === 'closed' || status === 'not-applicable' ? [] : unique(details.reasonCodes || ['DIMENSION_OPEN']),
  }
}

function bindingTypesForDimension(dimension) {
  return {
    entry: ['page'],
    action: ['ui-element', 'event'],
    handler: ['handler'],
    state: ['effect', 'state-transition'],
    request: ['request', 'endpoint'],
    response: ['response'],
    feedback: ['feedback'],
    outcome: ['outcome'],
    'branch-failure': [],
  }[dimension] || []
}

function blockingStepClosed(step, dimensions, bindings) {
  const groundedStep = grounded(step) || bindings.some(binding => binding?.stepId === step.stepId && groundedConfirmedBinding(binding))
  if (!groundedStep) return false
  return dimensions
    .filter(dimension => dimension.required && dimension.stepIds.includes(step.stepId))
    .every(dimension => dimension.status === 'closed')
}

function computedStatus({ definitionStatus, canClose, integrityIssues }) {
  if (definitionStatus === 'invalidated') return 'invalidated'
  if (definitionStatus === 'blocked') return 'blocked'
  if (integrityIssues.length) return definitionStatus === 'candidate' ? 'candidate' : 'open'
  if (canClose) return 'closed'
  return definitionStatus === 'candidate' ? 'candidate' : 'open'
}

function normalizeInput(input, bindingSet, options) {
  if (input?.definition || input?.bindingSet) return input
  return { definition: input, bindingSet, ...options }
}

function grounded(value) {
  return Boolean(value) && (array(value.evidenceIds).length > 0 || array(value.claimIds).length > 0)
}

function groundedConfirmedBinding(binding) {
  return binding?.status === 'confirmed' && grounded(binding)
}

function bindingsOfType(bindings, types) {
  const accepted = new Set(types)
  return array(bindings).filter(binding => accepted.has(binding?.bindingType))
}

function groundedBindings(bindings, types) {
  return bindingsOfType(bindings, types).filter(groundedConfirmedBinding)
}

function validJourneyStatus(value) {
  return ['candidate', 'open', 'closed', 'blocked', 'invalidated'].includes(value)
}

function normalizeCriticality(value) {
  return ['low', 'medium', 'high', 'critical'].includes(value) ? value : 'medium'
}

function issue(code, path, message) {
  return { code, path, message }
}

function sortIssues(issues) {
  return uniqueObjects(issues, item => `${item.code}|${item.path}|${item.message}`)
    .sort((left, right) => `${left.path}|${left.code}`.localeCompare(`${right.path}|${right.code}`))
}

function unique(values) {
  return [...new Set(array(values).filter(value => value !== null && value !== undefined && value !== '').map(String))].sort()
}

function uniqueObjects(values, key) {
  const seen = new Set()
  return array(values).filter(value => {
    const token = key(value)
    if (!token || seen.has(token)) return false
    seen.add(token)
    return true
  })
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function round(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000
}

function clampRate(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 1
}
