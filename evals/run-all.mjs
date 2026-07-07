#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] || 'all'

if (mode === 'contract' || mode === 'all') {
  run('contract', ['evals/contract/run-contract.mjs'])
}

if (mode === 'behavioral' || mode === 'all') {
  console.log('[behavioral] PENDING (deferred — not asserted): behavioral evals are reserved for the next standardization wave.')
}

if (mode === 'triggering' || mode === 'all') {
  console.log('[triggering] PENDING (deferred — not asserted): triggering evals are reserved for the next standardization wave.')
}

if (!['contract', 'behavioral', 'triggering', 'all'].includes(mode)) {
  console.error(`Unknown eval mode: ${mode}`)
  process.exit(2)
}

if (mode === 'all') {
  console.log('[summary] pillars: contract=PASS, behavioral=PENDING, triggering=PENDING')
} else if (mode === 'behavioral') {
  console.log('[summary] pillars: behavioral=PENDING')
} else if (mode === 'triggering') {
  console.log('[summary] pillars: triggering=PENDING')
}

function run(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error(`[${label}] failed with exit ${result.status}`)
    process.exit(result.status || 1)
  }
}
