import { createHash } from 'node:crypto'

import { buildRepoSupportDecision } from './frontend-support.mjs'
import {
  collectFrontendCensusSignals,
  normalizeRepoPath,
  pathWithinRoot,
  stableToken,
  uniqueSorted,
} from './frontend-census-utils.mjs'

export const REPO_INVESTIGATION_FRAME_SCHEMA = 'repo-investigation-frame/v1'
export const FRONTEND_MAP_DIMENSIONS = Object.freeze([
  'application-bootstrap',
  'route-layout-page',
  'component-composition',
  'state-ownership-data-flow',
  'api-client',
  'auth-permission',
  'build-deploy',
  'testing-quality',
  'core-journeys',
])

export function buildFrontendInvestigationFrame(input = {}) {
  const signals = collectFrontendCensusSignals(input)
  const supportDecision = input.supportDecision || buildRepoSupportDecision(input)
  const supported = supportDecision.supportLevel !== 'unsupported'
  const activeRoots = supported ? supportDecision.frontendRoots : []
  const filePaths = supported
    ? signals.filePaths.filter(filePath => activeRoots.some(root => pathWithinRoot(filePath, root)))
    : []
  const frameworkName = supported ? primaryFramework(signals.frameworkNames) : 'unknown'
  const bundlerName = supported ? primaryBundler(signals.bundlerNames, frameworkName) : 'unknown'
  const browserBootstrapPath = rankPaths(
    signals.browserBootstrapCandidates.filter(filePath => activeRoots.some(root => pathWithinRoot(filePath, root))),
    bootstrapRank,
  )[0] || null
  const routeRootPaths = supported ? findRouteRootPaths(signals, filePaths, frameworkName) : []
  const layoutPaths = supported ? rankPaths(filePaths.filter(isLayoutCandidate), layoutRank) : []
  const pagePaths = supported ? rankPaths(filePaths.filter(isPageCandidate), pageRank) : []
  const applicationRootPath = supported ? findApplicationRootPath(filePaths, frameworkName, activeRoots) : null
  const snapshotId = String(supportDecision.snapshotId)
  const supportDecisionRef = String(input.supportDecisionRef || `support-decision:${snapshotId}`)
  const frameSignature = JSON.stringify({
    snapshotId,
    supportDecisionRef,
    frameworkName,
    bundlerName,
    activeRoots,
    browserBootstrapPath,
    routeRootPaths,
  })
  const coreFlowCandidates = supported ? buildCoreFlowCandidates(signals, pagePaths) : []

  return {
    schemaVersion: REPO_INVESTIGATION_FRAME_SCHEMA,
    frameId: String(input.frameId || `frame:${stableToken(frameSignature)}`),
    snapshotId,
    supportDecisionRef,
    applicationKind: inferApplicationKind({ signals, supportDecision, frameworkName, browserBootstrapPath }),
    framework: buildFramework(signals, frameworkName),
    bundler: buildBundler(signals, bundlerName),
    packageWorkspaceRoots: buildWorkspaceRoots(signals, activeRoots),
    browserBootstrap: buildBrowserBootstrap(browserBootstrapPath, frameworkName),
    applicationRoot: buildApplicationRoot(applicationRootPath),
    routeRoots: buildRouteRoots(routeRootPaths, frameworkName),
    layoutCandidates: layoutPaths.map(sourcePath => entityCandidate(sourcePath, layoutConfidence(sourcePath))),
    pageCandidates: buildPageCandidates(pagePaths, signals),
    coreFlowCandidates,
    stateSystems: supported ? buildStateSystems(signals, filePaths) : [],
    apiClientCandidates: supported ? buildApiClientCandidates(signals, filePaths, activeRoots) : [],
    authPermissionCandidates: supported ? buildAuthPermissionCandidates(filePaths) : [],
    buildDeploySurfaces: supported ? buildBuildDeploySurfaces(signals, filePaths) : [],
    testQualitySurfaces: supported ? buildTestQualitySurfaces(signals, filePaths) : [],
    deterministicDiagnostics: collectDeterministicDiagnostics(input, signals, supportDecision),
    unresolvedSemanticAmbiguities: supported ? collectSemanticAmbiguities({ ...input, coreFlowCandidates }) : [],
    requiredMapDimensions: [...FRONTEND_MAP_DIMENSIONS],
    generatedAt: String(input.generatedAt || supportDecision.generatedAt),
  }
}

export const buildRepoInvestigationFrame = buildFrontendInvestigationFrame

export function validateRepoInvestigationFrame(value) {
  const issues = []
  const arrayFields = [
    'packageWorkspaceRoots',
    'routeRoots',
    'layoutCandidates',
    'pageCandidates',
    'coreFlowCandidates',
    'stateSystems',
    'apiClientCandidates',
    'authPermissionCandidates',
    'buildDeploySurfaces',
    'testQualitySurfaces',
    'deterministicDiagnostics',
    'unresolvedSemanticAmbiguities',
    'requiredMapDimensions',
  ]
  if (value?.schemaVersion !== REPO_INVESTIGATION_FRAME_SCHEMA) issues.push(`schemaVersion must be ${REPO_INVESTIGATION_FRAME_SCHEMA}`)
  for (const field of ['frameId', 'snapshotId', 'supportDecisionRef', 'applicationKind', 'generatedAt']) {
    if (!value?.[field] || typeof value[field] !== 'string') issues.push(`${field} must be a non-empty string`)
  }
  for (const field of arrayFields) if (!Array.isArray(value?.[field])) issues.push(`${field} must be an array`)
  if (!isFramework(value?.framework)) issues.push('framework is invalid')
  if (!isBundler(value?.bundler)) issues.push('bundler is invalid')
  if (!isBrowserBootstrap(value?.browserBootstrap)) issues.push('browserBootstrap is invalid')
  if (!isApplicationRoot(value?.applicationRoot)) issues.push('applicationRoot is invalid')
  for (const diagnostic of value?.deterministicDiagnostics || []) {
    if (!diagnostic?.diagnosticId || !diagnostic?.kind || !diagnostic?.message || !Array.isArray(diagnostic?.evidenceRefs)) {
      issues.push('deterministic diagnostics require diagnosticId, kind, message, and evidenceRefs')
    }
  }
  for (const item of value?.unresolvedSemanticAmbiguities || []) {
    if (!item?.ambiguityId || !item?.question || !item?.rationale || !Array.isArray(item?.competingHypotheses) || item.competingHypotheses.length < 2) {
      issues.push('semantic ambiguities require identity, rationale, and at least two competing hypotheses')
    }
  }
  if ((value?.requiredMapDimensions || []).some(item => !FRONTEND_MAP_DIMENSIONS.includes(item))) {
    issues.push('requiredMapDimensions contains an invalid value')
  }
  return issues
}

