import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRepoSupportDecision } from './frontend-support.mjs'
import {
  collectFrontendCensusSignals,
  generatedPath,
  normalizeRepoPath,
  pathWithinRoot,
  stableToken,
  uniqueSorted,
} from './frontend-census-utils.mjs'
import {
  scanBabelReactSemantics,
  scanTypeScriptReactSemantics,
} from './scanning/react-semantic-scanner.mjs'
import * as vueCompilerDom from '@vue/compiler-dom'
import {
  scanBabelVueSemantics,
  scanTypeScriptVueSemantics,
  scanVueSfcSemantics,
} from './scanning/vue-semantic-scanner.mjs'

export const REPO_STATIC_PROGRAM_GRAPH_SCHEMA = 'repo-static-program-graph/v1'

const SOURCE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i
const RESOLUTION_EXTENSIONS = Object.freeze(['', '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'])
const RESOURCE_RESOLUTION_EXTENSIONS = Object.freeze(['', '.css', '.scss', '.sass', '.less', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.json', '.wasm'])
const PROVIDER_PRIORITY = Object.freeze(['typescript', '@babel/parser', '@vue/compiler-sfc', 'svelte/compiler'])
const STATIC_PROGRAM_GRAPH_JSON_SCHEMA = JSON.parse(fs.readFileSync(new URL('../../schemas/static-program-graph.schema.json', import.meta.url), 'utf8'))

/**
 * Build a deterministic frontend program graph from the protected census.
 * Optional compiler packages are loaded at runtime; absence and parser failures
 * are deterministic diagnostics and never agent questions.
 */
export async function buildStaticProgramGraph(input = {}) {
  const signals = collectFrontendCensusSignals(input)
  const supportDecision = input.supportDecision || buildRepoSupportDecision(input)
  const repoRoot = resolveRepoRoot(input, signals)
  const generatedAt = String(
    input.generatedAt
      || signals.inventory?.generatedAt
      || signals.codeMap?.generatedAt
      || supportDecision.generatedAt
      || '1970-01-01T00:00:00.000Z',
  )
  const snapshotId = String(input.snapshotId || supportDecision.snapshotId)
  const diagnostics = []
  const roots = supportDecision.supportLevel === 'unsupported'
    ? []
    : uniqueSorted((supportDecision.frontendRoots || ['.']).map(normalizeRepoPath).filter(Boolean))

  if (supportDecision.supportLevel === 'unsupported') {
    const providers = emptyParserProviders()
    diagnostics.push(makeDiagnostic({
      kind: 'unsupported-repository',
      severity: 'error',
      message: `Static Program Graph is fail-closed: ${supportDecision.unsupportedReason || 'repository unsupported'}.`,
      evidenceRefs: supportDecision.evidenceRefs || [],
    }))
    return finalizeGraph({
      snapshotId,
      supportDecision,
      generatedAt,
      roots,
      providers,
      parsedFiles: [],
      facts: createFactAccumulator(),
      fileSet: new Set(),
      allPathSet: new Set(),
      aliases: { rules: [], baseUrls: [] },
      diagnostics,
      signals,
    })
  }

  const providers = await loadParserProviders(input.parserProviders || {}, diagnostics)
  const records = collectSourceRecords(input, signals)
  const scopedRecords = records.filter(record => roots.some(root => pathWithinRoot(record.path, root)))
  const fileSet = new Set(scopedRecords.map(record => record.path))
  const allPathSet = collectScopedPaths(input, signals, roots)
  const protectedPaths = new Set(scopedRecords
    .filter(record => record.protected || record.contentAnalyzable === false || record.binary)
    .map(record => record.path))
  const contentOverrides = collectContentOverrides(input)
  const configRecords = collectConfigRecords(input, signals)
  const aliases = collectAliases({ repoRoot, roots, fileSet, diagnostics, configRecords, contentOverrides })
  const parsedFiles = []
  const sourceMeta = new Map()
  const facts = createFactAccumulator()

  for (const failure of signals.codeMap?.metrics?.parseFailures || []) {
    const sourcePath = normalizeRepoPath(failure.file || failure.sourcePath) || null
    diagnostics.push(makeDiagnostic({
      kind: 'code-map-parse-failure',
      severity: 'warning',
      message: `Existing deterministic code-map parser failed${sourcePath ? ` for ${sourcePath}` : ''}.`,
      sourcePath,
      details: { provider: 'code-map' },
      evidenceRefs: sourcePath ? [`evidence:file:${sourcePath}`] : [],
    }))
  }

  if (!providers.typescript.available && !providers.babel.available) {
    diagnostics.push(makeDiagnostic({
      kind: 'parser-fallback-active',
      severity: 'warning',
      message: 'No compiler AST provider is available; frontend sources were scanned with the deterministic fallback lexer.',
      details: { attemptedProviders: ['typescript', '@babel/parser'] },
    }))
  }
  if (scopedRecords.some(record => /\.vue$/i.test(record.path)) && !providers.vue.available) {
    diagnostics.push(makeDiagnostic({
      kind: 'vue-compiler-unavailable',
      severity: 'warning',
      message: '@vue/compiler-sfc is unavailable; Vue SFC blocks were scanned with the deterministic fallback lexer.',
      details: { provider: '@vue/compiler-sfc' },
    }))
  }
  if (scopedRecords.some(record => /\.svelte$/i.test(record.path)) && !providers.svelte.available) {
    diagnostics.push(makeDiagnostic({
      kind: 'svelte-compiler-unavailable',
      severity: 'warning',
      message: 'svelte/compiler is unavailable; Svelte component blocks were scanned with the deterministic fallback lexer.',
      details: { provider: 'svelte/compiler' },
    }))
  }

  for (const record of scopedRecords) {
    const source = readSource({ repoRoot, record, contentOverrides, diagnostics })
    if (source === null) {
      parsedFiles.push(fileProvenance(record, 'unreadable', 'none', 'source-unavailable'))
      continue
    }
    const result = await parseSourceFile({ sourcePath: record.path, source, providers })
    for (const item of result.diagnostics) diagnostics.push(makeDiagnostic(item))
    addFileFacts(facts, record.path, result)
    sourceMeta.set(record.path, {
      range: result.fileRange || wholeSourceRange(source),
      structureFingerprint: result.structureFingerprint || structureFingerprint(`module:${record.path}:${source}`),
      provider: result.provider,
      sourceKind: result.sourceKind,
    })
    parsedFiles.push(fileProvenance(record, result.status, result.provider, result.sourceKind))
  }

  addCodeMapFacts(facts, signals.codeMap, fileSet, protectedPaths)
  return finalizeGraph({
    snapshotId,
    supportDecision,
    generatedAt,
    roots,
    providers,
    parsedFiles,
    facts,
    fileSet,
    allPathSet,
    aliases,
    sourceMeta,
    diagnostics,
    signals,
  })
}

export async function buildFrontendStaticProgramGraph(input = {}) {
  return buildStaticProgramGraph(input)
}

export function validateStaticProgramGraph(value) {
  const issues = validateJsonSchema(value, STATIC_PROGRAM_GRAPH_JSON_SCHEMA)
  const nodeIds = new Set()
  for (const node of Array.isArray(value?.nodes) ? value.nodes : []) {
    if (!node?.nodeId || !node?.kind || !node?.label || !node?.source || !Array.isArray(node?.evidenceRefs)) {
      issues.push('nodes require nodeId, kind, label, source, and evidenceRefs')
      continue
    }
    if (nodeIds.has(node.nodeId)) issues.push(`duplicate nodeId: ${node.nodeId}`)
    nodeIds.add(node.nodeId)
  }
  const edgeIds = new Set()
  for (const edge of Array.isArray(value?.edges) ? value.edges : []) {
    if (!edge?.edgeId || !edge?.type || !edge?.from || !edge?.to || !edge?.source || !Array.isArray(edge?.evidenceRefs)) {
      issues.push('edges require edgeId, type, endpoints, source, and evidenceRefs')
      continue
    }
    if (edgeIds.has(edge.edgeId)) issues.push(`duplicate edgeId: ${edge.edgeId}`)
    edgeIds.add(edge.edgeId)
    if (!nodeIds.has(edge.from)) issues.push(`edge source node does not exist: ${edge.edgeId} -> ${edge.from}`)
    if (!nodeIds.has(edge.to)) issues.push(`edge target node does not exist: ${edge.edgeId} -> ${edge.to}`)
  }
  for (const diagnostic of Array.isArray(value?.diagnostics) ? value.diagnostics : []) {
    if (!diagnostic?.diagnosticId || !diagnostic?.kind || !diagnostic?.severity || !diagnostic?.message) {
      issues.push('diagnostics require diagnosticId, kind, severity, and message')
    }
  }
  for (const forbidden of ['openQuestion', 'openQuestions', 'unresolvedSemanticAmbiguities', 'researchContracts']) {
    if (Object.hasOwn(value || {}, forbidden)) issues.push(`${forbidden} is forbidden in Static Program Graph output`)
  }
  if (value?.metrics?.sourceFiles !== (Array.isArray(value?.files) ? value.files.length : -1) && value?.supportLevel !== 'unsupported') {
    issues.push('metrics.sourceFiles must equal files.length')
  }
  if (value?.metrics?.nodeCount !== (Array.isArray(value?.nodes) ? value.nodes.length : -1)) issues.push('metrics.nodeCount must equal nodes.length')
  if (value?.metrics?.edgeCount !== (Array.isArray(value?.edges) ? value.edges.length : -1)) issues.push('metrics.edgeCount must equal edges.length')
  if (value?.metrics?.diagnosticCount !== (Array.isArray(value?.diagnostics) ? value.diagnostics.length : -1)) issues.push('metrics.diagnosticCount must equal diagnostics.length')
  return uniqueSorted(issues)
}

export function writeStaticProgramGraph({ graph, packageDir, outputPath = 'static/static-program-graph.json' }) {
  const issues = validateStaticProgramGraph(graph)
  if (issues.length) throw new Error(`Invalid Static Program Graph:\n- ${issues.join('\n- ')}`)
  const target = path.resolve(packageDir, outputPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
  return target
}

function emptyParserProviders() {
  return {
    typescript: providerRecord('typescript', null),
    babel: providerRecord('@babel/parser', null),
    vue: providerRecord('@vue/compiler-sfc', null),
    svelte: providerRecord('svelte/compiler', null),
  }
}

async function loadParserProviders(injected, diagnostics) {
  const typescript = await loadParserProvider('typescript', ['typescript'], injected)
  const babel = await loadParserProvider('@babel/parser', ['babel', '@babel/parser'], injected)
  const vue = await loadParserProvider('@vue/compiler-sfc', ['vue', '@vue/compiler-sfc'], injected)
  const svelte = await loadParserProvider('svelte/compiler', ['svelte', 'svelte/compiler'], injected)
  const providers = {
    typescript: typescript.provider,
    babel: babel.provider,
    vue: vue.provider,
    svelte: svelte.provider,
  }
  for (const loaded of [typescript, babel, vue, svelte]) {
    const provider = loaded.provider
    if (provider.available) continue
    diagnostics.push(makeDiagnostic({
      kind: loaded.loadError
        ? 'parser-provider-load-failure'
        : provider.incompatible
          ? 'parser-provider-incompatible'
          : 'parser-provider-unavailable',
      severity: loaded.loadError || provider.incompatible ? 'warning' : 'info',
      message: loaded.loadError
        ? `Optional parser provider ${provider.name} failed to load: ${loaded.loadError.code || loaded.loadError.name || 'load error'}.`
        : provider.incompatible
          ? `Optional parser provider ${provider.name} does not expose the required parser API.`
        : `Optional parser provider ${provider.name} is unavailable.`,
      details: { provider: provider.name, explicitlyDisabled: loaded.explicitlyDisabled },
    }))
  }
  return providers
}

async function loadParserProvider(name, keys, injected) {
  const explicitKey = keys.find(key => Object.hasOwn(injected, key))
  if (explicitKey !== undefined) {
    const value = injected[explicitKey]
    return { provider: providerRecord(name, value || null), loadError: null, explicitlyDisabled: !value }
  }
  try {
    const provider = providerRecord(name, await import(name))
    provider.version ||= installedProviderVersion(name)
    return { provider, loadError: null, explicitlyDisabled: false }
  } catch (error) {
    const missing = isRequestedProviderMissing(error, name)
    return { provider: providerRecord(name, null), loadError: missing ? null : error, explicitlyDisabled: false }
  }
}

function installedProviderVersion(name) {
  try {
    let current = path.dirname(fileURLToPath(import.meta.resolve(name)))
    const packageName = externalPackageName(name)
    for (;;) {
      const manifestPath = path.join(current, 'package.json')
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        if (manifest.name === packageName) return String(manifest.version || '') || null
      }
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
  } catch {
    return null
  }
}

function isRequestedProviderMissing(error, name) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') return false
  const message = String(error?.message || '')
  const rootName = externalPackageName(name)
  return [name, rootName].some(candidate => message.includes(`'${candidate}'`) || message.includes(`"${candidate}"`) || message.includes(` ${candidate} `))
}

function providerRecord(name, moduleValue) {
  const candidates = [moduleValue, moduleValue?.default, moduleValue?.default?.default].filter(Boolean)
  const api = candidates.find(candidate => providerApiAvailable(name, candidate)) || null
  const version = candidates.map(candidate => candidate?.version).find(Boolean)
  return {
    name,
    available: Boolean(api),
    version: String(version || '') || null,
    api,
    incompatible: Boolean(moduleValue && !api),
  }
}

function providerApiAvailable(name, candidate) {
  if (name === 'typescript') return typeof candidate?.createSourceFile === 'function' && candidate.ScriptTarget && candidate.ScriptKind
  return typeof candidate?.parse === 'function'
}

async function parseSourceFile({ sourcePath, source, providers }) {
  if (/\.vue$/i.test(sourcePath)) return parseVueSource({ sourcePath, source, providers })
  if (/\.svelte$/i.test(sourcePath)) return parseSvelteSource({ sourcePath, source, providers })
  if (providers.typescript.available) {
    try {
      return parseWithTypescript({ sourcePath, source, ts: providers.typescript.api })
    } catch (error) {
      const diagnostics = [parseFailureDiagnostic(sourcePath, 'typescript', error)]
      if (providers.babel.available) {
        try {
          const parsed = parseWithBabel({ sourcePath, source, babel: providers.babel.api })
          parsed.diagnostics.unshift(...diagnostics)
          if (parsed.status === 'parsed') parsed.status = 'partial'
          return parsed
        } catch (babelError) {
          diagnostics.push(parseFailureDiagnostic(sourcePath, '@babel/parser', babelError))
        }
      }
      const fallback = parseWithFallback({ sourcePath, source })
      fallback.diagnostics.unshift(...diagnostics)
      fallback.status = 'fallback-after-error'
      return fallback
    }
  }
  if (providers.babel.available) {
    try {
      return parseWithBabel({ sourcePath, source, babel: providers.babel.api })
    } catch (error) {
      const fallback = parseWithFallback({ sourcePath, source })
      fallback.diagnostics.unshift(parseFailureDiagnostic(sourcePath, '@babel/parser', error))
      fallback.status = 'fallback-after-error'
      return fallback
    }
  }
  return parseWithFallback({ sourcePath, source })
}

function parseWithTypescript({ sourcePath, source, ts }) {
  const scriptKind = typescriptScriptKind(ts, sourcePath)
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, scriptKind)
  const result = emptyParseResult('typescript', 'compiler-ast', 'parsed')
  const routeContext = routeContextFor(sourcePath, source)
  for (const item of sourceFile.parseDiagnostics || []) {
    const line = item.start === undefined ? null : sourceFile.getLineAndCharacterOfPosition(item.start).line + 1
    result.diagnostics.push({
      kind: 'parse-failure',
      severity: 'warning',
      message: `TypeScript parser diagnostic: ${flattenTsMessage(item.messageText)}`,
      sourcePath,
      line,
      details: { provider: 'typescript', code: item.code },
      evidenceRefs: [`evidence:file:${sourcePath}`],
    })
    result.status = 'partial'
  }
  const lineOf = node => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  const metaOf = node => typescriptFactProvenance(ts, sourceFile, node)
  const hasExport = node => Boolean(node.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword || item.kind === ts.SyntaxKind.DefaultKeyword))
  const visit = (node, exportedContext = false) => {
    const exported = exportedContext || hasExport(node)
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      result.imports.push(importFact(node.moduleSpecifier.text, 'static', lineOf(node), importBindingsFromTs(ts, node.importClause), 'typescript', 'compiler-ast', metaOf(node)))
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      result.imports.push(importFact(node.moduleSpecifier.text, 're-export', lineOf(node), [], 'typescript', 'compiler-ast', metaOf(node)))
    } else if (ts.isCallExpression(node)) {
      const first = node.arguments?.[0]
      if (node.expression?.kind === ts.SyntaxKind.ImportKeyword && first && ts.isStringLiteralLike(first)) {
        result.imports.push(importFact(first.text, 'dynamic', lineOf(node), [], 'typescript', 'compiler-ast', metaOf(node)))
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && first && ts.isStringLiteralLike(first)) {
        result.imports.push(importFact(first.text, 'require', lineOf(node), [], 'typescript', 'compiler-ast', metaOf(node)))
      }
    }
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements || []) {
        result.exports.push(exportFact(element.propertyName?.text || element.name.text, element.name.text, lineOf(element), 'typescript', 'compiler-ast', metaOf(element)))
      }
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      result.exports.push(exportFact(node.expression.text, 'default', lineOf(node), 'typescript', 'compiler-ast', metaOf(node)))
    }
    if (ts.isFunctionDeclaration(node) && node.name) result.symbols.push(symbolFact(node.name.text, 'function', lineOf(node), exported, 'typescript', 'compiler-ast', metaOf(node)))
    if (ts.isClassDeclaration(node) && node.name) result.symbols.push(symbolFact(node.name.text, 'class', lineOf(node), exported, 'typescript', 'compiler-ast', metaOf(node)))
    if (ts.isInterfaceDeclaration(node)) result.symbols.push(symbolFact(node.name.text, 'interface', lineOf(node), exported, 'typescript', 'compiler-ast', metaOf(node)))
    if (ts.isTypeAliasDeclaration(node)) result.symbols.push(symbolFact(node.name.text, 'type', lineOf(node), exported, 'typescript', 'compiler-ast', metaOf(node)))
    if (ts.isEnumDeclaration(node)) result.symbols.push(symbolFact(node.name.text, 'enum', lineOf(node), exported, 'typescript', 'compiler-ast', metaOf(node)))
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations || []) {
        if (ts.isIdentifier(declaration.name)) {
          result.symbols.push(symbolFact(declaration.name.text, variableKindTs(ts, declaration), lineOf(declaration), exported, 'typescript', 'compiler-ast', metaOf(declaration)))
        }
      }
    }
    if (ts.isJsxOpeningElement?.(node) || ts.isJsxSelfClosingElement?.(node)) {
      const name = node.tagName?.getText(sourceFile) || ''
      if (componentName(name)) result.componentRefs.push(componentFact(name, lineOf(node), 'typescript', 'compiler-ast', metaOf(node)))
    }
    if (routeContext && ts.isPropertyAssignment(node) && propertyNameTs(node.name) === 'path' && ts.isStringLiteralLike(node.initializer)) {
      result.routes.push(routeFact(node.initializer.text, lineOf(node), 'typescript', 'compiler-ast', {
        ...metaOf(node),
        pageSpecifiers: typescriptRouteComponentSpecifiers(ts, node.parent),
      }))
    }
    const childExportedContext = ts.isExportAssignment?.(node) || ts.isExportDeclaration?.(node) ? true : exportedContext
    ts.forEachChild(node, child => visit(child, childExportedContext))
  }
  visit(sourceFile)
  mergeSemanticParseResult(result, scanTypeScriptReactSemantics({ sourcePath, source, sourceFile, ts }))
  mergeSemanticParseResult(result, scanTypeScriptVueSemantics({ sourcePath, source, sourceFile, ts }))
  return dedupeParseResult(result)
}

