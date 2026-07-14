import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { loadJourneyStore } from '../knowledge/journey-store.mjs'
import { evaluateJourneySetClosure } from '../planning/journey-closure.mjs'
import { validateSynthesisNarrativeSchema } from '../validation/synthesis-narrative-validator.mjs'
import { productProjectionHash, validateProductMaps } from './product-maps.mjs'

const HTML_SCHEMA = 'repo-human-readable-html/v1'
const MAP_KEYS = ['application', 'experience', 'runtimeFlow', 'change']
const MAP_FILES = Object.freeze({
  application: 'projections/application-map.json',
  experience: 'projections/experience-map.json',
  runtimeFlow: 'projections/runtime-flow-map.json',
  change: 'projections/change-map.json',
})
const MAP_SCHEMAS = Object.freeze({
  application: 'repo-application-map/v1',
  experience: 'repo-experience-map/v1',
  runtimeFlow: 'repo-runtime-flow-map/v1',
  change: 'repo-change-map/v1',
})
const QUESTION_CATEGORIES = Object.freeze({
  semantic: 'semantic-ambiguity',
  runtime: 'runtime-external-blocked',
  'product-intent': 'product-intent',
})
const QUESTION_LABELS = Object.freeze({
  semantic: '语义歧义',
  runtime: '运行时外部阻塞',
  'product-intent': '产品意图',
})
const STATUS_LABELS = Object.freeze({
  confirmed: '已确认',
  candidate: '候选',
  conflicted: '冲突',
  missing: '缺失',
  closed: '已闭合',
  open: '未闭合',
  blocked: '阻塞',
  invalidated: '已失效',
})
const BRANCH_LABELS = Object.freeze({
  success: '成功',
  failure: '失败',
  alternate: '备选',
  retry: '重试',
  exit: '退出',
})

export function generateHumanReadableHtml(options = {}) {
  if (!options.packageDir) throw new Error('generateHumanReadableHtml requires packageDir')
  const packageDir = path.resolve(options.packageDir)
  const outFile = path.resolve(options.outFile || path.join(packageDir, 'human-readable.html'))
  const source = loadGovernedSources(packageDir)
  const model = buildReadableModel(packageDir, source)
  const html = renderHtml(model)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, html, 'utf8')
  return {
    schemaVersion: HTML_SCHEMA,
    packageDir,
    output: outFile,
    repo: { title: source.narrative.title },
    snapshotId: source.manifest.snapshotId,
    supportLevel: source.maps.application.supportLevel,
    frontendScope: source.maps.application.application.roots,
    artifactHashes: Object.fromEntries(MAP_KEYS.map(key => [key, source.manifest.projections[key].contentHash])),
    journeys: journeyCounts(source.journeyStore.manifest.entries),
    openQuestions: questionCounts(source.narrative.limitations),
    deterministicDiagnostics: model.diagnostics.length,
    validation: {
      passed: true,
      productMaps: true,
      journeyStore: true,
      narrative: true,
    },
  }
}

function loadGovernedSources(packageDir) {
  const manifest = readRequiredJson(packageDir, 'projections/manifest.json')
  if (manifest.schemaVersion !== 'repo-product-map-manifest/v1') {
    throw new Error('Invalid Product Map manifest: expected repo-product-map-manifest/v1')
  }
  const maps = {}
  for (const key of MAP_KEYS) {
    const entry = manifest.projections?.[key]
    if (!entry) throw new Error(`Product Map manifest is missing projections.${key}`)
    if (entry.path !== MAP_FILES[key]) throw new Error(`Product Map manifest has non-canonical path for ${key}: ${entry.path}`)
    if (entry.schemaVersion !== MAP_SCHEMAS[key]) throw new Error(`Product Map manifest has invalid schemaVersion for ${key}`)
    const map = readRequiredJson(packageDir, entry.path)
    if (map.schemaVersion !== MAP_SCHEMAS[key]) throw new Error(`Invalid ${key} Product Map schemaVersion`)
    const actualHash = productProjectionHash(map)
    if (actualHash !== entry.contentHash) {
      throw new Error(`Product Map artifact hash mismatch for ${entry.path}: expected ${entry.contentHash}, got ${actualHash}`)
    }
    if (map.snapshotId !== manifest.snapshotId) throw new Error(`Product Map snapshot mismatch for ${entry.path}`)
    if (!deepEqual(map.projectionKey, manifest.projectionKey)) throw new Error(`Product Map projectionKey mismatch for ${entry.path}`)
    maps[key] = map
  }

  const mapIssues = validateProductMaps({
    applicationMap: maps.application,
    experienceMap: maps.experience,
    runtimeFlowMap: maps.runtimeFlow,
    changeMap: maps.change,
    manifest,
  })
  if (mapIssues.length) throw new Error(`Product Map validation failed:\n- ${mapIssues.join('\n- ')}`)

  const journeyStore = loadJourneyStore(packageDir)
  if (!journeyStore.manifest.entries.length) throw new Error('Journey Store contains no governed journeys')
  if (journeyStore.manifest.snapshotId !== manifest.snapshotId) throw new Error('Journey Store snapshot does not match Product Maps')
  if (journeyStore.manifest.journeySetHash !== manifest.projectionKey?.journeySetHash) {
    throw new Error('Journey Store hash does not match Product Map projectionKey')
  }
  const journeyClosure = evaluateJourneySetClosure({
    definitions: journeyStore.definitions,
    bindingSets: journeyStore.bindingSets,
    snapshotId: journeyStore.manifest.snapshotId,
    evaluatedAt: journeyStore.manifest.generatedAt,
  })
  if (!journeyClosure.canComplete) {
    const unresolved = journeyClosure.reports
      .filter(item => item.status !== 'closed')
      .map(item => item.journeyId)
    throw new Error(`Journey closure gate failed: ${journeyClosure.counts.closed}/${journeyClosure.counts.journeys} closed; unresolved: ${unresolved.join(', ') || 'none'}`)
  }

  const activeJourneyIds = journeyStore.definitions
    .filter(item => item.status !== 'invalidated')
    .map(item => item.journeyId)
  const projectedJourneyIds = maps.experience.journeys.map(item => item.journeyId)
  if (!deepEqual(activeJourneyIds, projectedJourneyIds)) throw new Error('Experience Map Journey order is stale against Journey Store')
  const definitionById = new Map(journeyStore.definitions.map(item => [item.journeyId, item]))
  for (const journey of maps.experience.journeys) {
    if (!deepEqual(journey, normalizeJourneyForMap(definitionById.get(journey.journeyId)))) {
      throw new Error(`Experience Map Journey is stale against Journey Store: ${journey.journeyId}`)
    }
  }
  const flowJourneyIds = new Set(maps.runtimeFlow.flows.map(item => item.journeyId))
  const overlappingJourneyIds = maps.runtimeFlow.unboundJourneyIds.filter(item => flowJourneyIds.has(item))
  if (overlappingJourneyIds.length) throw new Error(`Runtime Flow Map marks bound Journeys as unbound: ${overlappingJourneyIds.join(', ')}`)
  const runtimeJourneyIds = [...flowJourneyIds, ...maps.runtimeFlow.unboundJourneyIds]
  if (!sameSet(activeJourneyIds, runtimeJourneyIds)) throw new Error('Runtime Flow Map journeys are stale against Journey Store')

  const narrative = readRequiredJson(packageDir, 'synthesis/narrative.json')
  validateNarrative(narrative, manifest, new Set(activeJourneyIds))
  return { manifest, maps, journeyStore, journeyClosure, narrative }
}

