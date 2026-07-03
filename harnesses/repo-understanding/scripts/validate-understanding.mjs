#!/usr/bin/env node
import path from 'node:path'
import {
  parseCommonArgs,
  writeValidation,
} from '../../../shared/understanding/repo-understanding-core.mjs'

function usage() {
  console.error('Usage: node harnesses/repo-understanding/scripts/validate-understanding.mjs --package /path/to/package')
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
  const validation = writeValidation(path.resolve(args.package))
  console.log(JSON.stringify(validation, null, 2))
  if (!validation.passed) process.exitCode = 2
}

main()

