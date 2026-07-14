import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildProductMaps,
  validateProductMaps,
  writeProductMaps,
} from '../src/projections/product-maps.mjs'

const generatedAt = '2026-07-13T00:00:00.000Z'
const snapshotId = 'snapshot:product-map-fixture'

test('projects deterministic application, experience, runtime, and change maps', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-product-maps-'))
  const input = fixtureInput(packageDir)
  const first = buildProductMaps(input)
  const second = buildProductMaps(input)

  assert.deepEqual(second, first)
  assert.deepEqual(validateProductMaps(first), [])
  const invalid = structuredClone(first)
  invalid.applicationMap.unexpected = true
  assert.ok(validateProductMaps(invalid).some(issue => issue.includes('$ApplicationMap.unexpected is not allowed')))
  assert.equal(first.applicationMap.application.framework, 'react')
  assert.equal(first.applicationMap.supportLevel, 'supported-frontend')
  assert.ok(first.applicationMap.relations.some(item => item.type === 'routes-to' && item.to === 'module:src/pages/Home.tsx'))
  assert.equal(first.applicationMap.diagnostics[0].kind, 'import-resolution-failure')
  assert.equal(Object.hasOwn(first.applicationMap.diagnostics[0], 'question'), false)

  assert.equal(first.experienceMap.journeys.length, 1)
  assert.equal(first.experienceMap.journeys[0].goal, 'Submit the checkout form')
  assert.deepEqual(first.experienceMap.semanticClaims.map(item => item.claimId), ['claim:home-role'])

  const flow = first.runtimeFlowMap.flows[0]
  assert.equal(flow.steps[0].kind, 'route')
  assert.deepEqual(flow.steps.map(item => item.order), flow.steps.map((_, index) => index + 1))
  assert.ok(flow.steps.some(item => item.kind === 'endpoint'))
  assert.ok(flow.steps.some(item => item.kind === 'outcome'))

  const clientImpact = first.changeMap.changeSets.find(item => item.subjectId === 'module:src/api/client.ts')
  assert.ok(clientImpact)
  assert.ok(clientImpact.reverseDependencies.includes('module:src/pages/Home.tsx'))
  assert.ok(clientImpact.reverseDependencies.includes('module:src/main.tsx'))
  assert.deepEqual(clientImpact.impactedPageIds, ['module:src/pages/Home.tsx'])
  assert.deepEqual(clientImpact.impactedRouteIds, ['route:home'])
  assert.deepEqual(clientImpact.impactedJourneyIds, ['journey:checkout'])
  assert.ok(clientImpact.impactedSurfaces.tests.includes('src/pages/Home.test.tsx'))
  assert.ok(clientImpact.impactedSurfaces.buildDeploy.includes('package.json#scripts.build'))
  assert.deepEqual(clientImpact.blockedDimensions.map(item => item.dimension), ['core-journeys'])

  const written = writeProductMaps(input)
  for (const filePath of Object.values(written.paths).filter(item => item.endsWith('.json'))) assert.ok(fs.existsSync(filePath), filePath)
  const manifest = JSON.parse(fs.readFileSync(written.paths.manifest, 'utf8'))
  assert.equal(manifest.projections.change.path, 'projections/change-map.json')
  assert.match(manifest.projections.change.contentHash, /^[a-f0-9]{64}$/)
})

test('keeps projection keys and semantic content hashes stable across independent run timestamps', () => {
  const firstInput = fixtureInput(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-product-maps-time-a-')))
  const secondInput = structuredClone(firstInput)
  secondInput.packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-product-maps-time-b-'))
  secondInput.generatedAt = '2030-01-01T00:00:00.000Z'
  secondInput.staticProgramGraph.generatedAt = '2030-01-01T00:00:00.000Z'
  secondInput.investigationFrame.generatedAt = '2030-01-01T00:00:00.000Z'
  secondInput.acceptedClaims[0].createdAt = '2030-01-01T00:00:00.000Z'
  secondInput.journeys.definitions[0].createdAt = '2030-01-01T00:00:00.000Z'
  secondInput.journeys.definitions[0].updatedAt = '2030-01-01T00:00:00.000Z'
  secondInput.journeys.bindings[0].generatedAt = '2030-01-01T00:00:00.000Z'

  const first = buildProductMaps(firstInput)
  const second = buildProductMaps(secondInput)

  assert.deepEqual(second.manifest.projectionKey, first.manifest.projectionKey)
  assert.deepEqual(second.applicationMap.mapId, first.applicationMap.mapId)
  assert.deepEqual(second.manifest.projections, first.manifest.projections)
  assert.notEqual(second.applicationMap.generatedAt, first.applicationMap.generatedAt)
})

test('refuses to publish frontend product maps for unsupported repositories', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-product-maps-unsupported-'))
  const input = fixtureInput(packageDir)
  input.staticProgramGraph.supportLevel = 'unsupported'
  assert.throws(() => buildProductMaps(input), /unsupported frontend repository/)
})