function validateNarrative(narrative, manifest, journeyIds) {
  const schemaIssues = validateSynthesisNarrativeSchema(narrative)
  if (schemaIssues.length) {
    throw new Error(`Invalid synthesis narrative schema:\n- ${schemaIssues.map(item => `${item.pointer} ${item.message}`).join('\n- ')}`)
  }
  const requiredText = [
    'title',
    'executiveSummary',
    'applicationSummary',
    'experienceSummary',
    'runtimeFlowSummary',
    'changeSummary',
  ]
  const requiredArrays = ['journeySummaries', 'limitations', 'journeyRefs', 'claimRefs', 'evidenceRefs', 'questionRefs']
  if (narrative.schemaVersion !== 'repo-synthesis-narrative/v3') {
    throw new Error('Invalid synthesis narrative: expected repo-synthesis-narrative/v3')
  }
  if (narrative.snapshotId !== manifest.snapshotId) throw new Error('Synthesis narrative snapshot does not match Product Maps')
  if (narrative.mapManifestRef !== 'projections/manifest.json') throw new Error('Synthesis narrative has an invalid mapManifestRef')
  if (!deepEqual(narrative.projectionKey, manifest.projectionKey)) throw new Error('Synthesis narrative projectionKey is stale')
  for (const field of requiredText) {
    if (!isText(narrative[field])) throw new Error(`Synthesis narrative requires ${field}`)
  }
  for (const field of requiredArrays) {
    if (!Array.isArray(narrative[field])) throw new Error(`Synthesis narrative requires array ${field}`)
  }
  for (const key of MAP_KEYS) {
    if (narrative.mapRefs?.[key] !== manifest.projections[key].path) {
      throw new Error(`Synthesis narrative mapRefs.${key} does not match Product Map manifest`)
    }
  }
  for (const journeyId of narrative.journeyRefs) {
    if (!journeyIds.has(journeyId)) throw new Error(`Synthesis narrative references unknown Journey: ${journeyId}`)
  }
  for (const [index, summary] of narrative.journeySummaries.entries()) {
    if (!journeyIds.has(summary?.journeyId)) throw new Error(`Synthesis narrative journeySummaries[${index}] references an unknown Journey`)
    if (!isText(summary?.summary) || !['closed', 'open', 'blocked'].includes(summary?.status) || !Array.isArray(summary?.evidenceRefs)) {
      throw new Error(`Synthesis narrative journeySummaries[${index}] is incomplete`)
    }
  }
  for (const [index, limitation] of narrative.limitations.entries()) {
    if (!isText(limitation?.limitationId) || !isText(limitation?.summary)) {
      throw new Error(`Synthesis narrative limitations[${index}] is incomplete`)
    }
    if (!['semantic', 'runtime', 'product-intent', 'deterministic-diagnostic', 'journey-closure'].includes(limitation.category)) {
      throw new Error(`Synthesis narrative limitations[${index}] has an invalid category`)
    }
    for (const field of ['mapDimensions', 'journeyIds', 'questionIds', 'evidenceRefs']) {
      if (!Array.isArray(limitation[field])) throw new Error(`Synthesis narrative limitations[${index}].${field} must be an array`)
    }
    for (const journeyId of limitation.journeyIds) {
      if (!journeyIds.has(journeyId)) throw new Error(`Synthesis narrative limitation references unknown Journey: ${journeyId}`)
    }
  }
}

function buildReadableModel(packageDir, source) {
  const { maps, manifest, journeyStore, narrative } = source
  const closureByJourney = new Map(journeyStore.closureReports.map(item => [item.journeyId, item]))
  const narrativeByJourney = new Map(narrative.journeySummaries.map(item => [item.journeyId, item]))
  const diagnostics = [
    ...maps.application.diagnostics.map(item => ({
      id: item.diagnosticId,
      category: 'deterministic-diagnostic',
      severity: item.severity,
      summary: item.message,
      sourcePath: item.sourcePath,
      evidenceRefs: item.evidenceIds,
    })),
    ...narrative.limitations
      .filter(item => item.category === 'deterministic-diagnostic')
      .map(item => ({
        id: item.limitationId,
        category: item.category,
        severity: 'warning',
        summary: item.summary,
        sourcePath: null,
        evidenceRefs: item.evidenceRefs,
      })),
  ]
  return {
    schemaVersion: HTML_SCHEMA,
    generatedAt: new Date().toISOString(),
    packageDir,
    manifest,
    maps,
    narrative,
    journeyStore,
    closureByJourney,
    narrativeByJourney,
    questions: narrative.limitations.filter(item => Object.hasOwn(QUESTION_CATEGORIES, item.category)),
    journeyLimitations: narrative.limitations.filter(item => item.category === 'journey-closure'),
    diagnostics,
  }
}

function renderHtml(model) {
  const { narrative, maps, manifest, journeyStore } = model
  return `<!doctype html>
<html lang="zh-CN" data-theme="paper">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(narrative.title)} · Product Maps</title>
  <style>${styles()}</style>
</head>
<body>
  <a class="skip-link" href="#content">跳到主要内容</a>
  <header class="masthead">
    <div class="masthead__rail" aria-label="发布状态">
      <span class="eyebrow">Governed frontend understanding</span>
      <span class="support-line">Support level · <code>${escapeHtml(maps.application.supportLevel)}</code></span>
      <span class="status-line"><span class="status-dot" aria-hidden="true"></span> 验证通过 · ${escapeHtml(manifest.snapshotId)}</span>
    </div>
    <div class="masthead__body">
      <div>
        <p class="kicker">Application · Experience · Runtime Flow · Change</p>
        <h1>${escapeHtml(narrative.title)}</h1>
      </div>
      <p class="lede">${escapeHtml(narrative.executiveSummary)}</p>
    </div>
    <div class="toolbar" aria-label="页面工具">
      <button class="tool-button" id="theme-toggle" type="button" aria-pressed="false">切换深色纸面</button>
      <span class="scope">前端范围 ${renderInlineList(maps.application.application.roots)}</span>
    </div>
  </header>

  <nav class="section-nav" aria-label="Product Map 导航">
    <a href="#application">01 Application</a>
    <a href="#experience">02 Experience</a>
    <a href="#runtime-flow">03 Runtime Flow</a>
    <a href="#change">04 Change</a>
    <a href="#limitations">05 未决与诊断</a>
    <a href="#provenance">06 溯源</a>
  </nav>

  <main id="content">
    ${renderApplication(maps.application, narrative.applicationSummary)}
    ${renderExperience(maps.experience, narrative.experienceSummary, model)}
    ${renderRuntimeFlow(maps.runtimeFlow, narrative.runtimeFlowSummary, model)}
    ${renderChange(maps.change, narrative.changeSummary)}
    ${renderLimitations(model)}
    ${renderProvenance(model)}
  </main>

  <footer>
    <span>${escapeHtml(HTML_SCHEMA)}</span>
    <span>生成 ${escapeHtml(model.generatedAt)}</span>
  </footer>
  <script>${clientScript()}</script>
</body>
</html>`
}

