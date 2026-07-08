import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  SCHEMA,
  buildRequestForPackage,
} from './repo-understanding-core.mjs'
import { refreshHarnessArtifactsForPackage } from './fact-graph-harness.mjs'
import {
  factExplorerNames,
  validPredicateSet,
} from './harness-registry.mjs'

const SECRET_VALUE_PATTERN = /(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|credential|passwd|password|private[_-]?key|secret|token)\s*[:=]/i

const DEFAULT_LIMITS = {
  maxFiles: 80,
  maxFileChars: 8000,
  maxSearchResults: 120,
  contextLines: 1,
}

const VALID_PREDICATES = validPredicateSet()
const VALID_FACT_EXPLORERS = factExplorerNames()
const VALID_SOURCES = new Set(['dynamic', 'inferred'])

export function buildExplorationRequestForPackage(packageDir) {
  const root = path.resolve(packageDir)
  const { request, requestHash } = buildExplorationRequestPayload(root)
  updateIndex(root, index => {
    delete index.requests
    index.transientRequests = { ...(index.transientRequests || {}) }
    index.transientRequests.repoExplorationHash = requestHash
    index.updatedAt = new Date().toISOString()
  })
  return { request, requestHash }
}

export function writeExplorationAnalysis(packageDir, value, provenance = {}) {
  const root = path.resolve(packageDir)
  const inventory = readJson(path.join(root, 'static', 'inventory.json'))
  const requestHash = provenance.requestHash || safeExplorationRequestHash(root)
  const now = new Date().toISOString()
  const producedBy = value.producedBy || {}
  const normalized = {
    schemaVersion: SCHEMA.explorationAnalysis,
    generatedAt: value.generatedAt || now,
    repo: value.repo || { name: inventory.repo.name, path: inventory.repo.path },
    producedBy: {
      runtime: producedBy.runtime || provenance.runtime || 'unknown',
      role: producedBy.role || provenance.role || 'repo-explorer',
      sessionId: producedBy.sessionId || provenance.sessionId || undefined,
      requestHash: requestHash || producedBy.requestHash,
      analysisInputHash: producedBy.analysisInputHash || provenance.analysisInputHash || hashText(JSON.stringify(value)),
      analysisOutputHash: undefined,
      sourcePath: producedBy.sourcePath || provenance.sourcePath || undefined,
    },
    strategy: String(value.strategy || '').trim(),
    facts: normalizeArray(value.facts).map(normalizeExplorerFact).filter(Boolean),
    openQuestions: normalizeArray(value.openQuestions).map(normalizeExplorerOpenQuestion).filter(Boolean),
    observations: normalizeArray(value.observations),
    requestedEvidence: {
      files: normalizeArray(value.requestedEvidence?.files),
      searches: normalizeArray(value.requestedEvidence?.searches),
    },
    gaps: normalizeArray(value.gaps),
    verdicts: normalizeArray(value.verdicts).map(normalizeVerifierVerdict).filter(Boolean),
  }
  validateExplorerAnalysis(normalized, inventory)
  normalized.producedBy.analysisOutputHash = hashText(JSON.stringify(normalized))
  const analysisPath = path.join(root, 'analyses', 'repo-exploration.json')
  writeJson(analysisPath, normalized)
  updateIndex(root, index => {
    index.analyses = { ...(index.analyses || {}) }
    index.analyses.repoExploration = 'analyses/repo-exploration.json'
    index.analyses.repoExplorationHash = hashFile(analysisPath)
    index.analyses.repoExplorationProvenance = normalized.producedBy
    index.transientRequests = { ...(index.transientRequests || {}) }
    if (requestHash) index.transientRequests.repoExplorationHash = requestHash
  })
  refreshHarnessArtifactsForPackage(root)
  return { analysisPath, analysis: normalized }
}

