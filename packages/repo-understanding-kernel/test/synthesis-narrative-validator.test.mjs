import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { validateSynthesisNarrative } from '../src/validation/synthesis-narrative-validator.mjs'
import { writeHumanReadableFixture } from './fixtures/human-readable-v3-fixture.mjs'

test('validates the bundled synthesis schema and canonical Journey store', t => {
  const context = fixtureContext(t)
  const validation = validateSynthesisNarrative(context)

  assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2))
  assert.equal(fs.existsSync(path.join(context.packageDir, 'store', 'journey-definitions.jsonl')), false)
})

test('rejects properties excluded by the bundled synthesis schema', t => {
  const context = fixtureContext(t)
  context.narrative.unexpected = 'legacy projection data'
  context.narrative.limitations[0].unexpected = true

  const validation = validateSynthesisNarrative(context)

  assert.equal(validation.valid, false)
  assert(validation.issues.some(issue => issue.code === 'schema-validation' && issue.pointer === '$.unexpected'))
  assert(validation.issues.some(issue => issue.code === 'schema-validation' && issue.pointer === '$.limitations[0].unexpected'))
})

function fixtureContext(t) {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-validator-v3-'))
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }))
  const fixture = writeHumanReadableFixture(packageDir)
  fs.mkdirSync(path.join(packageDir, 'state'), { recursive: true })
  writeJson(path.join(packageDir, 'state', 'run-state.json'), {
    schemaVersion: 'repo-run-state/v3',
    snapshotId: fixture.manifest.snapshotId,
    questions: {
      'question:semantic': { questionId: 'question:semantic', status: 'qualified' },
      'question:runtime': { questionId: 'question:runtime', status: 'blocked' },
      'question:intent': { questionId: 'question:intent', status: 'blocked' },
    },
    journeys: {},
  })
  fs.mkdirSync(path.join(packageDir, 'store'), { recursive: true })
  writeJsonLines(path.join(packageDir, 'store', 'evidence.jsonl'), [
    { evidenceId: 'evidence:page' },
    { evidenceId: 'evidence:error' },
  ])
  writeJsonLines(path.join(packageDir, 'store', 'claims.jsonl'), [
    { claimId: 'claim:checkout-goal', status: 'accepted' },
  ])
  return {
    packageDir,
    narrative: structuredClone(fixture.narrative),
    contract: { snapshotId: fixture.manifest.snapshotId },
    mapManifest: fixture.manifest,
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeJsonLines(file, values) {
  fs.writeFileSync(file, `${values.map(value => JSON.stringify(value)).join('\n')}\n`, 'utf8')
}
