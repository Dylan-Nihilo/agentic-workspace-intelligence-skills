import { createHash } from 'node:crypto'

export const NODE_SEMANTIC_REVIEW_SCHEMA = 'repo-node-semantic-review/v1'

export function nodeSemanticCatalogHash(catalog) {
  return `sha256:${createHash('sha256').update(JSON.stringify(catalog)).digest('hex')}`
}

export function validateNodeSemanticReview({ review, planId, batch, catalog } = {}) {
  const issues = []
  if (review?.schemaVersion !== NODE_SEMANTIC_REVIEW_SCHEMA) issues.push(`schemaVersion must be ${NODE_SEMANTIC_REVIEW_SCHEMA}`)
  if (!review?.planId || review.planId !== planId) issues.push('planId must match the Node Semantic Batch Plan')
  if (!review?.snapshotId || review.snapshotId !== catalog?.snapshotId) issues.push('snapshotId must match the catalog')
  if (!review?.batchId || review.batchId !== batch?.batchId) issues.push('batchId must match the reviewed batch')
  if (review?.catalogHash !== nodeSemanticCatalogHash(catalog)) issues.push('catalogHash must match the exact reviewed catalog')
  if (!['accepted', 'changes-requested'].includes(review?.status)) issues.push('status must be accepted or changes-requested')
  if (review?.reviewer?.kind !== 'agent' || !review?.reviewer?.reviewId) issues.push('reviewer must identify an independent agent review')
  if (!review?.generatedAt) issues.push('generatedAt is required')
  if (!Array.isArray(review?.entries)) issues.push('entries must be an array')
  const expected = uniqueSorted(batch?.primaryFiles || [])
  const actual = uniqueSorted((review?.entries || []).map(entry => entry?.filePath).filter(Boolean))
  if (!sameStrings(expected, actual)) issues.push('review entries must cover every batch primary file exactly once')
  for (const [index, entry] of (review?.entries || []).entries()) {
    const pointer = `entries[${index}]`
    if (!['accepted', 'changes-requested'].includes(entry?.status)) issues.push(`${pointer}.status must be accepted or changes-requested`)
    for (const check of ['responsibilityEvidence', 'semanticKind', 'noUnsupportedClaims']) {
      if (typeof entry?.checks?.[check] !== 'boolean') issues.push(`${pointer}.checks.${check} must be boolean`)
    }
    if (!Array.isArray(entry?.issues)) issues.push(`${pointer}.issues must be an array`)
    if (entry?.status === 'accepted' && Object.values(entry?.checks || {}).some(value => value !== true)) issues.push(`${pointer} cannot be accepted with a failed check`)
    if (entry?.status === 'accepted' && (entry?.issues || []).length > 0) issues.push(`${pointer} cannot be accepted with review issues`)
  }
  const hasChanges = (review?.entries || []).some(entry => entry.status === 'changes-requested')
  if (review?.status === 'accepted' && hasChanges) issues.push('accepted review cannot contain changes-requested entries')
  if (review?.status === 'changes-requested' && !hasChanges) issues.push('changes-requested review must identify at least one changed entry')
  return { valid: issues.length === 0, issues: uniqueSorted(issues) }
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right), 'en'))
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