test('carries frontend-subtree-only support into the governed Application Map', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-product-maps-subtree-'))
  const input = fixtureInput(packageDir)
  input.staticProgramGraph.supportLevel = 'frontend-subtree-only'

  const result = buildProductMaps(input)

  assert.equal(result.applicationMap.supportLevel, 'frontend-subtree-only')
  assert.deepEqual(validateProductMaps(result), [])
})

function fixtureInput(packageDir) {
  return {
    packageDir,
    generatedAt,
    staticProgramGraph: staticGraph(),
    investigationFrame: investigationFrame(),
    acceptedClaims: [semanticClaim()],
    journeys: {
      definitions: [journeyDefinition()],
      bindings: [journeyBinding()],
    },
  }
}

function staticGraph() {
  const modules = [
    'src/main.tsx',
    'src/App.tsx',
    'src/pages/Home.tsx',
    'src/api/client.ts',
    'src/pages/Home.test.tsx',
  ]
  const nodes = modules.map(sourcePath => graphNode(`module:${sourcePath}`, 'module', sourcePath, sourcePath))
  nodes.push(graphNode('route:home', 'route', '/', 'src/App.tsx'))
  return {
    schemaVersion: 'repo-static-program-graph/v1',
    graphId: 'graph:fixture',
    snapshotId,
    supportDecisionRef: `support-decision:${snapshotId}`,
    supportLevel: 'supported-frontend',
    roots: ['.'],
    frameworks: ['react'],
    languages: [{ name: 'React TS', fileCount: modules.length }],
    parser: { mode: 'compiler', providers: [] },
    files: [],
    nodes,
    edges: [
      graphEdge('imports', 'module:src/main.tsx', 'module:src/App.tsx', 'src/main.tsx'),
      graphEdge('imports', 'module:src/App.tsx', 'module:src/pages/Home.tsx', 'src/App.tsx'),
      graphEdge('imports', 'module:src/pages/Home.tsx', 'module:src/api/client.ts', 'src/pages/Home.tsx'),
      graphEdge('imports', 'module:src/pages/Home.test.tsx', 'module:src/pages/Home.tsx', 'src/pages/Home.test.tsx'),
      graphEdge('declares-route', 'module:src/App.tsx', 'route:home', 'src/App.tsx'),
    ],
    diagnostics: [{
      diagnosticId: 'diagnostic:missing-import',
      kind: 'import-resolution-failure',
      severity: 'warning',
      message: 'A fixture import could not be resolved.',
      sourcePath: 'src/App.tsx',
      line: 1,
      details: {},
      evidenceRefs: ['evidence:file:src/App.tsx'],
    }],
    metrics: {
      sourceFiles: modules.length,
      parsedFiles: modules.length,
      compilerParsedFiles: modules.length,
      fallbackParsedFiles: 0,
      nodeCount: nodes.length,
      edgeCount: 5,
      diagnosticCount: 1,
      parseFailureCount: 0,
      importResolutionFailureCount: 1,
    },
    generatedAt,
  }
}

function graphNode(nodeId, kind, label, sourcePath) {
  return {
    nodeId,
    kind,
    label,
    language: 'React TS',
    frameworks: ['react'],
    source: { sourcePath, line: 1, provider: 'typescript', sourceKind: 'compiler-ast' },
    evidenceRefs: [`evidence:file:${sourcePath}`],
    attributes: kind === 'module' ? { sourcePath } : { routePath: label },
  }
}

function graphEdge(type, from, to, sourcePath) {
  return {
    edgeId: `edge:${type}:${from}:${to}`,
    type,
    from,
    to,
    source: { sourcePath, line: 1, provider: 'typescript', sourceKind: 'compiler-ast' },
    evidenceRefs: [`evidence:file:${sourcePath}`],
    confidence: 1,
    attributes: {},
  }
}

