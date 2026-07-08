#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EFFORT_LEVELS,
  EXPLORERS,
  PREDICATES,
  PROJECTIONS,
  explorerEffort,
} from '../../shared/understanding/harness-registry.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const expectations = readJson(path.join(repoRoot, 'evals', 'fixtures', 'golden', 'contract.expectations.json'))
const harnessScript = path.join(repoRoot, 'harnesses', 'repo-understanding', 'scripts', 'harness.mjs')
const harnessConfigPath = path.join(repoRoot, 'harnesses', 'repo-understanding', 'harness.config.json')
const auditExportScript = path.join(repoRoot, 'skills', 'agentic-coding-audit', 'scripts', 'export-audit-data.mjs')
const normalizeCodingPoolScript = path.join(repoRoot, 'skills', 'agentic-coding-audit', 'scripts', 'normalize-coding-pool.mjs')
const datasourcePipelineScript = path.join(repoRoot, 'skills', 'agentic-datasource-orchestrator', 'scripts', 'run-pipeline.mjs')
const ceBridgeScript = path.join(repoRoot, 'skills', 'agentic-ce-bridge', 'scripts', 'run-ce-analysis.mjs')
const fixtureRepo = path.join(repoRoot, 'evals', 'fixtures', 'mini-repo')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-contract-eval-'))
const packageDir = path.join(workDir, 'package')

