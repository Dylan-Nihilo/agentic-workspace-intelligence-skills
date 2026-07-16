// Deterministic command implementation. Agent execution remains owned by the host runtime.
import http from 'node:http'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultPackageDir,
  parseCommonArgs,
  prepareFrontendCensusPackage,
} from '../../repo-understanding-kernel/src/census/frontend-census.mjs'
import { generateHumanReadableHtml } from '../../repo-understanding-kernel/src/projections/human-readable-html.mjs'
import { generateRepositoryAtlasHtml } from '../../repo-understanding-kernel/src/projections/repository-atlas-html.mjs'
import { writeProductMaps } from '../../repo-understanding-kernel/src/projections/product-maps.mjs'
import {
  acceptWorkResult,
  appendRunEvent,
  buildAgentDebugSummary,
  createWorkItem,
  ensureWorkflow,
  planAndIssueWorkItem,
  recordAgentTrace,
  recordCompletionFromWorkResult,
  rejectWorkResult,
  syncProducedResults,
  validateWorkResultEnvelope,
} from '../../repo-understanding-kernel/src/workflow/workflow-store.mjs'
import {
  writeDerivedJourneyCandidates,
  writeJourneyStore,
} from '../../repo-understanding-kernel/src/knowledge/journey-store.mjs'
import { snapshotIdForInventory } from '../../repo-understanding-kernel/src/snapshot/repo-snapshot.mjs'
import {
  buildRepoSupportDecision,
  validateRepoSupportDecision,
} from '../../repo-understanding-kernel/src/census/frontend-support.mjs'
import {
  buildFrontendInvestigationFrame,
  validateRepoInvestigationFrame,
} from '../../repo-understanding-kernel/src/census/investigation-frame.mjs'
import {
  buildStaticProgramGraph,
  validateStaticProgramGraph,
  writeStaticProgramGraph,
} from '../../repo-understanding-kernel/src/census/static-program-graph.mjs'
import {
  buildCommunityArtifacts,
  writeCommunityArtifacts,
} from '../../repo-understanding-kernel/src/graph/community-planner.mjs'
import {
  buildResearchContracts,
  qualifyOpenQuestions,
  writeResearchPlan,
} from '../../repo-understanding-kernel/src/planning/research-contract-planner.mjs'
import { validateTaskOutcome } from '../../repo-understanding-kernel/src/validation/task-outcome-validator.mjs'
import { validateSynthesisNarrative } from '../../repo-understanding-kernel/src/validation/synthesis-narrative-validator.mjs'
import {
  ingestGovernedHypotheses,
  initializeSemanticStore,
  loadSemanticStore,
} from '../../repo-understanding-kernel/src/knowledge/semantic-store.mjs'
import {
  verifyFrontendPackage,
  writeFrontendVerification,
} from '../../repo-understanding-kernel/src/verification/frontend-package-verifier.mjs'
import {
  buildNodeSemanticBatchPlan,
  writeNodeSemanticBatchPlan,
} from '../../repo-understanding-kernel/src/planning/node-semantic-batch-planner.mjs'
import {
  acceptRepositoryZoneCatalog,
  buildRepositoryZoneAgentContext,
  buildRepositoryZoneAgentPlan,
  repositoryZoneCatalogHash,
  validateRepositoryZoneDraft,
  validateRepositoryZoneReview,
  writeRepositoryZoneAgentContext,
  writeRepositoryZoneAgentPlan,
  writeRepositoryZones,
} from '../../repo-understanding-kernel/src/planning/repository-zones.mjs'
import { buildNodeSemanticContext } from '../../repo-understanding-kernel/src/knowledge/node-semantic-context.mjs'
import {
  acceptNodeSemanticBatchCatalog,
  mergeNodeSemanticCatalogs,
  validateNodeSemanticBatchDraft,
  writeNodeSemanticCatalog,
} from '../../repo-understanding-kernel/src/knowledge/node-semantic-catalog.mjs'
import { nodeSemanticCatalogHash, validateNodeSemanticReview } from '../../repo-understanding-kernel/src/knowledge/node-semantic-review.mjs'

const COMMAND_DIR = path.dirname(fileURLToPath(import.meta.url))
const SUITE_ROOT = path.resolve(COMMAND_DIR, '../../..')
const KERNEL_DIR = path.join(SUITE_ROOT, 'packages', 'repo-understanding-kernel')
const PRODUCT_PROJECTION_NAMES = new Set(['application', 'experience', 'runtime-flow', 'change', 'maps'])
const LEGACY_FRONTEND_FILES = [
  'gap-queue.json',
  'validation.json',
  'verification.json',
  'incremental.json',
  'store/knowledge-manifest.json',
  'store/repo-snapshot.json',
  'static/scan-policy.json',
  'views/fact-graph.json',
  'views/render-graph.json',
  'views/architecture.json',
  'views/domain.json',
  'views/flows.json',
  'views/knowledge-index.jsonl',
]
const LEGACY_FRONTEND_DIRECTORIES = ['analyses', 'exploration', 'scout', 'wiki']

function usage(exitCode = 1) {
  console.error(`Usage:
  harness scout --repo /path/to/repo [--out /path/to/package] [--max-files 16000]
  harness analyze --repo /path/to/repo [--out /path/to/package] [--max-files 16000] [--mode fast|deep] [--incremental] [--base HEAD]
  harness project --package /path/to/package [--only application|experience|runtime-flow|change|maps|html|all]
  harness status --package /path/to/package
  harness journeys --package /path/to/package --definitions /path/to/definitions.json --bindings /path/to/bindings.json
  harness dispatch --package /path/to/package [--max-tasks 40] [--contract contract:id]
  harness synthesize --package /path/to/package
  harness ingest --package /path/to/package --work-result /path/to/work-result.json
  harness retry --package /path/to/package --item work:id
  harness trace --package /path/to/package --item work:id --event started|completed|failed [--runtime name] [--model name] [--session id] [--input-tokens n] [--output-tokens n] [--cached-input-tokens n] [--reasoning-tokens n] [--total-tokens n] [--cost-usd n] [--duration-ms n]
  harness debug --package /path/to/package
  harness report --package /path/to/package [--out /path/to/report.md]
  harness atlas --package /path/to/package [--out /path/to/repository-atlas.html]
  harness semantic-plan --package /path/to/package [--max-files 8] [--max-source-bytes 262144]
  harness zone-plan --package /path/to/package [--max-zones 24] [--max-subzones 96]
  harness zone-review-plan --package /path/to/package
  harness zone-ingest --package /path/to/package
  harness semantic-review-plan --package /path/to/package
  harness semantic-ingest --package /path/to/package
  harness html --package /path/to/package [--out /path/to/human-readable.html]
  harness verify --package /path/to/package
  harness serve --package /path/to/package [--port 8787]`)
  process.exit(exitCode)
}

async function main() {
  const command = process.argv[2]
  if (!command) usage()
  if (command === '--help' || command === '-h') usage(0)
  const argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)]
  if (command === 'scout') return scout(argv)
  if (command === 'analyze') return analyze(argv)
  if (command === 'project') return project(argv)
  if (command === 'status') return status(argv)
  if (command === 'journeys') return journeys(argv)
  if (command === 'dispatch') return dispatch(argv)
  if (command === 'synthesize') return synthesize(argv)
  if (command === 'ingest') return ingest(argv)
  if (command === 'retry') return retry(argv)
  if (command === 'trace') return trace(argv)
  if (command === 'debug') return debug(argv)
  if (command === 'report') return report(argv)
  if (command === 'atlas') return atlas(argv)
  if (command === 'semantic-plan') return semanticPlan(argv)
  if (command === 'zone-plan') return zonePlan(argv)
  if (command === 'zone-review-plan') return zoneReviewPlan(argv)
  if (command === 'zone-ingest') return zoneIngest(argv)
  if (command === 'semantic-review-plan') return semanticReviewPlan(argv)
  if (command === 'semantic-ingest') return semanticIngest(argv)
  if (command === 'html') return html(argv)
  if (command === 'verify') return verify(argv)
  if (command === 'serve') return serve(argv)
  usage()
}

async function analyze(argv) {
  const args = parseArgs(argv, ['repo'])
  const repoPath = path.resolve(args.repo)
  const outDir = args.out ? path.resolve(args.out) : defaultPackageDir(repoPath)
  assertNoActiveWorkflowForAnalyze(outDir)
  const maxFiles = args['max-files'] ? Number(args['max-files']) : 16000
  if (!Number.isFinite(maxFiles)) usage()
  const gate = await prepareFrontendGate({ repoPath, outDir, maxFiles })
  purgeLegacyFrontendArtifacts(outDir)
  if (gate.supportDecision.supportLevel === 'unsupported') {
    const atlasResult = generateRepositoryAtlasHtml({ packageDir: outDir })
    console.log(`Unsupported repository: ${repoPath}`)
    console.log(`Reason: ${gate.supportDecision.unsupportedReason}`)
    console.log(`Package: ${outDir}`)
    console.log('No ResearchContract or agent work was dispatched.')
    console.log(`Repository Atlas: ${atlasResult.output}`)
    return
  }
  const mode = args.mode || 'fast'
  if (!['fast', 'deep'].includes(mode)) usage()
  const incremental = args.incremental
    ? {
        schemaVersion: 'repo-static-invalidation/v1',
        base: args.base || 'HEAD',
        changedFiles: gitChangedFiles(repoPath, args.base || 'HEAD'),
        rebuild: 'deterministic-static-program-graph',
      }
    : null
  if (incremental) writeStaticInvalidationReport(outDir, incremental, gate.staticProgramGraph)
  const semanticStore = initializeSemanticStore({
    packageDir: outDir,
    staticProgramGraph: gate.staticProgramGraph,
    inventory: gate.inventory,
  })
  appendRunEvent(outDir, 'census-completed', {
    inventoryPath: 'static/inventory.json',
    fileCount: gate.inventory.files.length,
    reused: false,
  })
  appendRunEvent(outDir, 'static-graph-built', {
    graphPath: 'static/static-program-graph.json',
    graphId: gate.staticProgramGraph.graphId,
    nodeCount: gate.staticProgramGraph.nodes.length,
    edgeCount: gate.staticProgramGraph.edges.length,
    diagnosticCount: gate.staticProgramGraph.diagnostics.length,
    communityMapPath: 'static/community-map.json',
    neighborMapPath: 'static/neighbor-map.json',
    communityCount: gate.communityMap.communities.length,
  })
  const qualified = qualifyOpenQuestions({
    investigationFrame: gate.investigationFrame,
    snapshotId: gate.snapshotId,
  })
  const openQuestions = qualified.openQuestions
  const contracts = buildResearchContracts({
    snapshotId: gate.snapshotId,
    investigationFrame: gate.investigationFrame,
    openQuestions,
    deterministicContextRefs: [
      'static/support-decision.json',
      'static/investigation-frame.json',
      'static/static-program-graph.json',
      'static/community-map.json',
      'static/neighbor-map.json',
      'static/inventory.json',
      'static/code-map.json',
    ],
  })
  const researchPlan = writeResearchPlan(outDir, {
    snapshotId: gate.snapshotId,
    investigationFrameId: gate.investigationFrame.frameId,
    openQuestions,
    deterministicDiagnostics: qualified.deterministicDiagnostics,
    contracts,
  })
  for (const question of openQuestions) {
    appendRunEvent(outDir, question.lifecycleStatus === 'blocked' ? 'question-blocked' : 'question-qualified', { question })
  }
  for (const ref of researchPlan.contractRefs) {
    const contract = readJson(path.join(outDir, ref.path))
    appendRunEvent(outDir, 'research-contracted', { contract, path: ref.path })
    for (const questionId of ref.questionIds) appendRunEvent(outDir, 'question-planned', { questionId, contractId: ref.contractId })
  }
  for (const closure of gate.journeyStore?.closureReports || []) {
    const journey = gate.journeyStore.definitions.find(item => item.journeyId === closure.journeyId)
    appendRunEvent(outDir, closure.status === 'closed' ? 'journey-closed' : 'journey-reopened', {
      journey,
      closure,
    }, { actor: 'kernel' })
  }
  writeRunConfig(outDir, mode)
  const { verification: validation } = writeFrontendVerification({ packageDir: outDir, phase: 'analysis' })
  appendRunEvent(outDir, validation.passed ? 'verification-passed' : 'verification-failed', {
    phase: validation.phase,
    issueCount: validation.issues.length,
  }, { actor: 'kernel' })
  const atlasResult = generateRepositoryAtlasHtml({ packageDir: outDir })
  console.log(`Analyzed ${repoPath}`)
  console.log(`Package: ${outDir}`)
  console.log(`Analysis mode: ${mode}`)
  if (incremental) console.log(`Incremental diff files: ${incremental.changedFiles.length}; Static Program Graph rebuilt deterministically`)
  console.log(`Static Program Graph: ${gate.staticProgramGraph.nodes.length} nodes, ${gate.staticProgramGraph.edges.length} edges, ${gate.staticProgramGraph.diagnostics.length} diagnostics`)
  console.log(`Semantic store: ${semanticStore.manifest.counts.acceptedClaims} accepted claims, ${semanticStore.manifest.counts.evidence} evidence records`)
  console.log(`Questions/contracts: ${openQuestions.length}/${contracts.length}`)
  console.log(`Repository Atlas: ${atlasResult.output}`)
  console.log(`Validation passed: ${validation.passed}`)
  if (!validation.passed) process.exitCode = 2
}

