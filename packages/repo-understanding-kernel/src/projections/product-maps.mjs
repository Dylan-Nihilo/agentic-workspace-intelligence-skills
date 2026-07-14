import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { computeJourneySetHash, loadJourneyStore } from '../knowledge/journey-store.mjs'

export const PRODUCT_MAP_GENERATOR_VERSION = '1.0.0'
export const APPLICATION_MAP_SCHEMA = 'repo-application-map/v1'
export const EXPERIENCE_MAP_SCHEMA = 'repo-experience-map/v1'
export const RUNTIME_FLOW_MAP_SCHEMA = 'repo-runtime-flow-map/v1'
export const CHANGE_MAP_SCHEMA = 'repo-change-map/v1'
export const PRODUCT_MAP_MANIFEST_SCHEMA = 'repo-product-map-manifest/v1'

const PRODUCT_MAP_SCHEMAS = loadProductMapSchemas()

const DEPENDENCY_EDGE_TYPES = new Set([
  'imports',
  'dynamic-imports',
  're-exports-from',
  'renders-component',
  'composes',
  'renders',
  'uses-client',
])
const APPLICATION_PREDICATES = new Set([
  'bootstraps',
  'registers',
  'renders',
  'composes',
  'routes-to',
  'nests-layout',
  'owns-state',
  'reads-state',
  'writes-state',
  'uses-client',
  'calls-endpoint',
  'guarded-by',
  'requires-permission',
  'tested-by',
  'built-by',
  'deployed-by',
  'has-business-role',
  'belongs-to-domain',
])
const EXPERIENCE_PREDICATES = new Set([
  'has-goal',
  'entered-through',
  'contains-ui-element',
  'emits-event',
  'produces-feedback',
  'leads-to-outcome',
  'supports-journey',
  'has-business-role',
  'belongs-to-domain',
])
const APPLICATION_DIMENSIONS = new Set([
  'application-bootstrap',
  'route-layout-page',
  'component-composition',
  'state-ownership-data-flow',
  'api-client',
  'auth-permission',
  'build-deploy',
  'testing-quality',
])
const EXPERIENCE_DIMENSIONS = new Set(['core-journeys', 'experience', 'runtime-flow'])
const RUNTIME_KIND_ORDER = new Map([
  ['route', 0],
  ['layout', 1],
  ['page', 2],
  ['ui-element', 3],
  ['event', 4],
  ['handler', 5],
  ['effect', 6],
  ['state-transition', 7],
  ['request', 8],
  ['endpoint', 9],
  ['response', 10],
  ['feedback', 11],
  ['outcome', 12],
])

const PROJECTION_TEMPORAL_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'generatedAt',
  'evaluatedAt',
  'writtenAt',
])

export function productMapPaths(packageDir) {
  const root = path.resolve(packageDir)
  const projections = path.join(root, 'projections')
  return {
    root,
    projections,
    application: path.join(projections, 'application-map.json'),
    experience: path.join(projections, 'experience-map.json'),
    runtimeFlow: path.join(projections, 'runtime-flow-map.json'),
    change: path.join(projections, 'change-map.json'),
    manifest: path.join(projections, 'manifest.json'),
  }
}

export function buildProductMaps(input = {}) {
  const resolved = resolveProjectionInputs(input)
  const {
    packageDir,
    staticProgramGraph,
    investigationFrame,
    acceptedClaims,
    journeyDefinitions,
    journeyBindings,
    journeySetHash,
  } = resolved
  assertProjectionInputs(resolved)
  const snapshotId = String(staticProgramGraph.snapshotId)
  const generatedAt = String(input.generatedAt || staticProgramGraph.generatedAt || investigationFrame.generatedAt)
  const semanticClaims = acceptedClaims.filter(isAcceptedSemanticClaim).sort(compareBy('claimId'))
  const definitions = journeyDefinitions.filter(item => item.status !== 'invalidated').sort(compareBy('journeyId'))
  const bindings = journeyBindings.filter(item => item.status !== 'invalidated').sort(compareBy('bindingSetId'))
  const projectionKey = {
    snapshotId,
    staticGraphHash: productProjectionHash(staticProgramGraph),
    acceptedClaimSetHash: productProjectionHash(acceptedClaims),
    journeySetHash,
    investigationFrameHash: productProjectionHash(investigationFrame),
    projectionGeneratorVersion: PRODUCT_MAP_GENERATOR_VERSION,
  }
  const keyToken = hashCanonical(projectionKey).slice(0, 20)
  const allBlockedDimensions = blockedDimensionsFromFrame(investigationFrame)
  const applicationMap = buildApplicationMap({
    snapshotId,
    keyToken,
    projectionKey,
    generatedAt,
    graph: staticProgramGraph,
    frame: investigationFrame,
    semanticClaims,
    blockedDimensions: allBlockedDimensions.filter(item => APPLICATION_DIMENSIONS.has(item.dimension)),
  })
  const experienceMap = buildExperienceMap({
    snapshotId,
    keyToken,
    projectionKey,
    generatedAt,
    definitions,
    semanticClaims,
    blockedDimensions: allBlockedDimensions.filter(item => EXPERIENCE_DIMENSIONS.has(item.dimension)),
  })
  const runtimeFlowMap = buildRuntimeFlowMap({
    snapshotId,
    keyToken,
    projectionKey,
    generatedAt,
    definitions,
    bindings,
    blockedDimensions: allBlockedDimensions.filter(item => EXPERIENCE_DIMENSIONS.has(item.dimension)),
  })
  const changeMap = buildChangeMap({
    snapshotId,
    keyToken,
    projectionKey,
    generatedAt,
    graph: staticProgramGraph,
    frame: investigationFrame,
    definitions,
    bindings,
    semanticClaims,
    blockedDimensions: allBlockedDimensions,
  })
  const paths = productMapPaths(packageDir)
  const manifest = {
    schemaVersion: PRODUCT_MAP_MANIFEST_SCHEMA,
    snapshotId,
    projectionKey,
    projections: {
      application: projectionEntry(paths.root, paths.application, applicationMap),
      experience: projectionEntry(paths.root, paths.experience, experienceMap),
      runtimeFlow: projectionEntry(paths.root, paths.runtimeFlow, runtimeFlowMap),
      change: projectionEntry(paths.root, paths.change, changeMap),
    },
    generatedAt,
  }
  const result = { applicationMap, experienceMap, runtimeFlowMap, changeMap, manifest, paths }
  const issues = validateProductMaps(result)
  if (issues.length) throw new Error(`Product map validation failed:\n${issues.map(issue => `- ${issue}`).join('\n')}`)
  return result
}

export function writeProductMaps(input = {}) {
  const result = buildProductMaps(input)
  fs.mkdirSync(result.paths.projections, { recursive: true })
  writeJsonAtomic(result.paths.application, result.applicationMap)
  writeJsonAtomic(result.paths.experience, result.experienceMap)
  writeJsonAtomic(result.paths.runtimeFlow, result.runtimeFlowMap)
  writeJsonAtomic(result.paths.change, result.changeMap)
  writeJsonAtomic(result.paths.manifest, result.manifest)
  return result
}