try {
  runHarness(['analyze', '--repo', fixtureRepo, '--out', packageDir, '--max-files', '2000'])

  const dispatchStatus = runHarnessJson(['status', '--package', packageDir])
  assertEqual(dispatchStatus.schemaVersion, expectations.statusSchemaVersion, 'status schemaVersion')
  assertIncludes(expectations.nextActions, dispatchStatus.nextAction, 'status nextAction enum')
  assertEqual(dispatchStatus.nextAction, 'dispatch', 'status nextAction after analyze')
  assertRegistryContracts(packageDir)

  const dispatch = runHarnessJson(['dispatch', '--package', packageDir, '--max-tasks', '3'])
  assertEqual(dispatch.schemaVersion, expectations.dispatchSchemaVersion, 'dispatch schemaVersion')
  assert(dispatch.round >= 1, 'dispatch round should be >= 1')
  assert(Array.isArray(dispatch.explorers), 'dispatch explorers should be an array')
  assert(dispatch.manifestPath && fs.existsSync(dispatch.manifestPath), 'dispatch manifestPath should exist')
  assertDispatchEffortInManifest(dispatch)

  assertExplorerOutputSchema()
  assertVerificationSchema()
  assertExternalVerifierTrustBoundary()
  assertCodingPoolGoldenGate()
  assertAuditExportGate()
  assertExternalRunGate()
  assertCeSharedIngestGate()
  assertCeParseFailureGate()

  const badAnalysis = path.join(workDir, 'bad-analysis.json')
  writeJson(badAnalysis, {
    schemaVersion: expectations.explorationAnalysisSchemaVersion,
    strategy: 'contract eval invalid predicate',
    facts: [{
      subject: 'file:src/main.ts',
      subjectType: 'file',
      predicate: 'made-up',
      object: 'file:src/router.ts',
      objectType: 'file',
      source: 'dynamic',
      confidence: 0.7,
      explorer: 'contract-eval',
      evidence: [{
        file: 'src/main.ts',
        line: 1,
        endLine: 1,
        snippet: "import { createRouter } from './router'",
        tool: 'contract-eval',
        rawConfidence: 0.7,
      }],
    }],
    openQuestions: [],
    observations: [],
    requestedEvidence: { files: [], searches: [] },
    gaps: [],
  })
  const rejected = runHarnessJson(['ingest', '--package', packageDir, '--analysis', badAnalysis, '--explorer', 'contract-eval', '--round', '1'], { expectExit: 2 })
  assertEqual(rejected.schemaVersion, expectations.ingestSchemaVersion, 'rejected ingest schemaVersion')
  assertEqual(rejected.merged, false, 'rejected ingest merged')
  assert(Array.isArray(rejected.issues) && rejected.issues.length > 0, 'rejected ingest issues')

  const badLineAnalysis = path.join(workDir, 'bad-line-analysis.json')
  writeJson(badLineAnalysis, {
    schemaVersion: expectations.explorationAnalysisSchemaVersion,
    strategy: 'contract eval invalid evidence line',
    facts: [{
      subject: 'file:src/main.ts',
      subjectType: 'file',
      predicate: 'imports',
      object: 'file:src/router.ts',
      objectType: 'file',
      source: 'dynamic',
      confidence: 0.7,
      explorer: 'contract-eval',
      evidence: [{
        file: 'src/main.ts',
        line: 9999,
        endLine: 9999,
        snippet: "import { createRouter } from './router'",
        tool: 'contract-eval',
        rawConfidence: 0.7,
      }],
    }],
    openQuestions: [],
    observations: [],
    requestedEvidence: { files: [], searches: [] },
    gaps: [],
  })
  const rejectedLine = runHarnessJson(['ingest', '--package', packageDir, '--analysis', badLineAnalysis, '--explorer', 'contract-eval', '--round', '1'], { expectExit: 2 })
  assertEqual(rejectedLine.schemaVersion, expectations.ingestSchemaVersion, 'line-range rejected ingest schemaVersion')
  assertEqual(rejectedLine.merged, false, 'line-range rejected ingest merged')
  assert(rejectedLine.issues.some(issue => /line count|endLine/.test(issue.message || '')), 'line-range rejection should mention line bounds')

  const spoofedEdgeId = edgeId('file:src/main.ts', 'imports', 'file:src/api.ts')
  const spoofedVerifierAnalysis = path.join(workDir, 'spoofed-verifier-analysis.json')
  writeJson(spoofedVerifierAnalysis, {
    schemaVersion: expectations.explorationAnalysisSchemaVersion,
    strategy: 'contract eval spoofed deterministic verifier tag',
    facts: [{
      subject: 'file:src/main.ts',
      subjectType: 'file',
      predicate: 'imports',
      object: 'file:src/api.ts',
      objectType: 'file',
      source: 'dynamic',
      confidence: 0.7,
      explorer: 'contract-eval',
      evidence: [{
        file: 'src/main.ts',
        line: 1,
        endLine: 1,
        snippet: "import { createRouter } from './router'",
        tool: 'contract-eval',
        rawConfidence: 0.7,
      }],
    }],
    openQuestions: [],
    observations: [],
    requestedEvidence: { files: [], searches: [] },
    gaps: [],
    verdicts: [{
      edgeId: spoofedEdgeId,
      verdict: 'not-refuted',
      tool: expectations.externalVerifiedTool,
      reason: 'malicious external output tries to spoof deterministic verification',
      evidenceChecked: 1,
    }],
  })
  const spoofed = runHarnessJson(['ingest', '--package', packageDir, '--analysis', spoofedVerifierAnalysis, '--explorer', 'contract-eval', '--round', '1'])
  assertEqual(spoofed.schemaVersion, expectations.ingestSchemaVersion, 'spoofed verifier ingest schemaVersion')
  assertEqual(spoofed.merged, true, 'spoofed verifier ingest merged')
  const factGraphAfterSpoof = readJson(path.join(packageDir, 'fact-graph.json'))
  assert(!factGraphAfterSpoof.edges?.[spoofedEdgeId], 'spoofed deterministic verifier tag must not prevent deterministic refutation')
  const verificationAfterSpoof = readJson(path.join(packageDir, 'verification.json'))
  assert(verificationAfterSpoof.verdicts.some(item => item.edgeId === spoofedEdgeId && item.verdict === 'refuted'), 'spoofed edge should be checked and refuted by deterministic verifier')

  const lockPath = path.join(packageDir, '.repo-understanding-ingest.lock')
  fs.writeFileSync(lockPath, 'contract eval lock')
  const locked = runHarnessJson([
    'ingest',
    '--package', packageDir,
    '--open-question', 'This should be blocked by the package ingest write lock.',
    '--tasks', 'file:src/main.ts',
  ], { expectExit: 2 })
  assertEqual(locked.schemaVersion, expectations.ingestSchemaVersion, 'locked ingest schemaVersion')
  assertEqual(locked.merged, false, 'locked ingest merged')
  assert(locked.issues.some(issue => /write lock/.test(issue.message || '')), 'locked ingest should mention write lock')
  fs.rmSync(lockPath, { force: true })

  const openQuestion = runHarnessJson([
    'ingest',
    '--package', packageDir,
    '--open-question', 'Contract eval confirms the open-question CLI primitive works.',
    '--tasks', 'file:src/main.ts',
  ])
  assertEqual(openQuestion.schemaVersion, expectations.ingestSchemaVersion, 'open-question ingest schemaVersion')
  assertEqual(openQuestion.merged, true, 'open-question ingest merged')
  assertIncludes(expectations.nextActions, openQuestion.nextAction, 'open-question ingest nextAction enum')

  const goodAnalysis = path.join(workDir, 'good-analysis.json')
  writeJson(goodAnalysis, {
    schemaVersion: expectations.explorationAnalysisSchemaVersion,
    strategy: 'contract eval open-question-only analysis',
    facts: [],
    openQuestions: [{
      question: 'Contract eval confirms open-question-only ingest remains accepted.',
      relatedNodes: ['file:src/main.ts'],
      raisedBy: 'contract-eval',
    }],
    observations: [{
      title: 'Mini repo entrypoint exists',
      finding: 'src/main.ts imports router, auth, and api modules in the fixture.',
      confidence: 'high',
      tags: ['contract'],
      evidence: [{
        path: 'src/main.ts',
        startLine: 1,
        endLine: 3,
        reason: 'Entrypoint imports show fixture structure.',
      }],
    }],
    requestedEvidence: { files: [], searches: [] },
    gaps: [],
  })
  const ingested = runHarnessJson(['ingest', '--package', packageDir, '--analysis', goodAnalysis, '--explorer', 'contract-eval', '--round', '1'])
  assertEqual(ingested.schemaVersion, expectations.ingestSchemaVersion, 'successful ingest schemaVersion')
  assertEqual(ingested.merged, true, 'successful ingest merged')
  assertIncludes(expectations.nextActions, ingested.nextAction, 'successful ingest nextAction enum')

  const guardedByEdgeId = edgeId('file:src/components/GuardedButton.ts', 'guarded-by', 'file:src/auth.ts')
  const guardedByAnalysis = path.join(workDir, 'guarded-by-analysis.json')
  writeJson(guardedByAnalysis, {
    schemaVersion: expectations.explorationAnalysisSchemaVersion,
    strategy: 'contract eval accepts grounded guarded-by facts',
    facts: [{
      subject: 'file:src/components/GuardedButton.ts',
      subjectType: 'file',
      predicate: 'guarded-by',
      object: 'file:src/auth.ts',
      objectType: 'file',
      source: 'dynamic',
      confidence: 0.8,
      explorer: 'contract-eval',
      evidence: [{
        file: 'src/components/GuardedButton.ts',
        line: 1,
        endLine: 4,
        snippet: [
          "import { canAccessAdmin } from '../auth'",
          '',
          'export function GuardedButton(permissionIds: string[]) {',
          "  return canAccessAdmin(permissionIds) ? 'enabled' : 'disabled'",
        ].join('\n'),
        tool: 'contract-eval',
        rawConfidence: 0.8,
      }],
    }],
    openQuestions: [],
    observations: [],
    requestedEvidence: { files: [], searches: [] },
    gaps: [],
  })
  const guardedByIngest = runHarnessJson(['ingest', '--package', packageDir, '--analysis', guardedByAnalysis, '--explorer', 'contract-eval', '--round', '1'])
  assertEqual(guardedByIngest.schemaVersion, expectations.ingestSchemaVersion, 'guarded-by ingest schemaVersion')
  assertEqual(guardedByIngest.merged, true, 'guarded-by ingest merged')
  const factGraphAfterGuardedBy = readJson(path.join(packageDir, 'fact-graph.json'))
  assert(factGraphAfterGuardedBy.edges?.[guardedByEdgeId], 'grounded guarded-by fact should remain in FactGraph')

  forceNoExecutableTasks(packageDir)
  const synthesizeStatus = runHarnessJson(['status', '--package', packageDir])
  assertEqual(synthesizeStatus.schemaVersion, expectations.statusSchemaVersion, 'synthesize status schemaVersion')
  assertEqual(synthesizeStatus.nextAction, 'synthesize', 'status nextAction without executable tasks and without synthesis')

  const badSynthesis = path.join(workDir, 'bad-repo-understanding-analysis.json')
  writeJson(badSynthesis, {
    schemaVersion: 'repo-understanding-analysis/v1',
    confidence: 'medium',
    summary: 'Too short.',
    architecture: { style: '', layers: [], components: [], boundaries: [], connections: [] },
    modules: [],
    keyFlows: [],
    risks: [],
    openQuestions: [],
    evidenceRefs: [],
  })
  runHarness(['write-subagent', '--package', packageDir, '--analysis', badSynthesis, '--runtime', 'contract-eval', '--role', 'repo-understander'], { expectExit: 1 })
  assert(!fs.existsSync(path.join(packageDir, 'analyses', 'repo-understanding.json')), 'bad synthesis must not write analyses/repo-understanding.json')
  const indexAfterBadSynthesis = readJson(path.join(packageDir, 'index.json'))
  assert(!indexAfterBadSynthesis.analyses?.repoUnderstanding, 'bad synthesis must not update index analyses.repoUnderstanding')

  const analysisFile = path.join(workDir, 'repo-understanding-analysis.json')
  writeJson(analysisFile, buildValidAnalysis(packageDir))
  const written = runHarnessJson(['write-subagent', '--package', packageDir, '--analysis', analysisFile, '--runtime', 'contract-eval', '--role', 'repo-understander'])
  assertEqual(written.schemaVersion, expectations.writeSubagentSchemaVersion, 'write-subagent schemaVersion')
  assertEqual(written.written, true, 'write-subagent written')
  assertEqual(written.validation.passed, true, 'write-subagent validation passed')

  const doneStatus = runHarnessJson(['status', '--package', packageDir])
  assertEqual(doneStatus.schemaVersion, expectations.statusSchemaVersion, 'done status schemaVersion')
  assertEqual(doneStatus.nextAction, 'done', 'status nextAction with synthesis and no executable tasks')
  assertProjectionProjectCommand(packageDir)

  console.log(JSON.stringify({
    ok: true,
    workDir,
    packageDir,
    checked: [
      expectations.statusSchemaVersion,
      expectations.dispatchSchemaVersion,
      expectations.ingestSchemaVersion,
      expectations.writeSubagentSchemaVersion,
      expectations.explorationAnalysisSchemaVersion,
      expectations.adversarialVerificationSchemaVersion,
      `externalVerifiedTool:${expectations.externalVerifiedTool}`,
      'verifier-spoof:deterministic-tag-sanitized',
      'coding-pool:golden',
      'coding-pool:invalid-evidenceRefs',
      'coding-pool:invalid-producedBy',
      'validateExplorerAnalysis:line-range',
      'ingest:write-lock',
      'ingest:open-question',
      'ingest:guarded-by',
      'export-audit-data:freshness',
      'run-pipeline:confirm-external',
      'run-ce-analysis:shared-ingest',
      'run-ce-analysis:parse-failure',
      'registry:schema-predicate-sync',
      'registry:protocol-anchors',
      'registry:readme-projections',
      'registry:default-mini-repo-golden',
      'registry:disabled-explorer',
      'registry:effort-complete',
      'registry:effort-config-override',
      'dispatch:effort-in-manifest',
      'project:html',
      'nextAction:dispatch',
      'nextAction:synthesize',
      'nextAction:done',
    ],
  }, null, 2))
} catch (error) {
  console.error(error.stack || error.message)
  console.error(`Contract eval workDir: ${workDir}`)
  process.exit(1)
}