function investigationFrame() {
  return {
    schemaVersion: 'repo-investigation-frame/v1',
    frameId: 'frame:fixture',
    snapshotId,
    supportDecisionRef: `support-decision:${snapshotId}`,
    applicationKind: 'spa',
    framework: { name: 'react', version: '19.0.0', confidence: 1, evidenceRefs: ['evidence:manifest:package.json'] },
    bundler: { name: 'vite', configPaths: ['vite.config.ts'], confidence: 1, evidenceRefs: ['evidence:file:vite.config.ts'] },
    packageWorkspaceRoots: [{ path: '.', kind: 'application', evidenceRefs: ['evidence:manifest:package.json'] }],
    browserBootstrap: { entryPath: 'src/main.tsx', entryEntityId: 'module:src/main.tsx', bootstrapKind: 'client-render', evidenceRefs: ['evidence:file:src/main.tsx'], confidence: 1 },
    applicationRoot: { entityId: 'module:src/App.tsx', sourcePath: 'src/App.tsx', evidenceRefs: ['evidence:file:src/App.tsx'], confidence: 1 },
    routeRoots: [{ entityId: 'module:src/App.tsx', sourcePath: 'src/App.tsx', routeKind: 'declarative', evidenceRefs: ['evidence:file:src/App.tsx'], confidence: 1 }],
    layoutCandidates: [],
    pageCandidates: [{ entityId: 'module:src/pages/Home.tsx', sourcePath: 'src/pages/Home.tsx', routeIds: ['route:home'], evidenceRefs: ['evidence:file:src/pages/Home.tsx'], confidence: 1 }],
    coreFlowCandidates: [],
    stateSystems: [{ name: 'checkout-store', kind: 'client-global', sourcePaths: ['src/store/checkout.ts'], evidenceRefs: ['evidence:file:src/store/checkout.ts'] }],
    apiClientCandidates: [{ entityId: 'module:src/api/client.ts', sourcePath: 'src/api/client.ts', clientKind: 'request-client-wrapper', evidenceRefs: ['evidence:file:src/api/client.ts'], confidence: 1 }],
    authPermissionCandidates: [],
    buildDeploySurfaces: [{ kind: 'build', sourcePath: 'package.json#scripts.build', evidenceRefs: ['evidence:manifest:package.json'] }],
    testQualitySurfaces: [
      { kind: 'unit', sourcePath: 'src/pages/Home.test.tsx', evidenceRefs: ['evidence:file:src/pages/Home.test.tsx'] },
      { kind: 'unit', sourcePath: 'package.json#scripts.test', evidenceRefs: ['evidence:manifest:package.json'] },
    ],
    deterministicDiagnostics: [],
    unresolvedSemanticAmbiguities: [{
      ambiguityId: 'ambiguity:checkout-outcome',
      question: 'Does checkout success remain on the page or navigate away?',
      rationale: 'The user-visible outcome is ambiguous.',
      relatedEntityIds: ['module:src/api/client.ts'],
      competingHypotheses: [
        { statement: 'Stays', subject: 'journey:checkout', predicate: 'leads-to-outcome', object: 'feedback:success', hypothesisType: 'semantic-classification', expectedSupportEvidence: [], expectedCounterEvidence: [], qualifiers: {}, initialConfidence: 0.5 },
        { statement: 'Navigates', subject: 'journey:checkout', predicate: 'leads-to-outcome', object: 'route:confirmation', hypothesisType: 'semantic-classification', expectedSupportEvidence: [], expectedCounterEvidence: [], qualifiers: {}, initialConfidence: 0.5 },
      ],
      targetMapDimensions: ['core-journeys'],
      targetJourneyIds: ['journey:checkout'],
      evidenceRefs: [],
      criticality: 'high',
      blocking: true,
      expectedInformationGain: 0.9,
      estimatedCost: 1,
      communityIds: ['community:checkout'],
      allowedFiles: ['src/api/client.ts'],
    }],
    requiredMapDimensions: ['application-bootstrap', 'route-layout-page', 'component-composition', 'state-ownership-data-flow', 'api-client', 'auth-permission', 'build-deploy', 'testing-quality', 'core-journeys'],
    generatedAt,
  }
}

