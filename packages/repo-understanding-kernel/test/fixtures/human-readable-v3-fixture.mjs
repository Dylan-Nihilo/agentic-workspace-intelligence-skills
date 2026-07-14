import fs from 'node:fs'
import path from 'node:path'

import { writeJourneyStore } from '../../src/knowledge/journey-store.mjs'
import { productProjectionHash } from '../../src/projections/product-maps.mjs'

const generatedAt = '2026-07-13T08:00:00.000Z'
const snapshotId = 'snapshot:human-readable-v3'
const hash64 = character => character.repeat(64)

export function writeHumanReadableFixture(packageDir, options = {}) {
  const definition = journeyDefinition(options)
  const bindingSet = journeyBinding(options)
  const store = writeJourneyStore({
    packageDir,
    definitions: [definition],
    bindingSets: [bindingSet],
    snapshotId,
    generatedAt,
  })
  const projectionKey = {
    snapshotId,
    staticGraphHash: hash64('1'),
    acceptedClaimSetHash: hash64('2'),
    journeySetHash: store.manifest.journeySetHash,
    investigationFrameHash: hash64('3'),
    projectionGeneratorVersion: 'fixture-v1',
  }
  const maps = productMaps(definition, bindingSet, projectionKey, options)
  const projections = path.join(packageDir, 'projections')
  fs.mkdirSync(projections, { recursive: true })
  const entries = {
    application: writeMap(packageDir, 'projections/application-map.json', maps.application),
    experience: writeMap(packageDir, 'projections/experience-map.json', maps.experience),
    runtimeFlow: writeMap(packageDir, 'projections/runtime-flow-map.json', maps.runtimeFlow),
    change: writeMap(packageDir, 'projections/change-map.json', maps.change),
  }
  const manifest = {
    schemaVersion: 'repo-product-map-manifest/v1',
    snapshotId,
    projectionKey,
    projections: entries,
    generatedAt,
  }
  writeJson(path.join(packageDir, 'projections', 'manifest.json'), manifest)
  fs.mkdirSync(path.join(packageDir, 'synthesis'), { recursive: true })
  const narrative = synthesisNarrative(projectionKey, entries, options)
  writeJson(path.join(packageDir, 'synthesis', 'narrative.json'), narrative)
  return { definition, bindingSet, store, maps, manifest, narrative }
}

