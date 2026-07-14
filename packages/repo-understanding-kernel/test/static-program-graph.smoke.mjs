import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFrontendInvestigationFrame } from '../src/census/investigation-frame.mjs'
import {
  buildStaticProgramGraph,
  staticProgramGraphContentHash,
  validateStaticProgramGraph,
} from '../src/census/static-program-graph.mjs'
import { buildResearchContracts, qualifyOpenQuestions } from '../src/planning/research-contract-planner.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, 'fixtures', 'static-program-graph-react')
const generatedAt = '2026-07-13T00:00:00.000Z'
const sourcePaths = [
  'generated/pages/Home.tsx',
  'src/App.tsx',
  'src/auth/RequireAuth.tsx',
  'src/components/Card.tsx',
  'src/exports.ts',
  'src/layouts/AppLayout.tsx',
  'src/main.tsx',
  'src/pages/Home.test.tsx',
  'src/pages/Home.tsx',
  'src/router.tsx',
  'vite.config.ts',
]
const files = ['package.json', 'tsconfig.json', 'src/app.css', ...sourcePaths].map(sourcePath => {
  const content = fs.readFileSync(path.join(repoRoot, sourcePath), 'utf8')
  const source = sourcePath.endsWith('.tsx') || sourcePath.endsWith('.ts')
  return {
    path: sourcePath,
    size: Buffer.byteLength(content),
    hash: createHash('sha256').update(content).digest('hex'),
    hashKind: 'content',
    language: sourcePath.endsWith('.tsx') ? 'React TS' : sourcePath.endsWith('.ts') ? 'TypeScript' : sourcePath.endsWith('.css') ? 'CSS' : 'JSON',
    category: source ? 'source' : sourcePath.endsWith('.css') ? 'style' : 'config',
    binary: false,
    large: false,
    contentAnalyzable: true,
    protected: false,
    protectionReason: null,
  }
})
const dependencies = [
  { name: 'react', version: '19.0.0', path: 'package.json' },
  { name: 'react-dom', version: '19.0.0', path: 'package.json' },
  { name: 'react-router-dom', version: '7.6.0', path: 'package.json' },
  { name: '@vitejs/plugin-react', version: '4.5.0', path: 'package.json' },
  { name: 'vite', version: '7.0.0', path: 'package.json' },
  { name: 'vitest', version: '3.2.0', path: 'package.json' },
]
const input = {
  repoRoot,
  generatedAt,
  inventory: {
    schemaVersion: 'repo-inventory/v1',
    generatedAt,
    repo: { name: 'static-program-graph-react-fixture', path: repoRoot },
    files,
  },
  codeMap: {
    schemaVersion: 'repo-code-map/v1',
    generatedAt,
    manifests: [{ path: 'package.json', type: 'npm', dependencies }],
    dependencies,
    imports: [],
    symbols: [],
    routes: [],
    componentRefs: [],
  },
}

const first = await buildStaticProgramGraph(input)
const second = await buildStaticProgramGraph(input)

assert.deepEqual(second, first, 'identical census inputs must produce an identical graph')
assert.deepEqual(validateStaticProgramGraph(first), [])
assert.equal(first.supportLevel, 'supported-frontend')
assert.equal(first.metrics.sourceFiles, 11)
assert.ok(first.nodes.some(node => node.nodeId === 'module:src/App.tsx'))
assert.ok(first.edges.some(edge => edge.type === 'imports' && edge.from === 'module:src/App.tsx' && edge.to === 'module:src/pages/Home.tsx'))
for (const specifier of ['ExactHome', 'src/pages/Home']) {
  assert.ok(first.edges.some(edge => edge.type === 'imports' && edge.to === 'module:src/pages/Home.tsx' && edge.attributes.specifier === specifier), `alias should resolve: ${specifier}`)
}
assert.ok(first.edges.some(edge => edge.type === 'imports' && edge.to === 'module:generated/pages/Home.tsx' && edge.attributes.specifier === 'fallback/pages/Home'), 'paths targets must preserve declared fallback order')
assert.ok(first.edges.some(edge => edge.type === 'renders-component' && edge.from === 'module:src/App.tsx' && edge.to.includes(':Card:')))
assert.ok(first.edges.some(edge => edge.type === 'imports-resource' && edge.from === 'module:src/main.tsx' && edge.to === 'resource:src/app.css'))
assert.equal(first.diagnostics.some(item => item.kind === 'import-resolution-failure' && item.details.specifier === './app.css'), false)
for (const name of ['Named', 'Defaulted']) {
  assert.ok(first.edges.some(edge => edge.type === 'exports' && edge.to.includes(`:${name}:`)), `compiler AST explicit export must bind local symbol: ${name}`)
  assert.equal(first.nodes.find(node => node.nodeId.includes(`:${name}:`))?.attributes.exported, true)
}
assert.ok(first.diagnostics.some(item => item.kind === 'import-resolution-failure' && item.sourcePath === 'src/App.tsx'))
assert.equal(JSON.stringify(first).includes('openQuestion'), false, 'parser/import failures must not produce OpenQuestion work')
assert.equal(staticProgramGraphContentHash(first), staticProgramGraphContentHash(second))

