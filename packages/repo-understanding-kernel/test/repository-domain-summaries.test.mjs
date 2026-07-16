import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  acceptRepositoryDomainSummaryCatalog,
  buildRepositoryDomainSummaryAgentContext,
  buildRepositoryDomainSummaryAgentPlan,
  repositoryDomainSummaryCatalogHash,
  validateRepositoryDomainSummaries,
  validateRepositoryDomainSummaryAgentPlan,
  validateRepositoryDomainSummaryDraft,
  validateRepositoryDomainSummaryReview,
  writeRepositoryDomainSummaries,
  writeRepositoryDomainSummaryAgentContext,
  writeRepositoryDomainSummaryAgentPlan,
} from '../src/knowledge/repository-domain-summaries.mjs'

test('S8 planning preserves reviewed S7 zones and exposes evidence-rich Agent context', () => {
  const fixture = buildFixture()
  const plan = buildRepositoryDomainSummaryAgentPlan(fixture)
  assert.deepEqual(validateRepositoryDomainSummaryAgentPlan({ plan, ...fixture }), [])
  assert.equal(plan.constraints.classification, 'reuse-reviewed-zone-membership')
  assert.deepEqual(plan.allowedZoneIds, ['application', 'platform'])
  assert.equal(plan.summaries, undefined)

  const context = buildRepositoryDomainSummaryAgentContext({ plan, ...fixture })
  assert.equal(context.schemaVersion, 'repo-repository-domain-summary-agent-context/v1')
  assert.equal(context.zones.length, 2)
  assert.equal(context.summary.boundaryRelations, 2)
  assert.equal(context.zones[0].files[0].semantic.responsibility, '挂载并承载应用。')
  assert.equal(context.zones[0].boundaryRelations[0].toFilePath, 'src/shared/helper.js')
  assert.equal(context.analysisRequirements.some(item => item.includes('do not rename domains')), true)
})

test('only independently reviewed, fully covered domain summaries become authoritative', () => {
  const fixture = buildFixture()
  const plan = buildRepositoryDomainSummaryAgentPlan(fixture)
  const catalog = buildDraft(plan)
  assert.deepEqual(validateRepositoryDomainSummaryDraft({ catalog, plan, ...fixture }), [])
  const review = acceptedReview(plan, catalog)
  assert.deepEqual(validateRepositoryDomainSummaryReview({ review, plan, catalog }), [])

  const accepted = acceptRepositoryDomainSummaryCatalog({ catalog, review, plan, ...fixture })
  assert.equal(accepted.schemaVersion, 'repo-repository-domain-summaries/v1')
  assert.equal(accepted.status, 'complete')
  assert.equal(accepted.metrics.zones, 2)
  assert.equal(accepted.metrics.boundaryFiles, 2)
  assert.equal(accepted.review.reviewer.agentId, 'domain-summary-verifier:test')
  assert.deepEqual(validateRepositoryDomainSummaries(accepted, { plan, ...fixture }), [])
})

test('S8 rejects renamed zones, cross-zone core files, invented graph relations, and self-review', () => {
  const fixture = buildFixture()
  const plan = buildRepositoryDomainSummaryAgentPlan(fixture)
  const catalog = buildDraft(plan)

  const renamed = structuredClone(catalog)
  renamed.summaries[0].label = 'Invented domain'
  assert(validateRepositoryDomainSummaryDraft({ catalog: renamed, plan, ...fixture }).some(issue => issue.includes('preserve the reviewed S7 title')))

  const wrongCore = structuredClone(catalog)
  wrongCore.summaries[0].coreFiles[0].filePath = 'src/shared/helper.js'
  assert(validateRepositoryDomainSummaryDraft({ catalog: wrongCore, plan, ...fixture }).some(issue => issue.includes('must belong to the current zone')))

  const inventedRelation = structuredClone(catalog)
  inventedRelation.summaries[0].boundaryFiles[0].evidenceRefs[0].relatedFilePath = 'src/App.vue'
  assert(validateRepositoryDomainSummaryDraft({ catalog: inventedRelation, plan, ...fixture }).some(issue => issue.includes('concrete directed graph relation')))

  const review = acceptedReview(plan, catalog)
  review.reviewer.agentId = catalog.producer.agentId
  assert(validateRepositoryDomainSummaryReview({ review, plan, catalog }).some(issue => issue.includes('independent')))
})

