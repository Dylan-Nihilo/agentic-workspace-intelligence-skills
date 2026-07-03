#!/usr/bin/env node
import path from 'node:path'
import {
  collectRepoUnderstanding,
  defaultPackageDir,
  parseCommonArgs,
  writeValidation,
} from '../../../shared/understanding/repo-understanding-core.mjs'

function usage() {
  console.error('Usage: node harnesses/repo-understanding/scripts/run-repo-understanding.mjs --repo /path/to/repo [--out /path/to/package] [--max-files 16000]')
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
  const validation = writeValidation(result.packageDir)
  console.log(`Prepared repo understanding package: ${result.packageDir}`)
  console.log(`Transient synthesis request hash: ${result.requestHash}`)
  console.log(`FactGraph nodes: ${Object.keys(result.factGraph.nodes).length}, edges: ${Object.keys(result.factGraph.edges).length}, coverage: ${result.factGraph.stats.coverageScore}`)
  console.log(`Render graph nodes: ${result.renderGraph.nodes.length}, edges: ${result.renderGraph.edges.length}`)
  console.log(`Static validation passed: ${validation.issues.length === 0}`)
  console.log('Next: generate the transient synthesis request with understanding:request when needed, then write returned JSON into analyses/repo-understanding.json.')
}

main()