function parseWithBabel({ sourcePath, source, babel }) {
  const parser = babel.parse ? babel : babel.default
  const ast = parser.parse(source, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: babelPluginsFor(sourcePath),
  })
  const result = emptyParseResult('@babel/parser', 'parser-ast', ast.errors?.length ? 'partial' : 'parsed')
  const routeContext = routeContextFor(sourcePath, source)
  for (const error of ast.errors || []) {
    result.diagnostics.push({
      kind: 'parse-failure',
      severity: 'warning',
      message: `Babel parser diagnostic: ${error.message}`,
      sourcePath,
      line: error.loc?.line || null,
      details: { provider: '@babel/parser' },
      evidenceRefs: [`evidence:file:${sourcePath}`],
    })
  }
  walkBabel(ast.program || ast, null, [], (node, parent, ancestors) => {
    const line = node.loc?.start?.line || 1
    const meta = babelFactProvenance(node)
    const exported = isBabelExportNode(parent)
      || (node.type === 'VariableDeclarator' && isBabelExportNode(ancestors.at(-2)))
    if (node.type === 'ImportDeclaration') {
      result.imports.push(importFact(node.source.value, 'static', line, importBindingsFromBabel(node), '@babel/parser', 'parser-ast', meta))
    } else if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source?.value) {
      result.imports.push(importFact(node.source.value, 're-export', line, [], '@babel/parser', 'parser-ast', meta))
    } else if (node.type === 'ImportExpression' && node.source?.type === 'StringLiteral') {
      result.imports.push(importFact(node.source.value, 'dynamic', line, [], '@babel/parser', 'parser-ast', meta))
    } else if (node.type === 'CallExpression') {
      const first = node.arguments?.[0]
      if ((node.callee?.type === 'Import' || node.callee?.type === 'ImportExpression') && stringValue(first) !== null) {
        result.imports.push(importFact(stringValue(first), 'dynamic', line, [], '@babel/parser', 'parser-ast', meta))
      } else if (node.callee?.type === 'Identifier' && node.callee.name === 'require' && stringValue(first) !== null) {
        result.imports.push(importFact(stringValue(first), 'require', line, [], '@babel/parser', 'parser-ast', meta))
      }
    }
    if (node.type === 'ExportNamedDeclaration' && !node.source) {
      for (const specifier of node.specifiers || []) {
        const localName = specifier.local?.name || specifier.local?.value
        const exportedName = specifier.exported?.name || specifier.exported?.value || localName
        if (localName) result.exports.push(exportFact(localName, exportedName, specifier.loc?.start?.line || line, '@babel/parser', 'parser-ast', babelFactProvenance(specifier)))
      }
    }
    if (node.type === 'ExportDefaultDeclaration' && node.declaration?.type === 'Identifier') {
      result.exports.push(exportFact(node.declaration.name, 'default', line, '@babel/parser', 'parser-ast', meta))
    }
    if (node.type === 'FunctionDeclaration' && node.id?.name) result.symbols.push(symbolFact(node.id.name, 'function', line, exported, '@babel/parser', 'parser-ast', meta))
    if (node.type === 'ClassDeclaration' && node.id?.name) result.symbols.push(symbolFact(node.id.name, 'class', line, exported, '@babel/parser', 'parser-ast', meta))
    if (node.type === 'TSInterfaceDeclaration' && node.id?.name) result.symbols.push(symbolFact(node.id.name, 'interface', line, exported, '@babel/parser', 'parser-ast', meta))
    if (node.type === 'TSTypeAliasDeclaration' && node.id?.name) result.symbols.push(symbolFact(node.id.name, 'type', line, exported, '@babel/parser', 'parser-ast', meta))
    if (node.type === 'TSEnumDeclaration' && node.id?.name) result.symbols.push(symbolFact(node.id.name, 'enum', line, exported, '@babel/parser', 'parser-ast', meta))
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') result.symbols.push(symbolFact(node.id.name, variableKindBabel(node), line, exported, '@babel/parser', 'parser-ast', meta))
    if (node.type === 'JSXOpeningElement') {
      const name = babelJsxName(node.name)
      if (componentName(name)) result.componentRefs.push(componentFact(name, line, '@babel/parser', 'parser-ast', meta))
    }
    if (routeContext && (node.type === 'ObjectProperty' || node.type === 'Property') && babelPropertyName(node.key) === 'path' && stringValue(node.value) !== null) {
      result.routes.push(routeFact(stringValue(node.value), line, '@babel/parser', 'parser-ast', {
        ...meta,
        pageSpecifiers: babelRouteComponentSpecifiers(parent),
      }))
    }
  })
  mergeSemanticParseResult(result, scanBabelReactSemantics({ sourcePath, source, ast }))
  mergeSemanticParseResult(result, scanBabelVueSemantics({ sourcePath, source, ast }))
  return dedupeParseResult(result)
}

async function parseVueSource({ sourcePath, source, providers }) {
  if (!providers.vue.available) return parseVueFallback({ sourcePath, source, providers })
  try {
    const compiler = providers.vue.api
    const parsed = compiler.parse(source, { filename: sourcePath })
    const descriptor = parsed.descriptor || parsed
    const result = emptyParseResult('@vue/compiler-sfc', 'compiler-ast', parsed.errors?.length ? 'partial' : 'parsed')
    for (const error of parsed.errors || []) {
      result.diagnostics.push({
        kind: 'parse-failure',
        severity: 'warning',
        message: `Vue SFC parser diagnostic: ${error.message || String(error)}`,
        sourcePath,
        line: error.loc?.start?.line || null,
        details: { provider: '@vue/compiler-sfc' },
        evidenceRefs: [`evidence:file:${sourcePath}`],
      })
    }
    for (const block of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
      const virtualPath = block.lang === 'ts' || block.lang === 'tsx' ? `${sourcePath}.tsx` : `${sourcePath}.jsx`
      const child = await parseSourceFile({ sourcePath: virtualPath, source: block.content, providers: { ...providers, vue: { ...providers.vue, available: false } } })
      mergeParseResult(result, child, Math.max(0, (block.loc?.start?.line || 1) - 1))
    }
    const vueSemantic = scanVueSfcSemantics({ sourcePath, source, descriptor, compilerDom: vueCompilerDom })
    mergeSemanticParseResult(result, vueSemantic)
    result.componentRefs.push(...vueSemantic.componentRefs)
    const embeddedProviders = (descriptor.script || descriptor.scriptSetup)
      ? scriptProvider(result).split('+').filter(Boolean)
      : []
    result.provider = uniqueSorted([
      '@vue/compiler-sfc',
      descriptor.template ? '@vue/compiler-dom' : null,
      ...embeddedProviders,
    ].filter(Boolean)).join('+')
    return dedupeParseResult(result)
  } catch (error) {
    const fallback = await parseVueFallback({ sourcePath, source, providers })
    fallback.diagnostics.unshift(parseFailureDiagnostic(sourcePath, '@vue/compiler-sfc', error))
    fallback.status = 'fallback-after-error'
    return fallback
  }
}

