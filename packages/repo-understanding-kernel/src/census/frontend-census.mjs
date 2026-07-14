import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildFrontendCensusProfile } from './frontend-census-profile.mjs'

export const SCHEMA = {
  inventory: 'repo-inventory/v1',
  codeMap: 'repo-code-map/v1',
  package: 'repo-frontend-census-package/v1',
}

const IGNORE_DIRS = new Set([
  '.cache',
  '.git',
  '.gradle',
  '.idea',
  '.mvn',
  '.next',
  '.nuxt',
  '.output',
  '.svn',
  '.turbo',
  '.venv',
  '.vscode',
  'build',
  'classes',
  'coverage',
  'dist',
  'logs',
  'node_modules',
  'out',
  'outputs',
  'target',
  'vendor',
])

const IGNORE_FILE_NAMES = new Set([
  '.DS_Store',
])

const TEXT_EXTS = new Set([
  '.c',
  '.cc',
  '.clj',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.gradle',
  '.graphql',
  '.groovy',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsp',
  '.jsx',
  '.kt',
  '.less',
  '.md',
  '.mjs',
  '.php',
  '.properties',
  '.proto',
  '.py',
  '.rb',
  '.rs',
  '.scala',
  '.scss',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
])

const RESOURCE_EXTS = new Set([
  '.cer',
  '.crt',
  '.jks',
  '.key',
  '.keystore',
  '.p12',
  '.pem',
  '.pfx',
])

const SENSITIVE_NAMES = new Set([
  '.env',
  '.envrc',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'secrets.json',
  'service-account.json',
  'serviceAccountKey.json',
])

const SENSITIVE_DIR_PATTERN = /(^|\/)(\.aws|\.azure|\.gcp|\.gnupg|\.ssh|auth|cert|certs|credential|credentials|key|keys|keystore|private|secret|secrets)(\/|$)/i
const SENSITIVE_FILE_PATTERN = /(^|[._-])(credential|credentials|passwords?|private[-_]?key|secrets?|tokens?)([._-]|$)/i
const SECRET_VALUE_PATTERN = /(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|credential|passwd|password|private[_-]?key|secret|token)\s*[:=]/i

const MAX_CONTENT_BYTES = 2_000_000
const TEXT_SAMPLE_BYTES = 8192

const MANIFEST_NAMES = new Set([
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'Makefile',
  'Procfile',
  'build.gradle',
  'go.mod',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'requirements.txt',
  'settings.gradle',
])

const CONFIG_NAMES = new Set([
  '.babelrc',
  '.browserslistrc',
  '.editorconfig',
  '.env',
  '.env.example',
  '.eslintrc',
  '.npmrc',
  '.prettierrc',
  'Dockerfile',
  'application.properties',
  'application.yml',
  'application.yaml',
  'log4j.properties',
  'log4j2.xml',
  'nginx.conf',
  'tsconfig.json',
  'web.xml',
])

const LANGUAGE_BY_EXT = {
  '.c': 'C',
  '.cc': 'C++',
  '.clj': 'Clojure',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.css': 'CSS',
  '.go': 'Go',
  '.gradle': 'Gradle',
  '.graphql': 'GraphQL',
  '.groovy': 'Groovy',
  '.h': 'C/C++ Header',
  '.hpp': 'C++ Header',
  '.html': 'HTML',
  '.java': 'Java',
  '.js': 'JavaScript',
  '.json': 'JSON',
  '.jsp': 'JSP',
  '.jsx': 'React',
  '.kt': 'Kotlin',
  '.less': 'Less',
  '.md': 'Markdown',
  '.mjs': 'JavaScript',
  '.php': 'PHP',
  '.properties': 'Properties',
  '.proto': 'Protocol Buffers',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.rs': 'Rust',
  '.scala': 'Scala',
  '.scss': 'SCSS',
  '.sh': 'Shell',
  '.sql': 'SQL',
  '.ts': 'TypeScript',
  '.tsx': 'React TS',
  '.vue': 'Vue',
  '.xml': 'XML',
  '.yaml': 'YAML',
  '.yml': 'YAML',
}

export function parseCommonArgs(argv, required = []) {
  const args = {}
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) throw new Error(`Unknown argument: ${key}`)
    const name = key.slice(2)
    if (name === 'help' || name === 'h') {
      args.help = true
      continue
    }
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args[name] = true
    } else {
      args[name] = next
      i += 1
    }
  }
  for (const key of required) {
    if (!args[key]) throw new Error(`Missing required --${key}`)
  }
  return args
}