export const buildAndWriteProductMaps = writeProductMaps

export function validateProductMaps(result) {
  const issues = []
  const maps = [
    ['applicationMap', APPLICATION_MAP_SCHEMA],
    ['experienceMap', EXPERIENCE_MAP_SCHEMA],
    ['runtimeFlowMap', RUNTIME_FLOW_MAP_SCHEMA],
    ['changeMap', CHANGE_MAP_SCHEMA],
  ]
  for (const [name, schemaVersion] of maps) {
    const map = result?.[name]
    if (!map || typeof map !== 'object') {
      issues.push(`${name} must be an object`)
      continue
    }
    if (map.schemaVersion !== schemaVersion) issues.push(`${name}.schemaVersion must be ${schemaVersion}`)
    if (!map.mapId || !map.snapshotId || !map.generatedAt) issues.push(`${name} requires mapId, snapshotId, and generatedAt`)
    validateProjectionKey(map.projectionKey, `${name}.projectionKey`, issues)
    const schema = PRODUCT_MAP_SCHEMAS.byVersion.get(schemaVersion)
    if (schema) issues.push(...validateJsonSchema(map, schema, schema, `$${name.slice(0, 1).toUpperCase()}${name.slice(1)}`))
  }
  if (result?.manifest?.schemaVersion !== PRODUCT_MAP_MANIFEST_SCHEMA) issues.push(`manifest.schemaVersion must be ${PRODUCT_MAP_MANIFEST_SCHEMA}`)
  if (result?.manifest) {
    const manifestSchema = PRODUCT_MAP_SCHEMAS.byVersion.get(PRODUCT_MAP_MANIFEST_SCHEMA)
    issues.push(...validateJsonSchema(result.manifest, manifestSchema, manifestSchema, '$Manifest'))
  }
  if (!Array.isArray(result?.applicationMap?.entities)) issues.push('applicationMap.entities must be an array')
  if (!Array.isArray(result?.applicationMap?.relations)) issues.push('applicationMap.relations must be an array')
  if (!Array.isArray(result?.experienceMap?.journeys)) issues.push('experienceMap.journeys must be an array')
  if (!Array.isArray(result?.runtimeFlowMap?.flows)) issues.push('runtimeFlowMap.flows must be an array')
  if (!Array.isArray(result?.changeMap?.changeSets)) issues.push('changeMap.changeSets must be an array')
  validateApplicationReferences(result?.applicationMap, issues)
  validateRuntimeFlows(result?.runtimeFlowMap, issues)
  validateChangeSets(result?.changeMap, issues)
  const snapshotIds = uniqueSorted(maps.map(([name]) => result?.[name]?.snapshotId).filter(Boolean))
  if (snapshotIds.length > 1 || (snapshotIds[0] && result?.manifest?.snapshotId !== snapshotIds[0])) issues.push('all product maps and manifest must share one snapshotId')
  return uniqueSorted(issues)
}

function buildApplicationMap(context) {
  const { graph, frame, semanticClaims } = context
  const entities = graph.nodes.map(node => entityFromGraphNode(node))
  const entityIds = new Set(entities.map(item => item.entityId))
  const addEntity = entity => {
    if (!entity?.entityId || entityIds.has(entity.entityId)) return
    entities.push(entity)
    entityIds.add(entity.entityId)
  }
  addFrameEntities(frame, addEntity)
  const relations = graph.edges.map(edge => relationFromGraphEdge(edge))
  const bootstrapId = frame.browserBootstrap?.entryEntityId
  const applicationRootId = frame.applicationRoot?.entityId
  if (bootstrapId && applicationRootId && bootstrapId !== applicationRootId) {
    relations.push(relation({
      type: 'bootstraps',
      from: bootstrapId,
      to: applicationRootId,
      evidenceIds: uniqueSorted([...(frame.browserBootstrap.evidenceRefs || []), ...(frame.applicationRoot.evidenceRefs || [])]),
      confidence: Math.min(numberOr(frame.browserBootstrap.confidence, 0), numberOr(frame.applicationRoot.confidence, 0)),
      attributes: { source: 'investigation-frame' },
    }))
  }
  for (const page of frame.pageCandidates || []) {
    for (const routeId of page.routeIds || []) {
      addEntity(candidateEntity({ entityId: routeId, sourcePath: null, kind: 'route', label: routeId, confidence: page.confidence, evidenceRefs: page.evidenceRefs }))
      relations.push(relation({
        type: 'routes-to',
        from: routeId,
        to: page.entityId,
        evidenceIds: page.evidenceRefs,
        confidence: page.confidence,
        attributes: { source: 'investigation-frame' },
      }))
    }
  }
  const applicationClaims = semanticClaims.filter(claim => claimTargetsApplication(claim))
  for (const claim of applicationClaims) {
    const targetId = claimObjectEntityId(claim)
    if (!targetId) continue
    addEntity(claimEntity(claim.subject, claim, 'semantic-entity'))
    addEntity(claimEntity(targetId, claim, 'semantic-entity'))
    relations.push(relation({
      id: `claim-relation:${claim.claimId}`,
      type: claim.predicate,
      from: claim.subject,
      to: targetId,
      evidenceIds: claim.evidenceIds,
      claimIds: [claim.claimId],
      confidence: claim.confidence,
      attributes: { layer: claim.qualifiers?.layer || 'semantic' },
    }))
  }
  return {
    schemaVersion: APPLICATION_MAP_SCHEMA,
    mapId: `application-map:${context.keyToken}`,
    snapshotId: context.snapshotId,
    supportLevel: graph.supportLevel,
    projectionKey: context.projectionKey,
    application: {
      kind: String(frame.applicationKind || 'unknown'),
      framework: String(frame.framework?.name || graph.frameworks?.[0] || 'unknown'),
      bundler: String(frame.bundler?.name || 'unknown'),
      roots: uniqueSorted((frame.packageWorkspaceRoots || []).map(item => item.path).concat(graph.roots || [])),
      bootstrap: {
        entityId: frame.browserBootstrap?.entryEntityId || null,
        sourcePath: frame.browserBootstrap?.entryPath || null,
        kind: String(frame.browserBootstrap?.bootstrapKind || 'unknown'),
        evidenceIds: uniqueSorted(frame.browserBootstrap?.evidenceRefs || []),
        confidence: boundedConfidence(frame.browserBootstrap?.confidence),
      },
      applicationRoot: {
        entityId: frame.applicationRoot?.entityId || null,
        sourcePath: frame.applicationRoot?.sourcePath || null,
        evidenceIds: uniqueSorted(frame.applicationRoot?.evidenceRefs || []),
        confidence: boundedConfidence(frame.applicationRoot?.confidence),
      },
    },
    entities: dedupeSorted(entities, item => item.entityId),
    relations: dedupeSorted(relations, item => item.relationId),
    routeLayoutPages: {
      routeIds: uniqueSorted(entities.filter(item => item.kind === 'route').map(item => item.entityId)),
      layoutIds: uniqueSorted((frame.layoutCandidates || []).map(item => item.entityId)),
      pageIds: uniqueSorted((frame.pageCandidates || []).map(item => item.entityId)),
    },
    boundaries: {
      state: stateSurfaces(frame, semanticClaims),
      api: apiSurfaces(frame, semanticClaims),
      auth: authSurfaces(frame, semanticClaims),
      buildDeploy: genericSurfaces(frame.buildDeploySurfaces, 'build-deploy', semanticClaims),
      testQuality: genericSurfaces(frame.testQualitySurfaces, 'test-quality', semanticClaims),
    },
    acceptedSemanticClaimIds: uniqueSorted(applicationClaims.map(item => item.claimId)),
    blockedDimensions: context.blockedDimensions,
    diagnostics: diagnosticsFrom(graph, frame),
    generatedAt: context.generatedAt,
  }
}

