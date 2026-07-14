const GENERATED_PATH_PATTERN = /(^|\/)(?:node_modules|dist|build|coverage|\.cache|\.next|\.nuxt|\.output|\.turbo|\.vite\/deps)(\/|$)/i
const SOURCE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?|vue)$/i
const FRONTEND_SOURCE_PATTERN = /\.(?:jsx|tsx|vue)$/i
const PACKAGE_MANIFEST_PATTERN = /(^|\/)package\.json$/i

const FRONTEND_DEPENDENCIES = new Set([
  '@angular/core',
  '@sveltejs/kit',
  'angular',
  'next',
  'nuxt',
  'preact',
  'react',
  'react-dom',
  'react-router',
  'react-router-dom',
  'solid-js',
  'svelte',
  'vue',
  'vue-router',
])

const FRONTEND_TOOLING_DEPENDENCIES = new Set([
  '@vitejs/plugin-react',
  '@vitejs/plugin-vue',
  '@vue/cli-service',
  'parcel',
  'rspack',
  'vite',
  'webpack',
])

const BACKEND_DEPENDENCY_PATTERN = /^(?:@nestjs\/|express$|fastify$|hapi$|koa$|nest(?:js)?$|spring|springframework|dubbo|hessian|django|fastapi|flask|gin-gonic|gorilla\/mux|go-chi|rails|sinatra|laravel|symfony|microsoft\.aspnetcore)/i
const BACKEND_MANIFEST_TYPES = new Set(['bundler', 'cargo', 'composer', 'dotnet', 'go', 'gradle', 'maven', 'python'])

export function normalizeCensusInput(value = {}) {
  const input = isObject(value) ? value : {}
  const schemaVersion = String(input.schemaVersion || '')
  return {
    input,
    snapshot: input.snapshot || (schemaVersion.startsWith('repo-snapshot/') ? input : {}),
    inventory: input.inventory || (schemaVersion.startsWith('repo-inventory/') ? input : {}),
    codeMap: input.codeMap || input.staticCodeMap || (schemaVersion.startsWith('repo-code-map/') ? input : {}),
    profile: input.profile || input.repoProfile || (schemaVersion.startsWith('repo-frontend-census-profile/') ? input : {}),
    scanPolicy: input.scanPolicy || {},
    staticProgramGraph: input.staticProgramGraph || input.programGraph || {},
  }
}

export function collectFrontendCensusSignals(value = {}) {
  const sources = normalizeCensusInput(value)
  const filePaths = collectFilePaths(sources)
  const manifests = collectManifests(sources)
  const dependencies = collectDependencies(sources, manifests)
  const frameworkNames = collectFrameworkNames(sources, dependencies, filePaths)
  const bundlerNames = collectBundlerNames(sources, dependencies, filePaths)
  const repoKindHints = collectRepoKindHints(sources)
  const packageRoots = collectPackageRoots(sources, manifests, dependencies, filePaths)
  const browserBootstrapCandidates = findBrowserBootstrapCandidates(filePaths)
  const frontendRoots = inferFrontendRoots({
    sources,
    filePaths,
    dependencies,
    frameworkNames,
    bundlerNames,
    packageRoots,
    browserBootstrapCandidates,
  })
  const backendRoots = inferBackendRoots({ sources, filePaths, manifests, dependencies })
  return {
    ...sources,
    filePaths,
    manifests,
    dependencies,
    frameworkNames,
    bundlerNames,
    repoKindHints,
    packageRoots,
    browserBootstrapCandidates,
    frontendRoots,
    backendRoots,
    hasStrongFrontendEvidence: hasStrongFrontendEvidence({
      filePaths,
      frameworkNames,
      bundlerNames,
      browserBootstrapCandidates,
      frontendRoots,
    }),
    hasBackendEvidence: hasBackendEvidence({ filePaths, manifests, dependencies, backendRoots }),
  }
}