function runHarness(args, options = {}) {
  const result = spawnSync(process.execPath, [harnessScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const expected = options.expectExit ?? 0
  if (result.status !== expected) {
    throw new Error([
      `harness ${args.join(' ')} exited ${result.status}, expected ${expected}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result.stdout
}

function runHarnessJson(args, options = {}) {
  const stdout = runHarness(args, options)
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`Expected JSON from harness ${args.join(' ')}:\n${stdout}`)
  }
}

function assertExplorerOutputSchema() {
  const schema = readJson(path.join(repoRoot, 'harnesses', 'repo-understanding', 'schemas', 'explorer-output.schema.json'))
  assertEqual(schema.properties.schemaVersion.const, expectations.explorationAnalysisSchemaVersion, 'explorer output schemaVersion const')
  assertArrayEqual(schema.required, expectations.explorerOutputRequired, 'explorer output required fields')
  const evidenceRequired = schema.properties.facts.items.properties.evidence.items.required
  assertArrayEqual(evidenceRequired, expectations.explorerEvidenceRequired, 'explorer evidence required fields')
  const predicateEnum = schema.properties.facts.items.properties.predicate.enum
  assertArrayEqual(predicateEnum, Object.keys(PREDICATES), 'explorer predicate enum registry sync')
}

function assertVerificationSchema() {
  const schema = readJson(path.join(repoRoot, 'harnesses', 'repo-understanding', 'schemas', 'verification.schema.json'))
  assertEqual(schema.properties.schemaVersion.const, expectations.adversarialVerificationSchemaVersion, 'verification schemaVersion const')
}

function assertRegistryContracts(packageDir) {
  assertRegistryConsumerWiring()
  assertRegistryEffortComplete()
  assertExplorerProtocolAnchors()
  assertReadmeProjectionOutputs()
  assertHarnessConfigExplorerKeys()
  assertMiniRepoRegistryGolden(packageDir)
  assertDisabledExplorerBehavior(packageDir)
  assertUnknownExplorerConfigFails(packageDir)
  assertEffortConfigOverride(packageDir)
}

function assertRegistryEffortComplete() {
  for (const [name, explorer] of Object.entries(EXPLORERS)) {
    assertIncludes(EFFORT_LEVELS, explorer.effort, `registry effort for ${name}`)
    assertEqual(explorerEffort(name), explorer.effort, `explorerEffort default for ${name}`)
  }
  assertEqual(explorerEffort('missing-explorer'), 'medium', 'explorerEffort fallback')
}

function assertDispatchEffortInManifest(dispatch) {
  assert(dispatch.explorers.length > 0, 'dispatch should produce at least one bundle for effort contract')
  for (const bundle of dispatch.explorers) {
    assertIncludes(EFFORT_LEVELS, bundle.effort, `dispatch effort for ${bundle.explorer}`)
    assertEqual(bundle.effort, explorerEffort(bundle.explorer), `dispatch effort registry default for ${bundle.explorer}`)
    assert(bundle.promptPath && fs.existsSync(bundle.promptPath), `dispatch promptPath exists for ${bundle.explorer}`)
    const prompt = fs.readFileSync(bundle.promptPath, 'utf8')
    assert(prompt.includes(`Effort: \`${bundle.effort}\``), `dispatch prompt must include effort for ${bundle.explorer}`)
  }
}

function assertRegistryConsumerWiring() {
  const registry = fs.readFileSync(path.join(repoRoot, 'shared', 'understanding', 'harness-registry.mjs'), 'utf8')
  assert(!/^import\s/m.test(registry), 'harness-registry must not import other modules')
  assert(!/\b(fs|readFile|writeFile|fetch|spawn)\b/.test(registry), 'harness-registry must remain side-effect-free data and pure queries')

  const factHarness = fs.readFileSync(path.join(repoRoot, 'shared', 'understanding', 'fact-graph-harness.mjs'), 'utf8')
  assert(factHarness.includes('pickExplorerForPath'), 'fact-graph-harness explorerForPath must delegate to registry')
  assert(factHarness.includes('explorerBudget'), 'fact-graph-harness explorerTokenBudget must delegate to registry')
  assert(!factHarness.includes("const EDGE_PREDICATES = new Set(["), 'fact-graph-harness must not keep a private predicate set')
  assert(!factHarness.includes("'vue-containment': 12000"), 'fact-graph-harness must not keep a private explorer budget map')

  const explorationCore = fs.readFileSync(path.join(repoRoot, 'shared', 'understanding', 'repo-exploration-core.mjs'), 'utf8')
  assert(explorationCore.includes('factExplorerNames'), 'repo-exploration-core explorer enum must derive from registry')
  assert(explorationCore.includes('validPredicateSet'), 'repo-exploration-core predicate validation must derive from registry')

  const readableHtml = fs.readFileSync(path.join(repoRoot, 'shared', 'understanding', 'human-readable-html.mjs'), 'utf8')
  assert(readableHtml.includes('EXPLORERS') && readableHtml.includes('PREDICATES'), 'human-readable translations must derive from registry')

  const harnessCli = fs.readFileSync(harnessScript, 'utf8')
  assert(harnessCli.includes('projectionNames'), 'harness project whitelist must derive from registry projections')
  assert(harnessCli.includes('explorerEnabled'), 'harness executable gap filtering must honor registry enabled state')
}

function assertExplorerProtocolAnchors() {
  const markdown = fs.readFileSync(path.join(repoRoot, 'skills', 'repo-explorer', 'references', 'explorer-protocol.md'), 'utf8')
  for (const [predicate, meta] of Object.entries(PREDICATES)) {
    const anchor = meta.protocolAnchor || predicate
    assert(protocolHeadingHasAnchor(markdown, anchor), `explorer protocol missing heading anchor for predicate: ${predicate}`)
  }
}

function protocolHeadingHasAnchor(markdown, anchor) {
  const pattern = new RegExp(`^###\\s+.*\`${escapeRegExp(anchor)}\``, 'm')
  return pattern.test(markdown)
}

function assertReadmeProjectionOutputs() {
  const readme = fs.readFileSync(path.join(repoRoot, 'harnesses', 'repo-understanding', 'README.md'), 'utf8')
  const outputSection = readme.split('## Output Contract')[1]?.split('\n## ')[0] || ''
  for (const projection of Object.values(PROJECTIONS)) {
    assert(outputSection.includes(projection.output), `README Output Contract missing projection output: ${projection.output}`)
  }
}

function assertHarnessConfigExplorerKeys() {
  const config = readJson(harnessConfigPath)
  const unknown = Object.keys(config.explorers || {}).filter(name => !EXPLORERS[name])
  assertEqual(unknown.length, 0, `harness.config explorers must be registry keys: ${unknown.join(', ')}`)
}

function assertMiniRepoRegistryGolden(packageDir) {
  const goldenDir = path.join(repoRoot, 'evals', 'fixtures', 'golden', 'mini-repo-registry-baseline')
  for (const file of ['fact-graph.json', 'gap-queue.json', 'render-graph.json', 'knowledge-index.json']) {
    const actual = normalizeRegistryGolden(readJson(path.join(packageDir, file)))
    const expected = normalizeRegistryGolden(readJson(path.join(goldenDir, file)))
    assertJsonEqual(actual, expected, `mini-repo registry baseline ${file}`)
  }
}

function assertDisabledExplorerBehavior(packageDir) {
  const disabledExplorer = 'route-binding'
  const disabledPackage = copyFixture(packageDir, 'registry-disabled-package')
  const gapQueue = readJson(path.join(disabledPackage, 'gap-queue.json'))
  const disabledTasks = (gapQueue.tasks || []).filter(task => task.explorer === disabledExplorer)
  assert(disabledTasks.length > 0, `${disabledExplorer} fixture tasks should exist before disabled-explorer contract`)

  withTemporaryHarnessConfig(config => {
    config.explorers = { ...(config.explorers || {}) }
    config.explorers[disabledExplorer] = { ...(config.explorers[disabledExplorer] || {}), enabled: false }
    return config
  }, () => {
    const status = runHarnessJson(['status', '--package', disabledPackage])
    assert(status.tasks.openDisabled >= disabledTasks.length, 'disabled explorer tasks should be counted as openDisabled')
    assert(status.tasks.executableOpen < (gapQueue.openTaskCount || gapQueue.tasks.length), 'disabled explorer tasks should not count as executable')

    const dispatch = runHarnessJson(['dispatch', '--package', disabledPackage, '--max-tasks', '40'])
    assert(!dispatch.explorers.some(item => item.explorer === disabledExplorer), 'dispatch must skip disabled explorer bundles')

    const onlyDisabled = {
      ...gapQueue,
      tasks: disabledTasks.map(task => ({ ...task, status: 'open', dispatch: undefined })),
    }
    onlyDisabled.taskCount = onlyDisabled.tasks.length
    onlyDisabled.openTaskCount = onlyDisabled.tasks.length
    onlyDisabled.dispatchedTaskCount = 0
    writeJson(path.join(disabledPackage, 'gap-queue.json'), onlyDisabled)

    const disabledOnlyStatus = runHarnessJson(['status', '--package', disabledPackage])
    assertEqual(disabledOnlyStatus.tasks.executableOpen, 0, 'only disabled tasks executableOpen')
    assertEqual(disabledOnlyStatus.tasks.openDisabled, disabledTasks.length, 'only disabled tasks openDisabled')
    assertEqual(disabledOnlyStatus.nextAction, 'synthesize', 'only disabled tasks should converge to synthesize')
  })

  const restoredStatus = runHarnessJson(['status', '--package', disabledPackage])
  assertEqual(restoredStatus.tasks.executableOpen, disabledTasks.length, 'reenabled explorer tasks should become executable again')
  assertEqual(restoredStatus.nextAction, 'dispatch', 'reenabled explorer tasks should restore dispatch nextAction')
}

function assertUnknownExplorerConfigFails(packageDir) {
  withTemporaryHarnessConfig(config => {
    config.explorers = { ...(config.explorers || {}), 'typo-explorer': { enabled: true, tokenBudget: 1 } }
    return config
  }, () => {
    runHarness(['status', '--package', packageDir], { expectExit: 1 })
  })
}

function assertEffortConfigOverride(packageDir) {
  const effortPackage = copyFixture(packageDir, 'registry-effort-package')
  const gapQueue = readJson(path.join(effortPackage, 'gap-queue.json'))
  const taskExplorer = (gapQueue.tasks || [])
    .map(task => task.explorer)
    .find(name => EXPLORERS[name] && explorerEffort(name) !== 'high')
  assert(taskExplorer, 'fixture should have at least one non-high explorer task for effort override contract')

  withTemporaryHarnessConfig(config => {
    config.explorers = { ...(config.explorers || {}) }
    config.explorers[taskExplorer] = { ...(config.explorers[taskExplorer] || {}), effort: 'high' }
    return config
  }, () => {
    const dispatch = runHarnessJson(['dispatch', '--package', effortPackage, '--max-tasks', '40', '--explorers', taskExplorer])
    const bundle = dispatch.explorers.find(item => item.explorer === taskExplorer)
    assert(bundle, `effort override dispatch should include ${taskExplorer}`)
    assertEqual(bundle.effort, 'high', `effort override for ${taskExplorer}`)
  })

  withTemporaryHarnessConfig(config => {
    config.explorers = { ...(config.explorers || {}) }
    config.explorers[taskExplorer] = { ...(config.explorers[taskExplorer] || {}), effort: 'ultra' }
    return config
  }, () => {
    runHarness(['status', '--package', effortPackage], { expectExit: 1 })
  })
}

function assertProjectionProjectCommand(packageDir) {
  fs.rmSync(path.join(packageDir, 'human-readable.html'), { force: true })
  runHarness(['project', '--package', packageDir, '--only', 'html'])
  assert(fs.existsSync(path.join(packageDir, 'human-readable.html')), 'project --only html should write human-readable.html')

  runHarness(['project', '--package', packageDir, '--only', 'all'])
  for (const projection of Object.values(PROJECTIONS)) {
    const output = path.join(packageDir, projection.output)
    assert(fs.existsSync(output), `project --only all missing projection output: ${projection.output}`)
  }
  runHarness(['project', '--package', packageDir, '--only', 'bogus'], { expectExit: 1 })
}

function withTemporaryHarnessConfig(mutator, fn) {
  const original = fs.readFileSync(harnessConfigPath, 'utf8')
  try {
    const next = mutator(JSON.parse(original))
    writeJson(harnessConfigPath, next)
    return fn()
  } finally {
    fs.writeFileSync(harnessConfigPath, original, 'utf8')
  }
}

function assertExternalVerifierTrustBoundary() {
  const source = fs.readFileSync(path.join(repoRoot, 'shared', 'understanding', 'fact-graph-harness.mjs'), 'utf8')
  const expected = `edge.metadata?.verification?.tool === '${expectations.externalVerifiedTool}'`
  assert(source.includes(expected), `isExternalVerified must trust only ${expectations.externalVerifiedTool}`)
  assert(!source.includes("edge.metadata?.verification?.tool === 'repo-fact-verifier'"), 'repo-fact-verifier must not disable deterministic G3')
}

function assertCodingPoolGoldenGate() {
  const fixtureRoot = path.join(repoRoot, 'evals', 'fixtures', 'coding-pool')
  const golden = readJson(path.join(repoRoot, 'evals', 'fixtures', 'golden', 'coding-pool.golden.json'))
  const validPool = copyFixture(path.join(fixtureRoot, 'valid'), 'coding-pool-valid')
  runNode(normalizeCodingPoolScript, ['--pool', validPool])
  const normalized = readJson(path.join(validPool, 'facts', 'coding-pool.json'))
  assertJsonEqual(normalized.agentAnalyses, golden.agentAnalyses, 'coding-pool normalized agentAnalyses golden')

  const invalidEmptyEvidence = copyFixture(path.join(fixtureRoot, 'invalid-empty-evidence'), 'coding-pool-invalid-empty-evidence')
  runNode(normalizeCodingPoolScript, ['--pool', invalidEmptyEvidence], { expectExit: 2 })

  const invalidProducedBy = copyFixture(path.join(fixtureRoot, 'invalid-produced-by'), 'coding-pool-invalid-produced-by')
  runNode(normalizeCodingPoolScript, ['--pool', invalidProducedBy], { expectExit: 2 })
}

function assertAuditExportGate() {
  const poolDir = path.join(workDir, 'datasource', 'pools', 'coding')
  fs.mkdirSync(path.join(poolDir, 'facts'), { recursive: true })
  fs.mkdirSync(path.join(poolDir, 'analyses'), { recursive: true })
  writeJson(path.join(poolDir, 'facts', 'repositories.json'), [])
  writeJson(path.join(poolDir, 'facts', 'relationships.json'), [])
  writeJson(path.join(poolDir, 'facts', 'findings.json'), [])
  writeJson(path.join(poolDir, 'facts', 'runs.json'), [])
  const codingPoolPath = path.join(poolDir, 'facts', 'coding-pool.json')
  writeJson(codingPoolPath, {
    schemaVersion: 'coding-pool/v1',
    generatedAt: new Date().toISOString(),
    workspace: { name: 'contract-eval', root: fixtureRepo },
    runs: [],
    repositories: [],
    relationships: [],
    findings: [],
    agentAnalyses: [],
  })
  const staleTime = new Date(Date.now() - 10000)
  fs.utimesSync(codingPoolPath, staleTime, staleTime)
  writeJson(path.join(poolDir, 'analyses', 'newer.json'), [{
    id: 'analysis:contract-eval',
    subject: { type: 'repo', id: 'repo:contract-eval' },
    producedBy: 'subagent',
    evidenceRefs: ['evidence:raw:contract'],
    claim: 'Contract eval analysis',
    rationale: 'Used to prove audit export freshness gate.',
    confidence: 'low',
    createdAt: new Date().toISOString(),
  }])
  runNode(auditExportScript, ['--pool', poolDir, '--out', path.join(workDir, 'audit-data.json')], { expectExit: 2 })
}

function assertExternalRunGate() {
  runNode(datasourcePipelineScript, [
    '--workspace', fixtureRepo,
    '--datasource', path.join(workDir, 'blocked-datasource'),
    '--run-ce',
    '--ce-subject', 'repo:contract-eval',
    '--ce-task', 'architecture-risk',
  ], { expectExit: 2, env: { ...process.env, AGENTIC_CONFIRM_EXTERNAL: '' } })
}

function assertCeParseFailureGate() {
  const fakeCli = path.join(workDir, 'fake-ce-cli.mjs')
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('fake-ce-cli 1.0.0')
  process.exit(0)
}
const payloadIndex = args.indexOf('-j')
const payload = payloadIndex >= 0 ? JSON.parse(args[payloadIndex + 1] || '{}') : {}
if (payload.op === 'start') {
  console.log(JSON.stringify({ session_id: 'contract-session' }))
  process.exit(0)
}
if (payload.op === 'wait') {
  console.log('not structured json')
  process.exit(0)
}
console.error('unknown op')
process.exit(2)
`)
  fs.chmodSync(fakeCli, 0o755)
  const datasource = path.join(workDir, 'ce-parse-failure-datasource')
  runNode(ceBridgeScript, [
    '--datasource', datasource,
    '--pool', 'coding',
    '--subject', 'repo:contract-eval',
    '--task', 'parse-failure',
    '--ce-cli', fakeCli,
    '--timeout', '1',
  ], { expectExit: 2 })
  const poolDir = path.join(datasource, 'pools', 'coding')
  const analysisDir = path.join(poolDir, 'analyses')
  assert(!fs.existsSync(analysisDir) || fs.readdirSync(analysisDir).length === 0, 'CE parse failure must not write analyses')
  const rawRoot = path.join(poolDir, 'raw', 'ce-runs')
  const failedMarkers = fs.readdirSync(rawRoot)
    .map(name => path.join(rawRoot, name, 'ce-run-failed.json'))
    .filter(file => fs.existsSync(file))
  assert(failedMarkers.length === 1, 'CE parse failure should write ce-run-failed.json')
}

function assertCeSharedIngestGate() {
  const source = fs.readFileSync(ceBridgeScript, 'utf8')
  assert(source.includes('ingestAgentAnalyses'), 'CE bridge should use shared datasource ingest')
  assert(!source.includes('function normalizeAnalyses'), 'CE bridge must not keep private normalizeAnalyses')
  assert(!source.includes('function subjectFromId'), 'CE bridge must not keep private subjectFromId')

  const fakeCli = path.join(workDir, 'fake-ce-cli-valid.mjs')
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('fake-ce-cli 1.0.0')
  process.exit(0)
}
const payloadIndex = args.indexOf('-j')
const payload = payloadIndex >= 0 ? JSON.parse(args[payloadIndex + 1] || '{}') : {}
if (payload.op === 'start') {
  console.log(JSON.stringify({ session_id: 'contract-session' }))
  process.exit(0)
}
if (payload.op === 'wait') {
  console.log(JSON.stringify([{ claim: 'CE shared ingest contract', rationale: 'Valid CE JSON is written through the shared datasource ingest gate.', confidence: 'medium' }]))
  process.exit(0)
}
console.error('unknown op')
process.exit(2)
`)
  fs.chmodSync(fakeCli, 0o755)
  const datasource = path.join(workDir, 'ce-shared-ingest-datasource')
  runNode(ceBridgeScript, [
    '--datasource', datasource,
    '--pool', 'coding',
    '--subject', 'repo:contract-eval',
    '--task', 'shared-ingest',
    '--ce-cli', fakeCli,
    '--timeout', '1',
  ])
  const analysisDir = path.join(datasource, 'pools', 'coding', 'analyses')
  const files = fs.readdirSync(analysisDir).filter(file => file.endsWith('.json'))
  assertEqual(files.length, 1, 'CE shared ingest analysis file count')
  const records = readJson(path.join(analysisDir, files[0]))
  assertEqual(records[0].producedBy, 'subagent', 'CE shared ingest producedBy')
  assert(Array.isArray(records[0].evidenceRefs) && records[0].evidenceRefs.length > 0, 'CE shared ingest evidenceRefs')
}