function semanticClaim() {
  return {
    schemaVersion: 'repo-claim/v2',
    claimId: 'claim:home-role',
    snapshotId,
    subject: 'module:src/pages/Home.tsx',
    predicate: 'has-business-role',
    object: 'goal:checkout',
    qualifiers: { layer: 'semantic', targetMaps: ['application-map', 'experience-map'], targetJourneyIds: ['journey:checkout'], sourcePath: 'src/pages/Home.tsx' },
    evidenceIds: ['evidence:file:src/pages/Home.tsx'],
    derivation: 'agent',
    status: 'accepted',
    confidence: 0.9,
    riskClass: 'medium',
    createdByItemId: 'item:checkout',
    verification: [],
    supersedes: [],
    supersededBy: [],
    createdAt: generatedAt,
  }
}

function journeyDefinition() {
  return {
    schemaVersion: 'repo-journey-definition/v1',
    journeyId: 'journey:checkout',
    snapshotId,
    title: 'Checkout',
    actor: 'Shopper',
    goal: 'Submit the checkout form',
    trigger: { kind: 'route-entry', description: 'Open checkout', entityId: 'route:home', evidenceIds: ['evidence:file:src/App.tsx'], claimIds: [] },
    entry: { routeId: 'route:home', pageId: 'module:src/pages/Home.tsx', sourcePath: 'src/pages/Home.tsx', evidenceIds: ['evidence:file:src/pages/Home.tsx'], claimIds: ['claim:home-role'] },
    steps: [
      { stepId: 'step:enter', order: 1, title: 'Enter details', description: 'The shopper enters checkout details.', branchIds: [], blocking: true, evidenceIds: ['evidence:file:src/pages/Home.tsx'], claimIds: [] },
      { stepId: 'step:submit', order: 2, title: 'Submit', description: 'The shopper submits checkout.', branchIds: [], blocking: true, evidenceIds: ['evidence:file:src/pages/Home.tsx'], claimIds: [] },
    ],
    branches: [],
    visibleFeedback: [{ feedbackId: 'feedback:success', stepId: 'step:submit', kind: 'success', description: 'Success message', evidenceIds: ['evidence:file:src/pages/Home.tsx'], claimIds: [] }],
    successOutcome: { outcomeId: 'outcome:paid', stepId: 'step:submit', description: 'Checkout is accepted.', evidenceIds: ['evidence:file:src/pages/Home.tsx'], claimIds: [] },
    failureOutcomes: [],
    evidenceIds: ['evidence:file:src/pages/Home.tsx'],
    claimIds: ['claim:home-role'],
    criticality: 'critical',
    status: 'open',
    createdAt: generatedAt,
    updatedAt: generatedAt,
  }
}

function journeyBinding() {
  const bindings = [
    binding('binding:page', 'step:enter', 1, 'page', 'module:src/pages/Home.tsx', 'src/pages/Home.tsx'),
    binding('binding:event', 'step:submit', 2, 'event', 'event:submit', 'src/pages/Home.tsx'),
    binding('binding:handler', 'step:submit', 2, 'handler', 'handler:submit', 'src/pages/Home.tsx'),
    binding('binding:request', 'step:submit', 2, 'request', 'request:checkout', 'src/api/client.ts'),
    binding('binding:endpoint', 'step:submit', 2, 'endpoint', 'endpoint:/checkout', 'src/api/client.ts'),
    binding('binding:feedback', 'step:submit', 2, 'feedback', 'feedback:success', 'src/pages/Home.tsx'),
    binding('binding:outcome', 'step:submit', 2, 'outcome', 'outcome:paid', 'src/pages/Home.tsx'),
  ]
  return {
    schemaVersion: 'repo-journey-binding/v1',
    bindingSetId: 'binding-set:checkout',
    journeyId: 'journey:checkout',
    snapshotId,
    bindings,
    relations: bindings.slice(1).map((item, index) => ({
      fromBindingId: bindings[index].bindingId,
      toBindingId: item.bindingId,
      kind: index === 0 ? 'triggers' : index === 1 ? 'handles' : index === 2 ? 'requests' : index === 3 ? 'resolves' : index === 4 ? 'shows' : 'produces',
      branchId: null,
      evidenceIds: item.evidenceIds,
      claimIds: item.claimIds,
    })),
    status: 'open',
    generatedAt,
  }
}

function binding(bindingId, stepId, order, bindingType, entityId, sourcePath) {
  return {
    bindingId,
    stepId,
    order,
    branchId: null,
    bindingType,
    entityId,
    entityType: bindingType,
    sourcePath,
    evidenceIds: [`evidence:file:${sourcePath}`],
    claimIds: [],
    confidence: 1,
    status: 'confirmed',
  }
}
