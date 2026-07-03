import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, '..')
const DEFAULT_OUTPUT_ROOT = path.join(WORKSPACE_ROOT, 'outputs', 'code-repo')
const MAX_TEXT_FILE_BYTES = 1_200_000
const MAX_MANIFEST_FILES = 12_000
const DEFAULT_MAX_SOURCE_FILES = 2_000

const IGNORE_DIRS = new Set([
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor'
])

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.less',
  '.mjs',
  '.mts',
  '.scss',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml'
])

const LANGUAGE_BY_EXTENSION = {
  '.cjs': 'JavaScript',
  '.css': 'CSS',
  '.cts': 'TypeScript',
  '.html': 'HTML',
  '.js': 'JavaScript',
  '.jsx': 'React',
  '.json': 'JSON',
  '.less': 'Less',
  '.mjs': 'JavaScript',
  '.mts': 'TypeScript',
  '.scss': 'SCSS',
  '.ts': 'TypeScript',
  '.tsx': 'React TS',
  '.vue': 'Vue',
  '.yaml': 'YAML',
  '.yml': 'YAML'
}

const CONFIG_FILE_NAMES = new Set([
  '.babelrc',
  '.browserslistrc',
  '.eslintrc',
  '.eslintrc.cjs',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.npmrc',
  '.prettierrc',
  'babel.config.js',
  'commitlint.config.js',
  'components.json',
  'eslint.config.js',
  'eslint.config.mjs',
  'jest.config.js',
  'jsconfig.json',
  'package.json',
  'pnpm-workspace.yaml',
  'postcss.config.js',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tsconfig.json',
  'vite.config.js',
  'vite.config.ts',
  'vue.config.js',
  'webpack.config.js'
])

const LOCK_FILE_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'])

function printUsage() {
  console.log(`Usage:
  npm run analyze:repo -- <repo-path> [--out <dir>] [--include-untracked] [--max-source-files <n>]

Examples:
  npm run analyze:repo -- ../mp-account
  node scripts/code-repo-analyzer.mjs /path/to/repo --out /tmp/repo-analysis
`)
}

function parseArgs(argv) {
  const args = [...argv]
  const options = {
    includeUntracked: false,
    maxSourceFiles: DEFAULT_MAX_SOURCE_FILES,
    outDir: null,
    repoPath: null
  }

  while (args.length) {
    const item = args.shift()
    if (item === '--help' || item === '-h') {
      printUsage()
      process.exit(0)
    }
    if (item === '--include-untracked') {
      options.includeUntracked = true
      continue
    }
    if (item === '--out') {
      options.outDir = args.shift()
      continue
    }
    if (item === '--max-source-files') {
      options.maxSourceFiles = Number(args.shift())
      continue
    }
    if (!options.repoPath) {
      options.repoPath = item
      continue
    }
    throw new Error(`Unknown argument: ${item}`)
  }

  if (!options.repoPath) {
    printUsage()
    process.exit(1)
  }

  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const repoPath = path.resolve(options.repoPath)
  const repoStats = await stat(repoPath).catch(() => null)
  if (!repoStats?.isDirectory()) throw new Error(`Repository path does not exist: ${repoPath}`)

  const generatedAt = new Date().toISOString()
  const repoName = path.basename(repoPath)
  const runId = `${safeId(repoName)}-${generatedAt.replace(/[:.]/g, '-')}`
  const outDir = path.resolve(options.outDir ?? path.join(DEFAULT_OUTPUT_ROOT, runId))
  await mkdir(outDir, { recursive: true })

  const files = await collectFiles(repoPath, options)
  const snapshot = await createRepoSnapshot({ files, generatedAt, options, repoName, repoPath, runId })
  const staticFacts = await createStaticFacts({ files, repoPath, snapshot, maxSourceFiles: options.maxSourceFiles })
  const repoWiki = createRepoWiki(snapshot, staticFacts)
  const lineage = createLineage(snapshot, staticFacts, generatedAt, runId)
  const summary = createSummary(snapshot, staticFacts, outDir)

  await writeJson(path.join(outDir, 'snapshot.json'), snapshot)
  await writeJson(path.join(outDir, 'static-facts.json'), staticFacts)
  await writeFile(path.join(outDir, 'repo-wiki.md'), repoWiki, 'utf8')
  await writeJson(path.join(outDir, 'lineage.json'), lineage)
  await writeJson(path.join(outDir, 'analysis-summary.json'), summary)

  console.log(`Repo analysis completed: ${outDir}`)
  console.log(`Files: ${snapshot.fileManifest.total} total, ${staticFacts.parserCoverage.analyzedFiles} analyzed`)
  console.log(`Routes: ${staticFacts.routes.length}, imports: ${staticFacts.imports.edges.length}, findings: ${staticFacts.qualitySignals.findings.length}`)
}

