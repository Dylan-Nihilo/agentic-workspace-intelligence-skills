#!/usr/bin/env node
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildRequestForPackage,
  collectRepoUnderstanding,
  defaultPackageDir,
  parseCommonArgs,
  writeAnalysis,
  writeValidation,
} from '../../../shared/understanding/repo-understanding-core.mjs'
import { writeExplorationAnalysis } from '../../../shared/understanding/repo-exploration-core.mjs'
import { projectHarnessPackage } from '../../../shared/understanding/fact-graph-harness.mjs'
import { generateHumanReadableHtml } from '../../../shared/understanding/human-readable-html.mjs'
import {
  EXPLORER,
  assertKnownExplorers,
  explorerEnabled,
  explorerEffort,
  projectionNames,
} from '../../../shared/understanding/harness-registry.mjs'

function usage() {
  console.error(`Usage:
  harness analyze --repo /path/to/repo [--out /path/to/package] [--max-files 16000] [--incremental] [--base HEAD]
  harness project --package /path/to/package [--only ${[...projectionNames(), 'all'].join('|')}]
  harness status --package /path/to/package
  harness dispatch --package /path/to/package [--max-tasks 40] [--explorers a,b,c]
  harness ingest --package /path/to/package (--analysis /path/to/output.json | --open-question text [--tasks id1,id2]) [--explorer name] [--round n]
  harness explore --package /path/to/package [--runner codex] [--max-tasks 40] [--rounds 2] [--until-coverage [threshold]]
  harness request --package /path/to/package
  harness write-subagent --package /path/to/package --analysis /path/to/analysis.json
  harness report --package /path/to/package [--out /path/to/report.md]
  harness html --package /path/to/package [--out /path/to/human-readable.html]
  harness verify --package /path/to/package
  harness serve --package /path/to/package [--port 8787]`)
  process.exit(1)
}

const EXECUTABLE_GAP_TYPES = new Set([
  'coverage-gap',
  'low-confidence-fact',
  'unresolved-import',
  'semantic-hint',
  'open-question',
])

function main() {
  const command = process.argv[2]
  if (!command || command === '--help' || command === '-h') usage()
  const argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)]
  if (command === 'analyze') return analyze(argv)
  if (command === 'project') return project(argv)
  if (command === 'status') return status(argv)
  if (command === 'dispatch') return dispatch(argv)
  if (command === 'ingest') return ingest(argv)
  if (command === 'explore') return explore(argv)
  if (command === 'request') return request(argv)
  if (command === 'write-subagent') return writeSubagent(argv)
  if (command === 'report') return report(argv)
  if (command === 'html') return html(argv)
  if (command === 'verify') return verify(argv)
  if (command === 'serve') return serve(argv)
  usage()
}

function analyze(argv) {
  const args = parseArgs(argv, ['repo'])
  const repoPath = path.resolve(args.repo)
  const outDir = args.out ? path.resolve(args.out) : defaultPackageDir(repoPath)
  const maxFiles = args['max-files'] ? Number(args['max-files']) : 16000
  if (!Number.isFinite(maxFiles)) usage()
  const previousFactGraph = args.incremental && fs.existsSync(path.join(outDir, 'fact-graph.json'))
    ? JSON.parse(fs.readFileSync(path.join(outDir, 'fact-graph.json'), 'utf8'))
    : null
  const previousCodeMap = args.incremental && fs.existsSync(path.join(outDir, 'static', 'code-map.json'))
    ? JSON.parse(fs.readFileSync(path.join(outDir, 'static', 'code-map.json'), 'utf8'))
    : null
  const incremental = args.incremental
    ? buildIncrementalPlan(repoPath, args.base || 'HEAD', previousFactGraph, previousCodeMap)
    : null
  const result = collectRepoUnderstanding({ repoPath, outDir, maxFiles, incremental })
  if (incremental) writeIncrementalReport(outDir, incremental, result.factGraph)
  const validation = writeValidation(result.packageDir)
  console.log(`Analyzed ${repoPath}`)
  console.log(`Package: ${result.packageDir}`)
  if (incremental) console.log(`Incremental diff files: ${incremental.changedFiles.length}, invalidated nodes: ${incremental.invalidatedNodeIds.length}`)
  console.log(`FactGraph nodes: ${Object.keys(result.factGraph.nodes).length}, edges: ${Object.keys(result.factGraph.edges).length}, coverage: ${result.factGraph.stats.coverageScore}`)
  console.log(`Render graph: ${result.renderGraph.nodes.length} nodes, ${result.renderGraph.edges.length} edges`)
  console.log(`Validation passed: ${validation.passed}`)
  if (!validation.passed) process.exitCode = 2
}

function project(argv) {
  const args = parseArgs(argv, ['package'])
  const only = args.only || 'all'
  if (![...projectionNames(), 'all'].includes(only)) usage()
  const packageDir = path.resolve(args.package)
  const artifacts = only === 'html' ? null : projectHarnessPackage(packageDir, { only })
  const htmlResult = only === 'html' || only === 'all'
    ? generateHumanReadableHtml({ packageDir })
    : null
  const validation = writeValidation(packageDir)
  console.log(`Reprojected ${only} from existing FactGraph package: ${packageDir}`)
  const factGraph = artifacts?.factGraph || readJson(path.join(packageDir, 'fact-graph.json'))
  console.log(`FactGraph edges: ${Object.keys(factGraph.edges).length}`)
  if (htmlResult) console.log(`HTML: ${htmlResult.output}`)
  console.log(`Validation passed: ${validation.passed}`)
  if (!validation.passed) process.exitCode = 2
}

function verify(argv) {
  const args = parseArgs(argv, ['package'])
  const validation = writeValidation(path.resolve(args.package))
  console.log(JSON.stringify(validation, null, 2))
  if (!validation.passed) process.exitCode = 2
}

function status(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  console.log(JSON.stringify(buildHarnessStatus(packageDir), null, 2))
}

function dispatch(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const maxTasks = args['max-tasks'] ? Number(args['max-tasks']) : 40
  if (!Number.isFinite(maxTasks)) usage()
  const explorers = parseExplorerFilter(args.explorers)
  const manifest = createDispatchRound(packageDir, { maxTasks, explorers })
  console.log(JSON.stringify(manifest, null, 2))
}

function ingest(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  if (!args.analysis && !args['open-question']) usage()
  try {
    const value = args['open-question']
      ? openQuestionAnalysis(packageDir, args['open-question'], args.tasks)
      : readAnalysisInput(args.analysis)
    const result = ingestAnalysisValue(packageDir, value, {
      analysisPath: !args.analysis || args.analysis === '-' ? undefined : path.resolve(args.analysis),
      explorer: args.explorer || value.explorer || value.producedBy?.role,
      round: args.round ? Number(args.round) : undefined,
      runtime: args.runtime || value.producedBy?.runtime || 'agent-runtime',
    })
    console.log(JSON.stringify(result, null, 2))
    if (!result.merged) process.exitCode = 2
  } catch (err) {
    console.log(JSON.stringify({
      schemaVersion: 'repo-harness-ingest-result/v1',
      merged: false,
      issues: schemaIssuesFromError(err),
    }, null, 2))
    process.exitCode = 2
  }
}

function request(argv) {
  const args = parseArgs(argv, ['package'])
  const result = buildRequestForPackage(path.resolve(args.package))
  process.stdout.write(result.request)
}

function writeSubagent(argv) {
  const args = parseArgs(argv, ['package', 'analysis'])
  const packageDir = path.resolve(args.package)
  const value = JSON.parse(args.analysis === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(path.resolve(args.analysis), 'utf8'))
  const result = writeAnalysis(packageDir, value, {
    runtime: args.runtime || 'agent-runtime',
    role: args.role || 'repo-understander',
    sessionId: args.session || undefined,
    sourcePath: args.analysis === '-' ? undefined : path.resolve(args.analysis),
  })
  const validation = writeValidation(packageDir)
  console.log(JSON.stringify({
    schemaVersion: 'repo-harness-write-subagent-result/v1',
    written: true,
    analysisPath: result.analysisPath,
    validation: {
      passed: validation.passed,
      score: validation.score,
      issues: validation.issues,
      warnings: validation.warnings,
    },
  }, null, 2))
  if (!validation.passed) process.exitCode = 2
}

function report(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const outFile = args.out ? path.resolve(args.out) : path.join(packageDir, 'report.md')
  const validation = writeValidation(packageDir)
  const markdown = renderHarnessReport(packageDir, validation)
  fs.writeFileSync(outFile, `${markdown.trimEnd()}\n`, 'utf8')
  console.log(`Report: ${outFile}`)
}

function html(argv) {
  const args = parseArgs(argv, ['package'])
  const result = generateHumanReadableHtml({
    packageDir: path.resolve(args.package),
    outFile: args.out ? path.resolve(args.out) : undefined,
  })
  console.log(JSON.stringify(result, null, 2))
}

