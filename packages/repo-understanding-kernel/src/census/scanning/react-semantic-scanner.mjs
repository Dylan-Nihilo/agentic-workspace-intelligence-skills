import { createHash } from 'node:crypto'

const BUILD_CONFIG_PATTERN = /(?:^|\/)(?:vite|rollup|webpack|rspack)\.config\.[cm]?[jt]s$/i
const TEST_CONFIG_PATTERN = /(?:^|\/)(?:vitest|jest|playwright|cypress)\.config\.[cm]?[jt]s$/i
const TEST_FILE_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i
const EVENT_ATTRIBUTE_PATTERN = /^on[A-Z]/
const REQUEST_CALLEES = new Set(['fetch', 'axios', 'axios.get', 'axios.post', 'axios.put', 'axios.patch', 'axios.delete'])

export function scanTypeScriptReactSemantics({ sourcePath, source, sourceFile, ts }) {
  const facts = emptySemanticFacts()
  const rangeOf = node => tsRange(sourceFile, node)
  const fingerprintOf = createTsFingerprinter(ts)
  const base = node => provenance(node, 'typescript', 'compiler-ast', rangeOf, fingerprintOf)
  const functions = collectTsFunctions(sourceFile, ts, base)
  const statesBySetter = new Map()
  const statesByName = new Map()
  const rootVariables = new Map()

  facts.fileRange = tsRange(sourceFile, sourceFile)
  facts.structureFingerprint = fingerprintOf(sourceFile)

  for (const declaration of functions.values()) {
    const role = componentRoleFor(sourcePath, declaration.name)
    if (role) facts.componentRoles.push({ ...declaration, role })
  }

  const visit = (node, ancestors = []) => {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && isTsNamedCall(node.initializer, ts, 'useState')) {
      const stateName = tsBindingName(node.name.elements?.[0]?.name)
      const setterName = tsBindingName(node.name.elements?.[1]?.name)
      if (stateName && setterName) {
        const ownerName = tsOwnerName(node, ts)
        const fact = { ...base(node), stateName, setterName, ownerName, label: stateName }
        facts.states.push(fact)
        statesBySetter.set(setterName, fact)
        statesByName.set(stateName, fact)
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && tsCalleeName(node.initializer.expression, ts) === 'createRoot') {
      rootVariables.set(node.name.text, node.initializer)
    }

    if (ts.isCallExpression(node)) {
      const callee = tsCalleeName(node.expression, ts)
      const renderReceiver = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'render'
        ? node.expression.expression
        : null
      if (renderReceiver && (isTsNamedCall(renderReceiver, ts, 'createRoot') || (ts.isIdentifier(renderReceiver) && rootVariables.has(renderReceiver.text)))) {
        const rootComponentName = firstTsJsxComponentName(node.arguments?.[0], ts, sourceFile)
        if (rootComponentName) {
          facts.bootstraps.push({
            ...base(node),
            label: `React root: ${rootComponentName}`,
            rootComponentName,
            container: tsRootContainer(renderReceiver, rootVariables, sourceFile, ts),
          })
        }
      }

      if (['createBrowserRouter', 'createHashRouter', 'useRoutes'].includes(callee)) {
        const routes = node.arguments?.[0]
        if (routes && ts.isArrayLiteralExpression(routes)) scanTsRouteArray(routes, [], [], facts.routes, { ts, sourceFile, base })
      }

      const request = tsRequestFact(node, callee, ts, sourceFile, base)
      if (request) facts.requests.push(request)

      if (statesBySetter.has(callee)) {
        const state = statesBySetter.get(callee)
        facts.stateMutations.push({ ...base(node), handlerName: tsOwnerName(node, ts), stateName: state.stateName, setterName: callee })
      }

      const outcome = tsOutcomeCandidate(node, callee, ts, sourceFile, base)
      if (outcome) facts.outcomeCandidates.push(outcome)
    }

    if (ts.isJsxOpeningElement?.(node) || ts.isJsxSelfClosingElement?.(node)) {
      collectTsJsxFacts(node, facts, statesByName, functions, { ts, sourceFile, base })
      if (tsJsxName(node.tagName, sourceFile) === 'Route') scanTsJsxRoute(node, facts.routes, { ts, sourceFile, base })
    }

    ts.forEachChild(node, child => visit(child, [...ancestors, node]))
  }
  visit(sourceFile)

  for (const event of facts.uiEvents) {
    if (event.handlerName && functions.has(event.handlerName)) facts.handlers.push(functions.get(event.handlerName))
    else if (event.inlineHandler) facts.handlers.push(event.inlineHandler)
  }

  facts.responses.push(...facts.requests.map(request => ({
    ...request,
    label: request.responseName || `${request.callee} response`,
    responseName: request.responseName || null,
    requestRef: rangeStart(request.range),
  })))
  addBuildAndTestWiring(facts, sourcePath, source, 'typescript', 'compiler-ast', facts.fileRange, facts.structureFingerprint)
  return dedupeSemanticFacts(facts)
}