async function createRepoSnapshot({ files, generatedAt, options, repoName, repoPath, runId }) {
  const packageJson = await readJsonIfExists(path.join(repoPath, 'package.json'))
  const git = getGitSnapshot(repoPath)
  const lockFiles = files.filter(file => LOCK_FILE_NAMES.has(file.relativePath))
  const configs = files.filter(file => CONFIG_FILE_NAMES.has(path.basename(file.relativePath)) || file.relativePath.startsWith('.github/'))
  const languageCounts = countBy(files, file => file.language)

  return {
    schemaVersion: 'code-repo-analyzer.snapshot.v1',
    generatedAt,
    repo: {
      id: safeId(repoName),
      name: packageJson?.name ?? repoName,
      path: repoPath,
      packageName: packageJson?.name ?? null,
      version: packageJson?.version ?? null
    },
    git,
    package: packageJson ? {
      dependencies: pickDependencySignals(packageJson),
      scripts: packageJson.scripts ?? {},
      manager: detectPackageManager(lockFiles.map(file => file.relativePath)),
      rawPackageJsonHash: hashText(JSON.stringify(packageJson))
    } : null,
    fileManifest: {
      total: files.length,
      truncated: files.length >= MAX_MANIFEST_FILES,
      byLanguage: languageCounts,
      lockFiles: lockFiles.map(file => file.relativePath),
      configFiles: configs.map(file => file.relativePath),
      files: files.map(file => ({
        hash: file.hash,
        language: file.language,
        path: file.relativePath,
        size: file.size
      }))
    },
    collection: {
      includeUntracked: options.includeUntracked,
      maxManifestFiles: MAX_MANIFEST_FILES,
      runId
    }
  }
}

async function createStaticFacts({ files, maxSourceFiles, repoPath, snapshot }) {
  const sourceFiles = files
    .filter(file => isAnalyzableTextFile(file))
    .slice(0, maxSourceFiles)
  const contents = await readSourceContents(repoPath, sourceFiles)
  const entrypoints = findEntrypoints(files, contents)
  const routes = findRoutes(contents)
  const imports = findImports(contents)
  const microFrontend = findMicroFrontendSignals(contents)
  const qualitySignals = findQualitySignals(contents, snapshot)
  const unknowns = findUnknowns(files, contents, imports, routes)

  return {
    schemaVersion: 'code-repo-analyzer.static-facts.v1',
    generatedAt: new Date().toISOString(),
    repoId: snapshot.repo.id,
    commitSha: snapshot.git.commitSha,
    parserCoverage: {
      totalFiles: files.length,
      analyzableTextFiles: files.filter(file => isAnalyzableTextFile(file)).length,
      analyzedFiles: contents.length,
      skippedTextFiles: Math.max(0, files.filter(file => isAnalyzableTextFile(file)).length - contents.length),
      maxSourceFiles
    },
    entrypoints,
    routes,
    imports,
    microFrontend,
    qualitySignals,
    unknowns
  }
}

