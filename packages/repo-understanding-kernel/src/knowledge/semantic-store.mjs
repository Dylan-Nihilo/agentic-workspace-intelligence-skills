import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SEMANTIC_STORE_MANIFEST_SCHEMA = 'repo-semantic-store-manifest/v1'

export function semanticStorePaths(packageDir) {
  const root = path.resolve(packageDir)
  const store = path.join(root, 'store')
  return {
    root,
    store,
    evidence: path.join(store, 'evidence.jsonl'),
    claims: path.join(store, 'claims.jsonl'),
    manifest: path.join(store, 'semantic-store-manifest.json'),
    lock: path.join(store, '.semantic-store.lock'),
  }
}

export function initializeSemanticStore({ packageDir, staticProgramGraph, inventory } = {}) {
  if (!packageDir) throw new Error('initializeSemanticStore requires packageDir')
  if (staticProgramGraph?.schemaVersion !== 'repo-static-program-graph/v1') throw new Error('Static Program Graph v1 is required')
  const paths = semanticStorePaths(packageDir)
  fs.mkdirSync(paths.store, { recursive: true })
  const snapshotId = staticProgramGraph.snapshotId
  const fileByPath = new Map((inventory?.files || []).map(file => [portable(file.path), file]))
  const sourcePaths = new Set([
    ...(staticProgramGraph.files || []).map(file => portable(file.sourcePath)),
    ...(inventory?.manifests || []).map(manifest => portable(manifest.path)),
  ].filter(Boolean))
  const evidence = [...sourcePaths].sort().map(sourcePath => {
    const file = fileByPath.get(sourcePath) || {}
    const protectedFile = file.protected === true
    return compact({
      schemaVersion: 'repo-evidence/v2',
      evidenceId: sourcePath === 'package.json' || (inventory?.manifests || []).some(item => portable(item.path) === sourcePath)
        ? `evidence:manifest:${sourcePath}`
        : `evidence:file:${sourcePath}`,
      snapshotId,
      kind: protectedFile ? 'file-metadata' : 'source-range',
      sourcePath,
      startLine: protectedFile ? null : 1,
      endLine: protectedFile ? null : positiveInteger(file.lines),
      fileContentHash: String(file.hash || staticProgramGraph.files?.find(item => portable(item.sourcePath) === sourcePath)?.contentHash || ''),
      extractor: 'static-program-graph',
      protected: protectedFile,
      capturedAt: staticProgramGraph.generatedAt,
    })
  })
  return withLock(paths, () => {
    writeJsonLinesAtomic(paths.evidence, evidence)
    writeJsonLinesAtomic(paths.claims, [])
    const manifest = buildManifest({ snapshotId, evidence, claims: [], generatedAt: staticProgramGraph.generatedAt })
    writeJsonAtomic(paths.manifest, manifest)
    return { paths, evidence, claims: [], manifest }
  })
}

