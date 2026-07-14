#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureRepo = path.join(repoRoot, 'evals', 'fixtures', 'mini-repo')
const fixtureRoot = path.join(repoRoot, 'evals', 'fixtures', 'coding-pool')
const goldenPath = path.join(repoRoot, 'evals', 'fixtures', 'golden', 'coding-pool.golden.json')
const normalizeScript = path.join(repoRoot, 'skills', 'agentic-coding-audit', 'scripts', 'normalize-coding-pool.mjs')
const exportScript = path.join(repoRoot, 'skills', 'agentic-coding-audit', 'scripts', 'export-audit-data.mjs')
const pipelineScript = path.join(repoRoot, 'skills', 'agentic-datasource-orchestrator', 'scripts', 'run-pipeline.mjs')
const ceBridgeScript = path.join(repoRoot, 'skills', 'agentic-ce-bridge', 'scripts', 'run-ce-analysis.mjs')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datasource-contract-eval-'))

try {
  assertCodingPoolGoldenGate()
  assertAuditExportFreshnessGate()
  assertExternalRunConfirmationGate()
  assertCeSharedIngestGate()
  assertCeParseFailureGate()
  console.log(JSON.stringify({
    schemaVersion: 'datasource-contract-eval/v1',
    passed: true,
    checked: [
      'coding-pool:golden',
      'coding-pool:invalid-evidenceRefs',
      'coding-pool:invalid-producedBy',
      'audit-export:freshness',
      'datasource-pipeline:external-confirmation',
      'ce-bridge:shared-ingest',
      'ce-bridge:parse-failure',
    ],
  }, null, 2))
  fs.rmSync(workDir, { recursive: true, force: true })
} catch (error) {
  console.error(error.stack || error.message || String(error))
  console.error(`Datasource contract eval workDir: ${workDir}`)
  process.exitCode = 1
}

function assertCodingPoolGoldenGate() {
  const golden = readJson(goldenPath)
  const validPool = copyFixture(path.join(fixtureRoot, 'valid'), 'coding-pool-valid')
  runNode(normalizeScript, ['--pool', validPool])
  const normalized = readJson(path.join(validPool, 'facts', 'coding-pool.json'))
  assertJsonEqual(normalized.agentAnalyses, golden.agentAnalyses, 'coding-pool normalized agentAnalyses golden')

  const invalidEmptyEvidence = copyFixture(path.join(fixtureRoot, 'invalid-empty-evidence'), 'coding-pool-invalid-empty-evidence')
  runNode(normalizeScript, ['--pool', invalidEmptyEvidence], { expectExit: 2 })
  const invalidProducedBy = copyFixture(path.join(fixtureRoot, 'invalid-produced-by'), 'coding-pool-invalid-produced-by')
  runNode(normalizeScript, ['--pool', invalidProducedBy], { expectExit: 2 })
}

function assertAuditExportFreshnessGate() {
  const poolDir = path.join(workDir, 'datasource', 'pools', 'coding')
  fs.mkdirSync(path.join(poolDir, 'facts'), { recursive: true })
  fs.mkdirSync(path.join(poolDir, 'analyses'), { recursive: true })
  for (const name of ['repositories', 'relationships', 'findings', 'runs']) writeJson(path.join(poolDir, 'facts', `${name}.json`), [])
  const codingPoolPath = path.join(poolDir, 'facts', 'coding-pool.json')
  writeJson(codingPoolPath, {
    schemaVersion: 'coding-pool/v1',
    generatedAt: new Date().toISOString(),
    workspace: { name: 'contract-eval', root: fixtureRepo },
    runs: [], repositories: [], relationships: [], findings: [], agentAnalyses: [],
  })
  const staleTime = new Date(Date.now() - 10000)
  fs.utimesSync(codingPoolPath, staleTime, staleTime)
  writeJson(path.join(poolDir, 'analyses', 'newer.json'), [{
    id: 'analysis:contract-eval',
    subject: { type: 'repo', id: 'repo:contract-eval' },
    producedBy: 'subagent',
    evidenceRefs: ['evidence:raw:contract'],
    claim: 'Contract eval analysis',
    rationale: 'Proves the audit export freshness gate.',
    confidence: 'low',
    createdAt: new Date().toISOString(),
  }])
  runNode(exportScript, ['--pool', poolDir, '--out', path.join(workDir, 'audit-data.json')], { expectExit: 2 })
}