function explore(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const runner = args.runner || 'codex'
  if (runner !== 'codex') usage()
  const maxTasks = args['max-tasks'] ? Number(args['max-tasks']) : 40
  const harnessConfig = readHarnessConfig()
  const rounds = args.rounds ? Number(args.rounds) : (harnessConfig.maxExplorerRounds || 2)
  if (!Number.isFinite(maxTasks) || !Number.isFinite(rounds)) usage()

  const initial = readPackageState(packageDir)
  const untilCoverage = parseUntilCoverage(args['until-coverage'], initial.gapQueue.coverageThreshold)
  const firstDispatch = buildExplorerDispatch(packageDir, initial, maxTasks, null, harnessConfig.explorers || {})
  if (!firstDispatch.taskCount) {
    console.log(`Explore has no open executable tasks: coverage=${initial.gapQueue.coverageScore}, tasks=${initial.gapQueue.tasks?.length || 0}`)
    return
  }
  if (!codexAvailable()) {
    printSkillExplorerFallback(packageDir, firstDispatch)
    process.exitCode = 3
    return
  }

  let wroteAnalysis = false
  for (let round = 1; round <= rounds; round += 1) {
    const state = readPackageState(packageDir)
    if (untilCoverage !== null && (state.gapQueue.coverageScore || 0) >= untilCoverage) {
      console.log(`Explore stopped before round ${round}: coverage=${state.gapQueue.coverageScore} reached ${untilCoverage}`)
      break
    }
    const dispatchManifest = createDispatchRound(packageDir, { maxTasks, explorerConfig: harnessConfig.explorers || {} })
    if (!dispatchManifest.explorers.length) {
      console.log(`Explore stopped before round ${round}: no open executable tasks`)
      break
    }
    console.log(`Explore round ${dispatchManifest.round}: ${dispatchManifest.taskCount} tasks across ${dispatchManifest.explorers.length} explorers`)
    for (const explorer of dispatchManifest.explorers) {
      const prompt = fs.readFileSync(explorer.promptPath, 'utf8')
      const result = runCodexExplorer(state.inventory.repo.path, prompt, explorer.schemaPath)
      const outputValue = result.ok
        ? result.analysis
        : {
            schemaVersion: 'repo-exploration-analysis/v1',
            strategy: `codex runner failed for ${explorer.explorer}`,
            facts: [],
            openQuestions: [{
              question: `Explorer ${explorer.explorer} failed: ${result.error}`,
              relatedNodes: explorer.taskIds.slice(0, 20),
              raisedBy: 'explorer-runtime',
            }],
            observations: [],
            requestedEvidence: { files: [], searches: [] },
            gaps: [],
          }
      fs.writeFileSync(explorer.outputPath, `${JSON.stringify(outputValue, null, 2)}\n`, 'utf8')
      try {
        const ingestResult = ingestAnalysisValue(packageDir, outputValue, {
          analysisPath: explorer.outputPath,
          runtime: 'codex-cli',
          explorer: explorer.explorer,
          round: dispatchManifest.round,
        })
        wroteAnalysis = true
        console.log(`  ${explorer.explorer}: ${ingestResult.merged ? 'merged' : 'rejected'}`)
      } catch (err) {
        const fallback = {
          schemaVersion: 'repo-exploration-analysis/v1',
          strategy: `schema fallback for ${explorer.explorer}`,
          facts: [],
          openQuestions: [{
            question: `Explorer ${explorer.explorer} output was rejected by schema validation: ${err.message}`,
            relatedNodes: explorer.taskIds.slice(0, 20),
            raisedBy: 'explorer-schema',
          }],
          observations: [],
          requestedEvidence: { files: [], searches: [] },
          gaps: [],
        }
        fs.writeFileSync(explorer.outputPath, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8')
        ingestAnalysisValue(packageDir, fallback, {
          analysisPath: explorer.outputPath,
          runtime: 'codex-cli',
          explorer: explorer.explorer,
          round: dispatchManifest.round,
        })
        wroteAnalysis = true
        console.log(`  ${explorer.explorer}: rejected output, open question recorded`)
      }
    }
  }

  const validation = writeValidation(packageDir)
  console.log(`Exploration analysis written: ${wroteAnalysis}`)
  console.log(`Validation passed: ${validation.passed}`)
  if (!validation.passed) process.exitCode = 2
}

function serve(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const port = args.port ? Number(args.port) : 8787
  if (!Number.isFinite(port)) usage()
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${port}`)
      if (url.pathname === '/health') return json(res, { ok: true, packageDir })
      if (url.pathname === '/fact-graph') return fileJson(res, path.join(packageDir, 'fact-graph.json'))
      if (url.pathname === '/render-graph') return fileJson(res, path.join(packageDir, 'render-graph.json'))
      if (url.pathname === '/knowledge-index') return text(res, fs.readFileSync(path.join(packageDir, 'knowledge-index.jsonl'), 'utf8'), 'application/x-ndjson')
      if (url.pathname === '/search') return search(res, packageDir, url.searchParams.get('q') || '')
      if (url.pathname.startsWith('/wiki/')) return serveWiki(res, packageDir, url.pathname)
      return json(res, { endpoints: ['/fact-graph', '/render-graph', '/knowledge-index', '/search?q=', '/wiki/README.md', '/health'] }, 404)
    } catch (err) {
      return json(res, { error: err.message }, 500)
    }
  })
  server.listen(port, () => {
    console.log(`Repo understanding harness serving ${packageDir}`)
    console.log(`http://localhost:${port}`)
  })
}

function buildHarnessStatus(packageDir, options = {}) {
  const root = path.resolve(packageDir)
  const explorerConfig = options.explorerConfig || readHarnessConfig().explorers || {}
  const validation = options.validation || writeValidation(root)
  const inventory = readJson(path.join(root, 'static', 'inventory.json'))
  const factGraph = readJson(path.join(root, 'fact-graph.json'))
  const gapQueue = readJsonIfExists(path.join(root, 'gap-queue.json')) || { tasks: [] }
  const tasks = gapQueue.tasks || []
  const history = readDispatchHistory(root)
  const currentTaskIds = new Set(tasks.map(task => task.id))
  const dispatchedHistoryIds = new Set(history.flatMap(round => round.taskIds || []))
  const doneFromHistory = [...dispatchedHistoryIds].filter(id => !currentTaskIds.has(id)).length
  const statusCounts = countTasksBy(tasks, task => task.status || 'unknown')
  const typeCounts = countTasksBy(tasks, task => task.type || 'unknown')
  const statusTypeCounts = countTasksBy(tasks, task => `${task.status || 'unknown'}:${task.type || 'unknown'}`)
  const executableOpenTasks = executableGapTasks(gapQueue, explorerConfig).length
  const openDisabledTasks = candidateExecutableGapTasks(gapQueue)
    .filter(task => !explorerEnabled(task.explorer, explorerConfig))
    .length
  const hasSynthesis = fs.existsSync(path.join(root, 'analyses', 'repo-understanding.json'))
  const nextAction = executableOpenTasks > 0
    ? 'dispatch'
    : hasSynthesis && validation.passed
      ? 'done'
      : 'synthesize'
  return {
    schemaVersion: 'repo-harness-status/v1',
    generatedAt: new Date().toISOString(),
    packageDir: root,
    repo: inventory.repo,
    coverage: {
      score: gapQueue.coverageScore ?? factGraph.stats?.coverageScore ?? 0,
      threshold: gapQueue.coverageThreshold ?? 0.85,
    },
    tasks: {
      total: tasks.length,
      open: statusCounts.open || 0,
      dispatched: statusCounts.dispatched || 0,
      done: (statusCounts.done || 0) + doneFromHistory,
      skipped: statusCounts.skipped || 0,
      executableOpen: executableOpenTasks,
      openDisabled: openDisabledTasks,
      byType: typeCounts,
      byStatusType: statusTypeCounts,
    },
    validation: {
      passed: validation.passed,
      score: validation.score,
      issues: validation.issues,
      warnings: validation.warnings,
      stats: validation.stats,
    },
    nextAction,
  }
}