function renderApplication(map, summary) {
  const app = map.application
  const boundaryOrder = [
    ['state', 'State ownership / data flow'],
    ['api', 'API / client'],
    ['auth', 'Auth / permission'],
    ['buildDeploy', 'Build / deploy'],
    ['testQuality', 'Testing / quality'],
  ]
  return `<section class="map-section" id="application" aria-labelledby="application-title">
    ${sectionHeader('01', 'Application Map', summary, map.mapId, 'application-title')}
    <div class="application-lead">
      <dl class="identity-grid">
        ${dataPair('应用形态', app.kind)}
        ${dataPair('Framework', app.framework)}
        ${dataPair('Bundler', app.bundler)}
        ${dataPair('根范围', app.roots.join(' · ') || '空')}
      </dl>
      <div class="bootstrap-chain" aria-label="启动链">
        ${renderAnchorNode('浏览器启动', app.bootstrap.entityId, app.bootstrap.sourcePath, app.bootstrap.confidence, app.bootstrap.evidenceIds)}
        <span class="chain-arrow" aria-hidden="true">→</span>
        ${renderAnchorNode('应用根', app.applicationRoot.entityId, app.applicationRoot.sourcePath, app.applicationRoot.confidence, app.applicationRoot.evidenceIds)}
      </div>
    </div>

    <div class="subsection">
      <h3>Route · Layout · Page</h3>
      <div class="three-columns">
        ${renderIdColumn('Routes', map.routeLayoutPages.routeIds)}
        ${renderIdColumn('Layouts', map.routeLayoutPages.layoutIds)}
        ${renderIdColumn('Pages', map.routeLayoutPages.pageIds)}
      </div>
    </div>

    <div class="subsection">
      <h3>工程边界</h3>
      <div class="boundary-grid">
        ${boundaryOrder.map(([key, label]) => renderBoundary(label, map.boundaries[key])).join('')}
      </div>
    </div>

    ${renderBlockedDimensions(map.blockedDimensions, 'Application Map 阻塞维度')}
    <div class="details-row">
      ${renderEntityDetails(map.entities)}
      ${renderRelationDetails(map.relations)}
    </div>
  </section>`
}

function renderExperience(map, summary, model) {
  return `<section class="map-section" id="experience" aria-labelledby="experience-title">
    ${sectionHeader('02', 'Experience Map', summary, map.mapId, 'experience-title')}
    <div class="journey-stack">
      ${map.journeys.map((journey, index) => renderJourney(journey, index, model)).join('') || emptyState('没有发布 Journey。')}
    </div>
    ${map.semanticClaims.length ? `<div class="subsection">
      <h3>已接受的语义 Claim</h3>
      <div class="claim-list">${map.semanticClaims.map(renderSemanticClaim).join('')}</div>
    </div>` : ''}
    ${renderBlockedDimensions(map.blockedDimensions, 'Experience Map 阻塞维度')}
  </section>`
}

function renderJourney(journey, index, model) {
  const closure = model.closureByJourney.get(journey.journeyId)
  const narrative = model.narrativeByJourney.get(journey.journeyId)
  const status = closure?.status || journey.status
  return `<article class="journey" aria-labelledby="journey-${index}-title">
    <div class="journey__head">
      <div>
        <span class="index-mark">J${String(index + 1).padStart(2, '0')}</span>
        <h3 id="journey-${index}-title">${escapeHtml(journey.title)}</h3>
        <p class="journey__goal"><strong>${escapeHtml(journey.actor)}</strong> · ${escapeHtml(journey.goal)}</p>
      </div>
      <div class="state-stack">
        ${statusBadge(status)}
        <span class="criticality">${escapeHtml(journey.criticality)}</span>
      </div>
    </div>
    ${narrative ? `<p class="narrative-note">${escapeHtml(narrative.summary)}</p>` : ''}
    <dl class="journey-meta">
      ${dataPair('触发', `${journey.trigger.kind} · ${journey.trigger.description}`)}
      ${dataPair('入口', joinPresent([journey.entry.routeId, journey.entry.pageId, journey.entry.sourcePath]))}
      ${dataPair('成功结果', journey.successOutcome.description)}
      ${dataPair('闭合率', closure ? formatPercent(closure.metrics.closureRate) : '未提供')}
    </dl>
    <ol class="journey-steps" aria-label="${escapeAttribute(journey.title)} 步骤">
      ${journey.steps.map(step => `<li data-step-order="${step.order}">
        <span class="step-number">${step.order}</span>
        <div><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.description)}</p>${renderRefs(step.evidenceIds, '证据')}</div>
        ${step.blocking ? '<span class="blocking-mark">阻塞步骤</span>' : ''}
      </li>`).join('')}
    </ol>
    ${journey.branches.length ? `<div class="branch-table" role="list" aria-label="Journey branches">
      ${journey.branches.map(branch => `<div class="branch branch--${safeToken(branch.kind)}" role="listitem">
        <span class="branch__kind">${escapeHtml(BRANCH_LABELS[branch.kind] || branch.kind)}</span>
        <span>${escapeHtml(branch.fromStepId)} → ${escapeHtml(branch.nextStepId || '结束')}</span>
        <strong>${escapeHtml(branch.condition)}</strong>
        ${renderRefs(branch.evidenceIds, '证据')}
      </div>`).join('')}
    </div>` : ''}
    <div class="journey-outcomes">
      ${renderOutcomeGroup('可见反馈', journey.visibleFeedback.map(item => `${item.kind}: ${item.description}`))}
      ${renderOutcomeGroup('失败结果', journey.failureOutcomes.map(item => item.description))}
    </div>
    ${renderRefs(journey.evidenceIds, 'Journey 证据')}
  </article>`
}

function renderRuntimeFlow(map, summary, model) {
  return `<section class="map-section" id="runtime-flow" aria-labelledby="runtime-flow-title">
    ${sectionHeader('03', 'Runtime Flow Map', summary, map.mapId, 'runtime-flow-title')}
    <div class="flow-stack">
      ${map.flows.map((flow, index) => renderFlow(flow, index, model)).join('') || emptyState('没有已绑定 Runtime Flow。')}
    </div>
    ${map.unboundJourneyIds.length ? `<div class="notice notice--blocked"><strong>未绑定 Journey</strong>${renderInlineList(map.unboundJourneyIds)}</div>` : ''}
    ${renderBlockedDimensions(map.blockedDimensions, 'Runtime Flow 阻塞维度')}
  </section>`
}