function primaryFramework(names) {
  if (names.includes('next')) return 'next'
  if (names.includes('nuxt')) return 'nuxt'
  const runtimeNames = ['react', 'vue', 'svelte', 'angular', 'preact', 'solid'].filter(name => names.includes(name))
  if (runtimeNames.length > 1) return 'mixed'
  return runtimeNames[0] || 'unknown'
}

function primaryBundler(names, frameworkName) {
  for (const name of ['vite', 'next', 'nuxt', 'rspack', 'webpack', 'parcel', 'rollup']) {
    if (names.includes(name)) return name
  }
  if (frameworkName === 'next' || frameworkName === 'nuxt') return frameworkName
  return 'unknown'
}

function inferApplicationKind({ signals, supportDecision, frameworkName, browserBootstrapPath }) {
  if (supportDecision.supportLevel === 'unsupported') return 'unknown'
  const dependencyNames = new Set(signals.dependencies.map(item => item.name))
  if ([...dependencyNames].some(name => /(?:^|\/)(?:single-spa|qiankun|module-federation)/i.test(name))
    || signals.filePaths.some(filePath => /module-federation|federation\.config/i.test(filePath))) return 'micro-frontend'
  if (supportDecision.supportLevel === 'frontend-subtree-only') return 'frontend-subtree'
  if (frameworkName === 'next' || frameworkName === 'nuxt') return 'hybrid'
  if (!browserBootstrapPath && signals.filePaths.some(filePath => /(^|\/)\.storybook\/|storybook/i.test(filePath))) return 'component-library'
  return browserBootstrapPath ? 'spa' : 'unknown'
}

function buildFramework(signals, frameworkName) {
  const dependency = frameworkDependency(signals.dependencies, frameworkName)
  const profileFramework = (signals.profile?.frameworks || []).find(item => String(item?.name || item).toLowerCase() === frameworkName)
  const evidenceRefs = uniqueSorted([
    ...asArray(profileFramework?.evidenceRefs),
    ...(dependency?.path ? [`evidence:manifest:${dependency.path}`] : []),
  ])
  return {
    name: frameworkName,
    version: dependency?.version ? String(dependency.version) : null,
    confidence: frameworkName === 'unknown' ? 0 : dependency ? 0.98 : 0.8,
    evidenceRefs,
  }
}

function buildBundler(signals, bundlerName) {
  const dependency = signals.dependencies.find(item => item.name === bundlerName || item.name.includes(bundlerName))
  const configPaths = bundlerConfigPaths(signals.filePaths, bundlerName)
  return {
    name: bundlerName,
    configPaths,
    confidence: bundlerName === 'unknown' ? 0 : configPaths.length || dependency ? 0.98 : 0.75,
    evidenceRefs: uniqueSorted([
      ...configPaths.map(evidenceForPath),
      ...(dependency?.path ? [`evidence:manifest:${dependency.path}`] : []),
    ]),
  }
}

function buildWorkspaceRoots(signals, activeRoots) {
  if (!activeRoots.length) return []
  const candidates = uniquePaths([
    ...activeRoots,
    ...signals.packageRoots.filter(root => activeRoots.some(activeRoot => pathWithinRoot(root, activeRoot) || pathWithinRoot(activeRoot, root))),
  ])
  return candidates.map(root => {
    const manifestPath = signals.manifests.find(item => parentPath(item.path) === root)?.path
      || signals.dependencies.find(item => item.path && parentPath(item.path) === root)?.path
    const containsOtherRoot = candidates.some(candidate => candidate !== root && pathWithinRoot(candidate, root))
    return {
      path: root,
      kind: activeRoots.includes(root) ? 'application' : containsOtherRoot ? 'workspace' : 'package',
      evidenceRefs: manifestPath ? [`evidence:manifest:${manifestPath}`] : evidenceRefsForPath(root, signals.filePaths),
    }
  })
}

function buildBrowserBootstrap(sourcePath, frameworkName) {
  if (!sourcePath) {
    return {
      entryPath: null,
      entryEntityId: null,
      bootstrapKind: 'unknown',
      evidenceRefs: [],
      confidence: 0,
    }
  }
  const frameworkManaged = ['next', 'nuxt'].includes(frameworkName)
  const hydrate = /entry-client|hydrate|pages\/_app/i.test(sourcePath)
  return {
    entryPath: sourcePath,
    entryEntityId: entityIdForPath(sourcePath),
    bootstrapKind: frameworkManaged ? 'framework-managed' : hydrate ? 'hydrate' : 'client-render',
    evidenceRefs: [evidenceForPath(sourcePath)],
    confidence: frameworkManaged ? 0.9 : 0.95,
  }
}

