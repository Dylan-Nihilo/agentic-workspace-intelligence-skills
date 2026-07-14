import fs from 'node:fs'
import path from 'node:path'

export const NODE_SEMANTIC_CONTEXT_SCHEMA = 'repo-node-semantic-context/v1'

export function buildNodeSemanticContext({ repoPath, filePaths = [], staticProgramGraph, maxSignalsPerFile = 120 } = {}) {
  if (!repoPath) throw new Error('buildNodeSemanticContext requires repoPath')
  if (staticProgramGraph?.schemaVersion !== 'repo-static-program-graph/v1') throw new Error('Static Program Graph v1 is required')
  const root = path.resolve(repoPath)
  const sourcePathByNode = new Map()
  const nodesByFile = new Map()
  for (const node of staticProgramGraph.nodes || []) {
    const sourcePath = portable(node?.source?.sourcePath || node?.attributes?.sourcePath)
    if (!sourcePath) continue
    sourcePathByNode.set(node.nodeId, sourcePath)
    const values = nodesByFile.get(sourcePath) || []
    values.push(node)
    nodesByFile.set(sourcePath, values)
  }
  const relationsByFile = buildFileRelations(staticProgramGraph.edges || [], sourcePathByNode)
  const files = [...new Set(filePaths.map(portable).filter(Boolean))].sort().map(filePath => {
    const absolutePath = path.resolve(root, filePath)
    if (!inside(root, absolutePath)) throw new Error(`Node semantic context path escapes repo: ${filePath}`)
    if (!fs.existsSync(absolutePath)) throw new Error(`Node semantic context file does not exist: ${filePath}`)
    const source = fs.readFileSync(absolutePath, 'utf8')
    const lines = source.split(/\r?\n/)
    const nodes = (nodesByFile.get(filePath) || []).sort((left, right) => (left.source?.line || 0) - (right.source?.line || 0) || left.nodeId.localeCompare(right.nodeId))
    return {
      filePath,
      language: nodes[0]?.language || languageForPath(filePath),
      lineCount: lines.length,
      entities: nodes.map(node => ({
        entityId: node.nodeId,
        kind: node.kind,
        label: node.label,
        line: node.source?.line || null,
        attributes: compactAttributes(node.attributes),
      })),
      relations: relationsByFile.get(filePath) || [],
      imports: extractImports(lines),
      signals: extractSignals(lines, maxSignalsPerFile),
    }
  })
  return {
    schemaVersion: NODE_SEMANTIC_CONTEXT_SCHEMA,
    snapshotId: staticProgramGraph.snapshotId,
    repoPath: root,
    files,
  }
}

function buildFileRelations(edges, sourcePathByNode) {
  const grouped = new Map()
  for (const edge of edges) {
    const source = sourcePathByNode.get(edge.from)
    const target = sourcePathByNode.get(edge.to)
    if (!source || !target || source === target) continue
    addRelation(grouped, source, { direction: 'outgoing', type: edge.type || 'related', filePath: target })
    addRelation(grouped, target, { direction: 'incoming', type: edge.type || 'related', filePath: source })
  }
  for (const [filePath, relations] of grouped) {
    const unique = new Map(relations.map(item => [`${item.direction}\u0000${item.type}\u0000${item.filePath}`, item]))
    grouped.set(filePath, [...unique.values()].sort((left, right) => left.direction.localeCompare(right.direction) || left.type.localeCompare(right.type) || left.filePath.localeCompare(right.filePath)))
  }
  return grouped
}

function addRelation(grouped, filePath, relation) {
  const values = grouped.get(filePath) || []
  values.push(relation)
  grouped.set(filePath, values)
}

function extractImports(lines) {
  const imports = []
  const pattern = /^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/
  lines.forEach((line, index) => {
    const match = line.match(pattern)
    if (!match) return
    imports.push({ line: index + 1, bindings: String(match[1] || '').trim() || null, specifier: match[2] || match[3] })
  })
  return imports
}

function extractSignals(lines, maximum) {
  const scored = []
  const patterns = [
    [9, /\b(name|props|data|computed|methods|watch|created|mounted|activated|setup)\s*[:(]/],
    [9, /\b(async\s+)?(function\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/],
    [9, /\b(export\s+(default|const|function|class)|module\.exports)\b/],
    [8, /\b(this\.)?\$(route|router|store|emit|message|confirm)\b/],
    [8, /\b(await|\.then\s*\(|\.catch\s*\(|\.finally\s*\()\b/],
    [8, /\b(v-if|v-show|v-for|@click|@change|@submit|:data-source|:value|:loading)\b/],
    [7, /\b(if|else if|switch|case)\s*[({]/],
    [7, /\b(request|query|create|update|delete|submit|save|load|fetch|download|upload|approve|reject)[A-Za-z0-9_$]*\s*\(/i],
    [6, /[\u3400-\u9fff]{2,}/],
    [5, /^\s*(const|let|var|class|interface|type)\s+[A-Za-z_$]/],
    [4, /<[A-Z][A-Za-z0-9._-]*/],
  ]
  lines.forEach((raw, index) => {
    const text = raw.trim()
    if (!text || text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')) return
    let score = 0
    for (const [weight, pattern] of patterns) if (pattern.test(text)) score = Math.max(score, weight)
    if (!score) return
    scored.push({ line: index + 1, score, text: text.slice(0, 280) })
  })
  const selected = scored.sort((left, right) => right.score - left.score || left.line - right.line).slice(0, maximum)
  return selected.sort((left, right) => left.line - right.line).map(({ score, ...item }) => item)
}

function compactAttributes(value) {
  if (!value || typeof value !== 'object') return {}
  const allowed = ['symbolName', 'semanticRole', 'symbolKind', 'componentName', 'tagName', 'ownerName', 'specifier', 'httpMethod', 'routePath', 'storeName']
  return Object.fromEntries(allowed.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
}

function languageForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return { '.vue': 'Vue SFC', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.html': 'HTML' }[extension] || 'Text'
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function portable(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//, '') : null
}