async function scout(argv) {
  const args = parseArgs(argv, ['repo'])
  const repoPath = path.resolve(args.repo)
  const outDir = args.out ? path.resolve(args.out) : defaultPackageDir(repoPath)
  const maxFiles = args['max-files'] ? Number(args['max-files']) : 16000
  if (!Number.isFinite(maxFiles)) usage()
  const gate = await prepareFrontendGate({ repoPath, outDir, maxFiles })
  const {
    result,
    supportDecision,
    investigationFrame,
    staticProgramGraph,
    communityMap,
    neighborMap,
    journeyStore,
    supportDecisionPath,
    investigationFramePath,
    staticProgramGraphPath,
    communityMapPath,
    neighborMapPath,
  } = gate
  const atlasResult = generateRepositoryAtlasHtml({ packageDir: outDir })
  const nextAction = supportDecision.supportLevel === 'unsupported' ? 'unsupported' : 'analyze'
  console.log(JSON.stringify({
    ...result,
    schemaVersion: 'repo-frontend-scout/v1',
    nextAction,
    supportDecision,
    investigationFrame,
    staticProgramGraph,
    communityMap,
    neighborMap,
    journeyStore: journeyStore ? {
      manifest: journeyStore.manifest,
      closureSet: journeyStore.closureSet,
      diagnostics: journeyStore.diagnostics,
    } : null,
    supportDecisionPath,
    investigationFramePath,
    staticProgramGraphPath,
    communityMapPath,
    neighborMapPath,
    workItem: null,
    repositoryAtlas: atlasResult.output,
    debug: debugPointers(outDir),
  }, null, 2))
}

async function prepareFrontendGate({ repoPath, outDir, maxFiles }) {
  const result = prepareFrontendCensusPackage({ repoPath, outDir, maxFiles })
  const inventory = readJson(path.join(outDir, 'static', 'inventory.json'))
  const codeMap = readJson(path.join(outDir, 'static', 'code-map.json'))
  const profile = readJson(result.profilePath)
  const snapshotId = snapshotIdForInventory(inventory)
  const supportDecision = buildRepoSupportDecision({ inventory, codeMap, profile, snapshotId })
  const supportIssues = validateRepoSupportDecision(supportDecision)
  if (supportIssues.length) throw new Error(`Frontend support decision is invalid:\n- ${supportIssues.join('\n- ')}`)
  const supportDecisionPath = path.join(outDir, 'static', 'support-decision.json')
  fs.writeFileSync(supportDecisionPath, `${JSON.stringify(supportDecision, null, 2)}\n`, 'utf8')
  const staticProgramGraph = await buildStaticProgramGraph({
    repoPath,
    inventory,
    codeMap,
    profile,
    supportDecision,
    snapshotId,
  })
  const staticGraphIssues = validateStaticProgramGraph(staticProgramGraph)
  if (staticGraphIssues.length) throw new Error(`Static Program Graph is invalid:\n- ${staticGraphIssues.join('\n- ')}`)
  const staticProgramGraphPath = writeStaticProgramGraph({ graph: staticProgramGraph, packageDir: outDir })
  const communityArtifacts = buildCommunityArtifacts({ staticProgramGraph, maxDepth: 1 })
  const communityPaths = writeCommunityArtifacts({ ...communityArtifacts, packageDir: outDir })
  const investigationFrame = buildFrontendInvestigationFrame({
    inventory,
    codeMap,
    profile,
    supportDecision,
    staticProgramGraph,
    communityMap: communityArtifacts.communityMap,
    neighborMap: communityArtifacts.neighborMap,
    snapshotId,
    supportDecisionRef: 'static/support-decision.json',
  })
  const frameIssues = validateRepoInvestigationFrame(investigationFrame)
  if (frameIssues.length) throw new Error(`Frontend investigation frame is invalid:\n- ${frameIssues.join('\n- ')}`)
  const investigationFramePath = path.join(outDir, 'static', 'investigation-frame.json')
  fs.writeFileSync(investigationFramePath, `${JSON.stringify(investigationFrame, null, 2)}\n`, 'utf8')
  const journeyStore = supportDecision.supportLevel === 'unsupported'
    ? null
    : writeDerivedJourneyCandidates({
        packageDir: outDir,
        staticProgramGraph,
        investigationFrame,
        snapshotId,
      })
  let workflow = ensureWorkflow(outDir, {
    snapshotId,
    allowSnapshotTransition: true,
    transitionReason: 'frontend-support-gate',
  })
  if (!workflow.supportDecision) {
    appendRunEvent(outDir, 'snapshot-created', { snapshotId, inventoryPath: 'static/inventory.json' })
    appendRunEvent(outDir, 'support-decided', { decision: supportDecision, path: 'static/support-decision.json' })
    appendRunEvent(outDir, 'investigation-frame-built', { frame: investigationFrame, path: 'static/investigation-frame.json' })
    workflow = ensureWorkflow(outDir)
  }
  if (supportDecision.supportLevel === 'unsupported' && workflow.terminal !== 'unsupported') {
    appendRunEvent(outDir, 'run-unsupported', {
      reason: supportDecision.unsupportedReason,
      repoKind: supportDecision.repoKind,
    })
  }
  return {
    result,
    inventory,
    codeMap,
    profile,
    snapshotId,
    supportDecision,
    staticProgramGraph,
    communityMap: communityArtifacts.communityMap,
    neighborMap: communityArtifacts.neighborMap,
    journeyStore,
    investigationFrame,
    supportDecisionPath,
    staticProgramGraphPath,
    communityMapPath: communityPaths.communityMapPath,
    neighborMapPath: communityPaths.neighborMapPath,
    investigationFramePath,
  }
}

function project(argv) {
  const args = parseArgs(argv, ['package'])
  const only = args.only || 'all'
  if (![...PRODUCT_PROJECTION_NAMES, 'html', 'all'].includes(only)) usage()
  const packageDir = path.resolve(args.package)
  const initialStatus = buildHarnessStatus(packageDir)
  if (only !== 'html') {
    assertProductProjectionAllowed(packageDir, initialStatus)
  } else if (!['project', 'done'].includes(initialStatus.nextAction)
    || !fs.existsSync(path.join(packageDir, 'synthesis', 'narrative.json'))) {
    throw new Error(`Cannot project human-readable HTML while nextAction is ${initialStatus.nextAction}; a validated synthesis narrative is required`)
  }
  const productMaps = only === 'html' ? null : writeProductMaps({ packageDir })
  const projectionVerification = productMaps
    ? writeFrontendVerification({ packageDir, phase: 'projection' })
    : null
  if (projectionVerification && !projectionVerification.verification.passed) {
    throw new Error(`Product Map projection failed verification: ${projectionVerification.verification.issues.map(issue => issue.code).join(', ')}`)
  }
  if (productMaps) {
    for (const [projection, entry] of Object.entries(productMaps.manifest.projections)) {
      appendRunEvent(packageDir, 'projection-built', {
        projection,
        path: entry.path,
        schemaVersion: entry.schemaVersion,
        contentHash: entry.contentHash,
        projectionKey: productMaps.manifest.projectionKey,
      }, { actor: 'kernel' })
    }
  }
  const hasNarrative = fs.existsSync(path.join(packageDir, 'synthesis', 'narrative.json'))
  const htmlResult = (only === 'html' || only === 'all') && hasNarrative
    ? generateHumanReadableHtml({ packageDir })
    : null
  if (htmlResult) {
    const projectionKey = productMaps?.manifest.projectionKey
      || readJson(path.join(packageDir, 'projections', 'manifest.json')).projectionKey
    appendRunEvent(packageDir, 'projection-built', {
      projection: 'html',
      humanReadablePath: htmlResult.output,
      projectionKey,
    }, { actor: 'kernel' })
  }
  const completion = htmlResult ? completeRunIfDeliverable(packageDir) : null
  const atlasResult = generateRepositoryAtlasHtml({ packageDir })
  console.log(JSON.stringify({
    schemaVersion: 'repo-product-projection-result/v1',
    packageDir,
    requested: only,
    maps: productMaps ? {
      manifestPath: productMaps.paths.manifest,
      projectionKey: productMaps.manifest.projectionKey,
      projections: productMaps.manifest.projections,
      verificationPath: projectionVerification.path,
    } : null,
    html: htmlResult?.output || null,
    repositoryAtlas: atlasResult.output,
    completion,
    nextAction: buildHarnessStatus(packageDir).nextAction,
  }, null, 2))
}

function assertProductProjectionAllowed(packageDir, statusValue) {
  const terminal = statusValue.workflow?.terminal || null
  if (terminal === 'unsupported' || statusValue.nextAction === 'unsupported') {
    throw new Error(`Cannot project Product Maps for unsupported package: ${packageDir}`)
  }
  if (terminal === 'blocked') {
    throw new Error(`Cannot project Product Maps while the workflow terminal is blocked: ${packageDir}`)
  }
  const activeWorkItems = statusValue.workflow?.activeWorkItems || []
  if (activeWorkItems.length) {
    throw new Error(`Cannot project Product Maps while WorkItems are active; wait for Join and ingest: ${activeWorkItems.join(', ')}`)
  }
  const blockingFailures = statusValue.workflow?.blockingFailures || []
  if (blockingFailures.length) {
    throw new Error(`Cannot project Product Maps while blocking WorkItems are unresolved: ${blockingFailures.join(', ')}`)
  }
  const pendingContracts = statusValue.research?.pendingContracts || []
  if (pendingContracts.length) {
    throw new Error(`Cannot project Product Maps while ResearchContracts are pending: ${pendingContracts.join(', ')}`)
  }
  const journeyGate = statusValue.validation?.gates?.journeys
  if (journeyGate?.current !== true) {
    const openJourneyIds = journeyGate?.criticalOpenJourneyIds || []
    const detail = openJourneyIds.length ? `; critical open: ${openJourneyIds.join(', ')}` : ''
    throw new Error(`Cannot project Product Maps while Journey closure is incomplete${detail}`)
  }
}

function verify(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const phase = explicitVerificationPhase(packageDir)
  const validation = writeFrontendVerification({ packageDir, phase }).verification
  generateRepositoryAtlasHtml({ packageDir })
  console.log(JSON.stringify(validation, null, 2))
  if (!validation.passed) process.exitCode = 2
}

function explicitVerificationPhase(packageDir) {
  const workflowState = readJsonIfExists(path.join(packageDir, 'state', 'run-state.json'))
  if (workflowState?.terminal === 'completed') return 'complete'
  if (fs.existsSync(path.join(packageDir, 'human-readable.html'))) return 'complete'
  if (fs.existsSync(path.join(packageDir, 'synthesis', 'narrative.json'))) return 'synthesis'
  return 'projection'
}

function status(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  console.log(JSON.stringify(buildHarnessStatus(packageDir), null, 2))
}

