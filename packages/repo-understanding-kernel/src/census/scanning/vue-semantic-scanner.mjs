import { createHash } from 'node:crypto'

const REQUEST_STATE_CALLS = new Set(['ref', 'reactive', 'shallowRef', 'shallowReactive'])
export function scanTypeScriptVueSemantics({ sourcePath, sourceFile, ts }) {
  const facts = emptySemanticFacts()
  const base = node => tsProvenance(sourceFile, node, ts)
  const stateNames = new Set()

  const collectState = node => {
    if (/\.vue\.[cm]?[jt]sx?$/i.test(sourcePath) && ts.isFunctionDeclaration(node) && node.name) {
      facts.handlers.push({ ...base(node), name: node.name.text, label: node.name.text })
    }
    if (/\.vue\.[cm]?[jt]sx?$/i.test(sourcePath) && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      facts.handlers.push({ ...base(node), name: node.name.text, label: node.name.text })
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isCallExpression(node.initializer)) {
      const callee = tsCalleeName(node.initializer.expression, ts)
      if (REQUEST_STATE_CALLS.has(callee)) {
        const stateName = node.name.text
        stateNames.add(stateName)
        facts.states.push({
          ...base(node),
          stateName,
          setterName: `${stateName}.value`,
          ownerName: vueComponentName(sourcePath),
          label: stateName,
        })
      }
    }
    ts.forEachChild(node, collectState)
  }
  collectState(sourceFile)

  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = tsCalleeName(node.expression, ts)
      if (callee.endsWith('.mount')) {
        const createAppCall = findNamedCall(node.expression, ts, 'createApp')
        const rootComponentName = tsIdentifierName(createAppCall?.arguments?.[0], ts)
        if (rootComponentName) {
          facts.bootstraps.push({
            ...base(node),
            label: `Vue root: ${rootComponentName}`,
            rootComponentName,
            container: tsString(node.arguments?.[0], ts),
          })
        }
      }
      if (callee === 'createRouter') {
        const options = node.arguments?.[0]
        const routes = tsObjectProperty(options, 'routes', ts)
        if (routes && ts.isArrayLiteralExpression(routes)) scanVueRouteArray(routes, facts.routes, { ts, sourceFile, base })
      }
    }

    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const stateName = vueStateTarget(node.left, ts)
      if (stateName && stateNames.has(stateName)) {
        facts.stateMutations.push({
          ...base(node),
          handlerName: tsOwnerName(node, ts),
          stateName,
          setterName: `${stateName}.value`,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return dedupeSemanticFacts(facts)
}

export function scanBabelVueSemantics({ sourcePath, ast }) {
  const program = ast?.program || ast
  const facts = emptySemanticFacts()
  const base = node => babelProvenance(node)
  const stateNames = new Set()

  walkBabel(program, null, [], node => {
    if (/\.vue\.[cm]?[jt]sx?$/i.test(sourcePath) && node.type === 'FunctionDeclaration' && node.id?.name) {
      facts.handlers.push({ ...base(node), name: node.id.name, label: node.id.name })
    }
    if (/\.vue\.[cm]?[jt]sx?$/i.test(sourcePath) && node.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
      && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
      facts.handlers.push({ ...base(node), name: node.id.name, label: node.id.name })
    }
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier' || node.init?.type !== 'CallExpression') return
    const callee = babelCalleeName(node.init.callee)
    if (!REQUEST_STATE_CALLS.has(callee)) return
    const stateName = node.id.name
    stateNames.add(stateName)
    facts.states.push({
      ...base(node),
      stateName,
      setterName: `${stateName}.value`,
      ownerName: vueComponentName(sourcePath),
      label: stateName,
    })
  })

  walkBabel(program, null, [], (node, parent, ancestors) => {
    if (node.type === 'CallExpression') {
      const callee = babelCalleeName(node.callee)
      if (callee.endsWith('.mount')) {
        const createAppCall = findBabelNamedCall(node.callee, 'createApp')
        const rootComponentName = babelIdentifierName(createAppCall?.arguments?.[0])
        if (rootComponentName) {
          facts.bootstraps.push({
            ...base(node),
            label: `Vue root: ${rootComponentName}`,
            rootComponentName,
            container: babelString(node.arguments?.[0]),
          })
        }
      }
      if (callee === 'createRouter') {
        const routes = babelObjectProperty(node.arguments?.[0], 'routes')
        if (routes?.type === 'ArrayExpression') scanBabelVueRouteArray(routes, facts.routes, base)
      }
    }

    if (node.type === 'AssignmentExpression') {
      const stateName = babelVueStateTarget(node.left)
      if (stateName && stateNames.has(stateName)) {
        facts.stateMutations.push({
          ...base(node),
          handlerName: babelOwnerName(ancestors),
          stateName,
          setterName: `${stateName}.value`,
        })
      }
    }
  })
  facts.fileRange = babelRange(program)
  facts.structureFingerprint = babelProvenance(program).structureFingerprint
  return dedupeSemanticFacts(facts)
}

export function scanVueSfcSemantics({ sourcePath, source, descriptor, compilerDom }) {
  const facts = emptySemanticFacts()
  const componentName = vueComponentName(sourcePath)
  const fileRange = sourceRange(source)
  facts.fileRange = fileRange
  facts.structureFingerprint = fingerprint(`vue-sfc:${sourcePath}:${source}`)

  const role = componentRoleFor(sourcePath, componentName)
  if (role) {
    facts.componentRoles.push({
      ...fileProvenance(fileRange, '@vue/compiler-sfc', 'compiler-ast', `vue-sfc-role:${role}`),
      name: componentName,
      label: componentName,
      role,
    })
  }

  const block = descriptor?.template
  if (!block?.content || typeof compilerDom?.parse !== 'function') return dedupeSemanticFacts(facts)
  const ast = compilerDom.parse(block.content, { comments: false })
  const location = {
    offset: Number.isInteger(block.loc?.start?.offset) ? block.loc.start.offset : source.indexOf(block.content),
    line: Number.isInteger(block.loc?.start?.line) ? block.loc.start.line : 1,
    column: Number.isInteger(block.loc?.start?.column) ? block.loc.start.column : 1,
  }
  const base = node => vueTemplateProvenance(node, location)

  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 1) {
      const provenance = base(node)
      const elementRef = provenance.range.start.offset
      facts.uiElements.push({
        ...provenance,
        elementName: node.tag,
        ownerName: componentName,
        label: `<${node.tag}>`,
        elementRef,
      })

      if (node.tagType === 1 || componentTag(node.tag)) {
        facts.componentRefs.push({
          ...provenance,
          name: node.tag,
          line: provenance.range.start.line,
          confidence: 1,
        })
      }

      for (const property of node.props || []) {
        if (property.type !== 7 || property.name !== 'on') continue
        const eventName = staticVueExpression(property.arg)
        const handlerName = staticHandlerName(property.exp)
        if (!eventName) continue
        facts.uiEvents.push({
          ...base(property),
          eventName,
          handlerName,
          inlineHandler: null,
          ownerName: componentName,
          elementRef,
          label: eventName,
        })
      }

      const feedbackKind = vueFeedbackKind(node)
      const dependsOnStates = vueDependencies(node)
      const visibleText = vueVisibleText(node)
      if (feedbackKind) {
        facts.feedbackCandidates.push({
          ...provenance,
          label: visibleText || `${feedbackKind} feedback`,
          feedbackKind,
          visibleText: visibleText || null,
          ownerName: componentName,
          dependsOnStates,
          candidateOnly: true,
          deterministicVisibleSignal: true,
        })
      }
      if (vueOutcomeElement(node)) {
        facts.outcomeCandidates.push({
          ...provenance,
          label: visibleText || `${node.tag} visible outcome`,
          signalKind: 'visible-output',
          target: null,
          handlerName: null,
          ownerName: componentName,
          dependsOnStates,
          candidateOnly: true,
          deterministicVisibleSignal: true,
        })
      }
    }
    for (const child of vueChildren(node)) visit(child)
  }
  visit(ast)
  return dedupeSemanticFacts(facts)
}

