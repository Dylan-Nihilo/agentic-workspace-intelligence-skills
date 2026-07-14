import { createHash } from 'node:crypto'

export function snapshotIdForInventory(inventory = {}) {
  const files = normalizedFiles(inventory)
  const repo = {
    path: inventory.repo?.path || '',
    head: inventory.repo?.git?.head || null,
  }
  return `snapshot:${hashJson({ repo, files }).slice(0, 20)}`
}

export function buildRepoSnapshot(inventory = {}, options = {}) {
  const files = normalizedFiles(inventory).map(([filePath, size, contentHash, protectedFile, protectionReason]) => ({
    path: filePath,
    size,
    protected: protectedFile,
    ...(protectedFile ? {} : { contentHash: contentHash || null }),
    ...(protectionReason ? { protectionReason } : {}),
  }))
  const fingerprint = hashJson({
    repoPath: inventory.repo?.path || '',
    head: inventory.repo?.git?.head || null,
    files,
  })
  return {
    schemaVersion: 'repo-snapshot/v2',
    snapshotId: options.snapshotId || snapshotIdForInventory(inventory),
    repo: {
      name: inventory.repo?.name || '',
      path: inventory.repo?.path || '',
      git: inventory.repo?.git || null,
    },
    fingerprint: {
      algorithm: 'sha256',
      value: fingerprint,
      dirty: inventory.scan?.clean === false,
    },
    scanRoots: [...new Set(options.scanRoots || ['.'])],
    protectedPolicy: {
      mode: 'metadata-only',
      protectedFileCount: files.filter(file => file.protected).length,
    },
    files,
    createdAt: options.createdAt || new Date().toISOString(),
  }
}

function normalizedFiles(inventory) {
  return (inventory.files || [])
    .map(file => [
      String(file.path || ''),
      Number(file.size || 0),
      file.protected ? null : (file.hash || null),
      Boolean(file.protected),
      file.protectionReason || null,
    ])
    .sort((a, b) => a[0].localeCompare(b[0]))
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