function buildExperienceMap(context) {
  const referencedClaimIds = new Set()
  const journeys = context.definitions.map(definition => {
    for (const claimId of collectJourneyClaimIds(definition)) referencedClaimIds.add(claimId)
    return compactJourneyDefinition(definition)
  })
  const semanticClaims = context.semanticClaims
    .filter(claim => referencedClaimIds.has(claim.claimId) || claimTargetsExperience(claim))
    .map(compactSemanticClaim)
    .sort(compareBy('claimId'))
  return {
    schemaVersion: EXPERIENCE_MAP_SCHEMA,
    mapId: `experience-map:${context.keyToken}`,
    snapshotId: context.snapshotId,
    projectionKey: context.projectionKey,
    journeys,
    semanticClaims,
    blockedDimensions: context.blockedDimensions,
    generatedAt: context.generatedAt,
  }
}

function buildRuntimeFlowMap(context) {
  const definitionsById = new Map(context.definitions.map(item => [item.journeyId, item]))
  const flows = []
  const boundJourneyIds = new Set()
  for (const bindingSet of context.bindings) {
    if (!bindingSet.bindings?.length) continue
    const definition = definitionsById.get(bindingSet.journeyId)
    const rawSteps = []
    if (definition?.entry?.routeId) {
      rawSteps.push({
        runtimeStepId: `runtime:${bindingSet.bindingSetId}:route`,
        journeyStepId: definition.steps?.[0]?.stepId || 'entry',
        originalOrder: 0,
        branchId: null,
        kind: 'route',
        entityId: definition.entry.routeId,
        sourcePath: definition.entry.sourcePath || null,
        evidenceIds: uniqueSorted(definition.entry.evidenceIds || []),
        claimIds: uniqueSorted(definition.entry.claimIds || []),
        confidence: (definition.entry.evidenceIds || []).length ? 1 : 0.7,
        status: (definition.entry.evidenceIds || []).length ? 'confirmed' : 'candidate',
      })
    }
    for (const binding of bindingSet.bindings) {
      rawSteps.push({
        runtimeStepId: String(binding.bindingId),
        journeyStepId: String(binding.stepId),
        originalOrder: Number(binding.order || 1),
        branchId: binding.branchId || null,
        kind: String(binding.bindingType),
        entityId: String(binding.entityId),
        sourcePath: binding.sourcePath || null,
        evidenceIds: uniqueSorted(binding.evidenceIds || []),
        claimIds: uniqueSorted(binding.claimIds || []),
        confidence: boundedConfidence(binding.confidence),
        status: String(binding.status),
      })
    }
    rawSteps.sort((left, right) => left.originalOrder - right.originalOrder
      || (RUNTIME_KIND_ORDER.get(left.kind) ?? 99) - (RUNTIME_KIND_ORDER.get(right.kind) ?? 99)
      || left.runtimeStepId.localeCompare(right.runtimeStepId))
    const steps = rawSteps.map((item, index) => {
      const { originalOrder, ...step } = item
      return { ...step, order: index + 1 }
    })
    const stepIds = new Set(steps.map(item => item.runtimeStepId))
    const transitions = (bindingSet.relations || [])
      .filter(item => stepIds.has(item.fromBindingId) && stepIds.has(item.toBindingId))
      .map(item => relation({
        id: `runtime-relation:${bindingSet.bindingSetId}:${item.fromBindingId}:${item.toBindingId}:${item.kind}`,
        type: item.kind,
        from: item.fromBindingId,
        to: item.toBindingId,
        order: steps.find(step => step.runtimeStepId === item.toBindingId)?.order || null,
        branchId: item.branchId || null,
        evidenceIds: item.evidenceIds,
        claimIds: item.claimIds,
        confidence: relationConfidence(steps, item.fromBindingId, item.toBindingId),
        attributes: { source: 'journey-binding' },
      }))
    if (steps[0]?.kind === 'route' && steps[1]) {
      transitions.push(relation({
        id: `runtime-relation:${bindingSet.bindingSetId}:route-entry`,
        type: 'enters',
        from: steps[0].runtimeStepId,
        to: steps[1].runtimeStepId,
        order: steps[1].order,
        evidenceIds: uniqueSorted([...steps[0].evidenceIds, ...steps[1].evidenceIds]),
        claimIds: uniqueSorted([...steps[0].claimIds, ...steps[1].claimIds]),
        confidence: Math.min(steps[0].confidence, steps[1].confidence),
        attributes: { source: 'journey-entry' },
      }))
    }
    flows.push({
      flowId: `runtime-flow:${bindingSet.bindingSetId}`,
      journeyId: bindingSet.journeyId,
      status: bindingSet.status,
      steps,
      transitions: dedupeSorted(transitions, item => item.relationId),
      evidenceIds: uniqueSorted(steps.flatMap(item => item.evidenceIds)),
      claimIds: uniqueSorted(steps.flatMap(item => item.claimIds)),
    })
    boundJourneyIds.add(bindingSet.journeyId)
  }
  return {
    schemaVersion: RUNTIME_FLOW_MAP_SCHEMA,
    mapId: `runtime-flow-map:${context.keyToken}`,
    snapshotId: context.snapshotId,
    projectionKey: context.projectionKey,
    flows: flows.sort(compareBy('flowId')),
    unboundJourneyIds: uniqueSorted(context.definitions.map(item => item.journeyId).filter(id => !boundJourneyIds.has(id))),
    blockedDimensions: context.blockedDimensions,
    generatedAt: context.generatedAt,
  }
}

function buildChangeMap(context) {
  const graphIndex = indexGraph(context.graph)
  const subjects = changeSubjects(context.graph, context.frame, graphIndex)
  const changeSets = subjects.map(subject => buildChangeSet(subject, context, graphIndex))
  return {
    schemaVersion: CHANGE_MAP_SCHEMA,
    mapId: `change-map:${context.keyToken}`,
    snapshotId: context.snapshotId,
    projectionKey: context.projectionKey,
    changeSets: dedupeSorted(changeSets, item => item.changeSetId),
    blockedDimensions: context.blockedDimensions,
    generatedAt: context.generatedAt,
  }
}