export function normalizeRepoPath(value) {
  if (typeof value !== 'string') return ''
  let normalized = value.trim().replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('evidence:') || normalized.startsWith('dependency:')) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return ''
  normalized = normalized.replace(/^\.\//, '').replace(/\/{2,}/g, '/')
  while (normalized.includes('/../')) normalized = normalized.replace(/(^|\/)[^/]+\/\.\.\//, '$1')
  return normalized === '' ? '.' : normalized.replace(/\/$/, '')
}

export function rootForFile(filePath) {
  const normalized = normalizeRepoPath(filePath)
  if (!normalized || normalized === '.' || !normalized.includes('/')) return '.'
  return normalized.slice(0, normalized.lastIndexOf('/')) || '.'
}

export function pathWithinRoot(filePath, root) {
  const file = normalizeRepoPath(filePath)
  const normalizedRoot = normalizeRepoPath(root) || '.'
  if (!file) return false
  return normalizedRoot === '.' || file === normalizedRoot || file.startsWith(`${normalizedRoot}/`)
}

export function uniqueSorted(values) {
  return [...new Set((values || []).map(normalizeScalar).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
}

export function stableToken(value) {
  let hash = 2166136261
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function generatedPath(filePath) {
  return GENERATED_PATH_PATTERN.test(normalizeRepoPath(filePath))
}

function collectFilePaths(sources) {
  const paths = []
  const add = value => {
    const filePath = normalizeRepoPath(typeof value === 'string' ? value : recordPath(value))
    if (filePath && !generatedPath(filePath)) paths.push(filePath)
  }
  for (const collection of [
    sources.input.files,
    sources.snapshot.files,
    sources.inventory.files,
    sources.codeMap.keyFiles,
    sources.codeMap.entrypoints,
    sources.codeMap.imports,
    sources.codeMap.routes,
    sources.codeMap.componentRefs,
    sources.codeMap.symbols,
    sources.profile.entrypoints,
    sources.staticProgramGraph.files,
    sources.staticProgramGraph.modules,
    sources.staticProgramGraph.records,
  ]) {
    for (const item of asArray(collection)) add(item)
  }
  for (const candidate of asArray(sources.profile.sourceRoots)) {
    const root = normalizeRepoPath(candidate)
    if (root) paths.push(root)
  }
  return uniqueSorted(paths)
}

function collectManifests(sources) {
  const result = []
  const seen = new Set()
  for (const item of [
    ...asArray(sources.input.manifests),
    ...asArray(sources.inventory.manifests),
    ...asArray(sources.codeMap.manifests),
  ]) {
    if (!isObject(item)) continue
    const manifestPath = normalizeRepoPath(item.path || item.file || item.sourcePath)
    if (!manifestPath || generatedPath(manifestPath)) continue
    const key = `${manifestPath}:${String(item.type || '')}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...item, path: manifestPath })
  }
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

function collectDependencies(sources, manifests) {
  const result = []
  const add = (item, fallbackPath = '') => {
    if (typeof item === 'string') item = { name: item }
    if (!isObject(item)) return
    const name = String(item.name || item.package || item.module || '').trim().toLowerCase()
    if (!name) return
    const manifestPath = normalizeRepoPath(item.path || item.manifestPath || fallbackPath)
    const key = `${name}:${manifestPath}`
    if (result.some(candidate => `${candidate.name}:${candidate.path}` === key)) return
    result.push({ ...item, name, path: manifestPath || null })
  }
  for (const item of asArray(sources.input.dependencies)) add(item)
  for (const item of asArray(sources.codeMap.dependencies)) add(item)
  for (const manifest of manifests) {
    for (const item of asArray(manifest.dependencies)) add(item, manifest.path)
    if (isObject(manifest.dependencies)) {
      for (const [name, version] of Object.entries(manifest.dependencies)) add({ name, version }, manifest.path)
    }
    for (const [name, version] of Object.entries(manifest.devDependencies || {})) add({ name, version, scope: 'dev' }, manifest.path)
  }
  return result.sort((left, right) => `${left.name}:${left.path || ''}`.localeCompare(`${right.name}:${right.path || ''}`))
}

function collectFrameworkNames(sources, dependencies, filePaths) {
  const names = []
  for (const item of asArray(sources.profile.frameworks)) {
    const name = String(typeof item === 'string' ? item : item?.name || '').trim().toLowerCase()
    if (name) names.push(name)
  }
  for (const item of asArray(sources.input.frameworks)) {
    const name = String(typeof item === 'string' ? item : item?.name || '').trim().toLowerCase()
    if (name) names.push(name)
  }
  for (const dependency of dependencies) {
    if (dependency.name === 'next') names.push('next', 'react')
    else if (dependency.name === 'nuxt') names.push('nuxt', 'vue')
    else if (/^(?:react|react-dom|react-router|react-router-dom)$/.test(dependency.name)) names.push('react')
    else if (/^(?:vue|vue-router)$/.test(dependency.name) || dependency.name.startsWith('@vue/')) names.push('vue')
    else if (/^(?:svelte|@sveltejs\/kit)$/.test(dependency.name)) names.push('svelte')
    else if (/^(?:angular|@angular\/core)$/.test(dependency.name)) names.push('angular')
  }
  if (filePaths.some(file => /(^|\/)next\.config\.[cm]?[jt]s$/i.test(file))) names.push('next', 'react')
  if (filePaths.some(file => /\.vue$/i.test(file))) names.push('vue')
  return uniqueSorted(names)
}

function collectBundlerNames(sources, dependencies, filePaths) {
  const names = []
  for (const item of asArray(sources.input.bundlers || sources.input.bundler)) {
    const name = String(typeof item === 'string' ? item : item?.name || '').trim().toLowerCase()
    if (name) names.push(name)
  }
  for (const dependency of dependencies) {
    if (dependency.name === 'next') names.push('next')
    if (dependency.name === 'nuxt') names.push('nuxt')
    if (dependency.name.includes('vite')) names.push('vite')
    if (dependency.name.includes('webpack')) names.push('webpack')
    if (dependency.name.includes('rspack')) names.push('rspack')
    if (dependency.name === 'parcel') names.push('parcel')
    if (dependency.name === 'rollup') names.push('rollup')
  }
  for (const filePath of filePaths) {
    if (/(^|\/)vite\.config\.[cm]?[jt]s$/i.test(filePath)) names.push('vite')
    if (/(^|\/)next\.config\.[cm]?[jt]s$/i.test(filePath)) names.push('next')
    if (/(^|\/)nuxt\.config\.[cm]?[jt]s$/i.test(filePath)) names.push('nuxt')
    if (/(^|\/)webpack(?:\.[^.]+)?\.config\.[cm]?[jt]s$/i.test(filePath)) names.push('webpack')
  }
  return uniqueSorted(names)
}

function collectRepoKindHints(sources) {
  return uniqueSorted([
    sources.input.repoKind,
    sources.profile.repoKind,
    sources.scanPolicy.repoKind,
  ].filter(value => ['frontend', 'fullstack', 'backend', 'unknown'].includes(value)))
}

function collectPackageRoots(sources, manifests, dependencies, filePaths) {
  const roots = []
  for (const value of [
    ...asArray(sources.input.packageWorkspaceRoots),
    ...asArray(sources.input.workspaceRoots),
    ...asArray(sources.input.packageRoots),
  ]) {
    const root = normalizeRepoPath(typeof value === 'string' ? value : value?.path || value?.root)
    if (root) roots.push(root)
  }
  for (const manifest of manifests) {
    if (manifest.type === 'npm' || PACKAGE_MANIFEST_PATTERN.test(manifest.path)) roots.push(rootForFile(manifest.path))
  }
  for (const dependency of dependencies) {
    if (dependency.path && PACKAGE_MANIFEST_PATTERN.test(dependency.path)) roots.push(rootForFile(dependency.path))
  }
  for (const filePath of filePaths) {
    if (PACKAGE_MANIFEST_PATTERN.test(filePath)) roots.push(rootForFile(filePath))
  }
  if (!roots.length && (sources.profile.repoKind === 'frontend' || sources.profile.repoKind === 'fullstack')) roots.push('.')
  return uniqueSorted(roots)
}

function findBrowserBootstrapCandidates(filePaths) {
  return filePaths
    .filter(filePath => /(^|\/)(?:main|client|entry-client|bootstrap|index)\.(?:[cm]?[jt]sx?|vue)$/i.test(filePath)
      || /(^|\/)pages\/_app\.[cm]?[jt]sx?$/i.test(filePath)
      || /(^|\/)app\/layout\.[cm]?[jt]sx?$/i.test(filePath))
    .sort((left, right) => bootstrapRank(right) - bootstrapRank(left) || left.localeCompare(right))
}

function inferFrontendRoots(context) {
  const explicitRoots = uniqueSorted([
    ...asArray(context.sources.input.frontendRoots),
    ...asArray(context.sources.input.supportDecision?.frontendRoots),
  ])
  if (explicitRoots.length) return explicitRoots

  const candidateRoots = new Set(context.packageRoots)
  for (const filePath of context.filePaths) {
    const match = filePath.match(/^((?:apps|packages)\/[^/]+|(?:frontend|client|web|ui))(?:\/|$)/i)
    if (match) candidateRoots.add(match[1])
  }
  if (!candidateRoots.size && (context.frameworkNames.length || context.bundlerNames.length)) candidateRoots.add('.')
  const roots = [...candidateRoots]
  const scores = roots.map(root => ({ root, score: frontendRootScore(root, roots, context) }))
  const qualified = scores.filter(item => item.score >= 5).sort((left, right) => right.score - left.score || left.root.localeCompare(right.root))
  const nestedQualified = qualified.filter(item => item.root !== '.')
  if (nestedQualified.length) return nestedQualified.map(item => item.root)
  if (qualified.length) return qualified.map(item => item.root)
  if (context.sources.profile.repoKind === 'frontend') return ['.']
  return []
}

function inferBackendRoots({ sources, filePaths, manifests, dependencies }) {
  const explicitRoots = uniqueSorted([
    ...asArray(sources.input.backendRoots),
    ...asArray(sources.input.supportDecision?.backendRoots),
  ])
  if (explicitRoots.length) return explicitRoots
  const roots = new Set()
  for (const manifest of manifests) {
    if (BACKEND_MANIFEST_TYPES.has(String(manifest.type || '').toLowerCase())) roots.add(rootForFile(manifest.path))
  }
  for (const dependency of dependencies) {
    if (BACKEND_DEPENDENCY_PATTERN.test(dependency.name)) roots.add(dependency.path ? rootForFile(dependency.path) : '.')
  }
  for (const filePath of filePaths) {
    const match = filePath.match(/^((?:apps|packages|services)\/[^/]+|(?:backend|server|api))(?:\/|$)/i)
    if (match && /(?:^|\/)(?:backend|server|api|service)$/i.test(match[1])) roots.add(match[1])
    if (/^(?:app|src\/app)\/api\//i.test(filePath) || /(^|\/)pages\/api\//i.test(filePath)) roots.add(rootForFile(filePath).replace(/\/[^/]+$/, ''))
  }
  if (!roots.size && sources.profile.repoKind === 'backend') roots.add('.')
  return uniqueSorted([...roots])
}

function frontendRootScore(root, roots, context) {
  let score = 0
  const owned = filePath => ownerRoot(filePath, roots) === root
  const dependencyNames = context.dependencies
    .filter(item => !item.path || ownerRoot(item.path, roots) === root)
    .map(item => item.name)
  if (dependencyNames.some(name => FRONTEND_DEPENDENCIES.has(name) || name.startsWith('@angular/'))) score += 8
  if (dependencyNames.some(name => FRONTEND_TOOLING_DEPENDENCIES.has(name) || name.includes('vite'))) score += 5
  if (context.filePaths.some(file => owned(file) && /(^|\/)(?:vite|next|nuxt|webpack)(?:\.[^.]+)?\.config\.[cm]?[jt]s$/i.test(file))) score += 5
  if (context.browserBootstrapCandidates.some(owned)) score += 5
  if (context.filePaths.some(file => owned(file) && /(^|\/)index\.html$/i.test(file))) score += 3
  if (context.filePaths.some(file => owned(file) && FRONTEND_SOURCE_PATTERN.test(file))) score += 2
  if (/(^|\/)(?:frontend|client|web)(?:\/|$)/i.test(root)) score += 3
  if (/(^|\/)(?:ui|design-system)(?:\/|$)/i.test(root)) score += 1
  return score
}

function hasStrongFrontendEvidence(context) {
  const runtimeFramework = context.frameworkNames.some(name => ['angular', 'next', 'nuxt', 'preact', 'react', 'solid', 'svelte', 'vue'].includes(name))
  const configuredBrowserBuild = context.bundlerNames.length > 0
    && (context.browserBootstrapCandidates.length > 0 || context.filePaths.some(file => /(^|\/)index\.html$/i.test(file)))
  return runtimeFramework || configuredBrowserBuild || context.frontendRoots.some(root => root !== '.')
}

function hasBackendEvidence({ filePaths, manifests, dependencies, backendRoots }) {
  return backendRoots.length > 0
    || manifests.some(item => BACKEND_MANIFEST_TYPES.has(String(item.type || '').toLowerCase()))
    || dependencies.some(item => BACKEND_DEPENDENCY_PATTERN.test(item.name))
    || filePaths.some(file => /^(?:backend|server|services)(\/|$)/i.test(file))
}

function ownerRoot(filePath, roots) {
  return [...roots]
    .filter(root => pathWithinRoot(filePath, root))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))[0] || '.'
}

function bootstrapRank(filePath) {
  if (/\/(?:main|entry-client)\.tsx?$/i.test(`/${filePath}`)) return 100
  if (/\/(?:main|entry-client)\.jsx?$/i.test(`/${filePath}`)) return 90
  if (/\/pages\/_app\./i.test(`/${filePath}`)) return 80
  if (/\/app\/layout\./i.test(`/${filePath}`)) return 75
  if (/\/(?:client|bootstrap|index)\./i.test(`/${filePath}`)) return 50
  return 0
}

function recordPath(value) {
  if (!isObject(value)) return ''
  return value.file || value.filePath || value.sourcePath || value.modulePath || value.resolvedPath || value.path || ''
}

function normalizeScalar(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function asArray(value) {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