function journeys(argv) {
  const args = parseArgs(argv, ['package', 'definitions', 'bindings'])
  const packageDir = path.resolve(args.package)
  const definitionsValue = readJson(path.resolve(args.definitions))
  const bindingsValue = readJson(path.resolve(args.bindings))
  const definitions = Array.isArray(definitionsValue) ? definitionsValue : definitionsValue?.definitions
  const bindingSets = Array.isArray(bindingsValue)
    ? bindingsValue
    : bindingsValue?.bindingSets || bindingsValue?.bindings
  if (!Array.isArray(definitions) || !definitions.length) throw new Error('Journey definitions input must contain a non-empty array')
  if (!Array.isArray(bindingSets) || !bindingSets.length) throw new Error('Journey bindings input must contain a non-empty array')
  const workflow = ensureWorkflow(packageDir)
  if (workflow.terminal === 'unsupported' || workflow.terminal === 'completed') {
    throw new Error(`Cannot import Journeys while run terminal is ${workflow.terminal}`)
  }
  const staticProgramGraph = readJson(path.join(packageDir, 'static', 'static-program-graph.json'))
  const store = writeJourneyStore({
    packageDir,
    definitions,
    bindingSets,
    staticProgramGraph,
    snapshotId: workflow.snapshotId,
    generatedAt: new Date().toISOString(),
  })
  const closureByJourneyId = new Map(store.closureReports.map(closure => [closure.journeyId, closure]))
  for (const closure of store.closureReports) {
    const definition = store.definitions.find(item => item.journeyId === closure.journeyId)
    appendRunEvent(packageDir, closure.status === 'closed' ? 'journey-closed' : 'journey-reopened', {
      journey: definition,
      closure,
      source: 'governed-journey-import',
    }, { actor: 'orchestrator' })
  }
  const questions = readJsonIfExists(path.join(packageDir, 'planning', 'open-questions.json'))?.questions || []
  const resolvedQuestionIds = []
  for (const question of questions.filter(item => item.category === 'product-intent')) {
    if (workflow.questions?.[question.questionId]?.status === 'resolved') continue
    const targets = question.targetJourneyIds || []
    if (!targets.length || !targets.every(journeyId => closureByJourneyId.get(journeyId)?.status === 'closed')) continue
    appendRunEvent(packageDir, 'question-resolved', {
      questionId: question.questionId,
      resolution: 'Governed JourneyDefinition and JourneyBinding closed the product-intent question.',
      journeyIds: targets,
    }, { actor: 'orchestrator' })
    resolvedQuestionIds.push(question.questionId)
  }
  const statusValue = buildHarnessStatus(packageDir)
  const atlasResult = generateRepositoryAtlasHtml({ packageDir })
  console.log(JSON.stringify({
    schemaVersion: 'repo-journey-import-result/v1',
    packageDir,
    manifestPath: store.paths.manifest,
    journeySetHash: store.manifest.journeySetHash,
    counts: store.manifest.counts,
    closure: store.closureSet,
    resolvedQuestionIds,
    repositoryAtlas: atlasResult.output,
    nextAction: statusValue.nextAction,
  }, null, 2))
}

function dispatch(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const runConfig = readRunConfig(packageDir)
  const statusValue = buildHarnessStatus(packageDir)
  if (statusValue.nextAction !== 'dispatch') {
    throw new Error(`Cannot dispatch while nextAction is ${statusValue.nextAction}`)
  }
  const maxTasks = args['max-tasks'] ? Number(args['max-tasks']) : runConfig.maxContractsPerDispatch
  if (!Number.isFinite(maxTasks)) usage()
  const manifest = createResearchDispatch(packageDir, { maxTasks, contractId: args.contract || null, runConfig })
  generateRepositoryAtlasHtml({ packageDir })
  console.log(JSON.stringify(manifest, null, 2))
}

function synthesize(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const statusValue = buildHarnessStatus(packageDir)
  if (statusValue.nextAction !== 'synthesize') {
    throw new Error(`Cannot synthesize while nextAction is ${statusValue.nextAction}`)
  }
  if (!statusValue.validation.passed) {
    throw new Error('Cannot synthesize before Product Map verification passes')
  }
  appendRunEvent(packageDir, 'verification-passed', {
    phase: 'projection',
    issueCount: 0,
    gate: 'pre-synthesis',
  }, { actor: 'orchestrator' })
  const bundle = createSynthesisWorkItem(packageDir)
  const issued = planAndIssueWorkItem(packageDir, bundle.workItem)
  generateRepositoryAtlasHtml({ packageDir })
  console.log(JSON.stringify({
    schemaVersion: 'repo-work-dispatch/v3',
    generatedAt: new Date().toISOString(),
    packageDir,
    taskCount: 1,
    workItems: [synthesisDispatchEntry(packageDir, bundle, issued)],
    joinRequired: true,
    debug: debugPointers(packageDir),
  }, null, 2))
}

function ingest(argv) {
  const args = parseArgs(argv, ['package', 'work-result'])
  const packageDir = path.resolve(args.package)
  try {
    return ingestWorkResult(packageDir, path.resolve(args['work-result']))
  } finally {
    generateRepositoryAtlasHtml({ packageDir })
  }
}

function ingestWorkResult(packageDir, resultPath) {
  let envelope
  let item
  try {
    envelope = readJson(resultPath)
    const validation = validateWorkResultEnvelope(packageDir, envelope)
    item = validation.item
    const expectedResultPath = item ? workResultEnvelopePath(packageDir, item.itemId) : null
    if (item && path.resolve(resultPath) !== expectedResultPath) {
      validation.issues.push(`WorkResult path mismatch: expected ${expectedResultPath}`)
      validation.valid = false
    }
    if (!validation.valid) {
      if (item && ['issued', 'result-produced'].includes(item.status)) {
        rejectWorkResult(packageDir, item.itemId, {
          issues: validation.issues,
          resultPath,
          message: 'WorkResult envelope failed validation.',
        })
      }
      console.log(JSON.stringify({
        schemaVersion: 'repo-harness-ingest-result/v3',
        merged: false,
        itemId: envelope?.itemId || null,
        issues: validation.issues.map((message, index) => ({ code: 'work-result-validation', index, message })),
        debug: debugPointers(packageDir),
      }, null, 2))
      process.exitCode = 2
      return
    }

    recordCompletionFromWorkResult(packageDir, envelope)
    if (['semantic-research', 'adjudicate'].includes(item.kind)) {
      return ingestTaskOutcomeWorkResult(packageDir, { envelope, item, resultPath })
    }
    if (envelope.status !== 'completed') {
      const issues = envelope.errors?.length
        ? envelope.errors
        : [{ code: `worker-${envelope.status}`, message: `Worker returned ${envelope.status}`, retryable: envelope.status === 'failed' }]
      rejectWorkResult(packageDir, item.itemId, {
        issues,
        resultPath,
        message: `Worker returned ${envelope.status}.`,
      })
      console.log(JSON.stringify({
        schemaVersion: 'repo-harness-ingest-result/v3',
        merged: false,
        itemId: item.itemId,
        attempt: item.attempt,
        issues,
        nextAction: buildHarnessStatus(packageDir).nextAction,
        debug: debugPointers(packageDir),
      }, null, 2))
      process.exitCode = 2
      return
    }

    if (item.kind === 'synthesize') {
      const outputPath = path.resolve(envelope.output.path)
      const narrative = readJson(outputPath)
      const contract = readJson(path.resolve(packageDir, item.contractRef))
      const mapManifest = readJson(path.join(packageDir, 'projections', 'manifest.json'))
      const narrativeValidation = validateSynthesisNarrative({ packageDir, narrative, contract, mapManifest })
      if (!narrativeValidation.valid) {
        throw new Error(`Synthesis narrative failed validation:\n- ${narrativeValidation.issues.map(issue => `${issue.code}: ${issue.message}`).join('\n- ')}`)
      }
      const canonicalPath = path.join(packageDir, 'synthesis', 'narrative.json')
      if (outputPath !== canonicalPath) fs.copyFileSync(outputPath, canonicalPath)
      acceptWorkResult(packageDir, item.itemId, {
        resultPath,
        outputPath,
        narrativePath: canonicalPath,
        contractId: contract.contractId,
        projectionKey: mapManifest.projectionKey,
        evidenceRefCount: narrative.evidenceRefs.length,
        claimRefCount: narrative.claimRefs.length,
        journeyRefCount: narrative.journeyRefs.length,
      })
      appendRunEvent(packageDir, 'synthesis-accepted', {
        itemId: item.itemId,
        attempt: item.attempt,
        narrativePath: canonicalPath,
        projectionKey: mapManifest.projectionKey,
      }, { actor: 'orchestrator' })
      const validation = writeFrontendVerification({ packageDir, phase: 'synthesis' }).verification
      const statusValue = buildHarnessStatus(packageDir, { validation })
      console.log(JSON.stringify({
        schemaVersion: 'repo-harness-ingest-result/v3',
        merged: true,
        itemId: item.itemId,
        attempt: item.attempt,
        workStatus: 'accepted',
        narrativePath: canonicalPath,
        validation: statusValue.validation,
        grounding: narrativeValidation,
        nextAction: statusValue.nextAction,
        workflow: statusValue.workflow,
        debug: statusValue.debug,
      }, null, 2))
      return
    }
    throw new Error(`Unsupported v3 WorkItem kind for ingest: ${item.kind}`)
  } catch (err) {
    const issues = schemaIssuesFromError(err)
    if (item && ['issued', 'result-produced'].includes(syncProducedResults(packageDir).workItems[item.itemId]?.status)) {
      try {
        rejectWorkResult(packageDir, item.itemId, { issues, resultPath, message: 'WorkResult ingest failed.' })
      } catch {
        // Preserve the original ingest error.
      }
    }
    console.log(JSON.stringify({
      schemaVersion: 'repo-harness-ingest-result/v3',
      merged: false,
      itemId: envelope?.itemId || null,
      issues,
      debug: debugPointers(packageDir),
    }, null, 2))
    process.exitCode = 2
  }
}

function ingestTaskOutcomeWorkResult(packageDir, { envelope, item, resultPath }) {
  const contract = readJson(path.resolve(packageDir, item.contractRef))
  const outcomePath = envelope.output?.path ? path.resolve(envelope.output.path) : null
  const outcome = outcomePath && fs.existsSync(outcomePath) ? readJson(outcomePath) : null
  const governedEvidenceIds = loadSemanticStore(packageDir).evidence.map(evidence => evidence.evidenceId)
  const validation = validateTaskOutcome({ contract, outcome, workResult: envelope, governedEvidenceIds })
  const issues = validation.issues.map(issue => ({
    code: issue.code,
    path: issue.path,
    message: issue.message,
    retryable: validation.acceptance.decision !== 'block',
  }))

  let semanticStore = null
  if (validation.acceptance.accepted) {
    semanticStore = ingestGovernedHypotheses({
      packageDir,
      contract,
      workItem: item,
      acceptedData: validation.acceptedData,
      generatedAt: envelope.producedAt,
    })
    acceptWorkResult(packageDir, item.itemId, {
      resultPath,
      outputPath: outcomePath,
      contractId: contract.contractId,
      questionCount: validation.acceptedData.questionOutcomes.length,
      hypothesisCount: validation.acceptedData.hypotheses.length,
      evidenceCount: validation.acceptedData.completionEvidenceIds.length,
      acceptedClaimIds: semanticStore.claims.filter(claim => claim.status === 'accepted').map(claim => claim.claimId),
      refutedClaimIds: semanticStore.claims.filter(claim => claim.status === 'refuted').map(claim => claim.claimId),
    })
    for (const claim of semanticStore.claims) {
      appendRunEvent(packageDir, claim.status === 'accepted' ? 'claim-accepted' : 'claim-refuted', {
        claimId: claim.claimId,
        contractId: contract.contractId,
        itemId: item.itemId,
        evidenceIds: claim.evidenceIds,
        semanticStoreHash: semanticStore.manifest.hashes.claims,
      }, { actor: 'orchestrator' })
    }
  } else {
    rejectWorkResult(packageDir, item.itemId, {
      issues,
      resultPath,
      outputPath: outcomePath,
      contractId: contract.contractId,
      decision: validation.acceptance.decision,
      message: validation.acceptance.decision === 'block'
        ? 'ResearchContract is blocked by external or product evidence.'
        : 'TaskOutcome did not satisfy the ResearchContract.',
    })
  }

  for (const event of validation.events) {
    appendRunEvent(packageDir, event.eventType, event.payload, { actor: 'orchestrator' })
  }
  const statusValue = buildHarnessStatus(packageDir)
  console.log(JSON.stringify({
    schemaVersion: 'repo-harness-ingest-result/v3',
    merged: validation.acceptance.accepted,
    itemId: item.itemId,
    attempt: item.attempt,
    contractId: contract.contractId,
    workStatus: validation.acceptance.accepted ? 'accepted' : 'rejected',
    decision: validation.acceptance.decision,
    acceptance: validation.acceptance,
    issues,
    warnings: validation.warnings,
    semanticStore: semanticStore ? {
      acceptedClaimIds: semanticStore.claims.filter(claim => claim.status === 'accepted').map(claim => claim.claimId),
      refutedClaimIds: semanticStore.claims.filter(claim => claim.status === 'refuted').map(claim => claim.claimId),
      claimSetHash: semanticStore.manifest.hashes.claims,
    } : null,
    nextAction: statusValue.nextAction,
    workflow: statusValue.workflow,
    debug: statusValue.debug,
  }, null, 2))
  if (!validation.acceptance.accepted) process.exitCode = 2
}