function scanVueRouteArray(array, target, context) {
  const { ts, base } = context
  for (const element of array.elements || []) {
    if (!ts.isObjectLiteralExpression(element)) continue
    const routePathNode = tsObjectProperty(element, 'path', ts)
    const componentNode = tsObjectProperty(element, 'component', ts)
    const beforeEnterNode = tsObjectProperty(element, 'beforeEnter', ts)
    const routePath = tsString(routePathNode, ts) || '(pathless)'
    const componentName = tsIdentifierName(componentNode, ts)
    const pageSpecifiers = tsDynamicImportSpecifiers(componentNode, ts)
    const guardName = tsIdentifierName(beforeEnterNode, ts)
    target.push({
      ...base(element),
      path: routePath,
      line: base(element).range.start.line,
      pageNames: componentName ? [componentName] : [],
      pageSpecifiers,
      layoutNames: [],
      guardNames: guardName ? [guardName] : [],
      semanticRank: 20,
    })
    const children = tsObjectProperty(element, 'children', ts)
    if (children && ts.isArrayLiteralExpression(children)) scanVueRouteArray(children, target, context)
  }
}

function scanBabelVueRouteArray(array, target, base) {
  for (const element of array.elements || []) {
    if (element?.type !== 'ObjectExpression') continue
    const routePath = babelString(babelObjectProperty(element, 'path')) || '(pathless)'
    const componentNode = babelObjectProperty(element, 'component')
    const componentName = babelIdentifierName(componentNode)
    const pageSpecifiers = babelDynamicImportSpecifiers(componentNode)
    const guardName = babelIdentifierName(babelObjectProperty(element, 'beforeEnter'))
    target.push({
      ...base(element),
      path: routePath,
      line: base(element).range.start.line,
      pageNames: componentName ? [componentName] : [],
      pageSpecifiers,
      layoutNames: [],
      guardNames: guardName ? [guardName] : [],
      semanticRank: 20,
    })
    const children = babelObjectProperty(element, 'children')
    if (children?.type === 'ArrayExpression') scanBabelVueRouteArray(children, target, base)
  }
}

