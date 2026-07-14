import path from 'node:path'

export const REPO_FRONTEND_CENSUS_PROFILE_SCHEMA = 'repo-frontend-census-profile/v1'

export function buildFrontendCensusProfile({ repo, inventory, codeMap, generatedAt = new Date().toISOString() }) {
  const manifests = codeMap?.manifests || inventory?.manifests || []
  const dependencies = codeMap?.dependencies || []
  const languages = inventory?.counts?.languages || {}
  const manifestTypes = new Set(manifests.map(item => item.type).filter(Boolean))
  const frameworks = detectFrameworks(dependencies, manifests)
  const buildSystems = detectBuildSystems(manifests)
  const repoKind = inferRepoKind({ manifestTypes, languages, frameworks })
  const primaryLanguage = inferPrimaryLanguage(languages, repoKind, frameworks)
  const sourceRoots = inferSourceRoots(inventory)
  const entrypoints = inferProfileEntrypoints(codeMap, inventory)
  const routeStyle = inferRouteStyle({ codeMap, frameworks, languages })
  const runtimeShape = inferRuntimeShape({ repoKind, frameworks, routeStyle, manifestTypes })
  const aliases = inferAliasHints(inventory, frameworks)
  const evidenceRefs = profileEvidenceRefs(manifests, inventory, entrypoints)
  return {
    schemaVersion: REPO_FRONTEND_CENSUS_PROFILE_SCHEMA,
    generatedAt,
    producedBy: {
      role: 'frontend-census',
      mode: 'deterministic',
    },
    repo: repo ? { name: repo.name, path: repo.path } : inventory?.repo,
    repoKind,
    primaryLanguage,
    languages,
    frameworks,
    buildSystems,
    runtimeShape,
    routeStyle,
    sourceRoots,
    aliases,
    entrypoints,
    evidenceRefs,
    confidence: profileConfidence({ manifests, frameworks, sourceRoots }),
    warnings: profileWarnings({ repoKind, manifests, frameworks, sourceRoots }),
  }
}

