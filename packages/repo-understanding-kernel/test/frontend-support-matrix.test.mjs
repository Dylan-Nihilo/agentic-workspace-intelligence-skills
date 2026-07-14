import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildRepoSupportDecision, validateRepoSupportDecision } from '../src/census/frontend-support.mjs'
import { buildStaticProgramGraph, validateStaticProgramGraph } from '../src/census/static-program-graph.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.join(here, 'fixtures', 'frontend-matrix')
const generatedAt = '2026-07-13T00:00:00.000Z'

test('backend repositories fail closed and produce no frontend graph facts', async () => {
  const repoRoot = path.join(fixtureRoot, 'backend')
  const input = fixtureInput(repoRoot, {
    repoKind: 'backend',
    paths: ['package.json', 'server/src/index.ts'],
    dependencies: [{ name: 'express', version: '5.1.0', path: 'package.json' }],
    backendRoots: ['server'],
  })
  const supportDecision = buildRepoSupportDecision(input)
  assert.deepEqual(validateRepoSupportDecision(supportDecision), [])
  assert.equal(supportDecision.repoKind, 'backend')
  assert.equal(supportDecision.supportLevel, 'unsupported')
  assert.equal(supportDecision.unsupportedReason, 'backend-repository')

  const graph = await buildStaticProgramGraph({ ...input, supportDecision })
  assert.deepEqual(validateStaticProgramGraph(graph), [])
  assert.equal(graph.supportLevel, 'unsupported')
  assert.deepEqual(graph.files, [])
  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.edges, [])
  assert.equal(JSON.stringify(graph).includes('INTERNAL_BACKEND_ONLY_SECRET'), false)
})

test('fullstack repositories scan only the deterministically selected frontend subtree', async () => {
  const repoRoot = path.join(fixtureRoot, 'fullstack')
  const input = fixtureInput(repoRoot, {
    repoKind: 'fullstack',
    paths: [
      'apps/web/package.json',
      'apps/web/src/main.tsx',
      'apps/server/package.json',
      'apps/server/src/index.ts',
    ],
    dependencies: [
      { name: 'react', version: '19.0.0', path: 'apps/web/package.json' },
      { name: 'react-dom', version: '19.0.0', path: 'apps/web/package.json' },
      { name: 'express', version: '5.1.0', path: 'apps/server/package.json' },
    ],
    frontendRoots: ['apps/web'],
    backendRoots: ['apps/server'],
  })
  const supportDecision = buildRepoSupportDecision(input)
  assert.deepEqual(validateRepoSupportDecision(supportDecision), [])
  assert.equal(supportDecision.supportLevel, 'frontend-subtree-only')
  assert.deepEqual(supportDecision.frontendRoots, ['apps/web'])

  const graph = await buildStaticProgramGraph({ ...input, supportDecision })
  assert.deepEqual(validateStaticProgramGraph(graph), [])
  assert.deepEqual(graph.roots, ['apps/web'])
  assert.deepEqual(graph.files.map(file => file.sourcePath), ['apps/web/src/main.tsx'])
  assert.ok(graph.nodes.some(node => node.nodeId === 'module:apps/web/src/main.tsx'))
  assert.equal(JSON.stringify(graph).includes('apps/server'), false)
  assert.equal(JSON.stringify(graph).includes('BACKEND_SUBTREE_SECRET'), false)
})

