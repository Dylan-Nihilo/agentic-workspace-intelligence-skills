import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))

test('loads every declared kernel package export', async t => {
  for (const subpath of Object.keys(manifest.exports)) {
    await t.test(subpath, async () => {
      const specifier = `${manifest.name}/${subpath.slice(2)}`
      const module = await import(specifier)
      assert(Object.keys(module).length > 0, `${specifier} must expose a public v3 surface`)
    })
  }
})