function retry(argv) {
  const args = parseArgs(argv, ['package', 'item'])
  const packageDir = path.resolve(args.package)
  const workflowState = syncProducedResults(packageDir)
  const previous = workflowState.workItems[args.item]
  if (!previous) throw new Error(`Unknown WorkItem: ${args.item}`)
  if (!['rejected', 'abandoned'].includes(previous.status)) {
    throw new Error(`WorkItem ${args.item} is ${previous.status}; only rejected or abandoned items can be retried`)
  }
  if (previous.attempt >= 3) throw new Error(`WorkItem ${args.item} exhausted the maximum of 3 attempts`)

  if (previous.kind === 'synthesize') {
    const bundle = createSynthesisWorkItem(packageDir, {
      attempt: previous.attempt + 1,
      retryOf: previous.itemId,
      idempotencyKey: previous.idempotencyKey,
    })
    const issued = planAndIssueWorkItem(packageDir, bundle.workItem)
    console.log(JSON.stringify({
      schemaVersion: 'repo-work-retry/v3',
      retryOf: previous.itemId,
      ...synthesisDispatchEntry(packageDir, bundle, issued),
      debug: debugPointers(packageDir),
    }, null, 2))
    return
  }
  if (!['semantic-research', 'adjudicate'].includes(previous.kind)) {
    throw new Error(`WorkItem kind ${previous.kind} belongs to the removed v2 flow; rerun analyze to create a v3 contract`)
  }

  const attempt = previous.attempt + 1
  const contractPath = path.isAbsolute(previous.contractRef) ? previous.contractRef : path.resolve(packageDir, previous.contractRef)
  const contract = readJson(contractPath)
  const previousPromptRef = (previous.inputArtifactRefs || []).find(ref => String(ref).endsWith('.md'))
  const previousPromptPath = previousPromptRef
    ? (path.isAbsolute(previousPromptRef) ? previousPromptRef : path.resolve(packageDir, previousPromptRef))
    : path.join(packageDir, 'research', 'retry', `${safeFileName(previous.itemId)}.md`)
  const promptPath = withAttemptSuffix(previousPromptPath, attempt, '.md')
  const promptRef = path.relative(packageDir, promptPath).split(path.sep).join('/')
  const outputArtifactPath = withAttemptSuffix(previous.outputArtifactPath, attempt, '.json')
  ensureDir(path.dirname(promptPath))
  const next = createWorkItem(packageDir, {
    attempt,
    retryOf: previous.itemId,
    kind: previous.kind,
    role: previous.role,
    contractRef: previous.contractRef,
    objectiveSummary: previous.objectiveSummary,
    blocking: previous.blocking,
    dependencies: previous.dependencies,
    completionPolicyRef: previous.completionPolicyRef,
    inputArtifactRefs: dedupeStrings([
      ...(previous.inputArtifactRefs || []).filter(ref => ref !== previousPromptRef),
      promptRef,
    ]),
    outputArtifactPath,
    outputSchemaRef: previous.outputSchemaRef,
    communityIds: previous.communityIds,
    neighborMapRef: previous.neighborMapRef,
    blockingMapDimensions: previous.blockingMapDimensions,
    blockingJourneyIds: previous.blockingJourneyIds,
    qualityClass: previous.qualityClass,
    criticality: previous.criticality,
    budgetHints: previous.budgetHints,
    idempotencyKey: previous.idempotencyKey,
  })
  fs.writeFileSync(promptPath, renderResearchWorkPrompt({
    root: packageDir,
    contract,
    contractPath,
    item: next,
    schemaPath: next.outputSchemaRef,
  }), 'utf8')
  const issued = planAndIssueWorkItem(packageDir, next)
  console.log(JSON.stringify({
    schemaVersion: 'repo-work-retry/v3',
    retryOf: previous.itemId,
    itemId: next.itemId,
    attempt: next.attempt,
    contractId: contract.contractId,
    workItemPath: issued.itemPath,
    promptPath,
    outputArtifactPath,
    workResultPath: issued.workResultPath,
    telemetry: telemetryCommands(packageDir, next.itemId),
    ingestCommand: ingestCommandFor(packageDir, issued.workResultPath),
    debug: debugPointers(packageDir),
  }, null, 2))
}

function trace(argv) {
  const args = parseArgs(argv, ['package', 'item', 'event'])
  const eventType = {
    started: 'agent-started',
    completed: 'agent-completed',
    failed: 'agent-failed',
  }[args.event]
  if (!eventType) usage()
  const traceValue = recordAgentTrace(path.resolve(args.package), {
    itemId: args.item,
    eventType,
    runtime: args.runtime,
    model: args.model,
    effort: args.effort,
    sessionId: args.session,
    durationMs: numericArg(args, 'duration-ms'),
    usage: {
      inputTokens: numericArg(args, 'input-tokens'),
      outputTokens: numericArg(args, 'output-tokens'),
      cachedInputTokens: numericArg(args, 'cached-input-tokens'),
      reasoningTokens: numericArg(args, 'reasoning-tokens'),
      totalTokens: numericArg(args, 'total-tokens'),
      costUsd: numericArg(args, 'cost-usd'),
    },
    message: args.message,
  })
  console.log(JSON.stringify(traceValue, null, 2))
}

function debug(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const summary = buildAgentDebugSummary(packageDir)
  const claims = readJsonLinesIfExists(path.join(packageDir, 'store', 'claims.jsonl'))
  const accepted = claims.filter(claim => claim.status === 'accepted')
  const agentClaims = accepted.filter(claim => claim.derivation === 'agent')
  const totalTokens = summary.aggregateUsage.totalTokens || 0
  const totalDurationMs = summary.byItem.reduce((sum, item) => sum + (Number(item.durationMs) || 0), 0)
  const totalCostUsd = summary.aggregateUsage.costUsd || 0
  const inputTokens = summary.aggregateUsage.inputTokens || 0
  const cachedInputTokens = summary.aggregateUsage.cachedInputTokens || 0
  console.log(JSON.stringify({
    ...summary,
    knowledgeEfficiency: {
      acceptedClaims: accepted.length,
      deterministicAcceptedClaims: accepted.filter(claim => claim.derivation === 'deterministic').length,
      agentAcceptedClaims: agentClaims.length,
      agentAcceptedClaimsByItem: countTasksBy(agentClaims.filter(claim => claim.createdByItemId), claim => claim.createdByItemId),
      acceptedAgentClaimsPer1kReportedTokens: totalTokens > 0
        ? Number((agentClaims.length / totalTokens * 1000).toFixed(3))
        : null,
      acceptedAgentClaimsPerReportedMinute: totalDurationMs > 0
        ? Number((agentClaims.length / (totalDurationMs / 60000)).toFixed(3))
        : null,
      costPerAcceptedAgentClaimUsd: agentClaims.length > 0 && totalCostUsd > 0
        ? Number((totalCostUsd / agentClaims.length).toFixed(6))
        : null,
      contextReuseRatio: inputTokens > 0
        ? Number((cachedInputTokens / inputTokens).toFixed(4))
        : null,
      metricStatus: totalTokens > 0 ? 'reported-usage-only' : 'unavailable',
      unreportedWorkItems: summary.byItem
        .filter(item => item.usage?.status === 'unavailable')
        .map(item => item.itemId),
    },
  }, null, 2))
}

function report(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const outFile = args.out ? path.resolve(args.out) : path.join(packageDir, 'report.md')
  const markdown = renderV3HarnessReport(packageDir)
  fs.writeFileSync(outFile, `${markdown.trimEnd()}\n`, 'utf8')
  console.log(`Report: ${outFile}`)
}

function renderV3HarnessReport(packageDir) {
  const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
  const support = readJson(path.join(packageDir, 'static', 'support-decision.json'))
  const graph = readJsonIfExists(path.join(packageDir, 'static', 'static-program-graph.json'))
  const questions = readJsonIfExists(path.join(packageDir, 'planning', 'open-questions.json'))?.questions || []
  const journeyManifest = readJsonIfExists(path.join(packageDir, 'store', 'journeys', 'manifest.json'))
  const mapManifest = readJsonIfExists(path.join(packageDir, 'projections', 'manifest.json'))
  const narrative = readJsonIfExists(path.join(packageDir, 'synthesis', 'narrative.json'))
  const statusValue = buildHarnessStatus(packageDir)
  const map = name => readJsonIfExists(path.join(packageDir, 'projections', `${name}-map.json`))
  const application = map('application')
  const experience = map('experience')
  const runtimeFlow = map('runtime-flow')
  const change = map('change')
  const lines = [
    `# ${inventory.repo?.name || path.basename(inventory.repo?.path || packageDir)} — Frontend Understanding v3`,
    '',
    `- Support: \`${support.supportLevel}\` (${support.repoKind})`,
    `- Snapshot: \`${graph?.snapshotId || statusValue.workflow.snapshotId}\``,
    `- Status: \`${statusValue.nextAction}\``,
    `- Static Program Graph: ${graph?.nodes?.length || 0} nodes / ${graph?.edges?.length || 0} edges / ${graph?.diagnostics?.length || 0} diagnostics`,
    `- ResearchContract: ${statusValue.research.contracts}; Questions: ${questions.length}`,
    `- Journeys: ${journeyManifest?.counts?.closed || 0}/${journeyManifest?.counts?.journeys || 0} closed`,
    '',
    '## Product Maps',
    '',
    `- Application Map: ${application?.entities?.length || 0} entities, ${application?.relations?.length || 0} relations`,
    `- Experience Map: ${experience?.journeys?.length || 0} journeys`,
    `- Runtime Flow Map: ${runtimeFlow?.flows?.length || 0} flows; ${runtimeFlow?.unboundJourneyIds?.length || 0} unbound journeys`,
    `- Change Map: ${change?.changeSets?.length || 0} deterministic impact sets`,
    `- Projection current: ${statusValue.validation.gates?.productMaps?.current === true}`,
    '',
    '## Open governance items',
    '',
  ]
  if (!questions.length) lines.push('- None.')
  for (const question of questions) {
    lines.push(`- [${question.category}/${question.lifecycleStatus}] ${question.question} (\`${question.questionId}\`)`)
  }
  lines.push('', '## Narrative', '')
  if (narrative) {
    lines.push(narrative.executiveSummary, '', `Limitations: ${narrative.limitations.length}`)
  } else {
    lines.push('- Not generated. The four Product Maps remain authoritative.')
  }
  lines.push('', '## Authoritative artifacts', '')
  for (const artifact of [
    'static/static-program-graph.json',
    'static/community-map.json',
    'static/neighbor-map.json',
    'static/investigation-frame.json',
    'planning/manifest.json',
    'store/journeys/manifest.json',
    'projections/manifest.json',
    'verification/frontend-verification.json',
  ]) {
    if (fs.existsSync(path.join(packageDir, artifact))) lines.push(`- \`${artifact}\``)
  }
  if (mapManifest) lines.push(`- Projection key: \`${stableHash(JSON.stringify(mapManifest.projectionKey)).slice(0, 20)}\``)
  return lines.join('\n')
}

function html(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const statusValue = buildHarnessStatus(packageDir)
  if (!['project', 'done'].includes(statusValue.nextAction) || !fs.existsSync(path.join(packageDir, 'synthesis', 'narrative.json'))) {
    throw new Error(`Cannot build human-readable HTML while nextAction is ${statusValue.nextAction}`)
  }
  const result = generateHumanReadableHtml({
    packageDir,
    outFile: args.out ? path.resolve(args.out) : undefined,
  })
  const mapManifest = readJson(path.join(packageDir, 'projections', 'manifest.json'))
  appendRunEvent(packageDir, 'projection-built', {
    projection: 'html',
    humanReadablePath: result.output,
    projectionKey: mapManifest.projectionKey,
  }, { actor: 'kernel' })
  const completion = completeRunIfDeliverable(packageDir)
  const validation = writeFrontendVerification({ packageDir, phase: 'complete' }).verification
  const atlasResult = generateRepositoryAtlasHtml({ packageDir })
  console.log(JSON.stringify({ ...result, repositoryAtlas: atlasResult.output, validation, completion }, null, 2))
}

