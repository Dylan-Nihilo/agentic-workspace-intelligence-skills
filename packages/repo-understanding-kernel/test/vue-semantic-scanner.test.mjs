import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from '@babel/parser'
import * as ts from 'typescript'
import {
  scanBabelVueSemantics,
  scanTypeScriptVueSemantics,
} from '../src/census/scanning/vue-semantic-scanner.mjs'

const sourcePath = 'src/router.ts'
const source = `
import { createRouter } from 'vue-router'

export default createRouter({
  routes: [
    { path: '/orders', component: () => import('./views/OrdersView.vue') },
  ],
})
`

test('Vue route scanners normalize dynamic component imports across TypeScript and Babel ASTs', () => {
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const typescriptFacts = scanTypeScriptVueSemantics({ sourcePath, source, sourceFile, ts })
  const babelAst = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'dynamicImport'],
  })
  const babelFacts = scanBabelVueSemantics({ sourcePath, source, ast: babelAst })

  const expected = ['./views/OrdersView.vue']
  assert.deepEqual(typescriptFacts.routes.find(route => route.path === '/orders')?.pageSpecifiers, expected)
  assert.deepEqual(babelFacts.routes.find(route => route.path === '/orders')?.pageSpecifiers, expected)
})
