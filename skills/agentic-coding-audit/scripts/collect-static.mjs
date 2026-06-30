#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SOURCE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.vue', '.json', '.css', '.scss', '.less', '.html', '.md', '.yml', '.yaml'])
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.next', '.nuxt', 'docs'])
const ISSUE_RULES = [
  { id: 'console-log', pattern: /\bconsole\.log\s*\(/ },
  { id: 'debugger', pattern: /\bdebugger\b/ },
  { id: 'dom-html-injection', pattern: /\b(innerHTML|outerHTML)\b|v-html\s*=/ },
  { id: 'url-token', pattern: /[?&](token|access_token|ticket|sessionId)=/i },
  { id: 'browser-storage-auth', pattern: /\b(localStorage|sessionStorage|document\.cookie)\b/ },
  { id: 'non-prod-url', pattern: /\b(localhost|127\.0\.0\.1|qa-|test-|sit-|uat-)/i },
  { id: 'todo-marker', pattern: /\b(TODO|FIXME|HACK)\b/ },
]

function usage() {
  console.error('Usage: node scripts/collect-static.mjs --workspace /path/to/workspace (--out /path/to/coding-pool | --datasource /path/to/datasource) [--max-files 8000]')
  process.exit(1)
}

function parseArgs(argv) {
  const args = { maxFiles: 8000 }
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--workspace') {
      args.workspace = value
      i += 1
    } else if (key === '--datasource') {
      args.datasource = value
      i += 1
    } else if (key === '--out') {
      args.out = value
      i += 1
    } else if (key === '--max-files') {
      args.maxFiles = Number(value)
      i += 1
    } else {
      usage()
    }
  }
  if (args.datasource && !args.out) args.out = path.join(path.resolve(args.datasource), 'pools', 'coding')
  if (!args.workspace || !args.out || !Number.isFinite(args.maxFiles)) usage()
  args.workspace = path.resolve(args.workspace)
  args.out = path.resolve(args.out)
  if (args.datasource) args.datasource = path.resolve(args.datasource)
  return args
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function safeReaddir(dir, opts = {}) {
  try {
    return fs.readdirSync(dir, opts)
  } catch {
    return []
  }
}

function runGit(repoDir, args) {
  const res = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', timeout: 5000 })
  if (res.status !== 0) return ''
  return res.stdout.trim()
}

function listRepoDirs(workspace) {
  return safeReaddir(workspace, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !EXCLUDED_DIRS.has(entry.name))
    .map(entry => path.join(workspace, entry.name))
    .filter(dir => fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json')))
    .sort()
}

function detectStack(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const stack = []
  if (deps.react) stack.push('React')
  if (deps.vue) stack.push(String(deps.vue).startsWith('^3') || String(deps.vue).startsWith('3') ? 'Vue 3' : 'Vue')
  if (deps.vite) stack.push('Vite')
  if (deps.webpack || deps['@vue/cli-service']) stack.push('Webpack')
  if (deps.typescript) stack.push('TypeScript')
  if (deps.qiankun || deps['single-spa']) stack.push('Micro Frontend')
  if (!stack.length) stack.push('Unknown')
  return stack
}

function countRoutes(text) {
  const matches = text.match(/\b(path|route|routes)\s*[:=]/g)
  return matches ? matches.length : 0
}

function walkFiles(root, maxFiles) {
  const files = []
  const stack = [root]
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop()
    for (const entry of safeReaddir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) stack.push(fullPath)
      } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) {
        files.push(fullPath)
        if (files.length >= maxFiles) break
      }
    }
  }
  return files.sort()
}

function scanSource(repoDir, maxFiles) {
  const files = walkFiles(repoDir, maxFiles)
  const extensionCounts = {}
  const issueCounts = Object.fromEntries(ISSUE_RULES.map(rule => [rule.id, 0]))
  const issueExamples = []
  let routeCount = 0
  let testFileCount = 0

  for (const file of files) {
    const ext = path.extname(file) || 'none'
    extensionCounts[ext] = (extensionCounts[ext] || 0) + 1
    const rel = path.relative(repoDir, file)
    if (/\.(test|spec)\.|(__tests__|tests?)\//i.test(rel)) testFileCount += 1

    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    routeCount += countRoutes(text)
    const lines = text.split(/\r?\n/)
    for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
      const line = lines[lineNo]
      for (const rule of ISSUE_RULES) {
        if (rule.pattern.test(line)) {
          issueCounts[rule.id] += 1
          if (issueExamples.length < 80) {
            issueExamples.push({
              ruleId: rule.id,
              file: rel,
              line: lineNo + 1,
              snippet: line.trim().slice(0, 180),
            })
          }
        }
        rule.pattern.lastIndex = 0
      }
    }
  }

  return {
    filesScanned: files.length,
    extensionCounts,
    routeCount,
    testFileCount,
    issueCounts,
    issueExamples,
  }
}

function copyPackageJson(repoDir, repoName, outDir) {
  const source = path.join(repoDir, 'package.json')
  if (!fs.existsSync(source)) return null
  const targetRel = path.posix.join('raw', 'repositories', repoName, 'package.json')
  const target = path.join(outDir, targetRel)
  ensureDir(path.dirname(target))
  fs.copyFileSync(source, target)
  return targetRel
}

function lockFiles(repoDir) {
  return ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']
    .filter(file => fs.existsSync(path.join(repoDir, file)))
}