const frame = buildFrontendInvestigationFrame({ ...input, staticProgramGraph: first, snapshotId: first.snapshotId })
const qualified = qualifyOpenQuestions({ investigationFrame: frame, snapshotId: first.snapshotId, generatedAt })
const contracts = buildResearchContracts({ snapshotId: first.snapshotId, investigationFrame: frame, openQuestions: qualified.openQuestions, generatedAt })
assert.ok(frame.deterministicDiagnostics.some(item => item.kind === 'import-resolution-failure'))
assert.ok(frame.unresolvedSemanticAmbiguities.every(item => item.competingHypotheses.length >= 2))
assert.equal(qualified.openQuestions.some(question => /parse|parser|import|module resolution/i.test(question.question)), false)
assert.equal(contracts.some(contract => contract.questions.some(question => /parse|parser|import|module resolution/i.test(question.question))), false, 'deterministic parser/import diagnostics must not become research contracts')

const invalidGraph = {
  ...first,
  supportLevel: 'bogus',
  frameworks: [],
  parser: { ...first.parser, mode: 'bogus' },
  unexpected: true,
}
const invalidIssues = validateStaticProgramGraph(invalidGraph)
assert.ok(invalidIssues.some(issue => issue.includes('supportLevel')))
assert.ok(invalidIssues.some(issue => issue.includes('frameworks')))
assert.ok(invalidIssues.some(issue => issue.includes('parser.mode')))
assert.ok(invalidIssues.some(issue => issue.includes('unexpected')))
assert.doesNotThrow(() => validateStaticProgramGraph({ ...first, nodes: {} }))
assert.ok(validateStaticProgramGraph({ ...first, nodes: {} }).some(issue => issue.includes('nodes')))

const astInput = {
  generatedAt,
  parserProviders: { typescript: false, babel: mockBabelParser(), vue: false, svelte: false },
  supportDecision: {
    schemaVersion: 'repo-support-decision/v1',
    snapshotId: 'snapshot:mock-babel',
    supportLevel: 'supported-frontend',
    repoKind: 'frontend',
    unsupportedReason: null,
    frontendRoots: ['.'],
    backendRoots: [],
    evidenceRefs: [],
    generatedAt,
  },
  files: [
    { path: 'src/main.jsx', content: "import { App } from './App'\n<App />\n", contentAnalyzable: true },
    { path: 'src/App.jsx', content: 'export function App() { return <div /> }\n', contentAnalyzable: true },
  ],
  inventory: {
    schemaVersion: 'repo-inventory/v1',
    generatedAt,
    repo: { name: 'mock-babel', path: repoRoot },
    files: [
      { path: 'src/main.jsx', language: 'React', contentAnalyzable: true },
      { path: 'src/App.jsx', language: 'React', contentAnalyzable: true },
    ],
  },
  codeMap: {
    schemaVersion: 'repo-code-map/v1',
    generatedAt,
    manifests: [{ path: 'package.json', type: 'npm', dependencies: [{ name: 'react' }] }],
    dependencies: [{ name: 'react', path: 'package.json' }],
    imports: [],
    symbols: [],
    routes: [],
    componentRefs: [],
  },
}
const astGraph = await buildStaticProgramGraph(astInput)
assert.deepEqual(validateStaticProgramGraph(astGraph), [])
assert.equal(astGraph.parser.mode, 'compiler')
assert.ok(astGraph.files.every(file => file.parser === '@babel/parser'))
assert.ok(astGraph.edges.some(edge => edge.type === 'imports' && edge.to === 'module:src/App.jsx'))
assert.ok(astGraph.edges.some(edge => edge.type === 'renders-component' && edge.to.includes(':App:')))