function findNamedCall(node, ts, name) {
  if (!node) return null
  if (ts.isCallExpression(node) && tsCalleeName(node.expression, ts) === name) return node
  if (ts.isCallExpression(node)) return findNamedCall(node.expression, ts, name)
  if (ts.isPropertyAccessExpression(node)) return findNamedCall(node.expression, ts, name)
  return null
}

function tsObjectProperty(node, name, ts) {
  if (!node || !ts.isObjectLiteralExpression(node)) return null
  const property = node.properties.find(item => ts.isPropertyAssignment(item) && tsPropertyName(item.name) === name)
  return property?.initializer || null
}

function tsCalleeName(node, ts) {
  if (!node) return ''
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return `${tsCalleeName(node.expression, ts)}.${node.name.text}`
  if (ts.isCallExpression(node)) return tsCalleeName(node.expression, ts)
  return ''
}

function tsIdentifierName(node, ts) {
  if (!node) return null
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return null
}

function tsDynamicImportSpecifiers(node, ts) {
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
  return [...new Set(values)].sort()
}

function tsString(node, ts) {
  return node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral?.(node)) ? node.text : null
}

function tsPropertyName(node) {
  return node?.text || node?.escapedText || ''
}

function vueStateTarget(node, ts) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'value') return null
  return ts.isIdentifier(node.expression) ? node.expression.text : null
}

function tsOwnerName(node, ts) {
  let current = node
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
      return current.parent.name.text
    }
    current = current.parent
  }
  return null
}

function findBabelNamedCall(node, name) {
  if (!node) return null
  if (node.type === 'CallExpression' && babelCalleeName(node.callee) === name) return node
  if (node.type === 'CallExpression') return findBabelNamedCall(node.callee, name)
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return findBabelNamedCall(node.object, name)
  return null
}

function babelCalleeName(node) {
  if (!node) return ''
  if (node.type === 'Identifier') return node.name
  if (node.type === 'CallExpression') return babelCalleeName(node.callee)
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    return `${babelCalleeName(node.object)}.${node.property?.name || node.property?.value || ''}`
  }
  return ''
}

function babelObjectProperty(node, name) {
  if (node?.type !== 'ObjectExpression') return null
  const property = (node.properties || []).find(item => ['ObjectProperty', 'Property'].includes(item.type)
    && (item.key?.name || item.key?.value) === name)
  return property?.value || null
}

function babelIdentifierName(node) {
  if (node?.type === 'Identifier') return node.name
  if (node?.type === 'MemberExpression') return node.property?.name || node.property?.value || null
  return null
}

function babelString(node) {
  return ['StringLiteral', 'Literal'].includes(node?.type) && typeof node.value === 'string' ? node.value : null
}

