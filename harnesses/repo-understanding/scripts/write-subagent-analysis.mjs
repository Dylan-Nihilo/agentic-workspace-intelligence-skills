#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {
  parseCommonArgs,
  writeAnalysis,
} from '../../../shared/understanding/repo-understanding-core.mjs'

function usage() {
  console.error('Usage: node harnesses/repo-understanding/scripts/write-subagent-analysis.mjs --package /path/to/package --analysis /path/to/analysis.json')
  process.exit(1)
}

function main() {
  let args
  try {
    args = parseCommonArgs(process.argv, ['package', 'analysis'])
  } catch (err) {
    console.error(err.message)
    usage()
  }
  if (args.help) usage()
  const analysisText = args.analysis === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(path.resolve(args.analysis), 'utf8')
  const value = JSON.parse(analysisText)
  const result = writeAnalysis(path.resolve(args.package), value, {
    runtime: args.runtime || 'agent-runtime',
    role: args.role || 'repo-understander',
    sessionId: args.session || undefined,
  })
  console.log(`Wrote ${result.analysisPath}`)
}

main()