const chainedProviderGraph = await buildStaticProgramGraph({
  ...astInput,
  supportDecision: { ...astInput.supportDecision, snapshotId: 'snapshot:provider-chain' },
  parserProviders: { typescript: throwingTypescriptProvider(), babel: mockBabelParser(), vue: false, svelte: false },
})
assert.ok(chainedProviderGraph.files.every(file => file.parser === '@babel/parser'))
assert.ok(chainedProviderGraph.diagnostics.some(item => item.kind === 'parse-failure' && item.details.provider === 'typescript'))
assert.equal(chainedProviderGraph.metrics.fallbackParsedFiles, 0, 'Babel must run before lexer fallback when TypeScript throws')

const protectedGraph = await buildStaticProgramGraph({
  ...astInput,
  supportDecision: { ...astInput.supportDecision, snapshotId: 'snapshot:protected-override' },
  files: [{ path: 'src/secret.ts', content: 'export const SECRET = "must-not-parse"', protected: true, contentAnalyzable: false }],
  inventory: {
    ...astInput.inventory,
    files: [{ path: 'src/secret.ts', language: 'TypeScript', protected: true, contentAnalyzable: false }],
  },
  codeMap: {
    ...astInput.codeMap,
    imports: [{ file: 'src/secret.ts', target: './vault', line: 1 }],
    symbols: [{ file: 'src/secret.ts', name: 'LEAKED_SECRET_SYMBOL', kind: 'variable', line: 1 }],
    routes: [{ file: 'src/secret.ts', path: '/secret', line: 1 }],
    componentRefs: [{ file: 'src/secret.ts', name: 'SecretPanel', line: 1 }],
  },
})
assert.equal(protectedGraph.nodes.some(node => node.label === 'SECRET'), false, 'content overrides must not bypass protected-file policy')
assert.equal(protectedGraph.nodes.some(node => ['LEAKED_SECRET_SYMBOL', '/secret', 'SecretPanel'].includes(node.label)), false, 'code-map facts must not bypass protected-file policy')
assert.ok(protectedGraph.diagnostics.some(item => item.kind === 'source-unavailable' && item.sourcePath === 'src/secret.ts'))

const boundContent = 'export const BOUND = true\n'
const staleGraph = await buildStaticProgramGraph({
  ...astInput,
  supportDecision: { ...astInput.supportDecision, snapshotId: 'snapshot:stale-content' },
  files: [{ path: 'src/stale.ts', content: 'export const STALE = true\n', contentAnalyzable: true }],
  inventory: {
    ...astInput.inventory,
    files: [{
      path: 'src/stale.ts',
      language: 'TypeScript',
      contentAnalyzable: true,
      hashKind: 'content',
      hash: createHash('sha1').update(boundContent).digest('hex'),
    }],
  },
})
assert.equal(staleGraph.nodes.some(node => node.label === 'STALE'), false, 'stale live content must not be parsed under an old snapshot')
assert.ok(staleGraph.diagnostics.some(item => item.kind === 'snapshot-content-mismatch' && item.sourcePath === 'src/stale.ts'))

const staleConfigGraph = await buildStaticProgramGraph({
  ...input,
  inventory: {
    ...input.inventory,
    files: input.inventory.files.map(file => file.path === 'tsconfig.json'
      ? { ...file, hash: createHash('sha1').update('{"compilerOptions":{}}').digest('hex') }
      : file),
  },
})
assert.ok(staleConfigGraph.diagnostics.some(item => item.kind === 'snapshot-content-mismatch' && item.sourcePath === 'tsconfig.json'))
assert.equal(staleConfigGraph.edges.some(edge => edge.type === 'imports' && edge.attributes.specifier === 'ExactHome' && edge.to === 'module:src/pages/Home.tsx'), false, 'stale alias config must not affect resolution')