export function collectExplorationEvidence(packageDir, options = {}) {
  const root = path.resolve(packageDir)
  const limits = {
    ...DEFAULT_LIMITS,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  }
  const inventory = readJson(path.join(root, 'static', 'inventory.json'))
  const analysisPath = path.join(root, 'analyses', 'repo-exploration.json')
  if (!fs.existsSync(analysisPath)) {
    throw new Error(`Missing exploration analysis: ${analysisPath}`)
  }
  const analysis = readJson(analysisPath)
  const inventoryByPath = new Map(inventory.files.map(file => [file.path, file]))
  const fileRequests = collectFileRequests(analysis)
  const searchRequests = collectSearchRequests(analysis)
  const files = []
  const skipped = []
  let includedFiles = 0

  for (const request of fileRequests) {
    if (includedFiles >= limits.maxFiles) {
      skipped.push({ path: request.path, reason: 'max-files limit reached' })
      continue
    }
    const rel = normalizeRequestedPath(request.path, inventory.repo.path)
    const meta = inventoryByPath.get(rel)
    if (!meta) {
      skipped.push({ path: request.path, reason: 'not found in inventory' })
      continue
    }
    if (meta.protected || meta.category === 'protected' || !meta.contentAnalyzable) {
      skipped.push({ path: rel, reason: meta.protected ? 'protected metadata-only file' : 'not content analyzable' })
      continue
    }
    const fullPath = path.join(inventory.repo.path, rel)
    const text = safeRead(fullPath)
    if (!text) {
      skipped.push({ path: rel, reason: 'empty or unreadable' })
      continue
    }
    const excerpts = buildExcerpts(text, request.ranges, limits)
    files.push({
      path: rel,
      reason: request.reason || 'requested by exploration analysis',
      hash: meta.hash,
      excerpts,
    })
    includedFiles += 1
  }

  const searches = []
  for (const request of searchRequests) {
    searches.push(runSearchRequest(request, inventory, limits))
  }

  const bundle = {
    schemaVersion: SCHEMA.explorationEvidenceBundle,
    generatedAt: new Date().toISOString(),
    repo: inventory.repo,
    sourceAnalysis: 'analyses/repo-exploration.json',
    files,
    searches,
    skipped,
  }
  const bundleDir = path.join(root, 'exploration')
  const jsonPath = path.join(bundleDir, 'evidence-bundle.json')
  const mdPath = path.join(bundleDir, 'evidence-bundle.md')
  writeJson(jsonPath, bundle)
  fs.writeFileSync(mdPath, renderEvidenceBundleMarkdown(bundle), 'utf8')
  updateIndex(root, index => {
    index.exploration = { ...(index.exploration || {}) }
    index.exploration.evidenceBundle = 'exploration/evidence-bundle.json'
    index.exploration.evidenceBundleMarkdown = 'exploration/evidence-bundle.md'
    index.exploration.evidenceBundleHash = hashFile(jsonPath)
    index.updatedAt = new Date().toISOString()
  })
  refreshHarnessArtifactsForPackage(root)
  buildRequestForPackage(root)
  return { jsonPath, mdPath, bundle }
}

function buildExplorationRequestPayload(root) {
  const inventory = readJson(path.join(root, 'static', 'inventory.json'))
  const codeMap = readJson(path.join(root, 'static', 'code-map.json'))
  const gapQueue = readJsonIfExists(path.join(root, 'gap-queue.json'))
  const renderGraph = readJsonIfExists(path.join(root, 'static', 'render-graph.json'))
  const knowledgeIndex = readJson(path.join(root, 'static', 'knowledge-index.json'))
  const request = renderExplorationRequest({ inventory, codeMap, gapQueue, renderGraph, knowledgeIndex })
  return { request, requestHash: hashText(request) }
}

function safeExplorationRequestHash(root) {
  try {
    return buildExplorationRequestPayload(root).requestHash
  } catch {
    return undefined
  }
}

