#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ingestAgentAnalyses } from '../../../shared/workspace-datasource/coding-pool.mjs'

function usage() {
  console.error('Usage: node scripts/run-ce-analysis.mjs --datasource /path --pool coding --subject repo:name --task task-name [--message text] [--ce-cli path] [--window 1] [--model explore] [--timeout 300] [--dry-run]')
  process.exit(1)
}

function parseArgs(argv) {
  const args = { pool: 'coding', window: '1', model: 'explore', timeout: 300, dryRun: false }
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--datasource') {
      args.datasource = path.resolve(argv[i + 1])
      i += 1
    } else if (key === '--pool') {
      args.pool = argv[i + 1]
      i += 1
    } else if (key === '--subject') {
      args.subject = argv[i + 1]
      i += 1
    } else if (key === '--task') {
      args.task = argv[i + 1]
      i += 1
    } else if (key === '--message') {
      args.message = argv[i + 1]
      i += 1
    } else if (key === '--ce-cli') {
      args.ceCli = path.resolve(argv[i + 1])
      i += 1
    } else if (key === '--window') {
      args.window = argv[i + 1]
      i += 1
    } else if (key === '--model') {
      args.model = argv[i + 1]
      i += 1
    } else if (key === '--timeout') {
      args.timeout = Number(argv[i + 1])
      i += 1
    } else if (key === '--dry-run') {
      args.dryRun = true
    } else {
      usage()
    }
  }
  if (!args.datasource || !args.pool || !args.subject || !args.task || !Number.isFinite(args.timeout)) usage()
  return args
}

function writeFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function detectCeCli(explicit) {
  const candidates = [
    explicit,
    process.env.REPOPROMPT_CE_CLI,
    '/usr/local/bin/rpce-cli-debug',
    '/usr/local/bin/rpce-cli',
    `${os.homedir()}/Library/Application Support/RepoPrompt CE/repoprompt_ce_cli_debug`,
    `${os.homedir()}/Library/Application Support/RepoPrompt CE/repoprompt_ce_cli`,
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const res = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 })
    if (res.status === 0) return candidate
  }
  return null
}

function parseJsonFromText(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  if (fenced) return JSON.parse(fenced[1])
  const firstArray = text.indexOf('[')
  const lastArray = text.lastIndexOf(']')
  if (firstArray >= 0 && lastArray > firstArray) return JSON.parse(text.slice(firstArray, lastArray + 1))
  const firstObject = text.indexOf('{')
  const lastObject = text.lastIndexOf('}')
  if (firstObject >= 0 && lastObject > firstObject) return JSON.parse(text.slice(firstObject, lastObject + 1))
  throw new Error('No JSON object or array found in CE output')
}

function assertCeParsed(text, rawDir, runId) {
  try {
    return parseJsonFromText(text)
  } catch (error) {
    writeJson(path.join(rawDir, 'ce-run-failed.json'), {
      schemaVersion: 'ce-run-failed/v1',
      runId,
      failedAt: new Date().toISOString(),
      reason: `CE output parse failed: ${error.message}`,
      rawRefs: [
        `raw/ce-runs/${runId}/wait.stdout.txt`,
        `raw/ce-runs/${runId}/wait.stderr.txt`,
      ],
    })
    console.error(`CE output parse failed; raw output preserved at ${rawDir}`)
    process.exit(2)
  }
}

function main() {
  const args = parseArgs(process.argv)
  const runId = `ce-${args.task}-${Date.now()}`
  const poolDir = path.join(args.datasource, 'pools', args.pool)
  const rawDir = path.join(poolDir, 'raw', 'ce-runs', runId)
  const prompt = args.message || [
    `Analyze ${args.subject} for ${args.task}.`,
    `Use the datasource pool at ${path.join(args.datasource, 'pools', args.pool)} as context if available.`,
    'Return only JSON matching AgentAnalysis[] with producedBy set to "subagent" and provider set to "repoprompt-ce".',
  ].join('\n')

  const ceCli = detectCeCli(args.ceCli)
  const request = {
    runId,
    datasource: args.datasource,
    pool: args.pool,
    subject: args.subject,
    task: args.task,
    model: args.model,
    window: args.window,
    ceCli,
    dryRun: args.dryRun,
    message: prompt,
  }
  writeJson(path.join(rawDir, 'request.json'), request)

  if (args.dryRun) {
    console.log(`Prepared CE analysis request at ${path.join(rawDir, 'request.json')}`)
    return
  }
  if (!ceCli) throw new Error('RepoPrompt CE CLI not found. Run detect-ce-cli.mjs first.')

  const startPayload = {
    op: 'start',
    model_id: args.model,
    session_name: `Datasource ${args.pool} ${args.task}`,
    message: prompt,
    detach: true,
  }
  const start = spawnSync(ceCli, ['-w', args.window, '-c', 'agent_run', '-j', JSON.stringify(startPayload)], { encoding: 'utf8', timeout: 30000 })
  writeFile(path.join(rawDir, 'start.stdout.txt'), start.stdout || '')
  writeFile(path.join(rawDir, 'start.stderr.txt'), start.stderr || '')
  if (start.status !== 0) throw new Error(`CE agent_run start failed with status ${start.status}`)

  const startJson = parseJsonFromText(start.stdout || start.stderr || '{}')
  const sessionId = startJson.session_id || startJson.sessionId || startJson.result?.session_id || startJson.result?.sessionId
  if (!sessionId) throw new Error('CE agent_run start did not return a session_id')

  const waitPayload = { op: 'wait', session_id: sessionId, timeout: args.timeout }
  const wait = spawnSync(ceCli, ['-w', args.window, '-c', 'agent_run', '-j', JSON.stringify(waitPayload)], { encoding: 'utf8', timeout: (args.timeout + 30) * 1000 })
  writeFile(path.join(rawDir, 'wait.stdout.txt'), wait.stdout || '')
  writeFile(path.join(rawDir, 'wait.stderr.txt'), wait.stderr || '')
  if (wait.status !== 0) throw new Error(`CE agent_run wait failed with status ${wait.status}`)

  const rawRef = `evidence:raw:raw/ce-runs/${runId}/wait.stdout.txt`
  const parsed = assertCeParsed(wait.stdout || wait.stderr || '', rawDir, runId)
  const result = ingestAgentAnalyses({
    datasource: args.datasource,
    pool: args.pool,
    fileName: `${runId}.json`,
    value: parsed,
    defaults: {
      subject: args.subject,
      task: args.task,
      producedBy: 'subagent',
      provider: 'repoprompt-ce',
      promptRef: `raw/ce-runs/${runId}/request.json`,
      evidenceRefs: [rawRef],
      claim: 'CE analysis completed; inspect raw output for details.',
      rationale: 'CE did not return a structured rationale. Raw output is preserved.',
      confidence: 'low',
    },
  })
  console.log(`Wrote ${result.records.length} CE analysis record(s) to ${result.analysisPath}`)
}

main()