function createDispatchRound(packageDir, options = {}) {
  const root = path.resolve(packageDir)
  const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const state = readPackageState(root)
  const explorerConfig = options.explorerConfig || readHarnessConfig().explorers || {}
  const dispatchPlan = buildExplorerDispatch(root, state, options.maxTasks || 40, options.explorers, explorerConfig)
  const round = options.round || nextDispatchRound(root)
  const dispatchDir = path.join(root, 'exploration', 'dispatch', `round-${round}`)
  ensureDir(dispatchDir)
  const explorers = dispatchPlan.explorers.map(bundle => {
    const name = safeFileName(bundle.explorer)
    const promptPath = path.join(dispatchDir, `${name}.md`)
    const outputPath = path.join(dispatchDir, `${name}.output.json`)
    const schemaPath = schemaPathForExplorer(bundle.explorer)
    const prompt = renderDispatchBundleMarkdown({
      packageDir: root,
      repo: dispatchPlan.repo,
      round,
      explorer: bundle.explorer,
      tasks: bundle.tasks,
      tokenBudget: bundle.tokenBudget,
      effort: bundle.effort,
      outputPath,
      schemaPath,
      body: bundle.prompt,
    })
    fs.writeFileSync(promptPath, prompt, 'utf8')
    return {
      explorer: bundle.explorer,
      taskIds: bundle.tasks.map(task => task.id),
      taskCount: bundle.tasks.length,
      tokenBudget: bundle.tokenBudget,
      effort: bundle.effort,
      promptPath,
      outputPath,
      schemaPath,
      schema: path.relative(harnessRoot, schemaPath),
    }
  })
  for (const bundle of dispatchPlan.explorers) {
    const explorer = explorers.find(item => item.explorer === bundle.explorer)
    markDispatchedTasks(root, bundle.tasks, round, bundle.explorer, {
      promptPath: explorer?.promptPath,
      outputPath: explorer?.outputPath,
      schemaPath: explorer?.schemaPath,
    })
  }
  const manifest = {
    schemaVersion: 'repo-explorer-dispatch/v1',
    generatedAt: new Date().toISOString(),
    packageDir: root,
    repo: dispatchPlan.repo,
    round,
    dispatchDir,
    manifestPath: path.join(dispatchDir, 'manifest.json'),
    taskCount: dispatchPlan.taskCount,
    explorers,
  }
  fs.writeFileSync(manifest.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

function ingestAnalysisValue(packageDir, value, provenance = {}) {
  return withPackageWriteLock(packageDir, () => {
    if (isVerificationOutput(value, provenance.explorer)) {
      return ingestVerificationAnalysis(packageDir, value, provenance)
    }
    return ingestExplorationAnalysis(packageDir, value, provenance)
  })
}

function withPackageWriteLock(packageDir, callback) {
  const root = path.resolve(packageDir)
  const lockPath = path.join(root, '.repo-understanding-ingest.lock')
  let fd
  try {
    fd = fs.openSync(lockPath, 'wx')
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }))
    return callback()
  } catch (err) {
    if (err?.code === 'EEXIST') throw new Error(`Package ingest write lock exists: ${lockPath}`)
    throw err
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd)
      fs.rmSync(lockPath, { force: true })
    }
  }
}

function ingestExplorationAnalysis(packageDir, value, provenance = {}) {
  const root = path.resolve(packageDir)
  const inventory = readJson(path.join(root, 'static', 'inventory.json'))
  const before = readJsonIfExists(path.join(root, 'fact-graph.json')) || { edges: {} }
  const beforeVerification = readJsonIfExists(path.join(root, 'verification.json')) || { verdicts: [] }
  const existing = readJsonIfExists(path.join(root, 'analyses', 'repo-exploration.json'))
  const base = existing || emptyExplorationAnalysis(inventory.repo)
  const incoming = sanitizeExplorerOutput(value)
  const next = mergeExplorationAnalyses(base, incoming, `round ${provenance.round || 'manual'} ${provenance.explorer || incoming.producedBy?.role || 'repo-explorer'}`)
  const result = writeExplorationAnalysis(root, next, {
    runtime: provenance.runtime || 'agent-runtime',
    role: provenance.explorer || incoming.producedBy?.role || 'repo-explorer',
    sessionId: provenance.round ? `harness-dispatch-round-${provenance.round}` : undefined,
    sourcePath: provenance.analysisPath,
  })
  const validation = writeValidation(root)
  const statusValue = buildHarnessStatus(root, { validation })
  const after = readJsonIfExists(path.join(root, 'fact-graph.json')) || { edges: {} }
  const afterVerification = readJsonIfExists(path.join(root, 'verification.json')) || { verdicts: [] }
  const removedEdgesByVerifier = newlyRefutedVerifierEdges(beforeVerification, afterVerification)
  return {
    schemaVersion: 'repo-harness-ingest-result/v1',
    merged: true,
    analysisPath: result.analysisPath,
    factsAccepted: Array.isArray(incoming.facts) ? incoming.facts.length : 0,
    edgeDelta: Object.keys(after.edges || {}).length - Object.keys(before.edges || {}).length,
    edgesRemovedByVerifier: removedEdgesByVerifier.length,
    removedEdgesByVerifier,
    coverage: statusValue.coverage,
    openTasks: statusValue.tasks.open,
    nextAction: statusValue.nextAction,
    validation: statusValue.validation,
  }
}

function ingestVerificationAnalysis(packageDir, value, provenance = {}) {
  const root = path.resolve(packageDir)
  const inventory = readJson(path.join(root, 'static', 'inventory.json'))
  const existing = readJsonIfExists(path.join(root, 'analyses', 'repo-exploration.json'))
  const base = existing || emptyExplorationAnalysis(inventory.repo)
  const verifierAnalysis = verifierOutputToExplorationAnalysis(value, provenance)
  const next = mergeExplorationAnalyses(base, verifierAnalysis, `round ${provenance.round || 'manual'} ${EXPLORER.adversarialVerify}`)
  const result = writeExplorationAnalysis(root, next, {
    runtime: provenance.runtime || 'agent-runtime',
    role: EXPLORER.adversarialVerify,
    sessionId: provenance.round ? `harness-dispatch-round-${provenance.round}` : undefined,
    sourcePath: provenance.analysisPath,
  })
  const validation = writeValidation(root)
  const statusValue = buildHarnessStatus(root, { validation })
  return {
    schemaVersion: 'repo-harness-ingest-result/v1',
    merged: true,
    analysisPath: result.analysisPath,
    factsAccepted: 0,
    verdictsAccepted: verifierAnalysis.verdicts.length,
    coverage: statusValue.coverage,
    openTasks: statusValue.tasks.open,
    nextAction: statusValue.nextAction,
    validation: statusValue.validation,
  }
}

function newlyRefutedVerifierEdges(beforeVerification, afterVerification) {
  const beforeIds = new Set((beforeVerification.verdicts || [])
    .filter(item => item.verdict === 'refuted')
    .map(item => item.edgeId))
  return (afterVerification.verdicts || [])
    .filter(item => item.verdict === 'refuted' && item.edgeId && !beforeIds.has(item.edgeId))
    .map(item => ({
      edgeId: item.edgeId,
      reason: item.reason || '',
      evidenceChecked: item.evidenceChecked || 0,
    }))
}