function productMaps(definition, bindingSet, projectionKey, options) {
  const blocked = [{
    dimension: 'core-journeys',
    reason: 'External response semantics remain unresolved.',
    ambiguityIds: ['ambiguity:checkout-response'],
  }]
  const application = {
    schemaVersion: 'repo-application-map/v1',
    mapId: 'application-map:fixture',
    snapshotId,
    supportLevel: options.supportLevel || 'supported-frontend',
    projectionKey,
    application: {
      kind: 'spa',
      framework: 'react',
      bundler: 'vite',
      roots: ['apps/storefront'],
      bootstrap: {
        entityId: 'module:src/main.tsx',
        sourcePath: 'src/main.tsx',
        kind: 'client-render',
        evidenceIds: ['evidence:bootstrap'],
        confidence: 1,
      },
      applicationRoot: {
        entityId: 'module:src/App.tsx',
        sourcePath: 'src/App.tsx',
        evidenceIds: ['evidence:app-root'],
        confidence: 0.98,
      },
    },
    entities: [
      entity('module:src/main.tsx', 'module', 'Browser bootstrap', 'src/main.tsx', 1, ['evidence:bootstrap']),
      entity('module:src/App.tsx', 'component', 'Application root', 'src/App.tsx', 0.98, ['evidence:app-root']),
      entity('route:checkout', 'route', '/checkout', 'src/routes.tsx', 1, ['evidence:route']),
      entity('page:checkout', 'page', 'Checkout page', 'src/pages/Checkout.tsx', 0.96, ['evidence:page']),
    ],
    relations: [relation('relation:bootstrap', 'bootstraps', 'module:src/main.tsx', 'module:src/App.tsx', 1, null, ['evidence:bootstrap'])],
    routeLayoutPages: {
      routeIds: ['route:checkout'],
      layoutIds: ['layout:storefront'],
      pageIds: ['page:checkout'],
    },
    boundaries: {
      state: [surface('surface:checkout-state', 'client-global', 'src/state/checkout.ts', ['evidence:state'])],
      api: [surface('surface:checkout-api', 'request-client-wrapper', 'src/api/checkout.ts', ['evidence:api'])],
      auth: [],
      buildDeploy: [surface('surface:build', 'build', 'package.json#scripts.build', ['evidence:manifest'])],
      testQuality: [surface('surface:test', 'unit', 'src/pages/Checkout.test.tsx', ['evidence:test'])],
    },
    acceptedSemanticClaimIds: ['claim:checkout-goal'],
    blockedDimensions: [],
    diagnostics: [{
      diagnosticId: 'diagnostic:unsafe-label',
      kind: 'import-resolution-failure',
      severity: 'warning',
      message: 'Unable to resolve </p><img src=x onerror=alert(1)> safely.',
      sourcePath: 'src/routes.tsx',
      evidenceIds: ['evidence:route'],
    }],
    generatedAt,
  }
  const experience = {
    schemaVersion: 'repo-experience-map/v1',
    mapId: 'experience-map:fixture',
    snapshotId,
    projectionKey,
    journeys: [{
      ...definition,
      evidenceIds: [...definition.evidenceIds].sort(),
      claimIds: [...definition.claimIds].sort(),
    }],
    semanticClaims: [{
      claimId: 'claim:checkout-goal',
      subject: 'page:checkout',
      predicate: 'has-goal',
      object: 'Submit order',
      evidenceIds: ['evidence:page'],
      confidence: 0.9,
      qualifiers: { layer: 'semantic' },
    }],
    blockedDimensions: blocked,
    generatedAt,
  }
  const runtimeFlow = {
    schemaVersion: 'repo-runtime-flow-map/v1',
    mapId: 'runtime-flow-map:fixture',
    snapshotId,
    projectionKey,
    flows: [{
      flowId: 'runtime-flow:checkout',
      journeyId: definition.journeyId,
      status: bindingSet.status,
      steps: [
        runtimeStep('binding:page', 'step:open', 1, null, 'page', 'page:checkout', 'src/pages/Checkout.tsx', 'confirmed', 1),
        runtimeStep('binding:event', 'step:open', 2, 'branch:failure', 'event', 'event:submit', 'src/pages/Checkout.tsx', 'confirmed', 1),
        runtimeStep('binding:handler', 'step:open', 3, 'branch:failure', 'handler', 'handler:submit', 'src/pages/Checkout.tsx', 'confirmed', 1),
        runtimeStep('binding:feedback', 'step:result', 4, 'branch:failure', 'feedback', 'feedback:error', 'src/pages/Checkout.tsx', options.openJourney ? 'conflicted' : 'confirmed', options.openJourney ? 0.5 : 1),
        runtimeStep('binding:outcome', 'step:result', 5, 'branch:failure', 'outcome', 'outcome:failed', options.openJourney ? null : 'src/pages/Checkout.tsx', options.openJourney ? 'missing' : 'confirmed', options.openJourney ? 0 : 1),
      ],
      transitions: [
        relation('runtime-relation:1', 'triggers', 'binding:page', 'binding:event', 1, null, ['evidence:page'], 2),
        relation('runtime-relation:2', 'handles', 'binding:event', 'binding:handler', 1, 'branch:failure', ['evidence:page'], 3),
        relation('runtime-relation:3', 'shows', 'binding:handler', 'binding:feedback', options.openJourney ? 0.5 : 1, 'branch:failure', ['evidence:error'], 4),
        relation('runtime-relation:4', 'produces', 'binding:feedback', 'binding:outcome', options.openJourney ? 0 : 1, 'branch:failure', options.openJourney ? [] : ['evidence:error'], 5),
      ],
      evidenceIds: ['evidence:page', 'evidence:error'],
      claimIds: ['claim:checkout-goal'],
    }],
    unboundJourneyIds: [],
    blockedDimensions: blocked,
    generatedAt,
  }
  const change = {
    schemaVersion: 'repo-change-map/v1',
    mapId: 'change-map:fixture',
    snapshotId,
    projectionKey,
    changeSets: [{
      changeSetId: 'change-set:checkout-api',
      subjectId: 'module:src/api/checkout.ts',
      sourcePath: 'src/api/checkout.ts',
      entityIds: ['module:src/api/checkout.ts'],
      reverseDependencies: ['page:checkout', 'module:src/App.tsx'],
      impactedRouteIds: ['route:checkout'],
      impactedPageIds: ['page:checkout'],
      impactedJourneyIds: ['journey:checkout'],
      impactedSurfaces: {
        state: ['src/state/checkout.ts'],
        api: ['src/api/checkout.ts'],
        auth: [],
        tests: ['src/pages/Checkout.test.tsx'],
        buildDeploy: ['package.json#scripts.build'],
      },
      confidence: 0.88,
      blockedDimensions: blocked,
    }],
    blockedDimensions: blocked,
    generatedAt,
  }
  return { application, experience, runtimeFlow, change }
}