async function collectFiles(repoPath, options) {
  const collected = []

  async function visit(dir) {
    if (collected.length >= MAX_MANIFEST_FILES) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (collected.length >= MAX_MANIFEST_FILES) return
      if (entry.name === '.DS_Store') continue
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toPosix(path.relative(repoPath, absolutePath))
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue
        await visit(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const fileStats = await stat(absolutePath)
      const buffer = await readFile(absolutePath).catch(() => null)
      const ext = path.extname(entry.name).toLowerCase()
      collected.push({
        absolutePath,
        ext,
        hash: buffer ? hashBuffer(buffer) : null,
        language: LANGUAGE_BY_EXTENSION[ext] ?? 'Other',
        relativePath,
        size: fileStats.size
      })
    }
  }

  await visit(repoPath)

  if (!options.includeUntracked && isGitRepo(repoPath)) {
    const tracked = new Set(runGit(['ls-files'], repoPath).split('\n').filter(Boolean).map(toPosix))
    return collected.filter(file => tracked.has(file.relativePath) || CONFIG_FILE_NAMES.has(path.basename(file.relativePath)))
  }

  return collected
}

async function readSourceContents(repoPath, files) {
  const contents = []
  for (const file of files) {
    if (file.size > MAX_TEXT_FILE_BYTES) continue
    const text = await readFile(path.join(repoPath, file.relativePath), 'utf8').catch(() => null)
    if (text === null || hasBinaryControlChars(text)) continue
    contents.push({
      file,
      lines: text.split(/\r?\n/),
      text
    })
  }
  return contents
}