function renderHarnessReport(packageDir, validation) {
  const inventory = readJsonIfExists(path.join(packageDir, 'inventory.json')) || readJson(path.join(packageDir, 'static', 'inventory.json'))
  const factGraph = readJson(path.join(packageDir, 'fact-graph.json'))
  const repoProfile = readJsonIfExists(path.join(packageDir, 'repo-profile.json')) || readJsonIfExists(path.join(packageDir, 'static', 'repo-profile.json'))
  const scanPolicy = readJsonIfExists(path.join(packageDir, 'scan-policy.json')) || readJsonIfExists(path.join(packageDir, 'static', 'scan-policy.json'))
  const gapQueue = readJsonIfExists(path.join(packageDir, 'gap-queue.json')) || {}
  const renderGraph = readJsonIfExists(path.join(packageDir, 'render-graph.json')) || { nodes: [], edges: [] }
  const knowledgeIndex = readJsonIfExists(path.join(packageDir, 'knowledge-index.json')) || { chunks: [] }
  const analysis = readJsonIfExists(path.join(packageDir, 'analyses', 'repo-exploration.json')) || { facts: [], observations: [], openQuestions: [] }
  const evidenceBundle = readJsonIfExists(path.join(packageDir, 'exploration', 'evidence-bundle.json')) || { files: [], searches: [], skipped: [] }
  const stats = validation.stats || {}
  const repo = factGraph.repo || inventory.repo || {}
  const git = repoGitSummary(factGraph)
  const title = repo.name || inventory.repo?.name || path.basename(repo.path || packageDir)
  const sourceFiles = factGraph.stats?.sourceFileCount ?? stats.sourceFiles ?? sourceFileCount(inventory)
  const openTasks = gapQueue.openTaskCount ?? (gapQueue.tasks || []).filter(task => task.status === 'open').length
  const dispatchedTasks = gapQueue.dispatchedTaskCount ?? (gapQueue.tasks || []).filter(task => task.status === 'dispatched').length
  const taskCount = gapQueue.taskCount ?? (gapQueue.tasks || []).length
  const lines = []

  lines.push(`# ${title} Harness Report`)
  lines.push('')
  lines.push(`Generated at: ${new Date().toISOString()}`)
  lines.push(`Repo: \`${repo.path || inventory.repo?.path || ''}\``)
  lines.push(`Package: \`${packageDir}\``)
  lines.push('')
  lines.push('## 1. 结论')
  lines.push('')
  lines.push(`最终 validation **${validation.passed ? 'passed' : 'failed'}**, score **${validation.score ?? 'n/a'}**, issues **${(validation.issues || []).length}**, warnings **${(validation.warnings || []).length}**。`)
  if ((validation.warnings || []).length) lines.push(`Warnings: ${(validation.warnings || []).map(item => `\`${item}\``).join(', ')}`)
  if ((validation.issues || []).length) lines.push(`Issues: ${(validation.issues || []).map(item => `\`${item}\``).join(', ')}`)
  lines.push('')
  lines.push(markdownTable(['指标', '值'], [
    ['Git branch/head', git],
    ['L0 profile', `${repoProfile?.repoKind || 'unknown'} / ${repoProfile?.primaryLanguage || 'unknown'}`],
    ['Files / source files', `${stats.files ?? inventory.files?.length ?? 0} / ${sourceFiles}`],
    ['Protected files', stats.protectedFiles ?? inventory.counts?.protectedFiles ?? 0],
    ['FactGraph nodes / edges', `${Object.keys(factGraph.nodes || {}).length} / ${Object.keys(factGraph.edges || {}).length}`],
    ['Static coverageScore', factGraph.stats?.coverageScore ?? stats.coverageScore ?? 'n/a'],
    ['symbolExtractionRate', factGraph.stats?.symbolExtractionRate ?? 'n/a'],
    ['Gap tasks open/dispatched/total', `${openTasks} / ${dispatchedTasks} / ${taskCount}`],
    ['Verified / removed edges', `${stats.verifiedEdges ?? 0} / ${stats.removedByVerifier ?? 0}`],
    ['RenderGraph nodes / edges', `${renderGraph.nodes?.length ?? stats.renderNodes ?? 0} / ${renderGraph.edges?.length ?? stats.renderEdges ?? 0}`],
    ['Knowledge chunks', knowledgeIndex.chunks?.length ?? stats.knowledgeChunks ?? stats.knowledgeJsonlChunks ?? 0],
    ['L2 facts / observations / open questions', `${analysis.facts?.length ?? 0} / ${analysis.observations?.length ?? 0} / ${analysis.openQuestions?.length ?? 0}`],
    ['Evidence bundle files / searches / skipped', `${evidenceBundle.files?.length ?? 0} / ${evidenceBundle.searches?.length ?? 0} / ${evidenceBundle.skipped?.length ?? 0}`],
  ]))
  lines.push('')
  lines.push(renderProjectOverview(inventory, factGraph, repoProfile, scanPolicy))
  lines.push('')
  lines.push('## 3. 执行链路')
  lines.push('')
  lines.push(markdownTable(['阶段', '命令/动作'], [
    ['L0 scout', 'repo-scout profile + scan-policy'],
    ['L1 analyze', 'harness analyze --repo ... --out <package>'],
    ['L2 explore', 'harness explore --package <package>'],
    ['L2 evidence bundle', 'npm run understanding:collect-exploration -- --package <package>'],
    ['L4 project', 'harness project --package <package> --only all'],
    ['quality gate', 'harness verify --package <package>'],
    ['human report', 'harness report --package <package> --out <report.md>'],
  ]))
  lines.push('')
  lines.push('## 4. Validation 抽检')
  lines.push('')
  lines.push(renderPredicateSamples(validation))
  lines.push('')
  lines.push('## 5. FactGraph 分布')
  lines.push('')
  lines.push('### Node Types')
  lines.push('')
  lines.push(markdownTable(['type', 'count'], sortedCountRows(Object.values(factGraph.nodes || {}), node => node.type)))
  lines.push('')
  lines.push('### Edge Predicates')
  lines.push('')
  lines.push(markdownTable(['predicate', 'count'], sortedCountRows(Object.values(factGraph.edges || {}), edge => edge.predicate)))
  lines.push('')
  lines.push('### Gap Queue')
  lines.push('')
  lines.push(markdownTable(['status:type', 'count'], sortedCountRows(gapQueue.tasks || [], task => `${task.status || 'unknown'}:${task.type || 'unknown'}`)))
  lines.push('')
  lines.push('## 6. L2 Dynamic Fact Samples')
  lines.push('')
  lines.push(renderDynamicFactSamples(analysis))
  lines.push('')
  lines.push('## 7. High-Importance Files')
  lines.push('')
  lines.push(renderImportantFiles(factGraph))
  lines.push('')
  lines.push('## 8. 产物入口')
  lines.push('')
  lines.push(markdownTable(['artifact', 'path'], artifactRows(packageDir)))
  lines.push('')
  lines.push('## 9. 说明')
  lines.push('')
  lines.push('- 本报告由 `harness report` 生成,以当前 package 内的 `fact-graph.json`、`validation.json`、`gap-queue.json`、L2 exploration 与 inventory 为事实源。')
  lines.push('- 项目概览只读取 inventory 中非 protected 的公开源码入口和 manifest,不输出 secret、证书、env 等 protected 内容。')
  if ((validation.warnings || []).includes('No subagent analysis has been written yet')) {
    lines.push('- 当前 warning `No subagent analysis has been written yet` 表示最终自然语言 synthesis 尚未写回,不影响本报告基于 harness artifacts 的概览。')
  }
  return lines.join('\n')
}

function renderProjectOverview(inventory, factGraph, repoProfile = null, scanPolicy = null) {
  if ((scanPolicy?.reportProjection?.mode || repoProfile?.repoKind) === 'backend') {
    return renderBackendProjectOverview(inventory, factGraph, repoProfile)
  }
  const repoPath = inventory.repo?.path || factGraph.repo?.path || ''
  const packageJson = readRepoJson(repoPath, 'package.json', inventory) || {}
  const readme = readFirstExistingRepoText(repoPath, ['README.md', 'readme.md'], inventory)
  const vueConfig = readRepoText(repoPath, 'vue.config.js', inventory)
  const mainEntry = firstExistingRepoFile(inventory, [packageJson.main, 'src/main.ts', 'src/main.js', 'src/index.ts', 'src/index.js', 'main.ts', 'main.js'])
  const mainText = mainEntry ? readRepoText(repoPath, mainEntry, inventory) : ''
  const appVueText = readRepoText(repoPath, 'src/App.vue', inventory)
  const httpText = readFirstExistingRepoText(repoPath, ['src/utils/http.js', 'src/utils/http.ts', 'src/utils/request.js', 'src/utils/request.ts', 'src/request.js', 'src/request.ts'], inventory)
  const permissionText = [
    readRepoText(repoPath, 'src/router/permission.js', inventory),
    appVueText,
    readRepoText(repoPath, 'src/store/modules/permission.js', inventory),
    readRepoText(repoPath, 'src/utils/index.js', inventory),
    readFirstMatchingRepoText(repoPath, inventory, /(^|\/)hasPermission\.(js|ts)$/),
  ].join('\n')
  const readmeHeading = firstMarkdownHeading(readme)
  const identityParts = [packageJson.description, readmeHeading].filter(Boolean)
  const description = [...new Set(identityParts)].join(' / ') || inventory.repo?.name || path.basename(repoPath)
  const frameworks = detectFrameworks(packageJson)
  const routeCount = Object.values(factGraph.nodes || {}).filter(node => node.type === 'route').length
  const routeFile = firstExistingRepoFile(inventory, ['src/router/customRouter.js', 'src/router/index.js', 'router/index.js']) || 'router config'
  const viewGroups = topViewGroups(inventory, readme).slice(0, 8)
  const mountTarget = detectMountTarget(mainText, readRepoText(repoPath, 'public/index.html', inventory), factGraph)
  const qiankun = /__POWERED_BY_QIANKUN__|export\s+async\s+function\s+(bootstrap|mount|unmount)|libraryTarget:\s*['"]umd['"]/.test(`${mainText}\n${vueConfig}`)
  const devPort = matchFirst(vueConfig, /port:\s*(\d+)/)
  const proxies = detectProxyTargets(vueConfig)
  const baseUrls = [...new Set([...httpText.matchAll(/baseUrl:\s*['"]([^'"]+)['"]/g)].map(match => match[1]))]
  const scripts = packageJson.scripts ? Object.keys(packageJson.scripts).slice(0, 8).map(name => `${name}: ${packageJson.scripts[name]}`) : []
  const lines = []

  lines.push('## 2. 项目概览')
  lines.push('')
  lines.push(`\`${packageJson.name || inventory.repo?.name || path.basename(repoPath)}\` 是“${description}”相关前端项目。项目入口是 \`${mainEntry || '未识别'}\`${mountTarget ? `, 页面挂载目标是 \`${mountTarget}\`` : ''}。`)
  lines.push('')
  if (qiankun) {
    lines.push(`运行形态上,它是可独立渲染的前端应用,同时具备 qiankun 子应用生命周期。路由由 \`${routeFile}\` 承载,当前 FactGraph 识别到 ${routeCount} 个 route 节点。`)
  } else {
    lines.push(`运行形态上,它是前端单页应用。路由由 \`${routeFile}\` 承载,当前 FactGraph 识别到 ${routeCount} 个 route 节点。`)
  }
  lines.push('')
  if (frameworks.length) {
    lines.push(`技术栈主要是 ${frameworks.join('、')}。${scripts.length ? `常用脚本: ${scripts.map(item => `\`${item}\``).join(', ')}。` : ''}`)
    lines.push('')
  }
  if (devPort || proxies.length) {
    const proxyText = proxies.length ? `本地代理: ${proxies.map(item => `\`${item.from}\` -> \`${item.target}\``).join(', ')}。` : ''
    lines.push(`${devPort ? `开发服务默认端口是 \`${devPort}\`。` : ''}${proxyText}`)
    lines.push('')
  }
  if (viewGroups.length) {
    lines.push('主要业务模块按 `src/views` 目录聚合如下:')
    lines.push('')
    lines.push(markdownTable(['模块目录', '文件数', '说明'], viewGroups.map(item => [`src/views/${item.name}`, item.count, item.description || item.name])))
    lines.push('')
  }
  if (baseUrls.length || /serviceFactory|axios|injectRequest/.test(httpText)) {
    const baseText = baseUrls.length ? `默认 baseUrl: ${baseUrls.map(item => `\`${item}\``).join(', ')}。` : ''
    const lowCodeText = /injectRequest/.test(mainText) ? '低代码 renderer 通过 `injectRequest(...)` 注入请求能力。' : ''
    lines.push(`数据访问集中在 \`src/api\` 与统一请求封装中。${baseText}${lowCodeText}`)
    lines.push('')
  }
  const permissionSummary = detectPermissionSummary(permissionText)
  if (permissionSummary) {
    lines.push(permissionSummary)
    lines.push('')
  }
  lines.push('阅读代码时建议从这些入口进入:')
  lines.push('')
  lines.push(markdownTable(['入口', '用途'], overviewEntryRows(inventory)))
  return lines.join('\n')
}

