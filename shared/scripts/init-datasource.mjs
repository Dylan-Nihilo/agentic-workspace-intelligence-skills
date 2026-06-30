#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const STAGES = ['coding', 'ce-bridge', 'docs', 'runtime', 'delivery', 'security', 'business', 'synthesis']
const POOLS = ['coding', 'docs', 'runtime', 'delivery', 'security', 'business']

function usage() {
  console.error('Usage: node shared/scripts/init-datasource.mjs --workspace /path/to/workspace --datasource /path/to/datasource [--force]')
  process.exit(1)
}

function parseArgs(argv) {
  const args = { force: false }
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--workspace') {
      args.workspace = path.resolve(argv[i + 1])
      i += 1
    } else if (key === '--datasource') {
      args.datasource = path.resolve(argv[i + 1])
      i += 1
    } else if (key === '--force') {
      args.force = true
    } else {
      usage()
    }
  }
  if (!args.workspace || !args.datasource) usage()
  return args
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function main() {
  const args = parseArgs(process.argv)
  const manifestPath = path.join(args.datasource, 'manifest.json')
  if (fs.existsSync(manifestPath) && !args.force) {
    console.log(`Datasource already exists: ${manifestPath}`)
    return
  }

  const now = new Date().toISOString()
  for (const pool of POOLS) fs.mkdirSync(path.join(args.datasource, 'pools', pool), { recursive: true })
  fs.mkdirSync(path.join(args.datasource, 'exports', 'audit-board'), { recursive: true })
  fs.mkdirSync(path.join(args.datasource, 'exports', 'reports'), { recursive: true })

  const manifest = {
    schemaVersion: 'workspace-datasource/v1',
    generatedAt: now,
    workspace: {
      root: args.workspace,
      name: path.basename(args.workspace),
      detectedAt: now,
    },
    stages: STAGES.map(id => ({
      id,
      status: 'pending',
      producedBy: '',
      outputRef: '',
      missingEvidence: [],
      updatedAt: now,
    })),
    completeness: Object.fromEntries([...STAGES, 'overall'].map(id => [id, 0])),
    pools: Object.fromEntries(POOLS.map(id => [id, { path: `pools/${id}`, status: 'pending' }])),
    exports: {},
  }
  writeJson(manifestPath, manifest)
  console.log(`Initialized datasource at ${args.datasource}`)
}

main()
