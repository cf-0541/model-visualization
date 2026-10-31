// ESTree implementation. Public TypeScript contracts are declared in the adjacent .d.mts file.
import { parse, tokenizer } from 'acorn'
import { full, fullAncestor } from 'acorn-walk'
import { generate } from 'astring'

const id = (name) => ({ type: 'Identifier', name })
const literal = (value) => ({ type: 'Literal', value })
const member = (object, property) => ({ type: 'MemberExpression', object, property, computed: false, optional: false })
const call = (method, args) => ({ type: 'CallExpression', callee: member(id('__trace'), id(method)), arguments: args, optional: false })
const statement = (expression) => ({ type: 'ExpressionStatement', expression })
const block = (body) => ({ type: 'BlockStatement', body })
const line = (node, fallback = 1) => node.loc?.start.line ?? fallback
const traceReturn = (name, argument, at, callId) => call('ret', [literal(name), argument ?? id('undefined'), literal(at), id(callId)])
const assignment = (left, right) => ({ type: 'AssignmentExpression', operator: '=', left, right })

// Babel's compact branch labels have no purely whitespace-based equivalent:
// e.g. `x + +y` needs a space, while `a + b` does not. Minimize the Astring
// expression only when Acorn confirms that its AST stays unchanged.
function labelShape(text) {
  const privateFields = [...new Set([...tokenizer(text, { ecmaVersion: 'latest' })]
    .filter((token) => token.type.label === 'privateId').map((token) => token.value))]
  const declarations = privateFields.map((name) => `#${name};`).join('')
  const wrapper = `class _Pilot extends Object { ${declarations} async *method() { return (${text}); } }`
  const ast = parse(wrapper, { ecmaVersion: 'latest' })
  const expression = ast.body[0].body.body.at(-1).value.body.body[0].argument
  return JSON.stringify(expression, (key, value) =>
    ['start', 'end', 'raw', 'loc'].includes(key) ? undefined : typeof value === 'bigint' ? `${value}n` : value)
}

