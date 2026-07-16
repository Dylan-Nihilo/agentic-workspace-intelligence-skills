import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  acceptRepositoryZoneCatalog,
  buildRepositoryZoneAgentContext,
  buildRepositoryZoneAgentPlan,
  repositoryZoneCatalogHash,
  validateRepositoryZoneAgentPlan,
  validateRepositoryZoneDraft,
  validateRepositoryZoneReview,
  validateRepositoryZones,
  writeRepositoryZoneAgentContext,
  writeRepositoryZoneAgentPlan,
  writeRepositoryZones,
} from '../src/planning/repository-zones.mjs'

test('zone planning emits Agent context without statically classifying any file', () => {
  const fixture = buildFixture()
  const plan = buildRepositoryZoneAgentPlan(fixture)
  assert.deepEqual(validateRepositoryZoneAgentPlan({ plan, ...fixture }), [])
  assert.equal(plan.constraints.authority, 'agent-only')
  assert.equal(plan.constraints.domainNaming, 'agent-derived')
  assert.deepEqual(plan.allowedFiles, fixture.inventory.files.map(file => file.path).sort())
  assert.equal(plan.zones, undefined)
  assert.equal(plan.memberships, undefined)

  const context = buildRepositoryZoneAgentContext({ plan, ...fixture })
  assert.equal(context.schemaVersion, 'repo-repository-zone-agent-context/v1')
  assert.equal(context.files.length, fixture.inventory.files.length)
  assert.equal(context.files.find(file => file.filePath === 'src/views/MerchantList.vue').semantic.responsibility, '查询和维护商户。')
  assert(context.files.find(file => file.filePath === 'src/views/MerchantList.vue').relations.some(item => item.filePath === 'src/shared/helper.js'))
  assert.equal(context.resultContract.producerKind, 'agent')
  assert.equal(context.analysisRequirements.some(item => item.includes('No fixed taxonomy')), true)
})

test('only an independently reviewed Agent domain catalog can become authoritative zones', () => {
  const fixture = buildFixture()
  const plan = buildRepositoryZoneAgentPlan(fixture)
  const catalog = buildAgentDraft(plan)
  assert.deepEqual(validateRepositoryZoneDraft({ catalog, plan, ...fixture }), [])
  const review = acceptedReview(plan, catalog)
  assert.deepEqual(validateRepositoryZoneReview({ review, plan, catalog }), [])

  const accepted = acceptRepositoryZoneCatalog({ catalog, review, plan, ...fixture })
  assert.equal(accepted.schemaVersion, 'repo-repository-zones/v2')
  assert.equal(accepted.status, 'complete')
  assert.equal(accepted.producer.kind, 'agent')
  assert.equal(accepted.review.reviewer.agentId, 'domain-verifier:test')
  assert.equal(accepted.memberships.length, fixture.inventory.files.length)
  assert.equal(new Set(accepted.memberships.map(item => item.filePath)).size, fixture.inventory.files.length)
  assert.equal(accepted.zones.find(zone => zone.zoneId === 'merchant-operations').fileCount, 1)
  assert(accepted.crossZoneRelations.some(item => item.fromZoneId === 'merchant-operations' && item.toZoneId === 'platform-foundation'))
  assert.deepEqual(validateRepositoryZones(accepted, { plan, ...fixture }), [])
})

test('kernel rejects static producers, incomplete coverage, and self-review', () => {
  const fixture = buildFixture()
  const plan = buildRepositoryZoneAgentPlan(fixture)
  const catalog = buildAgentDraft(plan)
  const staticCatalog = { ...catalog, producer: { kind: 'kernel', agentId: 'none' } }
  assert(validateRepositoryZoneDraft({ catalog: staticCatalog, plan, ...fixture }).some(issue => issue.includes('producer')))

  const incomplete = { ...catalog, memberships: catalog.memberships.slice(1) }
  assert(validateRepositoryZoneDraft({ catalog: incomplete, plan, ...fixture }).some(issue => issue.includes('exactly once')))

  const selfReview = acceptedReview(plan, catalog)
  selfReview.reviewer.agentId = catalog.producer.agentId
  assert(validateRepositoryZoneReview({ review: selfReview, plan, catalog }).some(issue => issue.includes('independent')))
})