async function parseVueFallback({ sourcePath, source, providers }) {
  const result = emptyParseResult('fallback-lexer', 'fallback-lexer', 'fallback')
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let match
  while ((match = scriptPattern.exec(source))) {
    const before = source.slice(0, match.index)
    const offset = lineFromOffset(before, before.length) - 1
    const lang = /\blang\s*=\s*["']tsx?["']/i.test(match[1]) ? 'tsx' : 'jsx'
    const child = await parseSourceFile({ sourcePath: `${sourcePath}.${lang}`, source: match[2], providers: { ...providers, vue: { ...providers.vue, available: false } } })
    mergeParseResult(result, child, offset)
  }
  if (!result.imports.length && !result.symbols.length) mergeParseResult(result, parseWithFallback({ sourcePath, source }), 0)
  for (const component of fallbackComponentRefs(source, sourcePath, true)) result.componentRefs.push(component)
  result.provider = scriptProvider(result)
  return dedupeParseResult(result)
}

async function parseSvelteSource({ sourcePath, source, providers }) {
  if (!providers.svelte.available) return parseSvelteFallback({ sourcePath, source, providers })
  try {
    const parsed = providers.svelte.api.parse(source, { filename: sourcePath })
    const result = emptyParseResult('svelte/compiler', 'compiler-ast', 'parsed')
    await mergeEmbeddedScripts({ sourcePath, source, providers, result })
    collectSvelteComponents(parsed, source, result.componentRefs)
    result.provider = `svelte/compiler+${scriptProvider(result)}`
    return dedupeParseResult(result)
  } catch (error) {
    const fallback = await parseSvelteFallback({ sourcePath, source, providers })
    fallback.diagnostics.unshift(parseFailureDiagnostic(sourcePath, 'svelte/compiler', error))
    fallback.status = 'fallback-after-error'
    return fallback
  }
}

async function parseSvelteFallback({ sourcePath, source, providers }) {
  const result = emptyParseResult('fallback-lexer', 'fallback-lexer', 'fallback')
  await mergeEmbeddedScripts({ sourcePath, source, providers, result })
  if (!result.imports.length && !result.symbols.length) mergeParseResult(result, parseWithFallback({ sourcePath, source }), 0)
  result.componentRefs.push(...fallbackComponentRefs(source, sourcePath, true))
  result.provider = scriptProvider(result)
  return dedupeParseResult(result)
}

async function mergeEmbeddedScripts({ sourcePath, source, providers, result }) {
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let match
  while ((match = scriptPattern.exec(source))) {
    const contentOffset = match.index + match[0].indexOf(match[2])
    const offset = lineFromOffset(source, contentOffset) - 1
    const lang = /\blang\s*=\s*["']tsx?["']/i.test(match[1]) ? 'tsx' : 'jsx'
    const child = await parseSourceFile({
      sourcePath: `${sourcePath}.${lang}`,
      source: match[2],
      providers: {
        ...providers,
        vue: { ...providers.vue, available: false },
        svelte: { ...providers.svelte, available: false },
      },
    })
    mergeParseResult(result, child, offset)
  }
}

function collectSvelteComponents(root, source, target) {
  const seen = new Set()
  const visit = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if (['InlineComponent', 'Component'].includes(node.type) && componentName(node.name || '')) {
      target.push(componentFact(node.name, node.loc?.start?.line || lineFromOffset(source, node.start || 0), 'svelte/compiler', 'compiler-ast'))
    }
    for (const [key, value] of Object.entries(node)) {
      if (['parent', 'metadata', 'comments'].includes(key)) continue
      if (Array.isArray(value)) for (const child of value) visit(child)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(root)
}

function parseWithFallback({ sourcePath, source }) {
  const result = emptyParseResult('fallback-lexer', 'fallback-lexer', 'fallback')
  const addImportMatches = (pattern, kind, specifierIndex, bindingsIndex = null) => {
    for (const match of source.matchAll(pattern)) {
      result.imports.push(importFact(
        match[specifierIndex],
        kind,
        lineFromOffset(source, match.index),
        bindingsIndex === null ? [] : importBindingsFromText(match[bindingsIndex]),
        'fallback-lexer',
        'fallback-lexer',
        textFactProvenance(source, match.index, match[0].length, `import:${kind}`),
      ))
    }
  }
  addImportMatches(/\bimport\s+(?:type\s+)?([^;'"\n][^;'"']{0,1999}?)\s+from\s+["']([^"']+)["']/g, 'static', 2, 1)
  addImportMatches(/\bimport\s+["']([^"']+)["']/g, 'static', 1)
  addImportMatches(/\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g, 're-export', 1)
  addImportMatches(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, 'dynamic', 1)
  addImportMatches(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, 'require', 1)

  const symbolPatterns = [
    [/\b(export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, 'function'],
    [/\b(export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)\b/g, 'class'],
    [/\b(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/g, 'interface'],
    [/\b(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g, 'type'],
    [/\b(export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/g, 'enum'],
    [/\b(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 'variable'],
  ]
  for (const [pattern, kind] of symbolPatterns) {
    for (const match of source.matchAll(pattern)) {
      result.symbols.push(symbolFact(
        match[2],
        kind,
        lineFromOffset(source, match.index),
        Boolean(match[1]),
        'fallback-lexer',
        'fallback-lexer',
        textFactProvenance(source, match.index, match[0].length, `symbol:${kind}`),
      ))
    }
  }
  for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}(?!\s*from)/g)) {
    for (const value of match[1].split(',')) {
      const [localName, exportedName] = value.trim().replace(/^type\s+/, '').split(/\s+as\s+/i)
      if (/^[A-Za-z_$][\w$]*$/.test(localName || '')) {
        result.exports.push(exportFact(
          localName,
          exportedName || localName,
          lineFromOffset(source, match.index),
          'fallback-lexer',
          'fallback-lexer',
          textFactProvenance(source, match.index, match[0].length, 'export:named'),
        ))
      }
    }
  }
  for (const match of source.matchAll(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|$)/gm)) {
    result.exports.push(exportFact(
      match[1],
      'default',
      lineFromOffset(source, match.index),
      'fallback-lexer',
      'fallback-lexer',
      textFactProvenance(source, match.index, match[0].length, 'export:default'),
    ))
  }
  if (routeContextFor(sourcePath, source)) {
    for (const match of source.matchAll(/\bpath\s*:\s*["']([^"']+)["']/g)) {
      result.routes.push(routeFact(
        match[1],
        lineFromOffset(source, match.index),
        'fallback-lexer',
        'fallback-lexer',
        textFactProvenance(source, match.index, match[0].length, 'route:path'),
      ))
    }
  }
  result.componentRefs.push(...fallbackComponentRefs(source, sourcePath, /\.vue(?:\.|$)/i.test(sourcePath)))
  return dedupeParseResult(result)
}

function finalizeGraph(context) {
  const nodes = []
  const edges = []
  const diagnostics = [...context.diagnostics]
  const frameworks = uniqueSorted(context.signals.frameworkNames || [])
  const frameworkValue = frameworks.length ? frameworks : ['unknown']
  const modulePaths = [...context.fileSet].sort((left, right) => left.localeCompare(right))
  for (const sourcePath of modulePaths) {
    const meta = context.sourceMeta?.get(sourcePath)
    nodes.push({
      nodeId: moduleId(sourcePath),
      kind: 'module',
      label: sourcePath,
      language: languageForPath(sourcePath),
      frameworks: frameworkValue,
      source: sourceProvenance(
        sourcePath,
        meta?.range?.start?.line || null,
        meta?.provider || 'inventory',
        meta?.sourceKind || 'inventory',
        meta?.range || null,
        meta?.structureFingerprint || structureFingerprint(`module:${sourcePath}`),
      ),
      evidenceRefs: [`evidence:file:${sourcePath}`],
      attributes: { sourcePath },
    })
  }

  const symbolFacts = preferredFacts(context.facts.symbols, item => `${item.file}:${item.kind}:${item.name}:${item.line}`)
  const symbolByName = new Map()
  for (const fact of symbolFacts) {
    const nodeId = symbolId(fact)
    nodes.push({
      nodeId,
      kind: 'symbol',
      label: fact.name,
      language: languageForPath(fact.file),
      frameworks: frameworkValue,
      source: sourceProvenanceForFact(fact),
      evidenceRefs: [`evidence:file:${fact.file}`],
      attributes: { symbolKind: fact.kind, exported: Boolean(fact.exported) },
    })
    if (!symbolByName.has(fact.name)) symbolByName.set(fact.name, [])
    symbolByName.get(fact.name).push({ fact, nodeId })
    edges.push(graphEdge('declares', moduleId(fact.file), nodeId, fact))
    if (fact.exported) edges.push(graphEdge('exports', moduleId(fact.file), nodeId, fact))
  }

  const semanticNodes = new Map()
  const addSemanticNode = (kind, fact, label, attributes = {}) => {
    const nodeId = semanticId(kind, fact)
    if (!semanticNodes.has(nodeId)) {
      nodes.push({
        nodeId,
        kind,
        label: String(label || kind),
        language: languageForPath(fact.file),
        frameworks: frameworkValue,
        source: sourceProvenanceForFact(fact),
        evidenceRefs: fact.file ? [`evidence:file:${fact.file}`] : [],
        attributes,
      })
      semanticNodes.set(nodeId, { fact, nodeId, kind })
      if (fact.file && context.fileSet.has(fact.file)) edges.push(graphEdge('declares', moduleId(fact.file), nodeId, fact, { semanticKind: kind }))
    }
    return nodeId
  }

  const roleFacts = preferredFacts(context.facts.componentRoles, item => `${item.file}:${item.role}:${item.name}:${rangeOffset(item)}`)
  const roleEntries = []
  for (const fact of roleFacts) {
    const kind = ['page', 'layout', 'auth-guard'].includes(fact.role) ? fact.role : null
    if (!kind) continue
    const nodeId = addSemanticNode(kind, fact, fact.name, {
      symbolName: fact.name,
      semanticRole: kind,
      deterministicClassification: true,
    })
    roleEntries.push({ fact, nodeId, kind })
  }

  const bootstrapFacts = preferredFacts(context.facts.bootstraps, item => `${item.file}:${item.rootComponentName}:${rangeOffset(item)}`)
  const bootstrapEntries = bootstrapFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('bootstrap', fact, fact.label, {
      rootComponentName: fact.rootComponentName,
      container: fact.container || null,
      deterministicRegistration: true,
    }),
  }))

  const handlerFacts = preferredFacts(context.facts.handlers, item => `${item.file}:${item.name}:${rangeOffset(item)}`)
  const handlerEntries = handlerFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('handler', fact, fact.name, { handlerName: fact.name, symbolName: fact.name }),
  }))
  const stateFacts = preferredFacts(context.facts.states, item => `${item.file}:${item.ownerName}:${item.stateName}:${rangeOffset(item)}`)
  const stateEntries = stateFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('state', fact, fact.stateName, {
      stateName: fact.stateName,
      setterName: fact.setterName,
      ownerName: fact.ownerName || null,
    }),
  }))
  const uiElementFacts = preferredFacts(context.facts.uiElements, item => `${item.file}:${item.ownerName}:${item.elementName}:${rangeOffset(item)}`)
  const uiElementEntries = uiElementFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('ui-element', fact, fact.label, {
      tagName: fact.elementName,
      elementType: fact.elementName,
      ownerName: fact.ownerName || null,
      elementRef: fact.elementRef,
    }),
  }))
  const uiEventFacts = preferredFacts(context.facts.uiEvents, item => `${item.file}:${item.eventName}:${item.handlerName}:${item.elementRef}:${rangeOffset(item)}`)
  const uiEventEntries = uiEventFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('ui-event', fact, fact.eventName, {
      eventName: fact.eventName,
      jsxAttribute: fact.eventName,
      handlerName: fact.handlerName || null,
      elementName: fact.elementName || null,
      interactionKind: fact.interactionKind || null,
      visibleText: fact.visibleText || null,
      componentTag: fact.componentTag === true,
      componentListener: false,
      actionSeed: Boolean(fact.interactionKind),
      elementRef: fact.elementRef,
    }),
  }))
  const componentEmitFacts = preferredFacts(context.facts.componentEmits, item => `${item.file}:${item.eventName}:${item.handlerName}:${rangeOffset(item)}`)
  const componentEmitEntries = componentEmitFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('component-event', fact, fact.eventName, {
      eventName: fact.eventName,
      handlerName: fact.handlerName || null,
      ownerName: fact.ownerName || null,
      deterministicComponentEvent: true,
    }),
  }))
  const requestFacts = preferredFacts(context.facts.requests, item => `${item.file}:${item.handlerName}:${item.method}:${item.url}:${rangeOffset(item)}`)
  const requestEntries = requestFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('request', fact, fact.label, {
      callee: fact.callee,
      method: fact.method,
      url: fact.url || null,
      handlerName: fact.handlerName || null,
      collaboratorName: fact.collaboratorName || null,
      collaboratorMethod: fact.collaboratorMethod || null,
      collaboratorSource: fact.collaboratorSource || null,
      deterministicRequest: true,
    }),
  }))
  const endpointEntries = []
  for (const request of requestEntries) {
    const endpointFact = { ...request.fact, label: request.fact.url || '<dynamic endpoint>' }
    const nodeId = addSemanticNode('endpoint', endpointFact, endpointFact.label, {
      url: request.fact.url || null,
      endpoint: request.fact.url || null,
      dynamic: !request.fact.url,
    })
    endpointEntries.push({ fact: endpointFact, nodeId, request })
  }
  const responseFacts = preferredFacts(context.facts.responses, item => `${item.file}:${item.requestRef}:${item.responseName || ''}:${rangeOffset(item)}`)
  const responseEntries = responseFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('response', fact, fact.label, {
      responseName: fact.responseName || null,
      requestRef: fact.requestRef,
      handlerName: fact.handlerName || null,
      candidateOnly: true,
    }),
  }))
  const feedbackFacts = preferredFacts(context.facts.feedbackCandidates, item => `${item.file}:${item.ownerName}:${item.feedbackKind}:${rangeOffset(item)}`)
  const feedbackEntries = feedbackFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('feedback-candidate', fact, fact.label, {
      feedbackKind: fact.feedbackKind,
      visibleText: fact.visibleText || null,
      dependsOnStates: fact.dependsOnStates || [],
      candidateOnly: true,
      deterministicVisibleSignal: true,
      semanticClaim: false,
    }),
  }))
  const outcomeFacts = preferredFacts(context.facts.outcomeCandidates, item => `${item.file}:${item.signalKind}:${item.target || ''}:${rangeOffset(item)}`)
  const outcomeEntries = outcomeFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('outcome-candidate', fact, fact.label, {
      signalKind: fact.signalKind,
      target: fact.target || null,
      dependsOnStates: fact.dependsOnStates || [],
      candidateOnly: true,
      deterministicVisibleSignal: true,
      semanticClaim: false,
    }),
  }))
  const buildFacts = preferredFacts(context.facts.buildWirings, item => `${item.file}:${item.tool}:${rangeOffset(item)}`)
  const buildEntries = buildFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('build-wiring', fact, fact.label, { tool: fact.tool, configPath: fact.sourcePath || fact.file }),
  }))
  const testFacts = preferredFacts(context.facts.testWirings, item => `${item.file}:${item.tool}:${rangeOffset(item)}`)
  const testEntries = testFacts.map(fact => ({
    fact,
    nodeId: addSemanticNode('test-wiring', fact, fact.label, { tool: fact.tool, testPath: fact.sourcePath || fact.file }),
  }))

  const exportFacts = preferredFacts(context.facts.exports, item => `${item.file}:${item.localName}:${item.exportedName}:${item.line}`)
  for (const fact of exportFacts) {
    const target = (symbolByName.get(fact.localName) || []).find(item => item.fact.file === fact.file)
    if (target) {
      const targetNode = nodes.find(node => node.nodeId === target.nodeId)
      if (targetNode) {
        targetNode.attributes.exported = true
        targetNode.attributes.exportedNames = uniqueSorted([...(targetNode.attributes.exportedNames || []), fact.exportedName])
      }
      edges.push(graphEdge('exports', moduleId(fact.file), target.nodeId, fact, { exportedName: fact.exportedName }))
    } else {
      diagnostics.push(makeDiagnostic({
        kind: 'export-symbol-unresolved',
        severity: 'warning',
        message: `Could not bind exported symbol "${fact.localName}" in ${fact.file}.`,
        sourcePath: fact.file,
        line: fact.line,
        evidenceRefs: [`evidence:file:${fact.file}`],
      }))
    }
  }

  const parsedRouteKeys = new Set(context.facts.routes
    .filter(item => item.provider !== 'code-map')
    .map(item => `${item.file}:${item.path}`))
  const routeFacts = preferredFacts(context.facts.routes
    .filter(item => item.provider !== 'code-map' || !parsedRouteKeys.has(`${item.file}:${item.path}`)), item => `${item.file}:${item.path}:${item.line}`)
  const routeEntries = []
  for (const fact of routeFacts) {
    const nodeId = routeId(fact)
    nodes.push({
      nodeId,
      kind: 'route',
      label: fact.path,
      language: languageForPath(fact.file),
      frameworks: frameworkValue,
      source: sourceProvenanceForFact(fact),
      evidenceRefs: [`evidence:file:${fact.file}`],
      attributes: { routePath: fact.path },
    })
    edges.push(graphEdge('declares-route', moduleId(fact.file), nodeId, fact))
    routeEntries.push({ fact, nodeId })
  }

  const importFacts = preferredFacts(context.facts.imports, item => `${item.file}:${item.kind}:${item.specifier}:${item.line}`)
  const resolvedImportTargets = new Map()
  for (const fact of importFacts) {
    const resolution = resolveImport(fact.file, fact.specifier, context.fileSet, context.allPathSet, context.aliases)
    let targetId
    if (resolution.kind === 'module') {
      targetId = moduleId(resolution.path)
    } else if (resolution.kind === 'resource') {
      targetId = resourceId(resolution.path)
      if (!nodes.some(node => node.nodeId === targetId)) {
        nodes.push({
          nodeId: targetId,
          kind: 'resource',
          label: resolution.path,
          language: resourceLanguageForPath(resolution.path),
          frameworks: frameworkValue,
          source: sourceProvenanceForFact(fact),
          evidenceRefs: [`evidence:file:${fact.file}`, `evidence:file:${resolution.path}`],
          attributes: { sourcePath: resolution.path, provenanceKind: 'import-occurrence' },
        })
      }
    } else if (resolution.kind === 'external') {
      targetId = externalId(resolution.packageName)
      if (!nodes.some(node => node.nodeId === targetId)) {
        nodes.push({
          nodeId: targetId,
          kind: 'external-package',
          label: resolution.packageName,
          language: 'external',
          frameworks: frameworkValue,
          source: sourceProvenance(null, fact.line, fact.provider, fact.sourceKind, fact.range, fact.structureFingerprint),
          evidenceRefs: [`evidence:file:${fact.file}`],
          attributes: { packageName: resolution.packageName },
        })
      }
    } else {
      targetId = unresolvedId(fact.file, fact.specifier)
      if (!nodes.some(node => node.nodeId === targetId)) {
        nodes.push({
          nodeId: targetId,
          kind: 'unresolved-module',
          label: fact.specifier,
          language: 'unknown',
          frameworks: frameworkValue,
          source: sourceProvenanceForFact(fact),
          evidenceRefs: [`evidence:file:${fact.file}`],
          attributes: { specifier: fact.specifier },
        })
      }
      diagnostics.push(makeDiagnostic({
        kind: 'import-resolution-failure',
        severity: 'warning',
        message: `Could not resolve import "${fact.specifier}" from ${fact.file}.`,
        sourcePath: fact.file,
        line: fact.line,
        details: { specifier: fact.specifier },
        evidenceRefs: [`evidence:file:${fact.file}`],
      }))
    }
    const type = resolution.kind === 'resource'
      ? 'imports-resource'
      : fact.kind === 'dynamic'
        ? 'dynamic-imports'
        : fact.kind === 're-export'
          ? 're-exports-from'
          : 'imports'
    resolvedImportTargets.set(`${fact.file}:${fact.specifier}`, { ...resolution, nodeId: targetId })
    edges.push(graphEdge(type, moduleId(fact.file), targetId, fact, { specifier: fact.specifier, resolution: resolution.kind }))
  }

  for (const bootstrap of bootstrapEntries) {
    const importedTarget = resolveImportedComponent({
      componentName: bootstrap.fact.rootComponentName,
      sourcePath: bootstrap.fact.file,
      importFacts,
      resolvedImportTargets,
      symbolByName,
      exportFacts,
    })
    const localTarget = (symbolByName.get(bootstrap.fact.rootComponentName) || []).find(item => item.fact.file === bootstrap.fact.file)
    const targetId = localTarget?.nodeId || importedTarget?.nodeId || moduleId(bootstrap.fact.file)
    edges.push(graphEdge('registers-root', bootstrap.nodeId, targetId, bootstrap.fact, {
      rootComponentName: bootstrap.fact.rootComponentName,
      resolution: localTarget ? 'local-symbol' : importedTarget?.resolution || 'module-fallback',
    }))
    for (const route of routeEntries) {
      edges.push(graphEdge('uses-router', bootstrap.nodeId, route.nodeId, bootstrap.fact, {
        registration: 'router-provider',
        deterministicWiring: true,
      }))
    }
  }

  for (const route of routeEntries) {
    const renderedTargetIds = new Set()
    for (const name of route.fact.pageNames || []) {
      const target = resolveSemanticRoleTarget({
        componentName: name,
        role: 'page',
        sourcePath: route.fact.file,
        roleEntries,
        importFacts,
        resolvedImportTargets,
      })
      if (target) {
        renderedTargetIds.add(target.nodeId)
        edges.push(graphEdge('route-renders-page', route.nodeId, target.nodeId, route.fact, {
          componentName: name,
          deterministicBinding: true,
          resolution: 'component-binding',
        }))
      }
    }
    for (const specifier of route.fact.pageSpecifiers || []) {
      const resolution = resolvedImportTargets.get(`${route.fact.file}:${specifier}`)
      if (resolution?.kind !== 'module') continue
      const page = roleEntries.find(item => item.kind === 'page' && item.fact.file === resolution.path)
      const targetId = page?.nodeId || resolution.nodeId
      if (renderedTargetIds.has(targetId)) continue
      renderedTargetIds.add(targetId)
      edges.push(graphEdge('route-renders-page', route.nodeId, targetId, route.fact, {
        componentSpecifier: specifier,
        deterministicBinding: true,
        resolution: 'dynamic-import',
      }))
    }
    for (const name of route.fact.layoutNames || []) {
      const target = resolveSemanticRoleTarget({
        componentName: name,
        role: 'layout',
        sourcePath: route.fact.file,
        roleEntries,
        importFacts,
        resolvedImportTargets,
      })
      if (target) edges.push(graphEdge('route-uses-layout', route.nodeId, target.nodeId, route.fact, { componentName: name, deterministicBinding: true }))
    }
    for (const name of route.fact.guardNames || []) {
      const target = resolveSemanticRoleTarget({
        componentName: name,
        role: 'auth-guard',
        sourcePath: route.fact.file,
        roleEntries,
        importFacts,
        resolvedImportTargets,
      })
      if (target) edges.push(graphEdge('guarded-by', route.nodeId, target.nodeId, route.fact, { componentName: name, deterministicBinding: true }))
    }
  }

  for (const element of uiElementEntries) {
    const role = roleEntries.find(item => item.fact.file === element.fact.file && item.fact.name === element.fact.ownerName)
    const symbol = (symbolByName.get(element.fact.ownerName) || []).find(item => item.fact.file === element.fact.file)
    const ownerId = role?.nodeId || symbol?.nodeId || moduleId(element.fact.file)
    edges.push(graphEdge('contains-ui-element', ownerId, element.nodeId, element.fact, { ownerName: element.fact.ownerName || null }))
  }
  for (const event of uiEventEntries) {
    const element = uiElementEntries.find(item => item.fact.file === event.fact.file && item.fact.elementRef === event.fact.elementRef)
    if (element) edges.push(graphEdge('emits-ui-event', element.nodeId, event.nodeId, event.fact, { eventName: event.fact.eventName }))
    const handler = handlerEntries.find(item => item.fact.file === event.fact.file && item.fact.name === event.fact.handlerName)
    const importedComponent = event.fact.componentTag
      ? resolveImportedComponent({
          componentName: event.fact.elementName,
          sourcePath: event.fact.file,
          importFacts,
          resolvedImportTargets,
          symbolByName,
          exportFacts,
        })
      : null
    const matchingEmits = importedComponent?.sourcePath
      ? componentEmitEntries.filter(item => item.fact.file === importedComponent.sourcePath && item.fact.eventName === event.fact.eventName)
      : []
    const eventNode = nodes.find(node => node.nodeId === event.nodeId)
    if (eventNode && matchingEmits.length) {
      eventNode.attributes.componentListener = true
      eventNode.attributes.actionSeed = false
      eventNode.attributes.componentSourcePath = importedComponent.sourcePath
      for (const matchingEmit of matchingEmits) {
        edges.push(graphEdge('listens-component-event', matchingEmit.nodeId, event.nodeId, event.fact, {
          eventName: event.fact.eventName,
          componentSourcePath: importedComponent.sourcePath,
        }))
      }
    }
    if (handler) {
      edges.push(graphEdge('invokes-handler', event.nodeId, handler.nodeId, event.fact, { handlerName: event.fact.handlerName }))
      if (matchingEmits.length) {
        edges.push(graphEdge('component-event-handled-by', event.nodeId, handler.nodeId, event.fact, {
          handlerName: event.fact.handlerName,
          eventName: event.fact.eventName,
        }))
      }
    }
  }
  for (const emission of componentEmitEntries) {
    const handler = handlerEntries.find(item => item.fact.file === emission.fact.file && item.fact.name === emission.fact.handlerName)
    if (handler) {
      edges.push(graphEdge('emits-component-event', handler.nodeId, emission.nodeId, emission.fact, {
        eventName: emission.fact.eventName,
        handlerName: emission.fact.handlerName,
      }))
    }
  }
  for (const mutation of context.facts.stateMutations) {
    const handler = handlerEntries.find(item => item.fact.file === mutation.file && item.fact.name === mutation.handlerName)
    const state = stateEntries.find(item => item.fact.file === mutation.file && item.fact.stateName === mutation.stateName)
    if (handler && state) edges.push(graphEdge('mutates-state', handler.nodeId, state.nodeId, mutation, { setterName: mutation.setterName, stateName: mutation.stateName }))
  }
  for (const request of requestEntries) {
    const handler = handlerEntries.find(item => item.fact.file === request.fact.file && item.fact.name === request.fact.handlerName)
    if (handler) edges.push(graphEdge('issues-request', handler.nodeId, request.nodeId, request.fact, { method: request.fact.method }))
    const endpoint = endpointEntries.find(item => item.request.nodeId === request.nodeId)
    if (endpoint) edges.push(graphEdge('targets-endpoint', request.nodeId, endpoint.nodeId, request.fact, { url: request.fact.url || null, dynamic: !request.fact.url }))
    const response = responseEntries.find(item => item.fact.file === request.fact.file && item.fact.requestRef === rangeOffset(request.fact))
    if (endpoint && response) edges.push(graphEdge('receives-response', endpoint.nodeId, response.nodeId, response.fact, { requestNodeId: request.nodeId }))
    if (response) {
      for (const feedback of feedbackEntries.filter(item => candidateDependsOnRequest(item.fact, request.fact, context.facts.stateMutations))) {
        edges.push(graphEdge('produces-feedback-candidate', response.nodeId, feedback.nodeId, feedback.fact, {
          candidateOnly: true,
          deterministicVisibleSignal: true,
        }))
      }
      for (const outcome of outcomeEntries.filter(item => candidateDependsOnRequest(item.fact, request.fact, context.facts.stateMutations))) {
        edges.push(graphEdge('produces-outcome-candidate', response.nodeId, outcome.nodeId, outcome.fact, {
          candidateOnly: true,
          deterministicVisibleSignal: true,
        }))
      }
    }
  }
  for (const outcome of outcomeEntries) {
    const handler = handlerEntries.find(item => item.fact.file === outcome.fact.file && item.fact.name === outcome.fact.handlerName)
    if (handler) {
      edges.push(graphEdge('produces-outcome-candidate', handler.nodeId, outcome.nodeId, outcome.fact, {
        candidateOnly: true,
        deterministicVisibleSignal: true,
        signalKind: outcome.fact.signalKind || null,
      }))
    }
    if (outcome.fact.signalKind !== 'navigation' || !outcome.fact.target) continue
    for (const route of routeEntries.filter(item => item.fact.path === outcome.fact.target)) {
      edges.push(graphEdge('navigates-to-route', outcome.nodeId, route.nodeId, outcome.fact, {
        target: outcome.fact.target,
        deterministicBinding: true,
      }))
    }
  }
  for (const build of buildEntries) {
    edges.push(graphEdge('configures-build', moduleId(build.fact.file), build.nodeId, build.fact, { tool: build.fact.tool }))
    for (const test of testEntries) edges.push(graphEdge('configures-test', build.nodeId, test.nodeId, test.fact, { buildTool: build.fact.tool, testTool: test.fact.tool }))
  }

  const componentFacts = preferredFacts(context.facts.componentRefs, item => `${item.file}:${item.name}:${item.line}`)
  const hasVueRouterEvidence = importFacts.some(fact => externalPackageName(fact.specifier) === 'vue-router')
  for (const fact of componentFacts) {
    const candidates = symbolByName.get(fact.name) || []
    const localTarget = candidates.find(item => item.fact.file === fact.file)
    const importedTarget = localTarget ? null : resolveImportedComponent({
      componentName: fact.name,
      sourcePath: fact.file,
      importFacts,
      resolvedImportTargets,
      symbolByName,
      exportFacts,
    })
    let targetId = localTarget?.nodeId || importedTarget?.nodeId
    const resolved = Boolean(targetId)
    if (!targetId) {
      targetId = componentId(fact)
      if (!nodes.some(node => node.nodeId === targetId)) {
        nodes.push({
          nodeId: targetId,
          kind: 'component-reference',
          label: fact.name,
          language: languageForPath(fact.file),
          frameworks: frameworkValue,
          source: sourceProvenanceForFact(fact),
          evidenceRefs: [`evidence:file:${fact.file}`],
          attributes: { componentName: fact.name, resolved: false },
        })
      }
    }
    edges.push(graphEdge('renders-component', moduleId(fact.file), targetId, fact, {
      componentName: fact.name,
      resolved,
      resolution: localTarget ? 'local-symbol' : importedTarget?.resolution || 'unresolved',
    }))
    if (hasVueRouterEvidence && isVueRouterOutlet(fact.name)) {
      for (const route of routeEntries) {
        edges.push(graphEdge('outlet-renders-route', targetId, route.nodeId, fact, {
          framework: 'vue-router',
          routePath: route.fact.path,
          deterministicWiring: true,
        }))
      }
    }
  }

  const dedupedNodes = dedupeBy(nodes, item => item.nodeId).sort((left, right) => left.nodeId.localeCompare(right.nodeId))
  const dedupedEdges = dedupeBy(edges, item => item.edgeId).sort((left, right) => left.edgeId.localeCompare(right.edgeId))
  const dedupedDiagnostics = dedupeBy(diagnostics, item => item.diagnosticId).sort((left, right) => left.diagnosticId.localeCompare(right.diagnosticId))
  const rawFiles = context.parsedFiles.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
  const structureBySourcePath = new Map()
  for (const item of [...dedupedNodes, ...dedupedEdges]) {
    const sourcePath = item.source?.sourcePath
    const fingerprint = item.source?.structureFingerprint
    if (!sourcePath || !fingerprint) continue
    const values = structureBySourcePath.get(sourcePath) || []
    values.push(fingerprint)
    structureBySourcePath.set(sourcePath, values)
  }
  const files = rawFiles.map(file => {
    const factFingerprints = [...new Set(structureBySourcePath.get(file.sourcePath) || [])].sort()
    return {
      ...file,
      structureFingerprint: structureFingerprint(JSON.stringify(
        factFingerprints.length
          ? factFingerprints
          : [file.sourcePath, file.parser, file.parseStatus, file.sourceKind],
      )),
    }
  })
  const languages = languageSummary(context.fileSet)
  const providerRecords = PROVIDER_PRIORITY.map(name => {
    const provider = name === 'typescript'
      ? context.providers.typescript
      : name === '@babel/parser'
        ? context.providers.babel
        : name === '@vue/compiler-sfc'
          ? context.providers.vue
          : context.providers.svelte
    return { name, available: provider.available, version: provider.version }
  })
  const hasCompilerFiles = files.some(item => /compiler-ast|parser-ast|hybrid/.test(item.sourceKind))
  const hasFallbackFiles = files.some(item => /fallback-lexer/.test(item.sourceKind))
  const mode = hasCompilerFiles && hasFallbackFiles ? 'hybrid' : hasCompilerFiles ? 'compiler' : 'fallback'
  const graphSignature = JSON.stringify({
    snapshotId: context.snapshotId,
    roots: context.roots,
    providers: providerRecords,
    files: files.map(item => [item.sourcePath, item.structureFingerprint]),
    nodes: dedupedNodes.map(item => item.nodeId),
    edges: dedupedEdges.map(item => [item.type, item.from, item.to]),
    diagnostics: dedupedDiagnostics.map(item => item.diagnosticId),
  })
  return {
    schemaVersion: REPO_STATIC_PROGRAM_GRAPH_SCHEMA,
    graphId: `static-program-graph:${stableToken(graphSignature)}`,
    structureFingerprint: structureFingerprint(graphSignature),
    snapshotId: context.snapshotId,
    supportDecisionRef: `support-decision:${context.snapshotId}`,
    supportLevel: context.supportDecision.supportLevel,
    roots: context.roots,
    frameworks: frameworkValue,
    languages,
    parser: {
      mode,
      providers: providerRecords,
      toolchainFingerprint: `parser-toolchain:${stableToken(JSON.stringify(providerRecords))}`,
    },
    files,
    nodes: dedupedNodes,
    edges: dedupedEdges,
    diagnostics: dedupedDiagnostics,
    metrics: {
      sourceFiles: context.fileSet.size,
      parsedFiles: files.filter(item => item.parseStatus !== 'unreadable').length,
      compilerParsedFiles: files.filter(item => /compiler-ast|parser-ast|hybrid/.test(item.sourceKind)).length,
      fallbackParsedFiles: files.filter(item => /fallback-lexer/.test(item.sourceKind)).length,
      nodeCount: dedupedNodes.length,
      edgeCount: dedupedEdges.length,
      diagnosticCount: dedupedDiagnostics.length,
      parseFailureCount: dedupedDiagnostics.filter(item => item.kind === 'parse-failure').length,
      importResolutionFailureCount: dedupedDiagnostics.filter(item => item.kind === 'import-resolution-failure').length,
    },
    generatedAt: context.generatedAt,
  }
}