function buildChangeSet(subject, context, index) {
  const startModuleId = subject.moduleId
  const closure = startModuleId ? reverseDependencyClosure(startModuleId, index.reverseDependencies) : { ids: new Set(), confidence: 1 }
  const impactedModuleIds = new Set(startModuleId ? [startModuleId, ...closure.ids] : [])
  const impactedPaths = new Set([...impactedModuleIds].map(id => index.sourcePathByModule.get(id)).filter(Boolean))
  if (subject.sourcePath) impactedPaths.add(subject.sourcePath)
  const entityIds = uniqueSorted([
    subject.subjectId,
    ...[...impactedModuleIds].flatMap(moduleId => index.entitiesByModule.get(moduleId) || []),
  ])
  const impactedPageCandidates = (context.frame.pageCandidates || []).filter(item => impactedPaths.has(item.sourcePath) || entityIds.includes(item.entityId))
  const impactedPageIds = uniqueSorted(impactedPageCandidates.map(item => item.entityId))
  const impactedRouteIds = uniqueSorted([
    ...[...impactedModuleIds].flatMap(moduleId => index.routesByModule.get(moduleId) || []),
    ...impactedPageCandidates.flatMap(item => item.routeIds || []),
  ])
  const impactedJourneyIds = impactedJourneys({
    definitions: context.definitions,
    bindings: context.bindings,
    semanticClaims: context.semanticClaims,
    impactedPaths,
    impactedEntityIds: new Set(entityIds),
    impactedPageIds: new Set(impactedPageIds),
    impactedRouteIds: new Set(impactedRouteIds),
  })
  const state = stateSurfacePaths(context.frame).filter(sourcePath => impactedPaths.has(sourcePath))
  const api = (context.frame.apiClientCandidates || []).map(item => item.sourcePath).filter(sourcePath => sourcePath && impactedPaths.has(sourcePath))
  const auth = (context.frame.authPermissionCandidates || []).map(item => item.sourcePath).filter(sourcePath => sourcePath && impactedPaths.has(sourcePath))
  const parsedTests = [...impactedPaths].filter(isTestPath)
  const testSurfaces = (context.frame.testQualitySurfaces || []).map(item => item.sourcePath).filter(Boolean)
  const tests = uniqueSorted([
    ...parsedTests,
    ...(parsedTests.length ? testSurfaces.filter(item => item.includes('#scripts.')) : []),
    ...testSurfaces.filter(item => stripSurfaceFragment(item) === subject.sourcePath),
  ])
  const applicationRelevant = [...impactedPaths].some(sourcePath => sourcePath === context.frame.browserBootstrap?.entryPath
    || sourcePath === context.frame.applicationRoot?.sourcePath
    || (context.frame.pageCandidates || []).some(page => page.sourcePath === sourcePath))
  const buildDeploySurfaces = (context.frame.buildDeploySurfaces || []).map(item => item.sourcePath).filter(Boolean)
  const buildDeploy = uniqueSorted([
    ...(applicationRelevant ? buildDeploySurfaces : []),
    ...buildDeploySurfaces.filter(item => stripSurfaceFragment(item) === subject.sourcePath),
  ])
  const blockedDimensions = changeBlockedDimensions(context.frame, context.blockedDimensions, {
    impactedPaths,
    impactedEntityIds: new Set(entityIds),
  })
  return {
    changeSetId: `change-set:${stableToken(subject.subjectId)}`,
    subjectId: subject.subjectId,
    sourcePath: subject.sourcePath,
    entityIds,
    reverseDependencies: uniqueSorted([...closure.ids]),
    impactedRouteIds,
    impactedPageIds,
    impactedJourneyIds,
    impactedSurfaces: {
      state: uniqueSorted(state),
      api: uniqueSorted(api),
      auth: uniqueSorted(auth),
      tests,
      buildDeploy,
    },
    confidence: boundedConfidence(closure.confidence),
    blockedDimensions,
  }
}

function indexGraph(graph) {
  const nodesById = new Map(graph.nodes.map(item => [item.nodeId, item]))
  const ownerByEntity = new Map()
  const entitiesByModule = new Map()
  const routesByModule = new Map()
  const sourcePathByModule = new Map()
  for (const node of graph.nodes) {
    if (node.kind !== 'module') continue
    ownerByEntity.set(node.nodeId, node.nodeId)
    sourcePathByModule.set(node.nodeId, node.attributes?.sourcePath || node.source?.sourcePath || node.label)
    entitiesByModule.set(node.nodeId, [node.nodeId])
  }
  for (const edge of graph.edges) {
    if (!['declares', 'declares-route'].includes(edge.type)) continue
    const owner = ownerByEntity.get(edge.from) || (nodesById.get(edge.from)?.kind === 'module' ? edge.from : null)
    if (!owner) continue
    ownerByEntity.set(edge.to, owner)
    if (!entitiesByModule.has(owner)) entitiesByModule.set(owner, [owner])
    entitiesByModule.get(owner).push(edge.to)
    if (edge.type === 'declares-route') {
      if (!routesByModule.has(owner)) routesByModule.set(owner, [])
      routesByModule.get(owner).push(edge.to)
    }
  }
  for (const node of graph.nodes) {
    if (ownerByEntity.has(node.nodeId)) continue
    const sourcePath = node.source?.sourcePath || node.attributes?.sourcePath
    const moduleId = sourcePath ? `module:${sourcePath}` : null
    if (moduleId && nodesById.has(moduleId)) {
      ownerByEntity.set(node.nodeId, moduleId)
      if (!entitiesByModule.has(moduleId)) entitiesByModule.set(moduleId, [moduleId])
      entitiesByModule.get(moduleId).push(node.nodeId)
    }
  }
  const reverseDependencies = new Map()
  for (const edge of graph.edges.filter(item => DEPENDENCY_EDGE_TYPES.has(item.type))) {
    const from = ownerByEntity.get(edge.from)
    const to = ownerByEntity.get(edge.to)
    if (!from || !to || from === to) continue
    if (!reverseDependencies.has(to)) reverseDependencies.set(to, [])
    reverseDependencies.get(to).push({ moduleId: from, confidence: boundedConfidence(edge.confidence) })
  }
  for (const [key, values] of entitiesByModule) entitiesByModule.set(key, uniqueSorted(values))
  for (const [key, values] of routesByModule) routesByModule.set(key, uniqueSorted(values))
  return { nodesById, ownerByEntity, entitiesByModule, routesByModule, sourcePathByModule, reverseDependencies }
}