function renderBackendProjectOverview(inventory, factGraph, repoProfile = null) {
  const repoPath = inventory.repo?.path || factGraph.repo?.path || ''
  const repoName = inventory.repo?.name || factGraph.repo?.name || path.basename(repoPath)
  const manifests = inventory.manifests || []
  const frameworks = (repoProfile?.frameworks || []).map(item => item.name).filter(Boolean)
  const buildSystems = (repoProfile?.buildSystems || []).length ? repoProfile.buildSystems : manifests
  const routeCount = Object.values(factGraph.nodes || {}).filter(node => node.type === 'route').length
  const runtimeFiles = backendRuntimeFiles(inventory)
  const entryRows = backendOverviewEntryRows(inventory)
  const moduleRows = buildSystems
    .filter(item => item.type === 'maven')
    .slice(0, 8)
    .map(item => [item.path || 'pom.xml', item.name || '-', item.packaging || '-'])
  const lines = []

  lines.push('## 2. 项目概览')
  lines.push('')
  lines.push(`\`${repoName}\` 是以 ${repoProfile?.primaryLanguage || '后端语言'} 为主的后端仓库。L0 scout 将它识别为 \`${repoProfile?.repoKind || 'backend'}\`${frameworks.length ? `, 主要技术迹象包括 ${frameworks.map(item => `\`${item}\``).join('、')}` : ''}。`)
  lines.push('')
  if (buildSystems.length) {
    lines.push(`构建与模块边界来自 manifest: ${buildSystems.slice(0, 5).map(item => `\`${item.path || item.type}\``).join('、')}。当前 FactGraph 识别到 ${routeCount} 个 route 节点。`)
    lines.push('')
  }
  if (moduleRows.length) {
    lines.push('Maven 模块/构建文件:')
    lines.push('')
    lines.push(markdownTable(['manifest', 'artifact/module', 'packaging'], moduleRows))
    lines.push('')
  }
  if (runtimeFiles.length) {
    lines.push('运行配置和容器入口优先从这些文件确认:')
    lines.push('')
    lines.push(markdownTable(['文件', '用途'], runtimeFiles.map(file => [file.path, backendFilePurpose(file.path)])))
    lines.push('')
  }
  if (entryRows.length) {
    lines.push('阅读代码时建议从这些后端入口进入:')
    lines.push('')
    lines.push(markdownTable(['入口', '用途'], entryRows))
  }
  return lines.join('\n')
}

function detectFrameworks(packageJson) {
  const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) }
  const names = []
  if (deps.vue) names.push(`Vue ${cleanVersion(deps.vue)}`)
  if (deps.react) names.push(`React ${cleanVersion(deps.react)}`)
  if (deps['@vue/cli-service']) names.push(`Vue CLI ${cleanVersion(deps['@vue/cli-service'])}`)
  if (deps['vue-router']) names.push(`Vue Router ${cleanVersion(deps['vue-router'])}`)
  if (deps.vuex) names.push(`Vuex ${cleanVersion(deps.vuex)}`)
  if (deps.typescript) names.push(`TypeScript ${cleanVersion(deps.typescript)}`)
  if (deps['ant-design-vue']) names.push(`Ant Design Vue ${cleanVersion(deps['ant-design-vue'])}`)
  if (deps['element-ui']) names.push(`Element UI ${cleanVersion(deps['element-ui'])}`)
  if (deps['@yeepay/lowcode-renderer']) names.push(`@yeepay/lowcode-renderer ${cleanVersion(deps['@yeepay/lowcode-renderer'])}`)
  if (deps.tailwindcss) names.push(`Tailwind CSS ${cleanVersion(deps.tailwindcss)}`)
  return names
}

function cleanVersion(value) {
  return String(value || '').replace(/^[~^]/, '')
}

function topViewGroups(inventory, readme) {
  const descriptions = parseReadmeModuleDescriptions(readme)
  const counts = new Map()
  for (const file of inventory.files || []) {
    const parts = String(file.path || '').split('/')
    if (parts[0] === 'src' && parts[1] === 'views' && parts[2]) counts.set(parts[2], (counts.get(parts[2]) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, description: descriptions.get(name) || '' }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function parseReadmeModuleDescriptions(readme) {
  const descriptions = new Map()
  for (const match of String(readme || '').matchAll(/(?:├|└|│|\s|-)*([A-Za-z0-9_-]+)\s+#\s*(.+)$/gm)) {
    descriptions.set(match[1], match[2].trim())
  }
  return descriptions
}

function detectMountTarget(mainText, htmlText, factGraph) {
  const mainMount = matchFirst(mainText, /\$mount\([^)]*['"](#[-A-Za-z0-9_]+)['"]/)
  if (mainMount) return mainMount
  const edge = Object.values(factGraph.edges || {}).find(item => item.predicate === 'contains' && /root mount element/.test(String(item.object || '')))
  const edgeMount = matchFirst(edge?.object || '', /(#[-A-Za-z0-9_]+)/)
  if (edgeMount) return edgeMount
  const htmlId = matchFirst(htmlText, /<div[^>]+id=['"]([^'"]+)['"]/i)
  return htmlId ? `#${htmlId}` : ''
}

function detectProxyTargets(vueConfig) {
  const proxies = []
  for (const match of String(vueConfig || '').matchAll(/['"]([^'"]+\/)['"]\s*:\s*\{[\s\S]{0,260}?target:\s*['"]([^'"]+)['"]/g)) {
    proxies.push({ from: match[1], target: match[2] })
  }
  return proxies.slice(0, 6)
}

function detectPermissionSummary(textValue) {
  const parts = []
  if (/SHRIOSESSIONID/.test(textValue) || /setTokenFromUrl|urlToken/.test(textValue)) parts.push('会话 token 来自 URL 或 cookie')
  if (/permissionIds/.test(textValue)) parts.push('按钮权限 ID 写入 Vuex')
  if (/hasPermission/.test(textValue)) parts.push('页面按钮可通过 `v-hasPermission` 控制')
  if (/checkPermission/.test(textValue)) parts.push('代码内可通过 `checkPermission(ids)` 判断')
  if (!parts.length) return ''
  return `权限链: ${parts.join('; ')}。`
}

function overviewEntryRows(inventory) {
  const candidates = [
    ['src/main.ts', '应用入口、生命周期、全局组件、请求注入'],
    ['src/main.js', '应用入口、生命周期、全局组件、请求注入'],
    ['src/router/customRouter.js', '业务路由总表,从 URL 反查页面的第一入口'],
    ['src/router/index.js', 'Router 实例、基础路由、全局路由钩子'],
    ['src/App.vue', '应用壳、keep-alive、父应用状态接入'],
    ['src/utils/http.js', '统一请求封装、成功码、错误处理'],
    ['src/utils/request.js', '统一请求封装、成功码、错误处理'],
    ['src/store/modules/permission.js', '菜单与按钮权限状态'],
    ['src/directive/permission/hasPermission.js', '按钮级权限指令'],
  ]
  const rows = []
  for (const [file, purpose] of candidates) {
    if (inventoryHasFile(inventory, file)) rows.push([file, purpose])
  }
  if ((inventory.files || []).some(file => String(file.path || '').startsWith('src/api/'))) rows.push(['src/api/*.js', '按业务域拆分的接口调用'])
  return rows.slice(0, 10)
}

function backendRuntimeFiles(inventory) {
  return (inventory.files || [])
    .filter(file => !file.protected)
    .filter(file => /(^|\/)(pom\.xml|web\.xml|application\.(properties|ya?ml)|bootstrap\.(properties|ya?ml))$|runtimecfg|(^|\/)(config|conf)(\/|$)/i.test(file.path))
    .slice(0, 12)
}

function backendOverviewEntryRows(inventory) {
  const patterns = [
    [/SpringBootApplication|Application\.java$/i, '应用启动入口或 Spring Boot 装配入口'],
    [/Controller\.java$|Resource\.java$|Handler\.java$/i, 'HTTP/API 或请求处理入口'],
    [/Service\.java$|BizImpl\.java$|Facade.*\.java$/i, '业务服务和 facade 实现'],
    [/Mapper\.java$|Dao\.java$|Repository\.java$/i, '数据访问接口'],
    [/web\.xml$/i, 'Servlet 容器配置'],
    [/runtimecfg\/.*\.properties$/i, '运行期组件初始化配置'],
    [/pom\.xml$/i, 'Maven 构建与模块依赖'],
  ]
  const rows = []
  for (const [pattern, purpose] of patterns) {
    const file = (inventory.files || []).find(item => pattern.test(item.path) && !item.protected)
    if (file) rows.push([file.path, purpose])
  }
  return rows.slice(0, 10)
}

function backendFilePurpose(filePath) {
  if (/pom\.xml$/.test(filePath)) return 'Maven 构建、模块和依赖'
  if (/web\.xml$/.test(filePath)) return 'Servlet 容器配置'
  if (/runtimecfg/i.test(filePath)) return '运行期组件初始化或框架约定配置'
  if (/application\.(properties|ya?ml)$|bootstrap\.(properties|ya?ml)$/i.test(filePath)) return '应用启动配置'
  return '后端运行配置'
}

function renderPredicateSamples(validation) {
  const rates = validation.stats?.predicateSamplePassRates || {}
  const rows = Object.entries(rates).map(([predicate, stat]) => [
    predicate,
    `${stat.passed}/${stat.sampled}`,
    stat.passRate,
    stat.sampleSeed,
  ])
  const lines = [markdownTable(['predicate', 'passed/sample', 'passRate', 'sampleSeed'], rows)]
  const failures = validation.stats?.predicateSampleFailures || []
  if (failures.length) {
    lines.push('')
    lines.push('### 抽检失败样本')
    lines.push('')
    lines.push(markdownTable(['edge', 'predicate', 'reason'], failures.map(item => [item.edgeId, item.predicate, item.reason])))
  }
  return lines.join('\n')
}

function renderDynamicFactSamples(analysis) {
  const facts = (analysis.facts || []).slice(0, 16)
  return markdownTable(['subject', 'predicate', 'object', 'confidence', 'evidence'], facts.map(fact => [
    fact.subject,
    fact.predicate,
    fact.object,
    fact.confidence,
    formatEvidenceRefs(fact.evidence),
  ]))
}

function renderImportantFiles(factGraph) {
  const rows = Object.values(factGraph.nodes || {})
    .filter(node => node.type === 'file')
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, 12)
    .map(node => [node.path, node.lang || node.metadata?.language || '', roundMetric(node.importance)])
  return markdownTable(['file', 'lang', 'importance'], rows)
}