test('Vue SFCs preserve compiler provenance and emit only candidate feedback/outcomes', async () => {
  const repoRoot = path.join(fixtureRoot, 'vue')
  const paths = [
    'package.json',
    'src/main.ts',
    'src/router.ts',
    'src/App.vue',
    'src/components/OrderCard.vue',
    'src/views/HomeView.vue',
    'dist/generated.ts',
    'src/protected-secret.ts',
  ]
  const input = fixtureInput(repoRoot, {
    repoKind: 'frontend',
    paths,
    dependencies: [
      { name: 'vue', version: '3.5.0', path: 'package.json' },
      { name: 'vue-router', version: '4.5.0', path: 'package.json' },
      { name: '@vitejs/plugin-vue', version: '6.0.0', path: 'package.json' },
      { name: 'vite', version: '7.0.0', path: 'package.json' },
    ],
    decorateFile(file) {
      if (file.path === 'dist/generated.ts') return { ...file, generated: true, category: 'generated' }
      if (file.path === 'src/protected-secret.ts') return { ...file, protected: true, contentAnalyzable: false }
      return file
    },
  })
  input.codeMap.symbols = [
    { file: 'dist/generated.ts', name: 'GENERATED_OUTPUT_SECRET', kind: 'variable', line: 1 },
    { file: 'src/protected-secret.ts', name: 'PROTECTED_SOURCE_SECRET', kind: 'variable', line: 1 },
  ]
  input.codeMap.routes = [
    { file: 'src/router.ts', path: '/', line: 1 },
    { file: 'dist/generated.ts', path: '/generated-secret', line: 1 },
    { file: 'src/protected-secret.ts', path: '/protected-secret', line: 1 },
  ]

  const supportDecision = buildRepoSupportDecision(input)
  assert.deepEqual(validateRepoSupportDecision(supportDecision), [])
  assert.equal(supportDecision.supportLevel, 'supported-frontend')
  const graph = await buildStaticProgramGraph({ ...input, supportDecision })
  assert.deepEqual(validateStaticProgramGraph(graph), [])
  assert.equal(graph.parser.mode, 'compiler')
  assert.equal(graph.metrics.fallbackParsedFiles, 0)
  assert.equal(graph.parser.providers.find(provider => provider.name === '@vue/compiler-sfc')?.available, true)

  const homeFile = graph.files.find(file => file.sourcePath === 'src/views/HomeView.vue')
  assert.ok(homeFile)
  assert.match(homeFile.parser, /@vue\/compiler-sfc/)
  assert.match(homeFile.parser, /@vue\/compiler-dom/)
  assert.doesNotMatch(homeFile.parser, /fallback-lexer/)

  const bootstrap = requireNode(graph, 'bootstrap', node => node.source.sourcePath === 'src/main.ts')
  const route = requireNode(graph, 'route', node => node.attributes.routePath === '/')
  const lazyRoute = requireNode(graph, 'route', node => node.attributes.routePath === '/lazy')
  const legacyRoute = requireNode(graph, 'route', node => node.attributes.routePath === '/legacy')
  const page = requireNode(graph, 'page', node => node.source.sourcePath === 'src/views/HomeView.vue')
  const outlet = requireNode(graph, 'component-reference', node => node.source.sourcePath === 'src/App.vue' && node.attributes.componentName === 'RouterView')
  const componentEdge = graph.edges.find(edge => edge.type === 'renders-component'
    && edge.from === 'module:src/App.vue'
    && edge.to === 'module:src/components/OrderCard.vue')
  const button = requireNode(graph, 'ui-element', node => node.source.sourcePath === 'src/views/HomeView.vue' && node.attributes.tagName === 'button')
  const event = requireNode(graph, 'ui-event', node => node.source.sourcePath === 'src/views/HomeView.vue' && node.attributes.eventName === 'click')
  const handler = requireNode(graph, 'handler', node => node.source.sourcePath === 'src/views/HomeView.vue' && node.attributes.handlerName === 'submitOrder')
  const state = requireNode(graph, 'state', node => node.source.sourcePath === 'src/views/HomeView.vue' && node.attributes.stateName === 'status')
  const request = requireNode(graph, 'request', node => node.source.sourcePath === 'src/views/HomeView.vue')
  const endpoint = requireNode(graph, 'endpoint', node => node.attributes.url === '/api/orders')
  const response = requireNode(graph, 'response', node => node.source.sourcePath === 'src/views/HomeView.vue')
  const feedback = requireNode(graph, 'feedback-candidate', node => node.source.sourcePath === 'src/views/HomeView.vue')
  const outcome = requireNode(graph, 'outcome-candidate', node => node.source.sourcePath === 'src/views/HomeView.vue')

  assert.equal(graph.nodes.filter(node => node.kind === 'route' && node.attributes.routePath === '/').length, 1)
  assert.ok(componentEdge, 'Vue template component imports must bind to their module')
  requireEdge(graph, 'registers-root', bootstrap)
  requireEdge(graph, 'uses-router', bootstrap, route)
  requireEdge(graph, 'route-renders-page', route, page)
  requireEdge(graph, 'route-renders-page', lazyRoute, page)
  requireEdge(graph, 'route-renders-page', legacyRoute, page)
  requireEdge(graph, 'outlet-renders-route', outlet, lazyRoute)
  requireEdge(graph, 'outlet-renders-route', outlet, legacyRoute)
  requireEdge(graph, 'emits-ui-event', button, event)
  requireEdge(graph, 'invokes-handler', event, handler)
  requireEdge(graph, 'mutates-state', handler, state)
  requireEdge(graph, 'issues-request', handler, request)
  requireEdge(graph, 'targets-endpoint', request, endpoint)
  requireEdge(graph, 'receives-response', endpoint, response)
  requireEdge(graph, 'produces-feedback-candidate', response, feedback)
  requireEdge(graph, 'produces-outcome-candidate', response, outcome)

  for (const node of [page, button, event, feedback, outcome]) {
    assert.ok(['@vue/compiler-sfc', '@vue/compiler-dom'].some(provider => node.source.provider.includes(provider)))
    assert.equal(node.source.sourceKind, 'compiler-ast')
    assert.ok(node.source.range)
  }
  for (const node of [feedback, outcome]) {
    assert.equal(node.attributes.candidateOnly, true)
    assert.equal(node.attributes.semanticClaim, false)
  }
  assert.equal(graph.nodes.some(node => ['feedback', 'outcome'].includes(node.kind)), false)

  const serialized = JSON.stringify(graph)
  assert.equal(serialized.includes('dist/generated.ts'), false)
  assert.equal(serialized.includes('GENERATED_OUTPUT_SECRET'), false)
  assert.equal(serialized.includes('PROTECTED_SOURCE_SECRET'), false)
  assert.ok(graph.diagnostics.some(item => item.kind === 'source-unavailable' && item.sourcePath === 'src/protected-secret.ts'))
})

