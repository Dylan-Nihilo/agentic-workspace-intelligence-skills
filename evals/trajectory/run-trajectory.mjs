#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  installClosedJourney,
  installSemanticContracts,
  writeAcceptedNodeSemanticFixtureResults,
  writeSatisfiedWorkResult,
  writeSynthesisWorkResult,
} from '../helpers/v3-workflow-fixture.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const harness = path.join(repoRoot, 'packages', 'repo-understanding-cli', 'src', 'cli.mjs')
const standaloneHtmlRenderer = path.join(repoRoot, 'skills', 'repo-human-readable', 'scripts', 'generate-html.mjs')
const fixtureRepo = path.join(repoRoot, 'evals', 'fixtures', 'react-mini-repo')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-v3-trajectory-eval-'))
const packageDir = path.join(workDir, 'package')

try {
  runHarness(['analyze', '--repo', fixtureRepo, '--out', packageDir, '--max-files', '2000'])
  const nodeSemanticPlanResult = runHarnessJson(['semantic-plan', '--package', packageDir])
  const nodeSemanticPlan = readJson(nodeSemanticPlanResult.planPath)
  writeAcceptedNodeSemanticFixtureResults(packageDir, nodeSemanticPlan)
  const nodeSemanticIngest = runHarnessJson(['semantic-ingest', '--package', packageDir])
  assertEqual(nodeSemanticIngest.status, 'complete', 'Stage 6 Node Semantic Catalog must close before Journey work')
  assertEqual(nodeSemanticIngest.acceptedFiles, nodeSemanticPlan.eligibleFileCount, 'Stage 6 accepted coverage')
  installSemanticContracts(packageDir, { count: 2 })
  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'dispatch', 'initial nextAction')
  assertRejected(
    ['project', '--package', packageDir, '--only', 'maps'],
    /pending|contract|cannot project/i,
    'Product Map projection must reject pending ResearchContracts',
  )
  const dispatch = runHarnessJson(['dispatch', '--package', packageDir, '--max-tasks', '40'])
  assertEqual(dispatch.schemaVersion, 'repo-work-dispatch/v3', 'dispatch schema')
  assertEqual(dispatch.workItems.length, 2, 'trajectory dispatch needs two semantic WorkItems')
  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'await-results', 'Join barrier after issue')
  assertRejected(
    ['project', '--package', packageDir, '--only', 'maps'],
    /work items|await|join|cannot project/i,
    'Product Map projection must reject in-flight WorkItems',
  )

  for (const [index, entry] of dispatch.workItems.entries()) {
    const item = readJson(entry.workItemPath)
    const produced = writeSatisfiedWorkResult(packageDir, item, { runtime: 'trajectory-fixture' })
    assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'ingest', `result ${index} must be detected before ingest`)
    runHarnessJson(['ingest', '--package', packageDir, '--work-result', produced.workResultPath])
    if (index < dispatch.workItems.length - 1) {
      assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'await-results', 'Join barrier waits for remaining issued work')
    }
  }
  const openJourneyStatus = runHarnessJson(['status', '--package', packageDir])
  assertEqual(openJourneyStatus.nextAction, 'blocked', 'accepted Join must stop at incomplete Journey closure')
  assertEqual(openJourneyStatus.workflow.stopReason, 'journey-closure-incomplete', 'Journey closure stop reason')
  assertRejected(
    ['project', '--package', packageDir, '--only', 'maps'],
    /journey closure|cannot project/i,
    'Product Map projection must reject incomplete Journey closure',
  )
  assertRejected(
    ['synthesize', '--package', packageDir],
    /product map|verification|cannot synthesize/i,
    'synthesis must reject before Product Maps pass verification',
  )
  const incomplete = runHarnessJson(['verify', '--package', packageDir], { expectExit: 2 })
  assertEqual(incomplete.passed, false, 'complete verification before Product Maps')
  assert(incomplete.issues.some(issue => issue.code.startsWith('product-map-')), 'complete verification must report missing Product Maps')
  const invalidNarrativePath = path.join(packageDir, 'synthesis', 'narrative.json')
  fs.mkdirSync(path.dirname(invalidNarrativePath), { recursive: true })
  fs.writeFileSync(invalidNarrativePath, '{"schemaVersion":"invalid-narrative"}\n', 'utf8')
  const invalidNarrativeVerification = runHarnessJson(['verify', '--package', packageDir], { expectExit: 2 })
  assertEqual(invalidNarrativeVerification.phase, 'synthesis', 'verify must inspect a present invalid narrative at synthesis phase')
  assert(invalidNarrativeVerification.issues.some(issue => issue.code.startsWith('narrative-')), 'invalid narrative failure must not be hidden by projection fallback')
  fs.rmSync(path.dirname(invalidNarrativePath), { recursive: true, force: true })

  const events = readJsonLines(path.join(packageDir, 'store', 'run-events.jsonl'))
  assertEqual(events[0].eventType, 'run-created', 'event stream root')
  assert(events.every(event => event.schemaVersion === 'repo-run-event/v3'), 'all RunEvents must use v3')
  assert(eventIndex(events, 'snapshot-created') > 0, 'snapshot-created event missing')
  assert(eventIndex(events, 'census-completed') > eventIndex(events, 'snapshot-created'), 'census must follow snapshot')
  for (const entry of dispatch.workItems) {
    assertEventOrder(events, entry.itemId, 'work-planned', 'work-issued')
    assertEventOrder(events, entry.itemId, 'work-issued', 'result-detected')
    assertEventOrder(events, entry.itemId, 'result-detected', 'result-accepted')
    assertContractOutcomeAfterResult(events, entry.itemId, entry.contractId)
  }
  assert(!events.some(event => ['synthesis-accepted', 'projection-built', 'run-completed'].includes(event.eventType)), 'trajectory must not bypass projection and synthesis gates')
  verifyHashChain(events)

  installClosedJourney(packageDir)
  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'project', 'closed Journey advances to Product Maps')
  runHarnessJson(['project', '--package', packageDir, '--only', 'maps'])
  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'synthesize', 'verified Product Maps advance to synthesis')
  assertRejected(
    ['project', '--package', packageDir, '--only', 'html'],
    /narrative|synthesi|cannot project/i,
    'HTML projection must fail clearly before a synthesis narrative exists',
  )
  const synthesisDispatch = runHarnessJson(['synthesize', '--package', packageDir])
  assertEqual(synthesisDispatch.workItems.length, 1, 'synthesis dispatch must contain one WorkItem')
  const synthesisItem = readJson(synthesisDispatch.workItems[0].workItemPath)
  const synthesisResult = writeSynthesisWorkResult(packageDir, synthesisItem, { runtime: 'trajectory-synthesizer' })
  assertEqual(runHarnessJson(['status', '--package', packageDir]).nextAction, 'ingest', 'synthesis WorkResult must be detected before ingest')
  const synthesisIngest = runHarnessJson(['ingest', '--package', packageDir, '--work-result', synthesisResult.workResultPath])
  assertEqual(synthesisIngest.merged, true, 'synthesis narrative must pass strict ingest validation')
  assertEqual(synthesisIngest.nextAction, 'project', 'accepted synthesis advances to HTML projection')
  const synthesisVerification = runHarnessJson(['verify', '--package', packageDir])
  assertEqual(synthesisVerification.phase, 'synthesis', 'verify with a current narrative must use synthesis phase')
  assertEqual(synthesisVerification.passed, true, 'current synthesis must pass before HTML projection')

  const standaloneHtml = runNodeJson(standaloneHtmlRenderer, ['--package', packageDir])
  assert(standaloneHtml.output && fs.existsSync(standaloneHtml.output), 'standalone HTML renderer must produce a file')
  const preCompletionStatus = runHarnessJson(['status', '--package', packageDir])
  assertEqual(preCompletionStatus.nextAction, 'project', 'current standalone HTML must not bypass run completion')
  assertEqual(preCompletionStatus.workflow.terminal, null, 'standalone HTML must not mutate workflow terminal')
  assertEqual(readJsonLines(path.join(packageDir, 'store', 'run-events.jsonl')).filter(event => event.eventType === 'run-completed').length, 0, 'standalone HTML must not emit run-completed')

  const htmlProjection = runHarnessJson(['project', '--package', packageDir, '--only', 'html'])
  assert(htmlProjection.html && fs.existsSync(htmlProjection.html), 'HTML projection must produce a file')
  assertEqual(htmlProjection.completion?.completed, true, 'HTML projection must complete the run')
  const completedStatus = runHarnessJson(['status', '--package', packageDir])
  assertEqual(completedStatus.nextAction, 'done', 'completed HTML projection must close the run')
  assertEqual(completedStatus.workflow.terminal, 'completed', 'done status must require completed workflow terminal')
  const repeatedHtml = runHarnessJson(['project', '--package', packageDir, '--only', 'html'])
  assertEqual(repeatedHtml.completion?.alreadyCompleted, true, 'repeated HTML projection must not complete the run twice')

  const stateBeforeVerify = fs.readFileSync(path.join(packageDir, 'state', 'run-state.json'), 'utf8')
  const eventsBeforeVerify = fs.readFileSync(path.join(packageDir, 'store', 'run-events.jsonl'), 'utf8')
  const doneVerification = runHarnessJson(['verify', '--package', packageDir])
  assertEqual(doneVerification.phase, 'complete', 'verify after done must preserve complete verification phase')
  assertEqual(doneVerification.passed, true, 'verify after done must remain passed')
  assertEqual(readJson(path.join(packageDir, 'verification', 'frontend-verification.json')).phase, 'complete', 'verify after done must not downgrade persisted verification')
  assertEqual(fs.readFileSync(path.join(packageDir, 'state', 'run-state.json'), 'utf8'), stateBeforeVerify, 'verify after done must not change RunState')
  assertEqual(fs.readFileSync(path.join(packageDir, 'store', 'run-events.jsonl'), 'utf8'), eventsBeforeVerify, 'verify after done must not append RunEvents')

  const completedEvents = readJsonLines(path.join(packageDir, 'store', 'run-events.jsonl'))
  assertEventOrder(completedEvents, synthesisItem.itemId, 'work-issued', 'result-accepted')
  assert(eventIndex(completedEvents, 'synthesis-accepted') > eventIndex(completedEvents, 'result-accepted'), 'synthesis-accepted must follow WorkResult acceptance')
  assert(eventIndex(completedEvents, 'run-completed') > eventIndex(completedEvents, 'synthesis-accepted'), 'run-completed must follow accepted synthesis')
  assertEqual(completedEvents.filter(event => event.eventType === 'run-completed').length, 1, 'run-completed must be emitted exactly once')
  verifyHashChain(completedEvents)
  console.log(JSON.stringify({
    schemaVersion: 'repo-trajectory-eval/v3',
    passed: true,
    metrics: {
      eventCount: completedEvents.length,
      nodeSemanticFiles: nodeSemanticPlan.eligibleFileCount,
      workItems: dispatch.workItems.length,
      joinBarrierChecks: dispatch.workItems.length + 1,
      gateRejectionChecks: 5,
      completionChecks: 15,
      hashChainValid: true,
    },
  }, null, 2))
  fs.rmSync(workDir, { recursive: true, force: true })
} catch (error) {
  console.error(error.stack || error.message || String(error))
  console.error(`Trajectory eval workDir: ${workDir}`)
  process.exitCode = 1
}

