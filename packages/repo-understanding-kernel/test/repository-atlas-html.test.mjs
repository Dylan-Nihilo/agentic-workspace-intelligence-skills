import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import {
  buildRepositoryAtlasModel,
  generateRepositoryAtlasHtml,
} from '../src/projections/repository-atlas-html.mjs'

test('repository atlas renders the progressive file tree without Product Maps', () => {
  const root = fixture('repo-atlas-base-')
  try {
    seedBasePackage(root)
    write(root, 'planning/manifest.json', {
      schemaVersion: 'repo-research-plan/v1',
      contractRefs: [],
      questionCounts: { 'product-intent:blocked': 1 },
    })
    write(root, 'planning/open-questions.json', {
      schemaVersion: 'repo-open-question-set/v1',
      questions: [{ questionId: 'question:1', category: 'product-intent', lifecycleStatus: 'blocked' }],
    })

    const model = buildRepositoryAtlasModel(root)
    assert.equal(model.progress.currentStage, 5)
    assert.equal(model.summary.files, 3)
    assert.equal(model.graph.edges.length, 1)

    const html = render(root)
    assertEmbeddedScriptParses(html)
    assert.match(html, /Repository Atlas/)
    assert.match(html, /Stage 05 \/ 12/)
    assert.match(html, /id="file-tree"/)
    assert.match(html, /id="dependency-flow"/)
    assert.match(html, /data-shared-ref/)
    assert.match(html, /共享节点 · 已合并到首次出现/)
    assert.match(html, /data-reference-kind="cycle"/)
    assert.match(html, /事件回路 · 返回已有节点/)
    assert.match(html, /flow-reference--cycle/)
    assert.match(html, /class:'shared-link-layer'/)
    assert.match(html, /双指捏合缩放 · 三指\/鼠标拖拽移动/)
    assert.match(html, /multiPointerGesture\.kind==='pan'/)
    assert.match(html, /kind:'pinch'/)
    assert.match(html, /function animateCameraTo\(nextX,nextY,onComplete\)/)
    assert.match(html, /function easeOutQuint\(value\)/)
    assert.match(html, /dataset\.cameraAnimating='true'/)
    assert.match(html, /revealCameraElement\(target,true,true/)
    assert.match(html, /flow-reference-arrival/)
    assert.match(html, /prefersReducedMotion\.matches/)
    assert.doesNotMatch(html, /id="relation-canvas"/)
    assert.doesNotMatch(html, /behavior-path-select|s7-layer-switch/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('stage six adds evidence-backed semantics without a depth ceiling', () => {
  const root = fixture('repo-atlas-semantics-')
  try {
    seedBasePackage(root)
    write(root, 'store/node-semantics.json', {
      schemaVersion: 'repo-node-semantics/v1',
      status: 'complete',
      entries: [{
        filePath: 'src/main.ts',
        title: 'Merchant application entry',
        status: 'accepted',
        confidence: 0.93,
        responsibility: {
          summary: 'Bootstraps the application and mounts the final shell after startup checks.',
          evidence: [{ sourcePath: 'src/main.ts', startLine: 12, endLine: 30 }],
        },
        inputs: [{ name: 'Runtime configuration', description: 'Reads startup configuration.', confidence: 0.9, evidence: [{ sourcePath: 'src/main.ts', startLine: 12, endLine: 18 }] }],
        actions: [{ name: 'Mount application', description: 'Creates and mounts the app.', confidence: 0.95, evidence: [{ sourcePath: 'src/main.ts', startLine: 20, endLine: 30 }] }],
        state: [], outputs: [], conditions: [], boundaries: [], collaborators: [], unknowns: [],
      }],
    })

    const model = buildRepositoryAtlasModel(root)
    assert.equal(model.stages[5].status, 'complete')
    assert.equal(model.progress.currentStage, 7)
    assert.equal(model.summary.semanticNodes, 1)

    const html = render(root)
    assert.match(html, /data-semantic-summary-toggle=/)
    assert.match(html, /展开语义全文/)
    assert.match(html, /<nav class="semantic-nav" aria-label="语义章节">/)
    assert.match(html, /"sourcePath":"src\/main\.ts","startLine":12,"endLine":30/)
    assert.doesNotMatch(html, /MAX_DEPTH|达到 5 层上限/)
    assertEmbeddedScriptParses(html)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('stage seven preserves the visible S6 tree and adds reviewed Agent domains', () => {
  const root = fixture('repo-atlas-zones-')
  try {
    seedBasePackage(root)
    write(root, 'store/node-semantics.json', {
      schemaVersion: 'repo-node-semantics/v1',
      status: 'complete',
      entries: [
        semantic('src/main.ts', '应用入口', '挂载应用。'),
        semantic('src/views/Merchant.vue', '商户页面', '查询和维护商户。'),
      ],
    })
    write(root, 'planning/repository-zones.json', {
      schemaVersion: 'repo-repository-zones/v2',
      zonePlanId: 'repository-zones:test',
      planId: 'repository-zone-agent-plan:test',
      snapshotId: 'snapshot:test',
      graphId: 'graph:test',
      semanticCatalogHash: `sha256:${'a'.repeat(64)}`,
      status: 'complete',
      producer: { kind: 'agent', agentId: 'domain-agent:test' },
      review: { status: 'accepted', reviewer: { kind: 'agent', agentId: 'domain-verifier:test' } },
      unknowns: [],
      gates: {},
      metrics: { files: 3, zones: 2, subzones: 2, unclassifiedFiles: 0, crossZoneRelations: 1 },
      zones: [
        zone('application-shell', '应用骨架', 'shell:runtime', '启动与运行时', ['package.json', 'src/main.ts']),
        zone('merchant-domain', '商户领域', 'merchant:management', '商户管理', ['src/views/Merchant.vue']),
      ],
      memberships: [
        membership('package.json', 'application-shell', 'shell:runtime', '构建清单'),
        membership('src/main.ts', 'application-shell', 'shell:runtime', '应用入口'),
        membership('src/views/Merchant.vue', 'merchant-domain', 'merchant:management', '商户页面'),
      ],
      crossZoneRelations: [{ fromZoneId: 'application-shell', toZoneId: 'merchant-domain', count: 1, edgeTypes: { imports: 1 } }],
    })

    const model = buildRepositoryAtlasModel(root)
    assert.equal(model.stages[6].status, 'complete')
    assert.equal(model.summary.repositoryZones, 2)
    assert.equal(model.summary.zonedFiles, 3)
    assert.equal(model.repositoryZones.memberships.length, 3)

    const html = render(root)
    assert.match(html, /Agent Domain Zoning/)
    assert.match(html, /function renderRepositoryZones\(centerRoot\)/)
    assert.match(html, /function collectVisibleRepositoryGraph\(\)/)
    assert.match(html, /semantic-tree-layout/)
    assert.match(html, /semantic-territory-layer/)
    assert.match(html, /semantic-territory-layer--shapes/)
    assert.match(html, /semantic-territory-layer--labels/)
    assert.match(html, /semantic-territory__shape/)
    assert.match(html, /function drawSemanticTerritories\(visible\)/)
    assert.match(html, /flowHost\.appendChild\(labelSvg\)/)
    assert.match(html, /function arrangeVisibleDomainChildren\(items\)/)
    assert.match(html, /data-zone-id/)
    assert.match(html, /expandedNodes\.has\(filePath\)/)
    assert.match(html, /沿用 S6 树形结构/)
    assert.match(html, /Domain Agent 已将同一棵文件树组织为仓库领域/)
    assert.doesNotMatch(html, /dynamic-zone-frame|data-zone-frame|behavior-path-select|s7-layer-switch/)
    assertEmbeddedScriptParses(html)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('stage eight keeps the S7 tree and projects reviewed domain responsibilities onto it', () => {
  const root = fixture('repo-atlas-domain-understanding-')
  try {
    seedBasePackage(root)
    write(root, 'store/node-semantics.json', {
      schemaVersion: 'repo-node-semantics/v1',
      status: 'complete',
      entries: [
        semantic('src/main.ts', '应用入口', '挂载应用。'),
        semantic('src/views/Merchant.vue', '商户页面', '查询和维护商户。'),
      ],
    })
    writeReviewedZones(root)
    write(root, 'store/repository-domain-summaries.json', {
      schemaVersion: 'repo-repository-domain-summaries/v1',
      summaryCatalogId: 'repository-domain-summaries:test',
      planId: 'repository-domain-summary-agent-plan:test',
      snapshotId: 'snapshot:test',
      graphId: 'graph:test',
      semanticCatalogHash: `sha256:${'a'.repeat(64)}`,
      zonePlanId: 'repository-zones:test',
      zoneCatalogHash: `sha256:${'b'.repeat(64)}`,
      status: 'complete',
      producer: { kind: 'agent', agentId: 'domain-interpreter:test' },
      review: { status: 'accepted', catalogHash: `sha256:${'c'.repeat(64)}`, reviewer: { kind: 'agent', agentId: 'domain-summary-verifier:test' } },
      summaries: [
        domainSummary('application-shell', '应用骨架', '负责应用启动、运行时装配与领域页面接入。', 'src/main.ts', 'src/main.ts', 'merchant-domain'),
        domainSummary('merchant-domain', '商户领域', '负责商户资料查询与维护界面。', 'src/views/Merchant.vue', 'src/views/Merchant.vue', 'application-shell'),
      ],
      metrics: { zones: 2, entryFiles: 2, coreFiles: 2, boundaryFiles: 2, collaborations: 2, unknowns: 2 },
      generatedAt: '2026-07-16T00:00:00.000Z',
    })

    const model = buildRepositoryAtlasModel(root)
    assert.equal(model.stages[7].status, 'complete')
    assert.equal(model.summary.understoodDomains, 2)
    assert.equal(model.summary.domainBoundaryFiles, 2)
    assert.equal(model.repositoryDomainSummaries.review.status, 'accepted')

    const html = render(root)
    assert.match(html, /Agent Domain Understanding/)
    assert.match(html, /id="domain-companion"/)
    assert.match(html, /function renderDomainCompanion\(\)/)
    assert.match(html, /function setDomainFocus\(zoneId\)/)
    assert.match(html, /data-domain-focus/)
    assert.match(html, /flow-badge--domain-role/)
    assert.match(html, /flow-relation--domain-boundary/)
    assert.match(html, /卡片标记入口 \/ 核心 \/ 边界/)
    assert.match(html, /负责应用启动、运行时装配与领域页面接入/)
    assert.match(html, /semantic-tree-layout/)
    assert.doesNotMatch(html, /id="domain-understanding-graph"|domain-map-canvas/)
    assertEmbeddedScriptParses(html)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function seedBasePackage(root) {
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
    nodes: [node('module:src/main.ts', 'src/main.ts'), node('module:src/views/Merchant.vue', 'src/views/Merchant.vue')],
    edges: [{ edgeId: 'edge:1', type: 'imports', from: 'module:src/main.ts', to: 'module:src/views/Merchant.vue' }],
    diagnostics: [{ kind: 'import-resolution-failure', severity: 'warning', message: 'fixture gap', sourcePath: 'src/main.ts' }],
  })
  write(root, 'static/code-map.json', { schemaVersion: 'repo-code-map/v1', routes: [], symbols: [], imports: [], relationships: [] })
  write(root, 'static/community-map.json', { schemaVersion: 'repo-community-map/v1', communities: [] })
  write(root, 'static/neighbor-map.json', { schemaVersion: 'repo-neighbor-map/v1', entries: [], edges: [] })
  write(root, 'static/investigation-frame.json', { schemaVersion: 'repo-investigation-frame/v1', frameId: 'frame:test', coreFlowCandidates: [] })
  write(root, 'planning/manifest.json', { schemaVersion: 'repo-research-plan/v1', contractRefs: [], questionCounts: {} })
  write(root, 'planning/open-questions.json', { schemaVersion: 'repo-open-question-set/v1', questions: [] })
  write(root, 'planning/node-semantic-batches.json', { batchCount: 1, eligibleFileCount: 2 })
  write(root, 'store/semantic-store-manifest.json', { schemaVersion: 'repo-semantic-store-manifest/v1', counts: { evidence: 0, claims: 0 } })
  write(root, 'state/run-state.json', { schemaVersion: 'repo-run-state/v3', workItems: {} })
}

function writeReviewedZones(root) {
  write(root, 'planning/repository-zones.json', {
    schemaVersion: 'repo-repository-zones/v2',
    zonePlanId: 'repository-zones:test',
    planId: 'repository-zone-agent-plan:test',
    snapshotId: 'snapshot:test',
    graphId: 'graph:test',
    semanticCatalogHash: `sha256:${'a'.repeat(64)}`,
    status: 'complete',
    producer: { kind: 'agent', agentId: 'domain-agent:test' },
    review: { status: 'accepted', reviewer: { kind: 'agent', agentId: 'domain-verifier:test' } },
    unknowns: [],
    gates: {},
    metrics: { files: 3, zones: 2, subzones: 2, unclassifiedFiles: 0, crossZoneRelations: 1 },
    zones: [
      zone('application-shell', '应用骨架', 'shell:runtime', '启动与运行时', ['package.json', 'src/main.ts']),
      zone('merchant-domain', '商户领域', 'merchant:management', '商户管理', ['src/views/Merchant.vue']),
    ],
    memberships: [
      membership('package.json', 'application-shell', 'shell:runtime', '构建清单'),
      membership('src/main.ts', 'application-shell', 'shell:runtime', '应用入口'),
      membership('src/views/Merchant.vue', 'merchant-domain', 'merchant:management', '商户页面'),
    ],
    crossZoneRelations: [{ fromZoneId: 'application-shell', toZoneId: 'merchant-domain', count: 1, edgeTypes: { imports: 1 } }],
  })
}

function fixture(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function file(filePath, language, category, lines) {
  return { path: filePath, language, category, lines, size: lines * 10, binary: false, protected: false }
}

function node(nodeId, sourcePath) {
  return { nodeId, source: { sourcePath } }
}

function semantic(filePath, title, summary) {
  return { filePath, title, status: 'accepted', responsibility: { summary, evidence: [] } }
}

function zone(zoneId, label, subzoneId, subzoneLabel, memberFilePaths) {
  return {
    zoneId, label, description: `${label}相关文件。`, fileCount: memberFilePaths.length,
    memberFilePaths, relationSummary: { inbound: 0, outbound: 0 },
    subzones: [{ subzoneId, label: subzoneLabel, description: `${subzoneLabel}相关文件。`, fileCount: memberFilePaths.length, confidence: 0.96, memberFilePaths, representativeFilePaths: memberFilePaths.slice(0, 2) }],
  }
}

function membership(filePath, zoneId, subzoneId, semanticTitle) {
  return { filePath, zoneId, subzoneId, role: 'repository-member', confidence: 0.96, status: 'accepted', semanticTitle, semanticSummary: semanticTitle }
}

function domainSummary(zoneId, label, responsibility, entryFilePath, coreFilePath, collaboratorZoneId) {
  const evidence = filePath => [{ kind: 'zone', filePath, claim: 'Reviewed fixture evidence.' }]
  return {
    zoneId,
    label,
    responsibility: { summary: responsibility, evidenceRefs: evidence(coreFilePath) },
    entryFiles: [{ filePath: entryFilePath, reason: '领域入口。', evidenceRefs: evidence(entryFilePath) }],
    coreFiles: [{ filePath: coreFilePath, reason: '核心职责载体。', evidenceRefs: evidence(coreFilePath) }],
    boundaryFiles: [{ filePath: coreFilePath, direction: 'outbound', connectedZoneIds: [collaboratorZoneId], reason: '跨领域连接点。', evidenceRefs: evidence(coreFilePath) }],
    collaboratingDomains: [{ zoneId: collaboratorZoneId, direction: 'outbound', relationCount: 1, summary: '通过静态文件关系协作。', evidenceRefs: evidence(coreFilePath) }],
    outputs: [{ name: '领域能力', description: '向相邻领域提供已声明能力。', evidenceRefs: evidence(coreFilePath) }],
    unknowns: [{ question: '运行时选择仍需确认。', reason: '静态证据不足。', evidenceRefs: [] }],
    confidence: 0.9,
  }
}

function render(root) {
  const result = generateRepositoryAtlasHtml({ packageDir: root })
  return fs.readFileSync(result.output, 'utf8')
}

function write(root, relativePath, value) {
  const filePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function assertEmbeddedScriptParses(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(match, 'expected Repository Atlas browser script')
  assert.doesNotThrow(() => new vm.Script(match[1]), 'generated browser script must parse')
}