function buildApplicationRoot(sourcePath) {
  return {
    entityId: sourcePath ? entityIdForPath(sourcePath) : null,
    sourcePath,
    evidenceRefs: sourcePath ? [evidenceForPath(sourcePath)] : [],
    confidence: sourcePath ? (/\.(?:[cm]?[jt]sx?|vue)$/i.test(sourcePath) ? 0.9 : 0.65) : 0,
  }
}

function findApplicationRootPath(filePaths, frameworkName, activeRoots) {
  const candidates = filePaths.filter(filePath => {
    if (frameworkName === 'next' || frameworkName === 'nuxt') return /(^|\/)(?:app\/layout|pages\/_app)\.[cm]?[jt]sx?$/i.test(filePath)
    return /(^|\/)App\.(?:[cm]?[jt]sx?|vue)$/i.test(filePath)
  })
  if (candidates.length) return rankPaths(candidates, applicationRootRank)[0]
  return activeRoots[0] || null
}

function findRouteRootPaths(signals, filePaths, frameworkName) {
  const paths = []
  for (const route of signals.codeMap?.routes || []) {
    const sourcePath = normalizeRepoPath(route?.file || route?.sourcePath)
    if (sourcePath && filePaths.includes(sourcePath)) paths.push(sourcePath)
  }
  for (const filePath of filePaths) {
    if (/(^|\/)(?:router|routes)(?:\/|\.|$)/i.test(filePath)) paths.push(filePath)
  }
  if (frameworkName === 'next' || frameworkName === 'nuxt') {
    for (const root of ['app', 'src/app', 'pages', 'src/pages']) {
      if (filePaths.some(filePath => pathWithinRoot(filePath, root))) paths.push(root)
    }
  }
  return uniquePaths(paths)
}

function buildRouteRoots(paths, frameworkName) {
  return paths.map(sourcePath => ({
    entityId: entityIdForPath(sourcePath),
    sourcePath,
    routeKind: ['next', 'nuxt'].includes(frameworkName) && /(^|\/)(?:app|pages)$/.test(sourcePath) ? 'file-system' : 'declarative',
    evidenceRefs: /\.[^/]+$/.test(sourcePath) ? [evidenceForPath(sourcePath)] : [],
    confidence: /\.[^/]+$/.test(sourcePath) ? 0.9 : 0.8,
  }))
}

function buildPageCandidates(pagePaths, signals) {
  return pagePaths.map(sourcePath => {
    const routeIds = (signals.codeMap?.routes || [])
      .filter(route => normalizeRepoPath(route?.component || route?.target || route?.page || '') === sourcePath)
      .map(routeId)
    if (!routeIds.length && /(^|\/)app\/(?:.*\/)?page\.[cm]?[jt]sx?$/i.test(sourcePath)) routeIds.push(`route:file-system:${stableToken(sourcePath)}`)
    return {
      ...entityCandidate(sourcePath, pageConfidence(sourcePath)),
      routeIds: uniqueSorted(routeIds),
    }
  })
}

function buildCoreFlowCandidates(signals, pagePaths) {
  const graph = signals.staticProgramGraph || {}
  const routeFamilies = new Map()
  for (const route of asArray(graph.nodes).filter(node => node?.kind === 'route')) {
    const routePath = normalizedRoutePath(route)
    if (!routePath || isExcludedRoutePath(routePath)) continue
    const familyPath = routeFamilyPath(routePath)
    const current = routeFamilies.get(familyPath) || []
    current.push(route)
    routeFamilies.set(familyPath, current)
  }
  const candidates = [...routeFamilies.entries()].map(([familyPath, routes]) => {
    const routeIds = uniqueSorted(routes.map(route => route.nodeId))
    const evidenceRefs = uniqueSorted(routes.flatMap(route => asArray(route.evidenceRefs)))
    return {
      candidateId: `flow:route-family:${sha256(`${graph.snapshotId || ''}|${familyPath}`).slice(0, 20)}`,
      title: familyPath,
      entryEntityIds: routeIds,
      reason: routeIds.length > 1
        ? `${routeIds.length} route-backed destinations share a deterministic route family and require journey-level semantic grouping.`
        : 'Reachable route declaration is a deterministic candidate for journey research.',
      evidenceRefs,
      confidence: routeIds.length > 1 ? 0.9 : 0.75,
    }
  })
  if (!candidates.length) {
    for (const sourcePath of pagePaths.filter(path => !/(?:error|exception|not-found|404|500)/i.test(path))) {
      candidates.push({
        candidateId: `flow:${stableToken(sourcePath)}`,
        title: pageTitle(sourcePath),
        entryEntityIds: [entityIdForPath(sourcePath)],
        reason: 'Page candidate is reachable from the frontend source tree; business journey meaning remains unresolved.',
        evidenceRefs: [evidenceForPath(sourcePath)],
        confidence: 0.55,
      })
    }
  }
  return dedupeObjects(candidates, item => item.candidateId)
    .sort((left, right) => left.title.localeCompare(right.title))
}

