#!/usr/bin/env node
import path from 'node:path'
import {
  collectRepoUnderstanding,
  defaultPackageDir,
  parseCommonArgs,
} from '../../../shared/understanding/repo-understanding-core.mjs'

function usage() {
  console.error('Usage: node harnesses/repo-understanding/scripts/collect-repo-intake.mjs --repo /path/to/repo [--out /path/to/package] [--max-files 16000]')
  process.exit(1)
}

function main() {
  let args
  try {
    args = parseCommonArgs(process.argv, ['repo'])
  } catch (err) {
    console.error(err.message)
    usage()
  }
  if (args.help) usage()

  const repoPath = path.resolve(args.repo)
  const outDir = args.out ? path.resolve(args.out) : defaultPackageDir(repoPath)
  const maxFiles = args['max-files'] ? Number(args['max-files']) : 16000
  if (!Number.isFinite(maxFiles)) usage()

  const result = collectRepoUnderstanding({ repoPath, outDir, maxFiles })
  console.log(`Collected repo intake package: ${result.packageDir}`)
  console.log(`Transient synthesis request hash: ${result.requestHash}`)
  console.log(`Files: ${result.inventory.files.length}, symbols: ${result.codeMap.symbols.length}, fact nodes: ${Object.keys(result.factGraph.nodes).length}, fact edges: ${Object.keys(result.factGraph.edges).length}, render nodes: ${result.renderGraph.nodes.length}, knowledge chunks: ${result.knowledgeIndex.chunks.length}`)
}

main()
