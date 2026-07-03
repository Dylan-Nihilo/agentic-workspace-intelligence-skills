#!/usr/bin/env node
import path from 'node:path'
import { parseCommonArgs } from '../../../shared/understanding/repo-understanding-core.mjs'
import { collectExplorationEvidence } from '../../../shared/understanding/repo-exploration-core.mjs'

function usage() {
  console.error('Usage: node harnesses/repo-understanding/scripts/collect-exploration-evidence.mjs --package /path/to/package [--max-files 80] [--max-file-chars 8000] [--max-search-results 120]')
  process.exit(1)
}

function optionalNumber(args, key) {
  if (!args[key]) return undefined
  const value = Number(args[key])
  if (!Number.isFinite(value)) usage()
  return value
}

function main() {
  let args
  try {
    args = parseCommonArgs(process.argv, ['package'])
  } catch (err) {
    console.error(err.message)
    usage()
  }
  if (args.help) usage()
  const result = collectExplorationEvidence(path.resolve(args.package), {
    maxFiles: optionalNumber(args, 'max-files'),
    maxFileChars: optionalNumber(args, 'max-file-chars'),
    maxSearchResults: optionalNumber(args, 'max-search-results'),
    contextLines: optionalNumber(args, 'context-lines'),
  })
  console.log(`Wrote ${result.jsonPath}`)
  console.log(`Wrote ${result.mdPath}`)
  console.log(`Refreshed transient synthesis request hash for ${path.resolve(args.package)}`)
}

main()