function buildStateSystems(signals, filePaths) {
  const storePaths = uniquePaths(filePaths.filter(filePath => SOURCE_FILE(filePath)
    && /(^|\/)(?:store|stores|state|context|contexts)(\/|\.|$)/i.test(filePath)
    && !isTestFile(filePath)))
  const mappings = [
    ['@reduxjs/toolkit', 'redux-toolkit', 'client-global'],
    ['redux', 'redux', 'client-global'],
    ['zustand', 'zustand', 'client-global'],
    ['mobx', 'mobx', 'client-global'],
    ['jotai', 'jotai', 'client-global'],
    ['recoil', 'recoil', 'client-global'],
    ['pinia', 'pinia', 'client-global'],
    ['vuex', 'vuex', 'client-global'],
    ['xstate', 'xstate', 'framework'],
    ['@tanstack/react-query', 'tanstack-query', 'server-cache'],
    ['@tanstack/vue-query', 'tanstack-query', 'server-cache'],
  ]
  const systems = []
  for (const [dependencyName, name, kind] of mappings) {
    const dependency = signals.dependencies.find(item => item.name === dependencyName)
    if (!dependency) continue
    systems.push({
      name,
      kind,
      sourcePaths: storePaths,
      evidenceRefs: uniqueSorted([
        ...storePaths.map(evidenceForPath),
        ...(dependency.path ? [`evidence:manifest:${dependency.path}`] : []),
      ]),
    })
  }
  if (!systems.length && storePaths.length) {
    systems.push({
      name: 'repository-store-candidate',
      kind: 'unknown',
      sourcePaths: storePaths,
      evidenceRefs: storePaths.map(evidenceForPath),
    })
  }
  return dedupeObjects(systems, item => item.name)
}

function buildApiClientCandidates(signals, filePaths, activeRoots) {
  const candidates = []
  for (const sourcePath of filePaths.filter(filePath => SOURCE_FILE(filePath)
    && /(^|\/)(?:api|apis|client|clients|request|requests|service|services|http|graphql)(\/|\.|$)/i.test(filePath)
    && !isTestFile(filePath))) {
    candidates.push({
      entityId: entityIdForPath(sourcePath),
      sourcePath,
      clientKind: apiClientKind(sourcePath),
      evidenceRefs: [evidenceForPath(sourcePath)],
      confidence: 0.65,
    })
  }
  for (const dependency of signals.dependencies.filter(item => /^(?:axios|ky|ofetch|superagent|@apollo\/client|urql|graphql-request)$/.test(item.name))) {
    const sourcePath = dependency.path || normalizeRepoPath(`${activeRoots[0] || '.'}/package.json`)
    candidates.push({
      entityId: `dependency:${dependency.name}`,
      sourcePath,
      clientKind: dependency.name,
      evidenceRefs: dependency.path ? [`evidence:manifest:${dependency.path}`] : [],
      confidence: 0.9,
    })
  }
  return dedupeObjects(candidates, item => `${item.entityId}:${item.sourcePath}`)
}

function buildAuthPermissionCandidates(filePaths) {
  return uniquePaths(filePaths.filter(filePath => SOURCE_FILE(filePath)
    && /(?:^|\/|[._-])(?:auth|authentication|authorization|permission|permissions|guard|guards|rbac|acl|login|session|token)(?:\/|[._-]|$)/i.test(filePath)
    && !isTestFile(filePath)))
    .map(sourcePath => ({
      entityId: entityIdForPath(sourcePath),
      sourcePath,
      candidateKind: authCandidateKind(sourcePath),
      evidenceRefs: [evidenceForPath(sourcePath)],
      confidence: 0.65,
    }))
}

function buildBuildDeploySurfaces(signals, filePaths) {
  const surfaces = []
  for (const sourcePath of filePaths.filter(isBuildDeployPath)) {
    surfaces.push({ kind: buildDeployKind(sourcePath), sourcePath, evidenceRefs: [evidenceForPath(sourcePath)] })
  }
  for (const manifest of signals.manifests) {
    for (const scriptName of Object.keys(manifest.scripts || {})) {
      if (!/^(?:build|dev|preview|start|deploy|release)(?::|$)/i.test(scriptName)) continue
      surfaces.push({
        kind: /^(?:deploy|release)/i.test(scriptName) ? 'deploy' : 'build',
        sourcePath: `${manifest.path}#scripts.${scriptName}`,
        evidenceRefs: [`evidence:manifest:${manifest.path}`],
      })
    }
  }
  return dedupeObjects(surfaces, item => `${item.kind}:${item.sourcePath}`)
}

function buildTestQualitySurfaces(signals, filePaths) {
  const surfaces = []
  for (const sourcePath of filePaths.filter(filePath => isTestFile(filePath) || isQualityConfig(filePath))) {
    surfaces.push({ kind: testQualityKind(sourcePath), sourcePath, evidenceRefs: [evidenceForPath(sourcePath)] })
  }
  for (const manifest of signals.manifests) {
    for (const scriptName of Object.keys(manifest.scripts || {})) {
      if (!/^(?:test|lint|type-check|typecheck|check|e2e|coverage)(?::|$)/i.test(scriptName)) continue
      surfaces.push({
        kind: /lint/i.test(scriptName) ? 'lint' : /type/i.test(scriptName) ? 'typecheck' : /e2e/i.test(scriptName) ? 'e2e' : 'unit',
        sourcePath: `${manifest.path}#scripts.${scriptName}`,
        evidenceRefs: [`evidence:manifest:${manifest.path}`],
      })
    }
  }
  return dedupeObjects(surfaces, item => `${item.kind}:${item.sourcePath}`)
}