test('unknown repository kinds fail closed even when source-looking files are present', async () => {
  const content = 'export function App() { return null }\n'
  const input = {
    repoKind: 'unknown',
    generatedAt,
    files: [{ path: 'src/App.tsx', content, contentAnalyzable: true, hash: sha256(content), hashKind: 'content' }],
    inventory: {
      schemaVersion: 'repo-inventory/v1',
      generatedAt,
      repo: { name: 'unknown-fixture', path: fixtureRoot },
      files: [{ path: 'src/App.tsx', contentAnalyzable: true, hash: sha256(content), hashKind: 'content' }],
    },
    codeMap: { schemaVersion: 'repo-code-map/v1', generatedAt, manifests: [], dependencies: [], imports: [], symbols: [], routes: [], componentRefs: [] },
  }
  const supportDecision = buildRepoSupportDecision(input)
  assert.equal(supportDecision.repoKind, 'unknown')
  assert.equal(supportDecision.supportLevel, 'unsupported')
  assert.equal(supportDecision.unsupportedReason, 'repository-kind-unknown')

  const graph = await buildStaticProgramGraph({ ...input, supportDecision })
  assert.deepEqual(validateStaticProgramGraph(graph), [])
  assert.deepEqual(graph.files, [])
  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.edges, [])
})

function fixtureInput(repoRoot, options) {
  let files = options.paths.map(sourcePath => {
    const content = fs.readFileSync(path.join(repoRoot, sourcePath))
    return {
      path: sourcePath,
      size: content.length,
      hash: sha256(content),
      hashKind: 'content',
      contentAnalyzable: true,
      protected: false,
      binary: false,
      category: sourcePath.endsWith('package.json') ? 'manifest' : 'source',
    }
  })
  if (options.decorateFile) files = files.map(options.decorateFile)
  return {
    repoRoot,
    repoKind: options.repoKind,
    frontendRoots: options.frontendRoots || [],
    backendRoots: options.backendRoots || [],
    generatedAt,
    inventory: {
      schemaVersion: 'repo-inventory/v1',
      generatedAt,
      repo: { name: path.basename(repoRoot), path: repoRoot },
      files,
    },
    codeMap: {
      schemaVersion: 'repo-code-map/v1',
      generatedAt,
      manifests: manifestRecords(options.paths, options.dependencies),
      dependencies: options.dependencies,
      imports: [],
      symbols: [],
      routes: [],
      componentRefs: [],
    },
  }
}

function manifestRecords(paths, dependencies) {
  return paths.filter(sourcePath => sourcePath.endsWith('package.json')).map(sourcePath => ({
    path: sourcePath,
    type: 'npm',
    dependencies: dependencies.filter(dependency => dependency.path === sourcePath),
  }))
}

function requireNode(graph, kind, predicate) {
  const node = graph.nodes.find(candidate => candidate.kind === kind && predicate(candidate))
  assert.ok(node, `expected ${kind} node`)
  return node
}

function requireEdge(graph, type, from, to = null) {
  const edge = graph.edges.find(candidate => candidate.type === type
    && candidate.from === from.nodeId
    && (!to || candidate.to === to.nodeId))
  assert.ok(edge, `expected ${type} edge from ${from.nodeId}${to ? ` to ${to.nodeId}` : ''}`)
  return edge
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