function reverseDependencyClosure(startId, reverseDependencies) {
  const ids = new Set()
  const queue = [{ id: startId, confidence: 1 }]
  let confidence = 1
  while (queue.length) {
    const current = queue.shift()
    for (const edge of reverseDependencies.get(current.id) || []) {
      if (ids.has(edge.moduleId) || edge.moduleId === startId) continue
      ids.add(edge.moduleId)
      const nextConfidence = Math.min(current.confidence, edge.confidence)
      confidence = Math.min(confidence, nextConfidence)
      queue.push({ id: edge.moduleId, confidence: nextConfidence })
    }
  }
  return { ids, confidence }
}

function changeSubjects(graph, frame, index) {
  const subjects = []
  for (const node of graph.nodes) {
    const moduleId = index.ownerByEntity.get(node.nodeId)
    if (!moduleId || ['external-package', 'unresolved-module'].includes(node.kind)) continue
    subjects.push({
      subjectId: node.nodeId,
      moduleId,
      sourcePath: node.source?.sourcePath || index.sourcePathByModule.get(moduleId) || null,
    })
  }
  for (const item of [
    frame.applicationRoot,
    frame.browserBootstrap && {
      entityId: frame.browserBootstrap.entryEntityId,
      sourcePath: frame.browserBootstrap.entryPath,
    },
    ...(frame.layoutCandidates || []),
    ...(frame.pageCandidates || []),
    ...(frame.apiClientCandidates || []),
    ...(frame.authPermissionCandidates || []),
  ].filter(Boolean)) {
    if (!item.entityId || !item.sourcePath) continue
    const moduleId = `module:${item.sourcePath}`
    subjects.push({ subjectId: item.entityId, moduleId: index.nodesById.has(moduleId) ? moduleId : null, sourcePath: item.sourcePath })
  }
  return dedupeSorted(subjects, item => item.subjectId)
}

function impactedJourneys(context) {
  const ids = new Set()
  for (const definition of context.definitions) {
    if (context.impactedPaths.has(definition.entry?.sourcePath)
      || context.impactedRouteIds.has(definition.entry?.routeId)
      || context.impactedPageIds.has(definition.entry?.pageId)) ids.add(definition.journeyId)
  }
  for (const bindingSet of context.bindings) {
    if ((bindingSet.bindings || []).some(binding => context.impactedPaths.has(binding.sourcePath)
      || context.impactedEntityIds.has(binding.entityId))) ids.add(bindingSet.journeyId)
  }
  for (const claim of context.semanticClaims) {
    if (!context.impactedEntityIds.has(claim.subject) && !context.impactedEntityIds.has(claimObjectEntityId(claim))) continue
    for (const journeyId of array(claim.qualifiers?.targetJourneyIds || claim.qualifiers?.journeyIds)) ids.add(String(journeyId))
  }
  return uniqueSorted([...ids])
}

function resolveProjectionInputs(input) {
  const packageDir = path.resolve(input.packageDir || process.cwd())
  const staticProgramGraph = input.staticProgramGraph || readJsonIfExists(path.join(packageDir, 'static', 'static-program-graph.json'))
  const investigationFrame = input.investigationFrame || readJsonIfExists(path.join(packageDir, 'static', 'investigation-frame.json'))
  const acceptedClaims = array(input.acceptedClaims || input.claims || readJsonLinesIfExists(path.join(packageDir, 'store', 'claims.jsonl')))
    .filter(item => item?.status === 'accepted')
  const hasExplicitJourneys = input.journeys || input.journeyDefinitions || input.journeyBindings
  const loadedJourneys = hasExplicitJourneys ? { definitions: [], bindings: [], journeySetHash: null } : loadJourneyArtifacts(packageDir)
  const bundle = normalizeJourneys(input.journeys || loadedJourneys)
  const journeyDefinitions = array(input.journeyDefinitions || bundle.definitions)
  const journeyBindings = array(input.journeyBindings || bundle.bindings)
  const journeySetHash = String(input.journeySetHash || loadedJourneys.journeySetHash || computeJourneySetHash({
    definitions: journeyDefinitions,
    bindingSets: journeyBindings,
  }))
  return { packageDir, staticProgramGraph, investigationFrame, acceptedClaims, journeyDefinitions, journeyBindings, journeySetHash }
}

function assertProjectionInputs(input) {
  if (input.staticProgramGraph?.schemaVersion !== 'repo-static-program-graph/v1') throw new Error('Product maps require repo-static-program-graph/v1')
  if (input.investigationFrame?.schemaVersion !== 'repo-investigation-frame/v1') throw new Error('Product maps require repo-investigation-frame/v1')
  if (input.staticProgramGraph.supportLevel === 'unsupported') throw new Error('Product maps are unavailable for an unsupported frontend repository')
  if (input.staticProgramGraph.snapshotId !== input.investigationFrame.snapshotId) throw new Error('StaticProgramGraph and InvestigationFrame snapshotId mismatch')
  for (const definition of input.journeyDefinitions) {
    if (definition.schemaVersion !== 'repo-journey-definition/v1') throw new Error(`JourneyDefinition ${definition.journeyId || 'missing'} has an invalid schemaVersion`)
    if (definition.snapshotId !== input.staticProgramGraph.snapshotId) throw new Error(`JourneyDefinition ${definition.journeyId} snapshotId mismatch`)
  }
  for (const binding of input.journeyBindings) {
    if (binding.schemaVersion !== 'repo-journey-binding/v1') throw new Error(`JourneyBinding ${binding.bindingSetId || 'missing'} has an invalid schemaVersion`)
    if (binding.snapshotId !== input.staticProgramGraph.snapshotId) throw new Error(`JourneyBinding ${binding.bindingSetId} snapshotId mismatch`)
  }
  for (const claim of input.acceptedClaims) {
    if (claim.snapshotId && claim.snapshotId !== input.staticProgramGraph.snapshotId) throw new Error(`Accepted Claim ${claim.claimId || 'missing'} snapshotId mismatch`)
  }
}

function addFrameEntities(frame, addEntity) {
  const addCandidate = (item, kind, label) => {
    if (!item?.entityId) return
    addEntity(candidateEntity({ ...item, kind, label: label || item.entityId }))
  }
  addCandidate(frame.browserBootstrap && {
    entityId: frame.browserBootstrap.entryEntityId,
    sourcePath: frame.browserBootstrap.entryPath,
    evidenceRefs: frame.browserBootstrap.evidenceRefs,
    confidence: frame.browserBootstrap.confidence,
  }, 'bootstrap', 'Browser bootstrap')
  addCandidate(frame.applicationRoot, 'application', 'Application root')
  for (const item of frame.routeRoots || []) addCandidate(item, 'route-root', item.sourcePath)
  for (const item of frame.layoutCandidates || []) addCandidate(item, 'layout', item.sourcePath)
  for (const item of frame.pageCandidates || []) addCandidate(item, 'page', item.sourcePath)
  for (const system of frame.stateSystems || []) {
    for (const sourcePath of system.sourcePaths || []) addCandidate({
      entityId: `entity:file:${sourcePath}`,
      sourcePath,
      evidenceRefs: system.evidenceRefs,
      confidence: 0.8,
    }, 'state-store', system.name)
  }
  for (const item of frame.apiClientCandidates || []) addCandidate(item, 'api-client', item.sourcePath || item.clientKind)
  for (const item of frame.authPermissionCandidates || []) addCandidate(item, 'auth-policy', item.sourcePath)
}