export function scanBabelReactSemantics({ sourcePath, source, ast }) {
  const program = ast.program || ast
  const facts = emptySemanticFacts()
  const rangeOf = node => babelRange(node)
  const fingerprintOf = createBabelFingerprinter()
  const base = node => provenance(node, '@babel/parser', 'parser-ast', rangeOf, fingerprintOf)
  const functions = collectBabelFunctions(program, base)
  const statesBySetter = new Map()
  const statesByName = new Map()
  const rootVariables = new Map()

  facts.fileRange = babelRange(program)
  facts.structureFingerprint = fingerprintOf(program)

  for (const declaration of functions.values()) {
    const role = componentRoleFor(sourcePath, declaration.name)
    if (role) facts.componentRoles.push({ ...declaration, role })
  }

  walkBabel(program, null, [], (node, parent, ancestors) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ArrayPattern' && babelCalleeName(node.init?.callee) === 'useState') {
      const stateName = node.id.elements?.[0]?.name
      const setterName = node.id.elements?.[1]?.name
      if (stateName && setterName) {
        const fact = { ...base(node), stateName, setterName, ownerName: babelOwnerName(ancestors), label: stateName }
        facts.states.push(fact)
        statesBySetter.set(setterName, fact)
        statesByName.set(stateName, fact)
      }
    }

    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init?.type === 'CallExpression' && babelCalleeName(node.init.callee) === 'createRoot') {
      rootVariables.set(node.id.name, node.init)
    }

    if (node.type === 'CallExpression') {
      const callee = babelCalleeName(node.callee)
      const receiver = node.callee?.type === 'MemberExpression' && babelMemberProperty(node.callee) === 'render'
        ? node.callee.object
        : null
      if (receiver && ((receiver.type === 'CallExpression' && babelCalleeName(receiver.callee) === 'createRoot') || (receiver.type === 'Identifier' && rootVariables.has(receiver.name)))) {
        const rootComponentName = firstBabelJsxComponentName(node.arguments?.[0])
        if (rootComponentName) {
          facts.bootstraps.push({
            ...base(node),
            label: `React root: ${rootComponentName}`,
            rootComponentName,
            container: babelRootContainer(receiver, rootVariables),
          })
        }
      }

      if (['createBrowserRouter', 'createHashRouter', 'useRoutes'].includes(callee) && node.arguments?.[0]?.type === 'ArrayExpression') {
        scanBabelRouteArray(node.arguments[0], [], [], facts.routes, { base })
      }

      const request = babelRequestFact(node, callee, ancestors, base)
      if (request) facts.requests.push(request)
      if (statesBySetter.has(callee)) {
        const state = statesBySetter.get(callee)
        facts.stateMutations.push({ ...base(node), handlerName: babelOwnerName(ancestors), stateName: state.stateName, setterName: callee })
      }
      const outcome = babelOutcomeCandidate(node, callee, ancestors, base)
      if (outcome) facts.outcomeCandidates.push(outcome)
    }

    if (node.type === 'JSXOpeningElement') {
      collectBabelJsxFacts(node, parent, ancestors, facts, statesByName, functions, base)
      if (babelJsxName(node.name) === 'Route') scanBabelJsxRoute(node, facts.routes, base)
    }
  })

  for (const event of facts.uiEvents) {
    if (event.handlerName && functions.has(event.handlerName)) facts.handlers.push(functions.get(event.handlerName))
    else if (event.inlineHandler) facts.handlers.push(event.inlineHandler)
  }
  facts.responses.push(...facts.requests.map(request => ({
    ...request,
    label: request.responseName || `${request.callee} response`,
    responseName: request.responseName || null,
    requestRef: rangeStart(request.range),
  })))
  addBuildAndTestWiring(facts, sourcePath, source, '@babel/parser', 'parser-ast', facts.fileRange, facts.structureFingerprint)
  return dedupeSemanticFacts(facts)
}

