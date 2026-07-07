#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { validateAgentAnalyses } from '../../../shared/workspace-datasource/coding-pool.mjs'

function usage() {
  console.error('Usage: node scripts/normalize-coding-pool.mjs (--pool /path/to/coding-pool | --datasource /path/to/datasource)')
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
      i += 1
    } else {
      usage()
    }
  }
  if (!args.pool) usage()
  return args
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function listFiles(root) {
  const result = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) result.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  return result.sort()
}

function readAnalyses(pool) {
  const analysesDir = path.join(pool, 'analyses')
  if (!fs.existsSync(analysesDir)) return []
  const records = []
  for (const file of fs.readdirSync(analysesDir).filter(name => name.endsWith('.json')).sort()) {
    const value = readJson(path.join(analysesDir, file), null)
    if (Array.isArray(value)) records.push(...value)
    else if (value) records.push(value)
  }
  return records
}

function main() {
  const args = parseArgs(process.argv)
  const indexPath = path.join(args.pool, 'index.json')
  const index = readJson(indexPath, null)
  if (!index) {
    throw new Error(`Missing index.json in ${args.pool}. Run collect-static.mjs first.`)
  }

  const repositories = readJson(path.join(args.pool, 'facts', 'repositories.json'), [])
  const relationships = readJson(path.join(args.pool, 'facts', 'relationships.json'), [])
  const findings = readJson(path.join(args.pool, 'facts', 'findings.json'), [])
  const runs = readJson(path.join(args.pool, 'facts', 'runs.json'), [])
  const agentAnalyses = readAnalyses(args.pool)
  const analysisErrors = validateAgentAnalyses(agentAnalyses)
  if (analysisErrors.length) {
    console.error(analysisErrors.join('\n'))
    process.exit(2)
  }

  const generatedAt = new Date().toISOString()
  const pool = {
    schemaVersion: 'coding-pool/v1',
    generatedAt,
    workspace: index.workspace,
    runs,
    repositories,
    relationships,
    findings,
    agentAnalyses,
  }
  writeJson(path.join(args.pool, 'facts', 'coding-pool.json'), pool)

  index.generatedAt = generatedAt
  index.counts = {
    repositories: repositories.length,
    relationships: relationships.length,
    findings: findings.length,
    agentAnalyses: agentAnalyses.length,
  }
  index.files = listFiles(args.pool)
  writeJson(indexPath, index)

  console.log(`Normalized coding pool with ${repositories.length} repositories and ${agentAnalyses.length} agent analyses.`)
}

main()