function entityFromGraphNode(node) {
  return {
    entityId: node.nodeId,
    kind: node.kind,
    label: String(node.label),
    sourcePath: node.source?.sourcePath || node.attributes?.sourcePath || null,
    evidenceIds: uniqueSorted(node.evidenceRefs || []),
    claimIds: [],
    confidence: node.source?.sourceKind === 'fallback-lexer' ? 0.7 : 1,
    attributes: canonicalObject(node.attributes || {}),
  }
}

function candidateEntity(input) {
  return {
    entityId: String(input.entityId),
    kind: String(input.kind || 'candidate'),
    label: String(input.label || input.sourcePath || input.entityId),
    sourcePath: input.sourcePath || null,
    evidenceIds: uniqueSorted(input.evidenceRefs || input.evidenceIds || []),
    claimIds: uniqueSorted(input.claimIds || []),
    confidence: boundedConfidence(input.confidence),
    attributes: canonicalObject(input.attributes || { source: 'investigation-frame' }),
  }
}

function claimEntity(entityId, claim, kind) {
  return {
    entityId: String(entityId),
    kind,
    label: String(entityId),
    sourcePath: claim.qualifiers?.sourcePath || null,
    evidenceIds: uniqueSorted(claim.evidenceIds || []),
    claimIds: [claim.claimId],
    confidence: boundedConfidence(claim.confidence),
    attributes: { layer: claim.qualifiers?.layer || 'semantic' },
  }
}

function relationFromGraphEdge(edge) {
  return relation({
    id: edge.edgeId,
    type: edge.type,
    from: edge.from,
    to: edge.to,
    evidenceIds: edge.evidenceRefs,
    confidence: edge.confidence,
    attributes: { ...canonicalObject(edge.attributes || {}), layer: 'static' },
  })
}

function relation(input) {
  const signature = `${input.type}:${input.from}:${input.to}:${input.order || ''}:${input.branchId || ''}`
  return {
    relationId: String(input.id || `relation:${stableToken(signature)}`),
    type: String(input.type),
    from: String(input.from),
    to: String(input.to),
    order: Number.isInteger(input.order) && input.order > 0 ? input.order : null,
    branchId: input.branchId || null,
    evidenceIds: uniqueSorted(input.evidenceIds || []),
    claimIds: uniqueSorted(input.claimIds || []),
    confidence: boundedConfidence(input.confidence),
    attributes: canonicalObject(input.attributes || {}),
  }
}

function stateSurfaces(frame, claims) {
  const result = []
  for (const system of frame.stateSystems || []) {
    const paths = system.sourcePaths?.length ? system.sourcePaths : [null]
    for (const sourcePath of paths) result.push(surface({
      kind: system.kind || 'state',
      sourcePath,
      identity: `state:${system.name}:${sourcePath || 'global'}`,
      evidenceIds: system.evidenceRefs,
      claimIds: claimsForSource(claims, sourcePath),
    }))
  }
  return dedupeSorted(result, item => item.surfaceId)
}

function apiSurfaces(frame, claims) {
  return dedupeSorted((frame.apiClientCandidates || []).map(item => surface({
    kind: item.clientKind || 'api-client',
    sourcePath: item.sourcePath || null,
    identity: item.entityId,
    evidenceIds: item.evidenceRefs,
    claimIds: claimsForSource(claims, item.sourcePath),
  })), item => item.surfaceId)
}

function authSurfaces(frame, claims) {
  return dedupeSorted((frame.authPermissionCandidates || []).map(item => surface({
    kind: item.candidateKind || 'auth-permission',
    sourcePath: item.sourcePath || null,
    identity: item.entityId,
    evidenceIds: item.evidenceRefs,
    claimIds: claimsForSource(claims, item.sourcePath),
  })), item => item.surfaceId)
}

function genericSurfaces(items, fallbackKind, claims) {
  return dedupeSorted((items || []).map(item => surface({
    kind: item.kind || fallbackKind,
    sourcePath: item.sourcePath || null,
    identity: `${item.kind || fallbackKind}:${item.sourcePath || 'global'}`,
    evidenceIds: item.evidenceRefs,
    claimIds: claimsForSource(claims, stripSurfaceFragment(item.sourcePath)),
  })), item => item.surfaceId)
}

function surface(input) {
  return {
    surfaceId: `surface:${stableToken(input.identity || `${input.kind}:${input.sourcePath || ''}`)}`,
    kind: String(input.kind),
    sourcePath: input.sourcePath || null,
    evidenceIds: uniqueSorted(input.evidenceIds || []),
    claimIds: uniqueSorted(input.claimIds || []),
  }
}

function compactJourneyDefinition(definition) {
  return {
    schemaVersion: definition.schemaVersion,
    journeyId: definition.journeyId,
    snapshotId: definition.snapshotId,
    title: definition.title,
    actor: definition.actor,
    goal: definition.goal,
    trigger: canonicalObject(definition.trigger),
    entry: canonicalObject(definition.entry),
    steps: [...definition.steps].sort((a, b) => a.order - b.order || a.stepId.localeCompare(b.stepId)).map(canonicalObject),
    branches: [...definition.branches].sort(compareBy('branchId')).map(canonicalObject),
    visibleFeedback: [...definition.visibleFeedback].sort(compareBy('feedbackId')).map(canonicalObject),
    successOutcome: canonicalObject(definition.successOutcome),
    failureOutcomes: [...definition.failureOutcomes].sort(compareBy('outcomeId')).map(canonicalObject),
    criticality: definition.criticality,
    status: definition.status,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    evidenceIds: uniqueSorted(definition.evidenceIds || []),
    claimIds: uniqueSorted(definition.claimIds || []),
  }
}

function compactSemanticClaim(claim) {
  return {
    claimId: claim.claimId,
    subject: claim.subject,
    predicate: claim.predicate,
    object: canonicalValue(claim.object),
    evidenceIds: uniqueSorted(claim.evidenceIds || []),
    confidence: boundedConfidence(claim.confidence),
    qualifiers: canonicalObject(claim.qualifiers || {}),
  }
}

function collectJourneyClaimIds(definition) {
  return uniqueSorted([
    ...(definition.claimIds || []),
    ...(definition.trigger?.claimIds || []),
    ...(definition.entry?.claimIds || []),
    ...(definition.steps || []).flatMap(item => item.claimIds || []),
    ...(definition.branches || []).flatMap(item => item.claimIds || []),
    ...(definition.visibleFeedback || []).flatMap(item => item.claimIds || []),
    ...(definition.successOutcome?.claimIds || []),
    ...(definition.failureOutcomes || []).flatMap(item => item.claimIds || []),
  ])
}

