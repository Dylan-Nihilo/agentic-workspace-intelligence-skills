#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installSemanticContracts, writeSatisfiedWorkResult } from '../helpers/v3-workflow-fixture.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const harness = path.join(repoRoot, 'packages', 'repo-understanding-cli', 'src', 'cli.mjs')
const fixtureRepo = path.join(repoRoot, 'evals', 'fixtures', 'react-mini-repo')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-v3-cost-eval-'))
const packageDir = path.join(workDir, 'package')

try {
  runHarness(['analyze', '--repo', fixtureRepo, '--out', packageDir, '--max-files', '2000'])
  installSemanticContracts(packageDir)
  const dispatch = runHarnessJson(['dispatch', '--package', packageDir, '--max-tasks', '1'])
  const item = readJson(dispatch.workItems[0].workItemPath)
  runHarnessJson([
    'trace', '--package', packageDir, '--item', item.itemId, '--event', 'started',
    '--runtime', 'cost-fixture-runtime', '--model', 'cost-fixture-model', '--session', 'cost-session',
  ])
  const usage = {
    status: 'reported',
    inputTokens: 800,
    outputTokens: 200,
    cachedInputTokens: 400,
    reasoningTokens: 50,
    totalTokens: 1000,
    costUsd: 0.02,
    durationMs: 60000,
  }
  const produced = writeSatisfiedWorkResult(packageDir, item, {
    runtime: 'cost-fixture-runtime',
    model: 'cost-fixture-model',
    sessionId: 'cost-session',
    usage,
  })
  runHarnessJson([
    'trace', '--package', packageDir, '--item', item.itemId, '--event', 'completed',
    '--runtime', 'cost-fixture-runtime', '--model', 'cost-fixture-model', '--session', 'cost-session',
    '--input-tokens', '800', '--output-tokens', '200', '--cached-input-tokens', '400',
    '--reasoning-tokens', '50', '--total-tokens', '1000', '--cost-usd', '0.02', '--duration-ms', '60000',
  ])
  runHarnessJson(['ingest', '--package', packageDir, '--work-result', produced.workResultPath])

  const debug = runHarnessJson(['debug', '--package', packageDir])
  assertEqual(debug.aggregateUsage.totalTokens, 1000, 'reported total tokens')
  assertEqual(debug.aggregateUsage.costUsd, 0.02, 'reported cost')
  assertEqual(debug.knowledgeEfficiency.agentAcceptedClaims, 1, 'agent accepted Claim count')
  assertEqual(debug.knowledgeEfficiency.agentAcceptedClaimsByItem[item.itemId], 1, 'Claim attribution by WorkItem')
  assertEqual(debug.knowledgeEfficiency.acceptedAgentClaimsPer1kReportedTokens, 1, 'Claims per 1k tokens')
  assertEqual(debug.knowledgeEfficiency.acceptedAgentClaimsPerReportedMinute, 1, 'Claims per reported minute')
  assertEqual(debug.knowledgeEfficiency.costPerAcceptedAgentClaimUsd, 0.02, 'cost per accepted Claim')
  assertEqual(debug.knowledgeEfficiency.contextReuseRatio, 0.5, 'context reuse ratio')
  assertEqual(debug.byItem.find(value => value.itemId === item.itemId)?.model, 'cost-fixture-model', 'model trace')
  console.log(JSON.stringify({
    schemaVersion: 'repo-cost-eval/v3',
    passed: true,
    metrics: {
      aggregateUsage: debug.aggregateUsage,
      knowledgeEfficiency: debug.knowledgeEfficiency,
    },
  }, null, 2))
  fs.rmSync(workDir, { recursive: true, force: true })
} catch (error) {
  console.error(error.stack || error.message || String(error))
  console.error(`Cost eval workDir: ${workDir}`)
  process.exitCode = 1
}

function runHarness(args) {
  const result = spawnSync(process.execPath, [harness, ...args], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) throw new Error([`harness failed with ${result.status}`, result.stdout, result.stderr].filter(Boolean).join('\n'))
  return result.stdout
}

function runHarnessJson(args) {
  return JSON.parse(runHarness(args))
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
}