function atlas(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const result = generateRepositoryAtlasHtml({
    packageDir,
    outFile: args.out ? path.resolve(args.out) : undefined,
  })
  console.log(JSON.stringify(result, null, 2))
}

function zonePlan(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
  const staticProgramGraph = readJson(path.join(packageDir, 'static', 'static-program-graph.json'))
  const nodeSemanticCatalog = readJson(path.join(packageDir, 'store', 'node-semantics.json'))
  const communityMap = readJsonIfExists(path.join(packageDir, 'static', 'community-map.json'))
  const plan = buildRepositoryZoneAgentPlan({
    inventory,
    staticProgramGraph,
    nodeSemanticCatalog,
    repoPath: inventory.repo?.path,
    maxZones: args['max-zones'] ? Number(args['max-zones']) : 24,
    maxSubzones: args['max-subzones'] ? Number(args['max-subzones']) : 96,
  })
  const planPath = writeRepositoryZoneAgentPlan({ packageDir, plan, inventory, staticProgramGraph, nodeSemanticCatalog })
  const context = buildRepositoryZoneAgentContext({ plan, inventory, staticProgramGraph, nodeSemanticCatalog, communityMap })
  const contextPath = writeRepositoryZoneAgentContext({ packageDir, context, outputPath: plan.artifactRefs.contextRef })
  removeStaleRepositoryZoneArtifacts(packageDir, plan)
  const repositoryAtlas = generateRepositoryAtlasHtml({ packageDir }).output
  console.log(JSON.stringify({
    schemaVersion: 'repo-repository-zone-agent-plan-result/v1',
    planId: plan.planId,
    status: 'waiting-for-agent',
    authority: plan.constraints.authority,
    allowedFiles: plan.allowedFiles.length,
    planPath,
    contextPath,
    outputPath: path.resolve(packageDir, plan.artifactRefs.outputRef),
    reviewPath: path.resolve(packageDir, plan.artifactRefs.reviewRef),
    resultSchemaPath: path.join(KERNEL_DIR, 'schemas', 'repository-zones.schema.json'),
    repositoryAtlas,
  }, null, 2))
}

function zoneReviewPlan(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
  const staticProgramGraph = readJson(path.join(packageDir, 'static', 'static-program-graph.json'))
  const plan = readJson(path.join(packageDir, 'planning', 'repository-zone-agent-plan.json'))
  const catalogPath = path.resolve(packageDir, plan.artifactRefs.outputRef)
  const catalog = readJson(catalogPath)
  const issues = validateRepositoryZoneDraft({ catalog, plan, inventory, staticProgramGraph })
  if (issues.length) throw new Error(`Invalid Repository Zone Agent draft:\n- ${issues.join('\n- ')}`)
  const reviewPath = path.resolve(packageDir, plan.artifactRefs.reviewRef)
  const dispatchPath = path.join(packageDir, 'research', 'repository-zones', 'review-dispatch.json')
  const catalogHash = repositoryZoneCatalogHash(catalog)
  removeStaleRepositoryZoneReview(packageDir, plan, catalogHash)
  const dispatch = {
    schemaVersion: 'repo-repository-zone-review-dispatch/v1',
    planId: plan.planId,
    snapshotId: plan.snapshotId,
    reviewerRole: plan.reviewerRole,
    producerAgentId: catalog.producer.agentId,
    catalogPath,
    catalogHash,
    contextPath: path.resolve(packageDir, plan.artifactRefs.contextRef),
    reviewPath,
    reviewSchemaPath: path.join(KERNEL_DIR, 'schemas', 'repository-zone-review.schema.json'),
    requiredChecks: ['semanticGrounding', 'graphCoherence', 'completeCoverage', 'singleFileIdentity', 'notPathOnlyClassification', 'noInventedFiles'],
  }
  ensureDir(path.dirname(dispatchPath))
  fs.writeFileSync(dispatchPath, `${JSON.stringify(dispatch, null, 2)}\n`, 'utf8')
  const repositoryAtlas = generateRepositoryAtlasHtml({ packageDir }).output
  console.log(JSON.stringify({
    schemaVersion: 'repo-repository-zone-review-plan-result/v1',
    planId: plan.planId,
    catalogHash: dispatch.catalogHash,
    dispatchPath,
    reviewPath,
    repositoryAtlas,
  }, null, 2))
}

function zoneIngest(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
  const staticProgramGraph = readJson(path.join(packageDir, 'static', 'static-program-graph.json'))
  const plan = readJson(path.join(packageDir, 'planning', 'repository-zone-agent-plan.json'))
  const catalog = readJson(path.resolve(packageDir, plan.artifactRefs.outputRef))
  const review = readJson(path.resolve(packageDir, plan.artifactRefs.reviewRef))
  const reviewIssues = validateRepositoryZoneReview({ review, plan, catalog })
  if (reviewIssues.length) throw new Error(`Invalid Repository Zone Agent review:\n- ${reviewIssues.join('\n- ')}`)
  const zones = acceptRepositoryZoneCatalog({ catalog, review, plan, inventory, staticProgramGraph })
  const output = writeRepositoryZones({ packageDir, zones, plan, inventory, staticProgramGraph, outputPath: plan.artifactRefs.finalRef })
  const repositoryAtlas = generateRepositoryAtlasHtml({ packageDir }).output
  console.log(JSON.stringify({
    schemaVersion: 'repo-repository-zone-ingest-result/v1',
    planId: plan.planId,
    zonePlanId: zones.zonePlanId,
    status: zones.status,
    producer: zones.producer,
    reviewer: zones.review.reviewer,
    output,
    metrics: zones.metrics,
    repositoryAtlas,
  }, null, 2))
}

function removeStaleRepositoryZoneArtifacts(packageDir, plan) {
  const refs = [plan.artifactRefs.outputRef, plan.artifactRefs.reviewRef, plan.artifactRefs.finalRef]
  for (const ref of refs) {
    const target = path.resolve(packageDir, ref)
    if (!fs.existsSync(target)) continue
    const value = readJsonIfExists(target)
    if (value?.planId !== plan.planId || value?.schemaVersion === 'repo-repository-zones/v1') fs.rmSync(target, { force: true })
  }
}

function removeStaleRepositoryZoneReview(packageDir, plan, catalogHash) {
  for (const ref of [plan.artifactRefs.reviewRef, plan.artifactRefs.finalRef]) {
    const target = path.resolve(packageDir, ref)
    const value = readJsonIfExists(target)
    if (value && value?.review?.catalogHash !== catalogHash && value?.catalogHash !== catalogHash) fs.rmSync(target, { force: true })
  }
}

