#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const harness = path.join(repoRoot, 'packages', 'repo-understanding-cli', 'src', 'cli.mjs')
const args = parseArgs(process.argv.slice(2))
const outRoot = path.resolve(args.out || path.join(repoRoot, 'outputs', 'benchmarks', `repo-understanding-v3-${timestamp()}`))
const maxFiles = Number(args['max-files'] || 16000)
const repos = (args.repo || []).map(parseRepo)

if (!repos.length) {
  console.error('Usage: node evals/real-repos/run-real-benchmark.mjs --out <dir> --repo name=/absolute/path [--repo name=/absolute/path] [--max-files 16000]')
  process.exit(2)
}
if (!Number.isFinite(maxFiles) || maxFiles <= 0) throw new Error(`Invalid --max-files value: ${args['max-files']}`)

fs.mkdirSync(outRoot, { recursive: true })
const results = []

for (const repo of repos) {
  for (const mode of ['fast', 'deep']) {
    const packageDir = path.join(outRoot, `${safe(repo.name)}-${mode}`)
    fs.rmSync(packageDir, { recursive: true, force: true })

    const scoutRun = timedRun(['scout', '--repo', repo.path, '--out', packageDir, '--max-files', String(maxFiles)], [0])
    const scout = parseJson(scoutRun.stdout, `scout ${repo.name} ${mode}`)
    if (scout.nextAction === 'unsupported') {
      assertUnsupportedPackage(scout, packageDir)
      const legacyArtifacts = findLegacyArtifacts(packageDir)
      if (legacyArtifacts.length) throw new Error(`${repo.name} ${mode} emitted legacy artifacts: ${legacyArtifacts.join(', ')}`)
      results.push({
        repo: repo.name,
        repoPath: repo.path,
        mode,
        packageDir,
        status: 'unsupported',
        scoutMs: scoutRun.durationMs,
        support: summarizeSupport(scout.supportDecision),
        staticGraph: summarizeGraph(scout.staticProgramGraph),
        packageBytes: directoryBytes(packageDir),
        legacyArtifacts,
      })
      continue
    }

    const analyzeRun = timedRun([
      'analyze', '--repo', repo.path, '--out', packageDir, '--max-files', String(maxFiles), '--mode', mode,
    ], [0, 2])
    let status = runJson(['status', '--package', packageDir])
    let dispatch = null
    if (status.nextAction === 'dispatch') {
      dispatch = runJson(['dispatch', '--package', packageDir])
      status = runJson(['status', '--package', packageDir])
    }

    let projection = null
    let projectionRun = null
    const mayProject = status.nextAction === 'project'
    if (mayProject) {
      projectionRun = timedRun(['project', '--package', packageDir, '--only', 'maps'], [0])
      projection = parseJson(projectionRun.stdout, `project ${repo.name} ${mode}`)
      assertProductMapContract(packageDir, projection)
      status = runJson(['status', '--package', packageDir])
    }

    const verificationRun = timedRun(['verify', '--package', packageDir], [0, 2])
    const verification = parseJson(verificationRun.stdout, `verify ${repo.name} ${mode}`)
    const debug = runJson(['debug', '--package', packageDir])
    const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
    const graph = readJson(path.join(packageDir, 'static', 'static-program-graph.json'))
    const semanticManifest = readJson(path.join(packageDir, 'store', 'semantic-store-manifest.json'))
    const journeyManifest = readJson(path.join(packageDir, 'store', 'journeys', 'manifest.json'))
    const legacyArtifacts = findLegacyArtifacts(packageDir)
    if (legacyArtifacts.length) throw new Error(`${repo.name} ${mode} emitted legacy artifacts: ${legacyArtifacts.join(', ')}`)

    const dispatchEntries = dispatch?.workItems || []
    const workItems = dispatchEntries
      .map(entry => readJsonIfExists(entry.workItemPath))
      .filter(Boolean)
    results.push({
      repo: repo.name,
      repoPath: repo.path,
      mode,
      packageDir,
      status: analyzeRun.status === 0 ? 'planned' : 'analysis-validation-failed',
      support: summarizeSupport(scout.supportDecision),
      scoutMs: scoutRun.durationMs,
      analyzeMs: analyzeRun.durationMs,
      projectMs: projectionRun?.durationMs || null,
      totalDeterministicMs: round(scoutRun.durationMs + analyzeRun.durationMs + (projectionRun?.durationMs || 0)),
      validation: status.validation,
      verification: {
        passed: verification.passed,
        phase: verification.phase,
        issueCodes: (verification.issues || []).map(issue => issue.code),
      },
      nextAction: status.nextAction,
      inventory: {
        files: inventory.files?.length || 0,
        sourceFiles: (inventory.files || []).filter(file => file.category === 'source').length,
        truncated: Boolean(inventory.scan?.truncated),
      },
      staticGraph: summarizeGraph(graph),
      semanticStore: {
        evidence: semanticManifest.counts?.evidence || 0,
        claims: semanticManifest.counts?.claims || 0,
        acceptedClaims: semanticManifest.counts?.acceptedClaims || 0,
        claimSetHash: semanticManifest.hashes?.claims || null,
      },
      research: {
        questionCounts: status.research?.questionCounts || {},
        contracts: status.research?.contracts || 0,
        dispatchableContracts: status.research?.dispatchableContracts || 0,
        workItems: workItems.length,
        roles: countBy(workItems, item => item.role),
        kinds: countBy(workItems, item => item.kind),
        maxFilesBudget: Math.max(0, ...workItems.map(item => item.budgetHints?.maxFiles || 0)),
        maxContextBytes: Math.max(0, ...workItems.map(item => item.budgetHints?.maxContextBytes || 0)),
        maxTokens: Math.max(0, ...workItems.map(item => item.budgetHints?.maxTokens || 0)),
      },
      journeys: {
        total: journeyManifest.counts?.journeys || 0,
        closed: journeyManifest.counts?.closed || 0,
        critical: journeyManifest.counts?.critical || 0,
        criticalClosed: journeyManifest.counts?.criticalClosed || 0,
        current: status.validation?.gates?.journeys?.current || false,
        closureRate: status.validation?.gates?.journeys?.closureRate || 0,
        journeySetHash: journeyManifest.journeySetHash,
      },
      productMaps: summarizeProductMaps(packageDir, projection, status),
      debug: {
        issued: debug.invocations.issued,
        started: debug.invocations.started,
        completed: debug.invocations.completed,
        failed: debug.invocations.failed,
        usageReported: debug.invocations.usageReported,
        usageUnavailable: debug.invocations.usageUnavailable,
        aggregateUsage: debug.aggregateUsage,
        tracePath: debug.files.trace,
      },
      packageBytes: directoryBytes(packageDir),
      legacyArtifacts,
    })
  }
}

