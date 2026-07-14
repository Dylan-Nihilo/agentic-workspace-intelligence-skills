#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  installClosedJourney,
  writeAcceptedNodeSemanticFixtureResults,
} from '../helpers/v3-workflow-fixture.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const harness = path.join(repoRoot, 'packages', 'repo-understanding-cli', 'src', 'cli.mjs')
const fixtureRepo = path.join(repoRoot, 'evals', 'fixtures', 'react-mini-repo')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-v3-map-retrieval-eval-'))
const packageDir = path.join(workDir, 'package')
const maxMapBytes = 256 * 1024

try {
  runHarness(['analyze', '--repo', fixtureRepo, '--out', packageDir, '--max-files', '2000'])
  const semanticPlanResult = runHarnessJson(['semantic-plan', '--package', packageDir])
  const semanticPlan = readJson(semanticPlanResult.planPath)
  writeAcceptedNodeSemanticFixtureResults(packageDir, semanticPlan)
  const semanticIngest = runHarnessJson(['semantic-ingest', '--package', packageDir])
  assertEqual(semanticIngest.status, 'complete', 'Stage 6 fixture status')
  assertEqual(semanticIngest.acceptedFiles, semanticPlan.eligibleFileCount, 'Stage 6 fixture coverage')
  installClosedJourney(packageDir)
  runHarnessJson(['project', '--package', packageDir, '--only', 'maps'])
  const manifest = readJson(path.join(packageDir, 'projections', 'manifest.json'))
  const documents = Object.entries(manifest.projections).map(([name, entry]) => {
    const value = readJson(path.resolve(packageDir, entry.path))
    return { name, entry, value, text: searchableText(value) }
  })
  const cases = [
    { query: 'React Vite application root', expected: 'application' },
    { query: 'experience journey actor goal product outcome', expected: 'experience' },
    { query: 'runtime flow page steps transitions', expected: 'runtimeFlow' },
    { query: 'change impact reverse dependencies App Button', expected: 'change' },
  ]
  const results = cases.map(test => {
    const ranked = rank(test.query, documents)
    const bestRank = ranked.findIndex(document => document.name === test.expected) + 1
    return {
      query: test.query,
      expected: test.expected,
      bestRank,
      hitAt2: bestRank > 0 && bestRank <= 2,
      reciprocalRank: bestRank ? 1 / bestRank : 0,
      ranking: ranked.map(document => document.name),
    }
  })
  const evidenceIds = new Set(readJsonLines(path.join(packageDir, 'store', 'evidence.jsonl')).map(value => value.evidenceId))
  const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
  for (const file of inventory.files || []) evidenceIds.add(`evidence:file:${file.path}`)
  for (const manifestEntry of inventory.manifests || []) evidenceIds.add(`evidence:manifest:${manifestEntry.path}`)
  const referencedEvidenceIds = unique(documents.flatMap(document => collectNamedArrays(document.value, 'evidenceIds')))
  const resolvedEvidenceIds = referencedEvidenceIds.filter(id => evidenceIds.has(id))
  const projectionKeys = documents.map(document => JSON.stringify(document.value.projectionKey))
  const metrics = {
    hitAt2: mean(results.map(result => result.hitAt2 ? 1 : 0)),
    meanReciprocalRank: mean(results.map(result => result.reciprocalRank)),
    evidenceReferencePrecision: resolvedEvidenceIds.length / referencedEvidenceIds.length,
    projectionKeyConsistency: new Set(projectionKeys).size === 1 ? 1 : 0,
    mapCount: documents.length,
    maxSerializedMapBytes: Math.max(...documents.map(document => Buffer.byteLength(JSON.stringify(document.value)))),
    maxSerializedMapBytesBudget: maxMapBytes,
  }
  assert(results.every(result => result.hitAt2), `Every Product Map must be retrievable at Hit@2: ${JSON.stringify(results)}`)
  assert(metrics.hitAt2 === 1, `Product Map Hit@2 below threshold: ${metrics.hitAt2}`)
  assert(metrics.meanReciprocalRank >= 0.7, `Product Map MRR below threshold: ${metrics.meanReciprocalRank}`)
  assert(referencedEvidenceIds.length > 0, 'Product Maps must expose governed Evidence references')
  assertEqual(metrics.evidenceReferencePrecision, 1, 'Product Map Evidence reference precision')
  assertEqual(metrics.projectionKeyConsistency, 1, 'Product Map projectionKey consistency')
  assertEqual(metrics.mapCount, 4, 'Product Map count')
  assert(metrics.maxSerializedMapBytes <= maxMapBytes, `Product Map exceeds ${maxMapBytes} byte budget: ${metrics.maxSerializedMapBytes}`)
  console.log(JSON.stringify({ schemaVersion: 'repo-map-retrieval-eval/v3', passed: true, metrics, results }, null, 2))
  fs.rmSync(workDir, { recursive: true, force: true })
} catch (error) {
  console.error(error.stack || error.message || String(error))
  console.error(`Map retrieval eval workDir: ${workDir}`)
  process.exitCode = 1
}

function rank(query, documents) {
  const queryTokens = tokens(query)
  return documents
    .map(document => ({
      ...document,
      score: queryTokens.reduce((score, token) => score
        + (tokens(document.name).includes(token) ? 6 : 0)
        + document.text.filter(value => value === token).length, 0),
    }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
}

function searchableText(value) {
  return tokens(JSON.stringify(value))
}

function tokens(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function collectNamedArrays(value, key) {
  if (Array.isArray(value)) return value.flatMap(item => collectNamedArrays(item, key))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([name, item]) => name === key && Array.isArray(item)
    ? item.filter(candidate => typeof candidate === 'string')
    : collectNamedArrays(item, key))
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

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
}

function unique(values) {
  return [...new Set(values)]
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
}
