#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  installClosedJourney,
  installSemanticContracts,
  writeAcceptedNodeSemanticFixtureResults,
  writeFailedWorkResult,
  writeSatisfiedWorkResult,
} from '../helpers/v3-workflow-fixture.mjs'
import { appendRunEvent } from '../../packages/repo-understanding-kernel/src/workflow/workflow-store.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const harnessScript = path.join(repoRoot, 'packages', 'repo-understanding-cli', 'src', 'cli.mjs')
const fixtureRepo = path.join(repoRoot, 'evals', 'fixtures', 'react-mini-repo')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-v3-behavioral-eval-'))

try {
  assertFailedWorkerBlocksAndRetryRecovers()
  assertRejectedNonBlockingContractRemainsPending()
  assertExplicitWaiverCompletesContract()
  assertLegacyPackageAnalyzeFailsClosed()
  assertSnapshotMismatchRejected()
  assertSnapshotTransitionArchives()
  assertEventTamperDetected()
  console.log(JSON.stringify({
    schemaVersion: 'repo-behavioral-eval/v3',
    passed: true,
    checked: [
      'workflow:failed-worker-blocks',
      'workflow:result-before-ingest',
      'workflow:retry-new-attempt',
      'workflow:rejected-nonblocking-contract-remains-pending',
      'workflow:explicit-waiver-completes-contract',
      'workflow:legacy-package-requires-fresh-output',
      'debug:usage-unavailable-explicit',
      'snapshot:mismatch-rejected',
      'snapshot:transition-archives-old-run',
      'snapshot:in-flight-transition-rejected',
      'event-chain:tamper-detected',
    ],
  }, null, 2))
  fs.rmSync(workDir, { recursive: true, force: true })
} catch (error) {
  console.error(error.stack || error.message || String(error))
  console.error(`Behavioral eval workDir: ${workDir}`)
  process.exitCode = 1
}

function assertFailedWorkerBlocksAndRetryRecovers() {
  const packageDir = path.join(workDir, 'failed-worker-package')
  preparePackage(packageDir)
  const dispatch = runHarnessJson(['dispatch', '--package', packageDir, '--max-tasks', '1'])
  const item = readJson(dispatch.workItems[0].workItemPath)
  runHarnessJson(['trace', '--package', packageDir, '--item', item.itemId, '--event', 'started', '--runtime', 'behavioral-runtime'])
  const failed = writeFailedWorkResult(packageDir, item, { runtime: 'behavioral-runtime' })

  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'ingest', 'failed result must pass through ingest')
  const rejected = runHarnessJson(['ingest', '--package', packageDir, '--work-result', failed.workResultPath], { expectExit: 2 })
  assertEqual(rejected.merged, false, 'failed WorkResult merged')
  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'blocked', 'failed blocking WorkItem must block workflow')

  const retry = runHarnessJson(['retry', '--package', packageDir, '--item', item.itemId])
  assertEqual(retry.schemaVersion, 'repo-work-retry/v3', 'retry schema')
  assertEqual(retry.attempt, 2, 'retry attempt')
  assertEqual(retry.retryOf, item.itemId, 'retryOf')
  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'await-results', 'replacement attempt clears old blocking failure')

  const retryItem = readJson(retry.workItemPath)
  const recovered = writeSatisfiedWorkResult(packageDir, retryItem, { runtime: 'behavioral-runtime' })
  runHarnessJson(['ingest', '--package', packageDir, '--work-result', recovered.workResultPath])
  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'project', 'retry should recover to Product Map projection')

  const debug = runHarnessJson(['debug', '--package', packageDir])
  assertEqual(debug.invocations.issued, 2, 'retry issued trace count')
  assertEqual(debug.invocations.failed, 1, 'failed trace count')
  assertEqual(debug.invocations.completed, 1, 'completion trace count')
  assertEqual(debug.invocations.usageUnavailable, 2, 'terminal invocations must report unavailable usage explicitly')
  assertEqual(debug.aggregateUsage.totalTokens, 0, 'unreported usage must not be estimated')
  assertEqual(debug.knowledgeEfficiency.metricStatus, 'unavailable', 'Claim efficiency stays unavailable without reported tokens')
}