function assertExternalRunConfirmationGate() {
  runNode(pipelineScript, [
    '--workspace', fixtureRepo,
    '--datasource', path.join(workDir, 'blocked-datasource'),
    '--run-ce',
    '--ce-subject', 'repo:contract-eval',
    '--ce-task', 'architecture-risk',
  ], { expectExit: 2, env: { ...process.env, AGENTIC_CONFIRM_EXTERNAL: '' } })
}

function assertCeSharedIngestGate() {
  const source = fs.readFileSync(ceBridgeScript, 'utf8')
  assert(source.includes('ingestAgentAnalyses'), 'CE bridge must use shared datasource ingest')
  const fakeCli = writeFakeCli('fake-ce-cli-valid.mjs', `
if (payload.op === 'wait') {
  console.log(JSON.stringify([{ claim: 'CE shared ingest contract', rationale: 'Valid CE JSON uses the shared ingest gate.', confidence: 'medium' }]))
  process.exit(0)
}`)
  const datasource = path.join(workDir, 'ce-shared-ingest-datasource')
  runNode(ceBridgeScript, [
    '--datasource', datasource, '--pool', 'coding', '--subject', 'repo:contract-eval',
    '--task', 'shared-ingest', '--ce-cli', fakeCli, '--timeout', '1',
  ])
  const analysisDir = path.join(datasource, 'pools', 'coding', 'analyses')
  const files = fs.readdirSync(analysisDir).filter(file => file.endsWith('.json'))
  assertEqual(files.length, 1, 'CE shared-ingest analysis count')
  const records = readJson(path.join(analysisDir, files[0]))
  assertEqual(records[0].producedBy, 'subagent', 'CE shared-ingest producedBy')
  assert(records[0].evidenceRefs?.length > 0, 'CE shared-ingest Evidence refs')
}

function assertCeParseFailureGate() {
  const fakeCli = writeFakeCli('fake-ce-cli-invalid.mjs', `
if (payload.op === 'wait') {
  console.log('not structured json')
  process.exit(0)
}`)
  const datasource = path.join(workDir, 'ce-parse-failure-datasource')
  runNode(ceBridgeScript, [
    '--datasource', datasource, '--pool', 'coding', '--subject', 'repo:contract-eval',
    '--task', 'parse-failure', '--ce-cli', fakeCli, '--timeout', '1',
  ], { expectExit: 2 })
  const poolDir = path.join(datasource, 'pools', 'coding')
  const analysisDir = path.join(poolDir, 'analyses')
  assert(!fs.existsSync(analysisDir) || fs.readdirSync(analysisDir).length === 0, 'CE parse failure must not write analyses')
  const rawRoot = path.join(poolDir, 'raw', 'ce-runs')
  const markers = fs.readdirSync(rawRoot).filter(name => fs.existsSync(path.join(rawRoot, name, 'ce-run-failed.json')))
  assertEqual(markers.length, 1, 'CE parse-failure marker count')
}

function writeFakeCli(name, waitBranch) {
  const file = path.join(workDir, name)
  fs.writeFileSync(file, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('fake-ce-cli 1.0.0'); process.exit(0) }
const payloadIndex = args.indexOf('-j')
const payload = payloadIndex >= 0 ? JSON.parse(args[payloadIndex + 1] || '{}') : {}
if (payload.op === 'start') { console.log(JSON.stringify({ session_id: 'contract-session' })); process.exit(0) }
${waitBranch}
console.error('unknown op')
process.exit(2)
`, 'utf8')
  fs.chmodSync(file, 0o755)
  return file
}

function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: options.env || process.env,
  })
  const expected = options.expectExit ?? 0
  if (result.status !== expected) throw new Error([
    `node ${path.relative(repoRoot, script)} ${args.join(' ')} exited ${result.status}, expected ${expected}`,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n'))
  return result.stdout
}

function copyFixture(source, name) {
  const target = path.join(workDir, name)
  fs.cpSync(source, target, { recursive: true })
  return target
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertJsonEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: values differ`)
}