function resolveImportedComponent({ componentName, sourcePath, importFacts, resolvedImportTargets, symbolByName, exportFacts }) {
  const imports = importFacts.filter(item => item.file === sourcePath)
  for (const imported of imports) {
    const binding = (imported.bindingMap || []).find(item => item.localName === componentName)
    if (!binding) continue
    const resolution = resolvedImportTargets.get(`${imported.file}:${imported.specifier}`)
    if (!resolution || resolution.kind === 'unresolved' || resolution.kind === 'resource') continue
    if (resolution.kind === 'external') return { nodeId: resolution.nodeId, resolution: 'imported-external', sourcePath: null }
    const modulePath = resolution.path
    if (binding.kind === 'named') {
      const symbol = (symbolByName.get(binding.importedName) || []).find(item => item.fact.file === modulePath)
      if (symbol) return { nodeId: symbol.nodeId, resolution: 'imported-symbol', sourcePath: modulePath }
    } else if (binding.kind === 'default') {
      const explicitDefault = exportFacts.find(item => item.file === modulePath && item.exportedName === 'default')
      const explicitSymbol = explicitDefault
        ? (symbolByName.get(explicitDefault.localName) || []).find(item => item.fact.file === modulePath)
        : null
      if (explicitSymbol) return { nodeId: explicitSymbol.nodeId, resolution: 'imported-default-symbol', sourcePath: modulePath }
      const componentSymbol = (symbolByName.get(componentName) || []).find(item => item.fact.file === modulePath)
      if (componentSymbol) return { nodeId: componentSymbol.nodeId, resolution: 'imported-default-symbol', sourcePath: modulePath }
      const stemSymbol = (symbolByName.get(moduleStem(modulePath)) || []).find(item => item.fact.file === modulePath)
      if (stemSymbol) return { nodeId: stemSymbol.nodeId, resolution: 'imported-default-symbol', sourcePath: modulePath }
      const exportedSymbols = [...symbolByName.values()].flat().filter(item => item.fact.file === modulePath && item.fact.exported)
      if (exportedSymbols.length === 1) return { nodeId: exportedSymbols[0].nodeId, resolution: 'imported-default-symbol', sourcePath: modulePath }
    }
    return { nodeId: resolution.nodeId, resolution: 'imported-module', sourcePath: modulePath }
  }
  return null
}