function collectDeterministicDiagnostics(input, signals, supportDecision) {
  const diagnostics = []
  const add = (value, fallback = {}) => {
    const diagnostic = normalizeDiagnostic(value, fallback)
    if (!diagnostic || diagnostics.some(item => item.diagnosticId === diagnostic.diagnosticId)) return
    diagnostics.push(diagnostic)
  }
  for (const failure of signals.codeMap?.metrics?.parseFailures || []) add(failure, { kind: 'parser-failure', severity: 'error' })
  for (const source of [
    input.deterministicDiagnostics,
    input.diagnostics,
    input.parserDiagnostics,
    input.moduleResolutionDiagnostics,
    signals.staticProgramGraph?.diagnostics,
    signals.staticProgramGraph?.deterministicDiagnostics,
  ]) {
    for (const item of asArray(source)) if (!isSemanticDiagnostic(item)) add(item)
  }
  for (const record of collectScanRecords(input)) {
    for (const nested of asArray(record?.diagnostics)) if (!isSemanticDiagnostic(nested)) add(nested, { sourcePath: recordPath(record) })
    if (record?.resolved === false || /^(?:unresolved|failed|error)$/i.test(String(record?.resolutionStatus || record?.status || ''))) {
      add(record, {
        kind: 'unresolved-import',
        severity: 'warning',
        message: `Unable to resolve import ${record.target || record.specifier || 'unknown'}`,
      })
    } else if (record?.error && /parse|parser|syntax/i.test(String(record.error))) {
      add(record, { kind: 'parser-failure', severity: 'error', message: String(record.error) })
    }
  }
  for (const item of signals.codeMap?.imports || []) {
    if (item?.resolved === false || /^(?:unresolved|failed|error)$/i.test(String(item?.resolutionStatus || item?.status || ''))) {
      add(item, {
        kind: 'unresolved-import',
        severity: 'warning',
        message: `Unable to resolve import ${item.target || item.specifier || 'unknown'}`,
      })
    }
  }
  if (supportDecision.supportLevel === 'unsupported') {
    add({
      kind: supportDecision.unsupportedReason,
      severity: 'error',
      message: `Frontend analysis is unsupported: ${supportDecision.unsupportedReason}`,
    })
  }
  if (signals.frameworkNames.includes('react') && signals.frameworkNames.includes('vue')) {
    add({
      kind: 'multiple-frontend-frameworks',
      severity: 'warning',
      message: 'React and Vue signals coexist; framework adapter boundaries must be resolved deterministically.',
    })
  }
  return diagnostics.sort((left, right) => `${left.kind}:${left.sourcePath || ''}`.localeCompare(`${right.kind}:${right.sourcePath || ''}`))
}

function normalizeDiagnostic(value, fallback = {}) {
  const item = typeof value === 'string' ? { message: value } : value
  if (!item || typeof item !== 'object' || isSemanticDiagnostic(item)) return null
  const raw = [item.category, item.kind, item.type, item.code, item.reason, item.message, item.error].filter(Boolean).join(' ')
  const kind = String(fallback.kind || item.kind || item.code || item.type || diagnosticKind(raw)).trim()
  const sourcePath = normalizeRepoPath(fallback.sourcePath || recordPath(item)) || null
  const message = String(fallback.message || item.message || item.reason || item.detail || item.error || kind).trim()
  if (!message) return null
  const severity = String(fallback.severity || item.severity || (/parser|syntax/i.test(kind) ? 'error' : 'warning')).toLowerCase()
  const evidenceRefs = uniqueSorted([
    ...asArray(item.evidenceRefs),
    ...(sourcePath ? [evidenceForPath(sourcePath)] : []),
  ])
  return {
    diagnosticId: String(item.diagnosticId || `diagnostic:${stableToken(`${kind}|${sourcePath}|${message}`)}`),
    kind,
    severity: ['info', 'warning', 'error'].includes(severity) ? severity : 'warning',
    message,
    sourcePath,
    evidenceRefs,
  }
}

function collectSemanticAmbiguities(input) {
  const questions = new Map()
  for (const source of [
    input.unresolvedSemanticAmbiguities,
    input.investigationFrame?.unresolvedSemanticAmbiguities,
    input.semanticAmbiguities,
  ]) {
    for (const value of asArray(source)) {
      if (!value || typeof value !== 'object') continue
      const question = String(value.question || value.statement || value.description || '').trim()
      const hypotheses = asArray(value.competingHypotheses || value.hypotheses).filter(item => item && typeof item === 'object')
      if (!question || looksDeterministic(question) || hypotheses.length < 2) continue
      const ambiguity = {
        ambiguityId: String(value.ambiguityId || `ambiguity:${stableToken(question)}`),
        question,
        rationale: String(value.rationale || value.whyItMatters || 'This semantic conflict blocks a declared frontend map or journey.'),
        relatedEntityIds: uniqueSorted(asArray(value.relatedEntityIds || value.relatedEntities).map(String)),
        competingHypotheses: hypotheses.map((item, index) => ({
          statement: String(item.statement || item.hypothesis || `hypothesis-${index + 1}`),
          subject: String(item.subject || value.subject || `semantic-subject:${index + 1}`),
          predicate: String(item.predicate || value.predicate || 'has-semantic-role'),
          object: item.object ?? value.object ?? item.statement,
          hypothesisType: String(item.hypothesisType || value.hypothesisType || 'semantic-classification'),
          expectedSupportEvidence: uniqueSorted(asArray(item.expectedSupportEvidence || item.supportingEvidence).map(String)),
          expectedCounterEvidence: uniqueSorted(asArray(item.expectedCounterEvidence || item.counterEvidence).map(String)),
          qualifiers: item.qualifiers && typeof item.qualifiers === 'object' ? item.qualifiers : {},
          initialConfidence: Math.max(0, Math.min(1, Number(item.initialConfidence ?? item.confidence ?? 0.5))),
        })),
        targetMapDimensions: uniqueSorted(asArray(value.targetMapDimensions).filter(item => FRONTEND_MAP_DIMENSIONS.includes(item))),
        targetJourneyIds: uniqueSorted(asArray(value.targetJourneyIds).map(String)),
        evidenceRefs: uniqueSorted(asArray(value.evidenceRefs).map(String)),
        criticality: ['low', 'medium', 'high', 'critical'].includes(value.criticality) ? value.criticality : 'medium',
        blocking: value.blocking !== false,
        expectedInformationGain: Math.max(0, Math.min(1, Number(value.expectedInformationGain ?? 0.5))),
        estimatedCost: Math.max(0, Number(value.estimatedCost ?? 1)),
        communityIds: uniqueSorted(asArray(value.communityIds).map(String)),
        allowedFiles: uniqueSorted(asArray(value.allowedFiles).map(normalizeRepoPath).filter(Boolean)),
      }
      if (!ambiguity.targetMapDimensions.length) ambiguity.targetMapDimensions = ['core-journeys']
      questions.set(ambiguity.ambiguityId, ambiguity)
    }
  }
  for (const ambiguity of buildRouteFamilySemanticAmbiguities(input)) {
    if (!questions.has(ambiguity.ambiguityId)) questions.set(ambiguity.ambiguityId, ambiguity)
  }
  return [...questions.values()].sort((a, b) => a.ambiguityId.localeCompare(b.ambiguityId))
}