function blockedDimensionsFromFrame(frame) {
  const grouped = new Map()
  for (const ambiguity of frame.unresolvedSemanticAmbiguities || []) {
    for (const dimension of ambiguity.targetMapDimensions || []) {
      if (!grouped.has(dimension)) grouped.set(dimension, { reasons: [], ids: [] })
      grouped.get(dimension).reasons.push(ambiguity.question)
      grouped.get(dimension).ids.push(ambiguity.ambiguityId)
    }
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([dimension, value]) => ({
    dimension,
    reason: uniqueSorted(value.reasons).map(item => `Unresolved semantic ambiguity: ${item}`).join(' | '),
    ambiguityIds: uniqueSorted(value.ids),
  }))
}

function changeBlockedDimensions(frame, blockedDimensions, context) {
  const relevantIds = new Set()
  for (const ambiguity of frame.unresolvedSemanticAmbiguities || []) {
    const related = array(ambiguity.relatedEntityIds)
    const files = array(ambiguity.allowedFiles)
    if ((!related.length && !files.length)
      || related.some(id => context.impactedEntityIds.has(id))
      || files.some(sourcePath => context.impactedPaths.has(sourcePath))) relevantIds.add(ambiguity.ambiguityId)
  }
  return blockedDimensions
    .map(item => ({ ...item, ambiguityIds: item.ambiguityIds.filter(id => relevantIds.has(id)) }))
    .filter(item => item.ambiguityIds.length)
}

function diagnosticsFrom(graph, frame) {
  const values = [...(graph.diagnostics || []), ...(frame.deterministicDiagnostics || [])]
  return dedupeSorted(values.map(item => ({
    diagnosticId: String(item.diagnosticId),
    kind: String(item.kind),
    severity: ['info', 'warning', 'error'].includes(item.severity) ? item.severity : 'warning',
    message: String(item.message),
    sourcePath: item.sourcePath || null,
    evidenceIds: uniqueSorted(item.evidenceRefs || item.evidenceIds || []),
  })), item => item.diagnosticId)
}

function stateSurfacePaths(frame) {
  return uniqueSorted((frame.stateSystems || []).flatMap(item => item.sourcePaths || []))
}

function claimsForSource(claims, sourcePath) {
  if (!sourcePath) return []
  return uniqueSorted(claims.filter(claim => claim.qualifiers?.sourcePath === sourcePath
    || array(claim.qualifiers?.sourcePaths).includes(sourcePath)).map(item => item.claimId))
}

function claimTargetsApplication(claim) {
  const targets = array(claim.qualifiers?.targetMaps || claim.qualifiers?.targetMapDimensions)
  return targets.some(item => item === 'application' || item === 'application-map' || APPLICATION_DIMENSIONS.has(item))
    || APPLICATION_PREDICATES.has(claim.predicate)
}

function claimTargetsExperience(claim) {
  const targets = array(claim.qualifiers?.targetMaps || claim.qualifiers?.targetMapDimensions)
  return targets.some(item => item === 'experience' || item === 'experience-map' || EXPERIENCE_DIMENSIONS.has(item))
    || EXPERIENCE_PREDICATES.has(claim.predicate)
    || array(claim.qualifiers?.targetJourneyIds || claim.qualifiers?.journeyIds).length > 0
}

function isAcceptedSemanticClaim(claim) {
  return claim?.status === 'accepted' && (claim.derivation === 'agent'
    || ['semantic', 'journey-binding'].includes(claim.qualifiers?.layer))
}

function claimObjectEntityId(claim) {
  if (typeof claim?.object === 'string' && claim.object.trim()) return claim.object
  if (typeof claim?.object?.entityId === 'string') return claim.object.entityId
  return null
}

function relationConfidence(steps, from, to) {
  const left = steps.find(item => item.runtimeStepId === from)?.confidence ?? 0
  const right = steps.find(item => item.runtimeStepId === to)?.confidence ?? 0
  return Math.min(left, right)
}

function validateProjectionKey(value, label, issues) {
  const fields = ['snapshotId', 'staticGraphHash', 'acceptedClaimSetHash', 'journeySetHash', 'investigationFrameHash', 'projectionGeneratorVersion']
  if (!value || typeof value !== 'object') {
    issues.push(`${label} must be an object`)
    return
  }
  for (const field of fields) if (!value[field] || typeof value[field] !== 'string') issues.push(`${label}.${field} must be a non-empty string`)
  for (const field of ['staticGraphHash', 'acceptedClaimSetHash', 'journeySetHash', 'investigationFrameHash']) {
    if (value[field] && !/^[a-f0-9]{64}$/.test(value[field])) issues.push(`${label}.${field} must be a sha256 hash`)
  }
}

function validateApplicationReferences(map, issues) {
  if (!map?.entities || !map?.relations) return
  const entityIds = new Set(map.entities.map(item => item.entityId))
  for (const relationItem of map.relations) {
    if (!entityIds.has(relationItem.from)) issues.push(`applicationMap relation ${relationItem.relationId} has an unknown from entity`)
    if (!entityIds.has(relationItem.to)) issues.push(`applicationMap relation ${relationItem.relationId} has an unknown to entity`)
  }
  if ((map.diagnostics || []).some(item => Object.hasOwn(item, 'question'))) issues.push('deterministic diagnostics must not be projected as questions')
}

function validateRuntimeFlows(map, issues) {
  for (const flow of map?.flows || []) {
    const ids = new Set(flow.steps.map(item => item.runtimeStepId))
    const orders = flow.steps.map(item => item.order)
    if (new Set(orders).size !== orders.length || orders.some((order, index) => order !== index + 1)) issues.push(`runtime flow ${flow.flowId} must have stable contiguous order`)
    for (const relationItem of flow.transitions) {
      if (!ids.has(relationItem.from) || !ids.has(relationItem.to)) issues.push(`runtime flow ${flow.flowId} has a transition outside its steps`)
    }
  }
}

function validateChangeSets(map, issues) {
  for (const changeSet of map?.changeSets || []) {
    if (!changeSet.subjectId) issues.push('change map contains a change set without subjectId')
    for (const field of ['entityIds', 'reverseDependencies', 'impactedRouteIds', 'impactedPageIds', 'impactedJourneyIds']) {
      if (!Array.isArray(changeSet[field])) issues.push(`change set ${changeSet.changeSetId} requires ${field}`)
    }
    for (const field of ['state', 'api', 'auth', 'tests', 'buildDeploy']) {
      if (!Array.isArray(changeSet.impactedSurfaces?.[field])) issues.push(`change set ${changeSet.changeSetId} requires impactedSurfaces.${field}`)
    }
  }
}

function projectionEntry(root, filePath, value) {
  return {
    path: path.relative(root, filePath).split(path.sep).join('/'),
    schemaVersion: value.schemaVersion,
    contentHash: productProjectionHash(value),
  }
}

