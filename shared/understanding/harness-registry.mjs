// Registry boundary: this module defines extension-axis nodes and derived data.
// Runtime tuning still belongs in harness.config.json explorers entries, where
// enabled, tokenBudget, and effort may override these structural defaults.

export const EXPLORER = Object.freeze({
  vueContainment: 'vue-containment',
  componentStructure: 'component-structure',
  routeBinding: 'route-binding',
  runtimeConfig: 'runtime-config',
  authChain: 'auth-chain',
  dataAccess: 'data-access',
  callChain: 'call-chain',
  dependencyResolution: 'dependency-resolution',
  dynamicImport: 'dynamic-import',
  adversarialVerify: 'adversarial-verify',
  coverageDirected: 'coverage-directed',
})

export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high'])

export const EXPLORERS = Object.freeze({
  [EXPLORER.vueContainment]: {
    kind: 'legacy',
    pathPattern: /^$/,
    tokenBudget: 12000,
    effort: 'low',
    label: 'Vue 结构(legacy)',
    inFactEnum: true,
  },
  [EXPLORER.componentStructure]: {
    kind: 'path-routed',
    pathPattern: /\.vue$|\.jsx$|\.tsx$|(^|\/)(components?|views?|pages?|screens?)(\/|$)/i,
    tokenBudget: 12000,
    effort: 'low',
    label: '组件结构',
    inFactEnum: true,
  },
  [EXPLORER.routeBinding]: {
    kind: 'path-routed',
    pathPattern: /route|router|controller|mapping/i,
    tokenBudget: 12000,
    effort: 'low',
    label: '路由绑定',
    inFactEnum: true,
  },
  [EXPLORER.runtimeConfig]: {
    kind: 'path-routed',
    pathPattern: /runtimecfg|application\.(ya?ml|properties)$|bootstrap\.(ya?ml|properties)$|web\.xml$|(^|\/)(config|conf|resources)(\/|$)|\.(properties|ya?ml)$/i,
    tokenBudget: 12000,
    effort: 'medium',
    label: '运行配置',
    inFactEnum: true,
  },
  [EXPLORER.authChain]: {
    kind: 'path-routed',
    pathPattern: /auth|security|permission|filter|interceptor|guard/i,
    tokenBudget: 14000,
    effort: 'high',
    label: '权限链路',
    inFactEnum: true,
  },
  [EXPLORER.dataAccess]: {
    kind: 'path-routed',
    pathPattern: /dao|mapper|repository|entity|sql|datasource|redis|cache/i,
    tokenBudget: 16000,
    effort: 'medium',
    label: '数据访问',
    inFactEnum: true,
  },
  [EXPLORER.callChain]: {
    kind: 'path-routed',
    pathPattern: /client|facade|rpc|http|mq|kafka|rocket|queue|consumer|producer/i,
    tokenBudget: 18000,
    effort: 'high',
    label: '调用链路',
    inFactEnum: true,
  },
  [EXPLORER.dependencyResolution]: {
    kind: 'system',
    tokenBudget: 10000,
    effort: 'medium',
    label: '依赖解析',
    inFactEnum: true,
  },
  [EXPLORER.dynamicImport]: {
    kind: 'system',
    tokenBudget: 10000,
    effort: 'low',
    label: '动态导入',
    inFactEnum: true,
  },
  [EXPLORER.adversarialVerify]: {
    kind: 'system',
    tokenBudget: 8000,
    effort: 'high',
    label: '反向验证',
    inFactEnum: false,
  },
  [EXPLORER.coverageDirected]: {
    kind: 'system',
    tokenBudget: 10000,
    effort: 'medium',
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
  const invalidEfforts = Object.entries(config || {})
    .filter(([name, value]) => EXPLORERS[name] && value?.effort !== undefined && !EFFORT_LEVELS.includes(value.effort))
    .map(([name, value]) => `${name}=${String(value.effort)}`)
  if (invalidEfforts.length) {
    throw new Error(`${label} contains invalid effort override(s): ${invalidEfforts.join(', ')}`)
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

export function explorerEffort(name, config = {}) {
  const override = config?.[name]?.effort
  if (EFFORT_LEVELS.includes(override)) return override
  return EXPLORERS[name]?.effort || 'medium'
}

export function pickExplorerForPath(filePath, context = {}) {
  const value = String(filePath || '')
  const repoKind = context.profile?.repoKind || context.repoKind || context.scanPolicy?.repoKind || 'unknown'
  const frontendLikely = repoKind === 'frontend' || repoKind === 'fullstack' || /\.(vue|jsx|tsx)$/i.test(value)
  const routeLikely = EXPLORERS[EXPLORER.routeBinding].pathPattern.test(value)
  const authLikely = EXPLORERS[EXPLORER.authChain].pathPattern.test(value)
  const dataLikely = EXPLORERS[EXPLORER.dataAccess].pathPattern.test(value)
  const callLikely = EXPLORERS[EXPLORER.callChain].pathPattern.test(value)
  const runtimeLikely = EXPLORERS[EXPLORER.runtimeConfig].pathPattern.test(value)
  const componentLikely = frontendLikely && EXPLORERS[EXPLORER.componentStructure].pathPattern.test(value)
  if (authLikely) return EXPLORER.authChain
  if (dataLikely) return EXPLORER.dataAccess
  if (callLikely) return EXPLORER.callChain
  if (routeLikely) return EXPLORER.routeBinding
  if (runtimeLikely) return EXPLORER.runtimeConfig
  if (componentLikely) return EXPLORER.componentStructure
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