function branchLabel(node) {
  let code = generate(node).trim()
  let expected
  try { expected = labelShape(code) } catch { return code }
  const matches = (candidate) => {
    try { return labelShape(candidate) === expected } catch { return false }
  }

  // Astring conservatively wraps regex/member and `in` expressions. Babel
  // removes those parentheses whenever doing so preserves the expression.
  while (true) {
    const stack = []
    const pairs = []
    for (const token of tokenizer(code, { ecmaVersion: 'latest' })) {
      if (token.type.label === '(') stack.push(token.start)
      if (token.type.label === ')' && stack.length) pairs.push([stack.pop(), token.start])
    }
    pairs.sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]))
    const removable = pairs.find(([open, close]) => matches(code.slice(0, open) + code.slice(open + 1, close) + code.slice(close + 1)))
    if (!removable) break
    const [open, close] = removable
    code = code.slice(0, open) + code.slice(open + 1, close) + code.slice(close + 1)
  }

  const tokens = [...tokenizer(code, { ecmaVersion: 'latest' })].filter((token) => token.type.label !== 'eof')
  const fragments = tokens.map((token) => code.slice(token.start, token.end))
  const quick = fragments.reduce((result, part, index) => {
    if (!index) return part
    const left = fragments[index - 1]
    const needsSpace = /[$\w]$/.test(left) && /^[$\w]/.test(part) ||
      /[+-]$/.test(left) && left.at(-1) === part[0] ||
      left.endsWith('/') && /^[/*]/.test(part)
    return result + (needsSpace ? ' ' : '') + part
  }, '')
  if (matches(quick)) return quick

  // Unusual lexical boundaries fall back to a checked, gap-by-gap reduction.
  for (let index = tokens.length - 1; index > 0; index -= 1) {
    const start = tokens[index - 1].end
    const end = tokens[index].start
    if (start === end) continue
    const candidate = code.slice(0, start) + code.slice(end)
    code = matches(candidate) ? candidate : code.slice(0, start) + ' ' + code.slice(end)
  }
  return code
}

function bindings(pattern) {
  switch (pattern.type) {
    case 'Identifier': return [pattern.name]
    case 'RestElement': return bindings(pattern.argument)
    case 'AssignmentPattern': return bindings(pattern.left)
    case 'ArrayPattern': return pattern.elements.flatMap((part) => part ? bindings(part) : [])
    case 'ObjectPattern': return pattern.properties.flatMap((part) => bindings(part.type === 'RestElement' ? part.argument : part.value))
    default: throw new Error(`Unsupported parameter: ${pattern.type}`)
  }
}

function functionName(node, parent) {
  if (node.id?.name) return node.id.name
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name
  if (parent?.type === 'Property' && !parent.method && parent.kind === 'init') {
    if (parent.key.type === 'Identifier') return parent.key.name
    if (parent.key.type === 'Literal') return String(parent.key.value)
  }
  return 'anonymous'
}

export function instrumentCode(source, captureScriptResult = false) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  ast.body = ast.body.map((node) => {
    if (node.type === 'ExportNamedDeclaration') {
      if (!node.declaration) throw new Error('Pilot does not support standalone exports.')
      return node.declaration
    }
    if (['ImportDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
      throw new Error(`Unsupported module syntax: ${node.type}`)
    }
    return node
  })

  let scriptResult = null
  if (captureScriptResult) {
    let name = '__traceScriptResult'
    while (new RegExp(`\\b${name}\\b`).test(source)) name += '_'
    for (const item of [...ast.body].reverse()) {
      if (item.type === 'ExpressionStatement' && !(item.expression.type === 'Literal' && typeof item.expression.value === 'string')) {
        item.expression = assignment(id(name), item.expression)
        scriptResult = name
        break
      }
      if (item.type === 'VariableDeclaration') {
        const candidate = [...item.declarations].reverse().find((part) =>
          part.id.type === 'Identifier' && part.id.name !== '__model' && part.init)
        if (candidate) {
          candidate.init = assignment(id(name), candidate.init)
          scriptResult = name
          break
        }
      }
    }
    if (scriptResult) ast.body.unshift({ type: 'VariableDeclaration', kind: 'let', declarations: [
      { type: 'VariableDeclarator', id: id(scriptResult), init: null },
    ] })
  }
  const top = ast.body.find((node) => node.type === 'FunctionDeclaration' ||
    node.type === 'VariableDeclaration' && node.declarations.some((part) =>
      part.id.type === 'Identifier' && ['FunctionExpression', 'ArrowFunctionExpression'].includes(part.init?.type)))
  const declaration = top?.type === 'VariableDeclaration' ? top.declarations.find((part) =>
    part.id.type === 'Identifier' && ['FunctionExpression', 'ArrowFunctionExpression'].includes(part.init?.type)) : null
  const entry = top?.type === 'FunctionDeclaration' ? top.id?.name : declaration?.id.name

  const names = new Set()
  full(ast, (node) => {
    if (node.type === 'Identifier') names.add(node.name)
    if (['WithStatement'].includes(node.type)) {
      throw new Error(`Unsupported syntax: ${node.type}`)
    }
  })
  if (names.has('__trace')) throw new Error('Instrumentation reserves __trace for its runtime.')
  let nextCallId = 0
  const uniqueCallId = () => {
    let name
    do { name = `_traceCallId${nextCallId++ || ''}` } while (names.has(name))
    names.add(name)
    return name
  }

  // Babel's passes: normalize concise arrows, wrap decisions, guard loops,
  // proxy variable initializers, instrument functions inside-out, then insert line ticks.
  full(ast, (node) => {
    if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') {
      node.body = block([{ type: 'ReturnStatement', argument: node.body }])
      node.expression = false
    }
  })
  // Capture source labels before any nested test has been instrumented.
  const originalBranchLabels = new WeakMap()
  full(ast, (node) => {
    if (['IfStatement', 'WhileStatement', 'DoWhileStatement', 'ForStatement', 'ConditionalExpression'].includes(node.type) && node.test) {
      originalBranchLabels.set(node, branchLabel(node.test))
    }
  })
  full(ast, (node) => {
    if (originalBranchLabels.has(node)) {
      node.test = call('branch', [literal(originalBranchLabels.get(node)), node.test, literal(line(node))])
    }
  })
  full(ast, (node) => {
    if (['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'].includes(node.type)) {
      if (node.body.type !== 'BlockStatement') node.body = block([node.body])
      node.body.body.unshift(statement(call('iteration', [literal(line(node))])))
    }
  })
  full(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      node.init = call('track', [literal(node.id.name), node.init, literal(line(node))])
    }
  })
  fullAncestor(ast, (node, _state, ancestors) => {
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return
    const parent = ancestors.at(-2)
    const name = functionName(node, parent)
    const at = line(node)
    const callId = uniqueCallId()
    const args = [...new Set(node.params.flatMap(bindings))]
    if (node.body.type !== 'BlockStatement') throw new Error('Expected normalized function block.')

    // Returns in nested functions have already been transformed in this postorder walk.
    // Only transform returns whose nearest function is this node.
    fullAncestor(node.body, (child, _ignored, chain) => {
      if (child.type !== 'ReturnStatement') return
      const nearest = [...chain].reverse().find((part) =>
        ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(part.type))
      if (!nearest || nearest === node) {
        child.argument = traceReturn(name, child.argument, line(child, at), callId)
      }
    })
    node.body.body.unshift(
      { type: 'VariableDeclaration', kind: 'const', declarations: [{
        type: 'VariableDeclarator', id: id(callId), init: call('call', [
          literal(name), { type: 'ObjectExpression', properties: args.map((arg) => ({
            type: 'Property', key: id(arg), value: id(arg), kind: 'init', method: false, shorthand: true, computed: false,
          })) }, literal(at),
        ]),
      }] },
      ...args.map((arg) => statement({ type: 'AssignmentExpression', operator: '=', left: id(arg),
        right: call('track', [literal(arg), id(arg), literal(at)]) })),
    )
    // A function's final implicit return reports its closing line.
    node.body.body.push({ type: 'ReturnStatement', argument: traceReturn(name, id('undefined'), node.loc?.end.line ?? at, callId) })
  })

  // Do not modify statement arrays while acorn-walk is iterating over them.
  const lists = new Set()
  fullAncestor(ast, (node, _state, ancestors) => {
    const parent = ancestors.at(-2)
    if (node.loc && node.type !== 'BlockStatement' && node.type !== 'EmptyStatement' &&
      node.type !== 'FunctionDeclaration' &&
      (node.type.endsWith('Statement') || ['VariableDeclaration', 'ClassDeclaration'].includes(node.type)) &&
      (parent?.type === 'Program' || parent?.type === 'BlockStatement' || parent?.type === 'SwitchCase')) {
      lists.add(parent.type === 'SwitchCase' ? parent.consequent : parent.body)
    }
  })
  for (const list of lists) {
    const original = [...list]
    list.splice(0, list.length, ...original.flatMap((node) =>
      node.loc && node.type !== 'BlockStatement' && node.type !== 'EmptyStatement' && node.type !== 'FunctionDeclaration'
        ? [statement(call('line', [literal(line(node))])), node] : [node]))
  }
  return { code: generate(ast), entry, scriptResult }
}
