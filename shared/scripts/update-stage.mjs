#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

function usage() {
  console.error('Usage: node shared/scripts/update-stage.mjs --datasource /path --stage coding --status complete [--produced-by name] [--output-ref path] [--missing item]...')
  process.exit(1)
}

function parseArgs(argv) {
  const args = { missing: [] }
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--datasource') {
      args.datasource = path.resolve(argv[i + 1])
      i += 1
    } else if (key === '--stage') {
      args.stage = argv[i + 1]
      i += 1
    } else if (key === '--status') {
      args.status = argv[i + 1]
      i += 1
    } else if (key === '--produced-by') {
      args.producedBy = argv[i + 1]
      i += 1
    } else if (key === '--output-ref') {
      args.outputRef = argv[i + 1]
      i += 1
    } else if (key === '--missing') {
      args.missing.push(argv[i + 1])
      i += 1
    } else {
      usage()
    }
  }
  if (!args.datasource || !args.stage || !args.status) usage()
  return args
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function statusCompleteness(status) {
  if (status === 'complete') return 1
  if (status === 'partial') return 0.5
  return 0
}

function main() {
  const args = parseArgs(process.argv)
  const manifestPath = path.join(args.datasource, 'manifest.json')
  const manifest = readJson(manifestPath)
  const stage = manifest.stages.find(item => item.id === args.stage)
  if (!stage) throw new Error(`Unknown stage: ${args.stage}`)

  stage.status = args.status
  if (args.producedBy !== undefined) stage.producedBy = args.producedBy
  if (args.outputRef !== undefined) stage.outputRef = args.outputRef
  if (args.missing.length) stage.missingEvidence = args.missing
  stage.updatedAt = new Date().toISOString()

  manifest.generatedAt = stage.updatedAt
  manifest.completeness[args.stage] = statusCompleteness(args.status)
  const stageValues = manifest.stages.map(item => manifest.completeness[item.id] || 0)
  manifest.completeness.overall = Number((stageValues.reduce((sum, value) => sum + value, 0) / stageValues.length).toFixed(3))
  if (manifest.pools[args.stage]) manifest.pools[args.stage].status = args.status
  writeJson(manifestPath, manifest)
  console.log(`Updated ${args.stage} to ${args.status}`)
}

main()
