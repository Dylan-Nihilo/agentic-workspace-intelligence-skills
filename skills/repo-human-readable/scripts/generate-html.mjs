#!/usr/bin/env node
import { generateHumanReadableHtml } from '../../../packages/repo-understanding-kernel/src/projections/human-readable-html.mjs'

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.package) usage()
  const result = generateHumanReadableHtml({
    packageDir: args.package,
    outFile: args.out,
  })
  console.log(JSON.stringify(result, null, 2))
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--help' || item === '-h') args.help = true
    else if (item.startsWith('--')) {
      const key = item.slice(2)
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) args[key] = true
      else {
        args[key] = next
        index += 1
      }
    }
  }
  return args
}

function usage() {
  console.error('Usage: generate-html --package <repo-understanding-package> [--out <file.html>]')
  process.exit(1)
}

main()