function renderExplorationRequest({ inventory, codeMap, gapQueue, renderGraph, knowledgeIndex }) {
  const focusFiles = chooseFocusFiles(inventory, codeMap)
  const directories = inventory.directories.slice(0, 80)
  const schema = {
    schemaVersion: SCHEMA.explorationAnalysis,
    repo: { name: inventory.repo.name, path: inventory.repo.path },
    producedBy: {
      runtime: 'agent-runtime',
      role: 'repo-explorer',
      sessionId: 'optional',
    },
    strategy: 'Brief description of how you explored.',
    facts: [
      {
        subject: 'file:src/router/index.ts or relative/path or structured node',
        subjectType: 'file|module|symbol|route|package|service|config|datastore',
        predicate: [...VALID_PREDICATES].join('|'),
        object: 'route:/orders or relative/path or structured node',
        objectType: 'file|module|symbol|route|package|service|config|datastore',
        source: 'dynamic|inferred',
        confidence: 0.7,
        explorer: VALID_FACT_EXPLORERS.join('|'),
        evidence: [
          { file: 'relative/path', line: 1, endLine: 3, snippet: 'optional <=3 lines', tool: 'repo-explorer', rawConfidence: 0.7 },
        ],
      },
    ],
    openQuestions: [
      { question: 'Question that still needs owner/runtime confirmation.', relatedNodes: ['file:relative/path'], raisedBy: 'repo-explorer' },
    ],
    observations: [
      {
        title: 'Evidence-backed observation',
        finding: 'What you learned.',
        confidence: 'low|medium|high',
        tags: ['runtime-entrypoint|request-pipeline|config|data-access|external-integration|security|async|domain-flow|risk'],
        evidence: [
          { path: 'relative/path', startLine: 1, endLine: 20, reason: 'Why this file/range matters' },
        ],
      },
    ],
    requestedEvidence: {
      files: [
        {
          path: 'relative/path',
          reason: 'Why the final synthesis should see this file.',
          ranges: [{ startLine: 1, endLine: 80, label: 'Relevant section' }],
        },
      ],
      searches: [
        {
          pattern: 'Search term or regex',
          regex: false,
          paths: ['optional/path/prefix'],
          reason: 'Why these matches matter.',
          maxResults: 20,
        },
      ],
    },
    gaps: ['Questions that still need runtime, owner, or environment confirmation.'],
  }

  return `# Repo Exploration Request

You are a read-only repository exploration agent restricted to non-destructive inspection.

Your task is not to write the final architecture summary. Your task is to explore the repository actively, identify missing evidence that a static scan may overlook, and return structured exploration JSON. The important output is \`facts[]\`: evidence-backed triples that can be merged into \`fact-graph.json\`.

## Repository

\`\`\`json
${JSON.stringify(inventory.repo, null, 2)}
\`\`\`

## Read-only Tool Policy

- Do not modify files.
- Do not run install, build, test, package, format, migration, server, or network commands.
- Use read-only exploration only.
- If your runtime provides shell tools, prefer \`rg\`, \`find\`, \`sed -n\`, \`nl -ba\`, \`git status --short\`, and \`git log --oneline -5\`.
- If your runtime exposes read-only code-navigation tools, prefer file-tree, file-search, code-structure, read-file, and read-only git; do not run install/build/test/servers.
- Read \`AGENTS.md\` if present.

## Exploration Workflow

1. Map the landscape: directory tree, manifests, and likely entrypoints.
2. Search for runtime and wiring terms: servlet, filter, interceptor, route, controller, handler, listener, consumer, scheduler, queue, datasource, config, auth, permission, security, client, facade, rpc, http, grpc, kafka, rocketmq, redis, elasticsearch, websocket.
3. Read targeted ranges from key files. Prefer small line ranges over entire large files.
4. Trace dependencies from entrypoints into config, service, data access, security, async, and external integration boundaries.
5. Report evidence-backed triples in \`facts[]\`, plus the exact file ranges/searches that the deterministic fetcher should preserve for final synthesis.

## Focus Areas

- Runtime entrypoints and deployment shape.
- HTTP/request pipeline, filters, interceptors, routes, controllers, handlers, middleware.
- Configuration, environment, and datasource wiring.
- External systems and protocols.
- Authentication, authorization, permission, signing, and sensitive flows.
- Async jobs, queues, schedulers, websocket, consumers, workers.
- Domain flows and boundaries.
- Concrete risks visible from code/config.

## Gap Task Queue

These tasks were generated by L1 Scanner and L3 coverage/confidence gates. Prefer these tasks over broad wandering. If you discover a new gap, put it in \`openQuestions[]\`.

\`\`\`json
${JSON.stringify((gapQueue?.tasks || []).slice(0, 120), null, 2)}
\`\`\`

## Static Signals

### Counts

\`\`\`json
${JSON.stringify(inventory.counts, null, 2)}
\`\`\`

### Directories

\`\`\`json
${JSON.stringify(directories, null, 2)}
\`\`\`

### Manifests

\`\`\`json
${JSON.stringify(codeMap.manifests, null, 2)}
\`\`\`

### Entrypoints

\`\`\`json
${JSON.stringify(codeMap.entrypoints.slice(0, 120), null, 2)}
\`\`\`

### Candidate Focus Files

\`\`\`json
${JSON.stringify(focusFiles, null, 2)}
\`\`\`

### Embedded Architecture View

This view is embedded in \`static/code-map.json#architecture\`. It is deterministic and Archify-inspired: semantic components, explicit boundaries, sparse connections, and evidenceRefs. Use it to target exploration, but verify every runtime claim with files/ranges/searches.

\`\`\`json
${JSON.stringify(trimArchitectureView(codeMap.architecture), null, 2)}
\`\`\`

### Render Graph Summary

\`\`\`json
${JSON.stringify(trimRenderGraph(renderGraph), null, 2)}
\`\`\`

### Evidence Refs Summary

\`\`\`json
${JSON.stringify(knowledgeIndex.evidenceRefs.filter(ref => ref.kind === 'manifest' || ref.kind === 'config' || ref.kind === 'source' || ref.kind === 'code-map' || ref.kind === 'render-graph').slice(0, 180).map(({ snippet, ...ref }) => ref), null, 2)}
\`\`\`

## Required Output

Return JSON only. Match this schema:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

Rules:

- Every fact must cite file evidence with relative paths and line ranges when possible.
- Do not return free-text-only findings. If you are unsure, use \`openQuestions[]\` instead of inventing a fact.
- \`requestedEvidence.files\` should include the exact files/ranges the final synthesis should see.
- \`requestedEvidence.searches\` should include searches that prove cross-cutting patterns.
- Protected files are metadata-only. Do not request or infer secret values.
- Separate facts from inference. Put uncertain runtime/environment questions in \`openQuestions[]\` and \`gaps\`.
`
}