test('Agent plan, context, and accepted catalog write canonical package artifacts', () => {
  const fixture = buildFixture()
  const plan = buildRepositoryZoneAgentPlan(fixture)
  const context = buildRepositoryZoneAgentContext({ plan, ...fixture })
  const catalog = buildAgentDraft(plan)
  const accepted = acceptRepositoryZoneCatalog({ catalog, review: acceptedReview(plan, catalog), plan, ...fixture })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-zone-agent-'))
  try {
    assert.equal(writeRepositoryZoneAgentPlan({ packageDir: root, plan, ...fixture }), path.join(root, 'planning/repository-zone-agent-plan.json'))
    assert.equal(writeRepositoryZoneAgentContext({ packageDir: root, context }), path.join(root, 'research/repository-zones/context.json'))
    assert.equal(writeRepositoryZones({ packageDir: root, zones: accepted, plan, ...fixture }), path.join(root, 'planning/repository-zones.json'))
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'planning/repository-zones.json'), 'utf8')).producer.kind, 'agent')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function buildFixture() {
  const inventory = {
    repo: { name: 'domain-fixture', path: '/repo/domain-fixture', git: { branch: 'main', head: 'abc123' } },
    files: [
      file('src/App.vue', 'Vue'),
      file('src/views/MerchantList.vue', 'Vue'),
      file('src/shared/helper.js', 'JavaScript'),
      file('src/assets/logo.png', 'Binary Resource', 'resource', true),
    ],
  }
  const staticProgramGraph = {
    graphId: 'graph:domain-agent',
    snapshotId: 'snapshot:domain-agent',
    generatedAt: '2026-07-15T00:00:00Z',
    nodes: inventory.files.filter(item => !item.binary).map(item => ({ nodeId: `module:${item.path}`, source: { sourcePath: item.path } })),
    edges: [
      edge('src/App.vue', 'src/views/MerchantList.vue', 'renders-component'),
      edge('src/views/MerchantList.vue', 'src/shared/helper.js', 'imports'),
    ],
  }
  const nodeSemanticCatalog = {
    schemaVersion: 'repo-node-semantic-catalog/v1',
    snapshotId: staticProgramGraph.snapshotId,
    status: 'complete',
    entries: [
      semantic('src/App.vue', '应用入口', '承载前端应用。'),
      semantic('src/views/MerchantList.vue', '商户列表', '查询和维护商户。'),
      semantic('src/shared/helper.js', '格式化工具', '提供通用格式转换。'),
    ],
    generatedAt: '2026-07-15T00:00:00Z',
  }
  return { inventory, staticProgramGraph, nodeSemanticCatalog, repoPath: inventory.repo.path }
}