function artifactRows(packageDir) {
  const artifacts = [
    ['fact graph', 'fact-graph.json'],
    ['gap queue', 'gap-queue.json'],
    ['verification', 'verification.json'],
    ['render graph', 'render-graph.json'],
    ['knowledge jsonl', 'knowledge-index.jsonl'],
    ['wiki', 'wiki/README.md'],
    ['exploration analysis', 'analyses/repo-exploration.json'],
    ['evidence bundle', 'exploration/evidence-bundle.md'],
    ['validation', 'validation.json'],
  ]
  return artifacts
    .map(([name, rel]) => [name, path.join(packageDir, rel)])
    .filter(([, file]) => fs.existsSync(file))
}

function sortedCountRows(values, keyFn) {
  const counts = new Map()
  for (const value of values || []) {
    const key = keyFn(value) || 'unknown'
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
}

function sourceFileCount(inventory) {
  return (inventory.files || []).filter(file => file.category === 'source').length
}

function repoGitSummary(factGraph) {
  const root = factGraph.nodes?.['module:.'] || Object.values(factGraph.nodes || {}).find(node => node.type === 'module' && node.path === '.')
  const git = root?.metadata?.git
  return git ? `${git.branch || 'unknown'} / ${git.head || 'unknown'}` : 'unknown'
}

function readRepoJson(repoPath, rel, inventory) {
  const textValue = readRepoText(repoPath, rel, inventory)
  if (!textValue) return null
  try {
    return JSON.parse(textValue)
  } catch {
    return null
  }
}

function readRepoText(repoPath, rel, inventory) {
  if (!repoPath || !rel || !inventoryHasReadableFile(inventory, rel)) return ''
  const full = path.resolve(repoPath, rel)
  const root = path.resolve(repoPath)
  if (!(full === root || full.startsWith(`${root}${path.sep}`)) || !fs.existsSync(full)) return ''
  return fs.readFileSync(full, 'utf8')
}

function readFirstExistingRepoText(repoPath, rels, inventory) {
  for (const rel of rels.filter(Boolean)) {
    const textValue = readRepoText(repoPath, rel, inventory)
    if (textValue) return textValue
  }
  return ''
}

function readFirstMatchingRepoText(repoPath, inventory, pattern) {
  const file = (inventory.files || []).find(item => pattern.test(String(item.path || '')) && !item.protected)
  return file ? readRepoText(repoPath, file.path, inventory) : ''
}

function firstExistingRepoFile(inventory, rels) {
  return rels.filter(Boolean).find(rel => inventoryHasReadableFile(inventory, rel)) || ''
}

function inventoryHasFile(inventory, rel) {
  return (inventory.files || []).some(file => file.path === rel)
}

function inventoryHasReadableFile(inventory, rel) {
  return (inventory.files || []).some(file => file.path === rel && !file.protected && file.contentAnalyzable !== false && file.binary !== true)
}

function firstMarkdownHeading(textValue) {
  const match = String(textValue || '').match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : ''
}

function matchFirst(textValue, regex) {
  const match = String(textValue || '').match(regex)
  return match ? match[1] : ''
}

function formatEvidenceRefs(evidence) {
  const refs = (evidence || []).slice(0, 2).map(item => item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '').filter(Boolean)
  return refs.join('<br>')
}

function roundMetric(value) {
  if (typeof value !== 'number') return value ?? ''
  return Math.round(value * 1000) / 1000
}

function markdownTable(headers, rows) {
  const safeRows = rows && rows.length ? rows : [['None', '']]
  const normalizedRows = safeRows.map(row => headers.map((_, index) => markdownCell(row[index])))
  return [
    `| ${headers.map(markdownCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...normalizedRows.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
}

function markdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

function buildIncrementalPlan(repoPath, base, previousFactGraph, previousCodeMap) {
  const changedFiles = gitChangedFiles(repoPath, base)
  const invalidatedNodeIds = changedFiles.map(file => `file:${file}`)
  const relatedEdgeIds = previousFactGraph
    ? Object.values(previousFactGraph.edges || {})
      .filter(edge => invalidatedNodeIds.includes(edge.subject) || invalidatedNodeIds.includes(edge.object) || (edge.evidence || []).some(item => changedFiles.includes(item.file)))
      .map(edge => edge.id)
    : []
  return {
    schemaVersion: 'repo-incremental-plan/v1',
    generatedAt: new Date().toISOString(),
    mode: previousFactGraph && previousCodeMap ? 'affected-subgraph' : 'full-bootstrap',
    base,
    changedFiles,
    invalidatedNodeIds,
    relatedEdgeIds,
    previousRepoId: previousFactGraph?.repoId || null,
    previousFactGraph,
    previousCodeMap,
  }
}

function writeIncrementalReport(outDir, plan, factGraph) {
  const report = {
    schemaVersion: plan.schemaVersion,
    generatedAt: plan.generatedAt,
    mode: plan.mode,
    base: plan.base,
    changedFiles: plan.changedFiles,
    invalidatedNodeIds: plan.invalidatedNodeIds,
    relatedEdgeIds: plan.relatedEdgeIds,
    previousRepoId: plan.previousRepoId,
    newRepoId: factGraph.repoId,
    reusedNodeCount: factGraph.quality?.incremental?.reusedNodeCount || 0,
    reusedEdgeCount: factGraph.quality?.incremental?.reusedEdgeCount || 0,
    rescannedFileCount: plan.changedFiles.length,
  }
  fs.writeFileSync(path.join(outDir, 'incremental.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function gitChangedFiles(repoPath, base) {
  const res = spawnSync('git', ['diff', '--name-only', base, '--'], { cwd: repoPath, encoding: 'utf8', timeout: 5000 })
  if (res.status !== 0) return []
  return res.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

function search(res, packageDir, query) {
  const needle = query.trim().toLowerCase()
  if (!needle) return json(res, { query, chunks: [] })
  const chunks = fs.readFileSync(path.join(packageDir, 'knowledge-index.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(chunk => String(chunk.text || '').toLowerCase().includes(needle) || String(chunk.id || '').toLowerCase().includes(needle))
    .slice(0, 50)
  return json(res, { query, chunks })
}

function serveWiki(res, packageDir, pathname) {
  const rel = decodeURIComponent(pathname.replace(/^\/+/, ''))
  const full = path.resolve(packageDir, rel)
  const wikiRoot = path.resolve(packageDir, 'wiki')
  if (!(full === wikiRoot || full.startsWith(`${wikiRoot}${path.sep}`))) return json(res, { error: 'outside wiki root' }, 403)
  return text(res, fs.readFileSync(full, 'utf8'), 'text/markdown; charset=utf-8')
}

function parseExplorerFilter(value) {
  if (!value) return null
  return new Set(String(value).split(',').map(item => item.trim()).filter(Boolean))
}

function readAnalysisInput(file) {
  return JSON.parse(file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8'))
}

function schemaIssuesFromError(err) {
  const message = String(err?.message || err)
  const lines = message.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const bulletLines = lines
    .filter(line => line.startsWith('- '))
    .map(line => line.replace(/^-\s+/, ''))
  const issues = bulletLines.length ? bulletLines : [message]
  return issues.map((issue, index) => ({ code: 'schema-validation', index, message: issue }))
}

function readDispatchHistory(packageDir) {
  const dispatchRoot = path.join(packageDir, 'exploration', 'dispatch')
  if (!fs.existsSync(dispatchRoot)) return []
  return fs.readdirSync(dispatchRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^round-\d+$/.test(entry.name))
    .map(entry => {
      const manifestPath = path.join(dispatchRoot, entry.name, 'manifest.json')
      const manifest = readJsonIfExists(manifestPath)
      return manifest
        ? {
            round: manifest.round,
            manifestPath,
            taskIds: (manifest.explorers || []).flatMap(explorer => explorer.taskIds || []),
          }
        : null
    })
    .filter(Boolean)
}

function countTasksBy(tasks, keyFn) {
  const counts = {}
  for (const task of tasks || []) {
    const key = keyFn(task)
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function nextDispatchRound(packageDir) {
  const rounds = readDispatchHistory(packageDir).map(item => Number(item.round)).filter(Number.isFinite)
  return rounds.length ? Math.max(...rounds) + 1 : 1
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function safeFileName(value) {
  return String(value || 'bundle').replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function schemaPathForExplorer(explorer) {
  const schemaName = explorer === EXPLORER.adversarialVerify
    ? 'verification.schema.json'
    : 'explorer-output.schema.json'
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schemas', schemaName)
}

function renderDispatchBundleMarkdown({ packageDir, repo, round, explorer, tasks, tokenBudget, effort, outputPath, schemaPath, body }) {
  const ingestCommand = `npm run --silent understanding:harness -- ingest --package ${JSON.stringify(packageDir)} --analysis ${JSON.stringify(outputPath)} --explorer ${explorer} --round ${round}`
  const schema = readJson(schemaPath)
  return [
    `# Repo Understanding Dispatch Bundle`,
    '',
    `Explorer: \`${explorer}\``,
    `Round: \`${round}\``,
    `Package: \`${packageDir}\``,
    `Repo: \`${repo?.path || ''}\``,
    `Token budget: \`${tokenBudget}\``,
    `Effort: \`${effort || 'medium'}\``,
    `Output JSON: \`${outputPath}\``,
    `Schema: \`${schemaPath}\``,
    '',
    '## Contract',
    '',
    '- Read the target repository only. Do not install, build, test, start servers, edit files, or access the network.',
    '- Write exactly one JSON file to the output path above.',
    '- After writing JSON, return control to the orchestrator or run the ingest command below if you are the assigned worker.',
    '- Protected files are metadata-only. Do not read or quote protected contents.',
    '- Evidence snippets must be at most 3 lines.',
    '',
    '## Ingest Command',
    '',
    '```bash',
    ingestCommand,
    '```',
    '',
    '## Output Schema',
    '',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    '',
    '## Task Count',
    '',
    String(tasks.length),
    '',
    body,
    '',
  ].join('\n')
}

function isVerificationOutput(value, explorer) {
  return explorer === EXPLORER.adversarialVerify
    || value?.schemaVersion === 'repo-adversarial-verification/v1'
    || (Array.isArray(value?.verdicts) && !Array.isArray(value?.facts))
}

function verifierOutputToExplorationAnalysis(value, provenance = {}) {
  const verdicts = normalizeVerifierVerdicts(value.verdicts || [])
  if (!verdicts.length) {
    throw new Error('Verifier output failed schema validation:\n- verdicts must contain at least one item')
  }
  const skipped = verdicts.filter(item => item.verdict === 'skipped')
  const refuted = verdicts.filter(item => item.verdict === 'refuted')
  return {
    schemaVersion: 'repo-exploration-analysis/v1',
    generatedAt: value.generatedAt || new Date().toISOString(),
    strategy: value.strategy || `Adversarial verification for round ${provenance.round || 'manual'}`,
    facts: [],
    openQuestions: [
      ...skipped.map(item => ({
        question: `Verifier marked ${item.edgeId} insufficient: ${item.reason}`,
        relatedNodes: [item.edgeId],
        raisedBy: EXPLORER.adversarialVerify,
      })),
      ...refuted.map(item => ({
        question: `Verifier refuted ${item.edgeId}: ${item.reason}`,
        relatedNodes: [item.edgeId],
        raisedBy: EXPLORER.adversarialVerify,
      })),
    ],
    observations: [],
    requestedEvidence: { files: [], searches: [] },
    gaps: [],
    verdicts,
  }
}

function normalizeVerifierVerdicts(values) {
  const issues = []
  const verdicts = (Array.isArray(values) ? values : []).map((item, index) => {
    const verdict = item.verdict === 'insufficient' ? 'skipped' : item.verdict
    if (!item.edgeId) issues.push(`verdicts[${index}].edgeId is required`)
    if (!['not-refuted', 'refuted', 'skipped'].includes(verdict)) issues.push(`verdicts[${index}].verdict is invalid: ${item.verdict || 'missing'}`)
    if (!item.reason) issues.push(`verdicts[${index}].reason is required`)
    return {
      edgeId: item.edgeId,
      verdict,
      reason: String(item.reason || ''),
      evidenceChecked: Number.isFinite(Number(item.evidenceChecked)) ? Number(item.evidenceChecked) : undefined,
      checkedAt: item.checkedAt || new Date().toISOString(),
      tool: item.tool || 'repo-fact-verifier',
    }
  })
  if (issues.length) {
    throw new Error(`Verifier output failed schema validation:\n${issues.map(issue => `- ${issue}`).join('\n')}`)
  }
  return verdicts
}

function readPackageState(packageDir) {
  return {
    inventory: readJson(path.join(packageDir, 'static', 'inventory.json')),
    repoProfile: readJsonIfExists(path.join(packageDir, 'repo-profile.json')) || readJsonIfExists(path.join(packageDir, 'static', 'repo-profile.json')),
    scanPolicy: readJsonIfExists(path.join(packageDir, 'scan-policy.json')) || readJsonIfExists(path.join(packageDir, 'static', 'scan-policy.json')),
    factGraph: readJson(path.join(packageDir, 'fact-graph.json')),
    gapQueue: readJson(path.join(packageDir, 'gap-queue.json')),
  }
}

function buildExplorerDispatch(packageDir, state, maxTasks, explorerFilter = null, explorerConfig = {}) {
  const tasks = executableGapTasks(state.gapQueue, explorerConfig)
    .filter(task => !explorerFilter || explorerFilter.has(task.explorer))
    .slice(0, maxTasks)
  const byExplorer = new Map()
  for (const task of tasks) {
    const list = byExplorer.get(task.explorer) || []
    list.push(task)
    byExplorer.set(task.explorer, list)
  }
  return {
    schemaVersion: 'repo-explorer-dispatch/v1',
    generatedAt: new Date().toISOString(),
    packageDir,
    repo: state.inventory.repo,
    taskCount: tasks.length,
    explorers: [...byExplorer.entries()].map(([explorer, explorerTasks]) => ({
      explorer,
      tasks: explorerTasks,
      tokenBudget: explorerTasks.reduce((sum, task) => sum + (task.tokenBudget || 0), 0),
      effort: explorerEffort(explorer, explorerConfig),
      prompt: explorer === EXPLORER.adversarialVerify
        ? renderVerifierPrompt(explorerTasks, state.factGraph)
        : renderExplorerPrompt(explorer, explorerTasks, state.factGraph, state.repoProfile, state.scanPolicy),
    })),
  }
}

function executableGapTasks(gapQueue, explorerConfig = {}) {
  return candidateExecutableGapTasks(gapQueue)
    .filter(task => explorerEnabled(task.explorer, explorerConfig))
}

function candidateExecutableGapTasks(gapQueue) {
  return (gapQueue.tasks || [])
    .filter(task => task.status === 'open')
    .filter(task => EXECUTABLE_GAP_TYPES.has(task.type))
    .filter(task => task.explorer)
}

function renderExplorerPrompt(explorer, tasks, factGraph, repoProfile = null, scanPolicy = null) {
  const relatedIds = new Set(tasks.flatMap(task => task.relatedNodes || []))
  const nodes = [...relatedIds].filter(id => factGraph.nodes?.[id]).map(id => factGraph.nodes[id])
  const edges = [...relatedIds].filter(id => factGraph.edges?.[id]).map(id => factGraph.edges[id])
  return [
    `You are the ${explorer} repo explorer.`,
    'Return JSON only using schemaVersion "repo-exploration-analysis/v1".',
    'Do not modify files, install dependencies, run builds, or access the network.',
    'Explore read-only with rg, find, sed -n, nl -ba, and other non-mutating commands.',
    'Output facts[] triples only when evidence is concrete. Put uncertainty in openQuestions[].',
    '',
    'L0 repo scout profile:',
    JSON.stringify(repoProfile || {}, null, 2),
    '',
    'L0 scan policy:',
    JSON.stringify(scanPolicy || {}, null, 2),
    '',
    'Tasks:',
    JSON.stringify(tasks, null, 2),
    '',
    'Related FactGraph nodes:',
    JSON.stringify(nodes, null, 2),
    '',
    'Related FactGraph edges:',
    JSON.stringify(edges, null, 2),
    '',
    'Required JSON shape:',
    JSON.stringify({
      schemaVersion: 'repo-exploration-analysis/v1',
      strategy: 'short read-only exploration strategy',
      facts: [],
      openQuestions: [],
      observations: [],
      requestedEvidence: { files: [], searches: [] },
      gaps: [],
    }, null, 2),
  ].join('\n')
}

function renderVerifierPrompt(tasks, factGraph) {
  const relatedIds = new Set(tasks.flatMap(task => task.relatedNodes || []))
  const edges = [...relatedIds].filter(id => factGraph.edges?.[id]).map(id => factGraph.edges[id])
  return [
    'You are the adversarial repo fact verifier.',
    'Return JSON only using schemaVersion "repo-adversarial-verification/v1".',
    'Your job is to try to refute each edge from the evidence. Do not use the explorer reasoning that produced the edge.',
    'Read the target repository only. Do not modify files, install dependencies, run builds, or access the network.',
    'Use verdict "refuted" when the evidence does not support the triple, "not-refuted" when the cited code supports it, and "skipped" when evidence is insufficient.',
    '',
    'Tasks:',
    JSON.stringify(tasks, null, 2),
    '',
    'Edges to verify:',
    JSON.stringify(edges, null, 2),
    '',
    'Required JSON shape:',
    JSON.stringify({
      schemaVersion: 'repo-adversarial-verification/v1',
      generatedAt: new Date().toISOString(),
      checkedEdges: edges.length,
      confirmedEdges: 0,
      removedEdges: 0,
      skippedEdges: 0,
      verdicts: [
        {
          edgeId: 'edge:...',
          verdict: 'not-refuted|refuted|skipped',
          reason: 'one sentence grounded in the evidence',
          evidenceChecked: 1,
        },
      ],
    }, null, 2),
  ].join('\n')
}

function codexAvailable() {
  const result = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 })
  return result.status === 0
}

