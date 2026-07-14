import { collectFrontendCensusSignals, normalizeRepoPath, stableToken, uniqueSorted } from './frontend-census-utils.mjs'

export const REPO_SUPPORT_DECISION_SCHEMA = 'repo-support-decision/v1'
export const FRONTEND_SUPPORT_LEVELS = Object.freeze([
  'supported-frontend',
  'frontend-subtree-only',
  'unsupported',
])
export const REPOSITORY_KINDS = Object.freeze(['frontend', 'fullstack', 'backend', 'unknown'])

export function buildRepoSupportDecision(input = {}) {
  const signals = collectFrontendCensusSignals(input)
  const repoKind = resolveRepoKind(signals)
  const frontendRoots = uniquePaths(signals.frontendRoots)
  const backendRoots = uniquePaths(signals.backendRoots)
  const metadata = decisionMetadata(input, signals)

  if (repoKind === 'backend') {
    return decision(metadata, 'unsupported', repoKind, 'backend-repository', [], backendRoots.length ? backendRoots : ['.'])
  }
  if (repoKind === 'unknown') {
    return decision(metadata, 'unsupported', repoKind, 'repository-kind-unknown', [], backendRoots)
  }
  if (!signals.hasStrongFrontendEvidence && repoKind !== 'frontend') {
    return decision(metadata, 'unsupported', repoKind, 'frontend-signals-not-found', [], backendRoots)
  }
  if (repoKind === 'fullstack') {
    if (!frontendRoots.length) {
      return decision(metadata, 'unsupported', repoKind, 'frontend-root-not-deterministically-established', [], backendRoots)
    }
    return decision(metadata, 'frontend-subtree-only', repoKind, null, frontendRoots, backendRoots)
  }
  return decision(metadata, 'supported-frontend', 'frontend', null, frontendRoots.length ? frontendRoots : ['.'], backendRoots)
}

export const decideFrontendSupport = buildRepoSupportDecision
export const assessFrontendSupport = buildRepoSupportDecision

export function validateRepoSupportDecision(value) {
  const issues = []
  if (value?.schemaVersion !== REPO_SUPPORT_DECISION_SCHEMA) issues.push(`schemaVersion must be ${REPO_SUPPORT_DECISION_SCHEMA}`)
  if (!value?.snapshotId || typeof value.snapshotId !== 'string') issues.push('snapshotId must be a non-empty string')
  if (!FRONTEND_SUPPORT_LEVELS.includes(value?.supportLevel)) issues.push(`supportLevel is invalid: ${value?.supportLevel}`)
  if (!REPOSITORY_KINDS.includes(value?.repoKind)) issues.push(`repoKind is invalid: ${value?.repoKind}`)
  if (value?.unsupportedReason !== null && typeof value?.unsupportedReason !== 'string') issues.push('unsupportedReason must be a string or null')
  if (!Array.isArray(value?.frontendRoots)) issues.push('frontendRoots must be an array')
  if (!Array.isArray(value?.backendRoots)) issues.push('backendRoots must be an array')
  if (!Array.isArray(value?.evidenceRefs)) issues.push('evidenceRefs must be an array')
  if (!value?.generatedAt || typeof value.generatedAt !== 'string') issues.push('generatedAt must be a non-empty string')
  if (value?.supportLevel === 'unsupported' && !value?.unsupportedReason) issues.push('unsupportedReason is required when supportLevel is unsupported')
  if (value?.supportLevel !== 'unsupported' && value?.unsupportedReason !== null) issues.push('unsupportedReason must be null when the repository is supported')
  if (value?.supportLevel !== 'unsupported' && value?.frontendRoots?.length === 0) issues.push('supported decisions require at least one frontend root')
  if (value?.supportLevel === 'frontend-subtree-only' && value?.repoKind !== 'fullstack') issues.push('frontend-subtree-only requires repoKind fullstack')
  if (value?.supportLevel === 'supported-frontend' && value?.repoKind !== 'frontend') issues.push('supported-frontend requires repoKind frontend')
  if (value?.repoKind === 'backend' && value?.supportLevel !== 'unsupported') issues.push('backend repositories must fail closed')
  if (value?.repoKind === 'unknown' && value?.supportLevel !== 'unsupported') issues.push('unknown repositories must fail closed')
  return issues
}

function resolveRepoKind(signals) {
  const primaryHint = [
    signals.profile?.repoKind,
    signals.scanPolicy?.repoKind,
    signals.input?.repoKind,
  ].find(value => REPOSITORY_KINDS.includes(value))
  if (primaryHint === 'backend' || primaryHint === 'unknown') return primaryHint
  if (primaryHint === 'fullstack') return 'fullstack'
  if (primaryHint === 'frontend') return 'frontend'
  if (signals.hasStrongFrontendEvidence && signals.hasBackendEvidence) return 'fullstack'
  if (signals.hasStrongFrontendEvidence) return 'frontend'
  if (signals.hasBackendEvidence) return 'backend'
  return 'unknown'
}

function decision(metadata, supportLevel, repoKind, unsupportedReason, frontendRoots, backendRoots) {
  return {
    schemaVersion: REPO_SUPPORT_DECISION_SCHEMA,
    snapshotId: metadata.snapshotId,
    supportLevel,
    repoKind,
    unsupportedReason,
    frontendRoots: uniquePaths(frontendRoots),
    backendRoots: uniquePaths(backendRoots),
    evidenceRefs: metadata.evidenceRefs,
    generatedAt: metadata.generatedAt,
  }
}

function decisionMetadata(input, signals) {
  const fingerprint = signals.snapshot?.fingerprint?.value || signals.inventory?.repo?.git?.head || ''
  const signature = JSON.stringify({
    fingerprint,
    repo: signals.snapshot?.repo?.path || signals.inventory?.repo?.path || signals.profile?.repo?.path || '',
    files: signals.filePaths,
  })
  const snapshotId = String(input.snapshotId || signals.snapshot?.snapshotId || `snapshot:compat-${stableToken(signature)}`)
  const generatedAt = String(
    input.generatedAt
      || signals.snapshot?.createdAt
      || signals.inventory?.generatedAt
      || signals.codeMap?.generatedAt
      || signals.profile?.generatedAt
      || '1970-01-01T00:00:00.000Z',
  )
  const evidenceRefs = uniqueSorted([
    ...asArray(input.evidenceRefs),
    ...asArray(signals.profile?.evidenceRefs),
    ...signals.manifests.map(manifest => `evidence:manifest:${manifest.path}`),
    ...signals.browserBootstrapCandidates.map(filePath => `evidence:file:${filePath}`),
  ])
  return { snapshotId, generatedAt, evidenceRefs }
}

function uniquePaths(values) {
  return uniqueSorted(values.map(normalizeRepoPath).filter(Boolean))
}

function asArray(value) {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}
