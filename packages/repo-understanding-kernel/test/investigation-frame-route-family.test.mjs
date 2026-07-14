import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFrontendInvestigationFrame, validateRepoInvestigationFrame } from '../src/census/investigation-frame.mjs'
import { deriveJourneyCandidates } from '../src/knowledge/journey-store.mjs'
import { buildResearchContracts, qualifyOpenQuestions } from '../src/planning/research-contract-planner.mjs'

const generatedAt = '2026-07-14T00:00:00.000Z'
const snapshotId = 'snapshot:route-family'

test('groups route families from the Static Program Graph and plans semantic research without product-intent templates', () => {
  const routeRoot = route('route:merchant', '/merchant/query', 10)
  const routeLook = route('route:merchant-look', '/merchant/query/look', 20)
  const pageRoot = page('page:merchant', 'src/views/merchant/index.vue')
  const pageLook = page('page:merchant-look', 'src/views/merchant/Look.vue')
  const staticProgramGraph = {
    schemaVersion: 'repo-static-program-graph/v1',
    snapshotId,
    supportLevel: 'supported-frontend',
    generatedAt,
    nodes: [routeRoot, routeLook, pageRoot, pageLook],
    edges: [
      render('edge:root', routeRoot.nodeId, pageRoot.nodeId, 10),
      render('edge:look', routeLook.nodeId, pageLook.nodeId, 20),
    ],
    diagnostics: [],
  }
  const supportDecision = {
    schemaVersion: 'repo-support-decision/v1',
    snapshotId,
    supportLevel: 'supported-frontend',
    repoKind: 'frontend',
    unsupportedReason: null,
    frontendRoots: ['.'],
    backendRoots: [],
    evidenceRefs: [],
    generatedAt,
  }
  const inventory = {
    schemaVersion: 'repo-inventory/v1',
    generatedAt,
    repo: { name: 'route-family-fixture', path: '/tmp/route-family-fixture' },
    files: [
      file('src/router.js'),
      file('src/views/merchant/index.vue'),
      file('src/views/merchant/Look.vue'),
    ],
  }
  const communityMap = {
    communities: [{
      communityId: 'community:merchant',
      memberNodeIds: [routeRoot.nodeId, routeLook.nodeId, pageRoot.nodeId, pageLook.nodeId],
      allowedFiles: inventory.files.map(item => item.path),
    }],
  }
  const frame = buildFrontendInvestigationFrame({
    inventory,
    codeMap: { routes: [], manifests: [], dependencies: [] },
    profile: { frameworks: [{ name: 'vue' }] },
    supportDecision,
    staticProgramGraph,
    communityMap,
    snapshotId,
    generatedAt,
    supportDecisionRef: 'static/support-decision.json',
  })

  assert.deepEqual(validateRepoInvestigationFrame(frame), [])
  assert.equal(frame.coreFlowCandidates.length, 1)
  assert.equal(frame.coreFlowCandidates[0].title, '/merchant/query')
  assert.equal(frame.coreFlowCandidates[0].entryEntityIds.length, 2)
  assert.equal(frame.unresolvedSemanticAmbiguities.length, 1)
  assert.equal(frame.unresolvedSemanticAmbiguities[0].competingHypotheses.length, 3)
  assert.deepEqual(frame.unresolvedSemanticAmbiguities[0].allowedFiles, [
    'src/router.js',
    'src/views/merchant/index.vue',
    'src/views/merchant/Look.vue',
  ])

  const qualified = qualifyOpenQuestions({ investigationFrame: frame, snapshotId, generatedAt })
  const contracts = buildResearchContracts({ snapshotId, investigationFrame: frame, openQuestions: qualified.openQuestions, generatedAt })
  const journeys = deriveJourneyCandidates({ staticProgramGraph, investigationFrame: frame, generatedAt })

  assert.equal(qualified.openQuestions.length, 1)
  assert.equal(qualified.openQuestions[0].category, 'semantic-ambiguity')
  assert.equal(qualified.openQuestions.some(question => question.category === 'product-intent'), false)
  assert.equal(contracts.length, 1)
  assert.equal(contracts[0].hypotheses.length, 3)
  assert.deepEqual(contracts[0].questions[0].evidenceIds, [
    'evidence:file:src/router.js',
    'evidence:file:src/views/merchant/index.vue',
    'evidence:file:src/views/merchant/Look.vue',
  ])
  assert.deepEqual(contracts[0].targetJourneys, [journeys.definitions[0].journeyId])
})

function route(nodeId, routePath, line) {
  return {
    nodeId,
    kind: 'route',
    label: routePath,
    source: { sourcePath: 'src/router.js', line },
    attributes: { routePath },
    evidenceRefs: ['evidence:file:src/router.js'],
  }
}

function page(nodeId, sourcePath) {
  return {
    nodeId,
    kind: 'page',
    label: sourcePath.split('/').at(-1),
    source: { sourcePath, line: 1 },
    attributes: {},
    evidenceRefs: [`evidence:file:${sourcePath}`],
  }
}

function render(edgeId, from, to, line) {
  return {
    edgeId,
    type: 'route-renders-page',
    from,
    to,
    source: { sourcePath: 'src/router.js', line },
    evidenceRefs: ['evidence:file:src/router.js'],
  }
}

function file(path) {
  return {
    path,
    size: 1,
    hash: `hash:${path}`,
    hashKind: 'content',
    language: path.endsWith('.vue') ? 'Vue SFC' : 'JavaScript',
    category: 'source',
    binary: false,
    large: false,
    contentAnalyzable: true,
    protected: false,
    protectionReason: null,
  }
}