function resolveSemanticRoleTarget({ componentName, role, sourcePath, roleEntries, importFacts, resolvedImportTargets }) {
  const local = roleEntries.find(item => item.kind === role && item.fact.file === sourcePath && item.fact.name === componentName)
  if (local) return local
  for (const imported of importFacts.filter(item => item.file === sourcePath)) {
    const binding = (imported.bindingMap || []).find(item => item.localName === componentName)
    if (!binding) continue
    const resolution = resolvedImportTargets.get(`${imported.file}:${imported.specifier}`)
    if (resolution?.kind !== 'module') continue
    const importedName = binding.kind === 'default' ? componentName : binding.importedName
    const exact = roleEntries.find(item => item.kind === role && item.fact.file === resolution.path && item.fact.name === importedName)
    if (exact) return exact
    const onlyRole = roleEntries.filter(item => item.kind === role && item.fact.file === resolution.path)
    if (onlyRole.length === 1) return onlyRole[0]
  }
  const candidates = roleEntries.filter(item => item.kind === role && item.fact.name === componentName)
  return candidates.length === 1 ? candidates[0] : null
}

function candidateDependsOnRequest(candidate, request, stateMutations) {
  if (candidate.file !== request.file) return false
  if (candidate.handlerName && candidate.handlerName === request.handlerName) return true
  const dependencies = new Set(candidate.dependsOnStates || [])
  if (!dependencies.size) return false
  return stateMutations.some(mutation => (
    mutation.file === request.file
    && mutation.handlerName === request.handlerName
    && dependencies.has(mutation.stateName)
  ))
}

function moduleStem(sourcePath) {
  const withoutExtension = path.posix.basename(sourcePath).replace(/\.(?:[cm]?[jt]sx?|vue|svelte)$/i, '')
  return withoutExtension === 'index' ? path.posix.basename(path.posix.dirname(sourcePath)) : withoutExtension
}