test('S8 derives every boundary endpoint, connected zone, and direction from the Static Program Graph', () => {
  const fixture = buildFixture()
  const plan = buildRepositoryDomainSummaryAgentPlan(fixture)
  const catalog = buildDraft(plan)

  const detachedEvidence = structuredClone(catalog)
  detachedEvidence.summaries[0].boundaryFiles[0].evidenceRefs[0] = {
    kind: 'graph',
    filePath: 'src/Feature.vue',
    relatedFilePath: 'src/shared/helper.js',
    claim: 'This relation is real but does not touch the declared src/App.vue boundary file.',
  }
  assert(validateRepositoryDomainSummaryDraft({ catalog: detachedEvidence, plan, ...fixture }).some(issue => issue.includes('declared boundary file')))

  const wrongConnectedZones = structuredClone(catalog)
  wrongConnectedZones.summaries[0].boundaryFiles[0].connectedZoneIds = ['application']
  assert(validateRepositoryDomainSummaryDraft({ catalog: wrongConnectedZones, plan, ...fixture }).some(issue => issue.includes('exactly match cross-zone relations')))

  const wrongDirection = structuredClone(catalog)
  wrongDirection.summaries[0].boundaryFiles[0].direction = 'inbound'
  assert(validateRepositoryDomainSummaryDraft({ catalog: wrongDirection, plan, ...fixture }).some(issue => issue.includes('direction must be outbound')))

  const nonGraphEvidence = structuredClone(catalog)
  nonGraphEvidence.summaries[0].boundaryFiles[0].evidenceRefs = nonGraphEvidence.summaries[0].entryFiles[0].evidenceRefs
  assert(validateRepositoryDomainSummaryDraft({ catalog: nonGraphEvidence, plan, ...fixture }).some(issue => issue.includes('concrete graph evidence')))
})