function runCodexExplorer(repoPath, prompt, schemaPath = schemaPathForExplorer('repo-explorer')) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-harness-explore-'))
  const outFile = path.join(tmpDir, 'explorer-output.json')
  const result = spawnSync('codex', [
    'exec',
    '-C', repoPath,
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--output-schema', schemaPath,
    '-o', outFile,
    '--ephemeral',
    prompt,
  ], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 })
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `codex exited ${result.status}`).trim().slice(0, 1200) }
  }
  try {
    const outputText = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : result.stdout
    return { ok: true, analysis: sanitizeExplorerOutput(JSON.parse(outputText)) }
  } catch (err) {
    return { ok: false, error: `invalid JSON output: ${err.message}` }
  }
}

function sanitizeExplorerOutput(value) {
  const copy = {
    ...value,
    facts: Array.isArray(value.facts) ? value.facts.map(sanitizeExplorerFact) : [],
    verdicts: Array.isArray(value.verdicts) ? value.verdicts : [],
  }
  return copy
}

function sanitizeExplorerFact(fact) {
  return {
    ...fact,
    evidence: Array.isArray(fact.evidence) ? fact.evidence.map(item => ({
      ...item,
      endLine: Number(item.endLine) >= Number(item.line) ? item.endLine : item.line,
      snippet: trimExplorerSnippet(item.snippet ?? item.text),
    })) : [],
  }
}