function collectSourceRecords(input, signals) {
  const records = new Map()
  const add = item => {
    const sourcePath = normalizeRepoPath(typeof item === 'string' ? item : item?.path || item?.file || item?.sourcePath)
    if (!sourcePath || generatedPath(sourcePath) || item?.generated === true || item?.category === 'generated' || !SOURCE_EXTENSION_PATTERN.test(sourcePath)) return
    const previous = records.get(sourcePath) || {}
    records.set(sourcePath, {
      ...previous,
      ...(typeof item === 'object' && item ? item : {}),
      path: sourcePath,
      language: item?.language || previous.language || languageForPath(sourcePath),
      contentHash: item?.contentHash || previous.contentHash || null,
      hash: item?.hash || previous.hash || null,
    })
  }
  for (const collection of [input.files, signals.inventory?.files, signals.snapshot?.files, signals.codeMap?.keyFiles, signals.codeMap?.entrypoints]) {
    for (const item of array(collection)) add(item)
  }
  for (const collection of [signals.codeMap?.imports, signals.codeMap?.symbols, signals.codeMap?.routes, signals.codeMap?.componentRefs]) {
    for (const item of array(collection)) add({ path: item?.file || item?.sourcePath })
  }
  return [...records.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function collectScopedPaths(input, signals, roots) {
  const paths = []
  for (const collection of [input.files, signals.inventory?.files, signals.snapshot?.files]) {
    for (const item of array(collection)) {
      const sourcePath = normalizeRepoPath(typeof item === 'string' ? item : item?.path || item?.file || item?.sourcePath)
      if (sourcePath && !generatedPath(sourcePath) && item?.generated !== true && item?.category !== 'generated' && roots.some(root => pathWithinRoot(sourcePath, root))) paths.push(sourcePath)
    }
  }
  return new Set(uniqueSorted(paths))
}

function collectContentOverrides(input) {
  const result = new Map()
  for (const item of array(input.files)) {
    if (!item || typeof item !== 'object') continue
    const sourcePath = normalizeRepoPath(item.path || item.file || item.sourcePath)
    const content = typeof item.content === 'string' ? item.content : typeof item.text === 'string' ? item.text : null
    if (sourcePath && content !== null) result.set(sourcePath, content)
  }
  for (const [sourcePath, content] of Object.entries(input.sourceFiles || {})) {
    const normalized = normalizeRepoPath(sourcePath)
    if (normalized && typeof content === 'string') result.set(normalized, content)
  }
  return result
}

function collectConfigRecords(input, signals) {
  const records = new Map()
  for (const collection of [input.files, signals.inventory?.files, signals.snapshot?.files]) {
    for (const item of array(collection)) {
      const sourcePath = normalizeRepoPath(typeof item === 'string' ? item : item?.path || item?.file || item?.sourcePath)
      if (generatedPath(sourcePath) || item?.generated === true || item?.category === 'generated' || !/(^|\/)(?:tsconfig|jsconfig)\.json$/i.test(sourcePath)) continue
      const previous = records.get(sourcePath) || {}
      records.set(sourcePath, {
        ...previous,
        ...(typeof item === 'object' && item ? item : {}),
        path: sourcePath,
        contentHash: item?.contentHash || previous.contentHash || null,
        hash: item?.hash || previous.hash || null,
      })
    }
  }
  return records
}

function readSource({ repoRoot, record, contentOverrides, diagnostics }) {
  if (record.protected || record.contentAnalyzable === false || record.binary) {
    diagnostics.push(makeDiagnostic({
      kind: 'source-unavailable',
      severity: 'info',
      message: `Source content is unavailable for deterministic parsing: ${record.path}.`,
      sourcePath: record.path,
      details: { protected: Boolean(record.protected), contentAnalyzable: record.contentAnalyzable !== false },
      evidenceRefs: [`evidence:file:${record.path}`],
    }))
    return null
  }
  const override = contentOverrides.has(record.path)
  if (!override && !record.contentHash && !record.hash) {
    diagnostics.push(makeDiagnostic({
      kind: 'source-content-unbound',
      severity: 'error',
      message: `Refused to parse live source without a census content hash: ${record.path}.`,
      sourcePath: record.path,
      evidenceRefs: [`evidence:file:${record.path}`],
    }))
    return null
  }
  if (override) return verifySourceBinding(record, contentOverrides.get(record.path), diagnostics)
  const absolutePath = path.resolve(repoRoot, record.path)
  const relative = path.relative(repoRoot, absolutePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    diagnostics.push(makeDiagnostic({
      kind: 'source-path-outside-root',
      severity: 'error',
      message: `Refused to read source outside repository root: ${record.path}.`,
      sourcePath: record.path,
      evidenceRefs: [`evidence:file:${record.path}`],
    }))
    return null
  }
  try {
    return verifySourceBinding(record, fs.readFileSync(absolutePath, 'utf8'), diagnostics)
  } catch (error) {
    diagnostics.push(makeDiagnostic({
      kind: 'source-read-failure',
      severity: 'warning',
      message: `Could not read ${record.path}: ${error.code || 'read failure'}.`,
      sourcePath: record.path,
      details: { code: error.code || null },
      evidenceRefs: [`evidence:file:${record.path}`],
    }))
    return null
  }
}

function verifySourceBinding(record, source, diagnostics) {
  const expected = String(record.contentHash || record.hash || '')
  if (!expected) return source
  const normalized = expected.replace(/^sha(?:1|256):/i, '')
  const algorithm = /^[a-f0-9]{40}$/i.test(normalized) ? 'sha1' : /^[a-f0-9]{64}$/i.test(normalized) ? 'sha256' : null
  if (!algorithm) {
    diagnostics.push(makeDiagnostic({
      kind: 'source-hash-unsupported',
      severity: 'error',
      message: `Refused to parse source with an unsupported census content hash: ${record.path}.`,
      sourcePath: record.path,
      details: { hashLength: normalized.length },
      evidenceRefs: [`evidence:file:${record.path}`],
    }))
    return null
  }
  const actual = createHash(algorithm).update(source).digest('hex')
  if (actual !== normalized.toLowerCase()) {
    diagnostics.push(makeDiagnostic({
      kind: 'snapshot-content-mismatch',
      severity: 'error',
      message: `Refused to parse source whose content no longer matches the census snapshot: ${record.path}.`,
      sourcePath: record.path,
      details: { algorithm, expectedHash: normalized.toLowerCase() },
      evidenceRefs: [`evidence:file:${record.path}`],
    }))
    return null
  }
  return source
}

function collectAliases({ repoRoot, roots, fileSet, diagnostics, configRecords, contentOverrides }) {
  const rules = []
  const baseUrls = []
  let order = 0
  const addRule = (key, target, priority) => rules.push({ key, target, priority, order: order++ })
  for (const root of roots) {
    const sourceRoot = root === '.' ? 'src' : `${root}/src`
    if ([...fileSet].some(file => pathWithinRoot(file, sourceRoot))) {
      addRule('@/*', `${sourceRoot}/*`, 10)
      addRule('~/*', `${sourceRoot}/*`, 10)
    }
  }
  for (const root of uniqueSorted(roots)) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const sourcePath = root === '.' ? name : `${root}/${name}`
      const record = configRecords.get(sourcePath)
      if (!record) continue
      try {
        const source = readSource({ repoRoot, record, contentOverrides, diagnostics })
        if (source === null) continue
        const config = parseJsonWithComments(source)
        const baseUrl = normalizeRepoPath(path.posix.join(root === '.' ? '' : root, config.compilerOptions?.baseUrl || '.')) || '.'
        if (typeof config.compilerOptions?.baseUrl === 'string') baseUrls.push({ path: baseUrl, order: order++ })
        for (const [key, targets] of Object.entries(config.compilerOptions?.paths || {})) {
          for (const target of array(targets)) {
            const normalizedTarget = normalizeRepoPath(path.posix.join(baseUrl, String(target)))
            if (key && normalizedTarget) addRule(key, normalizedTarget, 100)
          }
        }
      } catch (error) {
        diagnostics.push(makeDiagnostic({
          kind: 'config-parse-failure',
          severity: 'warning',
          message: `Could not parse alias configuration ${sourcePath}: ${error.message}`,
          sourcePath,
          evidenceRefs: [`evidence:file:${sourcePath}`],
        }))
      }
    }
  }
  return {
    rules: dedupeBy(rules.filter(item => item.key && item.target), item => `${item.key}:${item.target}`)
      .sort((left, right) => aliasStaticPrefix(right.key).length - aliasStaticPrefix(left.key).length || left.key.localeCompare(right.key) || right.priority - left.priority || left.order - right.order),
    baseUrls: dedupeBy(baseUrls, item => item.path),
  }
}

