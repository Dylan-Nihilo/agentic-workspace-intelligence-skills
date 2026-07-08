// Registry boundary: this module defines extension-axis nodes and derived data.
// Runtime tuning still belongs in harness.config.json explorers entries, where
// enabled and tokenBudget may override these structural defaults.

export const EXPLORER = Object.freeze({
  vueContainment: 'vue-containment',
  routeBinding: 'route-binding',
  authChain: 'auth-chain',
  dataAccess: 'data-access',
  callChain: 'call-chain',
  dynamicImport: 'dynamic-import',
  adversarialVerify: 'adversarial-verify',
  coverageDirected: 'coverage-directed',
})

export const EXPLORERS = Object.freeze({
  [EXPLORER.vueContainment]: {
    kind: 'path-routed',
    pathPattern: /\.vue$|components?|views?|pages?/i,
    tokenBudget: 12000,
    label: 'Vue 结构',
    inFactEnum: true,
  },
  [EXPLORER.routeBinding]: {
    kind: 'path-routed',
    pathPattern: /route|router|controller|mapping/i,
    tokenBudget: 12000,
    label: '路由绑定',
    inFactEnum: true,
  },
  [EXPLORER.authChain]: {
    kind: 'path-routed',
    pathPattern: /auth|security|permission|filter|interceptor|guard/i,
    tokenBudget: 14000,
    label: '权限链路',
    inFactEnum: true,
  },
  [EXPLORER.dataAccess]: {
    kind: 'path-routed',
    pathPattern: /dao|mapper|repository|entity|sql|datasource|redis|cache/i,
    tokenBudget: 16000,
    label: '数据访问',
    inFactEnum: true,
  },
  [EXPLORER.callChain]: {
    kind: 'path-routed',
    pathPattern: /client|facade|rpc|http|mq|kafka|rocket|queue|consumer|producer/i,
    tokenBudget: 18000,
    label: '调用链路',
    inFactEnum: true,
  },
  [EXPLORER.dynamicImport]: {
    kind: 'system',
    tokenBudget: 10000,
    label: '动态导入',
    inFactEnum: true,
  },
  [EXPLORER.adversarialVerify]: {
    kind: 'system',
    tokenBudget: 8000,
    label: '反向验证',
    inFactEnum: false,
  },
  [EXPLORER.coverageDirected]: {
    kind: 'system',
    tokenBudget: 10000,
    label: '覆盖导向',
    inFactEnum: false,
  },
})

export const PREDICATES = Object.freeze({
  imports: { zhLabel: '导入', protocolAnchor: 'imports' },
  'dynamic-imports': { zhLabel: '动态导入', protocolAnchor: 'dynamic-imports' },
  contains: { zhLabel: '包含', protocolAnchor: 'contains' },
  'depends-on': { zhLabel: '依赖', protocolAnchor: 'depends-on' },
  'routes-to': { zhLabel: '路由指向', protocolAnchor: 'routes-to' },
  registers: { zhLabel: '注册', protocolAnchor: 'registers' },
  calls: { zhLabel: '调用', protocolAnchor: 'calls' },
  'guarded-by': { zhLabel: '受保护于', protocolAnchor: 'guarded-by' },
  'reads-from': { zhLabel: '读取', protocolAnchor: 'reads-from' },
  'writes-to': { zhLabel: '写入', protocolAnchor: 'writes-to' },
  extends: { zhLabel: '继承', protocolAnchor: 'extends' },
  implements: { zhLabel: '实现', protocolAnchor: 'implements' },
})

export const PROJECTIONS = Object.freeze({
  'render-graph': { output: 'render-graph.json' },
  'knowledge-index': { output: 'knowledge-index.jsonl' },
  wiki: { output: 'wiki/' },
  html: { output: 'human-readable.html' },
})

export function assertKnownExplorers(config = {}, label = 'explorers config') {
  const unknown = Object.keys(config || {}).filter(name => !EXPLORERS[name])
  if (unknown.length) {
    throw new Error(`${label} contains unknown explorer(s): ${unknown.join(', ')}`)
  }
}

export function explorerEnabled(name, config = {}) {
  return Boolean(EXPLORERS[name]) && config?.[name]?.enabled !== false
}

export function explorerBudget(name, config = {}) {
  const override = Number(config?.[name]?.tokenBudget)
  if (Number.isFinite(override) && override > 0) return override
  return EXPLORERS[name]?.tokenBudget || EXPLORERS[EXPLORER.coverageDirected].tokenBudget
}

export function pickExplorerForPath(filePath) {
  const value = String(filePath || '')
  for (const [name, explorer] of Object.entries(EXPLORERS)) {
    if (explorer.kind === 'path-routed' && explorer.pathPattern.test(value)) return name
  }
  return EXPLORER.coverageDirected
}

export function validPredicateSet() {
  return new Set(Object.keys(PREDICATES))
}

export function factExplorerNames() {
  return Object.keys(EXPLORERS).filter(name => EXPLORERS[name].inFactEnum)
}

export function projectionNames() {
  return Object.keys(PROJECTIONS)
}
