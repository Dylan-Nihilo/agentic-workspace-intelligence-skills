import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadJourneyStore } from '../knowledge/journey-store.mjs'

const MAP_KEYS = ['application', 'experience', 'runtimeFlow', 'change']
const REQUIRED_TEXT = ['title', 'executiveSummary', 'applicationSummary', 'experienceSummary', 'runtimeFlowSummary', 'changeSummary']
const SYNTHESIS_SCHEMA = readJson(fileURLToPath(new URL('../../schemas/synthesis-output.schema.json', import.meta.url)))

export function validateSynthesisNarrative({ packageDir, narrative, contract, mapManifest } = {}) {
  const root = path.resolve(packageDir || '.')
  const issues = []
  const add = (code, pointer, message) => issues.push({ code, pointer, message })
  for (const issue of validateSynthesisNarrativeSchema(narrative)) {
    add('schema-validation', issue.pointer, issue.message)
  }
  if (narrative?.schemaVersion !== 'repo-synthesis-narrative/v3') add('schema-version', '$.schemaVersion', 'Expected repo-synthesis-narrative/v3.')
  if (narrative?.snapshotId !== contract?.snapshotId || narrative?.snapshotId !== mapManifest?.snapshotId) {
    add('snapshot-mismatch', '$.snapshotId', 'Narrative, ResearchContract, and Product Map snapshotId must match.')
  }
  if (narrative?.mapManifestRef !== 'projections/manifest.json') add('manifest-ref', '$.mapManifestRef', 'mapManifestRef must be projections/manifest.json.')
  if (!same(narrative?.projectionKey, mapManifest?.projectionKey)) add('projection-key', '$.projectionKey', 'Narrative projectionKey is stale.')
  for (const field of REQUIRED_TEXT) if (!text(narrative?.[field])) add('required-text', `$.${field}`, `${field} is required.`)
  for (const field of ['journeySummaries', 'limitations', 'journeyRefs', 'claimRefs', 'evidenceRefs', 'questionRefs']) {
    if (!Array.isArray(narrative?.[field])) add('required-array', `$.${field}`, `${field} must be an array.`)
  }
  for (const key of MAP_KEYS) {
    const expected = mapManifest?.projections?.[key]?.path
    if (!expected || narrative?.mapRefs?.[key] !== expected) add('map-ref', `$.mapRefs.${key}`, `Expected ${expected || 'a manifest projection path'}.`)
  }

  const evidenceIds = idsFromJsonl(path.join(root, 'store', 'evidence.jsonl'), 'evidenceId')
  const acceptedClaimIds = new Set(readJsonLines(path.join(root, 'store', 'claims.jsonl')).filter(item => item.status === 'accepted').map(item => item.claimId))
  const state = readJson(path.join(root, 'state', 'run-state.json')) || {}
  const journeyIds = new Set(Object.keys(state.journeys || {}))
  try {
    const journeyStore = loadJourneyStore(root)
    for (const definition of journeyStore.definitions) journeyIds.add(definition.journeyId)
  } catch (error) {
    add('journey-store', '$.journeyRefs', error.message)
  }
  for (const id of unique(narrative?.evidenceRefs)) if (!evidenceIds.has(id)) add('evidence-ref', '$.evidenceRefs', `Unknown Evidence: ${id}`)
  for (const id of unique(narrative?.claimRefs)) if (!acceptedClaimIds.has(id)) add('claim-ref', '$.claimRefs', `Claim is missing or not accepted: ${id}`)
  for (const id of unique(narrative?.questionRefs)) if (!state.questions?.[id]) add('question-ref', '$.questionRefs', `Unknown Question: ${id}`)
  for (const id of unique(narrative?.journeyRefs)) if (!journeyIds.has(id)) add('journey-ref', '$.journeyRefs', `Unknown Journey: ${id}`)

  const limitationQuestionIds = new Set((narrative?.limitations || []).flatMap(item => item.questionIds || []))
  const unresolvedQuestions = Object.values(state.questions || {}).filter(item => !['resolved', 'waived', 'invalidated'].includes(item.status))
  for (const question of unresolvedQuestions) {
    if (!limitationQuestionIds.has(question.questionId)) add('limitation-missing', '$.limitations', `Unresolved Question must appear as a limitation: ${question.questionId}`)
  }
  for (const [index, summary] of (narrative?.journeySummaries || []).entries()) {
    if (!text(summary?.journeyId) || !text(summary?.summary) || !['closed', 'open', 'blocked'].includes(summary?.status) || !Array.isArray(summary?.evidenceRefs)) {
      add('journey-summary', `$.journeySummaries[${index}]`, 'Journey summary is incomplete.')
    }
    if (summary?.journeyId && !journeyIds.has(summary.journeyId)) add('journey-ref', `$.journeySummaries[${index}].journeyId`, `Unknown Journey: ${summary.journeyId}`)
  }
  for (const [index, limitation] of (narrative?.limitations || []).entries()) {
    if (!text(limitation?.limitationId) || !text(limitation?.summary)) add('limitation', `$.limitations[${index}]`, 'Limitation id and summary are required.')
    for (const field of ['mapDimensions', 'journeyIds', 'questionIds', 'evidenceRefs']) if (!Array.isArray(limitation?.[field])) add('limitation', `$.limitations[${index}].${field}`, `${field} must be an array.`)
  }
  return { valid: issues.length === 0, issues }
}

/**
 * Validate only the bundled synthesis schema. This leaf validator performs no
 * package I/O and is safe for standalone consumers such as the HTML renderer.
 */
export function validateSynthesisNarrativeSchema(narrative) {
  return validateJsonSchema(narrative, SYNTHESIS_SCHEMA)
}

function idsFromJsonl(file, field) {
  return new Set(readJsonLines(file).map(item => item?.[field]).filter(Boolean))
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function readJson(file) {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))]
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateJsonSchema(value, schema, pointer = '$') {
  const issues = []
  const issue = message => issues.push({ pointer, message })
  if (!schema || typeof schema !== 'object') return [{ pointer, message: 'Bundled synthesis schema is unavailable.' }]
  if (Object.hasOwn(schema, 'const') && !same(value, schema.const)) issue(`must equal ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.some(item => same(value, item))) {
    issue(`must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`)
  }
  if (schema.type && !matchesType(value, schema.type)) {
    issue(`must be ${Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type}`)
    return issues
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) issue(`must contain at least ${schema.minLength} character(s)`)
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) issue(`must contain at most ${schema.maxLength} character(s)`)
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) issue(`must match ${schema.pattern}`)
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) issue(`must contain at least ${schema.minItems} item(s)`)
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) issue(`must contain at most ${schema.maxItems} item(s)`)
    if (schema.items) {
      value.forEach((item, index) => issues.push(...validateJsonSchema(item, schema.items, `${pointer}[${index}]`)))
    }
  }
  if (isObject(value)) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) issues.push({ pointer: `${pointer}.${key}`, message: 'is required' })
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) issues.push(...validateJsonSchema(value[key], childSchema, `${pointer}.${key}`))
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}))
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) issues.push({ pointer: `${pointer}.${key}`, message: 'is not allowed by the bundled synthesis schema' })
      }
    }
  }
  return issues
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type]
  return types.some(candidate => {
    if (candidate === 'null') return value === null
    if (candidate === 'array') return Array.isArray(value)
    if (candidate === 'object') return isObject(value)
    if (candidate === 'integer') return Number.isInteger(value)
    if (candidate === 'number') return typeof value === 'number' && Number.isFinite(value)
    return typeof value === candidate
  })
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