export function defaultPackageDir(repoPath, outRoot = 'outputs/code-understanding') {
  return path.resolve(outRoot, safeId(path.basename(path.resolve(repoPath))))
}

export function prepareFrontendCensusPackage({ repoPath, outDir, maxFiles = 16000, maxBytes = 180000 }) {
  const root = path.resolve(repoPath)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Repository path does not exist: ${root}`)
  }
  const packageDir = path.resolve(outDir)
  const staticDir = path.join(packageDir, 'static')
  ensureDir(staticDir)

  const generatedAt = new Date().toISOString()
  const files = walkFiles(root, { maxFiles })
  const repo = repoMeta(root, generatedAt)
  const manifests = collectManifests(root, files)
  const directories = summarizeDirectories(files)
  const inventoryFiles = files.map(file => ({
    path: file.relativePath,
    size: file.size,
    lines: file.lines,
    hash: file.hash,
    hashKind: file.hashKind,
    language: file.language,
    category: file.category,
    binary: file.binary,
    large: file.large,
    contentAnalyzable: file.contentAnalyzable,
    protected: file.protected,
    protectionReason: file.protectionReason,
  }))
  const inventory = {
    schemaVersion: SCHEMA.inventory,
    generatedAt,
    repo,
    scan: {
      maxFiles,
      truncated: files.length >= maxFiles,
      clean: isGitSubtreeClean(root),
      dirtyFingerprint: gitDirtyFingerprint(root),
    },
    directories,
    manifests: manifests.map(manifestSummary),
    counts: {
      files: inventoryFiles.length,
      languages: countBy(inventoryFiles, 'language'),
      categories: countBy(inventoryFiles, 'category'),
    },
    files: inventoryFiles,
  }
  const snippets = readSelectedFiles(root, chooseKeyFiles(files, manifests), maxBytes)
  const codeMap = buildCodeMap(root, repo, files, manifests, snippets, generatedAt)
  const baselineProfile = buildFrontendCensusProfile({ repo, inventory, codeMap, generatedAt })
  const profile = {
    ...baselineProfile,
    producedBy: {
      ...baselineProfile.producedBy,
      mode: 'deterministic-census',
      generator: 'frontend-census',
    },
  }
  const profilePath = path.join(staticDir, 'repo-profile.json')
  writeJson(path.join(staticDir, 'inventory.json'), inventory)
  writeJson(path.join(staticDir, 'code-map.json'), codeMap)
  writeJson(profilePath, profile)

  const sourceFiles = files.filter(file => ['source', 'test', 'script', 'markup', 'config', 'data'].includes(file.category))
  const index = {
    schemaVersion: SCHEMA.package,
    generatedAt,
    repo,
    static: {
      inventory: 'static/inventory.json',
      codeMap: 'static/code-map.json',
      repoProfile: 'static/repo-profile.json',
    },
    products: {
      inventory: 'static/inventory.json',
      repoProfile: 'static/repo-profile.json',
    },
    counts: {
      files: files.length,
      sourceFiles: sourceFiles.length,
      protectedFiles: files.filter(file => file.protected).length,
      symbols: codeMap.symbols.length,
      imports: codeMap.imports.length,
      relationships: codeMap.relationships.length,
    },
  }
  writeJson(path.join(packageDir, 'index.json'), index)
  return {
    schemaVersion: 'repo-frontend-census/v1',
    generatedAt,
    packageDir,
    repo,
    profilePath,
    nextAction: 'analyze',
    counts: index.counts,
  }
}

function repoMeta(root, generatedAt) {
  const git = {
    branch: runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || null,
    head: runGit(root, ['rev-parse', '--short', 'HEAD']) || null,
    remote: runGit(root, ['remote', 'get-url', 'origin']) || null,
  }
  return {
    name: path.basename(root),
    path: root,
    generatedAt,
    git,
  }
}

function isGitSubtreeClean(root) {
  if (!runGit(root, ['rev-parse', '--is-inside-work-tree'])) return false
  return runGit(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.']) === ''
}

function gitDirtyFingerprint(root) {
  if (!runGit(root, ['rev-parse', '--is-inside-work-tree'])) return null
  const status = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.'])
  if (!status) return 'clean'
  const entries = status.split(/\r?\n/).filter(Boolean).map(line => {
    const statusCode = line.slice(0, 2)
    const rawPath = line.slice(3).trim()
    const relativePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) : rawPath
    const fullPath = path.resolve(root, relativePath)
    if (!fullPath.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(fullPath)) {
      return { status: statusCode, path: relativePath, state: 'missing' }
    }
    const stat = fs.statSync(fullPath)
    if (!stat.isFile()) return { status: statusCode, path: relativePath, state: 'non-file' }
    return {
      status: statusCode,
      path: relativePath,
      size: stat.size,
      contentHash: hashText(fs.readFileSync(fullPath)),
    }
  })
  return hashText(JSON.stringify(entries))
}

function walkFiles(root, { maxFiles }) {
  const files = []
  const stack = [root]
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop()
    const entries = safeReaddir(current).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (IGNORE_FILE_NAMES.has(entry.name)) continue
      const stat = fs.statSync(full)
      const rel = normalizePath(path.relative(root, full))
      const ext = path.extname(entry.name)
      const protectionReason = sensitiveProtectionReason(rel, entry.name, ext)
      const isProtected = Boolean(protectionReason)
      const isTextual = !isProtected && isTextualRepoFile(full, entry.name, ext, stat)
      const contentAnalyzable = !isProtected && isTextual && stat.size <= MAX_CONTENT_BYTES
      const text = contentAnalyzable ? safeRead(full) : ''
      files.push({
        absolutePath: full,
        relativePath: rel,
        name: entry.name,
        ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        lines: countLines(text),
        hash: isProtected ? hashMetadata(rel, stat) : hashFile(full),
        hashKind: isProtected ? 'metadata' : 'content',
        language: languageFor(entry.name, ext, isTextual),
        category: categorizeFile(rel, entry.name, ext, isTextual),
        binary: !isTextual,
        large: stat.size > MAX_CONTENT_BYTES,
        contentAnalyzable,
        protected: isProtected,
        protectionReason,
      })
      if (files.length >= maxFiles) break
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function buildCodeMap(root, repo, files, manifests, snippets, generatedAt) {
  const symbols = []
  const imports = []
  const annotations = []
  const routes = []
  const componentRefs = []
  const entrypoints = []
  const relationships = []
  const parseFailures = []

  for (const file of files) {
    if (!file.contentAnalyzable || file.category === 'resource') continue
    try {
      const text = safeRead(file.absolutePath)
      const extracted = extractFileSignals(file, text)
      symbols.push(...extracted.symbols)
      imports.push(...extracted.imports)
      annotations.push(...extracted.annotations)
      routes.push(...(extracted.routes || []))
      componentRefs.push(...(extracted.componentRefs || []))
      entrypoints.push(...extracted.entrypoints)
    } catch (err) {
      parseFailures.push({
        file: file.relativePath,
        message: err.message,
      })
    }
  }

  for (const manifest of manifests) {
    for (const dep of manifest.dependencies || []) {
      relationships.push({
        id: `rel:dependency:${safeId(manifest.path)}:${safeId(dep.name)}`,
        type: 'declares-dependency',
        from: `manifest:${manifest.path}`,
        to: `dependency:${dep.name}`,
        label: dep.scope ? `${dep.name} (${dep.scope})` : dep.name,
        evidenceRefs: [`evidence:manifest:${manifest.path}`],
      })
    }
    for (const moduleName of manifest.modules || []) {
      relationships.push({
        id: `rel:module:${safeId(manifest.path)}:${safeId(moduleName)}`,
        type: 'declares-module',
        from: `manifest:${manifest.path}`,
        to: `module:${moduleName}`,
        label: moduleName,
        evidenceRefs: [`evidence:manifest:${manifest.path}`],
      })
    }
  }

  for (const item of imports) {
    relationships.push({
      id: `rel:import:${safeId(item.file)}:${safeId(item.target)}:${item.line}`,
      type: 'imports',
      from: `file:${item.file}`,
      to: `external-or-file:${item.target}`,
      label: item.target,
      evidenceRefs: [`evidence:file:${item.file}`],
    })
  }

  const keyFiles = chooseKeyFiles(files, manifests).map(file => ({
    path: file.relativePath,
    category: file.category,
    language: file.language,
    reason: keyFileReason(file),
    snippetIncluded: Boolean(snippets[file.relativePath]),
  }))

  return {
    schemaVersion: SCHEMA.codeMap,
    generatedAt,
    repo,
    manifests: manifests.map(manifestSummary),
    entrypoints: dedupeBy(entrypoints, item => `${item.file}:${item.kind}:${item.name}`),
    symbols: dedupeBy(symbols, item => item.id),
    imports,
    annotations,
    routes: dedupeBy(routes, item => `${item.file}:${item.method}:${item.path}:${item.line}`),
    componentRefs: dedupeBy(componentRefs, item => `${item.file}:${item.name}:${item.line}`),
    dependencies: manifests.flatMap(manifest => manifest.dependencies || []),
    relationships: dedupeBy(relationships, item => item.id),
    keyFiles,
    metrics: {
      filesConsidered: files.length,
      symbolCount: symbols.length,
      importCount: imports.length,
      annotationCount: annotations.length,
      routeCount: routes.length,
      componentRefCount: componentRefs.length,
      parseFailureCount: parseFailures.length,
      parseFailureRate: round(parseFailures.length / Math.max(1, files.filter(file => file.contentAnalyzable && file.category !== 'resource').length), 3),
      parseFailures: parseFailures.slice(0, 50),
      manifestCount: manifests.length,
    },
  }
}

function collectManifests(root, files) {
  return files
    .filter(file => isManifestFile(file) && file.contentAnalyzable)
    .map(file => parseManifest(root, file))
    .filter(Boolean)
}

function parseManifest(root, file) {
  const text = safeRead(path.join(root, file.relativePath))
  if (file.name === 'package.json') {
    try {
      const pkg = JSON.parse(text)
      return {
        type: 'npm',
        path: file.relativePath,
        name: pkg.name || path.basename(root),
        version: pkg.version || null,
        scripts: pkg.scripts || {},
        dependencies: Object.entries({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })
          .map(([name, version]) => ({ name, version: String(version), scope: pkg.dependencies?.[name] ? 'runtime' : 'dev', path: file.relativePath })),
      }
    } catch {
      return null
    }
  }
  if (file.name === 'pom.xml') {
    const artifactId = firstXmlValue(text, 'artifactId')
    const groupId = firstXmlValue(text, 'groupId')
    const version = firstXmlValue(text, 'version')
    const modules = allXmlValues(text, 'module')
    const dependencies = [...text.matchAll(/<dependency>[\s\S]*?<\/dependency>/g)].map(match => ({
      groupId: firstXmlValue(match[0], 'groupId'),
      name: firstXmlValue(match[0], 'artifactId') || 'unknown',
      version: firstXmlValue(match[0], 'version'),
      scope: firstXmlValue(match[0], 'scope') || 'runtime',
      path: file.relativePath,
    }))
    return {
      type: 'maven',
      path: file.relativePath,
      name: artifactId || path.basename(root),
      groupId,
      version,
      packaging: firstXmlValue(text, 'packaging') || null,
      modules,
      dependencies,
    }
  }
  if (file.name === 'go.mod') {
    const moduleName = text.match(/^module\s+(.+)$/m)?.[1]?.trim()
    const dependencies = [...text.matchAll(/^\s*(?:require\s+)?([A-Za-z0-9_.:/-]+)\s+v[^\s]+/gm)]
      .map(match => ({ name: match[1], scope: 'runtime', path: file.relativePath }))
    return { type: 'go', path: file.relativePath, name: moduleName || path.basename(root), dependencies }
  }
  if (file.name === 'Cargo.toml') {
    const dependencies = [...text.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"[^"]+"|\{[^\n]+)$/gm)]
      .map(match => ({ name: match[1], scope: 'runtime', path: file.relativePath }))
    return { type: 'cargo', path: file.relativePath, name: text.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] || path.basename(root), dependencies }
  }
  if (file.name === 'build.gradle' || file.name === 'settings.gradle') {
    const dependencies = [...text.matchAll(/(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s+['"]([^:'"]+):([^:'"]+):?([^'"]*)['"]/g)]
      .map(match => ({ groupId: match[1], name: match[2], version: match[3] || null, scope: 'runtime', path: file.relativePath }))
    return { type: 'gradle', path: file.relativePath, name: text.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/)?.[1] || path.basename(root), dependencies }
  }
  if (file.name === 'pyproject.toml') {
    const dependencies = [
      ...tomlArrayValues(text, 'dependencies'),
      ...tomlPoetryDependencies(text),
    ].map(name => ({ name, scope: 'runtime', path: file.relativePath }))
    return { type: 'python', path: file.relativePath, name: text.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] || path.basename(root), dependencies }
  }
  if (file.name === 'requirements.txt') {
    const dependencies = text.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('-'))
      .map(line => ({ name: line.split(/[<>=~! ]/)[0], scope: 'runtime', path: file.relativePath }))
    return { type: 'python', path: file.relativePath, name: path.basename(root), dependencies }
  }
  if (file.name === 'Gemfile') {
    const dependencies = [...text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)]
      .map(match => ({ name: match[1], scope: 'runtime', path: file.relativePath }))
    return { type: 'bundler', path: file.relativePath, name: path.basename(root), dependencies }
  }
  if (file.name === 'composer.json') {
    try {
      const composer = JSON.parse(text)
      const dependencies = Object.entries({ ...(composer.require || {}), ...(composer['require-dev'] || {}) })
        .filter(([name]) => name !== 'php')
        .map(([name, version]) => ({ name, version: String(version), scope: composer.require?.[name] ? 'runtime' : 'dev', path: file.relativePath }))
      return { type: 'composer', path: file.relativePath, name: composer.name || path.basename(root), dependencies }
    } catch {
      return null
    }
  }
  if (/\.csproj$/i.test(file.name)) {
    const dependencies = [...text.matchAll(/<PackageReference[^>]+Include=["']([^"']+)["'][^>]*(?:Version=["']([^"']+)["'])?/g)]
      .map(match => ({ name: match[1], version: match[2] || null, scope: 'runtime', path: file.relativePath }))
    return { type: 'dotnet', path: file.relativePath, name: firstXmlValue(text, 'AssemblyName') || file.name.replace(/\.csproj$/i, ''), dependencies }
  }
  return { type: 'generic', path: file.relativePath, name: path.basename(root), dependencies: [] }
}

function isManifestFile(file) {
  return MANIFEST_NAMES.has(file.name) || /\.csproj$/i.test(file.name)
}

function tomlArrayValues(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'))
  if (!match) return []
  return [...match[1].matchAll(/["']([^"']+)["']/g)]
    .map(item => packageNameFromRequirement(item[1]))
    .filter(Boolean)
}

function tomlPoetryDependencies(text) {
  const section = text.match(/^\s*\[tool\.poetry\.dependencies\]\s*$([\s\S]*?)(?=^\s*\[|$)/m)?.[1] || ''
  return section.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('python'))
    .map(line => packageNameFromRequirement(line.split('=')[0]))
    .filter(Boolean)
}

function packageNameFromRequirement(value) {
  return String(value || '').trim().split(/[<>=~! ;\[]/)[0]
}

function extractFileSignals(file, text) {
  const lines = text.split(/\r?\n/)
  const jsRouteContext = isJsRouteConfigFile(file.relativePath, text)
  const symbols = []
  const imports = []
  const annotations = []
  const routes = []
  const componentRefs = []
  const entrypoints = []
  const packageName = file.ext === '.java' ? text.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] : null

  lines.forEach((line, index) => {
    const lineNo = index + 1
    const trimmed = line.trim()
    const pushSymbol = (kind, name, signature = trimmed) => {
      symbols.push({
        id: `symbol:${file.relativePath}:${kind}:${name}:${lineNo}`,
        file: file.relativePath,
        kind,
        name,
        signature: signature.slice(0, 240),
        line: lineNo,
        package: packageName,
        evidenceRefs: [`evidence:file:${file.relativePath}`],
      })
    }

    if (file.ext === '.java') {
      const importMatch = trimmed.match(/^import\s+(?:static\s+)?([\w.*]+)\s*;/)
      if (importMatch) imports.push(importRecord(file, importMatch[1], lineNo, 'java-import'))
      const typeMatch = trimmed.match(/\b(class|interface|enum|record)\s+([A-Za-z_][\w]*)/)
      if (typeMatch) pushSymbol(typeMatch[1], typeMatch[2])
      const methodMatch = trimmed.match(/(?:public|protected|private|static|final|synchronized|abstract|\s)+[\w<>\[\], ?]+\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?:throws\s+[\w, ]+)?\s*\{?$/)
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'return', 'new'].includes(methodMatch[1])) pushSymbol('method', methodMatch[1])
      const annotationMatch = trimmed.match(/^@([A-Za-z_][\w.]*)(?:\((.*)\))?/)
      if (annotationMatch) {
        annotations.push({ file: file.relativePath, name: annotationMatch[1], value: (annotationMatch[2] || '').slice(0, 200), line: lineNo })
        const annotationName = annotationMatch[1].split('.').pop()
        if (/^(SpringBootApplication|Controller|RestController|Service|Component|Repository|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|DubboService|DubboReference|Resource)$/.test(annotationName)) {
          entrypoints.push({ file: file.relativePath, kind: 'java-annotation', name: annotationMatch[1], line: lineNo })
        }
        const routePath = routePathFromAnnotation(annotationName, annotationMatch[2] || '')
        if (routePath) {
          routes.push({ file: file.relativePath, path: routePath, method: routeMethodFromAnnotation(annotationName), kind: 'java-annotation', line: lineNo })
        }
      }
      if (/public\s+static\s+void\s+main\s*\(/.test(trimmed)) entrypoints.push({ file: file.relativePath, kind: 'main-method', name: 'main', line: lineNo })
    } else if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.vue'].includes(file.ext)) {
      for (const dynamicMatch of trimmed.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        imports.push(importRecord(file, dynamicMatch[1], lineNo, 'js-dynamic-import'))
      }
      const importMatch = trimmed.match(/^import\s+.*?\s+from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/)
      if (importMatch) imports.push(importRecord(file, importMatch[1] || importMatch[2] || importMatch[3], lineNo, 'js-import'))
      const classMatch = trimmed.match(/\bclass\s+([A-Za-z_][\w]*)/)
      if (classMatch) pushSymbol('class', classMatch[1])
      const functionMatch = trimmed.match(/\b(?:function\s+([A-Za-z_][\w]*)|const\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?\(|export\s+function\s+([A-Za-z_][\w]*))/)
      if (functionMatch) pushSymbol('function', functionMatch[1] || functionMatch[2] || functionMatch[3])
      const routeMatch = jsRouteContext ? trimmed.match(/\bpath\s*:\s*['"]([^'"]+)['"]/) : null
      if (routeMatch) routes.push({ file: file.relativePath, path: routeMatch[1], method: undefined, kind: 'js-route-config', line: lineNo })
      if (file.ext === '.vue') {
        for (const tagMatch of trimmed.matchAll(/<([A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*-[a-z0-9-]+)\b/g)) {
          componentRefs.push({ file: file.relativePath, name: tagMatch[1], line: lineNo })
        }
      }
    } else if (file.ext === '.py') {
      const importMatch = trimmed.match(/^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/)
      if (importMatch) imports.push(importRecord(file, importMatch[1] || importMatch[2], lineNo, 'python-import'))
      const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/)
      if (defMatch) pushSymbol('function', defMatch[1])
      const classMatch = trimmed.match(/^class\s+([A-Za-z_][\w]*)/)
      if (classMatch) pushSymbol('class', classMatch[1])
    } else if (file.ext === '.go') {
      const importMatch = trimmed.match(/^import\s+"([^"]+)"$/) || trimmed.match(/^"([^"]+)"$/)
      if (importMatch) imports.push(importRecord(file, importMatch[1], lineNo, 'go-import'))
      const funcMatch = trimmed.match(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/)
      if (funcMatch) pushSymbol('function', funcMatch[1])
      const typeMatch = trimmed.match(/^type\s+([A-Za-z_][\w]*)\s+(struct|interface)/)
      if (typeMatch) pushSymbol(typeMatch[2], typeMatch[1])
    } else if (file.ext === '.rs') {
      const useMatch = trimmed.match(/^use\s+([^;]+);/)
      if (useMatch) imports.push(importRecord(file, useMatch[1], lineNo, 'rust-use'))
      const itemMatch = trimmed.match(/^(?:pub\s+)?(fn|struct|enum|trait)\s+([A-Za-z_][\w]*)/)
      if (itemMatch) pushSymbol(itemMatch[1], itemMatch[2])
    } else if (file.ext === '.xml') {
      const beanMatch = trimmed.match(/<(?:bean|service|dubbo:service|dubbo:reference)\b[^>]*(?:id|interface|class)=["']([^"']+)["']/)
      if (beanMatch) pushSymbol('xml-component', beanMatch[1])
    }
  })

  return { symbols, imports, annotations, routes, componentRefs, entrypoints }
}

function isJsRouteConfigFile(filePath, text) {
  if (isMockOrFixturePath(filePath)) return false
  if (!/(^|\/)(router|routes?|.*router.*|.*routes?)\.(js|jsx|ts|tsx|mjs)$|(^|\/)(router|routes?)\//i.test(filePath)) return false
  if (!/\b(component|children|routes|createRouter|new\s+Router)\b/.test(text)) return false
  return true
}

function isMockOrFixturePath(filePath) {
  return /(^|\/)(__mocks__|mocks?|fixtures?)(\/|$)/i.test(filePath)
}

function chooseKeyFiles(files, manifests) {
  const manifestPaths = new Set(manifests.map(item => item.path))
  const scored = files.map(file => {
    let score = 0
    if (manifestPaths.has(file.relativePath)) score += 100
    if (/readme/i.test(file.name)) score += 90
    if (/application|bootstrap|config|web\.xml|spring|dubbo|route|router|controller|service|facade|api|handler|main/i.test(file.relativePath)) score += 60
    if (file.category === 'source') score += 20
    if (file.category === 'config') score += 30
    if (file.category === 'docs') score += 30
    if (file.lines > 20 && file.lines < 800) score += 10
    if (file.lines >= 1200) score -= 20
    return { file, score }
  })
  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath))
    .slice(0, 60)
    .map(item => item.file)
}

function readSelectedFiles(root, files, maxBytes) {
  const snippets = {}
  let used = 0
  for (const file of files) {
    if (!file.contentAnalyzable || file.category === 'resource') continue
    if (used >= maxBytes) break
    const text = safeRead(path.join(root, file.relativePath))
    const sanitized = sanitizeSnippet(text)
    const snippet = sanitized.slice(0, Math.min(sanitized.length, 2600))
    snippets[file.relativePath] = snippet
    used += snippet.length
  }
  return snippets
}

function summarizeDirectories(files) {
  const dirs = new Map()
  for (const file of files) {
    const top = file.relativePath.includes('/') ? file.relativePath.split('/')[0] : '.'
    const record = dirs.get(top) || { path: top, files: 0, categories: {}, languages: {} }
    record.files += 1
    record.categories[file.category] = (record.categories[file.category] || 0) + 1
    record.languages[file.language] = (record.languages[file.language] || 0) + 1
    dirs.set(top, record)
  }
  return [...dirs.values()].sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
}

function categorizeFile(rel, name, ext, isTextual = true) {
  if (sensitiveProtectionReason(rel, name, ext)) return 'protected'
  if (MANIFEST_NAMES.has(name)) return 'manifest'
  if (isEvidenceResource(rel, name, ext)) return 'resource'
  if (/README|CHANGELOG|CONTRIBUTING|\.md$/i.test(name) || ext === '.md') return 'docs'
  if (CONFIG_NAMES.has(name) || /(^|\/)(config|conf|resources)\//i.test(rel) || ['.yaml', '.yml', '.properties', '.xml', '.json'].includes(ext)) return 'config'
  if (/\.(test|spec)\.|(^|\/)(test|tests|__tests__)\//i.test(rel) || /src\/test\//.test(rel)) return 'test'
  if (ext === '.sql' || /(^|\/)(db|sql|migration|migrations)\//i.test(rel)) return 'data'
  if (['.sh', '.gradle'].includes(ext) || /^Makefile$/i.test(name)) return 'script'
  if (['.html', '.jsp', '.css', '.scss', '.less'].includes(ext)) return 'markup'
  if (!isTextual) return 'resource'
  return 'source'
}

function languageFor(name, ext, isTextual = true) {
  if (SENSITIVE_NAMES.has(name) || RESOURCE_EXTS.has(ext)) return 'Protected Metadata'
  if (name === 'pom.xml') return 'Maven XML'
  if (name === 'package.json') return 'NPM JSON'
  if (name === 'composer.json') return 'Composer JSON'
  if (name === 'pyproject.toml') return 'Python Project'
  if (name === 'requirements.txt') return 'Python Requirements'
  if (name === 'go.mod') return 'Go Module'
  if (name === 'Cargo.toml') return 'Cargo TOML'
  if (name === 'build.gradle' || name === 'settings.gradle') return 'Gradle'
  if (/\.csproj$/i.test(name)) return 'MSBuild XML'
  if (name === 'Makefile') return 'Makefile'
  if (name === 'Gemfile') return 'Ruby Bundler'
  if (name === 'Procfile') return 'Procfile'
  if (!isTextual) return 'Binary Resource'
  if (RESOURCE_EXTS.has(ext)) return 'Binary Resource'
  return LANGUAGE_BY_EXT[ext] || 'Text'
}

function keyFileReason(file) {
  if (file.category === 'protected') return 'protected metadata-only file'
  if (file.category === 'manifest') return 'manifest'
  if (file.category === 'docs') return 'documentation'
  if (file.category === 'resource') return 'metadata-only resource'
  if (/controller|service|facade|api|handler|main|application/i.test(file.relativePath)) return 'likely entry or domain component'
  if (file.category === 'config') return 'configuration'
  return 'representative source'
}

function importRecord(file, target, line, kind) {
  return { file: file.relativePath, target, line, kind, evidenceRefs: [`evidence:file:${file.relativePath}`] }
}

function routePathFromAnnotation(annotationName, value) {
  if (!isSpringRouteMappingAnnotation(annotationName)) return ''
  const text = String(value || '')
  const match = text.match(/(?:value\s*=\s*)?["']([^"']+)["']/)
  return match?.[1] || ''
}

function isSpringRouteMappingAnnotation(annotationName) {
  return /^(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)$/.test(annotationName)
}

function routeMethodFromAnnotation(annotationName) {
  if (annotationName === 'GetMapping') return 'GET'
  if (annotationName === 'PostMapping') return 'POST'
  if (annotationName === 'PutMapping') return 'PUT'
  if (annotationName === 'DeleteMapping') return 'DELETE'
  if (annotationName === 'PatchMapping') return 'PATCH'
  return undefined
}

function countBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item[field] || 'Unknown'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0
  return Number(value.toFixed(digits))
}

function manifestSummary(manifest) {
  return {
    type: manifest.type,
    path: manifest.path,
    name: manifest.name,
    groupId: manifest.groupId,
    version: manifest.version,
    packaging: manifest.packaging,
    moduleCount: manifest.modules?.length || 0,
    dependencyCount: manifest.dependencies?.length || 0,
    modules: manifest.modules || [],
    scripts: manifest.scripts || undefined,
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function safeReadSample(file, bytes = TEXT_SAMPLE_BYTES) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.allocUnsafe(bytes)
      const read = fs.readSync(fd, buffer, 0, bytes, 0)
      return buffer.subarray(0, read)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return Buffer.alloc(0)
  }
}

function isTextualRepoFile(file, name, ext, stat) {
  if (TEXT_EXTS.has(ext) || MANIFEST_NAMES.has(name) || CONFIG_NAMES.has(name)) return true
  if (stat.size === 0) return true
  return looksTextualBuffer(safeReadSample(file, Math.min(TEXT_SAMPLE_BYTES, stat.size)))
}

function looksTextualBuffer(buffer) {
  if (!buffer.length) return true
  let suspicious = 0
  for (const byte of buffer) {
    if (byte === 0) return false
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte >= 32) continue
    suspicious += 1
  }
  return suspicious / buffer.length < 0.05
}

function isEvidenceResource(rel, name, ext) {
  return RESOURCE_EXTS.has(ext) || /(^|\/)(cert|certs|keystore|keys)\//i.test(rel) || /\.(keystore)$/i.test(name)
}

function sensitiveProtectionReason(rel, name, ext) {
  if (SENSITIVE_NAMES.has(name) || /^\.env(?:\.|$)/.test(name)) return 'sensitive filename'
  if (RESOURCE_EXTS.has(ext)) return 'protected credential/certificate extension'
  if (SENSITIVE_DIR_PATTERN.test(rel)) return 'sensitive directory'
  if (SENSITIVE_FILE_PATTERN.test(name)) return 'sensitive-looking filename'
  return ''
}

function sanitizeSnippet(text) {
  return text
    .split(/\r?\n/)
    .map(line => (SECRET_VALUE_PATTERN.test(line) ? redactSecretLine(line) : line))
    .join('\n')
}

function redactSecretLine(line) {
  const separator = line.includes('=') ? '=' : ':'
  const index = line.indexOf(separator)
  if (index === -1) return '[REDACTED_SECRET_LINE]'
  return `${line.slice(0, index + 1)} [REDACTED]`
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function runGit(repoDir, args) {
  const res = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', timeout: 5000 })
  return res.status === 0 ? res.stdout.trim() : ''
}

function hashText(text) {
  return createHash('sha1').update(text).digest('hex')
}

function hashFile(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const hash = createHash('sha1')
    const buffer = Buffer.allocUnsafe(65536)
    try {
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, null)
        if (!read) break
        hash.update(buffer.subarray(0, read))
      }
    } finally {
      fs.closeSync(fd)
    }
    return hash.digest('hex')
  } catch {
    return hashText('')
  }
}

function hashMetadata(rel, stat) {
  return hashText(`${rel}:${stat.size}:${Math.round(stat.mtimeMs)}`)
}

function countLines(text) {
  if (!text) return 0
  return text.split(/\r?\n/).length
}

function safeId(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

function normalizePath(value) {
  return value.split(path.sep).join('/')
}

function firstXmlValue(text, tag) {
  return text.match(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`))?.[1]?.trim() || null
}

function allXmlValues(text, tag) {
  return [...text.matchAll(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, 'g'))].map(match => match[1].trim())
}

function dedupeBy(items, keyFn) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}
