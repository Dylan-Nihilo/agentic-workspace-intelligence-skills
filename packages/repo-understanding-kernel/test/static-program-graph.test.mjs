import assert from 'node:assert/strict'
import { fixtureGraph as graph } from './static-program-graph.smoke.mjs'

const homeSource = 'src/pages/Home.tsx'
const byKind = (kind, predicate = () => true) => graph.nodes.find(node => node.kind === kind && predicate(node))
const fromSource = sourcePath => node => node.source.sourcePath === sourcePath
const labelOrAttribute = (node, value, ...attributeNames) => {
  if (String(node.label).toLowerCase().includes(value.toLowerCase())) return true
  return attributeNames.some(name => String(node.attributes[name] || '').toLowerCase().includes(value.toLowerCase()))
}
const requireNode = (kind, predicate, message) => {
  const node = byKind(kind, predicate)
  assert.ok(node, message || `expected ${kind} node`)
  return node
}
const requireEdge = (type, from, to, message) => {
  const edge = graph.edges.find(candidate => (
    candidate.type === type
    && (!from || candidate.from === from.nodeId)
    && (!to || candidate.to === to.nodeId)
  ))
  assert.ok(edge, message || `expected ${type} edge from ${from?.nodeId || '*'} to ${to?.nodeId || '*'}`)
  return edge
}

const bootstrap = requireNode('bootstrap', fromSource('src/main.tsx'), 'createRoot must produce a bootstrap node')
const homeRoute = requireNode('route', node => node.attributes.routePath === '/', 'router config must produce the home route')
const layout = requireNode('layout', fromSource('src/layouts/AppLayout.tsx'))
const page = requireNode('page', fromSource(homeSource))
const button = requireNode('ui-element', node => fromSource(homeSource)(node) && labelOrAttribute(node, 'button', 'tagName', 'elementType'))
const click = requireNode('ui-event', node => fromSource(homeSource)(node) && labelOrAttribute(node, 'click', 'eventName', 'jsxAttribute'))
const handler = requireNode('handler', node => fromSource(homeSource)(node) && labelOrAttribute(node, 'handleCreateOrder', 'symbolName', 'handlerName'))
const status = requireNode('state', node => fromSource(homeSource)(node) && labelOrAttribute(node, 'status', 'stateName'))
const request = requireNode('request', fromSource(homeSource))
const endpoint = requireNode('endpoint', node => labelOrAttribute(node, '/api/orders', 'url', 'endpoint'))
const response = requireNode('response', fromSource(homeSource))
const feedback = requireNode('feedback-candidate', fromSource(homeSource))
const outcome = requireNode('outcome-candidate', fromSource(homeSource))
const authGuard = requireNode('auth-guard', fromSource('src/auth/RequireAuth.tsx'))
const buildWiring = requireNode('build-wiring', fromSource('vite.config.ts'))
const testWiring = requireNode('test-wiring', fromSource('src/pages/Home.test.tsx'))

assert.ok(graph.edges.some(edge => edge.type === 'registers-root' && (edge.from === bootstrap.nodeId || edge.to === bootstrap.nodeId)), 'bootstrap registration must be explicit')
assert.ok(graph.edges.some(edge => edge.type === 'uses-router' && (edge.from === bootstrap.nodeId || edge.to === bootstrap.nodeId)), 'bootstrap-to-router wiring must be explicit')
requireEdge('route-renders-page', homeRoute, page)
requireEdge('route-uses-layout', homeRoute, layout)
requireEdge('contains-ui-element', page, button)
requireEdge('emits-ui-event', button, click)
requireEdge('invokes-handler', click, handler)
requireEdge('mutates-state', handler, status)
requireEdge('issues-request', handler, request)
requireEdge('targets-endpoint', request, endpoint)
requireEdge('receives-response', endpoint, response)
requireEdge('produces-feedback-candidate', response, feedback)
requireEdge('produces-outcome-candidate', response, outcome)
requireEdge('guarded-by', homeRoute, authGuard)
assert.ok(graph.edges.some(edge => edge.type === 'configures-build' && (edge.from === buildWiring.nodeId || edge.to === buildWiring.nodeId)), 'Vite build wiring must be explicit')
requireEdge('configures-test', buildWiring, testWiring)

for (const item of [...graph.nodes, ...graph.edges]) {
  assertSourceProvenance(item.source, item.nodeId || item.edgeId)
}
for (const node of [bootstrap, homeRoute, layout, page, button, click, handler, status, request, endpoint, response, feedback, outcome, authGuard, buildWiring, testWiring]) {
  assert.ok(node.source.range, `${node.nodeId} must preserve an exact compiler range`)
}

function assertSourceProvenance(source, ownerId) {
  assert.ok(Object.hasOwn(source, 'range'), `${ownerId} source must include range`)
  assert.equal(typeof source.provider, 'string', `${ownerId} source must include parser/provider`)
  assert.ok(source.provider.length > 0, `${ownerId} source provider must not be empty`)
  assert.equal(typeof source.sourceKind, 'string', `${ownerId} source must include sourceKind`)
  assert.ok(source.sourceKind.length > 0, `${ownerId} sourceKind must not be empty`)
  assert.equal(typeof source.structureFingerprint, 'string', `${ownerId} source must include structureFingerprint`)
  assert.ok(source.structureFingerprint.length > 0, `${ownerId} structureFingerprint must not be empty`)
  if (!source.range) return
  for (const boundary of ['start', 'end']) {
    const position = source.range[boundary]
    assert.ok(Number.isInteger(position.offset) && position.offset >= 0, `${ownerId} ${boundary}.offset must be non-negative`)
    assert.ok(Number.isInteger(position.line) && position.line >= 1, `${ownerId} ${boundary}.line must be one-based`)
    assert.ok(Number.isInteger(position.column) && position.column >= 0, `${ownerId} ${boundary}.column must be non-negative`)
  }
  assert.ok(source.range.end.offset >= source.range.start.offset, `${ownerId} source range must be ordered`)
}
