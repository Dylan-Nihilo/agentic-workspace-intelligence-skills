import path from 'node:path'

export const REPO_SCOUT_PROFILE_SCHEMA = 'repo-scout-profile/v1'
export const REPO_SCAN_POLICY_SCHEMA = 'repo-scan-policy/v1'
export const REPO_SCOUT_CONTEXT_SCHEMA = 'repo-scout-context/v1'
export const REPO_SCOUT_AGENT_OUTPUT_SCHEMA = 'repo-scout-agent-output/v1'

export function buildRepoScoutProfile({ repo, inventory, codeMap, generatedAt = new Date().toISOString() }) {
  const manifests = codeMap?.manifests || inventory?.manifests || []
  const dependencies = codeMap?.dependencies || []
  const languages = inventory?.counts?.languages || {}
  const manifestTypes = new Set(manifests.map(item => item.type).filter(Boolean))
  const frameworks = detectFrameworks(dependencies, manifests)
  const buildSystems = detectBuildSystems(manifests)
  const repoKind = inferRepoKind({ manifestTypes, languages, frameworks })
  const primaryLanguage = topCountName(languages) || 'Unknown'
  const sourceRoots = inferSourceRoots(inventory)
  const entrypoints = inferProfileEntrypoints(codeMap, inventory)
  const routeStyle = inferRouteStyle({ codeMap, frameworks, languages })
  const runtimeShape = inferRuntimeShape({ repoKind, frameworks, routeStyle, manifestTypes })
  const aliases = inferAliasHints(inventory, frameworks)
  const evidenceRefs = profileEvidenceRefs(manifests, inventory, entrypoints)
  return {
    schemaVersion: REPO_SCOUT_PROFILE_SCHEMA,
    generatedAt,
    producedBy: {
      role: 'repo-scout',
      mode: 'deterministic-baseline',
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

export function buildScanPolicy(profile) {
  const repoKind = profile?.repoKind || 'unknown'
  const frameworkNames = new Set((profile?.frameworks || []).map(item => item.name))
  const languageNames = new Set(Object.keys(profile?.languages || {}))
  const frontend = repoKind === 'frontend' || repoKind === 'fullstack'
  const backend = repoKind === 'backend' || repoKind === 'fullstack'
  const jsLike = frontend || ['JavaScript', 'TypeScript', 'React', 'React TS', 'Vue', 'NPM JSON'].some(name => languageNames.has(name)) || frameworkNames.has('node')
  const javaBackend = languageNames.has('Java') || frameworkNames.has('maven') || frameworkNames.has('gradle') || frameworkNames.has('spring') || frameworkNames.has('dubbo')
  return {
    schemaVersion: REPO_SCAN_POLICY_SCHEMA,
    generatedAt: profile?.generatedAt || new Date().toISOString(),
    producedBy: {
      role: 'repo-scout',
      sourceProfile: profile?.schemaVersion || null,
    },
    repo: profile?.repo,
    repoKind,
    enabledScanners: {
      java: javaBackend,
      javascript: jsLike,
      typescript: jsLike,
      vue: frameworkNames.has('vue'),
      react: frameworkNames.has('react'),
      python: languageNames.has('Python') || frameworkNames.has('python'),
      go: languageNames.has('Go') || frameworkNames.has('go'),
      rust: languageNames.has('Rust') || frameworkNames.has('rust'),
      ruby: languageNames.has('Ruby') || frameworkNames.has('ruby'),
      php: languageNames.has('PHP') || frameworkNames.has('php'),
      dotnet: languageNames.has('C#') || frameworkNames.has('dotnet'),
      xml: javaBackend || frameworkNames.has('dotnet'),
      backend,
      config: true,
    },
    importResolution: {
      aliases: profile?.aliases || [],
      sourceRoots: profile?.sourceRoots || [],
      frontendExtensionless: frontend,
      javaPackagesAreExternalByDefault: javaBackend,
      unresolvedImportExplorer: 'dependency-resolution',
    },
    explorerRouting: {
      componentExplorer: frontend ? 'component-structure' : null,
      routeExplorer: 'route-binding',
      runtimeConfigExplorer: 'runtime-config',
      dependencyExplorer: 'dependency-resolution',
      defaultExplorer: 'coverage-directed',
    },
    reportProjection: {
      mode: repoKind,
      avoidFrontendDefault: repoKind !== 'frontend' && repoKind !== 'fullstack',
    },
    evidenceRefs: profile?.evidenceRefs || [],
  }
}

export function buildRepoScoutContext({ repo, inventory, codeMap, deterministicProfile = null, deterministicScanPolicy = null, snippets = {}, generatedAt = new Date().toISOString() }) {
  const files = inventory?.files || []
  const manifests = codeMap?.manifests || inventory?.manifests || []
  const topDirectories = (inventory?.directories || [])
    .filter(dir => dir.path === '.' || !dir.path.includes('/'))
    .slice(0, 80)
  const highSignalFiles = files
    .filter(file => isScoutSignalFile(file.path, file.category))
    .slice(0, 120)
    .map(file => ({
      path: file.path,
      language: file.language,
      category: file.category,
      lines: file.lines,
      protected: Boolean(file.protected),
    }))
  return {
    schemaVersion: REPO_SCOUT_CONTEXT_SCHEMA,
    generatedAt,
    repo,
    counts: inventory?.counts || {},
    directories: topDirectories,
    manifests,
    dependencies: codeMap?.dependencies || [],
    entrypoints: codeMap?.entrypoints || [],
    routes: codeMap?.routes || [],
    imports: (codeMap?.imports || []).slice(0, 200),
    sourceRoots: inferSourceRoots(inventory),
    highSignalFiles,
    snippets,
    deterministicHints: {
      profile: deterministicProfile,
      scanPolicy: deterministicScanPolicy,
      usage: 'hints-only; agent must verify and may override',
    },
  }
}

export function renderRepoScoutPrompt(context, outputPath) {
  return [
    '# Repo Scout L0 Agent Task',
    '',
    'You are the L0 repo scout. Produce the repository profile and scan policy before L1 scanning.',
    '',
    'Rules:',
    '- Read only. Do not install dependencies, run builds, run tests, start servers, or use the network.',
    '- Use the deterministic context as evidence material, not as the final answer.',
    '- Inspect README/manifests/entry files when needed. Do not classify a repo from filename heuristics alone.',
    '- Every claim must be grounded in manifest, directory, entrypoint, route, import, or README evidence.',
    '- Protected files may be mentioned only as existing metadata; do not infer values from them.',
    '',
    `Write JSON to: ${outputPath}`,
    '',
    'Required JSON shape:',
    JSON.stringify({
      schemaVersion: REPO_SCOUT_AGENT_OUTPUT_SCHEMA,
      strategy: 'short explanation of what was inspected',
      profile: {
        schemaVersion: REPO_SCOUT_PROFILE_SCHEMA,
        producedBy: { role: 'repo-scout', mode: 'agent' },
        repoKind: 'frontend|backend|fullstack|unknown',
        primaryLanguage: 'TypeScript',
        languages: {},
        frameworks: [{ name: 'framework-name', category: 'frontend|backend|platform|build-system', evidenceRefs: ['evidence:file:package.json'] }],
        buildSystems: [],
        runtimeShape: [],
        routeStyle: 'unknown',
        sourceRoots: [],
        aliases: [],
        entrypoints: [],
        evidenceRefs: [],
        confidence: 0.8,
        warnings: [],
      },
      scanPolicy: {
        schemaVersion: REPO_SCAN_POLICY_SCHEMA,
        repoKind: 'frontend|backend|fullstack|unknown',
        enabledScanners: {},
        importResolution: {},
        explorerRouting: {},
        reportProjection: {},
        evidenceRefs: [],
      },
      warnings: [],
    }, null, 2),
    '',
    'Scout context:',
    JSON.stringify(context, null, 2),
  ].join('\n')
}

export function normalizeRepoScoutAgentOutput(value, fallback = {}) {
  const output = value?.schemaVersion === REPO_SCOUT_AGENT_OUTPUT_SCHEMA
    ? value
    : {
        schemaVersion: REPO_SCOUT_AGENT_OUTPUT_SCHEMA,
        strategy: value?.strategy || 'repo-scout agent output normalized from profile payload',
        profile: value?.profile || value?.repoProfile || value,
        scanPolicy: value?.scanPolicy,
        warnings: value?.warnings || [],
      }
  const profile = normalizeScoutProfile(output.profile, fallback)
  const scanPolicy = output.scanPolicy
    ? normalizeScanPolicy(output.scanPolicy, profile, fallback)
    : buildScanPolicy(profile)
  return {
    schemaVersion: REPO_SCOUT_AGENT_OUTPUT_SCHEMA,
    generatedAt: output.generatedAt || fallback.generatedAt || profile.generatedAt || new Date().toISOString(),
    strategy: String(output.strategy || '').trim() || 'repo-scout agent classification',
    profile,
    scanPolicy,
    warnings: Array.isArray(output.warnings) ? output.warnings : [],
  }
}

export function validateRepoScoutAgentOutput(value) {
  const issues = []
  if (value?.schemaVersion !== REPO_SCOUT_AGENT_OUTPUT_SCHEMA) issues.push('Scout output schemaVersion is invalid')
  const profile = value?.profile
  const scanPolicy = value?.scanPolicy
  if (!profile || typeof profile !== 'object') issues.push('Scout output profile is missing')
  if (!scanPolicy || typeof scanPolicy !== 'object') issues.push('Scout output scanPolicy is missing')
  if (profile && profile.schemaVersion !== REPO_SCOUT_PROFILE_SCHEMA) issues.push('Scout profile schemaVersion is invalid')
  if (scanPolicy && scanPolicy.schemaVersion !== REPO_SCAN_POLICY_SCHEMA) issues.push('Scout scanPolicy schemaVersion is invalid')
  if (profile && !['frontend', 'backend', 'fullstack', 'unknown'].includes(profile.repoKind)) issues.push(`Scout profile repoKind is invalid: ${profile.repoKind}`)
  if (profile && !profile.primaryLanguage) issues.push('Scout profile primaryLanguage is missing')
  if (profile && (!Array.isArray(profile.evidenceRefs) || profile.evidenceRefs.length === 0)) issues.push('Scout profile evidenceRefs is empty')
  if (scanPolicy && profile && scanPolicy.repoKind !== profile.repoKind) issues.push(`Scout scanPolicy repoKind ${scanPolicy.repoKind} does not match profile ${profile.repoKind}`)
  if (profile?.producedBy?.mode === 'deterministic-baseline') issues.push('Scout profile must be produced by an agent, not deterministic-baseline')
  return issues
}

export function readRepoProfileFromPackage(readJsonIfExists, packageDir) {
  return readJsonIfExists(path.join(packageDir, 'repo-profile.json'))
    || readJsonIfExists(path.join(packageDir, 'static', 'repo-profile.json'))
}

export function readScanPolicyFromPackage(readJsonIfExists, packageDir) {
  return readJsonIfExists(path.join(packageDir, 'scan-policy.json'))
    || readJsonIfExists(path.join(packageDir, 'static', 'scan-policy.json'))
}

function normalizeScoutProfile(profile, fallback) {
  const generatedAt = profile?.generatedAt || fallback.generatedAt || new Date().toISOString()
  return {
    schemaVersion: REPO_SCOUT_PROFILE_SCHEMA,
    generatedAt,
    producedBy: {
      ...(profile?.producedBy || {}),
      role: 'repo-scout',
      mode: profile?.producedBy?.mode || 'agent',
    },
    repo: profile?.repo || fallback.repo || null,
    repoKind: profile?.repoKind || 'unknown',
    primaryLanguage: profile?.primaryLanguage || 'Unknown',
    languages: profile?.languages || fallback.languages || {},
    frameworks: Array.isArray(profile?.frameworks) ? profile.frameworks : [],
    buildSystems: Array.isArray(profile?.buildSystems) ? profile.buildSystems : [],
    runtimeShape: Array.isArray(profile?.runtimeShape) ? profile.runtimeShape : [],
    routeStyle: profile?.routeStyle || 'unknown',
    sourceRoots: Array.isArray(profile?.sourceRoots) ? profile.sourceRoots : [],
    aliases: Array.isArray(profile?.aliases) ? profile.aliases : [],
    entrypoints: Array.isArray(profile?.entrypoints) ? profile.entrypoints : [],
    evidenceRefs: dedupeStrings(profile?.evidenceRefs || []),
    confidence: finiteConfidence(profile?.confidence, 0.7),
    warnings: Array.isArray(profile?.warnings) ? profile.warnings : [],
  }
}

function normalizeScanPolicy(scanPolicy, profile, fallback) {
  const generatedAt = scanPolicy?.generatedAt || profile.generatedAt || fallback.generatedAt || new Date().toISOString()
  return {
    ...buildScanPolicy(profile),
    ...scanPolicy,
    schemaVersion: REPO_SCAN_POLICY_SCHEMA,
    generatedAt,
    producedBy: {
      role: 'repo-scout',
      sourceProfile: profile.schemaVersion,
      ...(scanPolicy?.producedBy || {}),
    },
    repo: scanPolicy?.repo || profile.repo || fallback.repo || null,
    repoKind: scanPolicy?.repoKind || profile.repoKind,
    evidenceRefs: dedupeStrings(scanPolicy?.evidenceRefs || profile.evidenceRefs || []),
  }
}

function isScoutSignalFile(filePath, category) {
  return /(^|\/)(README|AGENTS|CLAUDE|package\.json|composer\.json|pom\.xml|build\.gradle|settings\.gradle|go\.mod|Cargo\.toml|Gemfile|pyproject\.toml|requirements\.txt|Dockerfile|docker-compose\.ya?ml|\.gitlab-ci\.yml|Jenkinsfile|[^/]+\.csproj)$/i.test(filePath)
    || /(^|\/)(src|app|cmd|internal|server|api|backend|frontend|web|config|conf|resources)(\/|$)/i.test(filePath)
    || ['config', 'docs', 'script'].includes(category)
}

function finiteConfidence(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
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
  return candidates.filter(candidate => [...paths].some(file => file === candidate || file.startsWith(`${candidate}/`)))
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