function findEntrypoints(files, contents) {
  const exactEntrypoints = new Set([
    'index.html',
    'src/main.js',
    'src/main.jsx',
    'src/main.ts',
    'src/main.tsx',
    'src/App.vue',
    'src/App.jsx',
    'src/App.tsx',
    'src/index.js',
    'src/index.jsx',
    'src/index.ts',
    'src/index.tsx'
  ])
  const byName = files
    .filter(file => exactEntrypoints.has(file.relativePath) || /(^|\/)(bootstrap|single-spa|qiankun)\.[cm]?[jt]sx?$/.test(file.relativePath))
    .map(file => ({
      evidence: evidence(file.relativePath, 1),
      kind: 'well-known-entry',
      path: file.relativePath
    }))

  const mounts = collectPatternEvidence(contents, [
    { id: 'vue-create-app', regex: /createApp\s*\(|new\s+Vue\s*\(/ },
    { id: 'react-render', regex: /createRoot\s*\(|ReactDOM\.render\s*\(/ },
    { id: 'qiankun-lifecycle', regex: /export\s+(async\s+)?function\s+(bootstrap|mount|unmount)\b/ }
  ], 80).map(item => ({
    evidence: item.evidence,
    kind: item.id,
    path: item.file
  }))

  return uniqueBy([...byName, ...mounts], item => `${item.path}:${item.kind}`)
}

function findRoutes(contents) {
  const routeFiles = contents.filter(({ file }) => /(^|\/)(router|routes?|pages?)(\/|\.|-)|route/i.test(file.relativePath))
  const routePatterns = [
    { id: 'route-path', regex: /\bpath\s*:\s*['"`]([^'"`]+)['"`]/g },
    { id: 'react-route', regex: /<Route\b[^>]*\bpath\s*=\s*['"`]([^'"`]+)['"`]/g },
    { id: 'redirect', regex: /\bredirect\s*:\s*['"`]([^'"`]+)['"`]/g }
  ]

  const routes = []
  for (const content of routeFiles) {
    for (const pattern of routePatterns) {
      collectMatches(content, pattern.regex, 240).forEach(match => {
        routes.push({
          evidence: evidence(content.file.relativePath, match.line),
          kind: pattern.id,
          path: match.value
        })
      })
    }
  }

  return uniqueBy(routes, item => `${item.path}:${item.evidence}`)
}

function findImports(contents) {
  const importRegexes = [
    { kind: 'static-import', regex: /\bimport\s+(?:[^'"`]+?\s+from\s+)?['"`]([^'"`]+)['"`]/g },
    { kind: 'dynamic-import', regex: /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g },
    { kind: 'require', regex: /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g },
    { kind: 're-export', regex: /\bexport\s+[^'"`]+?\s+from\s+['"`]([^'"`]+)['"`]/g }
  ]
  const edges = []

  for (const content of contents) {
    if (!/\.[cm]?[jt]sx?$|\.vue$/.test(content.file.ext)) continue
    for (const item of importRegexes) {
      collectMatches(content, item.regex, 5000).forEach(match => {
        edges.push({
          evidence: evidence(content.file.relativePath, match.line),
          from: content.file.relativePath,
          kind: item.kind,
          to: match.value
        })
      })
    }
  }

  const uniqueEdges = uniqueBy(edges, item => `${item.from}:${item.kind}:${item.to}:${item.evidence}`)
  const externalDeps = [...new Set(uniqueEdges.filter(edge => !isInternalImport(edge.to)).map(edge => packageNameFromImport(edge.to)))].sort()
  const internalEdges = uniqueEdges.filter(edge => isInternalImport(edge.to))

  return {
    edges: uniqueEdges.slice(0, 5_000),
    externalDependencies: externalDeps,
    internalEdgeCount: internalEdges.length,
    dynamicImportCount: uniqueEdges.filter(edge => edge.kind === 'dynamic-import').length
  }
}

function findMicroFrontendSignals(contents) {
  return {
    lifecycleExports: collectPatternEvidence(contents, [
      { id: 'bootstrap', regex: /export\s+(async\s+)?function\s+bootstrap\b/ },
      { id: 'mount', regex: /export\s+(async\s+)?function\s+mount\b/ },
      { id: 'unmount', regex: /export\s+(async\s+)?function\s+unmount\b/ }
    ], 80),
    qiankunUsage: collectPatternEvidence(contents, [
      { id: 'qiankun-package', regex: /from\s+['"`]qiankun['"`]|require\(['"`]qiankun['"`]\)/ },
      { id: 'register-micro-apps', regex: /\bregisterMicroApps\s*\(/ },
      { id: 'start-qiankun', regex: /\bstart\s*\(/ },
      { id: 'webpack-public-path', regex: /__webpack_public_path__/ }
    ], 120)
  }
}

function findQualitySignals(contents, snapshot) {
  const findings = [
    ...collectPatternEvidence(contents, [{ id: 'debugger', regex: /\bdebugger\b/ }], 200).map(toFinding('debugger', 'high')),
    ...collectPatternEvidence(contents, [{ id: 'console-log', regex: /\bconsole\.(log|debug|info)\s*\(/ }], 300).map(toFinding('console-log', 'medium')),
    ...collectPatternEvidence(contents, [{ id: 'todo', regex: /\b(TODO|FIXME|HACK)\b/i }], 200).map(toFinding('todo', 'low')),
    ...collectPatternEvidence(contents, [{ id: 'html-injection', regex: /\bv-html\b|innerHTML|dangerouslySetInnerHTML/ }], 200).map(toFinding('html-injection', 'high')),
    ...collectPatternEvidence(contents, [{ id: 'client-storage', regex: /\b(localStorage|sessionStorage|document\.cookie)\b/ }], 300).map(toFinding('client-storage', 'medium')),
    ...collectPatternEvidence(contents, [{ id: 'runtime-address', regex: /localhost|127\.0\.0\.1|qamp\.yeepay\.com|https?:\/\/[^'"`\s]+/i }], 200).map(toFinding('runtime-address', 'medium'))
  ]

  const tests = contents.filter(({ file }) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(file.relativePath) || /(^|\/)(__tests__|test|tests)\//.test(file.relativePath))
  const scripts = snapshot.package?.scripts ?? {}

  return {
    findingCounts: countBy(findings, finding => finding.ruleId),
    findings: findings.slice(0, 1_000),
    tests: {
      files: tests.map(item => item.file.relativePath).slice(0, 200),
      total: tests.length
    },
    scripts: {
      hasBuild: Boolean(scripts.build),
      hasLint: Boolean(scripts.lint),
      hasTest: Boolean(scripts.test),
      names: Object.keys(scripts)
    }
  }
}

function findUnknowns(files, contents, imports, routes) {
  const unknowns = []
  if (!files.some(file => file.relativePath === 'package.json')) unknowns.push('package.json not found')
  if (!routes.length) unknowns.push('route definitions not detected')
  if (imports.dynamicImportCount > 0) unknowns.push(`dynamic imports need runtime confirmation: ${imports.dynamicImportCount}`)
  if (!contents.some(({ file }) => /eslint/.test(file.relativePath))) unknowns.push('eslint config not detected')
  if (!files.some(file => LOCK_FILE_NAMES.has(file.relativePath))) unknowns.push('lockfile not detected')
  return unknowns
}

function createRepoWiki(snapshot, facts) {
  const findingRows = Object.entries(facts.qualitySignals.findingCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([rule, count]) => `| ${rule} | ${count} |`)
    .join('\n') || '| none | 0 |'
  const routeRows = facts.routes.slice(0, 30).map(route => `| ${escapeTable(route.path)} | ${route.kind} | ${route.evidence} |`).join('\n') || '| none | - | - |'
  const entryRows = facts.entrypoints.map(item => `| ${item.path} | ${item.kind} | ${item.evidence} |`).join('\n') || '| none | - | - |'
  const unknownRows = facts.unknowns.map(item => `- ${item}`).join('\n') || '- none'

  return `# Repo Wiki: ${snapshot.repo.name}

## Snapshot

| Field | Value |
| --- | --- |
| repo_id | ${snapshot.repo.id} |
| path | ${escapeTable(snapshot.repo.path)} |
| branch | ${snapshot.git.branch ?? 'unknown'} |
| commit | ${snapshot.git.commitSha ?? 'unknown'} |
| dirty | ${snapshot.git.dirtyState} |
| generated_at | ${snapshot.generatedAt} |

## Entrypoints

| Path | Kind | Evidence |
| --- | --- | --- |
${entryRows}

## Routes

| Route | Kind | Evidence |
| --- | --- | --- |
${routeRows}

## Dependencies

- External dependencies detected: ${facts.imports.externalDependencies.length}
- Internal import edges: ${facts.imports.internalEdgeCount}
- Dynamic imports: ${facts.imports.dynamicImportCount}

Top external dependencies:

${facts.imports.externalDependencies.slice(0, 40).map(item => `- ${item}`).join('\n') || '- none'}

## Quality Signals

| Rule | Count |
| --- | ---: |
${findingRows}

## Micro-frontend Signals

- lifecycle exports: ${facts.microFrontend.lifecycleExports.length}
- qiankun usage: ${facts.microFrontend.qiankunUsage.length}

## Parser Coverage

- total files: ${facts.parserCoverage.totalFiles}
- analyzable text files: ${facts.parserCoverage.analyzableTextFiles}
- analyzed files: ${facts.parserCoverage.analyzedFiles}
- skipped text files: ${facts.parserCoverage.skippedTextFiles}

## Unknowns

${unknownRows}
`
}

function createLineage(snapshot, facts, generatedAt, runId) {
  return {
    schemaVersion: 'code-repo-analyzer.lineage.v1',
    runId,
    generatedAt,
    skills: [
      {
        skillId: 'repo_snapshot_collect',
        inputRefs: [snapshot.repo.path],
        outputRefs: ['snapshot.json'],
        evidencePolicy: 'repo path + git commit + file hash'
      },
      {
        skillId: 'repo_static_analyze',
        inputRefs: ['snapshot.json'],
        outputRefs: ['static-facts.json'],
        evidencePolicy: 'file_path + line_number',
        confidenceSummary: `${facts.parserCoverage.analyzedFiles}/${facts.parserCoverage.analyzableTextFiles} analyzable files parsed`
      },
      {
        skillId: 'repo_wiki_build',
        inputRefs: ['snapshot.json', 'static-facts.json'],
        outputRefs: ['repo-wiki.md'],
        evidencePolicy: 'wiki section -> facts -> evidence'
      }
    ],
    missingEvidence: facts.unknowns,
    reviewState: 'not_reviewed'
  }
}

function createSummary(snapshot, facts, outDir) {
  return {
    repo: snapshot.repo.name,
    commit: snapshot.git.commitSha,
    outputDir: outDir,
    files: snapshot.fileManifest.total,
    analyzedFiles: facts.parserCoverage.analyzedFiles,
    routes: facts.routes.length,
    imports: facts.imports.edges.length,
    externalDependencies: facts.imports.externalDependencies.length,
    findings: facts.qualitySignals.findings.length,
    unknowns: facts.unknowns
  }
}

function collectPatternEvidence(contents, patterns, limit) {
  const results = []
  for (const content of contents) {
    for (const pattern of patterns) {
      for (let index = 0; index < content.lines.length; index += 1) {
        if (!pattern.regex.test(content.lines[index])) {
          pattern.regex.lastIndex = 0
          continue
        }
        pattern.regex.lastIndex = 0
        results.push({
          evidence: evidence(content.file.relativePath, index + 1),
          file: content.file.relativePath,
          id: pattern.id,
          preview: content.lines[index].trim().slice(0, 180)
        })
        if (results.length >= limit) return results
      }
    }
  }
  return results
}

function collectMatches(content, regex, limit) {
  const matches = []
  for (let index = 0; index < content.lines.length; index += 1) {
    const line = content.lines[index]
    regex.lastIndex = 0
    let match
    while ((match = regex.exec(line)) && matches.length < limit) {
      matches.push({
        line: index + 1,
        value: match[1] ?? match[0]
      })
    }
    if (matches.length >= limit) return matches
  }
  return matches
}

function toFinding(ruleId, severity) {
  return item => ({
    evidence: item.evidence,
    preview: item.preview,
    ruleId,
    severity
  })
}

function getGitSnapshot(repoPath) {
  if (!isGitRepo(repoPath)) {
    return {
      branch: null,
      commitSha: null,
      dirtyFiles: [],
      dirtyState: 'not-a-git-repo',
      remoteUrl: null
    }
  }

  const dirtyFiles = runGit(['status', '--short'], repoPath).split('\n').filter(Boolean)
  return {
    branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath) || null,
    commitSha: runGit(['rev-parse', 'HEAD'], repoPath) || null,
    dirtyFiles,
    dirtyState: dirtyFiles.length ? 'dirty' : 'clean',
    remoteUrl: runGit(['config', '--get', 'remote.origin.url'], repoPath) || null
  }
}

function isGitRepo(repoPath) {
  try {
    return Boolean(runGit(['rev-parse', '--is-inside-work-tree'], repoPath))
  } catch {
    return false
  }
}

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000
    }).trim()
  } catch {
    return ''
  }
}

