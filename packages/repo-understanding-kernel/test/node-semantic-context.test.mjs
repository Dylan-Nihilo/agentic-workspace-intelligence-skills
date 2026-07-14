import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildNodeSemanticContext } from '../src/knowledge/node-semantic-context.mjs'

test('extracts bounded source signals and file relations for semantic agents', () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'node-semantic-context-'))
  try {
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true })
    fs.writeFileSync(path.join(repoPath, 'src', 'View.vue'), `<template><button v-if="ready" @click="submit">提交</button></template>\n<script>\nimport Api from './api'\nexport default { methods: { submit() { return Api.save(this.$route.query.id) } } }\n</script>\n`)
    fs.writeFileSync(path.join(repoPath, 'src', 'api.js'), 'export const save = value => value\n')
    const graph = {
      schemaVersion: 'repo-static-program-graph/v1',
      snapshotId: 'snapshot:test',
      nodes: [
        node('module:src/View.vue', 'src/View.vue', 'module', 1),
        node('module:src/api.js', 'src/api.js', 'module', 1),
      ],
      edges: [{ edgeId: 'edge:1', type: 'imports', from: 'module:src/View.vue', to: 'module:src/api.js' }],
    }
    const context = buildNodeSemanticContext({ repoPath, filePaths: ['src/View.vue'], staticProgramGraph: graph })
    assert.equal(context.schemaVersion, 'repo-node-semantic-context/v1')
    assert.equal(context.files.length, 1)
    assert.deepEqual(context.files[0].imports, [{ line: 3, bindings: 'Api', specifier: './api' }])
    assert(context.files[0].signals.some(item => item.text.includes('提交')))
    assert(context.files[0].relations.some(item => item.filePath === 'src/api.js' && item.direction === 'outgoing'))
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true })
  }
})

function node(nodeId, sourcePath, kind, line) {
  return { nodeId, kind, label: sourcePath, language: 'Vue SFC', source: { sourcePath, line }, attributes: { sourcePath } }
}
