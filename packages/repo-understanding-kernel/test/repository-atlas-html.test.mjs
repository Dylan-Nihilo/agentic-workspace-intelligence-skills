import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildRepositoryAtlasModel,
  generateRepositoryAtlasHtml,
} from '../src/projections/repository-atlas-html.mjs'

test('repository atlas renders a blocked stage-five package without Product Maps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-atlas-'))
  try {
    write(root, 'index.json', {
      schemaVersion: 'repo-frontend-census-package/v1',
      repo: { name: 'merchant-fixture', path: '/repo/merchant-fixture', git: { branch: 'main', head: 'abc1234' } },
    })
    write(root, 'static/inventory.json', {
      schemaVersion: 'repo-inventory/v1',
      counts: { categories: { source: 2, config: 1 } },
      files: [
        file('package.json', 'NPM JSON', 'manifest', 12),
        file('src/main.ts', 'TypeScript', 'source', 30),
        file('src/views/Merchant.vue', 'Vue', 'source', 80),
      ],
    })
    write(root, 'static/support-decision.json', { schemaVersion: 'repo-support-decision/v1', snapshotId: 'snapshot:test', supportLevel: 'supported-frontend' })
    write(root, 'static/static-program-graph.json', {
      schemaVersion: 'repo-static-program-graph/v1',
      graphId: 'graph:test',
      snapshotId: 'snapshot:test',
      nodes: [
        node('module:src/main.ts', 'src/main.ts'),
        node('module:src/views/Merchant.vue', 'src/views/Merchant.vue'),
      ],
      edges: [{ edgeId: 'edge:1', type: 'imports', from: 'module:src/main.ts', to: 'module:src/views/Merchant.vue' }],
      diagnostics: [{ kind: 'import-resolution-failure', severity: 'warning', message: 'fixture gap', sourcePath: 'src/main.ts' }],
    })
    write(root, 'static/code-map.json', { schemaVersion: 'repo-code-map/v1', routes: [{ file: 'src/main.ts', path: '/merchant' }], symbols: [], imports: [], relationships: [] })
    write(root, 'static/community-map.json', {
      schemaVersion: 'repo-community-map/v1',
      communities: [{ communityId: 'community:1', memberNodeIds: ['module:src/main.ts', 'module:src/views/Merchant.vue'] }],
    })
    write(root, 'static/neighbor-map.json', { schemaVersion: 'repo-neighbor-map/v1', entries: [], edges: [] })
    write(root, 'static/investigation-frame.json', { schemaVersion: 'repo-investigation-frame/v1', frameId: 'frame:test', coreFlowCandidates: [{ candidateId: 'flow:merchant' }] })
    write(root, 'planning/manifest.json', { schemaVersion: 'repo-research-plan/v1', contractRefs: [], questionCounts: { 'product-intent:blocked': 1 } })
    write(root, 'planning/open-questions.json', { schemaVersion: 'repo-open-question-set/v1', questions: [{ questionId: 'question:1', category: 'product-intent', lifecycleStatus: 'blocked' }] })
    write(root, 'store/journeys/manifest.json', { schemaVersion: 'repo-journey-store-manifest/v1', counts: { journeys: 1, closed: 0 }, entries: [] })
    write(root, 'store/semantic-store-manifest.json', { schemaVersion: 'repo-semantic-store-manifest/v1', counts: { evidence: 2, claims: 0 } })
    write(root, 'state/run-state.json', { schemaVersion: 'repo-run-state/v3', workItems: {} })
    write(root, 'verification/frontend-verification.json', { schemaVersion: 'repo-frontend-verification/v1', phase: 'projection', passed: false, issues: [{ code: 'journey-closure-incomplete' }] })

    const model = buildRepositoryAtlasModel(root)
    assert.equal(model.progress.currentStage, 5)
    assert.equal(model.progress.completedStages, 4)
    assert.equal(model.summary.files, 3)
    assert.equal(model.graph.nodes.length, 3)
    assert.equal(model.graph.edges.length, 1)
    assert.equal(model.stages[4].status, 'blocked')

    const result = generateRepositoryAtlasHtml({ packageDir: root })
    const html = fs.readFileSync(result.output, 'utf8')
    assert.match(html, /Repository Atlas/)
    assert.match(html, /Stage 05 \/ 11/)
    assert.match(html, /id="file-tree"/)
    assert.match(html, /id="dependency-flow"/)
    assert.match(html, /data-direction="downstream"/)
    assert.match(html, /id="stage-evolution"/)
    assert.match(html, /data-evolution-step/)
    assert.match(html, /首次生成文件级依赖流/)
    assert.match(html, /data-shared-ref/)
    assert.match(html, /共享节点 · 已合并到首次出现/)
    assert.match(html, /个唯一节点 \/.*个共享引用/)
    assert.match(html, /class:'shared-link-layer'/)
    assert.match(html, /共享汇流 · /)
    assert.match(html, /setSharedHighlight/)
    assert.match(html, /<details class="diagnostic-band">/)
    assert.match(html, /height:max\(680px,calc\(100dvh - 170px\)\)/)
    assert.match(html, /flow-card--kind-/)
    assert.match(html, /--node-component:/)
    assert.match(html, /\.flow-card--kind-component\{background:var\(--node-component\)\}/)
    assert.match(html, /双指捏合缩放 · 三指\/鼠标拖拽移动/)
    assert.match(html, /\.flow-viewport\{overflow:hidden;overflow:clip;overscroll-behavior:none;touch-action:none;cursor:grab\}/)
    assert.match(html, /\.dependency-flow\{position:absolute;top:0;left:0;transform-origin:0 0\}/)
    assert.match(html, /function applyCamera\(\).*translate\(/)
    assert.match(html, /flowViewport\.addEventListener\('wheel'.*event\.ctrlKey.*zoomCameraAt.*\{passive:false\}/)
    assert.doesNotMatch(html, /wheelDeltaInPixels/)
    assert.match(html, /flowViewport\.addEventListener\('pointerdown'/)
    assert.match(html, /multiPointerGesture\.kind==='pan'/)
    assert.match(html, /kind:'pinch'/)
    assert.match(html, /flowViewport\.addEventListener\('gesturechange'/)
    assert.match(html, /flowViewport\.addEventListener\('keydown'/)
    assert.doesNotMatch(html, /camera\.x-=delta\.left/)
    assert.doesNotMatch(html, /id="relation-canvas"/)
    assert.match(html, /repo-repository-atlas-html\/v1/)
    assert.doesNotMatch(html, /projections\/manifest\.json"[^>]*>OPEN/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('stage-six semantics remain compact with accessible full-reading controls and evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-atlas-semantics-'))
  try {
    write(root, 'index.json', {
      schemaVersion: 'repo-frontend-census-package/v1',
      repo: { name: 'semantic-fixture', path: '/repo/semantic-fixture', git: { branch: 'main', head: 'def5678' } },
    })
    write(root, 'static/inventory.json', {
      schemaVersion: 'repo-inventory/v1',
      counts: { categories: { source: 1 } },
      files: [file('src/main.ts', 'TypeScript', 'source', 140)],
    })
    write(root, 'static/support-decision.json', { schemaVersion: 'repo-support-decision/v1', snapshotId: 'snapshot:semantic', supportLevel: 'supported-frontend' })
    write(root, 'static/static-program-graph.json', {
      schemaVersion: 'repo-static-program-graph/v1',
      graphId: 'graph:semantic',
      snapshotId: 'snapshot:semantic',
      nodes: [node('module:src/main.ts', 'src/main.ts')],
      edges: [],
      diagnostics: [],
    })
    write(root, 'static/code-map.json', { schemaVersion: 'repo-code-map/v1', routes: [], symbols: [], imports: [], relationships: [] })
    write(root, 'static/investigation-frame.json', { schemaVersion: 'repo-investigation-frame/v1', frameId: 'frame:semantic', coreFlowCandidates: [] })
    write(root, 'planning/manifest.json', { schemaVersion: 'repo-research-plan/v1', contractRefs: [], questionCounts: {} })
    write(root, 'planning/open-questions.json', { schemaVersion: 'repo-open-question-set/v1', questions: [] })
    write(root, 'store/semantic-store-manifest.json', { schemaVersion: 'repo-semantic-store-manifest/v1', counts: { evidence: 9, claims: 8 } })
    write(root, 'store/node-semantics.json', {
      schemaVersion: 'repo-node-semantics/v1',
      status: 'active',
      entries: [{
        filePath: 'src/main.ts',
        title: 'Merchant application entry',
        status: 'accepted',
        confidence: 0.93,
        responsibility: {
          summary: 'Bootstraps the merchant application, composes runtime providers, restores the authenticated session, installs routing guards, and mounts the final shell only after required startup checks have completed.',
          evidence: [{ sourcePath: 'src/main.ts', startLine: 12, endLine: 44 }],
        },
        inputs: [{ name: 'Runtime configuration', description: 'Reads deployment and tenant configuration before application startup.', confidence: 0.9, evidence: [{ sourcePath: 'src/main.ts', startLine: 12, endLine: 18 }] }],
        actions: [{ name: 'Mount application', description: 'Creates the application, installs providers and mounts the shell.', confidence: 0.95, evidence: [{ sourcePath: 'src/main.ts', startLine: 20, endLine: 44 }] }],
        state: [{ name: 'Authenticated session', description: 'Restores persisted identity into the runtime store.', confidence: 0.86, evidence: [{ sourcePath: 'src/main.ts', startLine: 24, endLine: 31 }] }],
        outputs: [{ name: 'Mounted shell', description: 'Produces the interactive merchant application.', confidence: 0.94, evidence: [{ sourcePath: 'src/main.ts', startLine: 40, endLine: 44 }] }],
        conditions: [{ name: 'Startup checks', description: 'Mounting waits until mandatory startup checks finish.', confidence: 0.82, evidence: [{ sourcePath: 'src/main.ts', startLine: 32, endLine: 39 }] }],
        boundaries: [{ name: 'Feature behavior', description: 'Delegates feature behavior to routed modules.', confidence: 0.8, evidence: [{ sourcePath: 'src/main.ts', startLine: 42, endLine: 44 }] }],
        collaborators: [{ filePath: 'src/router/index.ts', role: 'Installs guarded application routes.', evidence: [{ sourcePath: 'src/main.ts', startLine: 21, endLine: 23 }] }],
        unknowns: [{ kind: 'runtime', question: 'Which remote flag source wins?', reason: 'The provider implementation is external.', evidence: [{ sourcePath: 'src/main.ts', startLine: 14, endLine: 16 }] }],
      }],
    })
    write(root, 'state/run-state.json', { schemaVersion: 'repo-run-state/v3', workItems: {} })

    const model = buildRepositoryAtlasModel(root)
    assert.equal(model.progress.currentStage, 6)
    assert.equal(model.summary.semanticNodes, 1)

    const result = generateRepositoryAtlasHtml({ packageDir: root })
    const html = fs.readFileSync(result.output, 'utf8')
    assert.match(html, /\.flow-card__semantic--collapsed\{display:-webkit-box/)
    assert.doesNotMatch(html, /\.flow-card__semantic\{display:-webkit-box/)
    assert.match(html, /<button type="button" class="flow-action flow-action--semantic" data-semantic-summary-toggle=/)
    assert.match(html, /aria-expanded=/)
    assert.match(html, /aria-controls=/)
    assert.match(html, /展开语义全文/)
    assert.match(html, /expandedSemanticSummaries/)
    assert.match(html, /if\(next\)next\.focus\(\)/)
    assert.doesNotMatch(html, /MAX_DEPTH/)
    assert.doesNotMatch(html, /达到 5 层上限/)
    assert.match(html, /var terminal=Boolean\(state\)/)
    assert.match(html, /<nav class="semantic-nav" aria-label="语义章节">/)
    assert.match(html, /data-semantic-nav/)
    assert.match(html, /function renderSemanticGroup\(id,title,items\).*<details class="semantic-group".*<summary><span>/)
    assert.match(html, /target\.focus\(\{preventScroll:true\}\)/)
    assert.match(html, /"sourcePath":"src\/main\.ts","startLine":12,"endLine":44/)
    assert.match(html, /semanticEvidenceLabel\(item\.evidence\)/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function file(filePath, language, category, lines) {
  return { path: filePath, language, category, lines, size: lines * 10, binary: false, protected: false }
}

function node(nodeId, sourcePath) {
  return { nodeId, source: { sourcePath } }
}

function write(root, relativePath, value) {
  const filePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
