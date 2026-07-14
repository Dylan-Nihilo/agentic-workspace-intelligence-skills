import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('exposes a runnable CLI entrypoint', () => {
  const result = spawnSync(process.execPath, ['src/cli.mjs', '--help'], {
    cwd: packageDir,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Usage:/)
  assert.match(result.stderr, /harness analyze/)
  assert.match(result.stderr, /harness semantic-plan/)
  assert.match(result.stderr, /harness semantic-review-plan/)
  assert.match(result.stderr, /harness semantic-ingest/)
})