function semanticPlan(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
  const staticProgramGraph = readJson(path.join(packageDir, 'static', 'static-program-graph.json'))
  const communityMap = readJsonIfExists(path.join(packageDir, 'static', 'community-map.json'))
  const neighborMap = readJsonIfExists(path.join(packageDir, 'static', 'neighbor-map.json'))
  const maxFilesPerBatch = args['max-files'] ? Number(args['max-files']) : 8
  const maxSourceBytesPerBatch = args['max-source-bytes'] ? Number(args['max-source-bytes']) : 262144
  const plan = buildNodeSemanticBatchPlan({
    inventory,
    staticProgramGraph,
    communityMap,
    neighborMap,
    repoPath: inventory.repo?.path,
    maxFilesPerBatch,
    maxSourceBytesPerBatch,
    outputBaseRef: 'research/node-semantics/results',
  })
  const written = writeNodeSemanticBatchPlan({ packageDir, plan, inventory, staticProgramGraph })
  const contextDir = path.join(packageDir, 'research', 'node-semantics', 'contexts')
  ensureDir(contextDir)
  for (const batch of plan.batches) {
    const context = buildNodeSemanticContext({
      repoPath: plan.repoPath,
      filePaths: batch.allowedFiles,
      staticProgramGraph,
      maxSignalsPerFile: 90,
    })
    const target = path.join(contextDir, `batch-${String(batch.ordinal).padStart(4, '0')}.json`)
    const payload = {
      schemaVersion: 'repo-node-semantic-agent-batch/v1',
      planId: plan.planId,
      batch,
      context,
      outputPath: path.resolve(packageDir, batch.outputRef),
      reviewPath: path.resolve(packageDir, 'research', 'node-semantics', 'reviews', `batch-${String(batch.ordinal).padStart(4, '0')}.review.json`),
    }
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
  const repositoryAtlas = generateRepositoryAtlasHtml({ packageDir }).output
  console.log(JSON.stringify({
    schemaVersion: 'repo-node-semantic-plan-result/v1',
    planId: plan.planId,
    planPath: written.path,
    eligibleFileCount: plan.eligibleFileCount,
    batchCount: plan.batchCount,
    contextDir,
    repositoryAtlas,
  }, null, 2))
}

function semanticIngest(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
  const staticProgramGraph = readJson(path.join(packageDir, 'static', 'static-program-graph.json'))
  const plan = readJson(path.join(packageDir, 'planning', 'node-semantic-batches.json'))
  const projectionCatalogs = []
  const acceptedBatchIds = []
  const missingBatchIds = []
  const unreviewedBatchIds = []
  const changesRequestedBatchIds = []
  const invalidReviewBatches = []
  for (const batch of plan.batches || []) {
    const resultPath = path.resolve(packageDir, batch.outputRef)
    if (!fs.existsSync(resultPath)) {
      missingBatchIds.push(batch.batchId)
      continue
    }
    const catalog = readJson(resultPath)
    const reviewPath = path.join(packageDir, 'research', 'node-semantics', 'reviews', `batch-${String(batch.ordinal).padStart(4, '0')}.review.json`)
    if (!fs.existsSync(reviewPath)) {
      projectionCatalogs.push(catalog)
      unreviewedBatchIds.push(batch.batchId)
      continue
    }
    const review = readJson(reviewPath)
    const reviewValidation = validateNodeSemanticReview({ review, planId: plan.planId, batch, catalog })
    if (!reviewValidation.valid) {
      projectionCatalogs.push(catalog)
      invalidReviewBatches.push({ batchId: batch.batchId, issues: reviewValidation.issues })
      continue
    }
    if (review.status === 'changes-requested') {
      projectionCatalogs.push(catalog)
      changesRequestedBatchIds.push(batch.batchId)
      continue
    }
    projectionCatalogs.push(acceptNodeSemanticBatchCatalog({ catalog, review, planId: plan.planId, batch, staticProgramGraph, inventory }))
    acceptedBatchIds.push(batch.batchId)
  }
  const expectedFilePaths = (plan.batches || []).flatMap(batch => batch.primaryFiles || [])
  const catalog = mergeNodeSemanticCatalogs({
    catalogs: projectionCatalogs,
    snapshotId: plan.snapshotId,
    expectedFilePaths,
  })
  const written = writeNodeSemanticCatalog({ packageDir, catalog, staticProgramGraph, inventory })
  const repositoryAtlas = generateRepositoryAtlasHtml({ packageDir }).output
  console.log(JSON.stringify({
    schemaVersion: 'repo-node-semantic-ingest-result/v1',
    planId: plan.planId,
    status: catalog.status,
    acceptedFiles: catalog.entries.filter(entry => entry.status === 'accepted').length,
    draftFiles: catalog.entries.filter(entry => entry.status === 'draft').length,
    eligibleFiles: expectedFilePaths.length,
    acceptedBatches: acceptedBatchIds.length,
    missingBatches: missingBatchIds,
    unreviewedBatches: unreviewedBatchIds,
    changesRequestedBatches: changesRequestedBatchIds,
    invalidReviewBatches,
    catalogPath: written.path,
    repositoryAtlas,
  }, null, 2))
}

function semanticReviewPlan(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const inventory = readJson(path.join(packageDir, 'static', 'inventory.json'))
  const staticProgramGraph = readJson(path.join(packageDir, 'static', 'static-program-graph.json'))
  const plan = readJson(path.join(packageDir, 'planning', 'node-semantic-batches.json'))
  const dispatchDir = path.join(packageDir, 'research', 'node-semantics', 'review-dispatch')
  ensureDir(dispatchDir)
  const dispatches = []
  const missingBatchIds = []
  for (const batch of plan.batches || []) {
    const resultPath = path.resolve(packageDir, batch.outputRef)
    if (!fs.existsSync(resultPath)) {
      missingBatchIds.push(batch.batchId)
      continue
    }
    const catalog = readJson(resultPath)
    const validation = validateNodeSemanticBatchDraft({ catalog, batch, staticProgramGraph, inventory })
    if (!validation.valid) throw new Error(`Invalid Node Semantic draft for ${batch.batchId}:\n${validation.issues.join('\n')}`)
    const suffix = String(batch.ordinal).padStart(4, '0')
    const reviewPath = path.join(packageDir, 'research', 'node-semantics', 'reviews', `batch-${suffix}.review.json`)
    const dispatchPath = path.join(dispatchDir, `batch-${suffix}.review-dispatch.json`)
    const dispatch = {
      schemaVersion: 'repo-node-semantic-review-dispatch/v1',
      planId: plan.planId,
      snapshotId: plan.snapshotId,
      batchId: batch.batchId,
      primaryFiles: batch.primaryFiles,
      allowedFiles: batch.allowedFiles,
      repoPath: plan.repoPath,
      catalogPath: resultPath,
      catalogHash: nodeSemanticCatalogHash(catalog),
      reviewPath,
      reviewSchemaPath: path.join(KERNEL_DIR, 'schemas', 'node-semantic-review.schema.json'),
    }
    fs.writeFileSync(dispatchPath, `${JSON.stringify(dispatch, null, 2)}\n`, 'utf8')
    dispatches.push({ batchId: batch.batchId, dispatchPath, reviewPath, catalogHash: dispatch.catalogHash })
  }
  console.log(JSON.stringify({
    schemaVersion: 'repo-node-semantic-review-plan-result/v1',
    planId: plan.planId,
    dispatches,
    missingBatches: missingBatchIds,
  }, null, 2))
}

function serve(argv) {
  const args = parseArgs(argv, ['package'])
  const packageDir = path.resolve(args.package)
  const port = args.port ? Number(args.port) : 8787
  if (!Number.isFinite(port)) usage()
  generateRepositoryAtlasHtml({ packageDir })
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${port}`)
      if (url.pathname === '/' || url.pathname === '/repository-atlas.html') {
        return fileText(res, path.join(packageDir, 'repository-atlas.html'), 'text/html; charset=utf-8')
      }
      if (url.pathname === '/health') return json(res, { ok: true, packageDir })
      if (url.pathname === '/status') return json(res, buildHarnessStatus(packageDir))
      if (url.pathname === '/static-program-graph') return fileJson(res, path.join(packageDir, 'static', 'static-program-graph.json'))
      if (url.pathname === '/application-map') return fileJson(res, path.join(packageDir, 'projections', 'application-map.json'))
      if (url.pathname === '/experience-map') return fileJson(res, path.join(packageDir, 'projections', 'experience-map.json'))
      if (url.pathname === '/runtime-flow-map') return fileJson(res, path.join(packageDir, 'projections', 'runtime-flow-map.json'))
      if (url.pathname === '/change-map') return fileJson(res, path.join(packageDir, 'projections', 'change-map.json'))
      if (url.pathname === '/journeys') return fileJson(res, path.join(packageDir, 'store', 'journeys', 'manifest.json'))
      if (url.pathname === '/narrative') return fileJson(res, path.join(packageDir, 'synthesis', 'narrative.json'))
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const artifactPath = path.resolve(packageDir, relativePath)
      if (artifactPath.startsWith(`${packageDir}${path.sep}`) && fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile()) {
        const contentType = artifactPath.endsWith('.html') ? 'text/html; charset=utf-8' : artifactPath.endsWith('.json') || artifactPath.endsWith('.jsonl') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'
        return fileText(res, artifactPath, contentType)
      }
      return json(res, { endpoints: ['/', '/repository-atlas.html', '/status', '/static-program-graph', '/application-map', '/experience-map', '/runtime-flow-map', '/change-map', '/journeys', '/narrative', '/health'] }, 404)
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
  ensureWorkflow(root)
  const workflowState = syncProducedResults(root)
  const inventory = readJson(path.join(root, 'static', 'inventory.json'))
  const semanticManifest = readJsonIfExists(path.join(root, 'store', 'semantic-store-manifest.json'))
  const researchPlan = readJsonIfExists(path.join(root, 'planning', 'manifest.json')) || { contractRefs: [], questionCounts: {} }
  const workItems = Object.values(workflowState.workItems)
  const mapManifestExists = fs.existsSync(path.join(root, 'projections', 'manifest.json'))
  const hasSynthesis = fs.existsSync(path.join(root, 'synthesis', 'narrative.json'))
  const hasCurrentHumanProjection = isV3HumanProjectionCurrent(root)
  const verificationPhase = hasCurrentHumanProjection
    ? 'complete'
    : hasSynthesis
      ? 'synthesis'
      : mapManifestExists
        ? 'projection'
        : 'analysis'
  const validation = options.validation || verifyFrontendPackage({ packageDir: root, phase: verificationPhase })
  const hasCurrentProductMaps = mapManifestExists && validation.gates?.productMaps?.current === true
  const hasCurrentNarrative = hasSynthesis && validation.gates?.narrative?.current === true
  const hasClosedJourneys = validation.gates?.journeys?.current === true
  const producedResults = workItems.filter(item => item.status === 'result-produced')
  const issuedWork = workItems.filter(item => ['ready', 'issued'].includes(item.status))
  const replacedItemIds = new Set(workItems.map(item => item.retryOf).filter(Boolean))
  const unresolvedBlockingFailures = workItems.filter(item => item.blocking
    && ['rejected', 'abandoned'].includes(item.status)
    && !replacedItemIds.has(item.itemId))
  const latestByContract = new Map()
  for (const item of workItems) {
    const contractPath = item.contractRef && (path.isAbsolute(item.contractRef) ? item.contractRef : path.resolve(root, item.contractRef))
    const contractId = contractPath && fs.existsSync(contractPath) ? readJson(contractPath).contractId : null
    if (!contractId || item.kind === 'synthesize') continue
    const previous = latestByContract.get(contractId)
    if (!previous || item.attempt > previous.attempt) latestByContract.set(contractId, item)
  }
  const contractStates = (researchPlan.contractRefs || []).map(ref => {
    const item = latestByContract.get(ref.contractId) || null
    return {
      ...ref,
      item,
      complete: Boolean(item && ['accepted', 'waived'].includes(item.status)),
    }
  })
  const completedContracts = contractStates.filter(entry => entry.complete)
  const pendingContracts = contractStates.filter(entry => !entry.complete)
  const dispatchableContracts = pendingContracts.filter(entry => !entry.item)
  const nextAction = workflowState.terminal === 'unsupported'
    ? 'unsupported'
    : workflowState.terminal === 'blocked'
    ? 'blocked'
    : workflowState.terminal === 'completed'
      ? 'done'
      : producedResults.length > 0
        ? 'ingest'
        : issuedWork.length > 0
          ? 'await-results'
          : unresolvedBlockingFailures.length > 0
            ? 'blocked'
            : dispatchableContracts.length > 0
              ? 'dispatch'
              : pendingContracts.length > 0
                ? 'blocked'
                : !hasClosedJourneys
                  ? 'blocked'
                  : !hasCurrentProductMaps
                    ? 'project'
                    : !validation.passed
                      ? 'blocked'
                      : !hasCurrentNarrative
                        ? 'synthesize'
                        : 'project'
  const stopReason = nextAction === 'done'
    ? 'all-contracts-journeys-and-projections-closed'
    : nextAction === 'blocked'
      ? unresolvedBlockingFailures.length > 0
        ? 'blocking-work-failure'
        : pendingContracts.length > 0
          ? 'pending-research-contract'
          : !hasClosedJourneys
            ? 'journey-closure-incomplete'
            : validation.issues?.[0]?.code || 'workflow-blocked'
      : null
  const debugSummary = buildAgentDebugSummary(root)
  return {
    schemaVersion: 'repo-harness-status/v3',
    generatedAt: new Date().toISOString(),
    packageDir: root,
    repo: inventory.repo,
    tasks: {
      total: (researchPlan.contractRefs || []).length,
      open: pendingContracts.length,
      dispatched: workItems.filter(item => ['ready', 'issued', 'result-produced'].includes(item.status)).length,
      done: completedContracts.length,
      skipped: completedContracts.filter(entry => entry.item?.status === 'waived').length,
      executableOpen: dispatchableContracts.length,
      openDisabled: pendingContracts.length - dispatchableContracts.length,
      byType: countTasksBy(workItems, item => item.kind || 'unknown'),
      byStatusType: countTasksBy(workItems, item => `${item.status || 'unknown'}:${item.kind || 'unknown'}`),
    },
    research: {
      questionCounts: researchPlan.questionCounts || {},
      contracts: (researchPlan.contractRefs || []).length,
      pendingContracts: pendingContracts.map(ref => ref.contractId),
      dispatchableContracts: dispatchableContracts.length,
      questions: researchPlan.questionCounts || {},
      journeys: validation.gates?.journeys || null,
    },
    validation: {
      passed: validation.passed,
      issues: validation.issues,
      warnings: validation.warnings,
      phase: validation.phase,
      gates: validation.gates,
    },
    knowledge: semanticManifest ? {
      schemaVersion: semanticManifest.schemaVersion,
      snapshotId: semanticManifest.snapshotId,
      counts: semanticManifest.counts,
      claimSetHash: semanticManifest.hashes?.claims,
      evidenceSetHash: semanticManifest.hashes?.evidence,
    } : null,
    workflow: {
      schemaVersion: workflowState.schemaVersion,
      runId: workflowState.runId,
      snapshotId: workflowState.snapshotId,
      terminal: workflowState.terminal,
      lastSequence: workflowState.lastSequence,
      counts: workflowState.counts,
      blockingFailures: unresolvedBlockingFailures.map(item => item.itemId),
      activeWorkItems: [...issuedWork, ...producedResults].map(item => item.itemId),
      stopReason,
    },
    debug: {
      tracePath: debugSummary.files.trace,
      issued: debugSummary.invocations.issued,
      started: debugSummary.invocations.started,
      completed: debugSummary.invocations.completed,
      failed: debugSummary.invocations.failed,
      usageReported: debugSummary.invocations.usageReported,
      usageUnavailable: debugSummary.invocations.usageUnavailable,
      aggregateUsage: debugSummary.aggregateUsage,
    },
    nextAction,
  }
}

function createResearchDispatch(packageDir, options = {}) {
  const root = path.resolve(packageDir)
  const plan = readJson(path.join(root, 'planning', 'manifest.json'))
  const workflow = ensureWorkflow(root)
  const existingContractIds = new Set(Object.values(workflow.workItems).map(item => {
    const contractPath = item.contractRef && (path.isAbsolute(item.contractRef) ? item.contractRef : path.resolve(root, item.contractRef))
    return contractPath && fs.existsSync(contractPath) ? readJson(contractPath).contractId : null
  }).filter(Boolean))
  const pending = (plan.contractRefs || [])
    .filter(ref => !existingContractIds.has(ref.contractId))
    .filter(ref => !options.contractId || ref.contractId === options.contractId)
    .slice(0, options.maxTasks || 20)
  if (!pending.length) throw new Error('No qualified ResearchContract is available for dispatch')
  const batchId = `batch-${Date.now()}`
  const batchDir = path.join(root, 'research', 'dispatch', batchId)
  ensureDir(batchDir)
  const schemaPath = path.join(KERNEL_DIR, 'schemas', 'task-outcome.schema.json')
  const entries = []
  for (const ref of pending) {
    const contractRef = ref.path.split(path.sep).join('/')
    const contractPath = path.resolve(root, contractRef)
    const contract = readJson(contractPath)
    const safeContract = safeFileName(contract.contractId)
    const promptPath = path.join(batchDir, `${safeContract}.md`)
    const outputArtifactPath = path.join(batchDir, `${safeContract}.task-outcome.json`)
    const blockingMapDimensions = dedupeStrings((contract.completionRules || []).flatMap(rule => rule.blockingMapDimensions || []))
    const blockingJourneyIds = dedupeStrings([
      ...(contract.targetJourneys || []),
      ...(contract.completionRules || []).flatMap(rule => rule.blockingJourneyIds || []),
    ])
    const item = createWorkItem(root, {
      kind: 'semantic-research',
      role: 'repo-explorer',
      contractRef,
      objectiveSummary: `Resolve ${contract.questions.length} qualified semantic question(s) without widening scope.`,
      blocking: contract.questions.some(question => question.blocking),
      dependencies: [],
      completionPolicyRef: `${contractRef}#completionRules`,
      inputArtifactRefs: dedupeStrings([
        contractRef,
        ...contract.deterministicContextRefs,
        path.relative(root, promptPath).split(path.sep).join('/'),
      ]),
      outputArtifactPath,
      outputSchemaRef: schemaPath,
      communityIds: contract.scope.communityIds,
      neighborMapRef: fs.existsSync(path.join(root, 'static', 'neighbor-map.json')) ? 'static/neighbor-map.json' : null,
      blockingMapDimensions,
      blockingJourneyIds,
      qualityClass: contract.questions.some(question => ['high', 'critical'].includes(question.criticality)) ? 'critical' : 'analytical',
      criticality: highestCriticality(contract.questions.map(question => question.criticality)),
      budgetHints: contract.budgetHints,
    })
    fs.writeFileSync(promptPath, renderResearchWorkPrompt({ root, contract, contractPath, item, schemaPath }), 'utf8')
    const issued = planAndIssueWorkItem(root, item)
    entries.push({
      itemId: item.itemId,
      attempt: item.attempt,
      kind: item.kind,
      role: item.role,
      contractId: contract.contractId,
      contractPath,
      workItemPath: issued.itemPath,
      promptPath,
      outputArtifactPath,
      workResultPath: issued.workResultPath,
      outputSchemaPath: schemaPath,
      questionIds: contract.questions.map(question => question.questionId),
      communityIds: item.communityIds,
      blockingMapDimensions,
      blockingJourneyIds,
      telemetry: telemetryCommands(root, item.itemId),
      ingestCommand: ingestCommandFor(root, issued.workResultPath),
    })
  }
  const manifest = {
    schemaVersion: 'repo-work-dispatch/v3',
    batchId,
    generatedAt: new Date().toISOString(),
    packageDir: root,
    taskCount: entries.length,
    workItems: entries,
    joinRequired: true,
    debug: debugPointers(root),
  }
  fs.writeFileSync(path.join(batchDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

function renderResearchWorkPrompt({ root, contract, contractPath, item, schemaPath }) {
  const outputSchema = readJson(schemaPath)
  const resultPath = path.join(root, 'work', 'results', `${safeFileName(item.itemId)}.result.json`)
  const resultTemplate = {
    schemaVersion: 'repo-work-result/v3',
    itemId: item.itemId,
    runId: item.runId,
    snapshotId: item.snapshotId,
    attempt: item.attempt,
    contractId: contract.contractId,
    status: 'completed',
    outcomeStatus: 'satisfied',
    completionSummary: 'Replace with a concise statement of which criteria were satisfied.',
    output: { path: item.outputArtifactPath, schemaVersion: 'repo-task-outcome/v1' },
    producer: { role: item.role, usage: { status: 'unavailable' } },
    artifactHashes: [{ artifactRef: item.outputArtifactPath, algorithm: 'sha256', value: 'replace-with-64-character-sha256' }],
    readSet: [],
    scopeViolations: [],
    errors: [],
    producedAt: 'replace-with-current-ISO-8601-time',
  }
  return [
    '# Frontend Semantic Research WorkItem',
    '',
    `Package: \`${root}\``,
    `ResearchContract: \`${contractPath}\``,
    `TaskOutcome: \`${item.outputArtifactPath}\``,
    `WorkResult: \`${resultPath}\``,
    '',
    '## Hard contract',
    '',
    '- Answer only the ResearchContract questions.',
    '- Read only scope.allowedFiles plus deterministicContextRefs.',
    '- Record every read in readSet. Source files must use the matching Static Program Graph files[].structureFingerprint; the graph artifact uses its top-level structureFingerprint.',
    '- Record support and counter evidence for every hypothesis.',
    '- Use only governed Evidence IDs. For a source file, the exact ID is `evidence:file:<repository-relative-path>`; do not invent descriptive Evidence IDs. Put line ranges and snippets in hypothesis qualifiers.',
    '- Every supportEvidenceId, counterEvidenceId, and completionEvidence entry must be one of those exact governed IDs.',
    '- Put parser/import/protected-file failures in deterministicDiagnostics; do not turn them into semantic questions.',
    '- Route runtime-only and product-intent questions to their dedicated arrays; do not widen repository scope.',
    '- Write TaskOutcome first, then the WorkResult envelope. Never call ingest or mutate authoritative stores.',
    '',
    '## WorkItem',
    '',
    '```json',
    JSON.stringify(item, null, 2),
    '```',
    '',
    '## ResearchContract',
    '',
    '```json',
    JSON.stringify(contract, null, 2),
    '```',
    '',
    '## TaskOutcome schema',
    '',
    '```json',
    JSON.stringify(outputSchema, null, 2),
    '```',
    '',
    '## WorkResult template',
    '',
    '```json',
    JSON.stringify(resultTemplate, null, 2),
    '```',
    '',
  ].join('\n')
}

function highestCriticality(values) {
  const order = ['low', 'medium', 'high', 'critical']
  return (values || []).reduce((highest, value) => order.indexOf(value) > order.indexOf(highest) ? value : highest, 'low')
}

function dedupeStrings(values) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && value.length > 0))]
}