function assertEventOrder(events, itemId, beforeType, afterType) {
  const before = events.findIndex(event => event.eventType === beforeType && eventItemId(event) === itemId)
  const after = events.findIndex(event => event.eventType === afterType && eventItemId(event) === itemId)
  assert(before >= 0, `${beforeType} missing for ${itemId}`)
  assert(after > before, `${afterType} must follow ${beforeType} for ${itemId}`)
}

function assertContractOutcomeAfterResult(events, itemId, contractId) {
  const accepted = events.findIndex(event => event.eventType === 'result-accepted' && eventItemId(event) === itemId)
  const outcome = events.findIndex(event => event.eventType === 'task-outcome-accepted' && event.payload.contractId === contractId)
  assert(accepted >= 0, `result-accepted missing for ${itemId}`)
  assert(outcome > accepted, `task-outcome-accepted must follow result-accepted for ${contractId}`)
}

function eventItemId(event) {
  return event.payload.itemId || event.payload.item?.itemId
}

function eventIndex(events, eventType) {
  return events.findIndex(event => event.eventType === eventType)
}

function verifyHashChain(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    assertEqual(event.sequence, index + 1, `event sequence ${index}`)
    assertEqual(event.previousEventHash, index === 0 ? null : events[index - 1].eventHash, `previousEventHash ${index}`)
    const { eventHash, ...base } = event
    assertEqual(eventHash, createHash('sha256').update(JSON.stringify(base)).digest('hex'), `eventHash ${index}`)
  }
}

function assertRejected(args, pattern, message) {
  const output = runHarness(args, { expectExit: 1, includeStderr: true })
  assert(pattern.test(output), `${message}: ${output}`)
}

function runHarness(args, options = {}) {
  const result = spawnSync(process.execPath, [harness, ...args], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const expected = options.expectExit ?? 0
  if (result.status !== expected) throw new Error([`harness exited ${result.status}, expected ${expected}`, result.stdout, result.stderr].filter(Boolean).join('\n'))
  return options.includeStderr ? `${result.stdout}${result.stderr}` : result.stdout
}

function runHarnessJson(args, options = {}) {
  return JSON.parse(runHarness(args, options))
}

function runNodeJson(entrypoint, args) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) throw new Error([`node entrypoint exited ${result.status}`, result.stdout, result.stderr].filter(Boolean).join('\n'))
  return JSON.parse(result.stdout)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
}