test('S8 plan, context, and accepted catalog write canonical package artifacts', () => {
  const fixture = buildFixture()
  const plan = buildRepositoryDomainSummaryAgentPlan(fixture)
  const context = buildRepositoryDomainSummaryAgentContext({ plan, ...fixture })
  const catalog = buildDraft(plan)
  const accepted = acceptRepositoryDomainSummaryCatalog({ catalog, review: acceptedReview(plan, catalog), plan, ...fixture })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-domain-summary-agent-'))
  try {
    assert.equal(writeRepositoryDomainSummaryAgentPlan({ packageDir: root, plan, ...fixture }), path.join(root, 'planning/repository-domain-summary-agent-plan.json'))
    assert.equal(writeRepositoryDomainSummaryAgentContext({ packageDir: root, context }), path.join(root, 'research/repository-domain-summaries/context.json'))
    assert.equal(writeRepositoryDomainSummaries({ packageDir: root, summaries: accepted, plan, ...fixture }), path.join(root, 'store/repository-domain-summaries.json'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function buildFixture() {
  const inventory = {
    repo: { name: 'domain-summary-fixture', path: '/repo/domain-summary-fixture', git: { branch: 'main', head: 'abc123' } },
    files: [file('src/App.vue', 'Vue'), file('src/Feature.vue', 'Vue'), file('src/shared/helper.js', 'JavaScript')],
  }
  const staticProgramGraph = {
    graphId: 'graph:domain-summary',
    snapshotId: 'snapshot:domain-summary',
    generatedAt: '2026-07-16T00:00:00Z',
    nodes: inventory.files.map(item => ({ nodeId: `module:${item.path}`, source: { sourcePath: item.path } })),
    edges: [
      { edgeId: 'edge:app-helper', type: 'imports', from: 'module:src/App.vue', to: 'module:src/shared/helper.js' },
      { edgeId: 'edge:feature-helper', type: 'imports', from: 'module:src/Feature.vue', to: 'module:src/shared/helper.js' },
    ],
  }
  const nodeSemanticCatalog = {
    schemaVersion: 'repo-node-semantic-catalog/v1',
    snapshotId: staticProgramGraph.snapshotId,
    status: 'complete',
    entries: [
      semantic('src/App.vue', '应用入口', '挂载并承载应用。'),
      semantic('src/Feature.vue', '应用功能', '消费共享格式化能力。'),
      semantic('src/shared/helper.js', '共享工具', '提供通用格式化。'),
    ],
    generatedAt: '2026-07-16T00:00:00Z',
  }
  const repositoryZones = {
    schemaVersion: 'repo-repository-zones/v2',
    zonePlanId: 'repository-zones:test',
    snapshotId: staticProgramGraph.snapshotId,
    graphId: staticProgramGraph.graphId,
    semanticCatalogHash: 'sha256:test',
    status: 'complete',
    zones: [
      zone('application', '应用运行', '承载应用运行。', ['src/App.vue', 'src/Feature.vue']),
      zone('platform', '共享平台', '提供共享能力。', 'src/shared/helper.js'),
    ],
    memberships: [
      membership('src/App.vue', 'application', 'application-core'),
      membership('src/Feature.vue', 'application', 'application-core'),
      membership('src/shared/helper.js', 'platform', 'platform-core'),
    ],
    crossZoneRelations: [{ fromZoneId: 'application', toZoneId: 'platform', count: 2, edgeTypes: { imports: 2 } }],
    review: { status: 'accepted', reviewer: { kind: 'agent', agentId: 'zone-verifier:test' } },
    metrics: { files: 2, zones: 2, subzones: 2, unclassifiedFiles: 0, crossZoneRelations: 1 },
    generatedAt: '2026-07-16T00:00:00Z',
  }
  return { inventory, staticProgramGraph, nodeSemanticCatalog, repositoryZones, repoPath: inventory.repo.path }
}

function buildDraft(plan) {
  return {
    schemaVersion: 'repo-repository-domain-summaries/v1',
    summaryCatalogId: 'repository-domain-summary-agent:test',
    planId: plan.planId,
    snapshotId: plan.snapshotId,
    graphId: plan.graphId,
    semanticCatalogHash: plan.semanticCatalogHash,
    zonePlanId: plan.zonePlanId,
    zoneCatalogHash: plan.zoneCatalogHash,
    status: 'draft',
    producer: { kind: 'agent', agentId: 'domain-interpreter:test', runId: 'run:test' },
    summaries: [
      domainSummary({
        zoneId: 'application',
        label: '应用运行',
        filePath: 'src/App.vue',
        responsibility: '挂载应用并承载前端运行。',
        boundaryDirection: 'outbound',
        connectedZoneId: 'platform',
        relationFrom: 'src/App.vue',
        relationTo: 'src/shared/helper.js',
      }),
      domainSummary({
        zoneId: 'platform',
        label: '共享平台',
        filePath: 'src/shared/helper.js',
        responsibility: '向应用提供共享格式化能力。',
        boundaryDirection: 'inbound',
        connectedZoneId: 'application',
        relationFrom: 'src/App.vue',
        relationTo: 'src/shared/helper.js',
      }),
    ],
    generatedAt: '2026-07-16T00:01:00Z',
  }
}

function domainSummary({ zoneId, label, filePath, responsibility, boundaryDirection, connectedZoneId, relationFrom, relationTo }) {
  const semanticRef = { kind: 'semantic', filePath, startLine: 1, endLine: 4, claim: responsibility }
  const graphRef = { kind: 'graph', filePath: relationFrom, relatedFilePath: relationTo, claim: '静态图确认跨领域 imports 关系。' }
  return {
    zoneId,
    label,
    responsibility: { summary: responsibility, evidenceRefs: [semanticRef] },
    entryFiles: [{ filePath, reason: '作为当前领域的主要代码入口。', evidenceRefs: [semanticRef] }],
    coreFiles: [{ filePath, reason: '承担当前领域的核心职责。', evidenceRefs: [semanticRef] }],
    boundaryFiles: [{ filePath, direction: boundaryDirection, connectedZoneIds: [connectedZoneId], reason: '参与跨领域依赖。', evidenceRefs: [graphRef] }],
    collaboratingDomains: [{ zoneId: connectedZoneId, direction: boundaryDirection, relationCount: 1, summary: '通过 imports 关系协作。', evidenceRefs: [graphRef] }],
    outputs: [{ name: '领域能力', description: responsibility, evidenceRefs: [semanticRef] }],
    unknowns: [],
    confidence: 0.9,
  }
}

function acceptedReview(plan, catalog) {
  return {
    schemaVersion: 'repo-repository-domain-summary-review/v1',
    planId: plan.planId,
    snapshotId: plan.snapshotId,
    catalogHash: repositoryDomainSummaryCatalogHash(catalog),
    status: 'accepted',
    checks: {
      evidenceGrounding: true,
      zoneCoverage: true,
      entryAndCoreAccuracy: true,
      boundaryAccuracy: true,
      collaborationAccuracy: true,
      noInventedBehavior: true,
      unknownsPreserved: true,
    },
    issues: [],
    reviewer: { kind: 'agent', agentId: 'domain-summary-verifier:test', runId: 'review:test' },
    generatedAt: '2026-07-16T00:02:00Z',
  }
}

function zone(zoneId, label, summary, filePath) {
  const filePaths = Array.isArray(filePath) ? filePath : [filePath]
  return {
    zoneId,
    label,
    summary,
    rationale: `${filePaths[0]} 提供直接语义证据。`,
    confidence: 0.9,
    evidenceRefs: [{ kind: 'semantic', filePath: filePaths[0], claim: summary }],
    fileCount: filePaths.length,
    memberFilePaths: filePaths,
    subzones: [{
      subzoneId: `${zoneId}-core`,
      label: `${label}核心`,
      summary,
      rationale: summary,
      confidence: 0.9,
      evidenceRefs: [{ kind: 'semantic', filePath: filePaths[0], claim: summary }],
      fileCount: filePaths.length,
      memberFilePaths: filePaths,
      representativeFilePaths: filePaths,
    }],
  }
}

function membership(filePath, zoneId, subzoneId) {
  return { filePath, zoneId, subzoneId, role: '核心文件', rationale: '测试归属。', confidence: 0.9, status: 'accepted', evidenceRefs: [{ kind: 'semantic', filePath, claim: '测试语义。' }] }
}

function semantic(filePath, title, summary) {
  return {
    filePath,
    semanticKind: filePath.endsWith('.vue') ? 'component' : 'shared-utility',
    title,
    responsibility: { summary, evidence: [{ sourcePath: filePath, startLine: 1, endLine: 4 }] },
    inputs: [], actions: [], state: [], outputs: [], conditions: [], boundaries: [], collaborators: [], unknowns: [], confidence: 0.9, status: 'accepted',
  }
}

function file(filePath, language) {
  return { path: filePath, language, category: 'source', binary: false, protected: false, lines: 20, size: 100 }
}