function assertRejectedNonBlockingContractRemainsPending() {
  const packageDir = path.join(workDir, 'rejected-nonblocking-package')
  preparePackage(packageDir, { blocking: false })
  const dispatch = runHarnessJson(['dispatch', '--package', packageDir, '--max-tasks', '1'])
  const item = readJson(dispatch.workItems[0].workItemPath)
  const failed = writeFailedWorkResult(packageDir, item, { runtime: 'behavioral-runtime' })
  runHarnessJson(['ingest', '--package', packageDir, '--work-result', failed.workResultPath], { expectExit: 2 })

  const status = runHarnessJson(['status', '--package', packageDir])
  assert(status.research.pendingContracts.includes(dispatch.workItems[0].contractId), 'rejected non-blocking contract must remain pending')
  assertEqual(status.tasks.open, 1, 'rejected contract open count')
  assertEqual(status.tasks.executableOpen, 0, 'rejected contract requires retry rather than fresh dispatch')
  assertEqual(status.tasks.openDisabled, 1, 'rejected contract disabled-open count')
  assertEqual(status.nextAction, 'blocked', 'rejected non-blocking contract must fail closed')
  const rejected = runHarness(['project', '--package', packageDir, '--only', 'maps'], { expectExit: 1, includeStderr: true })
  assert(/ResearchContracts are pending/i.test(rejected), 'pending rejected contract must block Product Map projection')
}

function assertExplicitWaiverCompletesContract() {
  const packageDir = path.join(workDir, 'waived-contract-package')
  preparePackage(packageDir)
  const dispatch = runHarnessJson(['dispatch', '--package', packageDir, '--max-tasks', '1'])
  const item = readJson(dispatch.workItems[0].workItemPath)
  appendRunEvent(packageDir, 'work-waived', {
    itemId: item.itemId,
    attempt: item.attempt,
    reason: 'Explicit behavioral-eval waiver.',
  }, { actor: 'orchestrator' })

  const status = runHarnessJson(['status', '--package', packageDir])
  assertEqual(status.research.pendingContracts.length, 0, 'waived contract pending count')
  assertEqual(status.tasks.done, 1, 'waived contract completion count')
  assertEqual(status.tasks.skipped, 1, 'waived contract skipped count')
  assertEqual(status.nextAction, 'project', 'explicitly waived contract may advance to projection')
  runHarnessJson(['project', '--package', packageDir, '--only', 'maps'])
}