const componentBindingGraph = await buildStaticProgramGraph({
  ...astInput,
  supportDecision: { ...astInput.supportDecision, snapshotId: 'snapshot:component-binding' },
  parserProviders: { typescript: false, babel: false, vue: false, svelte: false },
  files: [
    { path: 'src/AAA.tsx', content: 'export function Card() { return <div /> }\n', contentAnalyzable: true },
    { path: 'src/RenamedApp.tsx', content: "import { Card as Renamed } from './AAA'\nexport function RenamedApp() { return <Renamed /> }\n", contentAnalyzable: true },
    { path: 'src/ZApp.tsx', content: 'export function ZApp() { return <Card /> }\n', contentAnalyzable: true },
    { path: 'src/exports.ts', content: 'const Named = () => null\nexport { Named }\nconst Defaulted = () => null\nexport default Defaulted\n', contentAnalyzable: true },
    { path: 'src/entry.ts', content: "import './util'\n", contentAnalyzable: true },
    { path: 'src/util.mts', content: 'export const util = true\n', contentAnalyzable: true },
  ],
  inventory: {
    ...astInput.inventory,
    files: ['src/AAA.tsx', 'src/RenamedApp.tsx', 'src/ZApp.tsx', 'src/exports.ts', 'src/entry.ts', 'src/util.mts'].map(path => ({ path, contentAnalyzable: true })),
  },
})
const zAppRender = componentBindingGraph.edges.find(edge => edge.type === 'renders-component' && edge.from === 'module:src/ZApp.tsx')
assert.ok(zAppRender?.to.startsWith('component-reference:src/ZApp.tsx:Card:'), 'unimported components must not bind to an unrelated same-name symbol')
assert.equal(zAppRender?.attributes.resolved, false)
const renamedRender = componentBindingGraph.edges.find(edge => edge.type === 'renders-component' && edge.from === 'module:src/RenamedApp.tsx')
assert.ok(renamedRender?.to.includes('symbol:src/AAA.tsx:function:Card:'), 'aliased imports must bind local component names to imported symbols')
assert.equal(renamedRender?.attributes.resolved, true)
for (const name of ['Named', 'Defaulted']) {
  assert.ok(componentBindingGraph.edges.some(edge => edge.type === 'exports' && edge.to.includes(`:${name}:`)), `explicit export must bind local symbol: ${name}`)
}
assert.ok(componentBindingGraph.edges.some(edge => edge.type === 'imports' && edge.from === 'module:src/entry.ts' && edge.to === 'module:src/util.mts'))

const svelteGraph = await buildStaticProgramGraph({
  ...astInput,
  supportDecision: { ...astInput.supportDecision, snapshotId: 'snapshot:svelte' },
  parserProviders: { typescript: false, babel: false, vue: false, svelte: false },
  files: [
    { path: 'src/App.svelte', content: "<script lang='ts'>\nimport Card from './Card.svelte'\n</script>\n<Card />\n", contentAnalyzable: true },
    { path: 'src/Card.svelte', content: '<article>Card</article>\n', contentAnalyzable: true },
  ],
  inventory: {
    ...astInput.inventory,
    files: [
      { path: 'src/App.svelte', language: 'Svelte', contentAnalyzable: true },
      { path: 'src/Card.svelte', language: 'Svelte', contentAnalyzable: true },
    ],
  },
  codeMap: {
    ...astInput.codeMap,
    manifests: [{ path: 'package.json', type: 'npm', dependencies: [{ name: 'svelte' }] }],
    dependencies: [{ name: 'svelte', path: 'package.json' }],
  },
})
assert.equal(svelteGraph.metrics.sourceFiles, 2)
assert.ok(svelteGraph.edges.some(edge => edge.type === 'imports' && edge.from === 'module:src/App.svelte' && edge.to === 'module:src/Card.svelte'))
assert.ok(svelteGraph.edges.some(edge => edge.type === 'renders-component' && edge.from === 'module:src/App.svelte' && edge.to === 'module:src/Card.svelte' && edge.attributes.resolved === true))
assert.ok(svelteGraph.diagnostics.some(item => item.kind === 'svelte-compiler-unavailable'))
assert.equal(JSON.stringify(svelteGraph).includes('openQuestion'), false)