function stableHash(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function assertNoActiveWorkflowForAnalyze(packageDir) {
  const root = path.resolve(packageDir)
  const statePath = path.join(root, 'state', 'run-state.json')
  const eventPath = path.join(root, 'store', 'run-events.jsonl')
  const legacyMarkers = [...LEGACY_FRONTEND_FILES, ...LEGACY_FRONTEND_DIRECTORIES]
    .filter(relative => fs.existsSync(path.join(root, relative)))
  const state = readJsonIfExists(statePath)
  const events = readJsonLinesIfExists(eventPath)
  const legacyState = state && state.schemaVersion !== 'repo-run-state/v3'
  const legacyEvents = events.some(event => event?.schemaVersion !== 'repo-run-event/v3')
  if (legacyState || legacyEvents || legacyMarkers.length) {
    const detail = [
      ...(legacyState ? [`state schema ${state.schemaVersion || 'missing'}`] : []),
      ...(legacyEvents ? ['non-v3 RunEvent stream'] : []),
      ...legacyMarkers,
    ].join(', ')
    throw new Error(`Legacy repo-understanding package detected (${detail}). Analyze into a fresh --out directory; v2 and v3 state cannot be mixed.`)
  }
  if (!state) return
  const active = Object.values(state.workItems || {}).filter(item => ['ready', 'issued', 'result-produced'].includes(item.status))
  if (active.length) {
    throw new Error(`Cannot analyze while ${active.length} WorkItems are in flight: ${active.map(item => item.itemId).join(', ')}`)
  }
}

function writeRunConfig(packageDir, mode) {
  const root = path.resolve(packageDir)
  const profiles = {
    fast: {
      maxContractsPerDispatch: 8,
    },
    deep: {
      maxContractsPerDispatch: 24,
    },
  }
  const value = {
    schemaVersion: 'repo-run-config/v3',
    mode,
    ...profiles[mode],
    writtenAt: new Date().toISOString(),
  }
  const file = path.join(root, 'state', 'run-config.json')
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return value
}

function readRunConfig(packageDir) {
  return readJsonIfExists(path.join(path.resolve(packageDir), 'state', 'run-config.json')) || {
    schemaVersion: 'repo-run-config/v3',
    mode: 'fast',
    maxContractsPerDispatch: 8,
  }
}

function gitChangedFiles(repoPath, base) {
  const res = spawnSync('git', ['diff', '--name-only', base, '--'], { cwd: repoPath, encoding: 'utf8', timeout: 5000 })
  if (res.status !== 0) return []
  return res.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

function writeStaticInvalidationReport(outDir, plan, staticProgramGraph) {
  const changed = new Set(plan.changedFiles)
  const affectedEntityIds = (staticProgramGraph.nodes || [])
    .filter(node => changed.has(node.source?.path || node.sourcePath))
    .map(node => node.nodeId || node.entityId || node.id)
    .filter(Boolean)
    .sort()
  const report = {
    ...plan,
    snapshotId: staticProgramGraph.snapshotId,
    affectedEntityIds,
    structureFingerprint: staticProgramGraph.structureFingerprint || null,
    generatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(outDir, 'static', 'invalidation.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function purgeLegacyFrontendArtifacts(packageDir) {
  for (const relative of LEGACY_FRONTEND_FILES) fs.rmSync(path.join(packageDir, relative), { force: true })
  for (const relative of LEGACY_FRONTEND_DIRECTORIES) fs.rmSync(path.join(packageDir, relative), { recursive: true, force: true })
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

function countTasksBy(tasks, keyFn) {
  const counts = {}
  for (const task of tasks || []) {
    const key = keyFn(task)
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function safeFileName(value) {
  return String(value || 'bundle').replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function workResultEnvelopePath(packageDir, itemId) {
  return path.resolve(packageDir, 'work', 'results', `${safeFileName(itemId)}.result.json`)
}

function createSynthesisWorkItem(packageDir, options = {}) {
  const root = path.resolve(packageDir)
  const attempt = Number(options.attempt || 1)
  const synthesisDir = path.join(root, 'synthesis')
  ensureDir(synthesisDir)
  const mapManifest = readJson(path.join(root, 'projections', 'manifest.json'))
  const frame = readJson(path.join(root, 'static', 'investigation-frame.json'))
  const mapRefs = Object.values(mapManifest.projections).map(entry => entry.path)
  const journeyManifestRef = 'store/journeys/manifest.json'
  const journeyManifest = readJson(path.join(root, journeyManifestRef))
  const journeyRefs = dedupeStrings([
    journeyManifestRef,
    ...(journeyManifest.entries || []).flatMap(entry => [
      entry.definitionPath,
      entry.bindingPath,
      entry.closureReportPath,
    ]),
  ])
  for (const ref of journeyRefs) {
    if (!fs.existsSync(path.join(root, ref))) throw new Error(`Canonical Journey artifact is missing: ${ref}`)
  }
  const questionRef = 'planning/open-questions.json'
  const deterministicContextRefs = dedupeStrings([
    'projections/manifest.json',
    ...mapRefs,
    ...journeyRefs,
    ...(fs.existsSync(path.join(root, questionRef)) ? [questionRef] : []),
  ])
  const targetJourneys = (journeyManifest.entries || []).map(entry => entry.journeyId).filter(Boolean)
  const contractId = `contract:synthesis:${stableHash(JSON.stringify(mapManifest.projectionKey)).slice(0, 20)}`
  const contractRef = 'synthesis/research-contract.json'
  const contractPath = path.join(root, contractRef)
  const contract = {
    schemaVersion: 'repo-research-contract/v1',
    contractId,
    snapshotId: mapManifest.snapshotId,
    investigationFrameId: frame.frameId,
    questions: [{
      questionId: 'question:synthesis-narrative',
      question: 'How should the four verified Product Maps and closed Journeys be explained without adding new facts?',
      rationale: 'The human narrative must remain a consumer of governed maps, journeys, claims, and evidence.',
      criticality: 'high',
      blocking: true,
      targetMaps: ['application', 'experience', 'runtime-flow', 'change'],
      targetJourneyIds: targetJourneys,
      supportEvidenceRequirements: ['Reference the current Product Map projectionKey and exact map paths.'],
      counterEvidenceRequirements: ['List unresolved runtime, product-intent, semantic, diagnostic, or journey-closure limitations explicitly.'],
      completionCriteria: [
        'Preserve Product Map and Journey ordering.',
        'Reference only accepted Claim, Evidence, Question, Journey, and Map identifiers.',
        'Do not infer missing feedback, outcomes, or business intent.',
      ],
      blockedConditions: ['A current Product Map is missing or a critical Journey remains unclosed.'],
    }],
    hypotheses: [],
    targetMaps: ['application', 'experience', 'runtime-flow', 'change'],
    targetJourneys,
    scope: {
      communityIds: ['community:product-maps'],
      entryEntities: ['map:application', 'map:experience', 'map:runtime-flow', 'map:change'],
      allowedFiles: deterministicContextRefs,
      neighborDepth: 0,
    },
    deterministicContextRefs,
    acceptanceCriteria: [{
      criterionId: 'criterion:synthesis-grounded',
      description: 'Narrative references the current Product Maps and exposes all unresolved limitations.',
      questionIds: ['question:synthesis-narrative'],
      hypothesisIds: [],
      blocking: true,
      minimumEvidenceCount: 0,
    }],
    completionRules: [{
      ruleId: 'completion:synthesis-grounded',
      description: 'All four map summaries are present and every unresolved governed question is represented as a limitation.',
      blockingMapDimensions: [
        'application-bootstrap', 'route-layout-page', 'component-composition', 'state-ownership-data-flow',
        'api-client', 'auth-permission', 'build-deploy', 'testing-quality', 'core-journeys',
      ],
      blockingJourneyIds: targetJourneys,
    }],
    stopRules: [
      { ruleId: 'stop:synthesis-complete', condition: 'The narrative schema and all governed references validate.', action: 'stop' },
      { ruleId: 'stop:synthesis-stale', condition: 'A Product Map, Journey, Claim, or Evidence reference is stale.', action: 'block' },
    ],
    blockedPolicies: [
      { category: 'runtime-external-blocked', action: 'block', description: 'Expose runtime-only limitations without inventing an answer.' },
      { category: 'product-intent', action: 'request-input', description: 'Expose product-intent limitations without inventing intent.' },
      { category: 'budget-exhausted', action: 'defer', description: 'Do not truncate required map dimensions or limitations.' },
    ],
    budgetHints: {
      maxFiles: Math.max(1, deterministicContextRefs.length),
      maxContextBytes: 600000,
      maxOutputBytes: 64000,
      maxTokens: 12000,
      maxDurationMs: 900000,
    },
  }
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
  const basePromptPath = path.join(synthesisDir, 'request.md')
  const baseOutputPath = path.join(synthesisDir, 'narrative.json')
  const promptPath = attempt === 1 ? basePromptPath : withAttemptSuffix(basePromptPath, attempt, '.md')
  const outputArtifactPath = attempt === 1 ? baseOutputPath : withAttemptSuffix(baseOutputPath, attempt, '.json')
  const schemaPath = path.join(KERNEL_DIR, 'schemas', 'synthesis-output.schema.json')
  const promptRef = path.relative(root, promptPath).split(path.sep).join('/')
  const inputArtifactRefs = dedupeStrings([contractRef, ...deterministicContextRefs, promptRef])
  const requestBytes = inputArtifactRefs.reduce((total, ref) => {
    const file = path.resolve(root, ref)
    return total + (fs.existsSync(file) && fs.statSync(file).isFile() ? fs.statSync(file).size : 0)
  }, 0)
  const maxContextBytes = 600000
  if (requestBytes > maxContextBytes) {
    throw new Error(`Synthesis request exceeds hard context cap: ${requestBytes} > ${maxContextBytes} bytes`)
  }
  const workItem = createWorkItem(root, {
    attempt,
    retryOf: options.retryOf,
    idempotencyKey: options.idempotencyKey,
    kind: 'synthesize',
    role: 'repo-synthesizer',
    contractRef,
    objectiveSummary: 'Explain the current four Product Maps and Journeys in Chinese without generating or changing facts.',
    blocking: true,
    dependencies: [],
    completionPolicyRef: `${contractRef}#completionRules`,
    inputArtifactRefs,
    outputArtifactPath,
    outputSchemaRef: schemaPath,
    communityIds: ['community:product-maps'],
    neighborMapRef: fs.existsSync(path.join(root, 'static', 'neighbor-map.json')) ? 'static/neighbor-map.json' : null,
    blockingMapDimensions: contract.completionRules[0].blockingMapDimensions,
    blockingJourneyIds: targetJourneys,
    qualityClass: 'critical',
    criticality: 'high',
    budgetHints: {
      maxFiles: Math.max(1, inputArtifactRefs.length),
      maxContextBytes,
      maxOutputBytes: 64000,
      maxTokens: 12000,
      maxDurationMs: 900000,
    },
  })
  const prompt = renderSynthesisWorkPrompt({
    packageDir: root,
    workItem,
    contract,
    mapManifest,
    schemaPath,
  })
  fs.writeFileSync(promptPath, prompt, 'utf8')
  return { workItem, promptPath, outputArtifactPath, schemaPath, contractPath, contract, mapManifest }
}

function renderSynthesisWorkPrompt({ packageDir, workItem, contract, mapManifest, schemaPath }) {
  const schema = readJson(schemaPath)
  const workResultTemplate = {
    schemaVersion: 'repo-work-result/v3',
    itemId: workItem.itemId,
    runId: workItem.runId,
    snapshotId: workItem.snapshotId,
    attempt: workItem.attempt,
    contractId: contract.contractId,
    status: 'completed',
    outcomeStatus: 'satisfied',
    completionSummary: 'Summarized the current Product Maps and preserved every governed limitation.',
    output: {
      path: workItem.outputArtifactPath,
      schemaVersion: 'repo-synthesis-narrative/v3',
    },
    producer: { role: workItem.role, usage: { status: 'unavailable' } },
    artifactHashes: [{ artifactRef: workItem.outputArtifactPath, algorithm: 'sha256', value: 'replace-with-64-character-sha256' }],
    readSet: [],
    scopeViolations: [],
    errors: [],
    producedAt: 'replace-with-current-ISO-8601-time',
  }
  const narrativeTemplate = {
    schemaVersion: 'repo-synthesis-narrative/v3',
    snapshotId: mapManifest.snapshotId,
    mapManifestRef: 'projections/manifest.json',
    projectionKey: mapManifest.projectionKey,
    title: 'Replace with a concise repository title',
    executiveSummary: 'Replace with a governed summary.',
    applicationSummary: 'Summarize Application Map only.',
    experienceSummary: 'Summarize Experience Map only.',
    runtimeFlowSummary: 'Summarize Runtime Flow Map without changing step order.',
    changeSummary: 'Summarize Change Map deterministically.',
    journeySummaries: [],
    limitations: [],
    mapRefs: Object.fromEntries(Object.entries(mapManifest.projections).map(([key, entry]) => [key, entry.path])),
    journeyRefs: [],
    claimRefs: [],
    evidenceRefs: [],
    questionRefs: [],
    generatedAt: 'replace-with-current-ISO-8601-time',
  }
  return [
    '# Product Map Narrative WorkItem',
    '',
    `WorkItem: \`${workItem.itemId}\``,
    `Attempt: \`${workItem.attempt}\``,
    `Package: \`${packageDir}\``,
    `Role output JSON: \`${workItem.outputArtifactPath}\``,
    `WorkResult envelope: \`${workResultEnvelopePath(packageDir, workItem.itemId)}\``,
    `Role output schema: \`${schemaPath}\``,
    '',
    '## Contract',
    '',
    '- Read only WorkItem.inputArtifactRefs. Do not inspect the repository again.',
    '- Write the role output JSON first, then write the WorkResult envelope at the exact paths above.',
    '- Do not call ingest, project, verify, report, or HTML commands. Return control to the orchestrator.',
    '- Use simplified Chinese for all narrative fields; keep code identifiers, paths, and proper nouns unchanged.',
    '- Do not change Journey order or invent feedback, outcome, business intent, or missing bindings.',
    '- Every unresolved governed Question must appear in limitations and questionRefs.',
    '- The four Product Maps remain authoritative; this output is narrative only.',
    '- If blocked or failed, do not write a role output; set the envelope status accordingly and populate errors.',
    '',
    '## WorkItem',
    '',
    '```json',
    JSON.stringify(workItem, null, 2),
    '```',
    '',
    '## ResearchContract',
    '',
    '```json',
    JSON.stringify(contract, null, 2),
    '```',
    '',
    '## Product Map Manifest',
    '',
    '```json',
    JSON.stringify(mapManifest, null, 2),
    '```',
    '',
    '## Role Output Schema',
    '',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    '',
    '## Narrative Template',
    '',
    '```json',
    JSON.stringify(narrativeTemplate, null, 2),
    '```',
    '',
    '## WorkResult Envelope Template',
    '',
    '```json',
    JSON.stringify(workResultTemplate, null, 2),
    '```',
    '',
  ].join('\n')
}

function synthesisDispatchEntry(packageDir, bundle, issued) {
  const item = bundle.workItem
  return {
    itemId: item.itemId,
    attempt: item.attempt,
    workItemPath: issued.itemPath,
    workResultPath: issued.workResultPath,
    promptPath: bundle.promptPath,
    outputArtifactPath: bundle.outputArtifactPath,
    schemaPath: bundle.schemaPath,
    contractId: bundle.contract.contractId,
    contractPath: bundle.contractPath,
    kind: item.kind,
    role: item.role,
    taskCount: 1,
    qualityClass: item.qualityClass,
    criticality: item.criticality,
    budgetHints: item.budgetHints,
    telemetry: telemetryCommands(packageDir, item.itemId),
    ingestCommand: ingestCommandFor(packageDir, issued.workResultPath),
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null
  return readJson(file)
}

function readJsonLinesIfExists(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function fileJson(res, file) {
  return text(res, fs.readFileSync(file, 'utf8'), 'application/json; charset=utf-8')
}

function fileText(res, file, contentType) {
  return text(res, fs.readFileSync(file), contentType)
}

function json(res, body, status = 200) {
  return text(res, JSON.stringify(body, null, 2), 'application/json; charset=utf-8', status)
}

function text(res, body, contentType, status = 200) {
  res.writeHead(status, { 'content-type': contentType })
  res.end(body)
}

function numericArg(args, name) {
  if (args[name] === undefined) return undefined
  const value = Number(args[name])
  if (!Number.isFinite(value) || value < 0) usage()
  return value
}

function withAttemptSuffix(file, attempt, extension = path.extname(file)) {
  const resolved = path.resolve(file)
  const base = extension && resolved.endsWith(extension) ? resolved.slice(0, -extension.length) : resolved
  return `${base}.attempt-${attempt}${extension}`
}

function telemetryCommands(packageDir, itemId) {
  const root = path.resolve(packageDir)
  return {
    startCommand: `npm run --silent understanding:harness -- trace --package ${JSON.stringify(root)} --item ${JSON.stringify(itemId)} --event started`,
    completeCommand: `npm run --silent understanding:harness -- trace --package ${JSON.stringify(root)} --item ${JSON.stringify(itemId)} --event completed [usage flags when available]`,
    failCommand: `npm run --silent understanding:harness -- trace --package ${JSON.stringify(root)} --item ${JSON.stringify(itemId)} --event failed`,
  }
}

function ingestCommandFor(packageDir, workResultPath) {
  return `npm run --silent understanding:harness -- ingest --package ${JSON.stringify(path.resolve(packageDir))} --work-result ${JSON.stringify(workResultPath)}`
}

function isV3HumanProjectionCurrent(packageDir) {
  const analysisPath = path.join(packageDir, 'synthesis', 'narrative.json')
  const manifestPath = path.join(packageDir, 'projections', 'manifest.json')
  const htmlPath = path.join(packageDir, 'human-readable.html')
  if (![analysisPath, manifestPath, htmlPath].every(fs.existsSync)) return false
  return fs.statSync(htmlPath).mtimeMs >= Math.max(fs.statSync(analysisPath).mtimeMs, fs.statSync(manifestPath).mtimeMs)
}

function completeRunIfDeliverable(packageDir) {
  const root = path.resolve(packageDir)
  const state = syncProducedResults(root)
  if (state.terminal === 'completed') {
    return { completed: true, alreadyCompleted: true, runId: state.runId }
  }
  const validation = writeFrontendVerification({ packageDir: root, phase: 'complete' }).verification
  if (!validation.passed || !isV3HumanProjectionCurrent(root)) {
    return { completed: false, runId: state.runId }
  }
  const mapManifest = readJson(path.join(root, 'projections', 'manifest.json'))
  const next = appendRunEvent(root, 'run-completed', {
    narrativePath: path.join(root, 'synthesis', 'narrative.json'),
    humanReadablePath: path.join(root, 'human-readable.html'),
    mapManifestPath: path.join(root, 'projections', 'manifest.json'),
    projectionKey: mapManifest.projectionKey,
    verificationPath: path.join(root, 'verification', 'frontend-verification.json'),
  }, { actor: 'orchestrator' }).state
  return { completed: true, alreadyCompleted: false, runId: next.runId }
}

function debugPointers(packageDir) {
  const summary = buildAgentDebugSummary(packageDir)
  return {
    schemaVersion: summary.schemaVersion,
    runId: summary.runId,
    tracePath: summary.files.trace,
    statePath: summary.files.state,
    command: `npm run --silent understanding:harness -- debug --package ${JSON.stringify(path.resolve(packageDir))}`,
    invocations: summary.invocations,
    aggregateUsage: summary.aggregateUsage,
  }
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

await main()