function babelDynamicImportSpecifiers(node) {
  const values = []
  walkBabel(node, null, [], current => {
    if (current.type === 'ImportExpression') {
      const value = babelString(current.source)
      if (value !== null) values.push(value)
      return
    }
    if (current.type === 'CallExpression' && current.callee?.type === 'Import') {
      const value = babelString(current.arguments?.[0])
      if (value !== null) values.push(value)
    }
  })
  return [...new Set(values)].sort()
}

function babelVueStateTarget(node) {
  if (!['MemberExpression', 'OptionalMemberExpression'].includes(node?.type)) return null
  if ((node.property?.name || node.property?.value) !== 'value') return null
  return node.object?.type === 'Identifier' ? node.object.name : null
}

function babelOwnerName(ancestors) {
  for (let index = (ancestors || []).length - 1; index >= 0; index -= 1) {
    const node = ancestors[index]
    if (node.type === 'FunctionDeclaration' && node.id?.name) return node.id.name
    if (['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type)) {
      const parent = ancestors[index - 1]
      if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name
    }
  }
  return null
}

function tsProvenance(sourceFile, node, ts) {
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
    line: start.line + 1,
    range: {
      start: { offset: startOffset, line: start.line + 1, column: start.character },
      end: { offset: endOffset, line: end.line + 1, column: end.character },
    },
    structureFingerprint: fingerprint(kinds.join('>')),
    provider: 'typescript',
    sourceKind: 'compiler-ast',
    confidence: 1,
  }
}

function babelProvenance(node) {
  const range = babelRange(node)
  const kinds = []
  walkBabel(node, null, [], child => {
    if (kinds.length < 160) kinds.push(child.type)
  })
  return {
    line: range.start.line,
    range,
    structureFingerprint: fingerprint(kinds.join('>')),
    provider: '@babel/parser',
    sourceKind: 'parser-ast',
    confidence: 0.98,
  }
}

function babelRange(node) {
  const startOffset = Number.isInteger(node?.start) ? node.start : 0
  const endOffset = Number.isInteger(node?.end) ? node.end : startOffset
  return {
    start: { offset: startOffset, line: node?.loc?.start?.line || 1, column: node?.loc?.start?.column || 0 },
    end: { offset: endOffset, line: node?.loc?.end?.line || node?.loc?.start?.line || 1, column: node?.loc?.end?.column || 0 },
  }
}

function vueTemplateProvenance(node, blockStart) {
  const range = vueRange(node?.loc, blockStart)
  return {
    line: range.start.line,
    range,
    structureFingerprint: fingerprint(vueStructure(node)),
    provider: '@vue/compiler-dom',
    sourceKind: 'compiler-ast',
    confidence: 1,
  }
}

function fileProvenance(range, provider, sourceKind, structure) {
  return {
    line: range.start.line,
    range,
    structureFingerprint: fingerprint(structure),
    provider,
    sourceKind,
    confidence: 1,
  }
}

function vueRange(loc, blockStart) {
  const position = value => {
    const localLine = Number.isInteger(value?.line) ? value.line : 1
    const localColumn = Number.isInteger(value?.column) ? value.column : 1
    return {
      offset: Math.max(0, blockStart.offset + (Number.isInteger(value?.offset) ? value.offset : 0)),
      line: Math.max(1, blockStart.line + localLine - 1),
      column: Math.max(0, localColumn - 1 + (localLine === 1 ? blockStart.column - 1 : 0)),
    }
  }
  return { start: position(loc?.start), end: position(loc?.end) }
}

function sourceRange(source) {
  const lines = String(source || '').split('\n')
  return {
    start: { offset: 0, line: 1, column: 0 },
    end: { offset: String(source || '').length, line: lines.length, column: lines.at(-1)?.length || 0 },
  }
}

function vueStructure(node) {
  const values = []
  const visit = item => {
    if (!item || typeof item !== 'object' || values.length >= 160) return
    values.push(String(item.type ?? 'object'))
    if (item.type === 1) values.push(`tag:${item.tagType}`)
    if (item.type === 7) values.push(`directive:${item.name}`)
    for (const child of vueChildren(item)) visit(child)
  }
  visit(node)
  return values.join('>')
}

function vueChildren(node) {
  const result = []
  for (const key of ['children', 'props', 'branches']) {
    if (Array.isArray(node?.[key])) result.push(...node[key])
  }
  if (node?.content && typeof node.content === 'object') result.push(node.content)
  if (node?.condition && typeof node.condition === 'object') result.push(node.condition)
  return result
}

