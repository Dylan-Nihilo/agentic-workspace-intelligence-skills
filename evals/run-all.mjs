#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] || 'all'

if (mode === 'contract' || mode === 'all') {
  run('contract', ['evals/contract/run-contract.mjs'])
}

if (mode === 'datasource' || mode === 'all') {
  run('datasource', ['evals/datasource/run-datasource-contract.mjs'])
}

if (mode === 'behavioral' || mode === 'all') {
  run('behavioral', ['evals/behavioral/run-behavioral.mjs'])
}

if (mode === 'triggering' || mode === 'all') {
  run('triggering', ['evals/triggering/run-triggering.mjs'])
}

if (mode === 'retrieval' || mode === 'all') {
  run('retrieval', ['evals/retrieval/run-retrieval.mjs'])
}

if (mode === 'knowledge' || mode === 'all') {
  run('knowledge', ['evals/knowledge/run-knowledge.mjs'])
}

if (mode === 'trajectory' || mode === 'all') {
  run('trajectory', ['evals/trajectory/run-trajectory.mjs'])
}

if (mode === 'cost' || mode === 'all') {
  run('cost', ['evals/cost/run-cost.mjs'])
}

if (!['contract', 'datasource', 'behavioral', 'triggering', 'retrieval', 'knowledge', 'trajectory', 'cost', 'all'].includes(mode)) {
  console.error(`Unknown eval mode: ${mode}`)
  process.exit(2)
}

if (mode === 'all') {
  console.log('[summary] pillars: contract=PASS, datasource=PASS, behavioral=PASS, triggering=PASS, retrieval=PASS, knowledge=PASS, trajectory=PASS, cost=PASS')
} else if (mode === 'datasource') {
  console.log('[summary] pillars: datasource=PASS')
} else if (mode === 'behavioral') {
  console.log('[summary] pillars: behavioral=PASS')
} else if (mode === 'triggering') {
  console.log('[summary] pillars: triggering=PASS')
} else if (mode === 'retrieval') {
  console.log('[summary] pillars: retrieval=PASS')
} else if (mode === 'knowledge') {
  console.log('[summary] pillars: knowledge=PASS')
} else if (mode === 'trajectory') {
  console.log('[summary] pillars: trajectory=PASS')
} else if (mode === 'cost') {
  console.log('[summary] pillars: cost=PASS')
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