function emptySemanticFacts() {
  return {
    bootstraps: [],
    componentRoles: [],
    routes: [],
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

function collectTsFunctions(sourceFile, ts, base) {
  const functions = new Map()
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, { ...base(node), name: node.name.text, label: node.name.text })
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functions.set(node.name.text, { ...base(node), name: node.name.text, label: node.name.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return functions
}

function collectBabelFunctions(program, base) {
  const functions = new Map()
  walkBabel(program, null, [], node => {
    if (node.type === 'FunctionDeclaration' && node.id?.name) functions.set(node.id.name, { ...base(node), name: node.id.name, label: node.id.name })
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) {
      functions.set(node.id.name, { ...base(node), name: node.id.name, label: node.id.name })
    }
  })
  return functions
}

function collectTsJsxFacts(node, facts, statesByName, functions, context) {
  const { ts, sourceFile, base } = context
  const elementName = tsJsxName(node.tagName, sourceFile)
  const ownerName = tsOwnerName(node, ts)
  const element = { ...base(node), elementName, ownerName, label: `<${elementName}>`, elementRef: rangeStart(base(node).range) }
  facts.uiElements.push(element)

  for (const attribute of node.attributes?.properties || []) {
    if (!ts.isJsxAttribute(attribute)) continue
    const eventName = attribute.name?.text || attribute.name?.getText?.(sourceFile) || ''
    if (!EVENT_ATTRIBUTE_PATTERN.test(eventName)) continue
    const expression = attribute.initializer?.expression
    let handlerName = ts.isIdentifier(expression) ? expression.text : null
    let inlineHandler = null
    if (!handlerName && expression && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))) {
      handlerName = `<inline:${eventName}@${base(expression).range.start.line}>`
      inlineHandler = { ...base(expression), name: handlerName, label: handlerName }
    }
    facts.uiEvents.push({
      ...base(attribute),
      eventName,
      handlerName,
      inlineHandler,
      ownerName,
      elementRef: element.elementRef,
      label: eventName,
    })
  }

  const feedbackKind = tsFeedbackKind(node, ts, sourceFile)
  if (feedbackKind) {
    const parent = node.parent
    const visibleText = parent && ts.isJsxElement(parent) ? tsVisibleText(parent, sourceFile) : ''
    const dependsOnStates = parent ? tsIdentifiers(parent, ts).filter(name => statesByName.has(name)) : []
    facts.feedbackCandidates.push({
      ...base(parent || node),
      label: visibleText || `${feedbackKind} feedback`,
      feedbackKind,
      visibleText: visibleText || null,
      ownerName,
      dependsOnStates: unique(dependsOnStates),
      candidateOnly: true,
      deterministicVisibleSignal: true,
    })
  }
  if (tsOutcomeElement(node, ts, sourceFile)) {
    const parent = node.parent
    const visibleText = parent && ts.isJsxElement(parent) ? tsVisibleText(parent, sourceFile) : ''
    const dependencyRoot = tsConditionalContainer(parent || node, ts) || parent || node
    const dependsOnStates = tsIdentifiers(dependencyRoot, ts).filter(name => statesByName.has(name))
    facts.outcomeCandidates.push({
      ...base(parent || node),
      label: visibleText || `${elementName} visible outcome`,
      signalKind: 'visible-output',
      target: null,
      handlerName: null,
      ownerName,
      dependsOnStates: unique(dependsOnStates),
      candidateOnly: true,
      deterministicVisibleSignal: true,
    })
  }
}