function journeyDefinition(options) {
  return {
    schemaVersion: 'repo-journey-definition/v1',
    journeyId: 'journey:checkout',
    snapshotId,
    title: 'Checkout </h3><script>globalThis.compromised=true</script>',
    actor: 'Shopper',
    goal: 'Submit an order',
    trigger: {
      kind: 'user-action',
      description: 'Press submit',
      entityId: 'event:submit',
      evidenceIds: ['evidence:page'],
      claimIds: [],
    },
    entry: {
      routeId: 'route:checkout',
      pageId: 'page:checkout',
      sourcePath: 'src/pages/Checkout.tsx',
      evidenceIds: ['evidence:page'],
      claimIds: ['claim:checkout-goal'],
    },
    steps: [
      {
        stepId: 'step:open',
        order: 1,
        title: 'Open checkout',
        description: 'Open the checkout page.',
        branchIds: ['branch:failure'],
        blocking: true,
        evidenceIds: ['evidence:page'],
        claimIds: [],
      },
      {
        stepId: 'step:result',
        order: 2,
        title: 'Observe result',
        description: 'Observe visible feedback.',
        branchIds: [],
        blocking: true,
        evidenceIds: ['evidence:error'],
        claimIds: [],
      },
    ],
    branches: [{
      branchId: 'branch:failure',
      fromStepId: 'step:open',
      condition: 'Request fails',
      nextStepId: 'step:result',
      kind: 'failure',
      evidenceIds: ['evidence:error'],
      claimIds: [],
    }],
    visibleFeedback: [{
      feedbackId: 'feedback:error',
      stepId: 'step:result',
      kind: 'error',
      description: 'An error message is shown.',
      evidenceIds: ['evidence:error'],
      claimIds: [],
    }],
    successOutcome: {
      outcomeId: 'outcome:submitted',
      stepId: 'step:result',
      description: 'The order is submitted.',
      evidenceIds: ['evidence:success'],
      claimIds: [],
    },
    failureOutcomes: [{
      outcomeId: 'outcome:failed',
      stepId: 'step:result',
      branchId: 'branch:failure',
      description: 'The order is not submitted.',
      evidenceIds: ['evidence:error'],
      claimIds: [],
    }],
    evidenceIds: ['evidence:page', 'evidence:error'],
    claimIds: ['claim:checkout-goal'],
    criticality: options.criticality || 'high',
    status: options.openJourney ? 'open' : 'closed',
    createdAt: generatedAt,
    updatedAt: generatedAt,
  }
}

function journeyBinding(options) {
  const bindings = [
    binding('binding:page', 'step:open', 1, null, 'page', 'page:checkout', 'src/pages/Checkout.tsx', 'confirmed', 1, ['evidence:page']),
    binding('binding:event', 'step:open', 1, 'branch:failure', 'event', 'event:submit', 'src/pages/Checkout.tsx', 'confirmed', 1, ['evidence:page']),
    binding('binding:handler', 'step:open', 1, 'branch:failure', 'handler', 'handler:submit', 'src/pages/Checkout.tsx', 'confirmed', 1, ['evidence:page']),
    binding('binding:feedback', 'step:result', 2, 'branch:failure', 'feedback', 'feedback:error', 'src/pages/Checkout.tsx', options.openJourney ? 'conflicted' : 'confirmed', options.openJourney ? 0.5 : 1, ['evidence:error']),
    binding('binding:outcome', 'step:result', 2, 'branch:failure', 'outcome', 'outcome:failed', options.openJourney ? null : 'src/pages/Checkout.tsx', options.openJourney ? 'missing' : 'confirmed', options.openJourney ? 0 : 1, options.openJourney ? [] : ['evidence:error']),
  ]
  return {
    schemaVersion: 'repo-journey-binding/v1',
    bindingSetId: 'binding-set:checkout',
    journeyId: 'journey:checkout',
    snapshotId,
    bindings,
    relations: [
      bindingRelation('binding:page', 'binding:event', 'triggers', null, ['evidence:page']),
      bindingRelation('binding:event', 'binding:handler', 'handles', 'branch:failure', ['evidence:page']),
      bindingRelation('binding:handler', 'binding:feedback', 'shows', 'branch:failure', ['evidence:error']),
      bindingRelation('binding:feedback', 'binding:outcome', 'produces', 'branch:failure', options.openJourney ? [] : ['evidence:error']),
    ],
    status: options.openJourney ? 'open' : 'closed',
    generatedAt,
  }
}