function walkBabel(node, parent, ancestors, visitor) {
  if (!node || typeof node !== 'object') return
  visitor(node, parent, ancestors)
  const next = [...ancestors, node]
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'errors', 'comments', 'tokens'].includes(key)) continue
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) walkBabel(child, node, next, visitor)
    } else if (value?.type) {
      walkBabel(value, node, next, visitor)
    }
  }
}

function staticVueExpression(node) {
  const value = node?.isStatic === false ? null : node?.content
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function staticHandlerName(node) {
  const value = typeof node?.content === 'string' ? node.content.trim() : ''
  return /^[A-Za-z_$][\w$]*$/.test(value) ? value : null
}

function staticVueAttribute(node, name) {
  const property = (node?.props || []).find(item => item.type === 6 && item.name === name)
  return property?.value?.content || null
}

function vueFeedbackKind(node) {
  const role = staticVueAttribute(node, 'role')
  if (role === 'status' || role === 'alert') return role
  return staticVueAttribute(node, 'aria-live') ? 'aria-live' : null
}

function vueOutcomeElement(node) {
  return node?.tag === 'output'
    || (node?.props || []).some(item => item.type === 6 && ['data-outcome', 'data-result'].includes(item.name))
}

function vueVisibleText(node) {
  const values = []
  const visit = item => {
    if (!item || typeof item !== 'object') return
    if (item.type === 2 && item.content?.trim()) values.push(item.content.trim())
    for (const child of vueChildren(item)) visit(child)
  }
  visit(node)
  return values.join(' ').replace(/\s+/g, ' ').trim()
}

function vueDependencies(node) {
  const expressions = []
  const visit = item => {
    if (!item || typeof item !== 'object') return
    if ((item.type === 4 || item.type === 8) && typeof item.content === 'string') expressions.push(item.content)
    if (item.type === 7 && typeof item.exp?.content === 'string') expressions.push(item.exp.content)
    for (const child of vueChildren(item)) visit(child)
  }
  visit(node)
  const ignored = new Set(['true', 'false', 'null', 'undefined', 'return', 'if', 'else', 'const', 'let', 'var'])
  return [...new Set(expressions.flatMap(value => value.match(/[A-Za-z_$][\w$]*/g) || []).filter(value => !ignored.has(value)))].sort()
}

function vueComponentName(sourcePath) {
  const base = String(sourcePath || '').split('/').at(-1) || 'AnonymousComponent'
  return base.replace(/\.vue(?:\.[cm]?[jt]sx?)?$/i, '') || 'AnonymousComponent'
}

function componentRoleFor(sourcePath, name) {
  if (/(?:Auth|Protected|Permission|Access)(?:Route|Guard|Boundary|Gate)?$/i.test(name) || /(?:Guard|Gate)$/i.test(name)) return 'auth-guard'
  if (/(?:Layout|Shell|Frame)$/i.test(name) || /(?:^|\/)layouts?(?:\/|$)/i.test(sourcePath)) return 'layout'
  if (/(?:Page|Screen|View)$/i.test(name) || /(?:^|\/)(?:pages?|views?)(?:\/|$)/i.test(sourcePath)) return 'page'
  return null
}

function componentTag(tag) {
  return /^[A-Z][A-Za-z0-9.$]*$/.test(tag || '') || /^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(tag || '')
}

function emptySemanticFacts() {
  return {
    bootstraps: [],
    componentRoles: [],
    routes: [],
    componentRefs: [],
    uiElements: [],
    uiEvents: [],
    handlers: [],
    states: [],
    stateMutations: [],
    requests: [],
    responses: [],
    feedbackCandidates: [],
    outcomeCandidates: [],
    buildWirings: [],
    testWirings: [],
    fileRange: null,
    structureFingerprint: null,
  }
}

function dedupeSemanticFacts(facts) {
  for (const [key, values] of Object.entries(facts)) {
    if (!Array.isArray(values)) continue
    const seen = new Set()
    facts[key] = values.filter(item => {
      const identity = `${item.label || item.name || item.path || ''}:${item.range?.start?.offset || 0}:${item.eventName || ''}:${item.role || ''}`
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
  }
  return facts
}

function fingerprint(value) {
  return `structure:sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}