function isAnalyzableTextFile(file) {
  const baseName = path.basename(file.relativePath)
  if (file.ext === '.json') return CONFIG_FILE_NAMES.has(baseName)
  return TEXT_EXTENSIONS.has(file.ext) || CONFIG_FILE_NAMES.has(baseName)
}

function hasBinaryControlChars(text) {
  return /[\u0000-\u0008\u000E-\u001F]/.test(text)
}

function detectPackageManager(lockFiles) {
  if (lockFiles.includes('pnpm-lock.yaml')) return 'pnpm'
  if (lockFiles.includes('yarn.lock')) return 'yarn'
  if (lockFiles.includes('package-lock.json')) return 'npm'
  if (lockFiles.includes('bun.lockb')) return 'bun'
  return 'unknown'
}

function pickDependencySignals(packageJson) {
  const merged = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {})
  }
  const interesting = ['@vitejs/plugin-react', 'axios', 'eslint', 'next', 'qiankun', 'react', 'react-dom', 'typescript', 'vite', 'vue', 'vue-router', 'webpack']
  return Object.fromEntries(interesting.filter(name => merged[name]).map(name => [name, merged[name]]))
}

async function readJsonIfExists(filePath) {
  const text = await readFile(filePath, 'utf8').catch(() => null)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

function evidence(filePath, line) {
  return `${filePath}:${line}`
}

function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'repo'
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function countBy(items, selector) {
  return items.reduce((counts, item) => {
    const key = selector(item) || 'unknown'
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
}

function uniqueBy(items, selector) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    const key = selector(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function isInternalImport(value) {
  return value.startsWith('.') || value.startsWith('/') || value.startsWith('@/') || value.startsWith('~/')
}

function packageNameFromImport(value) {
  if (value.startsWith('@')) return value.split('/').slice(0, 2).join('/')
  return value.split('/')[0]
}

function escapeTable(value) {
  return String(value).replace(/\|/g, '\\|')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
