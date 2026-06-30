#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const candidates = [
  process.env.REPOPROMPT_CE_CLI,
  '/usr/local/bin/rpce-cli-debug',
  '/usr/local/bin/rpce-cli',
  `${os.homedir()}/Library/Application Support/RepoPrompt CE/repoprompt_ce_cli_debug`,
  `${os.homedir()}/Library/Application Support/RepoPrompt CE/repoprompt_ce_cli`,
].filter(Boolean)

const results = candidates.map(candidate => {
  if (!fs.existsSync(candidate)) return { path: candidate, exists: false, ok: false }
  const res = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 })
  return {
    path: candidate,
    exists: true,
    ok: res.status === 0,
    version: res.stdout.trim() || res.stderr.trim(),
    status: res.status,
  }
})

const selected = results.find(item => item.ok) || null
console.log(JSON.stringify({ selected, candidates: results }, null, 2))
process.exit(selected ? 0 : 1)