function assertLegacyPackageAnalyzeFailsClosed() {
  const packageDir = path.join(workDir, 'legacy-v2-package')
  fs.mkdirSync(path.join(packageDir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'state', 'run-state.json'), `${JSON.stringify({ schemaVersion: 'repo-run-state/v2', workItems: {} }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(packageDir, 'gap-queue.json'), '{"schemaVersion":"repo-gap-queue/v2"}\n', 'utf8')

  const rejected = runHarness(['analyze', '--repo', fixtureRepo, '--out', packageDir, '--max-files', '2000'], { expectExit: 1, includeStderr: true })
  assert(/Legacy repo-understanding package detected/i.test(rejected), 'analyze must identify a legacy package before scanning')
  assert(/fresh --out directory/i.test(rejected), 'legacy package rejection must require a fresh output directory')
  assertEqual(fs.existsSync(path.join(packageDir, 'static', 'inventory.json')), false, 'legacy rejection must happen before deterministic artifacts are written')
  assertEqual(readJson(path.join(packageDir, 'state', 'run-state.json')).schemaVersion, 'repo-run-state/v2', 'legacy state must remain untouched')
}

function assertSnapshotMismatchRejected() {
  const packageDir = path.join(workDir, 'snapshot-mismatch-package')
  preparePackage(packageDir)
  const dispatch = runHarnessJson(['dispatch', '--package', packageDir, '--max-tasks', '1'])
  const item = readJson(dispatch.workItems[0].workItemPath)
  const produced = writeSatisfiedWorkResult(packageDir, item, { snapshotId: 'snapshot:wrong' })
  const rejected = runHarnessJson(['ingest', '--package', packageDir, '--work-result', produced.workResultPath], { expectExit: 2 })
  assert(rejected.issues.some(issue => /snapshotId mismatch/.test(issue.message || '')), 'snapshot mismatch issue missing')
  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'blocked', 'snapshot mismatch must block workflow')
}

function assertSnapshotTransitionArchives() {
  const repo = path.join(workDir, 'snapshot-transition-repo')
  fs.cpSync(fixtureRepo, repo, { recursive: true })
  const packageDir = path.join(workDir, 'snapshot-transition-package')
  runHarness(['analyze', '--repo', repo, '--out', packageDir, '--max-files', '2000'])
  const before = readJson(path.join(packageDir, 'state', 'run-state.json'))
  fs.appendFileSync(path.join(repo, 'src', 'App.tsx'), '\n// v3 snapshot transition fixture\n', 'utf8')
  runHarness(['analyze', '--repo', repo, '--out', packageDir, '--max-files', '2000'])
  const after = readJson(path.join(packageDir, 'state', 'run-state.json'))
  assert(before.runId !== after.runId, 'snapshot transition must create a new runId')
  assert(before.snapshotId !== after.snapshotId, 'snapshot transition must create a new snapshotId')
  const archiveDir = path.join(packageDir, 'store', 'runs', safeId(before.runId))
  assert(fs.existsSync(path.join(archiveDir, 'run-events.jsonl')), 'snapshot transition must archive prior event stream')
  assert(fs.existsSync(path.join(archiveDir, 'transition.json')), 'snapshot transition metadata missing')

  installSemanticContracts(packageDir)
  const dispatch = runHarnessJson(['dispatch', '--package', packageDir, '--max-tasks', '1'])
  assertEqual(dispatch.workItems.length, 1, 'snapshot transition fixture needs an in-flight WorkItem')
  fs.appendFileSync(path.join(repo, 'src', 'App.tsx'), '\n// v3 in-flight snapshot transition fixture\n', 'utf8')
  const rejected = runHarness(['analyze', '--repo', repo, '--out', packageDir, '--max-files', '2000'], { expectExit: 1, includeStderr: true })
  assert(/WorkItems are in flight/.test(rejected), 'analyze must reject an in-flight snapshot transition before scanning')
  assertEqual(readJson(path.join(packageDir, 'state', 'run-state.json')).runId, after.runId, 'rejected transition preserves active run')
}

function assertEventTamperDetected() {
  const packageDir = path.join(workDir, 'tampered-events-package')
  preparePackage(packageDir)
  runHarnessJson(['dispatch', '--package', packageDir, '--max-tasks', '1'])
  const eventFile = path.join(packageDir, 'store', 'run-events.jsonl')
  const events = readJsonLines(eventFile)
  events.at(-1).payload.itemId = 'work:tampered'
  fs.writeFileSync(eventFile, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8')
  const output = runHarness(['status', '--package', packageDir], { expectExit: 1, includeStderr: true })
  assert(/event hash mismatch/i.test(output), 'tampered event stream must fail hash validation')
}

function preparePackage(packageDir, options = {}) {
  runHarness(['analyze', '--repo', fixtureRepo, '--out', packageDir, '--max-files', '2000'])
  const planResult = runHarnessJson(['semantic-plan', '--package', packageDir])
  const plan = readJson(planResult.planPath)
  writeAcceptedNodeSemanticFixtureResults(packageDir, plan)
  const semanticIngest = runHarnessJson(['semantic-ingest', '--package', packageDir])
  assertEqual(semanticIngest.status, 'complete', 'Stage 6 fixture status')
  assertEqual(semanticIngest.acceptedFiles, plan.eligibleFileCount, 'Stage 6 fixture coverage')
  installClosedJourney(packageDir)
  installSemanticContracts(packageDir, options)
  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'dispatch', 'semantic contract must be dispatchable')
}

function runHarness(args, options = {}) {
  const result = spawnSync(process.execPath, [harnessScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const expected = options.expectExit ?? 0
  if (result.status !== expected) {
    throw new Error([`harness ${args.join(' ')} exited ${result.status}, expected ${expected}`, result.stdout, result.stderr].filter(Boolean).join('\n'))
  }
  return options.includeStderr ? `${result.stdout}${result.stderr}` : result.stdout
}

function runHarnessJson(args, options = {}) {
  const stdout = runHarness(args, options)
  try { return JSON.parse(stdout) } catch { throw new Error(`Expected JSON from harness ${args.join(' ')}:\n${stdout}`) }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