function collectBabelJsxFacts(node, parent, ancestors, facts, statesByName, functions, base) {
  const elementName = babelJsxName(node.name)
  const ownerName = babelOwnerName(ancestors)
  const element = { ...base(node), elementName, ownerName, label: `<${elementName}>`, elementRef: rangeStart(base(node).range) }
  facts.uiElements.push(element)
  for (const attribute of node.attributes || []) {
    if (attribute.type !== 'JSXAttribute') continue
    const eventName = attribute.name?.name || ''
    if (!EVENT_ATTRIBUTE_PATTERN.test(eventName)) continue
    const expression = attribute.value?.expression
    let handlerName = expression?.type === 'Identifier' ? expression.name : null
    let inlineHandler = null
    if (!handlerName && ['ArrowFunctionExpression', 'FunctionExpression'].includes(expression?.type)) {
      handlerName = `<inline:${eventName}@${base(expression).range.start.line}>`
      inlineHandler = { ...base(expression), name: handlerName, label: handlerName }
    }
    facts.uiEvents.push({ ...base(attribute), eventName, handlerName, inlineHandler, ownerName, elementRef: element.elementRef, label: eventName })
  }
  const feedbackKind = babelFeedbackKind(node)
  if (feedbackKind) {
    const elementNode = parent?.type === 'JSXElement' ? parent : ancestors.at(-1)?.type === 'JSXElement' ? ancestors.at(-1) : null
    const visibleText = elementNode ? babelVisibleText(elementNode) : ''
    const dependsOnStates = elementNode ? babelIdentifiers(elementNode).filter(name => statesByName.has(name)) : []
    facts.feedbackCandidates.push({
      ...base(elementNode || node),
      label: visibleText || `${feedbackKind} feedback`,
      feedbackKind,
      visibleText: visibleText || null,
      ownerName,
      dependsOnStates: unique(dependsOnStates),
      candidateOnly: true,
      deterministicVisibleSignal: true,
    })
  }
  if (babelOutcomeElement(node)) {
    const elementNode = parent?.type === 'JSXElement' ? parent : ancestors.at(-1)?.type === 'JSXElement' ? ancestors.at(-1) : null
    const visibleText = elementNode ? babelVisibleText(elementNode) : ''
    const dependencyRoot = [...ancestors].reverse().find(item => ['LogicalExpression', 'ConditionalExpression', 'JSXExpressionContainer'].includes(item.type)) || elementNode || node
    const dependsOnStates = babelIdentifiers(dependencyRoot).filter(name => statesByName.has(name))
    facts.outcomeCandidates.push({
      ...base(elementNode || node),
      label: visibleText || `${elementName} visible outcome`,
      signalKind: 'visible-output',
      target: null,
      handlerName: null,
      ownerName,
      dependsOnStates: unique(dependsOnStates),
      candidateOnly: true,
      deterministicVisibleSignal: true,
    })
  }
}

function scanTsRouteArray(array, inheritedLayouts, inheritedGuards, target, context) {
  const { ts, sourceFile, base } = context
  for (const element of array.elements || []) {
    if (!ts.isObjectLiteralExpression(element)) continue
    const properties = new Map()
    for (const property of element.properties || []) {
      if (ts.isPropertyAssignment(property)) properties.set(tsPropertyName(property.name), property.initializer)
    }
    const pathNode = properties.get('path')
    const indexNode = properties.get('index')
    const routePath = pathNode && ts.isStringLiteralLike(pathNode) ? pathNode.text : indexNode?.kind === ts.SyntaxKind.TrueKeyword ? '(index)' : '(pathless)'
    const components = []
    const elementNode = properties.get('element')
    if (elementNode) collectTsJsxComponentNames(elementNode, ts, sourceFile, components)
    const componentNode = properties.get('Component') || properties.get('component')
    if (componentNode && ts.isIdentifier(componentNode)) components.push(componentNode.text)
    const currentLayouts = components.filter(name => componentRoleFor('', name) === 'layout')
    const currentGuards = components.filter(name => componentRoleFor('', name) === 'auth-guard')
    const pageNames = components.filter(name => componentRoleFor('', name) === 'page')
    if (!pageNames.length) {
      const fallback = [...components].reverse().find(name => !['RouterProvider', 'Navigate', 'Outlet'].includes(name) && !currentLayouts.includes(name) && !currentGuards.includes(name))
      if (fallback) pageNames.push(fallback)
    }
    target.push({
      ...base(element),
      path: routePath,
      line: base(element).range.start.line,
      pageNames: unique(pageNames),
      layoutNames: unique([...inheritedLayouts, ...currentLayouts]),
      guardNames: unique([...inheritedGuards, ...currentGuards]),
      semanticRank: 10,
    })
    const children = properties.get('children')
    if (children && ts.isArrayLiteralExpression(children)) {
      scanTsRouteArray(children, unique([...inheritedLayouts, ...currentLayouts]), unique([...inheritedGuards, ...currentGuards]), target, context)
    }
  }
}