function buildAgentDraft(plan) {
  const evidence = (filePath, claim, kind = 'semantic', relatedFilePath = undefined) => ({ kind, filePath, ...(relatedFilePath ? { relatedFilePath } : {}), claim })
  return {
    schemaVersion: 'repo-repository-zones/v2',
    zonePlanId: 'agent-domain-analysis:test',
    planId: plan.planId,
    snapshotId: plan.snapshotId,
    graphId: plan.graphId,
    semanticCatalogHash: plan.semanticCatalogHash,
    status: 'draft',
    producer: { kind: 'agent', agentId: 'domain-analyzer:test', runId: 'run:test' },
    zones: [
      {
        zoneId: 'merchant-operations', label: '商户经营管理', summary: '维护商户资料。', rationale: '商户列表承担明确的商户维护职责。', confidence: 0.94,
        evidenceRefs: [evidence('src/views/MerchantList.vue', '文件语义明确描述商户查询和维护。')],
        subzones: [{ subzoneId: 'merchant-records', label: '商户资料', summary: '商户资料查询和维护。', rationale: '当前入口围绕商户资料。', confidence: 0.93, evidenceRefs: [evidence('src/views/MerchantList.vue', '职责与商户资料一致。')] }],
      },
      {
        zoneId: 'platform-foundation', label: '前端平台支撑', summary: '承载应用入口和共享能力。', rationale: '应用入口和格式化工具服务于业务页面。', confidence: 0.86,
        evidenceRefs: [evidence('src/App.vue', '应用入口承载业务页面。'), evidence('src/shared/helper.js', '工具被业务页面依赖。', 'graph', 'src/views/MerchantList.vue')],
        subzones: [
          { subzoneId: 'application-host', label: '应用承载', summary: '承载应用渲染。', rationale: 'App 是应用入口。', confidence: 0.91, evidenceRefs: [evidence('src/App.vue', '职责为承载前端应用。')] },
          { subzoneId: 'shared-support', label: '共享支撑', summary: '提供通用代码和随附资源。', rationale: '工具和资源不表达独立业务职责。', confidence: 0.78, evidenceRefs: [evidence('src/shared/helper.js', '提供通用格式转换。'), evidence('src/assets/logo.png', '资源文件只提供界面素材。', 'inventory')] },
        ],
      },
    ],
    memberships: [
      membership('src/App.vue', 'platform-foundation', 'application-host', '应用承载入口', 0.91, evidence('src/App.vue', '承载应用。')),
      membership('src/views/MerchantList.vue', 'merchant-operations', 'merchant-records', '商户资料页面', 0.94, evidence('src/views/MerchantList.vue', '维护商户资料。')),
      membership('src/shared/helper.js', 'platform-foundation', 'shared-support', '共享格式化能力', 0.86, evidence('src/shared/helper.js', '提供通用格式转换。')),
      membership('src/assets/logo.png', 'platform-foundation', 'shared-support', '界面品牌资源', 0.68, evidence('src/assets/logo.png', '资源文件提供界面素材。', 'inventory')),
    ],
    unknowns: [],
    generatedAt: '2026-07-15T00:00:00Z',
  }
}

function acceptedReview(plan, catalog) {
  return {
    schemaVersion: 'repo-repository-zone-review/v1',
    planId: plan.planId,
    snapshotId: plan.snapshotId,
    catalogHash: repositoryZoneCatalogHash(catalog),
    status: 'accepted',
    checks: { semanticGrounding: true, graphCoherence: true, completeCoverage: true, singleFileIdentity: true, notPathOnlyClassification: true, noInventedFiles: true },
    issues: [],
    reviewer: { kind: 'agent', agentId: 'domain-verifier:test', runId: 'review:test' },
    generatedAt: '2026-07-15T00:01:00Z',
  }
}

function membership(filePath, zoneId, subzoneId, role, confidence, evidenceRef) {
  return { filePath, zoneId, subzoneId, role, rationale: `Agent grounded ${role}.`, confidence, status: confidence < 0.7 ? 'needs-review' : 'proposed', evidenceRefs: [evidenceRef] }
}

function file(filePath, language, category = 'source', binary = false) {
  return { path: filePath, language, category, binary, protected: false, lines: binary ? 0 : 20, size: 100 }
}

function semantic(filePath, title, summary) {
  return { filePath, semanticKind: filePath.endsWith('.vue') ? 'component' : 'shared-utility', title, responsibility: { summary, evidence: [{ sourcePath: filePath, startLine: 1, endLine: 4 }] }, inputs: [], actions: [], state: [], outputs: [], conditions: [], boundaries: [], collaborators: [], confidence: 0.9, status: 'accepted' }
}

function edge(from, to, type) {
  return { edgeId: `edge:${from}:${to}`, type, from: `module:${from}`, to: `module:${to}` }
}
