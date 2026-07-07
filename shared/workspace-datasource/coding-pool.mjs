import fs from 'node:fs'
import path from 'node:path'

export function ingestAgentAnalyses(options = {}) {
  const datasource = path.resolve(required(options.datasource, 'datasource'))
  const pool = options.pool || 'coding'
  const fileName = safeFileName(options.fileName || `${Date.now()}.json`)
  const records = normalizeAgentAnalyses(options.value, options.defaults || {})
  const errors = validateAgentAnalyses(records)
  if (errors.length) {
    const error = new Error(`Agent analysis ingest failed validation:\n${errors.map(item => `- ${item}`).join('\n')}`)
    error.exitCode = 2
    throw error
  }
  const analysisPath = path.join(datasource, 'pools', pool, 'analyses', fileName)
  writeJson(analysisPath, records)
  return { analysisPath, records }
}

export function normalizeAgentAnalyses(value, defaults = {}) {
  const records = Array.isArray(value) ? value : [value]
  return records.map((record, index) => ({
    id: record.id || `analysis:${defaults.subject || 'unknown'}:${defaults.task || 'task'}:${index}`,
    subject: record.subject || subjectFromId(defaults.subject || 'workspace'),
    producedBy: record.producedBy || defaults.producedBy || 'subagent',
    provider: record.provider || defaults.provider,
    promptRef: record.promptRef || defaults.promptRef,
    evidenceRefs: Array.isArray(record.evidenceRefs) && record.evidenceRefs.length
      ? record.evidenceRefs
      : normalizeEvidenceRefs(defaults.evidenceRefs),
    claim: record.claim || defaults.claim || 'External analysis completed; inspect raw output for details.',
    rationale: record.rationale || defaults.rationale || 'External analysis did not return a structured rationale. Raw output is preserved.',
    confidence: ['low', 'medium', 'high'].includes(record.confidence) ? record.confidence : (defaults.confidence || 'low'),
    createdAt: record.createdAt || new Date().toISOString(),
  }))
}

export function validateAgentAnalyses(records) {
  const errors = []
  records.forEach((record, index) => {
    const label = record.id || `analysis[${index}]`
    for (const field of ['id', 'subject', 'producedBy', 'evidenceRefs', 'claim', 'rationale', 'confidence', 'createdAt']) {
      if (record[field] === undefined) errors.push(`${label}: missing ${field}`)
    }
    if (record.producedBy && !['codex', 'subagent', 'human'].includes(record.producedBy)) {
      errors.push(`${label}: producedBy must be codex, subagent, or human`)
    }
    if (record.confidence && !['low', 'medium', 'high'].includes(record.confidence)) {
      errors.push(`${label}: confidence must be low, medium, or high`)
    }
    if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0) {
      errors.push(`${label}: evidenceRefs must be a non-empty array`)
    }
    if (!record.subject || typeof record.subject !== 'object' || !record.subject.id || !record.subject.type) {
      errors.push(`${label}: subject must include type and id`)
    }
  })
  return errors
}

export function subjectFromId(id) {
  if (id.startsWith('repo:')) return { type: 'repo', id }
  if (id.startsWith('relationship:')) return { type: 'relationship', id }
  return { type: 'workspace', id }
}

function normalizeEvidenceRefs(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

function required(value, name) {
  if (!value) throw new Error(`Missing required ${name}`)
  return value
}

function safeFileName(value) {
  return String(value || 'analysis.json').replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