function scanBabelRouteArray(array, inheritedLayouts, inheritedGuards, target, context) {
  const { base } = context
  for (const element of array.elements || []) {
    if (!['ObjectExpression', 'ObjectPattern'].includes(element?.type)) continue
    const properties = new Map()
    for (const property of element.properties || []) {
      if (['ObjectProperty', 'Property'].includes(property.type)) properties.set(babelPropertyName(property.key), property.value)
    }
    const pathNode = properties.get('path')
    const routePath = babelString(pathNode) ?? (properties.get('index')?.value === true ? '(index)' : '(pathless)')
    const components = []
    if (properties.get('element')) collectBabelJsxComponentNames(properties.get('element'), components)
    const componentNode = properties.get('Component') || properties.get('component')
    if (componentNode?.type === 'Identifier') components.push(componentNode.name)
    const currentLayouts = components.filter(name => componentRoleFor('', name) === 'layout')
    const currentGuards = components.filter(name => componentRoleFor('', name) === 'auth-guard')
    const pageNames = components.filter(name => componentRoleFor('', name) === 'page')
    if (!pageNames.length) {
      const fallback = [...components].reverse().find(name => !['RouterProvider', 'Navigate', 'Outlet'].includes(name) && !currentLayouts.includes(name) && !currentGuards.includes(name))
      if (fallback) pageNames.push(fallback)
    }
    target.push({
      ...base(element),
      path: routePath,
      line: base(element).range.start.line,
      pageNames: unique(pageNames),
      layoutNames: unique([...inheritedLayouts, ...currentLayouts]),
      guardNames: unique([...inheritedGuards, ...currentGuards]),
      semanticRank: 10,
    })
    const children = properties.get('children')
    if (children?.type === 'ArrayExpression') scanBabelRouteArray(children, unique([...inheritedLayouts, ...currentLayouts]), unique([...inheritedGuards, ...currentGuards]), target, context)
  }
}

function scanTsJsxRoute(node, target, context) {
  const { ts, sourceFile, base } = context
  const attributes = new Map()
  for (const attribute of node.attributes?.properties || []) {
    if (!ts.isJsxAttribute(attribute)) continue
    attributes.set(attribute.name?.text || '', attribute.initializer)
  }
  const path = tsJsxAttributeString(attributes.get('path'), ts) || (attributes.has('index') ? '(index)' : '(pathless)')
  const expression = attributes.get('element')?.expression
  const components = []
  if (expression) collectTsJsxComponentNames(expression, ts, sourceFile, components)
  target.push({
    ...base(node),
    path,
    line: base(node).range.start.line,
    pageNames: components.filter(name => componentRoleFor('', name) === 'page'),
    layoutNames: components.filter(name => componentRoleFor('', name) === 'layout'),
    guardNames: components.filter(name => componentRoleFor('', name) === 'auth-guard'),
    semanticRank: 10,
  })
}

function scanBabelJsxRoute(node, target, base) {
  const attributes = new Map((node.attributes || []).filter(item => item.type === 'JSXAttribute').map(item => [item.name?.name, item.value]))
  const path = babelJsxAttributeString(attributes.get('path')) || (attributes.has('index') ? '(index)' : '(pathless)')
  const expression = attributes.get('element')?.expression
  const components = []
  if (expression) collectBabelJsxComponentNames(expression, components)
  target.push({
    ...base(node),
    path,
    line: base(node).range.start.line,
    pageNames: components.filter(name => componentRoleFor('', name) === 'page'),
    layoutNames: components.filter(name => componentRoleFor('', name) === 'layout'),
    guardNames: components.filter(name => componentRoleFor('', name) === 'auth-guard'),
    semanticRank: 10,
  })
}

function tsRequestFact(node, callee, ts, sourceFile, base) {
  const normalized = normalizeRequestCallee(callee)
  if (!normalized) return null
  const url = tsString(node.arguments?.[0], ts)
  const method = requestMethod(normalized, tsObjectStringProperty(node.arguments?.[1], 'method', ts))
  const responseName = tsAssignedName(node, ts)
  return {
    ...base(node),
    label: `${method} ${url || '<dynamic endpoint>'}`,
    callee: normalized,
    url,
    method,
    handlerName: tsOwnerName(node, ts),
    responseName,
  }
}

function babelRequestFact(node, callee, ancestors, base) {
  const normalized = normalizeRequestCallee(callee)
  if (!normalized) return null
  const url = babelString(node.arguments?.[0])
  const method = requestMethod(normalized, babelObjectStringProperty(node.arguments?.[1], 'method'))
  const responseName = babelAssignedName(node, ancestors)
  return { ...base(node), label: `${method} ${url || '<dynamic endpoint>'}`, callee: normalized, url, method, handlerName: babelOwnerName(ancestors), responseName }
}

function tsOutcomeCandidate(node, callee, ts, sourceFile, base) {
  if (!['navigate', 'router.push', 'router.replace', 'history.push', 'location.assign', 'window.location.assign'].includes(callee)) return null
  const target = tsString(node.arguments?.[0], ts)
  return {
    ...base(node),
    label: target ? `Navigation to ${target}` : `${callee} navigation`,
    signalKind: 'navigation',
    target,
    handlerName: tsOwnerName(node, ts),
    candidateOnly: true,
    deterministicVisibleSignal: true,
  }
}