function buildRouteFamilySemanticAmbiguities(input) {
  const graph = input.staticProgramGraph || {}
  const nodeById = new Map(asArray(graph.nodes).map(node => [node?.nodeId, node]))
  const renderEdgesByRoute = new Map()
  for (const edge of asArray(graph.edges).filter(edge => edge?.type === 'route-renders-page')) {
    renderEdgesByRoute.set(edge.from, [...(renderEdgesByRoute.get(edge.from) || []), edge])
  }
  const communityByNode = new Map()
  for (const community of asArray(input.communityMap?.communities)) {
    for (const nodeId of asArray(community.memberNodeIds)) {
      communityByNode.set(nodeId, [...(communityByNode.get(nodeId) || []), community.communityId])
    }
  }
  const snapshotId = String(input.snapshotId || graph.snapshotId || '')
  const ambiguities = []
  for (const candidate of asArray(input.coreFlowCandidates)) {
    const routeIds = uniqueSorted(asArray(candidate.entryEntityIds).filter(nodeId => nodeById.get(nodeId)?.kind === 'route'))
    if (routeIds.length < 2) continue
    const renderEdges = routeIds.flatMap(routeId => renderEdgesByRoute.get(routeId) || [])
    const pageIds = uniqueSorted(renderEdges.map(edge => edge.to))
    const relatedEntityIds = uniqueSorted([...routeIds, ...pageIds])
    const relatedNodes = relatedEntityIds.map(nodeId => nodeById.get(nodeId)).filter(Boolean)
    const allowedFiles = uniqueSorted(relatedNodes.map(node => normalizeRepoPath(node.source?.sourcePath)).filter(Boolean))
    const evidenceRefs = uniqueSorted([
      ...asArray(candidate.evidenceRefs),
      ...relatedNodes.flatMap(node => asArray(node.evidenceRefs)),
      ...renderEdges.flatMap(edge => asArray(edge.evidenceRefs)),
    ])
    const communityIds = uniqueSorted(relatedEntityIds.flatMap(nodeId => communityByNode.get(nodeId) || []))
    const journeyId = `journey:${sha256(`${snapshotId}|${candidate.candidateId}`).slice(0, 20)}`
    const subject = `route-family:${candidate.title}`
    ambiguities.push({
      ambiguityId: `ambiguity:route-family:${sha256(`${snapshotId}|${candidate.candidateId}|journey-structure`).slice(0, 20)}`,
      question: `What journey structure best represents the route-backed pages under ${candidate.title}: one coordinated journey, independent destinations, or a family of related subflows?`,
      rationale: 'The Static Program Graph proves a shared route namespace and page bindings, but structural proximity alone cannot establish journey ownership or page responsibility.',
      relatedEntityIds,
      competingHypotheses: [
        {
          statement: `The routes under ${candidate.title} form one coordinated user journey centered on the family root; child routes act as steps, detail views, or actions within that journey.`,
          subject,
          predicate: 'has-journey-structure',
          object: 'coordinated-route-family',
          hypothesisType: 'route-family-journey-structure',
          expectedSupportEvidence: ['Shared navigation, data context, actions, or return paths connect the route-backed pages into one workflow.'],
          expectedCounterEvidence: ['A route-backed page exposes an independent entry, responsibility, or lifecycle with no workflow connection to the family root.'],
          qualifiers: { routeFamily: candidate.title, routeCount: routeIds.length },
          initialConfidence: 0.5,
        },
        {
          statement: `The routes under ${candidate.title} are independent destinations that only share a route namespace and should be represented as separate journeys.`,
          subject,
          predicate: 'has-journey-structure',
          object: 'independent-destinations',
          hypothesisType: 'route-family-journey-structure',
          expectedSupportEvidence: ['The pages have distinct entry conditions, responsibilities, state, or outcomes and do not form an ordered workflow.'],
          expectedCounterEvidence: ['Page actions, shared context, or navigation establish an ordered root-to-child workflow.'],
          qualifiers: { routeFamily: candidate.title, routeCount: routeIds.length },
          initialConfidence: 0.5,
        },
        {
          statement: `The routes under ${candidate.title} form a mixed family: a root responsibility connects several related subflows, but those subflows require separate journey boundaries.`,
          subject,
          predicate: 'has-journey-structure',
          object: 'related-subflows',
          hypothesisType: 'route-family-journey-structure',
          expectedSupportEvidence: ['The root page links or supplies context to child pages whose actions, state, or outcomes are distinct from one another.'],
          expectedCounterEvidence: ['All child pages participate in one ordered workflow, or no meaningful navigation or context connects them.'],
          qualifiers: { routeFamily: candidate.title, routeCount: routeIds.length },
          initialConfidence: 0.5,
        },
      ],
      targetMapDimensions: ['component-composition', 'core-journeys', 'route-layout-page'],
      targetJourneyIds: [journeyId],
      evidenceRefs,
      criticality: 'medium',
      blocking: true,
      expectedInformationGain: Number(Math.min(1, 0.55 + routeIds.length * 0.05).toFixed(2)),
      estimatedCost: Math.max(1, allowedFiles.length),
      communityIds,
      allowedFiles,
    })
  }
  return ambiguities
}