const unsupportedGraph = await buildStaticProgramGraph({
  supportDecision: {
    ...astInput.supportDecision,
    snapshotId: 'snapshot:unsupported-no-read',
    supportLevel: 'unsupported',
    repoKind: 'backend',
    unsupportedReason: 'backend-repository',
    frontendRoots: [],
    backendRoots: ['.'],
  },
  files: [{ path: 'tsconfig.json', content: '{invalid', contentAnalyzable: true }],
  inventory: { ...astInput.inventory, files: [{ path: 'tsconfig.json', contentAnalyzable: true }] },
})
assert.deepEqual(unsupportedGraph.diagnostics.map(item => item.kind), ['unsupported-repository'])
assert.equal(unsupportedGraph.metrics.sourceFiles, 0)

const frontendSubtreeGraph = await buildStaticProgramGraph({
  supportDecision: {
    ...astInput.supportDecision,
    snapshotId: 'snapshot:frontend-subtree',
    supportLevel: 'frontend-subtree-only',
    repoKind: 'fullstack',
    frontendRoots: ['apps/web'],
    backendRoots: ['apps/server'],
  },
  parserProviders: { typescript: false, babel: false, vue: false, svelte: false },
  files: [
    { path: 'apps/web/src/App.tsx', content: 'export function App() { return <main /> }\n', contentAnalyzable: true },
    { path: 'apps/server/src/index.ts', content: 'export const backend = true\n', contentAnalyzable: true },
    { path: 'tsconfig.json', content: '{invalid', contentAnalyzable: true },
  ],
  inventory: {
    ...astInput.inventory,
    files: [
      { path: 'apps/web/src/App.tsx', contentAnalyzable: true },
      { path: 'apps/server/src/index.ts', contentAnalyzable: true },
      { path: 'tsconfig.json', contentAnalyzable: true },
    ],
  },
})
assert.equal(frontendSubtreeGraph.metrics.sourceFiles, 1)
assert.ok(frontendSubtreeGraph.nodes.some(node => node.nodeId === 'module:apps/web/src/App.tsx'))
assert.equal(frontendSubtreeGraph.nodes.some(node => node.nodeId.includes('apps/server')), false)
assert.equal(frontendSubtreeGraph.diagnostics.some(item => item.kind === 'config-parse-failure'), false, 'root config is outside a frontend-only subtree')

console.log(JSON.stringify({
  passed: true,
  graphId: first.graphId,
  parserMode: first.parser.mode,
  sourceFiles: first.metrics.sourceFiles,
  nodes: first.metrics.nodeCount,
  edges: first.metrics.edgeCount,
  diagnostics: first.metrics.diagnosticCount,
  injectedAstProvider: astGraph.parser.mode,
}, null, 2))

export { first as fixtureGraph }

function mockBabelParser() {
  const loc = line => ({ start: { line }, end: { line } })
  return {
    version: 'fixture',
    parse(source) {
      if (source.includes("from './App'")) {
        return {
          errors: [],
          program: {
            type: 'Program',
            body: [
              {
                type: 'ImportDeclaration',
                loc: loc(1),
                source: { type: 'StringLiteral', value: './App', loc: loc(1) },
                specifiers: [{ type: 'ImportSpecifier', local: { type: 'Identifier', name: 'App', loc: loc(1) } }],
              },
              {
                type: 'ExpressionStatement',
                loc: loc(2),
                expression: {
                  type: 'JSXElement',
                  loc: loc(2),
                  openingElement: { type: 'JSXOpeningElement', loc: loc(2), name: { type: 'JSXIdentifier', name: 'App', loc: loc(2) } },
                  children: [],
                },
              },
            ],
          },
        }
      }
      return {
        errors: [],
        program: {
          type: 'Program',
          body: [{
            type: 'ExportNamedDeclaration',
            loc: loc(1),
            declaration: {
              type: 'FunctionDeclaration',
              loc: loc(1),
              id: { type: 'Identifier', name: 'App', loc: loc(1) },
              params: [],
              body: { type: 'BlockStatement', loc: loc(1), body: [] },
            },
          }],
        },
      }
    },
  }
}

function throwingTypescriptProvider() {
  return {
    version: 'fixture',
    ScriptTarget: { Latest: 99 },
    ScriptKind: { TS: 1, TSX: 2, JS: 3, JSX: 4 },
    createSourceFile() {
      throw new Error('fixture TypeScript parse failure')
    },
  }
}