function babelOutcomeCandidate(node, callee, ancestors, base) {
  if (!['navigate', 'router.push', 'router.replace', 'history.push', 'location.assign', 'window.location.assign'].includes(callee)) return null
  const target = babelString(node.arguments?.[0])
  return { ...base(node), label: target ? `Navigation to ${target}` : `${callee} navigation`, signalKind: 'navigation', target, handlerName: babelOwnerName(ancestors), candidateOnly: true, deterministicVisibleSignal: true }
}

function addBuildAndTestWiring(facts, sourcePath, source, provider, sourceKind, range, structureFingerprint) {
  const shared = { line: range?.start?.line || 1, range, structureFingerprint, provider, sourceKind, confidence: sourceKind === 'compiler-ast' ? 1 : 0.98 }
  if (BUILD_CONFIG_PATTERN.test(sourcePath)) {
    facts.buildWirings.push({ ...shared, label: `Build config: ${sourcePath}`, tool: buildToolFor(sourcePath), sourcePath })
  }
  if (TEST_CONFIG_PATTERN.test(sourcePath) || TEST_FILE_PATTERN.test(sourcePath)) {
    facts.testWirings.push({ ...shared, label: `Test wiring: ${sourcePath}`, tool: testToolFor(sourcePath, source), sourcePath })
  }
}

function componentRoleFor(sourcePath, name) {
  if (!name) return null
  if (/(?:Auth|Protected|Permission|Access)(?:Route|Guard|Boundary|Gate)?$/i.test(name) || /(?:Guard|Gate)$/i.test(name)) return 'auth-guard'
  if (/(?:Layout|Shell|Frame)$/i.test(name) || (/^[A-Z]/.test(name) && /(?:^|\/)layouts?(?:\/|$)/i.test(sourcePath))) return 'layout'
  if (/(?:Page|Screen|View)$/i.test(name) || (/^[A-Z]/.test(name) && /(?:^|\/)pages?(?:\/|$)/i.test(sourcePath))) return 'page'
  return null
}

function normalizeRequestCallee(callee) {
  if (REQUEST_CALLEES.has(callee)) return callee
  if (/^(?:api|client|http)\.(?:get|post|put|patch|delete|request)$/i.test(callee || '')) return callee
  return null
}

function requestMethod(callee, explicit) {
  if (explicit) return String(explicit).toUpperCase()
  const suffix = String(callee || '').split('.').at(-1)
  return ['get', 'post', 'put', 'patch', 'delete'].includes(suffix) ? suffix.toUpperCase() : 'GET'
}

function tsOwnerName(node, ts) {
  let current = node
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text
    current = current.parent
  }
  return null
}