function renderFlow(flow, index, model) {
  const definition = model.journeyStore.definitions.find(item => item.journeyId === flow.journeyId)
  const svgId = `flow-svg-${index}`
  return `<article class="runtime-flow" aria-labelledby="flow-${index}-title">
    <div class="runtime-flow__head">
      <div>
        <span class="index-mark">FLOW ${String(index + 1).padStart(2, '0')}</span>
        <h3 id="flow-${index}-title">${escapeHtml(definition?.title || flow.journeyId)}</h3>
        <p class="artifact-id">${escapeHtml(flow.flowId)}</p>
      </div>
      <div class="flow-actions">
        ${statusBadge(flow.status)}
        <button class="export-button" type="button" data-svg-target="${svgId}" data-download="${escapeAttribute(fileSafeName(flow.journeyId))}.svg">导出 SVG</button>
      </div>
    </div>
    <div class="flow-canvas" tabindex="0" aria-label="${escapeAttribute(definition?.title || flow.journeyId)} runtime flow 图">
      ${renderFlowSvg(flow, svgId)}
    </div>
    <ol class="runtime-steps" aria-label="Runtime binding 明细">
      ${flow.steps.map(step => `<li class="runtime-step runtime-step--${safeToken(step.status)}" data-runtime-order="${step.order}">
        <span class="runtime-step__order">${String(step.order).padStart(2, '0')}</span>
        <div class="runtime-step__body">
          <div><strong>${escapeHtml(step.kind)}</strong> ${statusBadge(step.status)}</div>
          <p>${escapeHtml(step.entityId)}</p>
          ${step.sourcePath ? `<code>${escapeHtml(step.sourcePath)}</code>` : ''}
          <div class="trace-row"><span>置信 ${formatPercent(step.confidence)}</span>${step.branchId ? `<span>branch ${escapeHtml(step.branchId)}</span>` : ''}</div>
          ${renderRefs(step.evidenceIds, '证据')}
          ${renderRefs(step.claimIds, 'Claim')}
        </div>
      </li>`).join('')}
    </ol>
    ${flow.transitions.length ? `<details class="data-details"><summary>Transitions · ${flow.transitions.length}</summary>
      <div class="relation-list">${flow.transitions.map(renderRelation).join('')}</div>
    </details>` : ''}
    ${definition?.branches?.length ? `<div class="runtime-branches"><h4>Journey branches</h4>${definition.branches.map(branch => `<p><span class="branch-tag branch-tag--${safeToken(branch.kind)}">${escapeHtml(BRANCH_LABELS[branch.kind] || branch.kind)}</span> ${escapeHtml(branch.fromStepId)} → ${escapeHtml(branch.nextStepId || '结束')} · ${escapeHtml(branch.condition)}</p>`).join('')}</div>` : ''}
  </article>`
}

function renderFlowSvg(flow, svgId) {
  const itemWidth = 156
  const itemGap = 34
  const width = Math.max(720, 32 + flow.steps.length * (itemWidth + itemGap))
  const height = 184
  const idToIndex = new Map(flow.steps.map((item, index) => [item.runtimeStepId, index]))
  const lines = flow.transitions.map(transition => {
    const fromIndex = idToIndex.get(transition.from)
    const toIndex = idToIndex.get(transition.to)
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return ''
    const x1 = 32 + fromIndex * (itemWidth + itemGap) + itemWidth
    const x2 = 32 + toIndex * (itemWidth + itemGap)
    const branchClass = transition.branchId ? ' svg-link--branch' : ''
    return `<path class="svg-link${branchClass}" d="M ${x1} 84 C ${x1 + 18} 84, ${x2 - 18} 84, ${x2} 84"/><text class="svg-link-label" x="${(x1 + x2) / 2}" y="70" text-anchor="middle">${escapeHtml(clip(transition.type, 18))}</text>`
  }).join('')
  const nodes = flow.steps.map((step, index) => {
    const x = 32 + index * (itemWidth + itemGap)
    return `<g class="svg-node svg-node--${safeToken(step.status)}" transform="translate(${x} 42)">
      <rect width="${itemWidth}" height="84" rx="0"/>
      <text class="svg-order" x="12" y="20">${String(step.order).padStart(2, '0')}</text>
      <text class="svg-kind" x="12" y="42">${escapeHtml(clip(step.kind, 20))}</text>
      <text class="svg-entity" x="12" y="64">${escapeHtml(clip(step.entityId, 22))}</text>
      ${step.branchId ? `<text class="svg-branch" x="12" y="78">${escapeHtml(clip(step.branchId, 22))}</text>` : ''}
    </g>`
  }).join('')
  return `<svg id="${svgId}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Ordered runtime flow"><style>
    .svg-link{fill:none;stroke:#6f685e;stroke-width:1.5}.svg-link--branch{stroke:#a22f32;stroke-dasharray:5 4}.svg-link-label{fill:#6f685e;font:9px sans-serif}.svg-node rect{fill:#f4f0e7;stroke:#29251f;stroke-width:1}.svg-node--candidate rect{stroke:#9a681a;stroke-dasharray:5 3}.svg-node--conflicted rect,.svg-node--missing rect{stroke:#a22f32;stroke-width:2}.svg-order{fill:#9b4432;font:10px sans-serif}.svg-kind{fill:#29251f;font:bold 12px sans-serif}.svg-entity,.svg-branch{fill:#6f685e;font:8px monospace}.svg-branch{fill:#a22f32}
  </style>${lines}${nodes}</svg>`
}

function renderChange(map, summary) {
  return `<section class="map-section" id="change" aria-labelledby="change-title">
    ${sectionHeader('04', 'Change Map', summary, map.mapId, 'change-title')}
    <div class="change-stack">
      ${map.changeSets.map((changeSet, index) => renderChangeSet(changeSet, index)).join('') || emptyState('没有发布 Change Set。')}
    </div>
    ${renderBlockedDimensions(map.blockedDimensions, 'Change Map 阻塞维度')}
  </section>`
}

function renderChangeSet(changeSet, index) {
  const surfaces = [
    ['state', 'State'],
    ['api', 'API'],
    ['auth', 'Auth'],
    ['tests', 'Tests'],
    ['buildDeploy', 'Build / deploy'],
  ]
  return `<article class="change-set">
    <div class="change-set__head">
      <span class="index-mark">变更 ${String(index + 1).padStart(2, '0')}</span>
      <h3>${escapeHtml(changeSet.subjectId)}</h3>
      ${changeSet.sourcePath ? `<code>${escapeHtml(changeSet.sourcePath)}</code>` : ''}
      <span class="confidence">置信 ${formatPercent(changeSet.confidence)}</span>
    </div>
    <div class="impact-grid">
      ${renderImpact('反向依赖', changeSet.reverseDependencies)}
      ${renderImpact('影响 Routes', changeSet.impactedRouteIds)}
      ${renderImpact('影响 Pages', changeSet.impactedPageIds)}
      ${renderImpact('影响 Journeys', changeSet.impactedJourneyIds)}
    </div>
    <div class="surface-strip">
      ${surfaces.map(([key, label]) => `<div><strong>${escapeHtml(label)}</strong>${renderValueList(changeSet.impactedSurfaces[key])}</div>`).join('')}
    </div>
    ${renderBlockedDimensions(changeSet.blockedDimensions, '该变更项的阻塞维度')}
  </article>`
}

function renderLimitations(model) {
  return `<section class="map-section limitations" id="limitations" aria-labelledby="limitations-title">
    ${sectionHeader('05', '未决问题与确定性诊断', '公开不确定性，不用生成器推断补齐。', 'governance-status', 'limitations-title')}
    <div class="governance-grid">
      <div class="governance-column">
        <h3>OpenQuestion / limitation</h3>
        ${model.questions.map(renderQuestionLimitation).join('') || emptyState('没有未决语义、运行时或产品意图问题。')}
        ${model.journeyLimitations.map(renderJourneyLimitation).join('')}
      </div>
      <div class="governance-column">
        <h3>Deterministic diagnostics</h3>
        ${model.diagnostics.map(renderDiagnostic).join('') || emptyState('没有确定性诊断。')}
      </div>
    </div>
  </section>`
}