const report = {
  schemaVersion: 'repo-real-benchmark/v3',
  generatedAt: new Date().toISOString(),
  outRoot,
  maxFiles,
  note: 'Planning benchmark only. No worker agent is executed. Static Program Graph, ResearchContract, Journey closure, semantic store, and Product Map gates are measured from generated package artifacts.',
  results,
}
writeJson(path.join(outRoot, 'benchmark.json'), report)
fs.writeFileSync(path.join(outRoot, 'benchmark.md'), `${renderMarkdown(report)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))

function assertUnsupportedPackage(scout, packageDir) {
  if (scout.supportDecision?.supportLevel !== 'unsupported') throw new Error('Unsupported scout result must carry supportLevel=unsupported.')
  if ((scout.staticProgramGraph?.nodes || []).length || (scout.staticProgramGraph?.edges || []).length) {
    throw new Error('Unsupported repository emitted Static Program Graph nodes or edges.')
  }
  if (fs.existsSync(path.join(packageDir, 'planning', 'manifest.json'))) throw new Error('Unsupported repository emitted a ResearchPlan.')
}

function assertProductMapContract(packageDir, projection) {
  if (projection.schemaVersion !== 'repo-product-projection-result/v1') throw new Error(`Unexpected projection schema: ${projection.schemaVersion}`)
  const manifest = readJson(path.join(packageDir, 'projections', 'manifest.json'))
  if (manifest.schemaVersion !== 'repo-product-map-manifest/v1') throw new Error(`Unexpected Product Map manifest schema: ${manifest.schemaVersion}`)
  const expected = {
    application: 'repo-application-map/v1',
    experience: 'repo-experience-map/v1',
    runtimeFlow: 'repo-runtime-flow-map/v1',
    change: 'repo-change-map/v1',
  }
  for (const [key, schemaVersion] of Object.entries(expected)) {
    const entry = manifest.projections?.[key]
    if (!entry) throw new Error(`Product Map manifest is missing ${key}.`)
    const mapPath = path.resolve(packageDir, entry.path)
    if (!fs.existsSync(mapPath)) throw new Error(`Product Map file is missing: ${entry.path}`)
    const map = readJson(mapPath)
    if (map.schemaVersion !== schemaVersion || entry.schemaVersion !== schemaVersion) {
      throw new Error(`${key} Product Map schema mismatch.`)
    }
    if (canonicalHash(map) !== entry.contentHash) throw new Error(`${key} Product Map contentHash mismatch.`)
  }
}

function summarizeSupport(decision = {}) {
  return {
    level: decision.supportLevel,
    repoKind: decision.repoKind,
    frontendRoots: decision.frontendRoots || [],
    backendRoots: decision.backendRoots || [],
    unsupportedReason: decision.unsupportedReason || null,
  }
}

function summarizeGraph(graph = {}) {
  return {
    nodes: graph.nodes?.length || 0,
    edges: graph.edges?.length || 0,
    diagnostics: graph.diagnostics?.length || 0,
    parsedFiles: graph.metrics?.parsedFiles || 0,
    parserMode: graph.parser?.mode || null,
    contentHash: graph.schemaVersion ? canonicalHash({ ...graph, generatedAt: undefined }) : null,
  }
}

function summarizeProductMaps(packageDir, projection, status) {
  if (!projection?.maps) return { built: false, current: false, projectionKey: null, files: {} }
  const manifest = readJson(path.join(packageDir, 'projections', 'manifest.json'))
  return {
    built: true,
    current: status.validation?.gates?.productMaps?.current || false,
    projectionKey: manifest.projectionKey,
    files: Object.fromEntries(Object.entries(manifest.projections || {}).map(([key, entry]) => [key, {
      path: entry.path,
      schemaVersion: entry.schemaVersion,
      bytes: fs.statSync(path.resolve(packageDir, entry.path)).size,
      contentHash: entry.contentHash,
    }])),
  }
}

function findLegacyArtifacts(packageDir) {
  const files = listRelativeFiles(packageDir)
  const found = files.filter(relative => (
    /(?:^|\/)(?:fact-graph|render-graph|gap-queue|verification)\.json$/i.test(relative)
    || /(?:^|\/)store\/(?:gaps\.jsonl|knowledge-manifest\.json)$/i.test(relative)
    || /(?:^|\/)views\/knowledge-index\.jsonl$/i.test(relative)
    || relative.startsWith('exploration/')
  ))
  const forbiddenContent = /repo-(?:fact-graph|gap(?:-queue)?)\/v\d|coverage-directed|"coverage(?:Score|Threshold|Eligible)"|"(?:gapQueue|openGaps|gapTasks)"/i
  for (const relative of files.filter(file => /\.(?:json|jsonl|md|txt)$/i.test(file))) {
    const absolute = path.join(packageDir, relative)
    if (fs.statSync(absolute).size > 2 * 1024 * 1024) continue
    const match = fs.readFileSync(absolute, 'utf8').match(forbiddenContent)
    if (match) found.push(`content:${relative}:${match[0]}`)
  }
  return [...new Set(found)].sort()
}

function listRelativeFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(target)
      else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join('/'))
    }
  }
  return files.sort()
}

function timedRun(commandArgs, allowedStatuses) {
  const started = process.hrtime.bigint()
  const result = spawnSync(process.execPath, [harness, ...commandArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6
  if (result.error) throw result.error
  if (!allowedStatuses.includes(result.status)) {
    throw new Error([`harness ${commandArgs.join(' ')} exited ${result.status}`, result.stdout, result.stderr].filter(Boolean).join('\n'))
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, durationMs: round(durationMs) }
}

function runJson(commandArgs) {
  const result = timedRun(commandArgs, [0])
  return parseJson(result.stdout, commandArgs.join(' '))
}

function parseJson(value, label) {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`Expected JSON from ${label}:\n${value}`)
  }
}

function parseArgs(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = values[index + 1]
    if (!value || value.startsWith('--')) result[name] = true
    else {
      index += 1
      if (name === 'repo') result.repo = [...(result.repo || []), value]
      else result[name] = value
    }
  }
  return result
}

function parseRepo(value) {
  const index = value.indexOf('=')
  if (index <= 0) throw new Error(`Invalid --repo value: ${value}`)
  const repo = { name: value.slice(0, index), path: path.resolve(value.slice(index + 1)) }
  if (!fs.existsSync(repo.path)) throw new Error(`Repository does not exist: ${repo.path}`)
  return repo
}

function renderMarkdown(report) {
  const rows = report.results.map(item => [
    item.repo,
    item.mode,
    item.support?.level || '-',
    item.status,
    item.inventory?.files ?? '-',
    item.staticGraph?.nodes ?? 0,
    item.staticGraph?.edges ?? 0,
    item.semanticStore?.acceptedClaims ?? 0,
    item.research?.contracts ?? 0,
    item.research?.workItems ?? 0,
    item.journeys ? `${item.journeys.closed}/${item.journeys.total}` : '-',
    item.productMaps?.built ? (item.productMaps.current ? 'current' : 'blocked/stale') : '-',
    item.verification?.passed ?? '-',
    item.nextAction || '-',
    item.totalDeterministicMs ? Math.round(item.totalDeterministicMs) : Math.round(item.scoutMs || 0),
    item.packageBytes ? (item.packageBytes / 1024 / 1024).toFixed(1) : '-',
  ])
  return [
    '# Repo Understanding v3 Real Repository Planning Benchmark',
    '',
    report.note,
    '',
    '| repo | mode | support | status | files | SPG nodes | SPG edges | accepted Claims | contracts | WorkItems | journeys closed/total | Product Maps | verification | next action | deterministic ms | package MB |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | ---: | ---: |',
    ...rows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
}

function countBy(values, keyFn) {
  const result = {}
  for (const value of values) {
    const key = keyFn(value) || 'unknown'
    result[key] = (result[key] || 0) + 1
  }
  return result
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonIfExists(file) {
  return file && fs.existsSync(file) ? readJson(file) : null
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function directoryBytes(root) {
  let total = 0
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(target)
      else if (entry.isFile()) total += fs.statSync(target).size
    }
  }
  return total
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonicalValue(value[key])]))
  }
  return value
}

function round(value) {
  return Math.round(Number(value) * 10) / 10
}

function safe(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}
