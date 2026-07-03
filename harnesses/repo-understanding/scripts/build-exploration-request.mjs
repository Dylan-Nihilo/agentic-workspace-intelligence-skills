#!/usr/bin/env node
import path from 'node:path'
import { parseCommonArgs } from '../../../shared/understanding/repo-understanding-core.mjs'
import { buildExplorationRequestForPackage } from '../../../shared/understanding/repo-exploration-core.mjs'

function usage() {
  console.error('Usage: node harnesses/repo-understanding/scripts/build-exploration-request.mjs --package /path/to/package')
  process.exit(1)
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
  const result = buildExplorationRequestForPackage(path.resolve(args.package))
  process.stdout.write(result.request)
}

main()