function detectUiDeps(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  return Object.keys(deps).filter(name => /antd|element|arco|radix|mui|chakra|tailwind|bootstrap|vant|naive-ui|shadcn/i.test(name)).sort()
}

function buildRepoFact(repoDir, workspace, outDir, maxFiles) {
  const name = path.basename(repoDir)
  const pkg = readJson(path.join(repoDir, 'package.json')) || {}
  const packageRef = copyPackageJson(repoDir, name, outDir)
  const sourceScan = scanSource(repoDir, maxFiles)
  const sourceScanRel = path.posix.join('raw', 'repositories', name, 'source-scan.json')
  writeJson(path.join(outDir, sourceScanRel), sourceScan)

  const evidenceRefs = [
    packageRef && `evidence:raw:${packageRef}`,
    `evidence:raw:${sourceScanRel}`,
  ].filter(Boolean)

  return {
    id: `repo:${name}`,
    name,
    path: path.relative(workspace, repoDir) || '.',
    local: true,
    gitRemote: runGit(repoDir, ['remote', 'get-url', 'origin']) || undefined,
    gitBranch: runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']) || undefined,
    gitHead: runGit(repoDir, ['rev-parse', '--short', 'HEAD']) || undefined,
    packageName: pkg.name,
    version: pkg.version,
    stack: detectStack(pkg),
    ui: detectUiDeps(pkg),
    scripts: pkg.scripts || {},
    deps: pkg.dependencies || {},
    devDeps: pkg.devDependencies || {},
    lockFiles: lockFiles(repoDir),
    sourceStats: {
      filesScanned: sourceScan.filesScanned,
      extensionCounts: sourceScan.extensionCounts,
      routeCount: sourceScan.routeCount,
      testFileCount: sourceScan.testFileCount,
    },
    qualitySignals: {
      issueCounts: sourceScan.issueCounts,
      issueExamples: sourceScan.issueExamples,
    },
    evidenceRefs,
  }
}

function inferPackageRelationships(repos) {
  const byPackage = new Map(repos.filter(repo => repo.packageName).map(repo => [repo.packageName, repo]))
  const edges = []
  for (const repo of repos) {
    for (const dep of Object.keys(repo.deps || {})) {
      const target = byPackage.get(dep)
      if (target && target.id !== repo.id) {
        edges.push({
          id: `rel:package:${repo.name}->${target.name}`,
          type: 'package-dependency',
          from: repo.id,
          to: target.id,
          label: dep,
          evidenceRefs: repo.evidenceRefs.filter(ref => ref.includes('package.json')),
        })
      }
    }
  }
  return edges
}

function listFiles(root) {
  const result = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of safeReaddir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) result.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  return result.sort()
}

function main() {
  const args = parseArgs(process.argv)
  const startedAt = new Date().toISOString()
  const rawDir = path.join(args.out, 'raw')
  const factsDir = path.join(args.out, 'facts')
  ensureDir(rawDir)
  ensureDir(factsDir)
  ensureDir(path.join(args.out, 'analyses'))
  ensureDir(path.join(args.out, 'exports'))

  const repoDirs = listRepoDirs(args.workspace)
  const repos = repoDirs.map(repoDir => buildRepoFact(repoDir, args.workspace, args.out, args.maxFiles))
  const relationships = inferPackageRelationships(repos)
  const findings = repos.flatMap(repo => Object.entries(repo.qualitySignals.issueCounts)
    .filter(([, count]) => count > 0)
    .map(([ruleId, count]) => ({
      id: `finding:${repo.name}:${ruleId}`,
      subject: { type: 'repo', id: repo.id },
      category: ruleId.includes('token') || ruleId.includes('html') || ruleId.includes('storage') ? 'security' : 'engineering',
      severity: count > 50 ? 'high' : count > 10 ? 'medium' : 'low',
      title: `${ruleId} detected`,
      description: `${count} occurrence(s) detected by static source scan.`,
      evidenceRefs: repo.evidenceRefs,
    })))

  const completedAt = new Date().toISOString()
  const run = {
    id: `run:collect-static:${completedAt}`,
    startedAt,
    completedAt,
    producedBy: 'script',
    command: process.argv.join(' '),
    inputRefs: [args.workspace],
    outputRefs: ['facts/repositories.json', 'facts/relationships.json', 'facts/findings.json'],
  }

  writeJson(path.join(factsDir, 'repositories.json'), repos)
  writeJson(path.join(factsDir, 'relationships.json'), relationships)
  writeJson(path.join(factsDir, 'findings.json'), findings)
  writeJson(path.join(factsDir, 'runs.json'), [run])
  writeJson(path.join(args.out, 'index.json'), {
    schemaVersion: 'coding-pool/v1',
    generatedAt: completedAt,
    workspace: {
      root: args.workspace,
      name: path.basename(args.workspace),
      detectedAt: startedAt,
    },
    layers: {
      raw: { path: 'raw', summary: 'Raw package and source scan evidence' },
      facts: { path: 'facts', summary: 'Normalized repository, relationship, and finding facts' },
      analyses: { path: 'analyses', summary: 'Codex, subagent, or human analysis records' },
      exports: { path: 'exports', summary: 'Derived board or report exports' },
    },
    counts: {
      repositories: repos.length,
      relationships: relationships.length,
      findings: findings.length,
      agentAnalyses: 0,
    },
    files: listFiles(args.out),
  })

  console.log(`Collected ${repos.length} repositories, ${relationships.length} relationships, and ${findings.length} findings into ${args.out}`)
}

main()