function renderQuestionLimitation(item) {
  const category = QUESTION_CATEGORIES[item.category]
  const blocked = item.category === 'runtime' || item.category === 'product-intent'
  return `<article class="governance-item governance-item--${blocked ? 'blocked' : 'open'}">
    <div class="governance-item__head"><span>${escapeHtml(QUESTION_LABELS[item.category])}</span><strong>${blocked ? 'BLOCKED' : 'UNRESOLVED'}</strong></div>
    <p>${escapeHtml(item.summary)}</p>
    <div class="trace-row"><span>${escapeHtml(category)}</span>${renderInlineList(item.questionIds)}</div>
    ${renderRefs(item.evidenceRefs, '证据')}
    ${renderRefs(item.mapDimensions, 'Map 维度')}
    ${renderRefs(item.journeyIds, 'Journey')}
  </article>`
}

function renderJourneyLimitation(item) {
  return `<article class="governance-item governance-item--open">
    <div class="governance-item__head"><span>Journey closure</span><strong>OPEN</strong></div>
    <p>${escapeHtml(item.summary)}</p>
    ${renderRefs(item.journeyIds, 'Journey')}
    ${renderRefs(item.evidenceRefs, '证据')}
  </article>`
}

function renderDiagnostic(item) {
  return `<article class="diagnostic diagnostic--${safeToken(item.severity)}">
    <div><span>${escapeHtml(item.severity.toUpperCase())}</span><code>${escapeHtml(item.id)}</code></div>
    <p>${escapeHtml(item.summary)}</p>
    ${item.sourcePath ? `<code>${escapeHtml(item.sourcePath)}</code>` : ''}
    ${renderRefs(item.evidenceRefs, '证据')}
  </article>`
}

function renderProvenance(model) {
  const { manifest, narrative, journeyStore } = model
  return `<section class="map-section provenance" id="provenance" aria-labelledby="provenance-title">
    ${sectionHeader('06', '溯源与发布指纹', '每个公开区域均指向同一 snapshot 与 projectionKey。', 'projections/manifest.json', 'provenance-title')}
    <dl class="fingerprint-grid">
      ${dataPair('Snapshot', manifest.snapshotId)}
      ${dataPair('Static graph hash', manifest.projectionKey.staticGraphHash)}
      ${dataPair('Accepted Claim set', manifest.projectionKey.acceptedClaimSetHash)}
      ${dataPair('Journey set', manifest.projectionKey.journeySetHash)}
      ${dataPair('Investigation frame', manifest.projectionKey.investigationFrameHash)}
      ${dataPair('Projection generator', manifest.projectionKey.projectionGeneratorVersion)}
    </dl>
    <div class="artifact-table" role="table" aria-label="Product Map artifacts">
      ${MAP_KEYS.map(key => {
        const entry = manifest.projections[key]
        return `<div class="artifact-row" role="row"><strong role="cell">${escapeHtml(key)}</strong><code role="cell">${escapeHtml(entry.path)}</code><code role="cell">sha256:${escapeHtml(entry.contentHash)}</code></div>`
      }).join('')}
      <div class="artifact-row" role="row"><strong role="cell">journeys</strong><code role="cell">store/journeys/manifest.json</code><code role="cell">sha256:${escapeHtml(journeyStore.manifest.journeySetHash)}</code></div>
      <div class="artifact-row" role="row"><strong role="cell">narrative</strong><code role="cell">synthesis/narrative.json</code><code role="cell">${escapeHtml(narrative.schemaVersion)} · ${escapeHtml(narrative.generatedAt)}</code></div>
    </div>
  </section>`
}

function sectionHeader(number, title, summary, artifactId, id) {
  return `<header class="section-heading">
    <span class="section-number">${escapeHtml(number)}</span>
    <div><h2 id="${escapeAttribute(id)}">${escapeHtml(title)}</h2><p>${escapeHtml(summary)}</p></div>
    <code>${escapeHtml(artifactId)}</code>
  </header>`
}

function renderAnchorNode(label, entityId, sourcePath, confidence, evidenceIds) {
  return `<div class="anchor-node">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(entityId || '未绑定')}</strong>
    ${sourcePath ? `<code>${escapeHtml(sourcePath)}</code>` : ''}
    <small>置信 ${formatPercent(confidence)}</small>
    ${renderRefs(evidenceIds, '证据')}
  </div>`
}

function renderIdColumn(label, values) {
  return `<div class="id-column"><h4>${escapeHtml(label)} <span>${values.length}</span></h4>${renderValueList(values)}</div>`
}

function renderBoundary(label, surfaces) {
  return `<article class="boundary"><h4>${escapeHtml(label)} <span>${surfaces.length}</span></h4>
    ${surfaces.map(surface => `<div class="surface"><strong>${escapeHtml(surface.kind)}</strong>${surface.sourcePath ? `<code>${escapeHtml(surface.sourcePath)}</code>` : ''}${renderRefs(surface.evidenceIds, '证据')}${renderRefs(surface.claimIds, 'Claim')}</div>`).join('') || '<p class="empty-inline">未发布条目</p>'}
  </article>`
}

function renderEntityDetails(entities) {
  return `<details class="data-details"><summary>Entities · ${entities.length}</summary>
    <div class="entity-list">${entities.map(entity => `<article><div><strong>${escapeHtml(entity.label)}</strong><span>${escapeHtml(entity.kind)}</span></div><code>${escapeHtml(entity.entityId)}</code>${entity.sourcePath ? `<code>${escapeHtml(entity.sourcePath)}</code>` : ''}<div class="trace-row"><span>置信 ${formatPercent(entity.confidence)}</span>${renderInlineList(entity.claimIds)}</div>${renderRefs(entity.evidenceIds, '证据')}</article>`).join('')}</div>
  </details>`
}

function renderRelationDetails(relations) {
  return `<details class="data-details"><summary>Relations · ${relations.length}</summary>
    <div class="relation-list">${relations.map(renderRelation).join('')}</div>
  </details>`
}

function renderRelation(relation) {
  return `<article><div><span>${escapeHtml(relation.from)}</span><strong>${escapeHtml(relation.type)}</strong><span>${escapeHtml(relation.to)}</span></div><div class="trace-row"><span>置信 ${formatPercent(relation.confidence)}</span>${relation.branchId ? `<span>branch ${escapeHtml(relation.branchId)}</span>` : ''}${relation.order ? `<span>order ${relation.order}</span>` : ''}</div>${renderRefs(relation.evidenceIds, '证据')}${renderRefs(relation.claimIds, 'Claim')}</article>`
}

function renderSemanticClaim(claim) {
  return `<article><div><code>${escapeHtml(claim.claimId)}</code><span class="confidence">置信 ${formatPercent(claim.confidence)}</span></div><p><strong>${escapeHtml(claim.subject)}</strong> <span>${escapeHtml(claim.predicate)}</span> <strong>${escapeHtml(renderObject(claim.object))}</strong></p>${renderRefs(claim.evidenceIds, '证据')}</article>`
}

function renderBlockedDimensions(items, label) {
  if (!items.length) return ''
  return `<aside class="blocked-dimensions" aria-label="${escapeAttribute(label)}"><h4>${escapeHtml(label)}</h4>${items.map(item => `<div><strong>${escapeHtml(item.dimension)}</strong><p>${escapeHtml(item.reason)}</p>${renderRefs(item.ambiguityIds, 'Ambiguity')}</div>`).join('')}</aside>`
}

