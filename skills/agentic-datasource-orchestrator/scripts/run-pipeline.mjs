#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..', '..', '..')

function usage() {
  console.error('Usage: node scripts/run-pipeline.mjs --workspace /path --datasource /path [--max-files 8000] [--prepare-ce|--run-ce --confirm-external] [--ce-subject repo:name] [--ce-task task]')
  process.exit(1)
}

function parseArgs(argv) {
  const args = { maxFiles: 8000, prepareCe: false, runCe: false, confirmExternal: false, ceSubject: '', ceTask: 'architecture-risk' }
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--workspace') {
      args.workspace = path.resolve(argv[i + 1])
      i += 1
    } else if (key === '--datasource') {
      args.datasource = path.resolve(argv[i + 1])
      i += 1
    } else if (key === '--max-files') {
      args.maxFiles = Number(argv[i + 1])
      i += 1
    } else if (key === '--prepare-ce') {
      args.prepareCe = true
    } else if (key === '--run-ce') {
      args.runCe = true
    } else if (key === '--confirm-external') {
      args.confirmExternal = true
    } else if (key === '--ce-subject') {
      args.ceSubject = argv[i + 1]
      i += 1
    } else if (key === '--ce-task') {
      args.ceTask = argv[i + 1]
      i += 1
    } else {
      usage()
    }
  }
  if (!args.workspace || !args.datasource || !Number.isFinite(args.maxFiles)) usage()
  if ((args.prepareCe || args.runCe) && !args.ceSubject) usage()
  return args
}

function run(script, args) {
  const full = path.join(repoRoot, script)
  const res = spawnSync(process.execPath, [full, ...args], { encoding: 'utf8' })
  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)
  if (res.status !== 0) throw new Error(`${script} failed with status ${res.status}`)
}

function assertExternalExecutionConfirmed(args) {
  if (!args.runCe) return
  const token = process.env.AGENTIC_CONFIRM_EXTERNAL
  if (!args.confirmExternal || token !== 'run-ce') {
    console.error('External CE execution blocked. Use --run-ce --confirm-external with AGENTIC_CONFIRM_EXTERNAL=run-ce.')
    process.exit(2)
  }
}

function main() {
  const args = parseArgs(process.argv)
  assertExternalExecutionConfirmed(args)
  run('shared/scripts/init-datasource.mjs', ['--workspace', args.workspace, '--datasource', args.datasource])
  run('shared/scripts/update-stage.mjs', ['--datasource', args.datasource, '--stage', 'coding', '--status', 'running', '--produced-by', 'agentic-coding-audit'])
  run('skills/agentic-coding-audit/scripts/collect-static.mjs', ['--workspace', args.workspace, '--datasource', args.datasource, '--max-files', String(args.maxFiles)])
  run('skills/agentic-coding-audit/scripts/normalize-coding-pool.mjs', ['--datasource', args.datasource])
  run('skills/agentic-coding-audit/scripts/export-audit-data.mjs', ['--datasource', args.datasource])
  run('shared/scripts/update-stage.mjs', [
    '--datasource', args.datasource,
    '--stage', 'coding',
    '--status', 'partial',
    '--produced-by', 'agentic-coding-audit',
    '--output-ref', 'pools/coding/facts/coding-pool.json',
    '--missing', 'dynamic command evidence: eslint/build/test/typecheck not collected by this minimal pipeline',
    '--missing', 'runtime evidence: browser/RUM/monitoring not collected by coding stage',
  ])

  if (args.prepareCe || args.runCe) {
    run('shared/scripts/update-stage.mjs', ['--datasource', args.datasource, '--stage', 'ce-bridge', '--status', 'running', '--produced-by', 'agentic-ce-bridge'])
    const ceArgs = [
      '--datasource', args.datasource,
      '--pool', 'coding',
      '--subject', args.ceSubject,
      '--task', args.ceTask,
      '--message', `Analyze ${args.ceSubject} for ${args.ceTask}. Use datasource/pools/coding facts. Return only AgentAnalysis[] JSON.`,
    ]
    if (args.prepareCe && !args.runCe) ceArgs.push('--dry-run')
    run('skills/agentic-ce-bridge/scripts/run-ce-analysis.mjs', ceArgs)
    if (args.runCe) run('skills/agentic-coding-audit/scripts/normalize-coding-pool.mjs', ['--datasource', args.datasource])
    run('shared/scripts/update-stage.mjs', [
      '--datasource', args.datasource,
      '--stage', 'ce-bridge',
      '--status', 'partial',
      '--produced-by', 'agentic-ce-bridge',
      '--output-ref', 'pools/coding/analyses',
      '--missing', args.runCe ? 'CE output may need human review before promotion to high confidence' : 'CE request prepared but not executed',
    ])
  }

  run('shared/scripts/build-workspace-datasource.mjs', ['--datasource', args.datasource])
}

main()