function chooseFocusFiles(inventory, codeMap) {
  const entrypointPaths = new Set((codeMap.entrypoints || []).map(item => item.file).filter(Boolean))
  return inventory.files
    .filter(file => file.contentAnalyzable && !file.protected)
    .map(file => {
      let score = 0
      if (entrypointPaths.has(file.path)) score += 90
      if (file.category === 'manifest') score += 100
      if (file.category === 'config') score += 70
      if (/(^|\/)(AGENTS|README|Dockerfile|Makefile|Procfile|pom\.xml|package\.json|go\.mod|Cargo\.toml|pyproject\.toml|web\.xml|\.gitlab-ci\.yml)$/i.test(file.path)) score += 90
      if (/(spring|application|bootstrap|config|datasource|shiro|security|auth|permission|route|router|controller|handler|filter|interceptor|listener|consumer|scheduler|job|mq|kafka|rocket|redis|elastic|websocket|client|facade|rpc|httpinvoke|dubbo)/i.test(file.path)) score += 60
      if (file.lines > 0 && file.lines <= 900) score += 10
      if (file.lines > 1600) score -= 20
      return { path: file.path, category: file.category, language: file.language, lines: file.lines, score }
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 160)
}

function collectFileRequests(analysis) {
  const requests = []
  const add = (value, fallbackReason = 'referenced by exploration analysis') => {
    if (!value) return
    if (typeof value === 'string') {
      requests.push({ path: value, reason: fallbackReason, ranges: [] })
      return
    }
    const filePath = value.path || value.file || value.relativePath
    if (!filePath) return
    requests.push({
      path: filePath,
      reason: value.reason || value.rationale || value.label || fallbackReason,
      ranges: normalizeRanges(value.ranges || value.range || value.lines || value),
    })
  }
  for (const request of normalizeArray(analysis.requestedEvidence?.files)) add(request, 'requested by exploration analysis')
  for (const observation of normalizeArray(analysis.observations)) {
    for (const evidence of normalizeArray(observation.evidence)) add(evidence, observation.title || 'observation evidence')
  }
  return dedupeFileRequests(requests)
}

function collectSearchRequests(analysis) {
  return normalizeArray(analysis.requestedEvidence?.searches)
    .map(search => ({
      pattern: String(search.pattern || '').trim(),
      regex: Boolean(search.regex),
      caseSensitive: Boolean(search.caseSensitive),
      paths: normalizeArray(search.paths).map(String).filter(Boolean),
      reason: search.reason || search.rationale || 'requested by exploration analysis',
      maxResults: clampNumber(search.maxResults, 1, DEFAULT_LIMITS.maxSearchResults, 20),
    }))
    .filter(search => search.pattern)
}

function dedupeFileRequests(requests) {
  const byPath = new Map()
  for (const request of requests) {
    const key = request.path
    const existing = byPath.get(key)
    if (!existing) {
      byPath.set(key, { ...request, ranges: [...(request.ranges || [])] })
      continue
    }
    existing.reason = existing.reason || request.reason
    existing.ranges.push(...(request.ranges || []))
  }
  return [...byPath.values()].map(request => ({
    ...request,
    ranges: dedupeRanges(request.ranges || []),
  }))
}

function normalizeRanges(value) {
  if (!value) return []
  if (typeof value === 'string') return parseLineRanges(value)
  if (Array.isArray(value)) return value.flatMap(item => normalizeRanges(item))
  if (typeof value === 'object') {
    const start = value.startLine ?? value.start_line ?? value.start
    const end = value.endLine ?? value.end_line ?? value.end ?? value.line
    if (start || end) {
      const startLine = Number(start || end)
      const endLine = Number(end || start)
      if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
        return [{ startLine, endLine, label: value.label || value.description || value.reason }]
      }
    }
    if (typeof value.lines === 'string') return parseLineRanges(value.lines)
  }
  return []
}