function renderOutcomeGroup(label, values) {
  return `<div><strong>${escapeHtml(label)}</strong>${renderValueList(values)}</div>`
}

function renderImpact(label, values) {
  return `<div><strong>${escapeHtml(label)}</strong><span>${values.length}</span>${renderValueList(values)}</div>`
}

function renderValueList(values) {
  if (!values?.length) return '<p class="empty-inline">无</p>'
  return `<ul class="value-list">${values.map(value => `<li>${escapeHtml(renderObject(value))}</li>`).join('')}</ul>`
}

function renderRefs(values, label) {
  if (!values?.length) return ''
  return `<div class="refs"><span>${escapeHtml(label)}</span>${values.map(value => `<code>${escapeHtml(value)}</code>`).join('')}</div>`
}

function renderInlineList(values) {
  if (!values?.length) return '<span class="inline-empty">无</span>'
  return values.map(value => `<code>${escapeHtml(value)}</code>`).join(' ')
}

function statusBadge(status) {
  const safe = safeToken(status)
  return `<span class="status-badge status-badge--${safe}">${escapeHtml(STATUS_LABELS[status] || status || '未知')}</span>`
}

function dataPair(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? '未提供')}</dd></div>`
}

function emptyState(message) {
  return `<p class="empty-state">${escapeHtml(message)}</p>`
}

function styles() {
  return `
:root {
  color-scheme: light;
  --paper: oklch(96.8% 0.012 86);
  --paper-deep: oklch(92.5% 0.018 83);
  --ink: oklch(20% 0.018 78);
  --muted: oklch(45% 0.018 78);
  --line: oklch(78% 0.022 80);
  --accent: oklch(44% 0.13 35);
  --accent-soft: oklch(91% 0.035 35);
  --ok: oklch(44% 0.09 151);
  --warn: oklch(54% 0.13 70);
  --danger: oklch(48% 0.16 28);
  --code: oklch(31% 0.022 77);
  --serif: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, serif;
  --sans: "Avenir Next", Avenir, "Century Gothic", sans-serif;
  --mono: "SFMono-Regular", Menlo, Consolas, monospace;
}
html[data-theme="ink"] {
  color-scheme: dark;
  --paper: oklch(21% 0.018 76);
  --paper-deep: oklch(25% 0.019 76);
  --ink: oklch(92% 0.014 84);
  --muted: oklch(72% 0.018 82);
  --line: oklch(39% 0.022 78);
  --accent: oklch(72% 0.13 45);
  --accent-soft: oklch(30% 0.05 35);
  --ok: oklch(72% 0.11 151);
  --warn: oklch(76% 0.12 76);
  --danger: oklch(70% 0.15 28);
  --code: oklch(83% 0.018 83);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); font-size: 15px; line-height: 1.55; }
