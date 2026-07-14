#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadSemanticStore } from '../../packages/repo-understanding-kernel/src/knowledge/semantic-store.mjs'
import {
  installClosedJourney,
  installSemanticContracts,
  writeAcceptedNodeSemanticFixtureResults,
  writeSatisfiedWorkResult,
} from '../helpers/v3-workflow-fixture.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const harness = path.join(repoRoot, 'packages', 'repo-understanding-cli', 'src', 'cli.mjs')
const fixtureRepo = path.join(repoRoot, 'evals', 'fixtures', 'react-mini-repo')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-v3-knowledge-eval-'))
const packageDir = path.join(workDir, 'package')

try {
  runHarness(['analyze', '--repo', fixtureRepo, '--out', packageDir, '--max-files', '2000'])
  const semanticPlanResult = runHarnessJson(['semantic-plan', '--package', packageDir])
  const semanticPlan = readJson(semanticPlanResult.planPath)
  writeAcceptedNodeSemanticFixtureResults(packageDir, semanticPlan)
  const semanticIngest = runHarnessJson(['semantic-ingest', '--package', packageDir])
  assertEqual(semanticIngest.status, 'complete', 'Stage 6 fixture status')
  assertEqual(semanticIngest.acceptedFiles, semanticPlan.eligibleFileCount, 'Stage 6 fixture coverage')
  installClosedJourney(packageDir)
  installSemanticContracts(packageDir)
  const dispatch = runHarnessJson(['dispatch', '--package', packageDir, '--max-tasks', '1'])
  const item = readJson(dispatch.workItems[0].workItemPath)
  const produced = writeSatisfiedWorkResult(packageDir, item)
  const ingest = runHarnessJson(['ingest', '--package', packageDir, '--work-result', produced.workResultPath])
  assertEqual(ingest.merged, true, 'TaskOutcome ingest')

  const store = loadSemanticStore(packageDir)
  assert(store.validation.valid, store.validation.issues.join('\n'))
  const evidenceIds = new Set(store.evidence.map(value => value.evidenceId))
  const evidenceById = new Map(store.evidence.map(value => [value.evidenceId, value]))
  const accepted = store.claims.filter(claim => claim.status === 'accepted')
  const refuted = store.claims.filter(claim => claim.status === 'refuted')
  assertEqual(accepted.length, 1, 'accepted semantic Claims')
  assertEqual(refuted.length, 1, 'refuted semantic Claims')
  assert(store.claims.every(claim => claim.evidenceIds.length > 0), 'every Claim requires Evidence')
  assert(store.claims.every(claim => claim.evidenceIds.every(id => evidenceIds.has(id))), 'every Claim Evidence reference must resolve')
  assert(store.claims.every(claim => claim.derivation === 'agent' && claim.createdByItemId === item.itemId), 'semantic Claim provenance must identify the WorkItem')
  assert(store.claims.every(claim => claim.qualifiers?.contractId === produced.contract.contractId), 'semantic Claim provenance must identify the ResearchContract')
  assert(accepted.every(claim => claim.evidenceIds.every(id => evidenceById.get(id)?.sourcePath === claim.subject.replace(/^module:/, ''))), 'accepted Claim Evidence must come from the claimed source file')
  assert(store.claims.every(claim => claim.evidenceIds.every(id => produced.contract.scope.allowedFiles.includes(evidenceById.get(id)?.sourcePath))), 'semantic Claim Evidence must stay inside ResearchContract scope')

  runHarnessJson(['project', '--package', packageDir, '--only', 'maps'])
  const application = readJson(path.join(packageDir, 'projections', 'application-map.json'))
  const projectedClaimIds = new Set(application.acceptedSemanticClaimIds || [])
  const projectionGroundedness = accepted.filter(claim => projectedClaimIds.has(claim.claimId)).length / accepted.length
  assertEqual(projectionGroundedness, 1, 'accepted semantic Claim projection groundedness')

  const metrics = {
    acceptedSemanticClaims: accepted.length,
    refutedSemanticClaims: refuted.length,
    evidenceCount: store.evidence.length,
    claimEvidenceReferencePrecision: 1,
    acceptedClaimSubjectEvidenceAlignment: 1,
    projectionGroundedness,
    semanticStoreValid: true,
  }
  console.log(JSON.stringify({ schemaVersion: 'repo-knowledge-eval/v3', passed: true, metrics }, null, 2))
  fs.rmSync(workDir, { recursive: true, force: true })
} catch (error) {
  console.error(error.stack || error.message || String(error))
  console.error(`Knowledge eval workDir: ${workDir}`)
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

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
}