function parseLineRanges(value) {
  return String(value)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const match = part.match(/^(\d+)(?:-(\d+))?$/)
      if (!match) return null
      const startLine = Number(match[1])
      const endLine = Number(match[2] || match[1])
      return { startLine, endLine }
    })
    .filter(Boolean)
}

function dedupeRanges(ranges) {
  const seen = new Set()
  const result = []
  for (const range of ranges) {
    const startLine = Math.max(1, Number(range.startLine || 1))
    const endLine = Math.max(startLine, Number(range.endLine || startLine))
    const key = `${startLine}:${endLine}:${range.label || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ startLine, endLine, label: range.label })
  }
  return result
}

function buildExcerpts(text, ranges, limits) {
  const lines = text.split(/\r?\n/)
  if (!ranges || ranges.length === 0) {
    return [excerptFromLines(lines, 1, Math.min(lines.length, 260), limits.maxFileChars, 'top of requested file')]
  }
  return ranges.slice(0, 8).map(range => {
    const start = Math.max(1, Number(range.startLine || 1) - limits.contextLines)
    const end = Math.min(lines.length, Number(range.endLine || range.startLine || start) + limits.contextLines)
    return excerptFromLines(lines, start, end, limits.maxFileChars, range.label)
  })
}

function excerptFromLines(lines, startLine, endLine, maxChars, label) {
  let used = 0
  const selected = []
  for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
    const line = redactSecretLineIfNeeded(lines[lineNo - 1] || '')
    if (used + line.length + 1 > maxChars) break
    selected.push(line)
    used += line.length + 1
  }
  return {
    startLine,
    endLine: startLine + selected.length - 1,
    label,
    text: selected.join('\n'),
  }
}

function runSearchRequest(request, inventory, limits) {
  const matches = []
  const matcher = buildMatcher(request)
  if (!matcher) {
    return { ...request, matches: [], error: 'invalid regex' }
  }
  const allowedFiles = inventory.files.filter(file => {
    if (!file.contentAnalyzable || file.protected || file.category === 'protected') return false
    if (!request.paths.length) return true
    return request.paths.some(prefix => file.path === prefix || file.path.startsWith(`${prefix.replace(/\/$/, '')}/`))
  })
  const maxResults = Math.min(request.maxResults || 20, limits.maxSearchResults)
  for (const file of allowedFiles) {
    if (matches.length >= maxResults) break
    const text = safeRead(path.join(inventory.repo.path, file.path))
    if (!text) continue
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (matches.length >= maxResults) break
      if (!matcher(lines[i])) continue
      matches.push({
        path: file.path,
        line: i + 1,
        text: redactSecretLineIfNeeded(lines[i]).slice(0, 500),
      })
    }
  }
  return {
    pattern: request.pattern,
    regex: request.regex,
    caseSensitive: request.caseSensitive,
    paths: request.paths,
    reason: request.reason,
    matches,
  }
}

function buildMatcher(request) {
  if (request.regex) {
    try {
      const regex = new RegExp(request.pattern, request.caseSensitive ? '' : 'i')
      return line => regex.test(line)
    } catch {
      return null
    }
  }
  const needle = request.caseSensitive ? request.pattern : request.pattern.toLowerCase()
  return line => {
    const haystack = request.caseSensitive ? line : line.toLowerCase()
    return haystack.includes(needle)
  }
}

function renderEvidenceBundleMarkdown(bundle) {
  return `# Exploration Evidence Bundle

Repository: ${bundle.repo.name}

Generated: ${bundle.generatedAt}

Source analysis: \`${bundle.sourceAnalysis}\`

## Files

${bundle.files.map(file => `### ${file.path}

Reason: ${file.reason || ''}

${file.excerpts.map(excerpt => `#### Lines ${excerpt.startLine}-${excerpt.endLine}${excerpt.label ? `: ${excerpt.label}` : ''}

\`\`\`
${excerpt.text}
\`\`\``).join('\n\n')}`).join('\n\n') || '- None.'}

## Searches

${bundle.searches.map(search => `### ${search.regex ? 'Regex' : 'Text'}: ${search.pattern}

Reason: ${search.reason || ''}

${search.matches.map(match => `- ${match.path}:${match.line} ${match.text}`).join('\n') || '- No matches.'}`).join('\n\n') || '- None.'}

## Skipped

${bundle.skipped.map(item => `- ${item.path}: ${item.reason}`).join('\n') || '- None.'}
`
}

function normalizeRequestedPath(value, repoPath) {
  const normalized = String(value || '').replaceAll('\\', '/')
  const repoNormalized = path.resolve(repoPath).replaceAll('\\', '/')
  if (path.isAbsolute(normalized) && normalized.startsWith(`${repoNormalized}/`)) {
    return normalized.slice(repoNormalized.length + 1)
  }
  return normalized.replace(/^\.?\//, '')
}

function redactSecretLineIfNeeded(line) {
  if (!SECRET_VALUE_PATTERN.test(line)) return line
  const separator = line.includes('=') ? '=' : ':'
  const index = line.indexOf(separator)
  if (index === -1) return '[REDACTED_SECRET_LINE]'
  return `${line.slice(0, index + 1)} [REDACTED]`
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeExplorerFact(value) {
  if (!value || typeof value !== 'object') return null
  const evidence = normalizeArray(value.evidence).map(item => ({
    file: item.file || item.path,
    line: item.line ?? item.startLine,
    endLine: item.endLine,
    snippet: item.snippet || item.text,
    tool: item.tool || value.explorer || 'repo-explorer',
    rawConfidence: item.rawConfidence ?? item.confidence ?? value.confidence,
  })).filter(item => item.file)
  return {
    subject: value.subject,
    subjectType: value.subjectType,
    predicate: value.predicate,
    object: value.object,
    objectType: value.objectType,
    source: value.source || 'dynamic',
    confidence: value.confidence,
    explorer: value.explorer || value.raisedBy,
    inferred: Boolean(value.inferred),
    evidence,
  }
}

function normalizeExplorerOpenQuestion(value) {
  if (!value) return null
  if (typeof value === 'string') return { question: value, relatedNodes: [], raisedBy: 'repo-explorer' }
  const question = String(value.question || value.title || value.finding || '').trim()
  if (!question) return null
  return {
    question,
    relatedNodes: normalizeArray(value.relatedNodes).map(String).filter(Boolean),
    raisedBy: value.raisedBy || value.explorer || 'repo-explorer',
  }
}

function normalizeVerifierVerdict(value) {
  if (!value || typeof value !== 'object') return null
  const verdict = value.verdict === 'insufficient' ? 'skipped' : value.verdict
  return {
    edgeId: value.edgeId,
    verdict,
    reason: String(value.reason || '').trim(),
    evidenceChecked: value.evidenceChecked,
    checkedAt: value.checkedAt,
    tool: value.tool || 'repo-fact-verifier',
  }
}

function validateExplorerAnalysis(value, inventory = null) {
  const issues = []
  const inventoryByPath = inventory
    ? new Map((inventory.files || []).map(file => [normalizeRequestedPath(file.path, inventory.repo?.path || ''), file]))
    : new Map()
  for (const [index, fact] of (value.facts || []).entries()) {
    if (!fact.subject) issues.push(`facts[${index}].subject is required`)
    if (!fact.object) issues.push(`facts[${index}].object is required`)
    if (!VALID_PREDICATES.has(fact.predicate)) issues.push(`facts[${index}].predicate is invalid: ${fact.predicate || 'missing'}`)
    if (!VALID_SOURCES.has(fact.source)) issues.push(`facts[${index}].source is invalid: ${fact.source || 'missing'}`)
    if (fact.confidence !== undefined) {
      const confidence = Number(fact.confidence)
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) issues.push(`facts[${index}].confidence must be 0..1`)
    }
    if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) {
      issues.push(`facts[${index}].evidence must contain at least one item`)
    }
    for (const [evidenceIndex, evidence] of (fact.evidence || []).entries()) {
      if (!evidence.file) {
        issues.push(`facts[${index}].evidence[${evidenceIndex}].file is required`)
      } else if (inventoryByPath.size) {
        const filePath = normalizeRequestedPath(evidence.file, inventory.repo?.path || '')
        const meta = inventoryByPath.get(filePath)
        if (!meta) {
          issues.push(`facts[${index}].evidence[${evidenceIndex}].file is not in inventory: ${evidence.file}`)
        } else {
          const lineCount = Number(meta.lines || 0)
          const startLine = evidence.line === undefined ? null : Number(evidence.line)
          const endLine = evidence.endLine === undefined ? startLine : Number(evidence.endLine)
          if (evidence.line !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
            issues.push(`facts[${index}].evidence[${evidenceIndex}].line must be a positive integer`)
          }
          if (evidence.endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
            issues.push(`facts[${index}].evidence[${evidenceIndex}].endLine must be a positive integer`)
          }
          if (Number.isInteger(startLine) && Number.isInteger(endLine) && endLine < startLine) {
            issues.push(`facts[${index}].evidence[${evidenceIndex}].endLine must be >= line`)
          }
          if (lineCount > 0 && Number.isInteger(startLine) && startLine > lineCount) {
            issues.push(`facts[${index}].evidence[${evidenceIndex}].line exceeds file line count: ${evidence.file}:${startLine} > ${lineCount}`)
          }
          if (lineCount > 0 && Number.isInteger(endLine) && endLine > lineCount) {
            issues.push(`facts[${index}].evidence[${evidenceIndex}].endLine exceeds file line count: ${evidence.file}:${endLine} > ${lineCount}`)
          }
        }
      }
      if (evidence.snippet && String(evidence.snippet).split(/\r?\n/).length > 3) {
        issues.push(`facts[${index}].evidence[${evidenceIndex}].snippet must be <= 3 lines`)
      }
    }
  }
  for (const [index, verdict] of (value.verdicts || []).entries()) {
    if (!verdict.edgeId) issues.push(`verdicts[${index}].edgeId is required`)
    if (!['not-refuted', 'refuted', 'skipped'].includes(verdict.verdict)) issues.push(`verdicts[${index}].verdict is invalid: ${verdict.verdict || 'missing'}`)
    if (!verdict.reason) issues.push(`verdicts[${index}].reason is required`)
  }
  if (issues.length) throw new Error(`Explorer analysis failed schema validation:\n${issues.map(issue => `- ${issue}`).join('\n')}`)
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function updateIndex(packageDir, mutator) {
  const indexPath = path.join(packageDir, 'index.json')
  const index = fs.existsSync(indexPath) ? readJson(indexPath) : {}
  mutator(index)
  index.updatedAt = new Date().toISOString()
  writeJson(indexPath, index)
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null
  return readJson(file)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function hashText(text) {
  return createHash('sha1').update(text).digest('hex')
}

function hashFile(file) {
  try {
    return createHash('sha1').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return hashText('')
  }
}

function trimArchitectureView(value) {
  if (!value) return null
  return {
    schemaVersion: value.schemaVersion,
    method: value.method,
    components: Array.isArray(value.components)
      ? value.components.slice(0, 32).map(component => ({
        id: component.id,
        type: component.type,
        label: component.label,
        role: component.role,
        confidence: component.confidence,
        keyFiles: component.keyFiles,
        evidenceRefs: component.evidenceRefs,
        signals: component.signals,
      }))
      : [],
    boundaries: Array.isArray(value.boundaries) ? value.boundaries.slice(0, 16) : [],
    connections: Array.isArray(value.connections)
      ? value.connections.slice(0, 48).map(connection => ({
        from: connection.from,
        to: connection.to,
        label: connection.label,
        kind: connection.kind,
        confidence: connection.confidence,
        evidenceRefs: connection.evidenceRefs,
      }))
      : [],
  }
}

function trimRenderGraph(value) {
  if (!value) return null
  return {
    schemaVersion: value.schemaVersion,
    purpose: value.purpose,
    source: value.source,
    nodes: Array.isArray(value.nodes)
      ? value.nodes.slice(0, 48).map(node => ({
        id: node.id,
        kind: node.kind,
        type: node.type,
        label: node.label,
        confidence: node.confidence,
        evidenceRefs: node.evidenceRefs,
      }))
      : [],
    edges: Array.isArray(value.edges)
      ? value.edges.slice(0, 64).map(edge => ({
        id: edge.id,
        kind: edge.kind,
        from: edge.from,
        to: edge.to,
        label: edge.label,
        evidenceRefs: edge.evidenceRefs,
      }))
      : [],
    frames: Array.isArray(value.frames) ? value.frames.slice(0, 24) : [],
  }
}