button, a { font: inherit; }
a { color: currentColor; }
code { color: var(--code); font-family: var(--mono); font-size: .78rem; overflow-wrap: anywhere; }
.skip-link { position: fixed; z-index: 50; top: 8px; left: 8px; padding: 8px 12px; background: var(--ink); color: var(--paper); transform: translateY(-150%); }
.skip-link:focus { transform: translateY(0); }
.masthead { padding: clamp(24px, 5vw, 72px) clamp(18px, 6vw, 92px) 28px; border-bottom: 1px solid var(--ink); }
.masthead__rail, .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.eyebrow, .kicker, .index-mark, .section-number { letter-spacing: .15em; text-transform: uppercase; font-size: .69rem; font-weight: 700; }
.status-line, .support-line { color: var(--muted); font-size: .76rem; }
.status-dot { display: inline-block; width: 7px; height: 7px; margin-right: 4px; background: var(--ok); }
.masthead__body { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(280px, .7fr); align-items: end; gap: clamp(36px, 8vw, 140px); margin: clamp(48px, 8vw, 110px) 0 44px; }
.kicker { color: var(--accent); }
h1, h2, h3, h4, p { margin-top: 0; }
h1 { max-width: 900px; margin-bottom: 0; font-family: var(--serif); font-size: clamp(3rem, 8vw, 8rem); font-weight: 400; line-height: .88; letter-spacing: -.055em; }
.lede { margin: 0; color: var(--muted); font-family: var(--serif); font-size: clamp(1.1rem, 2vw, 1.5rem); line-height: 1.45; }
.toolbar { border-top: 1px solid var(--line); padding-top: 16px; }
.tool-button, .export-button { border: 1px solid var(--ink); border-radius: 0; background: transparent; color: var(--ink); padding: 8px 12px; cursor: pointer; }
.tool-button:hover, .export-button:hover, .tool-button:focus-visible, .export-button:focus-visible { background: var(--ink); color: var(--paper); outline: none; }
.scope { color: var(--muted); font-size: .78rem; }
.section-nav { position: sticky; z-index: 20; top: 0; display: flex; gap: 0; overflow-x: auto; background: var(--paper); border-bottom: 1px solid var(--line); }
.section-nav a { flex: 0 0 auto; padding: 13px clamp(16px, 2vw, 30px); border-right: 1px solid var(--line); text-decoration: none; font-size: .75rem; letter-spacing: .04em; }
.section-nav a:hover, .section-nav a:focus-visible { background: var(--ink); color: var(--paper); outline: none; }
main { width: min(1500px, 100%); margin: 0 auto; }
.map-section { padding: clamp(58px, 9vw, 130px) clamp(18px, 6vw, 92px); border-bottom: 1px solid var(--ink); container-type: inline-size; }
.section-heading { display: grid; grid-template-columns: 54px minmax(0, 1fr) minmax(180px, .45fr); gap: clamp(18px, 4vw, 60px); align-items: start; margin-bottom: clamp(44px, 7vw, 96px); }
.section-number { color: var(--accent); }
.section-heading h2 { margin-bottom: 12px; font-family: var(--serif); font-size: clamp(2.2rem, 5vw, 5.8rem); font-weight: 400; line-height: .98; letter-spacing: -.04em; }
.section-heading p { max-width: 720px; margin-bottom: 0; color: var(--muted); font-size: 1.02rem; }
.section-heading > code { text-align: right; }
.application-lead { display: grid; grid-template-columns: .75fr 1.4fr; gap: clamp(30px, 6vw, 90px); align-items: start; }
.identity-grid, .fingerprint-grid, .journey-meta { margin: 0; }
.identity-grid > div, .fingerprint-grid > div, .journey-meta > div { display: grid; grid-template-columns: minmax(100px, .45fr) 1fr; gap: 18px; padding: 10px 0; border-top: 1px solid var(--line); }
dt { color: var(--muted); font-size: .75rem; }
dd { margin: 0; overflow-wrap: anywhere; }
.bootstrap-chain { display: grid; grid-template-columns: minmax(0, 1fr) 32px minmax(0, 1fr); align-items: center; }
.anchor-node { min-height: 210px; padding: 24px; border: 1px solid var(--ink); display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
.anchor-node > span { color: var(--accent); font-size: .75rem; }
.anchor-node > strong { font-family: var(--serif); font-size: clamp(1.2rem, 2.5vw, 2rem); line-height: 1.15; overflow-wrap: anywhere; }
.anchor-node small { color: var(--muted); }
.chain-arrow { text-align: center; font-size: 1.5rem; }
.subsection { margin-top: clamp(52px, 8vw, 100px); }
.subsection > h3, .governance-column > h3 { padding-bottom: 12px; border-bottom: 1px solid var(--ink); font-size: .78rem; letter-spacing: .12em; text-transform: uppercase; }
.three-columns, .boundary-grid, .journey-outcomes, .details-row, .impact-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.id-column, .boundary, .journey-outcomes > div, .impact-grid > div { background: var(--paper); padding: clamp(16px, 2.5vw, 28px); }
.id-column h4, .boundary h4 { display: flex; justify-content: space-between; margin-bottom: 18px; font-size: .85rem; }
.id-column h4 span, .boundary h4 span { color: var(--accent); }
.boundary-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.surface { padding: 14px 0; border-top: 1px solid var(--line); display: grid; gap: 8px; }
.surface strong { font-size: .75rem; }
.value-list { list-style: none; margin: 0; padding: 0; }
.value-list li { padding: 7px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.empty-inline, .inline-empty { color: var(--muted); font-size: .78rem; }
.details-row { grid-template-columns: 1fr 1fr; margin-top: 42px; }
.data-details { background: var(--paper); }
.data-details summary { padding: 16px 18px; cursor: pointer; font-weight: 700; }
.data-details[open] summary { border-bottom: 1px solid var(--line); }
.entity-list article, .relation-list article { padding: 16px 18px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
.entity-list article > div:first-child, .relation-list article > div:first-child, .claim-list article > div:first-child { display: flex; justify-content: space-between; gap: 14px; }
.entity-list span { color: var(--muted); font-size: .73rem; }
.relation-list article > div:first-child { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; }
.relation-list article > div:first-child strong { color: var(--accent); text-align: center; font-size: .72rem; }
.relation-list article > div:first-child span:last-child { text-align: right; }
.blocked-dimensions { margin-top: 42px; border: 1px solid var(--danger); }
.blocked-dimensions > h4 { margin: 0; padding: 11px 16px; background: var(--danger); color: var(--paper); font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; }
.blocked-dimensions > div { padding: 16px; border-top: 1px solid var(--danger); }
.blocked-dimensions p { margin: 6px 0; }
.journey-stack, .flow-stack, .change-stack { display: grid; gap: clamp(60px, 9vw, 120px); }
.journey { border-top: 2px solid var(--ink); }
.journey__head, .runtime-flow__head { display: flex; justify-content: space-between; gap: 24px; padding: 24px 0; }
.journey__head h3, .runtime-flow__head h3, .change-set__head h3 { margin: 6px 0; font-family: var(--serif); font-size: clamp(1.8rem, 3.5vw, 3.8rem); font-weight: 400; line-height: 1.08; }
.journey__goal, .artifact-id { color: var(--muted); }
.state-stack, .flow-actions { display: flex; align-items: flex-start; gap: 8px; }
.criticality, .confidence { color: var(--muted); font-size: .72rem; text-transform: uppercase; }
.narrative-note { max-width: 850px; padding-left: 22px; border-left: 2px solid var(--accent); color: var(--muted); font-family: var(--serif); font-size: 1.08rem; }
.journey-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 42px; margin: 30px 0; }
.journey-steps, .runtime-steps { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.journey-steps li { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; gap: 18px; padding: 22px 0; border-bottom: 1px solid var(--line); }
.step-number, .runtime-step__order { color: var(--accent); font-family: var(--serif); font-size: 1.5rem; }
.journey-steps p { margin: 4px 0 0; color: var(--muted); }
.blocking-mark { align-self: start; color: var(--danger); font-size: .7rem; font-weight: 700; text-transform: uppercase; }
.branch-table { margin: 24px 0; border: 1px solid var(--line); }
.branch { display: grid; grid-template-columns: 90px minmax(160px, .4fr) 1fr; gap: 16px; padding: 12px 16px; border-top: 1px solid var(--line); }
.branch:first-child { border-top: 0; }
.branch__kind, .branch-tag { color: var(--accent); font-size: .72rem; font-weight: 700; text-transform: uppercase; }
.branch--failure .branch__kind, .branch--exit .branch__kind, .branch-tag--failure, .branch-tag--exit { color: var(--danger); }
.branch--retry .branch__kind, .branch-tag--retry { color: var(--warn); }
.journey-outcomes { grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 34px 0; }
.claim-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--line); }
.claim-list article { padding: 20px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.claim-list p { margin: 14px 0; }
.status-badge { display: inline-block; padding: 3px 7px; border: 1px solid currentColor; font-size: .66rem; font-weight: 700; line-height: 1.3; text-transform: uppercase; white-space: nowrap; }
.status-badge--confirmed, .status-badge--closed { color: var(--ok); }
.status-badge--candidate, .status-badge--open { color: var(--warn); }
.status-badge--conflicted, .status-badge--missing, .status-badge--blocked { color: var(--danger); }
.flow-canvas { overflow-x: auto; margin: 8px 0 22px; border: 1px solid var(--line); background: var(--paper-deep); }
.flow-canvas:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.flow-canvas svg { display: block; font-family: var(--sans); }
.svg-link { fill: none; stroke: var(--muted); stroke-width: 1.5; }
.svg-link--branch { stroke: var(--danger); stroke-dasharray: 5 4; }
.svg-link-label { fill: var(--muted); font-size: 9px; }
.svg-node rect { fill: var(--paper); stroke: var(--ink); stroke-width: 1; }
.svg-node--candidate rect { stroke: var(--warn); stroke-dasharray: 5 3; }
.svg-node--conflicted rect, .svg-node--missing rect { stroke: var(--danger); stroke-width: 2; }
.svg-order { fill: var(--accent); font-size: 10px; }
.svg-kind { fill: var(--ink); font-size: 12px; font-weight: 700; }
.svg-entity, .svg-branch { fill: var(--muted); font-family: var(--mono); font-size: 8px; }
.svg-branch { fill: var(--danger); }
.runtime-steps { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--line); }
.runtime-step { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 14px; padding: 20px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.runtime-step--conflicted, .runtime-step--missing { background: color-mix(in oklch, var(--danger) 9%, var(--paper)); }
.runtime-step__body p { margin: 8px 0 2px; overflow-wrap: anywhere; }
.trace-row { display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: .72rem; }
.refs { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 8px; }
.refs > span { color: var(--muted); font-size: .65rem; letter-spacing: .06em; text-transform: uppercase; }
.refs code { padding: 2px 5px; background: var(--paper-deep); }
.runtime-branches { margin: 28px 0 0; padding: 18px; border: 1px solid var(--line); }
.runtime-branches h4 { font-size: .75rem; text-transform: uppercase; }
.runtime-branches p:last-child { margin-bottom: 0; }
.notice { margin-top: 34px; padding: 18px; border: 1px solid var(--line); }
.notice strong { margin-right: 12px; }
.notice--blocked { border-color: var(--danger); }
.change-set { border-top: 2px solid var(--ink); }
.change-set__head { position: relative; padding: 24px 180px 24px 0; }
.change-set__head .confidence { position: absolute; right: 0; top: 28px; }
.impact-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.impact-grid > div > strong { display: inline-block; margin-right: 8px; font-size: .78rem; }
.impact-grid > div > span { color: var(--accent); }
.surface-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin-top: 1px; gap: 1px; background: var(--line); border: 1px solid var(--line); }
.surface-strip > div { background: var(--paper); padding: 18px; }
.surface-strip > div > strong { font-size: .75rem; }
.governance-grid { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(36px, 6vw, 90px); }
.governance-item, .diagnostic { padding: 18px 0; border-bottom: 1px solid var(--line); }
.governance-item__head, .diagnostic > div:first-child { display: flex; justify-content: space-between; gap: 18px; color: var(--muted); font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; }
.governance-item--blocked .governance-item__head strong { color: var(--danger); }
.governance-item--open .governance-item__head strong { color: var(--warn); }
.governance-item p, .diagnostic p { margin: 10px 0; }
.diagnostic--error > div:first-child span { color: var(--danger); }
.diagnostic--warning > div:first-child span { color: var(--warn); }
.fingerprint-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 42px; }
.fingerprint-grid dd { font-family: var(--mono); font-size: .75rem; }
.artifact-table { margin-top: 48px; border-top: 1px solid var(--ink); }
.artifact-row { display: grid; grid-template-columns: 110px minmax(200px, .55fr) 1fr; gap: 18px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.empty-state { padding: 28px; border: 1px dashed var(--line); color: var(--muted); }
footer { display: flex; justify-content: space-between; gap: 18px; padding: 24px clamp(18px, 6vw, 92px); color: var(--muted); font-size: .72rem; }
@container (max-width: 920px) {
  .application-lead, .governance-grid { grid-template-columns: 1fr; }
  .boundary-grid, .surface-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .impact-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .masthead__body, .section-heading { grid-template-columns: 1fr; }
  .masthead__body { align-items: start; gap: 24px; margin: 54px 0 34px; }
  h1 { font-size: clamp(3rem, 17vw, 5.4rem); }
  .section-heading { gap: 12px; }
  .section-heading > code { text-align: left; }
  .toolbar, .masthead__rail { align-items: flex-start; flex-direction: column; }
  .bootstrap-chain { grid-template-columns: 1fr; gap: 12px; }
  .chain-arrow { transform: rotate(90deg); }
  .three-columns, .boundary-grid, .details-row, .runtime-steps, .claim-list, .impact-grid, .surface-strip, .fingerprint-grid { grid-template-columns: 1fr; }
  .journey__head, .runtime-flow__head { align-items: flex-start; flex-direction: column; }
  .journey-meta { grid-template-columns: 1fr; }
  .journey-steps li { grid-template-columns: 34px minmax(0, 1fr); }
  .blocking-mark { grid-column: 2; }
  .branch { grid-template-columns: 1fr; }
  .journey-outcomes { grid-template-columns: 1fr; }
  .change-set__head { padding-right: 0; }
  .change-set__head .confidence { position: static; display: block; margin-top: 12px; }
  .artifact-row { grid-template-columns: 1fr; gap: 4px; }
  footer { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
@media print {
  .toolbar, .section-nav, .export-button { display: none; }
  .map-section { break-before: page; }
  body { background: white; color: black; }
}`
}

function clientScript() {
  return `
(() => {
  const root = document.documentElement
  const toggle = document.getElementById('theme-toggle')
  let stored = null
  try { stored = localStorage.getItem('repo-human-theme') } catch {}
  if (stored === 'ink') {
    root.dataset.theme = 'ink'
    toggle.setAttribute('aria-pressed', 'true')
  }
  toggle.addEventListener('click', () => {
    const ink = root.dataset.theme !== 'ink'
    root.dataset.theme = ink ? 'ink' : 'paper'
    toggle.setAttribute('aria-pressed', String(ink))
    try { localStorage.setItem('repo-human-theme', root.dataset.theme) } catch {}
  })
  document.querySelectorAll('[data-svg-target]').forEach(button => {
    button.addEventListener('click', () => {
      const svg = document.getElementById(button.dataset.svgTarget)
      if (!svg) return
      const clone = svg.cloneNode(true)
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      const source = '<?xml version="1.0" encoding="UTF-8"?>\\n' + new XMLSerializer().serializeToString(clone)
      const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = button.dataset.download || 'runtime-flow.svg'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    })
  })
})()`
}

function readRequiredJson(packageDir, relativePath) {
  const filePath = resolveInside(packageDir, relativePath)
  if (!fs.existsSync(filePath)) throw new Error(`Missing required repo-understanding artifact: ${relativePath}`)
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid JSON in required repo-understanding artifact ${relativePath}: ${error.message}`)
  }
}

