#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const EVALUATION_FRAMEWORK = [
  { id: 'architecture', name: 'Architecture contract', weight: 0.18 },
  { id: 'engineering', name: 'Engineering quality gate', weight: 0.20 },
  { id: 'security', name: 'Application security', weight: 0.22 },
  { id: 'stability', name: 'Reliability', weight: 0.16 },
  { id: 'experience', name: 'Experience and accessibility', weight: 0.12 },
  { id: 'business', name: 'Business criticality', weight: 0.12 },
]

function usage() {
  console.error('Usage: node scripts/export-audit-data.mjs (--pool /path/to/coding-pool --out /path/to/audit-data.json | --datasource /path/to/datasource [--out /path/to/audit-data.json])')
  process.exit(1)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--pool') {
      args.pool = path.resolve(argv[i + 1])
      i += 1
    } else if (argv[i] === '--datasource') {
      args.datasource = path.resolve(argv[i + 1])
      args.pool = path.join(args.datasource, 'pools', 'coding')
      if (!args.out) args.out = path.join(args.datasource, 'exports', 'audit-board', 'audit-data.json')
      i += 1
    } else if (argv[i] === '--out') {
      args.out = path.resolve(argv[i + 1])
      i += 1
    } else {
      usage()
    }
  }
  if (!args.pool || !args.out) usage()
  return args
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function clamp(value) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function grade(score) {
  if (score >= 85) return 'A'
  if (score >= 75) return 'B'
  if (score >= 65) return 'C'
  if (score >= 50) return 'D'
  return 'E'
}

function risk(score) {
  if (score >= 75) return 'low'
  if (score >= 60) return 'medium'
  if (score >= 45) return 'high'
  return 'critical'
}

function scoreRepo(repo, findings, analyses) {
  const counts = repo.qualitySignals?.issueCounts || {}
  const issueTotal = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0)
  const securityTotal = Number(counts['url-token'] || 0) + Number(counts['dom-html-injection'] || 0) + Number(counts['browser-storage-auth'] || 0)
  const hasLint = Boolean(repo.qualitySignals?.lint)
  const hasBuildScript = Boolean(repo.scripts?.build)
  const hasTestScript = Boolean(repo.scripts?.test)
  const hasLock = repo.lockFiles?.length > 0
  const hasTests = repo.sourceStats?.testFileCount > 0
  const agentPenalty = analyses.filter(item => item.subject?.id === repo.id && /risk|critical|fragile|unsafe/i.test(`${item.claim} ${item.rationale}`)).length * 4

  const dims = {
    architecture: { score: clamp(82 - agentPenalty), penalties: [] },
    engineering: { score: clamp(72 + (hasLock ? 8 : -8) + (hasBuildScript ? 6 : -8) + (hasTestScript || hasTests ? 6 : -10) + (hasLint ? 4 : 0) - Math.min(issueTotal, 60) * 0.2), penalties: [] },
    security: { score: clamp(88 - securityTotal * 3), penalties: [] },
    stability: { score: clamp(78 + (hasTests ? 8 : -8) - Number(counts.debugger || 0) * 4 - Number(counts['console-log'] || 0) * 0.2), penalties: [] },
    experience: { score: clamp(70 + (((repo.stack || []).includes('React') || (repo.stack || []).includes('Vue 3')) ? 8 : 0)), penalties: [] },
    business: { score: clamp(70), penalties: [] },
  }

  const rawScore = clamp(EVALUATION_FRAMEWORK.reduce((sum, dim) => sum + dims[dim.id].score * dim.weight, 0))
  return { dims, rawScore, score: rawScore, grade: grade(rawScore), risk: risk(rawScore) }
}

function main() {
  const args = parseArgs(process.argv)
  const poolPath = path.join(args.pool, 'facts', 'coding-pool.json')
  if (!fs.existsSync(poolPath)) {
    throw new Error(`Missing ${poolPath}. Run normalize-coding-pool.mjs first.`)
  }
  const pool = readJson(poolPath)
  const findingsByRepo = new Map()
  for (const finding of pool.findings || []) {
    const id = finding.subject?.id
    if (!id) continue
    if (!findingsByRepo.has(id)) findingsByRepo.set(id, [])
    findingsByRepo.get(id).push(finding)
  }

  const repos = (pool.repositories || []).map(repo => {
    const repoFindings = findingsByRepo.get(repo.id) || []
    const repoAnalyses = (pool.agentAnalyses || []).filter(item => item.subject?.id === repo.id)
    const scored = scoreRepo(repo, repoFindings, repoAnalyses)
    return {
      name: repo.name,
      path: repo.path,
      gitRemote: repo.gitRemote,
      business: repoAnalyses.find(item => /business|domain/i.test(item.claim))?.claim || 'Unknown',
      businessCriticality: 'unknown',
      domain: 'unknown',
      local: repo.local,
      registered: false,
      packageName: repo.packageName,
      version: repo.version,
      stack: repo.stack,
      ui: repo.ui || [],
      deps: Object.keys(repo.deps || {}),
      lockFiles: repo.lockFiles || [],
      eslint: repo.qualitySignals?.lint?.status || 'missing',
      scripts: repo.scripts || {},
      routeCount: repo.sourceStats?.routeCount || 0,
      tests: repo.sourceStats?.testFileCount || 0,
      issueCounts: repo.qualitySignals?.issueCounts || {},
      issueExamples: repo.qualitySignals?.issueExamples || [],
      scoreSignals: {
        sourceStats: repo.sourceStats,
        agentAnalysisCount: repoAnalyses.length,
      },
      issues: repoFindings.map(item => ({
        title: item.title,
        severity: item.severity,
        description: item.description,
        evidenceRefs: item.evidenceRefs,
      })),
      relations: {
        out: (pool.relationships || []).filter(edge => edge.from === repo.id),
        in: (pool.relationships || []).filter(edge => edge.to === repo.id),
      },
      dimensionScores: scored.dims,
      rawScore: scored.rawScore,
      scoreCaps: [],
      score: scored.score,
      grade: scored.grade,
      risk: scored.risk,
      evidenceConfidence: repoAnalyses.some(item => item.confidence === 'high') ? 'high' : 'medium',
      agentAnalyses: repoAnalyses,
    }
  })

  const data = {
    generatedAt: new Date().toISOString(),
    workspace: pool.workspace?.name,
    root: pool.workspace?.root,
    evaluationFramework: EVALUATION_FRAMEWORK,
    referenceEdges: (pool.relationships || []).map(edge => ({
      id: edge.id,
      type: edge.type,
      from: edge.from.replace(/^repo:/, ''),
      to: edge.to.replace(/^repo:/, ''),
      label: edge.label,
      evidence: edge.evidenceRefs,
    })),
    eslintRun: null,
    tooling: {
      generatedBy: 'agentic-coding-audit-skill/scripts/export-audit-data.mjs',
    },
    navigationModel: null,
    repos,
    agentAnalyses: pool.agentAnalyses || [],
  }

  writeJson(args.out, data)
  console.log(`Exported ${repos.length} repos and ${data.referenceEdges.length} edges to ${args.out}`)
}

main()