function babelOwnerName(ancestors) {
  for (const node of [...(ancestors || [])].reverse()) {
    if (node.type === 'FunctionDeclaration' && node.id?.name) return node.id.name
    if (['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type)) {
      const parentIndex = ancestors.indexOf(node) - 1
      const parent = parentIndex >= 0 ? ancestors[parentIndex] : null
      if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name
    }
  }
  return null
}

function tsFeedbackKind(node, ts, sourceFile) {
  for (const attribute of node.attributes?.properties || []) {
    if (!ts.isJsxAttribute(attribute)) continue
    const name = attribute.name?.text || ''
    const value = tsJsxAttributeString(attribute.initializer, ts)
    if (name === 'role' && ['status', 'alert'].includes(value)) return value
    if (name === 'aria-live') return 'aria-live'
  }
  return null
}

function babelFeedbackKind(node) {
  for (const attribute of node.attributes || []) {
    if (attribute.type !== 'JSXAttribute') continue
    const name = attribute.name?.name
    const value = babelJsxAttributeString(attribute.value)
    if (name === 'role' && ['status', 'alert'].includes(value)) return value
    if (name === 'aria-live') return 'aria-live'
  }
  return null
}

function tsOutcomeElement(node, ts, sourceFile) {
  if (tsJsxName(node.tagName, sourceFile) === 'output') return true
  return (node.attributes?.properties || []).some(attribute => ts.isJsxAttribute(attribute) && ['data-outcome', 'data-result'].includes(attribute.name?.text || ''))
}

function babelOutcomeElement(node) {
  if (babelJsxName(node.name) === 'output') return true
  return (node.attributes || []).some(attribute => attribute.type === 'JSXAttribute' && ['data-outcome', 'data-result'].includes(attribute.name?.name || ''))
}

function tsConditionalContainer(node, ts) {
  let current = node
  for (let depth = 0; current && depth < 6; depth += 1, current = current.parent) {
    if (ts.isJsxExpression?.(current) || ts.isConditionalExpression?.(current) || ts.isBinaryExpression?.(current)) return current
  }
  return null
}

function tsVisibleText(node, sourceFile) {
  const values = []
  const visit = child => {
    if (child.kind === sourceFile.languageVariant && false) return
    if (child.text && child.kind === 12) values.push(String(child.text).trim())
    child.forEachChild?.(visit)
  }
  node.forEachChild?.(visit)
  return values.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

function babelVisibleText(node) {
  const values = []
  walkBabel(node, null, [], child => {
    if (child.type === 'JSXText' && child.value?.trim()) values.push(child.value.trim())
    if (child.type === 'StringLiteral' && child.value?.trim()) values.push(child.value.trim())
  })
  return values.join(' ').replace(/\s+/g, ' ').trim()
}

function tsIdentifiers(node, ts) {
  const values = []
  const visit = child => {
    if (ts.isIdentifier(child)) values.push(child.text)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return unique(values)
}

function babelIdentifiers(node) {
  const values = []
  walkBabel(node, null, [], child => {
    if (child.type === 'Identifier') values.push(child.name)
  })
  return unique(values)
}

function tsAssignedName(node, ts) {
  let current = node.parent
  if (ts.isAwaitExpression(current)) current = current.parent
  return ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) ? current.name.text : null
}

function babelAssignedName(node, ancestors) {
  const reversed = [...(ancestors || [])].reverse()
  const declaration = reversed.find(item => item.type === 'VariableDeclarator')
  return declaration?.id?.type === 'Identifier' ? declaration.id.name : null
}

function tsRootContainer(receiver, rootVariables, sourceFile, ts) {
  const call = ts.isCallExpression(receiver) ? receiver : ts.isIdentifier(receiver) ? rootVariables.get(receiver.text) : null
  return call ? call.arguments?.[0]?.getText(sourceFile) || null : null
}

function babelRootContainer(receiver, rootVariables) {
  const call = receiver?.type === 'CallExpression' ? receiver : receiver?.type === 'Identifier' ? rootVariables.get(receiver.name) : null
  const argument = call?.arguments?.[0]
  if (argument?.type === 'StringLiteral') return argument.value
  if (argument?.type === 'CallExpression') return babelCalleeName(argument.callee)
  return null
}

function firstTsJsxComponentName(node, ts, sourceFile) {
  if (!node) return null
  if (ts.isJsxElement(node)) return tsJsxName(node.openingElement.tagName, sourceFile)
  if (ts.isJsxSelfClosingElement(node)) return tsJsxName(node.tagName, sourceFile)
  return null
}

function firstBabelJsxComponentName(node) {
  if (node?.type === 'JSXElement') return babelJsxName(node.openingElement?.name)
  if (node?.type === 'JSXFragment') {
    for (const child of node.children || []) {
      const name = firstBabelJsxComponentName(child)
      if (name) return name
    }
  }
  return null
}

function collectTsJsxComponentNames(node, ts, sourceFile, target) {
  const visit = child => {
    if (ts.isJsxOpeningElement?.(child) || ts.isJsxSelfClosingElement?.(child)) {
      const name = tsJsxName(child.tagName, sourceFile)
      if (/^[A-Z]/.test(name)) target.push(name)
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
}

function collectBabelJsxComponentNames(node, target) {
  walkBabel(node, null, [], child => {
    if (child.type === 'JSXOpeningElement') {
      const name = babelJsxName(child.name)
      if (/^[A-Z]/.test(name)) target.push(name)
    }
  })
}

function tsCalleeName(node, ts) {
  if (!node) return ''
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return `${tsCalleeName(node.expression, ts)}.${node.name.text}`
  return ''
}

function babelCalleeName(node) {
  if (!node) return ''
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return `${babelCalleeName(node.object)}.${babelMemberProperty(node)}`
  return ''
}

function babelMemberProperty(node) {
  return node?.property?.name || node?.property?.value || ''
}

function isTsNamedCall(node, ts, name) {
  return Boolean(node && ts.isCallExpression(node) && tsCalleeName(node.expression, ts) === name)
}

function tsBindingName(node) {
  return node?.text || node?.escapedText || null
}

function tsPropertyName(node) {
  return node?.text || node?.escapedText || ''
}

function tsJsxName(node, sourceFile) {
  return node?.getText?.(sourceFile) || node?.text || ''
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

function tsString(node, ts) {
  if (!node) return null
  return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral?.(node) ? node.text : null
}

function babelString(node) {
  if (!node) return null
  return ['StringLiteral', 'Literal'].includes(node.type) && typeof node.value === 'string' ? node.value : null
}

function tsObjectStringProperty(node, name, ts) {
  if (!node || !ts.isObjectLiteralExpression(node)) return null
  const property = node.properties.find(item => ts.isPropertyAssignment(item) && tsPropertyName(item.name) === name)
  return property ? tsString(property.initializer, ts) : null
}

function babelObjectStringProperty(node, name) {
  if (node?.type !== 'ObjectExpression') return null
  const property = node.properties.find(item => ['ObjectProperty', 'Property'].includes(item.type) && babelPropertyName(item.key) === name)
  return property ? babelString(property.value) : null
}

function tsJsxAttributeString(node, ts) {
  if (!node) return null
  if (ts.isStringLiteral?.(node)) return node.text
  if (node.expression) return tsString(node.expression, ts)
  return null
}

function babelJsxAttributeString(node) {
  if (!node) return null
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'JSXExpressionContainer') return babelString(node.expression)
  return null
}

function buildToolFor(sourcePath) {
  if (/vite/i.test(sourcePath)) return 'vite'
  if (/rollup/i.test(sourcePath)) return 'rollup'
  if (/webpack/i.test(sourcePath)) return 'webpack'
  if (/rspack/i.test(sourcePath)) return 'rspack'
  return 'unknown'
}

function testToolFor(sourcePath, source) {
  if (/vitest/i.test(sourcePath) || /\b(?:describe|it|test)\s*\(/.test(source) && /from\s+['"]vitest['"]/.test(source)) return 'vitest'
  if (/playwright/i.test(sourcePath)) return 'playwright'
  if (/cypress/i.test(sourcePath)) return 'cypress'
  if (/jest/i.test(sourcePath)) return 'jest'
  return 'test-runner'
}

function provenance(node, provider, sourceKind, rangeOf, fingerprintOf) {
  const range = rangeOf(node)
  return {
    line: range.start.line,
    range,
    structureFingerprint: fingerprintOf(node),
    provider,
    sourceKind,
    confidence: sourceKind === 'compiler-ast' ? 1 : 0.98,
  }
}

function tsRange(sourceFile, node) {
  const startOffset = Math.max(0, node?.getStart?.(sourceFile, false) ?? node?.pos ?? 0)
  const endOffset = Math.max(startOffset, node?.getEnd?.() ?? node?.end ?? startOffset)
  const start = sourceFile.getLineAndCharacterOfPosition(startOffset)
  const end = sourceFile.getLineAndCharacterOfPosition(Math.min(endOffset, sourceFile.end))
  return {
    start: { offset: startOffset, line: start.line + 1, column: start.character + 1 },
    end: { offset: endOffset, line: end.line + 1, column: end.character + 1 },
  }
}

function babelRange(node) {
  const startOffset = Number.isInteger(node?.start) ? node.start : 0
  const endOffset = Number.isInteger(node?.end) ? node.end : startOffset
  return {
    start: { offset: startOffset, line: node?.loc?.start?.line || 1, column: (node?.loc?.start?.column ?? 0) + 1 },
    end: { offset: endOffset, line: node?.loc?.end?.line || node?.loc?.start?.line || 1, column: (node?.loc?.end?.column ?? node?.loc?.start?.column ?? 0) + 1 },
  }
}

function createTsFingerprinter(ts) {
  const cache = new WeakMap()
  return node => {
    if (cache.has(node)) return cache.get(node)
    const kinds = []
    const visit = child => {
      if (kinds.length >= 160) return
      kinds.push(ts.SyntaxKind?.[child.kind] || String(child.kind))
      ts.forEachChild(child, visit)
    }
    visit(node)
    const value = fingerprint(kinds.join('>'))
    cache.set(node, value)
    return value
  }
}

function createBabelFingerprinter() {
  const cache = new WeakMap()
  return node => {
    if (cache.has(node)) return cache.get(node)
    const kinds = []
    walkBabel(node, null, [], child => {
      if (kinds.length < 160) kinds.push(child.type)
    })
    const value = fingerprint(kinds.join('>'))
    cache.set(node, value)
    return value
  }
}

function fingerprint(value) {
  return `structure:sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

function rangeStart(range) {
  return range?.start?.offset ?? 0
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

function dedupeSemanticFacts(facts) {
  for (const key of Object.keys(facts)) {
    if (!Array.isArray(facts[key])) continue
    const seen = new Set()
    facts[key] = facts[key].filter(item => {
      const identity = `${item.label || item.name || item.path || ''}:${rangeStart(item.range)}:${item.eventName || ''}:${item.role || ''}`
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
  }
  return facts
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))]
}