function resolveInside(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.length || path.isAbsolute(relativePath)) {
    throw new Error(`Artifact path must be package-relative: ${relativePath}`)
  }
  const resolved = path.resolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Artifact path escapes package: ${relativePath}`)
  return resolved
}

function hashCanonical(value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]))
  }
  return value
}

function deepEqual(left, right) {
  return hashCanonical(left) === hashCanonical(right)
}

function sameSet(left, right) {
  return new Set(left).size === new Set(right).size && [...new Set(left)].every(item => new Set(right).has(item))
}

function journeyCounts(entries) {
  return Object.fromEntries(['closed', 'open', 'blocked', 'candidate', 'invalidated'].map(status => [status, entries.filter(item => item.status === status).length]))
}

function questionCounts(limitations) {
  return Object.fromEntries(Object.entries(QUESTION_CATEGORIES).map(([category, publicName]) => [publicName, new Set(limitations.filter(item => item.category === category).flatMap(item => item.questionIds)).size]))
}

function formatPercent(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? `${Math.round(Math.max(0, Math.min(1, numeric)) * 100)}%` : '未提供'
}

function renderObject(value) {
  if (value === null || value === undefined) return '无'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function joinPresent(values) {
  return values.filter(Boolean).join(' · ') || '未绑定'
}

function safeToken(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
}

function fileSafeName(value) {
  return String(value || 'runtime-flow').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'runtime-flow'
}

function clip(value, length) {
  const text = String(value || '')
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeJourneyForMap(definition) {
  if (!definition) return null
  return {
    schemaVersion: definition.schemaVersion,
    journeyId: definition.journeyId,
    snapshotId: definition.snapshotId,
    title: definition.title,
    actor: definition.actor,
    goal: definition.goal,
    trigger: canonicalValue(definition.trigger),
    entry: canonicalValue(definition.entry),
    steps: [...definition.steps].sort((left, right) => left.order - right.order || left.stepId.localeCompare(right.stepId)).map(canonicalValue),
    branches: [...definition.branches].sort((left, right) => left.branchId.localeCompare(right.branchId)).map(canonicalValue),
    visibleFeedback: [...definition.visibleFeedback].sort((left, right) => left.feedbackId.localeCompare(right.feedbackId)).map(canonicalValue),
    successOutcome: canonicalValue(definition.successOutcome),
    failureOutcomes: [...definition.failureOutcomes].sort((left, right) => left.outcomeId.localeCompare(right.outcomeId)).map(canonicalValue),
    criticality: definition.criticality,
    status: definition.status,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    evidenceIds: [...new Set(definition.evidenceIds)].sort(),
    claimIds: [...new Set(definition.claimIds)].sort(),
  }
}

function escapeAttribute(value) {
  return escapeHtml(value)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
