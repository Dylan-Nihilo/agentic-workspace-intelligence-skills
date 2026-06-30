#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

function usage() {
  console.error('Usage: node shared/scripts/build-workspace-datasource.mjs --datasource /path/to/datasource')
  process.exit(1)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--datasource') {
      args.datasource = path.resolve(argv[i + 1])
      i += 1
    } else {
      usage()
    }
  }
  if (!args.datasource) usage()
  return args
}

function readJson(file, fallback = null) {
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

function main() {
  const args = parseArgs(process.argv)
  const manifestPath = path.join(args.datasource, 'manifest.json')
  const manifest = readJson(manifestPath)
  if (!manifest) throw new Error(`Missing manifest: ${manifestPath}`)

  const coding = readJson(path.join(args.datasource, 'pools', 'coding', 'facts', 'coding-pool.json'))
  const auditBoard = fs.existsSync(path.join(args.datasource, 'exports', 'audit-board', 'audit-data.json'))
    ? 'exports/audit-board/audit-data.json'
    : ''
  const missingEvidence = manifest.stages.flatMap(stage => (stage.missingEvidence || []).map(item => ({
    stage: stage.id,
    evidence: item,
  })))

  const generatedAt = new Date().toISOString()
  const out = path.join(args.datasource, 'exports', 'workspace-datasource.json')
  const stage = manifest.stages.find(item => item.id === 'synthesis')
  if (stage) {
    stage.status = 'partial'
    stage.producedBy = 'shared/scripts/build-workspace-datasource.mjs'
    stage.outputRef = 'exports/workspace-datasource.json'
    stage.updatedAt = generatedAt
    manifest.generatedAt = generatedAt
    manifest.exports.workspaceDatasource = 'exports/workspace-datasource.json'
    if (auditBoard) manifest.exports.auditBoard = auditBoard
    manifest.completeness.synthesis = 0.5
    const stageValues = manifest.stages.map(item => manifest.completeness[item.id] || 0)
    manifest.completeness.overall = Number((stageValues.reduce((sum, value) => sum + value, 0) / stageValues.length).toFixed(3))
  }

  const datasource = {
    schemaVersion: 'workspace-datasource/v1',
    generatedAt,
    workspace: manifest.workspace,
    manifest,
    pools: {
      coding,
      docs: null,
      runtime: null,
      delivery: null,
      security: null,
      business: null,
    },
    missingEvidence,
    exports: {
      auditBoard,
    },
  }

  writeJson(out, datasource)
  writeJson(manifestPath, manifest)
  console.log(`Built ${out}`)
}

main()