function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: options.env || process.env,
  })
  const expected = options.expectExit ?? 0
  if (result.status !== expected) {
    throw new Error([
      `node ${path.relative(repoRoot, script)} ${args.join(' ')} exited ${result.status}, expected ${expected}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result.stdout
}

function copyFixture(source, name) {
  const target = path.join(workDir, name)
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true })
  return target
}

function forceNoExecutableTasks(root) {
  const gapQueuePath = path.join(root, 'gap-queue.json')
  const gapQueue = readJson(gapQueuePath)
  gapQueue.tasks = []
  gapQueue.taskCount = 0
  gapQueue.openTaskCount = 0
  gapQueue.dispatchedTaskCount = 0
  gapQueue.coverageScore = Math.max(gapQueue.coverageThreshold || 0.85, 0.95)
  writeJson(gapQueuePath, gapQueue)

  const factGraphPath = path.join(root, 'fact-graph.json')
  const factGraph = readJson(factGraphPath)
  factGraph.stats = {
    ...(factGraph.stats || {}),
    coverageScore: gapQueue.coverageScore,
  }
  writeJson(factGraphPath, factGraph)
}

function buildValidAnalysis(root) {
  const inventory = readJson(path.join(root, 'static', 'inventory.json'))
  const knowledgeIndex = readJson(path.join(root, 'static', 'knowledge-index.json'))
  const evidenceRef = knowledgeIndex.evidenceRefs.find(ref => ref.id)?.id
  const keyFile = inventory.files.find(file => !file.protected && file.path === 'src/main.ts')
    || inventory.files.find(file => !file.protected)
  assert(evidenceRef, 'fixture package should have an evidence ref')
  assert(keyFile, 'fixture package should have a non-protected key file')
  return {
    schemaVersion: 'repo-understanding-analysis/v1',
    confidence: 'medium',
    summary: 'This fixture repository is a compact frontend-style codebase used to lock the repo-understanding harness contract. It contains an entrypoint, router, auth guard, API request helper, protected metadata-only configuration, and mock route data so contract checks can exercise package projection without relying on a large real repository.',
    architecture: {
      style: 'frontend fixture',
      layers: [{
        name: 'Application shell',
        purpose: 'Entrypoint, router, auth guard, and API helper used by the contract eval.',
        evidenceRefs: [evidenceRef],
      }],
      components: [{
        name: 'Mini app',
        type: 'frontend',
        responsibility: 'Small fixture component set for harness contract checks.',
        keyFiles: [keyFile.path],
        evidenceRefs: [evidenceRef],
      }],
      boundaries: [],
      connections: [],
    },
    modules: [{
      name: 'src',
      responsibility: 'Fixture source files for routing, guard, and request examples.',
      keyFiles: [keyFile.path],
      evidenceRefs: [evidenceRef],
    }],
    keyFlows: [{
      name: 'Entrypoint to guarded route',
      steps: [
        'src/main.ts creates the router and checks admin access.',
        'src/router.ts binds the admin route to its page and guard.',
      ],
      evidenceRefs: [evidenceRef],
    }, {
      name: 'Entrypoint to API helper',
      steps: [
        'src/main.ts invokes the invoice API helper.',
        'src/api.ts delegates the request to the shared request helper.',
      ],
      evidenceRefs: [evidenceRef],
    }],
    risks: [{
      title: 'Fixture-only runtime confidence',
      severity: 'low',
      rationale: 'The repository is intentionally small and exists for contract checks rather than runtime validation.',
      evidenceRefs: [evidenceRef],
    }],
    openQuestions: [],
    evidenceRefs: [evidenceRef],
  }
}

function normalizeRegistryGolden(value) {
  if (Array.isArray(value)) return value.map(normalizeRegistryGolden)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (['generatedAt', 'analyzedAt', 'firstSeen', 'lastConfirmed', 'head', 'repoId'].includes(key)) {
      output[key] = '<volatile>'
    } else {
      output[key] = normalizeRegistryGolden(value[key])
    }
  }
  return output
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function edgeId(subject, predicate, object) {
  return `edge:${hashText(`${subject}|${predicate}|${object}`).slice(0, 16)}`
}

function hashText(value) {
  return createHash('sha1').update(String(value)).digest('hex')
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertIncludes(values, actual, label) {
  if (!values.includes(actual)) throw new Error(`${label}: ${JSON.stringify(actual)} not in ${JSON.stringify(values)}`)
}

function assertArrayEqual(actual, expected, label) {
  assert(Array.isArray(actual), `${label}: actual is not an array`)
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertJsonEqual(actual, expected, label) {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText !== expectedText) throw new Error(`${label}: expected ${expectedText}, got ${actualText}`)
}