function resolveImport(sourcePath, specifier, fileSet, allPathSet, aliases) {
  const resolvableSpecifier = specifier.replace(/[?#].*$/, '')
  if (resolvableSpecifier.startsWith('.')) {
    const base = normalizeRepoPath(path.posix.join(path.posix.dirname(sourcePath), resolvableSpecifier))
    return resolvePathCandidates([base], fileSet, allPathSet) || { kind: 'unresolved' }
  }
  if (resolvableSpecifier.startsWith('/')) {
    return resolvePathCandidates([normalizeRepoPath(resolvableSpecifier.slice(1))], fileSet, allPathSet) || { kind: 'unresolved' }
  }
  const matchingRules = (aliases.rules || [])
    .filter(rule => aliasCapturedValue(rule.key, resolvableSpecifier) !== null)
    .sort((left, right) => aliasAffinity(right.target, sourcePath) - aliasAffinity(left.target, sourcePath) || right.priority - left.priority || left.order - right.order)
  if (matchingRules.length) {
    const targets = matchingRules.map(rule => applyAliasRule(rule, resolvableSpecifier)).filter(Boolean)
    return resolvePathCandidates(targets, fileSet, allPathSet) || { kind: 'unresolved' }
  }
  const baseUrlResolution = resolvePathCandidates((aliases.baseUrls || [])
    .sort((left, right) => rootAffinity(right.path, sourcePath) - rootAffinity(left.path, sourcePath) || left.order - right.order)
    .map(baseUrl => normalizeRepoPath(path.posix.join(baseUrl.path, resolvableSpecifier))), fileSet, allPathSet)
  if (baseUrlResolution) return baseUrlResolution
  return { kind: 'external', packageName: externalPackageName(specifier) }
}

function resolvePathCandidates(basePaths, fileSet, allPathSet) {
  for (const base of dedupeBy(basePaths.map(normalizeRepoPath).filter(Boolean), value => value)) {
    if (allPathSet.has(base) && !fileSet.has(base)) return { kind: 'resource', path: base }
  }
  const moduleResolution = resolveModuleCandidates(basePaths, fileSet)
  if (moduleResolution) return moduleResolution
  for (const base of dedupeBy(basePaths.map(normalizeRepoPath).filter(Boolean), value => value)) {
    for (const extension of RESOURCE_RESOLUTION_EXTENSIONS) {
      for (const candidate of [base + extension, `${base}/index${extension}`]) {
        const normalized = normalizeRepoPath(candidate)
        if (allPathSet.has(normalized)) return { kind: 'resource', path: normalized }
      }
    }
  }
  return null
}

function resolveModuleCandidates(basePaths, fileSet) {
  for (const base of dedupeBy(basePaths.map(normalizeRepoPath).filter(Boolean), value => value)) {
    if (!base) continue
    for (const extension of RESOLUTION_EXTENSIONS) {
      for (const candidate of [base + extension, `${base}/index${extension}`]) {
        const normalized = normalizeRepoPath(candidate)
        if (fileSet.has(normalized)) return { kind: 'module', path: normalized }
      }
    }
  }
  return null
}

function aliasStaticPrefix(key) {
  return String(key).split('*')[0]
}

function aliasCapturedValue(key, specifier) {
  const star = key.indexOf('*')
  if (star === -1) return key === specifier ? '' : null
  const prefix = key.slice(0, star)
  const suffix = key.slice(star + 1)
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) return null
  return specifier.slice(prefix.length, specifier.length - suffix.length)
}

function applyAliasRule(rule, specifier) {
  const captured = aliasCapturedValue(rule.key, specifier)
  if (captured === null) return null
  return normalizeRepoPath(rule.target.includes('*') ? rule.target.replace('*', captured) : rule.target)
}

function aliasAffinity(target, sourcePath) {
  const normalized = normalizeRepoPath(target.replace('*', ''))
  const sourceRoot = normalized.includes('/src/') ? normalized.slice(0, normalized.indexOf('/src/')) : normalized.endsWith('/src') ? normalized.slice(0, -4) || '.' : path.posix.dirname(normalized)
  return pathWithinRoot(sourcePath, sourceRoot || '.') ? sourceRoot === '.' ? 1 : sourceRoot.length + 1 : 0
}

function rootAffinity(root, sourcePath) {
  const normalized = normalizeRepoPath(root) || '.'
  return pathWithinRoot(sourcePath, normalized) ? normalized === '.' ? 1 : normalized.length + 1 : 0
}

function addCodeMapFacts(facts, codeMap, fileSet, protectedPaths) {
  for (const item of codeMap?.imports || []) {
    const file = normalizeRepoPath(item.file || item.sourcePath)
    if (!fileSet.has(file) || protectedPaths.has(file) || !item.target) continue
    facts.imports.push({
      file,
      specifier: String(item.target),
      kind: /dynamic/i.test(item.kind || item.type || '') ? 'dynamic' : 'static',
      line: integer(item.line, 1),
      bindings: [],
      bindingMap: [],
      provider: 'code-map',
      sourceKind: 'code-map',
      confidence: 0.65,
    })
  }
  for (const item of codeMap?.symbols || []) {
    const file = normalizeRepoPath(item.file || item.sourcePath)
    if (!fileSet.has(file) || protectedPaths.has(file) || !item.name) continue
    facts.symbols.push({
      file,
      name: String(item.name),
      kind: String(item.kind || 'symbol'),
      line: integer(item.line, 1),
      exported: false,
      provider: 'code-map',
      sourceKind: 'code-map',
      confidence: 0.65,
    })
  }
  for (const item of codeMap?.routes || []) {
    const file = normalizeRepoPath(item.file || item.sourcePath)
    if (!fileSet.has(file) || protectedPaths.has(file) || typeof item.path !== 'string') continue
    facts.routes.push({ file, path: item.path, line: integer(item.line, 1), provider: 'code-map', sourceKind: 'code-map', confidence: 0.65 })
  }
  for (const item of codeMap?.componentRefs || []) {
    const file = normalizeRepoPath(item.file || item.sourcePath)
    if (!fileSet.has(file) || protectedPaths.has(file) || !item.name) continue
    facts.componentRefs.push({ file, name: String(item.name), line: integer(item.line, 1), provider: 'code-map', sourceKind: 'code-map', confidence: 0.65 })
  }
}

function createFactAccumulator() {
  return {
    imports: [],
    symbols: [],
    exports: [],
    routes: [],
    componentRefs: [],
    bootstraps: [],
    componentRoles: [],
    uiElements: [],
    uiEvents: [],
    componentEmits: [],
    handlers: [],
    states: [],
    stateMutations: [],
    requests: [],
    responses: [],
    feedbackCandidates: [],
    outcomeCandidates: [],
    buildWirings: [],
    testWirings: [],
  }
}

function addFileFacts(facts, file, result) {
  for (const kind of Object.keys(facts)) {
    for (const item of result[kind] || []) facts[kind].push({ file, ...item })
  }
}

function emptyParseResult(provider, sourceKind, status) {
  return {
    provider,
    sourceKind,
    status,
    imports: [],
    symbols: [],
    exports: [],
    routes: [],
    componentRefs: [],
    bootstraps: [],
    componentRoles: [],
    uiElements: [],
    uiEvents: [],
    componentEmits: [],
    handlers: [],
    states: [],
    stateMutations: [],
    requests: [],
    responses: [],
    feedbackCandidates: [],
    outcomeCandidates: [],
    buildWirings: [],
    testWirings: [],
    diagnostics: [],
    fileRange: null,
    structureFingerprint: null,
  }
}

function mergeParseResult(target, child, lineOffset) {
  for (const kind of parseFactCollections()) {
    for (const item of child[kind] || []) {
      target[kind].push({
        ...item,
        line: integer(item.line, 1) + lineOffset,
        range: offsetRangeLines(item.range, lineOffset),
      })
    }
  }
  for (const diagnostic of child.diagnostics || []) target.diagnostics.push({
    ...diagnostic,
    line: diagnostic.line === null || diagnostic.line === undefined ? null : integer(diagnostic.line, 1) + lineOffset,
  })
  if (target.sourceKind !== child.sourceKind) {
    target.sourceKind = uniqueSorted(`${target.sourceKind}+${child.sourceKind}`.split('+')).join('+')
  }
  if (child.status !== 'parsed') target.status = child.status
  target.fileRange ||= child.fileRange
  target.structureFingerprint ||= child.structureFingerprint
}

function mergeSemanticParseResult(target, semantic) {
  for (const kind of parseFactCollections()) {
    if (kind === 'imports' || kind === 'symbols' || kind === 'exports' || kind === 'componentRefs') continue
    target[kind].push(...(semantic[kind] || []))
  }
  target.fileRange = semantic.fileRange || target.fileRange
  target.structureFingerprint = semantic.structureFingerprint || target.structureFingerprint
}

function dedupeParseResult(result) {
  result.imports = preferredFacts(result.imports, item => `${item.kind}:${item.specifier}:${item.line}`)
  result.symbols = preferredFacts(result.symbols, item => `${item.kind}:${item.name}:${item.line}`)
  result.exports = preferredFacts(result.exports, item => `${item.localName}:${item.exportedName}:${item.line}`)
  const semanticRoutes = result.routes.filter(item => (item.semanticRank || 0) > 0)
  const unmatchedGenericRoutes = result.routes.filter(item => (item.semanticRank || 0) === 0
    && !semanticRoutes.some(semantic => semantic.path === item.path && rangeContains(semantic.range, item.range)))
  result.routes = preferredFacts([...semanticRoutes, ...unmatchedGenericRoutes], item => `${item.path}:${item.line}`)
  result.componentRefs = preferredFacts(result.componentRefs, item => `${item.name}:${item.line}`)
  result.bootstraps = preferredFacts(result.bootstraps, item => `${item.rootComponentName}:${rangeOffset(item)}`)
  result.componentRoles = preferredFacts(result.componentRoles, item => `${item.role}:${item.name}:${rangeOffset(item)}`)
  result.uiElements = preferredFacts(result.uiElements, item => `${item.ownerName}:${item.elementName}:${rangeOffset(item)}`)
  result.uiEvents = preferredFacts(result.uiEvents, item => `${item.eventName}:${item.handlerName}:${item.elementRef}:${rangeOffset(item)}`)
  result.componentEmits = preferredFacts(result.componentEmits, item => `${item.eventName}:${item.handlerName}:${rangeOffset(item)}`)
  result.handlers = preferredFacts(result.handlers, item => `${item.name}:${rangeOffset(item)}`)
  result.states = preferredFacts(result.states, item => `${item.ownerName}:${item.stateName}:${rangeOffset(item)}`)
  result.stateMutations = preferredFacts(result.stateMutations, item => `${item.handlerName}:${item.stateName}:${rangeOffset(item)}`)
  result.requests = preferredFacts(result.requests, item => `${item.handlerName}:${item.method}:${item.url}:${rangeOffset(item)}`)
  result.responses = preferredFacts(result.responses, item => `${item.requestRef}:${item.responseName || ''}:${rangeOffset(item)}`)
  result.feedbackCandidates = preferredFacts(result.feedbackCandidates, item => `${item.ownerName}:${item.feedbackKind}:${rangeOffset(item)}`)
  result.outcomeCandidates = preferredFacts(result.outcomeCandidates, item => `${item.handlerName}:${item.signalKind}:${item.target || ''}:${rangeOffset(item)}`)
  result.buildWirings = preferredFacts(result.buildWirings, item => `${item.tool}:${rangeOffset(item)}`)
  result.testWirings = preferredFacts(result.testWirings, item => `${item.tool}:${rangeOffset(item)}`)
  return result
}

function rangeContains(container, candidate) {
  if (!Number.isInteger(container?.start?.offset) || !Number.isInteger(container?.end?.offset)
    || !Number.isInteger(candidate?.start?.offset) || !Number.isInteger(candidate?.end?.offset)) return false
  return container.start.offset <= candidate.start.offset && container.end.offset >= candidate.end.offset
}

function preferredFacts(items, keyFor) {
  const ordered = [...items].sort((left, right) => (right.semanticRank || 0) - (left.semanticRank || 0) || (right.confidence || 0) - (left.confidence || 0) || keyFor(left).localeCompare(keyFor(right)))
  return dedupeBy(ordered, keyFor).sort((left, right) => keyFor(left).localeCompare(keyFor(right)))
}

function parseFactCollections() {
  return [
    'imports', 'symbols', 'exports', 'routes', 'componentRefs', 'bootstraps', 'componentRoles',
    'uiElements', 'uiEvents', 'componentEmits', 'handlers', 'states', 'stateMutations', 'requests', 'responses',
    'feedbackCandidates', 'outcomeCandidates', 'buildWirings', 'testWirings',
  ]
}

function importFact(specifier, kind, line, bindings, provider, sourceKind, provenance = {}) {
  const bindingMap = dedupeBy((bindings || []).map(normalizeImportBinding).filter(Boolean), item => `${item.localName}:${item.importedName}:${item.kind}`)
  return {
    specifier: String(specifier),
    kind,
    line,
    bindings: uniqueSorted(bindingMap.map(item => item.localName)),
    bindingMap,
    provider,
    sourceKind,
    confidence: confidenceFor(sourceKind),
    ...provenance,
  }
}

function normalizeImportBinding(value) {
  if (typeof value === 'string') return { localName: value, importedName: value, kind: 'named' }
  if (!value || typeof value !== 'object' || !value.localName) return null
  return {
    localName: String(value.localName),
    importedName: String(value.importedName || value.localName),
    kind: ['default', 'named', 'namespace'].includes(value.kind) ? value.kind : 'named',
  }
}

function symbolFact(name, kind, line, exported, provider, sourceKind, provenance = {}) {
  return { name: String(name), kind, line, exported: Boolean(exported), provider, sourceKind, confidence: confidenceFor(sourceKind), ...provenance }
}

function exportFact(localName, exportedName, line, provider, sourceKind, provenance = {}) {
  return { localName: String(localName), exportedName: String(exportedName || localName), line, provider, sourceKind, confidence: confidenceFor(sourceKind), ...provenance }
}

function routeFact(routePath, line, provider, sourceKind, provenance = {}) {
  return { path: String(routePath), line, provider, sourceKind, confidence: confidenceFor(sourceKind), ...provenance }
}

function componentFact(name, line, provider, sourceKind, provenance = {}) {
  return { name: String(name), line, provider, sourceKind, confidence: confidenceFor(sourceKind), ...provenance }
}

function confidenceFor(sourceKind) {
  if (sourceKind === 'compiler-ast') return 1
  if (sourceKind === 'parser-ast') return 0.98
  if (sourceKind === 'fallback-lexer') return 0.7
  return 0.65
}

function graphEdge(type, from, to, fact, attributes = {}) {
  const signature = `${type}:${from}:${to}:${fact.file || ''}:${fact.line || 0}:${JSON.stringify(attributes)}`
  return {
    edgeId: `edge:${stableToken(signature)}`,
    type,
    from,
    to,
    source: sourceProvenanceForFact(fact),
    evidenceRefs: fact.file ? [`evidence:file:${fact.file}`] : [],
    confidence: fact.confidence || confidenceFor(fact.sourceKind),
    attributes,
  }
}

function sourceProvenanceForFact(fact) {
  return sourceProvenance(
    fact.file || null,
    fact.line || fact.range?.start?.line || null,
    fact.provider,
    fact.sourceKind,
    fact.range || null,
    fact.structureFingerprint || structureFingerprint(`${fact.provider || 'unknown'}:${fact.file || ''}:${fact.line || 0}`),
  )
}

function sourceProvenance(sourcePath, line, provider, sourceKind, range = null, fingerprint = null) {
  return {
    sourcePath: sourcePath || null,
    line: Number.isInteger(line) && line > 0 ? line : null,
    range: normalizeSourceRange(range),
    provider: String(provider || 'unknown'),
    sourceKind: String(sourceKind || 'unknown'),
    structureFingerprint: String(fingerprint || structureFingerprint(`${provider || 'unknown'}:${sourcePath || ''}:${line || 0}`)),
  }
}

function fileProvenance(record, parseStatus, parser, sourceKind) {
  return {
    sourcePath: record.path,
    language: record.language || languageForPath(record.path),
    contentHash: typeof (record.contentHash || record.hash) === 'string' ? (record.contentHash || record.hash) : null,
    parser,
    parseStatus,
    sourceKind,
    evidenceRefs: [`evidence:file:${record.path}`],
  }
}

function languageSummary(fileSet) {
  const counts = new Map()
  for (const sourcePath of fileSet) counts.set(languageForPath(sourcePath), (counts.get(languageForPath(sourcePath)) || 0) + 1)
  return [...counts.entries()].map(([name, fileCount]) => ({ name, fileCount })).sort((left, right) => left.name.localeCompare(right.name))
}

function makeDiagnostic(input) {
  const sourcePath = normalizeRepoPath(input.sourcePath) || null
  const line = Number.isInteger(input.line) && input.line > 0 ? input.line : null
  const kind = String(input.kind || 'unknown-diagnostic')
  const message = String(input.message || kind)
  const signature = `${kind}:${sourcePath || ''}:${line || 0}:${message}`
  return {
    diagnosticId: `diagnostic:${stableToken(signature)}`,
    kind,
    severity: ['info', 'warning', 'error'].includes(input.severity) ? input.severity : 'warning',
    message,
    sourcePath,
    line,
    details: input.details && typeof input.details === 'object' ? input.details : {},
    evidenceRefs: uniqueSorted(input.evidenceRefs || (sourcePath ? [`evidence:file:${sourcePath}`] : [])),
  }
}

function parseFailureDiagnostic(sourcePath, provider, error) {
  return {
    kind: 'parse-failure',
    severity: 'warning',
    message: `${provider} failed to parse ${sourcePath}: ${error.message}`,
    sourcePath,
    line: error.loc?.line || null,
    details: { provider },
    evidenceRefs: [`evidence:file:${sourcePath}`],
  }
}

function resolveRepoRoot(input, signals) {
  return path.resolve(
    input.repoRoot
      || input.repoPath
      || signals.inventory?.repo?.path
      || signals.snapshot?.repo?.path
      || signals.profile?.repo?.path
      || '.',
  )
}

function moduleId(sourcePath) { return `module:${sourcePath}` }
function resourceId(sourcePath) { return `resource:${sourcePath}` }
function externalId(packageName) { return `external-package:${packageName}` }
function unresolvedId(sourcePath, specifier) { return `unresolved-module:${stableToken(`${sourcePath}:${specifier}`)}` }
function symbolId(fact) { return `symbol:${fact.file}:${fact.kind}:${fact.name}:${fact.line}` }
function routeId(fact) { return `route:${fact.file}:${stableToken(`${fact.path}:${fact.line}`)}` }
function componentId(fact) { return `component-reference:${fact.file}:${fact.name}:${fact.line}` }
function semanticId(kind, fact) {
  const label = fact.name || fact.label || fact.stateName || fact.eventName || fact.elementName || kind
  return `${kind}:${fact.file || 'unknown'}:${stableToken(`${label}:${rangeOffset(fact)}`)}`
}

function languageForPath(sourcePath) {
  if (/\.tsx$/i.test(sourcePath)) return 'TypeScript TSX'
  if (/\.(?:mts|cts|ts)$/i.test(sourcePath)) return 'TypeScript'
  if (/\.jsx$/i.test(sourcePath)) return 'JavaScript JSX'
  if (/\.(?:mjs|cjs|js)$/i.test(sourcePath)) return 'JavaScript'
  if (/\.vue$/i.test(sourcePath)) return 'Vue SFC'
  if (/\.svelte$/i.test(sourcePath)) return 'Svelte Component'
  return 'unknown'
}

function resourceLanguageForPath(sourcePath) {
  const extension = path.posix.extname(sourcePath).slice(1).toLowerCase()
  return extension ? `resource/${extension}` : 'resource'
}

function externalPackageName(specifier) {
  const parts = String(specifier).split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function routeContextFor(sourcePath, source) {
  return /(^|\/)(?:router|routes?)(?:\/|\.|$)/i.test(sourcePath)
    || /\b(?:createBrowserRouter|createHashRouter|createRouter|useRoutes|RouterProvider|RouteObject)\b/.test(source)
}

function fallbackComponentRefs(source, sourcePath, vue) {
  const result = []
  const pattern = vue ? /<([A-Z][A-Za-z0-9.$]*|[a-z][a-z0-9]*-[a-z0-9-]+)\b/g : /<([A-Z][A-Za-z0-9.$]*)\b/g
  for (const match of source.matchAll(pattern)) {
    result.push(componentFact(
      match[1],
      lineFromOffset(source, match.index),
      'fallback-lexer',
      'fallback-lexer',
      textFactProvenance(source, match.index, match[0].length, 'jsx:component-reference'),
    ))
  }
  return result
}

function componentName(name) {
  return /^[A-Z][A-Za-z0-9.$]*$/.test(name) || /^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(name)
}

function isVueRouterOutlet(name) {
  return String(name || '').replace(/-/g, '').toLowerCase() === 'routerview'
}

function typescriptScriptKind(ts, sourcePath) {
  if (/\.tsx$/i.test(sourcePath)) return ts.ScriptKind.TSX
  if (/\.jsx$/i.test(sourcePath)) return ts.ScriptKind.JSX
  if (/\.(?:js|mjs|cjs)$/i.test(sourcePath)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function variableKindTs(ts, declaration) {
  if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return 'function'
  return 'variable'
}

function propertyNameTs(node) {
  if (!node) return ''
  return node.text || node.escapedText || ''
}

function typescriptRouteComponentSpecifiers(ts, node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return []
  const component = node.properties.find(item => ts.isPropertyAssignment(item) && propertyNameTs(item.name) === 'component')
  return typescriptDynamicImportSpecifiers(ts, component?.initializer)
}

function typescriptDynamicImportSpecifiers(ts, node) {
  const values = []
  const visit = current => {
    if (ts.isCallExpression(current)
      && current.expression?.kind === ts.SyntaxKind.ImportKeyword
      && current.arguments?.[0]
      && ts.isStringLiteralLike(current.arguments[0])) {
      values.push(current.arguments[0].text)
    }
    ts.forEachChild(current, visit)
  }
  if (node) visit(node)
  return uniqueSorted(values)
}

function importBindingsFromTs(ts, clause) {
  if (!clause) return []
  const values = []
  if (clause.name) values.push({ localName: clause.name.text, importedName: 'default', kind: 'default' })
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      values.push({ localName: clause.namedBindings.name.text, importedName: '*', kind: 'namespace' })
    } else {
      for (const item of clause.namedBindings.elements || []) {
        values.push({ localName: item.name.text, importedName: item.propertyName?.text || item.name.text, kind: 'named' })
      }
    }
  }
  return values
}

function flattenTsMessage(value) {
  if (typeof value === 'string') return value
  const result = []
  let current = value
  while (current) {
    if (current.messageText) result.push(current.messageText)
    current = current.next?.[0]
  }
  return result.join(' ') || 'unknown parse error'
}

function babelPluginsFor(sourcePath) {
  const plugins = ['dynamicImport', 'importMeta', 'topLevelAwait']
  if (/\.(?:[cm]?ts|tsx)$/i.test(sourcePath)) plugins.push('typescript')
  if (/\.(?:tsx|jsx|[cm]?js)$/i.test(sourcePath)) plugins.push('jsx')
  return plugins
}

function walkBabel(node, parent, ancestors, visitor) {
  if (!node || typeof node !== 'object') return
  visitor(node, parent, ancestors)
  const childAncestors = [...ancestors, node]
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'errors', 'comments', 'tokens'].includes(key)) continue
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) walkBabel(child, node, childAncestors, visitor)
    } else if (value?.type) {
      walkBabel(value, node, childAncestors, visitor)
    }
  }
}