export function ingestGovernedHypotheses({ packageDir, contract, workItem, acceptedData, generatedAt = new Date().toISOString() } = {}) {
  if (!acceptedData) throw new Error('accepted TaskOutcome data is required')
  const paths = semanticStorePaths(packageDir)
  const manifest = readJson(paths.manifest)
  if (manifest?.snapshotId !== workItem?.snapshotId || manifest?.snapshotId !== contract?.snapshotId) {
    throw new Error('Semantic store, WorkItem, and ResearchContract snapshots must match')
  }
  return withLock(paths, () => {
    const evidence = readJsonLines(paths.evidence)
    const evidenceIds = new Set(evidence.map(item => item.evidenceId))
    const existing = readJsonLines(paths.claims)
    const claims = [...existing]
    const acceptedClaims = []
    for (const hypothesis of acceptedData.hypotheses || []) {
      const refs = hypothesis.status === 'supported' ? hypothesis.supportEvidenceIds : hypothesis.counterEvidenceIds
      if (!refs?.length) throw new Error(`Hypothesis ${hypothesis.hypothesisId} has no governed evidence for ${hypothesis.status}`)
      for (const evidenceId of refs) if (!evidenceIds.has(evidenceId)) throw new Error(`Unknown governed Evidence: ${evidenceId}`)
      const question = (contract.questions || []).find(item => item.questionId === hypothesis.questionId)
      const claim = {
        schemaVersion: 'repo-claim/v2',
        claimId: `claim:${hashCanonical([contract.contractId, hypothesis.hypothesisId, hypothesis.status, [...refs].sort()]).slice(0, 24)}`,
        snapshotId: contract.snapshotId,
        subject: hypothesis.subject,
        predicate: hypothesis.predicate,
        object: hypothesis.object,
        qualifiers: {
          layer: 'semantic',
          contractId: contract.contractId,
          questionId: hypothesis.questionId,
          hypothesisId: hypothesis.hypothesisId,
          hypothesisType: hypothesis.hypothesisType,
          targetMaps: question?.targetMaps || [],
          targetJourneyIds: question?.targetJourneyIds || [],
          mapDimensions: hypothesis.impact?.mapDimensions || [],
          journeyIds: hypothesis.impact?.journeyIds || [],
        },
        evidenceIds: [...new Set(refs)].sort(),
        derivation: 'agent',
        status: hypothesis.status === 'supported' ? 'accepted' : 'refuted',
        confidence: bounded(hypothesis.confidence),
        riskClass: normalizeRisk(workItem.criticality),
        createdByItemId: workItem.itemId,
        verification: [{
          kind: 'research-contract',
          contractId: contract.contractId,
          questionId: hypothesis.questionId,
          hypothesisId: hypothesis.hypothesisId,
          decision: hypothesis.status,
        }],
        supersedes: [],
        supersededBy: [],
        createdAt: generatedAt,
      }
      const index = claims.findIndex(item => item.claimId === claim.claimId)
      if (index >= 0) claims[index] = claim
      else claims.push(claim)
      acceptedClaims.push(claim)
    }
    claims.sort((left, right) => left.claimId.localeCompare(right.claimId))
    writeJsonLinesAtomic(paths.claims, claims)
    const nextManifest = buildManifest({ snapshotId: manifest.snapshotId, evidence, claims, generatedAt })
    writeJsonAtomic(paths.manifest, nextManifest)
    return { paths, claims: acceptedClaims, manifest: nextManifest }
  })
}

export function loadSemanticStore(packageDir) {
  const paths = semanticStorePaths(packageDir)
  const evidence = readJsonLines(paths.evidence)
  const claims = readJsonLines(paths.claims)
  const manifest = readJson(paths.manifest)
  const issues = []
  if (manifest?.schemaVersion !== SEMANTIC_STORE_MANIFEST_SCHEMA) issues.push('semantic store manifest is missing or invalid')
  if (manifest?.hashes?.evidence !== hashCanonical(evidence)) issues.push('evidence hash mismatch')
  if (manifest?.hashes?.claims !== hashCanonical(claims)) issues.push('claims hash mismatch')
  const evidenceIds = new Set(evidence.map(item => item.evidenceId))
  for (const claim of claims) for (const id of claim.evidenceIds || []) if (!evidenceIds.has(id)) issues.push(`Claim ${claim.claimId} references unknown Evidence ${id}`)
  return { paths, evidence, claims, manifest, validation: { valid: issues.length === 0, issues } }
}

function buildManifest({ snapshotId, evidence, claims, generatedAt }) {
  return {
    schemaVersion: SEMANTIC_STORE_MANIFEST_SCHEMA,
    snapshotId,
    counts: {
      evidence: evidence.length,
      claims: claims.length,
      acceptedClaims: claims.filter(item => item.status === 'accepted').length,
      refutedClaims: claims.filter(item => item.status === 'refuted').length,
    },
    hashes: { evidence: hashCanonical(evidence), claims: hashCanonical(claims) },
    generatedAt,
  }
}

function withLock(paths, callback) {
  fs.mkdirSync(paths.store, { recursive: true })
  let descriptor
  try {
    descriptor = fs.openSync(paths.lock, 'wx')
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Semantic store writer lock is already held')
    throw error
  }
  try {
    return callback()
  } finally {
    fs.closeSync(descriptor)
    fs.rmSync(paths.lock, { force: true })
  }
}

function writeJsonLinesAtomic(file, values) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, values.length ? `${values.map(value => JSON.stringify(value)).join('\n')}\n` : '', 'utf8')
  fs.renameSync(temporary, file)
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function readJson(file) {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function hashCanonical(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function portable(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//, '') : null
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function bounded(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0
}

function normalizeRisk(value) {
  return ['low', 'medium', 'high', 'critical'].includes(value) ? value : 'medium'
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