/**
 * Content-address Product Map semantics while keeping operational timestamps
 * available for audit. Identical repository snapshots must retain the same
 * projection key and map hashes across independent runs.
 */
export function productProjectionHash(value) {
  return hashCanonical(stripProjectionTemporalMetadata(value))
}

function loadJourneyArtifacts(packageDir) {
  const authoritativeManifest = path.join(packageDir, 'store', 'journeys', 'manifest.json')
  if (fs.existsSync(authoritativeManifest)) {
    const store = loadJourneyStore(packageDir)
    return {
      definitions: store.definitions,
      bindings: store.bindingSets,
      journeySetHash: store.manifest.journeySetHash,
    }
  }
  const definitions = firstExistingRecords([
    path.join(packageDir, 'store', 'journey-definitions.jsonl'),
    path.join(packageDir, 'store', 'journeys.jsonl'),
    path.join(packageDir, 'journeys', 'definitions.json'),
    path.join(packageDir, 'planning', 'journeys.json'),
  ])
  const bindings = firstExistingRecords([
    path.join(packageDir, 'store', 'journey-bindings.jsonl'),
    path.join(packageDir, 'journeys', 'bindings.json'),
  ])
  return { definitions, bindings, journeySetHash: computeJourneySetHash({ definitions, bindingSets: bindings }) }
}

function normalizeJourneys(value) {
  if (Array.isArray(value)) return { definitions: value, bindings: [] }
  return {
    definitions: array(value?.definitions || value?.journeyDefinitions || value?.journeys),
    bindings: array(value?.bindings || value?.journeyBindings),
  }
}

function firstExistingRecords(paths) {
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue
    if (filePath.endsWith('.jsonl')) return readJsonLinesIfExists(filePath)
    const value = readJsonIfExists(filePath)
    if (Array.isArray(value)) return value
    if (Array.isArray(value?.items)) return value.items
    if (Array.isArray(value?.journeys)) return value.journeys
    if (Array.isArray(value?.definitions)) return value.definitions
    if (Array.isArray(value?.bindings)) return value.bindings
  }
  return []
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readJsonLinesIfExists(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

function loadProductMapSchemas() {
  const names = [
    'product-map-common',
    'application-map',
    'experience-map',
    'runtime-flow-map',
    'change-map',
    'product-map-manifest',
    'journey-definition',
  ]
  const byId = new Map()
  const byVersion = new Map()
  for (const name of names) {
    const schema = JSON.parse(fs.readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'))
    if (schema.$id) byId.set(schema.$id, schema)
    const schemaVersion = schema.properties?.schemaVersion?.const
    if (schemaVersion) byVersion.set(schemaVersion, schema)
  }
  return { byId, byVersion }
}

function validateJsonSchema(value, schema, rootSchema, pointer) {
  if (!schema || typeof schema !== 'object') return [`${pointer} has no resolvable schema`]
  if (schema.$ref) {
    const resolved = resolveSchemaReference(schema.$ref, rootSchema)
    return resolved
      ? validateJsonSchema(value, resolved.schema, resolved.rootSchema, pointer)
      : [`${pointer} has unresolved schema reference ${schema.$ref}`]
  }
  const issues = []
  if (Object.hasOwn(schema, 'const') && stableStringify(value) !== stableStringify(schema.const)) issues.push(`${pointer} must equal ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.some(item => stableStringify(item) === stableStringify(value))) issues.push(`${pointer} must be one of ${schema.enum.join(', ')}`)
  if (schema.type && !matchesJsonSchemaType(value, schema.type)) {
    issues.push(`${pointer} must be ${array(schema.type).join(' or ')}`)
    return issues
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) issues.push(`${pointer} must contain at least ${schema.minLength} characters`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(`${pointer} must match ${schema.pattern}`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${pointer} must be >= ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${pointer} must be <= ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) issues.push(`${pointer} must contain at least ${schema.minItems} items`)
    if (schema.uniqueItems && new Set(value.map(stableStringify)).size !== value.length) issues.push(`${pointer} must contain unique items`)
    if (schema.items) value.forEach((item, index) => issues.push(...validateJsonSchema(item, schema.items, rootSchema, `${pointer}[${index}]`)))
  }
  if (isPlainObject(value)) {
    for (const field of schema.required || []) if (!Object.hasOwn(value, field)) issues.push(`${pointer}.${field} is required`)
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}))
      for (const field of Object.keys(value)) if (!allowed.has(field)) issues.push(`${pointer}.${field} is not allowed`)
    }
    for (const [field, fieldSchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, field)) issues.push(...validateJsonSchema(value[field], fieldSchema, rootSchema, `${pointer}.${field}`))
    }
  }
  return issues
}

function resolveSchemaReference(reference, rootSchema) {
  const [schemaId, fragment = ''] = reference.split('#')
  const targetRoot = schemaId ? PRODUCT_MAP_SCHEMAS.byId.get(schemaId) : rootSchema
  if (!targetRoot) return null
  if (!fragment) return { schema: targetRoot, rootSchema: targetRoot }
  const segments = fragment.replace(/^\//, '').split('/').filter(Boolean).map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))
  let target = targetRoot
  for (const segment of segments) target = target?.[segment]
  return target ? { schema: target, rootSchema: targetRoot } : null
}

function matchesJsonSchemaType(value, expected) {
  return array(expected).some(type => {
    if (type === 'null') return value === null
    if (type === 'array') return Array.isArray(value)
    if (type === 'object') return isPlainObject(value)
    if (type === 'integer') return Number.isInteger(value)
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    return typeof value === type
  })
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hashCanonical(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value) {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') return canonicalObject(value)
  return value
}

function canonicalObject(value) {
  return Object.fromEntries(Object.keys(value || {}).sort().map(key => [key, canonicalValue(value[key])]))
}

function stripProjectionTemporalMetadata(value) {
  if (Array.isArray(value)) return value.map(stripProjectionTemporalMetadata)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value)
    .filter(key => !PROJECTION_TEMPORAL_FIELDS.has(key))
    .sort()
    .map(key => [key, stripProjectionTemporalMetadata(value[key])]))
}

function boundedConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(1, number))
}

function numberOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function stableToken(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 20)
}

function dedupeSorted(values, key) {
  const byId = new Map()
  for (const value of values || []) if (value && !byId.has(key(value))) byId.set(key(value), value)
  return [...byId.values()].sort((left, right) => String(key(left)).localeCompare(String(key(right))))
}

function uniqueSorted(values) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && value.length > 0))].sort((left, right) => left.localeCompare(right))
}

function compareBy(field) {
  return (left, right) => String(left?.[field] || '').localeCompare(String(right?.[field] || ''))
}

function array(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

function isTestPath(sourcePath) {
  return /(?:^|\/)(?:__tests__|test|tests|e2e)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(sourcePath || '')
}

function stripSurfaceFragment(sourcePath) {
  return typeof sourcePath === 'string' ? sourcePath.split('#')[0] : sourcePath
}