function synthesisNarrative(projectionKey, entries, options) {
  return {
    schemaVersion: 'repo-synthesis-narrative/v3',
    snapshotId,
    mapManifestRef: 'projections/manifest.json',
    projectionKey,
    title: 'Storefront </title><script>globalThis.titleCompromised=true</script>',
    executiveSummary: 'A governed frontend package with one checkout journey.',
    applicationSummary: 'The client bootstrap reaches the application root and checkout page.',
    experienceSummary: 'A shopper submits an order and receives visible feedback.',
    runtimeFlowSummary: 'The ordered flow preserves governed binding status and branch order.',
    changeSummary: 'The checkout client can affect its page, journey, state, tests, and build surface.',
    journeySummaries: [{
      journeyId: 'journey:checkout',
      summary: options.openJourney
        ? 'Checkout remains open because the external failure outcome is unresolved.'
        : 'Checkout is closed with grounded feedback and outcome bindings.',
      status: options.openJourney ? 'open' : 'closed',
      evidenceRefs: ['evidence:page'],
    }],
    limitations: [
      limitation('limitation:semantic', 'semantic', 'The success destination has competing interpretations.', ['question:semantic']),
      limitation('limitation:runtime', 'runtime', 'The external response contract is unavailable.', ['question:runtime']),
      limitation('limitation:intent', 'product-intent', 'The intended retry experience requires a product decision.', ['question:intent']),
      limitation('limitation:diagnostic', 'deterministic-diagnostic', 'A static import could not be resolved.', []),
      ...(options.openJourney
        ? [limitation('limitation:journey', 'journey-closure', 'Checkout has unresolved bindings.', [])]
        : []),
    ],
    mapRefs: Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.path])),
    journeyRefs: ['journey:checkout'],
    claimRefs: ['claim:checkout-goal'],
    evidenceRefs: ['evidence:page', 'evidence:error'],
    questionRefs: ['question:semantic', 'question:runtime', 'question:intent'],
    generatedAt,
  }
}

function limitation(limitationId, category, summary, questionIds) {
  return {
    limitationId,
    category,
    summary,
    mapDimensions: ['core-journeys'],
    journeyIds: ['journey:checkout'],
    questionIds,
    evidenceRefs: ['evidence:page'],
  }
}

function entity(entityId, kind, label, sourcePath, confidence, evidenceIds) {
  return { entityId, kind, label, sourcePath, evidenceIds, claimIds: [], confidence, attributes: {} }
}

function relation(relationId, type, from, to, confidence, branchId, evidenceIds, order = null) {
  return { relationId, type, from, to, order, branchId, evidenceIds, claimIds: [], confidence, attributes: {} }
}

function surface(surfaceId, kind, sourcePath, evidenceIds) {
  return { surfaceId, kind, sourcePath, evidenceIds, claimIds: [] }
}

function runtimeStep(runtimeStepId, journeyStepId, order, branchId, kind, entityId, sourcePath, status, confidence) {
  return {
    runtimeStepId,
    journeyStepId,
    order,
    branchId,
    kind,
    entityId,
    sourcePath,
    evidenceIds: sourcePath ? [`evidence:${runtimeStepId}`] : [],
    claimIds: [],
    confidence,
    status,
  }
}

function binding(bindingId, stepId, order, branchId, bindingType, entityId, sourcePath, status, confidence, evidenceIds) {
  return {
    bindingId,
    stepId,
    order,
    branchId,
    bindingType,
    entityId,
    entityType: bindingType,
    sourcePath,
    evidenceIds,
    claimIds: [],
    confidence,
    status,
  }
}

function bindingRelation(fromBindingId, toBindingId, kind, branchId, evidenceIds) {
  return { fromBindingId, toBindingId, kind, branchId, evidenceIds, claimIds: [] }
}

function writeMap(packageDir, relativePath, value) {
  writeJson(path.join(packageDir, relativePath), value)
  return { path: relativePath, schemaVersion: value.schemaVersion, contentHash: productProjectionHash(value) }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