function trimExplorerSnippet(value) {
  return String(value || '').split(/\r?\n/).slice(0, 3).join('\n')
}

function printSkillExplorerFallback(packageDir, dispatch) {
  console.error('codex runner is unavailable. Use the runtime-neutral skill flow instead:')
  console.error(`  npm run --silent understanding:harness -- dispatch --package ${JSON.stringify(packageDir)}`)
  console.error('Then process each manifest explorer bundle with repo-explorer or repo-fact-verifier, write the requested output JSON, and ingest it:')
  console.error(`  npm run --silent understanding:harness -- ingest --package ${JSON.stringify(packageDir)} --analysis <bundle.output.json> --explorer <name> --round <round>`)
  console.error(`Open executable tasks available: ${dispatch.taskCount}`)
}

function markDispatchedTasks(packageDir, tasks, round, explorer, bundle = {}) {
  const gapPath = path.join(packageDir, 'gap-queue.json')
  const gapQueue = readJson(gapPath)
  const taskIds = new Set(tasks.map(task => task.id))
  const dispatchedAt = new Date().toISOString()
  gapQueue.tasks = (gapQueue.tasks || []).map(task => {
    if (!taskIds.has(task.id)) return task
    return {
      ...task,
      status: 'dispatched',
      dispatch: {
        round,
        explorer,
        dispatchedAt,
        promptPath: bundle.promptPath,
        outputPath: bundle.outputPath,
        schemaPath: bundle.schemaPath,
      },
    }
  })
  gapQueue.openTaskCount = gapQueue.tasks.filter(task => task.status === 'open').length
  gapQueue.dispatchedTaskCount = gapQueue.tasks.filter(task => task.status === 'dispatched').length
  gapQueue.doneTaskCount = gapQueue.tasks.filter(task => task.status === 'done').length
  gapQueue.updatedAt = dispatchedAt
  fs.writeFileSync(gapPath, `${JSON.stringify(gapQueue, null, 2)}\n`, 'utf8')
}

function parseUntilCoverage(value, fallbackThreshold) {
  if (!value) return null
  if (value === true) {
    const threshold = Number(fallbackThreshold)
    if (!Number.isFinite(threshold)) usage()
    return threshold
  }
  const threshold = Number(value)
  if (!Number.isFinite(threshold)) usage()
  return threshold
}

function openQuestionAnalysis(packageDir, text, taskIdsValue) {
  const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
  const question = String(text || '').trim()
  if (!question) throw new Error('--open-question must not be empty')
  const relatedNodes = String(taskIdsValue || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  return {
    schemaVersion: 'repo-exploration-analysis/v1',
    repo: inventory.repo,
    strategy: 'open-question ingest primitive',
    facts: [],
    openQuestions: [{
      question,
      relatedNodes,
      raisedBy: 'harness-open-question',
    }],
    observations: [],
    requestedEvidence: { files: [], searches: [] },
    gaps: [],
  }
}

function emptyExplorationAnalysis(repo) {
  return {
    schemaVersion: 'repo-exploration-analysis/v1',
    repo: { name: repo.name, path: repo.path },
    strategy: '',
    facts: [],
    openQuestions: [],
    observations: [],
    requestedEvidence: { files: [], searches: [] },
    gaps: [],
    verdicts: [],
  }
}

function mergeExplorationAnalyses(base, next, strategyNote) {
  return {
    ...emptyExplorationAnalysis(base.repo || next.repo || {}),
    ...base,
    strategy: [base.strategy, next.strategy, strategyNote].filter(Boolean).join('\n'),
    facts: dedupeBy([...(base.facts || []), ...(next.facts || [])], item => JSON.stringify([item.subject, item.predicate, item.object, item.evidence])),
    openQuestions: dedupeBy([...(base.openQuestions || []), ...(next.openQuestions || [])], item => `${item.question}:${(item.relatedNodes || []).join('|')}`),
    observations: [...(base.observations || []), ...(next.observations || [])],
    requestedEvidence: {
      files: dedupeBy([...(base.requestedEvidence?.files || []), ...(next.requestedEvidence?.files || [])], item => `${item.path}:${JSON.stringify(item.ranges || [])}`),
      searches: dedupeBy([...(base.requestedEvidence?.searches || []), ...(next.requestedEvidence?.searches || [])], item => `${item.pattern}:${(item.paths || []).join('|')}`),
    },
    gaps: [...new Set([...(base.gaps || []), ...(next.gaps || [])].map(String).filter(Boolean))],
    verdicts: dedupeBy([...(base.verdicts || []), ...(next.verdicts || [])], item => `${item.edgeId}:${item.verdict}:${item.reason}`),
  }
}

function readHarnessConfig() {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../harness.config.json')
  const config = readJsonIfExists(file) || {}
  assertKnownExplorers(config.explorers || {}, 'harness.config.json explorers')
  return config
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null
  return readJson(file)
}

function dedupeBy(values, keyFn) {
  const seen = new Set()
  const output = []
  for (const value of values || []) {
    const key = keyFn(value)
    if (seen.has(key)) continue
    seen.add(key)
    output.push(value)
  }
  return output
}

function fileJson(res, file) {
  return text(res, fs.readFileSync(file, 'utf8'), 'application/json; charset=utf-8')
}

function json(res, body, status = 200) {
  return text(res, JSON.stringify(body, null, 2), 'application/json; charset=utf-8', status)
}

function text(res, body, contentType, status = 200) {
  res.writeHead(status, { 'content-type': contentType })
  res.end(body)
}

function parseArgs(argv, required) {
  let args
  try {
    args = parseCommonArgs(argv, required)
  } catch (err) {
    console.error(err.message)
    usage()
  }
  if (args.help) usage()
  return args
}

main()