function normalizedRoutePath(route) {
  const value = String(route?.attributes?.routePath || route?.label || '').trim().split(/[?#]/, 1)[0]
  if (!value || value === '/' || value === '*') return null
  return value.startsWith('/') ? value.replace(/\/+$/, '') || '/' : `/${value.replace(/\/+$/, '')}`
}

function routeFamilyPath(routePath) {
  const segments = String(routePath).split('/').filter(Boolean)
  if (segments.length <= 2) return `/${segments.join('/')}`
  return `/${segments.slice(0, 2).join('/')}`
}

function isExcludedRoutePath(routePath) {
  return /^\/(?:40[134]|50\d)(?:\/|$)/.test(routePath) || routePath.includes(':pathMatch')
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function collectScanRecords(input) {
  const records = []
  for (const source of [input.scanRecords, input.parserRecords, input.moduleResolutionRecords, input.scanResults]) {
    for (const item of asArray(source)) {
      if (!item || typeof item !== 'object') continue
      records.push(item)
      for (const nested of asArray(item.records || item.results || item.imports)) if (nested && typeof nested === 'object') records.push(nested)
    }
  }
  return records
}

function frameworkDependency(dependencies, frameworkName) {
  const priority = frameworkName === 'react'
    ? ['react', 'react-dom']
    : frameworkName === 'vue'
      ? ['vue']
      : [frameworkName]
  return priority.map(name => dependencies.find(item => item.name === name)).find(Boolean)
}

function bundlerConfigPaths(filePaths, bundlerName) {
  if (bundlerName === 'unknown') return []
  return uniquePaths(filePaths.filter(filePath => new RegExp(`(^|/)${escapeRegex(bundlerName)}(?:\\.[^/.]+)?\\.config\\.[cm]?[jt]s$`, 'i').test(filePath)))
}

function entityCandidate(sourcePath, confidence) {
  return {
    entityId: entityIdForPath(sourcePath),
    sourcePath,
    evidenceRefs: [evidenceForPath(sourcePath)],
    confidence,
  }
}

function routeId(route) {
  const sourcePath = normalizeRepoPath(route?.file || route?.sourcePath)
  return String(route?.routeId || route?.entityId || `route:${stableToken(`${sourcePath}|${route?.path || route?.name || ''}`)}`)
}

function routeRecordForPath(signals, sourcePath) {
  return (signals.codeMap?.routes || []).filter(route => normalizeRepoPath(route?.file || route?.sourcePath) === sourcePath)
}

function pageTitle(sourcePath) {
  const segments = sourcePath.replace(/\.[^.]+$/, '').split('/').filter(segment => !/^(?:src|app|pages|views|screens|index|page)$/i.test(segment))
  return segments.at(-1) || sourcePath
}

function apiClientKind(sourcePath) {
  if (/graphql/i.test(sourcePath)) return 'graphql-client'
  if (/request|http|client/i.test(sourcePath)) return 'request-client-wrapper'
  return 'api-module'
}

function authCandidateKind(sourcePath) {
  if (/guard|protected.?route/i.test(sourcePath)) return 'route-guard'
  if (/permission|rbac|acl/i.test(sourcePath)) return 'ui-gate'
  if (/token|client|request|http/i.test(sourcePath)) return 'token-client'
  if (/session|store|state|context/i.test(sourcePath)) return 'session-state'
  return 'unknown'
}

function isBuildDeployPath(sourcePath) {
  return /(^|\/)(?:package\.json|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|nuxt\.config\.[cm]?[jt]s|webpack(?:\.[^.]+)?\.config\.[cm]?[jt]s|Dockerfile|docker-compose\.ya?ml|nginx\.conf|\.gitlab-ci\.yml|\.github\/workflows\/[^/]+\.ya?ml|Jenkinsfile|build\.(?:sh|mjs|cjs|js)|deploy(?:ment)?[._-][^/]+)$/i.test(sourcePath)
    || /(^|\/)\.env(?:\.|$)/i.test(sourcePath)
}

function buildDeployKind(sourcePath) {
  if (/\.env(?:\.|$)/i.test(sourcePath)) return 'environment'
  if (/nginx|proxy/i.test(sourcePath)) return 'proxy'
  if (/Dockerfile|docker-compose/i.test(sourcePath)) return 'container'
  if (/\.gitlab-ci|\.github\/workflows|Jenkinsfile/i.test(sourcePath)) return 'ci'
  if (/deploy|release/i.test(sourcePath)) return 'deploy'
  return 'build'
}

function isQualityConfig(sourcePath) {
  return /(^|\/)(?:vitest|jest|playwright|cypress|eslint|prettier|stylelint|tsconfig|jsconfig)(?:\.[^/]+)*\.(?:json|[cm]?[jt]s)$/i.test(sourcePath)
}

function testQualityKind(sourcePath) {
  if (/playwright|cypress|e2e/i.test(sourcePath)) return 'e2e'
  if (/eslint|prettier|stylelint/i.test(sourcePath)) return 'lint'
  if (/tsconfig|jsconfig/i.test(sourcePath)) return 'typecheck'
  if (/component/i.test(sourcePath)) return 'component'
  if (/integration/i.test(sourcePath)) return 'integration'
  return 'unit'
}

function diagnosticKind(raw) {
  if (/unresolved.?import|import.+unresolved|module.+not.+found|resolve/i.test(raw)) return 'unresolved-import'
  if (/unsupported.?syntax/i.test(raw)) return 'unsupported-syntax'
  if (/parse|parser|syntax/i.test(raw)) return 'parser-failure'
  if (/protected/i.test(raw)) return 'protected-source-blocked'
  return 'static-analysis-diagnostic'
}

function isSemanticDiagnostic(value) {
  const raw = typeof value === 'string'
    ? value
    : [value?.category, value?.kind, value?.type, value?.code].filter(Boolean).join(' ')
  return /semantic(?:-ambiguity)?|business-meaning|domain-meaning|product-intent/i.test(raw)
}

function looksDeterministic(value) {
  return /parse(?:r| failure)?|syntax|unsupported syntax|unresolved import|module resolution|alias resolution|protected file|route ast|dynamic url/i.test(value)
}

function isLayoutCandidate(sourcePath) {
  return SOURCE_FILE(sourcePath) && /(^|\/)(?:layout|layouts)(?:\/|\.|$)/i.test(sourcePath) && !isTestFile(sourcePath)
}

function isPageCandidate(sourcePath) {
  if (!SOURCE_FILE(sourcePath) || isTestFile(sourcePath)) return false
  return /(^|\/)(?:pages|views|screens)(\/|$)/i.test(sourcePath)
    || /(^|\/)app\/(?:.*\/)?page\.[cm]?[jt]sx?$/i.test(sourcePath)
}

function SOURCE_FILE(sourcePath) {
  return /\.(?:[cm]?[jt]sx?|vue)$/i.test(sourcePath)
}

function isTestFile(sourcePath) {
  return /(^|\/)(?:__tests__|tests?|specs?|e2e|cypress)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(sourcePath)
}

function bootstrapRank(sourcePath) {
  if (/\/(?:main|entry-client)\.tsx?$/i.test(`/${sourcePath}`)) return 100
  if (/\/(?:main|entry-client)\.jsx?$/i.test(`/${sourcePath}`)) return 90
  if (/\/pages\/_app\./i.test(`/${sourcePath}`)) return 80
  if (/\/app\/layout\./i.test(`/${sourcePath}`)) return 75
  return 50
}

function applicationRootRank(sourcePath) {
  if (/\/app\/layout\./i.test(`/${sourcePath}`)) return 100
  if (/\/pages\/_app\./i.test(`/${sourcePath}`)) return 90
  if (/\/src\/App\./.test(`/${sourcePath}`)) return 80
  return 50
}

function layoutRank(sourcePath) {
  if (/\/app\/layout\./i.test(`/${sourcePath}`)) return 100
  if (/\/(?:layouts?|shells?)\/index\./i.test(`/${sourcePath}`)) return 80
  return 50
}

function pageRank(sourcePath) {
  if (/\/app\/(?:.*\/)?page\./i.test(`/${sourcePath}`)) return 100
  if (/\/(?:pages|views)\/index\./i.test(`/${sourcePath}`)) return 80
  return 50
}

function pageConfidence(sourcePath) {
  return /\/app\/(?:.*\/)?page\./i.test(`/${sourcePath}`) ? 0.95 : 0.75
}

function layoutConfidence(sourcePath) {
  return /\/app\/layout\./i.test(`/${sourcePath}`) ? 0.95 : 0.75
}

function rankPaths(values, ranker) {
  return uniquePaths(values).sort((left, right) => ranker(right) - ranker(left) || left.localeCompare(right))
}

function evidenceForPath(sourcePath) {
  return `evidence:file:${sourcePath}`
}

function evidenceRefsForPath(root, filePaths) {
  return filePaths.filter(sourcePath => pathWithinRoot(sourcePath, root)).slice(0, 5).map(evidenceForPath)
}

function entityIdForPath(sourcePath) {
  return `${/\.[^/]+$/.test(sourcePath) ? 'file' : 'directory'}:${sourcePath}`
}

function parentPath(sourcePath) {
  const normalized = normalizeRepoPath(sourcePath)
  return normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '.'
}

function recordPath(value) {
  return value?.file || value?.filePath || value?.sourcePath || value?.modulePath || value?.path || ''
}

function dedupeObjects(values, keyFor) {
  const seen = new Set()
  return values.filter(value => {
    const key = keyFor(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniquePaths(values) {
  return uniqueSorted((values || []).map(normalizeRepoPath).filter(Boolean))
}

function asArray(value) {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isFramework(value) {
  return Boolean(value)
    && typeof value.name === 'string'
    && (value.version === null || typeof value.version === 'string')
    && Number.isFinite(value.confidence)
    && Array.isArray(value.evidenceRefs)
}

function isBundler(value) {
  return Boolean(value)
    && typeof value.name === 'string'
    && Array.isArray(value.configPaths)
    && Number.isFinite(value.confidence)
    && Array.isArray(value.evidenceRefs)
}

function isBrowserBootstrap(value) {
  return Boolean(value)
    && (value.entryPath === null || typeof value.entryPath === 'string')
    && (value.entryEntityId === null || typeof value.entryEntityId === 'string')
    && ['client-render', 'hydrate', 'framework-managed', 'unknown'].includes(value.bootstrapKind)
    && Array.isArray(value.evidenceRefs)
    && Number.isFinite(value.confidence)
}

function isApplicationRoot(value) {
  return Boolean(value)
    && (value.entityId === null || typeof value.entityId === 'string')
    && (value.sourcePath === null || typeof value.sourcePath === 'string')
    && Array.isArray(value.evidenceRefs)
    && Number.isFinite(value.confidence)
}