function detectFrameworks(dependencies, manifests) {
  const depText = dependencies
    .map(dep => [dep.name, dep.groupId].filter(Boolean).join(':').toLowerCase())
    .join('\n')
  const names = []
  const manifestTypes = new Set(manifests.map(item => item.type))
  const add = (name, evidence = [], category = 'runtime') => {
    if (!names.some(item => item.name === name)) names.push({ name, category, evidenceRefs: evidence.filter(Boolean) })
  }
  if (manifestTypes.has('npm')) add('node', manifestRefs(manifests, 'npm'), 'platform')
  if (manifestTypes.has('maven')) add('maven', manifestRefs(manifests, 'maven'), 'build-system')
  if (manifestTypes.has('gradle')) add('gradle', manifestRefs(manifests, 'gradle'), 'build-system')
  if (manifestTypes.has('go')) add('go', manifestRefs(manifests, 'go'), 'platform')
  if (manifestTypes.has('cargo')) add('rust', manifestRefs(manifests, 'cargo'), 'platform')
  if (manifestTypes.has('python')) add('python', manifestRefs(manifests, 'python'), 'platform')
  if (manifestTypes.has('bundler')) add('ruby', manifestRefs(manifests, 'bundler'), 'platform')
  if (manifestTypes.has('composer')) add('php', manifestRefs(manifests, 'composer'), 'platform')
  if (manifestTypes.has('dotnet')) add('dotnet', manifestRefs(manifests, 'dotnet'), 'platform')
  if (/\bvue\b|vue-router|@vue\//.test(depText)) add('vue', dependencyRefs(dependencies, /vue|vue-router|@vue\//i), 'frontend')
  if (/\breact\b|react-dom|react-router/.test(depText)) add('react', dependencyRefs(dependencies, /react|react-dom|react-router/i), 'frontend')
  if (/angular|@angular\//.test(depText)) add('angular', dependencyRefs(dependencies, /angular|@angular\//i), 'frontend')
  if (/svelte|@svelte/.test(depText)) add('svelte', dependencyRefs(dependencies, /svelte|@svelte/i), 'frontend')
  if (/\bnext\b|nextjs/.test(depText)) add('next', dependencyRefs(dependencies, /\bnext\b|nextjs/i), 'frontend')
  if (/\bnuxt\b|nuxtjs/.test(depText)) add('nuxt', dependencyRefs(dependencies, /\bnuxt\b|nuxtjs/i), 'frontend')
  if (/vite/.test(depText)) add('vite', dependencyRefs(dependencies, /vite/i), 'frontend-tooling')
  if (/webpack/.test(depText)) add('webpack', dependencyRefs(dependencies, /webpack/i), 'frontend-tooling')
  if (/express|koa|fastify|@nestjs|nestjs|hapi/.test(depText)) add('node-server', dependencyRefs(dependencies, /express|koa|fastify|@nestjs|nestjs|hapi/i), 'backend')
  if (/spring|springframework/.test(depText)) add('spring', dependencyRefs(dependencies, /spring|springframework/i), 'backend')
  if (/dubbo/.test(depText)) add('dubbo', dependencyRefs(dependencies, /dubbo/i), 'backend')
  if (/hessian/.test(depText)) add('hessian', dependencyRefs(dependencies, /hessian/i), 'backend')
  if (/fastapi|django|flask|starlette/.test(depText)) add('python-web', dependencyRefs(dependencies, /fastapi|django|flask|starlette/i), 'backend')
  if (/gin-gonic|gorilla\/mux|go-chi|labstack\/echo/.test(depText)) add('go-web', dependencyRefs(dependencies, /gin-gonic|gorilla\/mux|go-chi|labstack\/echo/i), 'backend')
  if (/rails|sinatra/.test(depText)) add('ruby-web', dependencyRefs(dependencies, /rails|sinatra/i), 'backend')
  if (/laravel|symfony/.test(depText)) add('php-web', dependencyRefs(dependencies, /laravel|symfony/i), 'backend')
  if (/aspnet|microsoft\.aspnetcore/.test(depText)) add('dotnet-web', dependencyRefs(dependencies, /aspnet|microsoft\.aspnetcore/i), 'backend')
  return names
}

function detectBuildSystems(manifests) {
  return manifests.map(manifest => ({
    type: manifest.type,
    path: manifest.path,
    name: manifest.name,
    packaging: manifest.packaging || null,
    evidenceRefs: manifest.path ? [`evidence:manifest:${manifest.path}`] : [],
  }))
}

function inferRepoKind({ manifestTypes, languages, frameworks }) {
  const frameworkNames = new Set(frameworks.map(item => item.name))
  const frontendLangs = (languages.React || 0) + (languages['React TS'] || 0) + (languages.Vue || 0)
  const frontendFrameworks = ['vue', 'react', 'angular', 'svelte', 'next', 'nuxt', 'vite']
  const backendFrameworks = ['spring', 'dubbo', 'hessian', 'node-server', 'python-web', 'go-web', 'ruby-web', 'php-web', 'dotnet-web']
  const backendManifestTypes = ['maven', 'gradle', 'go', 'cargo', 'python', 'bundler', 'composer', 'dotnet']
  const backendLangs = ['Java', 'Go', 'Python', 'Rust', 'Ruby', 'PHP', 'C#', 'Kotlin', 'Scala']
    .reduce((sum, name) => sum + (languages[name] || 0), 0)
  const hasFrontend = frontendFrameworks.some(name => frameworkNames.has(name)) || frontendLangs > 0
  const hasBackend = backendManifestTypes.some(type => manifestTypes.has(type))
    || backendFrameworks.some(name => frameworkNames.has(name))
    || backendLangs > 0
  if (hasFrontend && hasBackend) return 'fullstack'
  if (hasFrontend) return 'frontend'
  if (hasBackend) return 'backend'
  return 'unknown'
}

function inferSourceRoots(inventory) {
  const paths = new Set((inventory?.files || []).map(file => file.path))
  const candidates = [
    'src',
    'src/main/java',
    'src/main/kotlin',
    'src/main/scala',
    'src/main/resources',
    'src/main/webapp',
    'src/test/java',
    'cmd',
    'pkg',
    'internal',
    'app',
    'server',
    'backend',
    'frontend',
    'web',
    'api',
    'service',
    'services',
    'lib',
    'packages',
    'modules',
  ]
  const roots = new Set(candidates.filter(candidate => [...paths].some(file => file === candidate || file.startsWith(`${candidate}/`))))
  for (const file of inventory?.files || []) {
    if (!['source', 'test', 'script', 'markup'].includes(file.category) || file.protected) continue
    const parts = String(file.path || '').split('/')
    const srcIndex = parts.indexOf('src')
    if (srcIndex < 0) continue
    let end = srcIndex
    if (parts[srcIndex + 1] === 'main' && ['java', 'kotlin', 'scala', 'resources', 'webapp'].includes(parts[srcIndex + 2])) end = srcIndex + 2
    else if (parts[srcIndex + 1] === 'test' && ['java', 'kotlin', 'scala'].includes(parts[srcIndex + 2])) end = srcIndex + 2
    roots.add(parts.slice(0, end + 1).join('/'))
  }
  return [...roots].sort().slice(0, 80)
}

function inferPrimaryLanguage(languages, repoKind, frameworks) {
  const excluded = new Set([
    'Binary Resource',
    'Protected Metadata',
    'Text',
    'Markdown',
    'JSON',
    'YAML',
    'XML',
    'HTML',
    'CSS',
    'SCSS',
    'NPM JSON',
    'Maven XML',
  ])
  const candidates = Object.entries(languages || {})
    .filter(([name, count]) => !excluded.has(name) && Number(count) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (candidates.length) return candidates[0][0]
  const frameworkNames = new Set((frameworks || []).map(item => item.name))
  if (repoKind === 'frontend' && frameworkNames.has('vue')) return 'Vue'
  if (repoKind === 'frontend' && frameworkNames.has('react')) return 'TypeScript/JavaScript'
  return topCountName(Object.fromEntries(Object.entries(languages || {}).filter(([name]) => !/binary|protected/i.test(name)))) || 'Unknown'
}

function inferProfileEntrypoints(codeMap, inventory) {
  const explicit = (codeMap?.entrypoints || [])
    .slice(0, 80)
    .map(item => ({
      file: item.file,
      kind: item.kind,
      name: item.name,
      line: item.line,
      evidenceRefs: item.file ? [`evidence:file:${item.file}`] : [],
    }))
  if (explicit.length) return explicit
  return (inventory?.files || [])
    .filter(file => /(^|\/)(main|index|app|application|bootstrap|server|manage|program|startup)\.(js|jsx|ts|tsx|vue|java|go|py|rb|rs|cs|php|kt|scala)$|web\.xml$|pom\.xml$|package\.json$|pyproject\.toml$|go\.mod$|Cargo\.toml$/i.test(file.path))
    .slice(0, 40)
    .map(file => ({ file: file.path, kind: 'file-name', name: path.basename(file.path), evidenceRefs: [`evidence:file:${file.path}`] }))
}

function inferRouteStyle({ codeMap, frameworks, languages }) {
  const frameworkNames = new Set(frameworks.map(item => item.name))
  if (frameworkNames.has('vue')) return 'vue-router'
  if (frameworkNames.has('react')) return 'react-router-or-file-routes'
  if (frameworkNames.has('next')) return 'next-file-routes'
  if (frameworkNames.has('nuxt')) return 'nuxt-file-routes'
  if (frameworkNames.has('node-server')) return 'node-http-router'
  if (frameworkNames.has('python-web')) return 'python-http-router'
  if (frameworkNames.has('go-web')) return 'go-http-router'
  if (frameworkNames.has('ruby-web')) return 'ruby-http-router'
  if (frameworkNames.has('php-web')) return 'php-http-router'
  if (frameworkNames.has('dotnet-web')) return 'dotnet-controller'
  if ((languages.Java || 0) > 0 && (codeMap?.routes || []).some(route => route.kind === 'java-annotation')) return 'java-annotation'
  if ((codeMap?.routes || []).some(route => route.kind === 'js-route-config')) return 'js-route-config'
  return 'unknown'
}

function inferRuntimeShape({ repoKind, frameworks, routeStyle, manifestTypes }) {
  const frameworkNames = frameworks.map(item => item.name)
  if (repoKind === 'frontend') return ['browser-app', routeStyle].filter(Boolean)
  if (repoKind === 'fullstack') return ['mixed-runtime', routeStyle]
  if (manifestTypes.has('maven') || manifestTypes.has('gradle')) return ['jvm-service', routeStyle, ...frameworkNames.filter(name => ['spring', 'dubbo', 'hessian'].includes(name))].filter(Boolean)
  if (manifestTypes.has('go')) return ['go-service', routeStyle].filter(Boolean)
  if (manifestTypes.has('python')) return ['python-service', routeStyle].filter(Boolean)
  if (manifestTypes.has('cargo')) return ['rust-service', routeStyle].filter(Boolean)
  if (manifestTypes.has('bundler')) return ['ruby-service', routeStyle].filter(Boolean)
  if (manifestTypes.has('composer')) return ['php-service', routeStyle].filter(Boolean)
  if (manifestTypes.has('dotnet')) return ['dotnet-service', routeStyle].filter(Boolean)
  if (frameworkNames.includes('node-server')) return ['node-service', routeStyle].filter(Boolean)
  return [repoKind]
}

function inferAliasHints(inventory, frameworks) {
  const paths = new Set((inventory?.files || []).map(file => file.path))
  const aliases = []
  if ([...paths].some(file => file.startsWith('src/'))) {
    aliases.push({ alias: '@', target: 'src', source: 'src-root-heuristic' })
    aliases.push({ alias: '_', target: 'src', source: 'src-root-heuristic' })
  }
  if (frameworks.some(item => ['vue', 'react', 'angular', 'svelte', 'next', 'nuxt', 'node'].includes(item.name))) {
    for (const file of ['tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js', 'webpack.config.js', 'vue.config.js', 'next.config.js', 'nuxt.config.ts']) {
      if (paths.has(file)) aliases.push({ alias: '(config)', target: file, source: 'config-file-present' })
    }
  }
  return aliases
}

function profileEvidenceRefs(manifests, inventory, entrypoints) {
  return dedupeStrings([
    ...manifests.map(item => item.path ? `evidence:manifest:${item.path}` : ''),
    ...entrypoints.map(item => item.file ? `evidence:file:${item.file}` : ''),
    ...(inventory?.files || [])
      .filter(file => /(^|\/)(package\.json|composer\.json|pom\.xml|build\.gradle|settings\.gradle|go\.mod|Cargo\.toml|Gemfile|pyproject\.toml|requirements\.txt|tsconfig\.json|jsconfig\.json|vite\.config\.[jt]s|webpack\.config\.js|vue\.config\.js|next\.config\.js|nuxt\.config\.ts|[^/]+\.csproj)$/i.test(file.path))
      .slice(0, 40)
      .map(file => `evidence:file:${file.path}`),
  ])
}

function profileConfidence({ manifests, frameworks, sourceRoots }) {
  let score = 0.45
  if (manifests.length) score += 0.25
  if (frameworks.length) score += 0.15
  if (sourceRoots.length) score += 0.1
  return Math.min(0.95, Number(score.toFixed(2)))
}

function profileWarnings({ repoKind, manifests, frameworks, sourceRoots }) {
  const warnings = []
  if (repoKind === 'unknown') warnings.push('Repo kind is unknown; route scanner and report projection will use conservative defaults.')
  if (!manifests.length) warnings.push('No recognized manifest was found.')
  if (!frameworks.length) warnings.push('No framework dependency was identified from manifests.')
  if (!sourceRoots.length) warnings.push('No conventional source root was identified.')
  return warnings
}

function topCountName(counts) {
  return Object.entries(counts || {}).sort((a, b) => b[1] - a[1])[0]?.[0]
}

function manifestRefs(manifests, type) {
  return manifests.filter(item => item.type === type && item.path).map(item => `evidence:manifest:${item.path}`)
}

function dependencyRefs(dependencies, pattern) {
  return dependencies
    .filter(dep => pattern.test(`${dep.name || ''}:${dep.groupId || ''}`))
    .map(dep => dep.path ? `evidence:manifest:${dep.path}` : '')
    .filter(Boolean)
}

function dedupeStrings(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))]
}
