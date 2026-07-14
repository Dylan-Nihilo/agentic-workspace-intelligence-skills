import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { generateHumanReadableHtml } from '../src/projections/human-readable-html.mjs'
import { writeHumanReadableFixture } from './fixtures/human-readable-v3-fixture.mjs'

test('renders the four governed Product Maps, ordered Journey branches, questions, and provenance', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-readable-v3-'))
  const fixture = writeHumanReadableFixture(packageDir)
  const result = generateHumanReadableHtml({ packageDir })
  const html = fs.readFileSync(result.output, 'utf8')

  assert.equal(result.schemaVersion, 'repo-human-readable-html/v1')
  assert.equal(result.snapshotId, fixture.manifest.snapshotId)
  assert.equal(result.supportLevel, 'supported-frontend')
  assert.deepEqual(result.frontendScope, ['apps/storefront'])
  assert.equal(result.validation.passed, true)
  assert.equal(result.openQuestions['semantic-ambiguity'], 1)
  assert.equal(result.openQuestions['runtime-external-blocked'], 1)
  assert.equal(result.openQuestions['product-intent'], 1)
  assert.equal(result.deterministicDiagnostics, 2)

  for (const heading of ['Application Map', 'Experience Map', 'Runtime Flow Map', 'Change Map']) {
    assert.match(html, new RegExp(`>${heading}<`))
  }
  assert.ok(html.indexOf('data-step-order="1"') < html.indexOf('data-step-order="2"'))
  assert.ok(html.indexOf('data-runtime-order="1"') < html.indexOf('data-runtime-order="5"'))
  assert.match(html, /branch--failure/)
  assert.match(html, /branch:failure/)
  assert.match(html, /runtime-external-blocked/)
  assert.match(html, /product-intent/)
  assert.match(html, /Deterministic diagnostics/)
  assert.match(html, /evidence:page/)
  assert.match(html, /Support level · <code>supported-frontend<\/code>/)
  assert.match(html, /data-svg-target="flow-svg-0"/)
  assert.match(html, /id="theme-toggle"/)
  assert.match(html, new RegExp(fixture.manifest.projections.change.contentHash))

  const labelledByIds = [...html.matchAll(/<section[^>]+aria-labelledby="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(labelledByIds, [
    'application-title',
    'experience-title',
    'runtime-flow-title',
    'change-title',
    'limitations-title',
    'provenance-title',
  ])
  for (const id of labelledByIds) assert.match(html, new RegExp(`<h2 id="${id}">`))
  assert.doesNotMatch(html, /id="(?:application|experience|runtime-flow|change|limitations|provenance)-title-title"/)

  assert.doesNotMatch(html, /<script>globalThis\.compromised=true<\/script>/)
  assert.doesNotMatch(html, /<script>globalThis\.titleCompromised=true<\/script>/)
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/)
  assert.match(html, /&lt;script&gt;globalThis\.compromised=true&lt;\/script&gt;/)
  assert.doesNotMatch(html, /gap.?queue/i)
  assert.doesNotMatch(html, /code-map/i)
  assert.doesNotMatch(html, /coverage/i)
})

test('fails closed when a required governed artifact is missing', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-readable-v3-missing-'))
  writeHumanReadableFixture(packageDir)
  fs.rmSync(path.join(packageDir, 'synthesis', 'narrative.json'))
  assert.throws(() => generateHumanReadableHtml({ packageDir }), /Missing required repo-understanding artifact: synthesis\/narrative\.json/)
  assert.equal(fs.existsSync(path.join(packageDir, 'human-readable.html')), false)
})

test('fails closed when the synthesis narrative contains properties excluded by its bundled schema', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-readable-v3-narrative-schema-'))
  writeHumanReadableFixture(packageDir)
  const narrativeFile = path.join(packageDir, 'synthesis', 'narrative.json')
  const narrative = JSON.parse(fs.readFileSync(narrativeFile, 'utf8'))
  narrative.unexpected = 'legacy projection data'
  narrative.limitations[0].unexpected = true
  fs.writeFileSync(narrativeFile, `${JSON.stringify(narrative, null, 2)}\n`, 'utf8')

  assert.throws(
    () => generateHumanReadableHtml({ packageDir }),
    error => error.message.includes('Invalid synthesis narrative schema:')
      && error.message.includes('$.unexpected is not allowed')
      && error.message.includes('$.limitations[0].unexpected is not allowed'),
  )
  assert.equal(fs.existsSync(path.join(packageDir, 'human-readable.html')), false)
})

test('fails closed when a Product Map content hash is stale', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-readable-v3-stale-'))
  writeHumanReadableFixture(packageDir)
  const mapFile = path.join(packageDir, 'projections', 'change-map.json')
  const changeMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
  changeMap.changeSets[0].confidence = 0.01
  fs.writeFileSync(mapFile, `${JSON.stringify(changeMap, null, 2)}\n`, 'utf8')
  assert.throws(() => generateHumanReadableHtml({ packageDir }), /Product Map artifact hash mismatch for projections\/change-map\.json/)
})

test('fails closed when a high Journey has not passed the default 100% closure gate', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-readable-v3-open-'))
  writeHumanReadableFixture(packageDir, { criticality: 'high', openJourney: true })
  assert.throws(
    () => generateHumanReadableHtml({ packageDir }),
    /Journey closure gate failed: 0\/1 closed; unresolved: journey:checkout/,
  )
  assert.equal(fs.existsSync(path.join(packageDir, 'human-readable.html')), false)
})

test('fails closed when a canonical Journey artifact file is missing', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-readable-v3-journey-file-'))
  const fixture = writeHumanReadableFixture(packageDir)
  fs.rmSync(path.join(packageDir, fixture.store.manifest.entries[0].bindingPath))

  assert.throws(() => generateHumanReadableHtml({ packageDir }), /ENOENT|no such file or directory/)
  assert.equal(fs.existsSync(path.join(packageDir, 'human-readable.html')), false)
})

test('fails closed when a Journey manifest points at a non-canonical artifact ref', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-readable-v3-journey-ref-'))
  const fixture = writeHumanReadableFixture(packageDir)
  const manifestFile = path.join(packageDir, 'store', 'journeys', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const canonicalFile = path.join(packageDir, manifest.entries[0].bindingPath)
  manifest.entries[0].bindingPath = 'store/journeys/bindings/noncanonical.json'
  fs.copyFileSync(canonicalFile, path.join(packageDir, manifest.entries[0].bindingPath))
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  assert.throws(() => generateHumanReadableHtml({ packageDir }), /bindingPath is not canonical/)
  assert.equal(fs.existsSync(path.join(packageDir, 'human-readable.html')), false)
})

test('renders the support level carried by the Application Map instead of hardcoding it', () => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-readable-v3-support-'))
  writeHumanReadableFixture(packageDir, { supportLevel: 'frontend-subtree-only' })

  const result = generateHumanReadableHtml({ packageDir })
  const html = fs.readFileSync(result.output, 'utf8')

  assert.equal(result.supportLevel, 'frontend-subtree-only')
  assert.match(html, /Support level · <code>frontend-subtree-only<\/code>/)
  assert.doesNotMatch(html, /Support level · <code>supported-frontend<\/code>/)
})