function typescriptFactProvenance(ts, sourceFile, node) {
  const startOffset = Math.max(0, node?.getStart?.(sourceFile, false) ?? node?.pos ?? 0)
  const endOffset = Math.max(startOffset, node?.getEnd?.() ?? node?.end ?? startOffset)
  const start = sourceFile.getLineAndCharacterOfPosition(startOffset)
  const end = sourceFile.getLineAndCharacterOfPosition(Math.min(endOffset, sourceFile.end))
  const kinds = []
  const visit = child => {
    if (kinds.length >= 160) return
    kinds.push(ts.SyntaxKind?.[child.kind] || String(child.kind))
    ts.forEachChild(child, visit)
  }
  visit(node)
  return {
    range: {
      start: { offset: startOffset, line: start.line + 1, column: start.character },
      end: { offset: endOffset, line: end.line + 1, column: end.character },
    },
    structureFingerprint: structureFingerprint(kinds.join('>')),
  }
}

function babelFactProvenance(node) {
  const startOffset = Number.isInteger(node?.start) ? node.start : 0
  const endOffset = Number.isInteger(node?.end) ? node.end : startOffset
  const kinds = []
  walkBabel(node, null, [], child => {
    if (kinds.length < 160) kinds.push(child.type)
  })
  return {
    range: {
      start: { offset: startOffset, line: node?.loc?.start?.line || 1, column: node?.loc?.start?.column || 0 },
      end: { offset: endOffset, line: node?.loc?.end?.line || node?.loc?.start?.line || 1, column: node?.loc?.end?.column || 0 },
    },
    structureFingerprint: structureFingerprint(kinds.join('>')),
  }
}

function isBabelExportNode(node) {
  return node?.type === 'ExportNamedDeclaration' || node?.type === 'ExportDefaultDeclaration'
}

function importBindingsFromBabel(node) {
  return (node.specifiers || []).map(item => {
    const localName = item.local?.name
    if (!localName) return null
    if (item.type === 'ImportDefaultSpecifier') return { localName, importedName: 'default', kind: 'default' }
    if (item.type === 'ImportNamespaceSpecifier') return { localName, importedName: '*', kind: 'namespace' }
    return { localName, importedName: item.imported?.name || item.imported?.value || localName, kind: 'named' }
  }).filter(Boolean)
}

function variableKindBabel(node) {
  return ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type) ? 'function' : 'variable'
}

function babelJsxName(node) {
  if (!node) return ''
  if (node.type === 'JSXIdentifier') return node.name
  if (node.type === 'JSXMemberExpression') return `${babelJsxName(node.object)}.${babelJsxName(node.property)}`
  return ''
}

function babelPropertyName(node) {
  return node?.name || node?.value || ''
}

function babelRouteComponentSpecifiers(node) {
  if (node?.type !== 'ObjectExpression') return []
  const component = (node.properties || []).find(item => ['ObjectProperty', 'Property'].includes(item.type)
    && babelPropertyName(item.key) === 'component')
  return babelDynamicImportSpecifiers(component?.value)
}

function babelDynamicImportSpecifiers(node) {
  const values = []
  walkBabel(node, null, [], current => {
    if (current.type === 'ImportExpression') {
      const value = stringValue(current.source)
      if (value !== null) values.push(value)
      return
    }
    if (current.type === 'CallExpression' && current.callee?.type === 'Import') {
      const value = stringValue(current.arguments?.[0])
      if (value !== null) values.push(value)
    }
  })
  return uniqueSorted(values)
}

function stringValue(node) {
  if (!node) return null
  if (node.type === 'StringLiteral' || node.type === 'Literal') return typeof node.value === 'string' ? node.value : null
  return null
}

function importBindingsFromText(value) {
  const source = String(value || '').trim().replace(/^type\s+/, '')
  const bindings = []
  const namespace = source.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
  if (namespace) bindings.push({ localName: namespace[1], importedName: '*', kind: 'namespace' })
  const named = source.match(/\{([\s\S]*?)\}/)?.[1] || ''
  for (const item of named.split(',')) {
    const normalized = item.trim().replace(/^type\s+/, '')
    if (!normalized) continue
    const [importedName, localName = importedName] = normalized.split(/\s+as\s+/i).map(part => part.trim())
    if (/^[A-Za-z_$][\w$]*$/.test(importedName) && /^[A-Za-z_$][\w$]*$/.test(localName)) {
      bindings.push({ localName, importedName, kind: 'named' })
    }
  }
  const defaultPart = source.split(',')[0].trim()
  if (!defaultPart.startsWith('{') && !defaultPart.startsWith('*') && /^[A-Za-z_$][\w$]*$/.test(defaultPart)) {
    bindings.push({ localName: defaultPart, importedName: 'default', kind: 'default' })
  }
  return bindings
}

function collectVueTemplateComponents(node, target) {
  if (!node || typeof node !== 'object') return
  if (node.type === 1 && componentName(node.tag || '')) {
    target.push(componentFact(node.tag, node.loc?.start?.line || 1, '@vue/compiler-sfc', 'compiler-ast'))
  }
  for (const child of node.children || []) collectVueTemplateComponents(child, target)
  if (node.branches) for (const child of node.branches) collectVueTemplateComponents(child, target)
}

function scriptProvider(result) {
  const providers = uniqueSorted([
    ...result.imports,
    ...result.symbols,
    ...result.exports,
    ...result.routes,
    ...result.componentRefs,
  ].map(item => item.provider).filter(Boolean))
  return providers.join('+') || 'fallback-lexer'
}

function lineFromOffset(source, offset) {
  let line = 1
  for (let index = 0; index < Math.max(0, offset || 0); index += 1) if (source.charCodeAt(index) === 10) line += 1
  return line
}

function wholeSourceRange(source) {
  const value = String(source || '')
  const lines = value.split('\n')
  return {
    start: { offset: 0, line: 1, column: 0 },
    end: { offset: value.length, line: lines.length, column: lines.at(-1)?.length || 0 },
  }
}

function textFactProvenance(source, startOffset, length, structureKind) {
  const value = String(source || '')
  const start = Math.max(0, Number.isInteger(startOffset) ? startOffset : 0)
  const end = Math.min(value.length, start + Math.max(0, Number.isInteger(length) ? length : 0))
  return {
    range: {
      start: sourcePositionAt(value, start),
      end: sourcePositionAt(value, end),
    },
    structureFingerprint: structureFingerprint(`${structureKind}:${value.slice(start, end).replace(/[A-Za-z_$][\w$]*/g, 'id').replace(/\s+/g, ' ')}`),
  }
}

function sourcePositionAt(source, offset) {
  const prefix = source.slice(0, offset)
  const lines = prefix.split('\n')
  return { offset, line: lines.length, column: lines.at(-1)?.length || 0 }
}

function normalizeSourceRange(range) {
  if (!range?.start || !range?.end) return null
  const position = value => ({
    offset: Math.max(0, Number.isInteger(value.offset) ? value.offset : 0),
    line: Math.max(1, Number.isInteger(value.line) ? value.line : 1),
    column: Math.max(0, Number.isInteger(value.column) ? value.column : 0),
  })
  return { start: position(range.start), end: position(range.end) }
}

function offsetRangeLines(range, lineOffset) {
  if (!range?.start || !range?.end || !lineOffset) return range || null
  return {
    start: { ...range.start, line: range.start.line + lineOffset },
    end: { ...range.end, line: range.end.line + lineOffset },
  }
}

function rangeOffset(fact) {
  return fact?.range?.start?.offset ?? fact?.line ?? 0
}

function structureFingerprint(value) {
  return `structure:sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

function parseJsonWithComments(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  return JSON.parse(withoutComments.replace(/,\s*([}\]])/g, '$1'))
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function array(value) {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

function dedupeBy(values, keyFor) {
  const seen = new Set()
  return values.filter(value => {
    const key = keyFor(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validateJsonSchema(value, schema, root = schema, pointer = '$') {
  if (schema.$ref) return validateJsonSchema(value, resolveSchemaRef(root, schema.$ref), root, pointer)
  const issues = []
  if (Object.hasOwn(schema, 'const') && value !== schema.const) issues.push(`${pointer} must equal ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.some(candidate => candidate === value)) issues.push(`${pointer} must be one of ${schema.enum.map(JSON.stringify).join(', ')}`)
  if (schema.type && !jsonTypeMatches(value, schema.type)) {
    issues.push(`${pointer} must be ${array(schema.type).join(' or ')}`)
    return issues
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${pointer} must have length >= ${schema.minLength}`)
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${pointer} must be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${pointer} must be <= ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${pointer} must contain at least ${schema.minItems} items`)
    if (schema.uniqueItems) {
      const serialized = value.map(item => JSON.stringify(item))
      if (new Set(serialized).size !== serialized.length) issues.push(`${pointer} must contain unique items`)
    }
    if (schema.items) value.forEach((item, index) => issues.push(...validateJsonSchema(item, schema.items, root, `${pointer}[${index}]`)))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) issues.push(`${pointer}.${key} is required`)
    const properties = schema.properties || {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) issues.push(`${pointer}.${key} is not allowed`)
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) issues.push(...validateJsonSchema(value[key], childSchema, root, `${pointer}.${key}`))
    }
  }
  return issues
}

function resolveSchemaRef(root, reference) {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported JSON Schema reference: ${reference}`)
  return reference.slice(2).split('/').reduce((current, part) => current?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], root)
}

function jsonTypeMatches(value, expected) {
  return array(expected).some(type => {
    if (type === 'null') return value === null
    if (type === 'array') return Array.isArray(value)
    if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    if (type === 'integer') return Number.isInteger(value)
    return typeof value === type
  })
}

export function staticProgramGraphContentHash(graph) {
  return createHash('sha256').update(JSON.stringify({ nodes: graph?.nodes || [], edges: graph?.edges || [], diagnostics: graph?.diagnostics || [] })).digest('hex')
}
