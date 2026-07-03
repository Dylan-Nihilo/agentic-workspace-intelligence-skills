#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { parseCommonArgs } from '../../../shared/understanding/repo-understanding-core.mjs'

function usage() {
  console.error('Usage: node harnesses/repo-understanding/scripts/build-explorer-dispatch.mjs --package /path/to/package [--max-tasks 40]')
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
  const packageDir = path.resolve(args.package)
  const maxTasks = args['max-tasks'] ? Number(args['max-tasks']) : 40
  if (!Number.isFinite(maxTasks)) usage()
  const gapQueue = readJson(path.join(packageDir, 'gap-queue.json'))
  const factGraph = readJson(path.join(packageDir, 'fact-graph.json'))
  const inventory = readJson(path.join(packageDir, 'inventory.json'))
  const tasks = (gapQueue.tasks || []).slice(0, maxTasks)
  const byExplorer = new Map()
  for (const task of tasks) {
    const list = byExplorer.get(task.explorer) || []
    list.push(task)
    byExplorer.set(task.explorer, list)
  }
  const dispatch = {
    schemaVersion: 'repo-explorer-dispatch/v1',
    generatedAt: new Date().toISOString(),
    packageDir,
    repo: inventory.repo,
    factGraph: 'fact-graph.json',
    gapQueue: 'gap-queue.json',
    taskCount: tasks.length,
    explorers: [...byExplorer.entries()].map(([explorer, explorerTasks]) => ({
      explorer,
      tokenBudget: explorerTasks.reduce((sum, task) => sum + (task.tokenBudget || 0), 0),
      tasks: explorerTasks,
      prompt: renderExplorerPrompt(explorer, explorerTasks, factGraph),
    })),
  }
  process.stdout.write(`${JSON.stringify(dispatch, null, 2)}\n`)
}

function renderExplorerPrompt(explorer, tasks, factGraph) {
  const relatedIds = new Set(tasks.flatMap(task => task.relatedNodes || []))
  const nodes = [...relatedIds].filter(id => factGraph.nodes?.[id]).map(id => factGraph.nodes[id])
  const edges = [...relatedIds].filter(id => factGraph.edges?.[id]).map(id => factGraph.edges[id])
  return [
    `You are the ${explorer} repo explorer.`,
    'Return JSON only using schemaVersion "repo-exploration-analysis/v1".',
    'Output facts[] triples with evidence and openQuestions[].',
    'Do not modify files, install dependencies, or run builds.',
    '',
    'Tasks:',
    JSON.stringify(tasks, null, 2),
    '',
    'Related FactGraph nodes:',
    JSON.stringify(nodes, null, 2),
    '',
    'Related FactGraph edges:',
    JSON.stringify(edges, null, 2),
  ].join('\n')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

main()
