// ESTree implementation. Public TypeScript contracts are declared in the adjacent .d.mts file.
import { parse } from 'acorn'
import { fullAncestor } from 'acorn-walk'

const models = ['array', 'dp', 'segment-tree', 'graph']
const isFunction = (node) => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node?.type)
const isDeclaration = (node) => ['FunctionDeclaration', 'VariableDeclaration', 'ClassDeclaration',
  'ImportDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration'].includes(node?.type)
const declaration = (node) => node.type === 'ExportNamedDeclaration' ? node.declaration : isDeclaration(node) ? node : null
const isString = (node) => node?.type === 'Literal' && typeof node.value === 'string'
const nameOf = (node, parent) => node.id?.name ?? (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? parent.id.name : null)

export function analyzeSource(source) {
  const comments = []
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments })
  let declaredModel = null
  const declare = (value) => {
    if (!models.includes(value)) throw new Error(`不支持 @model ${value}。可选：${models.join('、')}。`)
    if (declaredModel && declaredModel !== value) throw new Error('模型声明冲突，请只声明一种模型。')
    declaredModel = value
  }
  for (const comment of comments) {
    const marker = comment.value.match(/(?:^|\s)@model\s+([\w-]+)/)
    if (marker) declare(marker[1])
  }

  const candidates = []
  for (const statement of ast.body) {
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportDefaultDeclaration'].includes(statement.type) ||
      statement.type === 'ExportNamedDeclaration' && (!statement.declaration || statement.source)) {
      throw new Error('暂不支持模块导入或再导出；请粘贴独立可运行的 JavaScript。')
    }
    const item = declaration(statement)
    if (item?.type === 'FunctionDeclaration' && item.id) candidates.push({ name: item.id.name, parameters: item.params })
    if (item?.type === 'VariableDeclaration') {
      for (const variable of item.declarations) {
        if (variable.id.type !== 'Identifier') continue
        if (variable.id.name === '__model') {
          if (!isString(variable.init)) throw new Error('__model 必须是静态字符串。')
          declare(variable.init.value)
        }
        if (isFunction(variable.init) && variable.init.type !== 'FunctionDeclaration') {
          candidates.push({ name: variable.id.name, parameters: variable.init.params })
        }
      }
    }
  }

  const calledHelpers = new Set()
  const features = new Map()
  const featureFor = (ancestors) => {
    const key = [...ancestors].reverse().find(isFunction) ?? ast
    let value = features.get(key)
    if (!value) {
      value = { shift: new Set(), push: new Set(), adjacency: false,
        writes: new Set(), previous: new Set(), locals: new Set() }
      features.set(key, value)
    }
    return value
  }
  let segmentShape = false
  fullAncestor(ast, (node, _state, ancestors) => {
    const parent = ancestors.at(-2)
    const ancestorsWithoutSelf = ancestors.slice(0, -1)
    const feature = featureFor(ancestorsWithoutSelf)
    if (node.type === 'CallExpression') {
      const caller = [...ancestorsWithoutSelf].reverse().find(isFunction)
      if (caller && node.callee.type === 'Identifier') {
        const callerParent = ancestorsWithoutSelf[ancestorsWithoutSelf.indexOf(caller) - 1]
        const calleeName = node.callee.name
        if (calleeName !== nameOf(caller, callerParent) && candidates.some((item) => item.name === calleeName)) {
          calledHelpers.add(calleeName)
        }
      }
      const callee = node.callee
      if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' &&
        callee.property.type === 'Identifier') {
        if (callee.property.name === 'shift') feature.shift.add(callee.object.name)
        if (callee.property.name === 'push') feature.push.add(callee.object.name)
      }
      if (callee.type === 'Identifier' && ancestorsWithoutSelf.some((part) => isFunction(part) &&
        part.id?.name === callee.name && ['p', 'l', 'r'].every((param) =>
          part.params.some((arg) => arg.type === 'Identifier' && arg.name === param)))) segmentShape = true
    }
    if (node.type === 'ForOfStatement' && node.right.type === 'MemberExpression') feature.adjacency = true
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
      ['ArrayExpression', 'CallExpression'].includes(node.init?.type)) feature.locals.add(node.id.name)
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
      const left = node.left
      const root = left.object.type === 'MemberExpression' ? left.object.object : left.object
      if (root.type === 'Identifier' && left.computed) feature.writes.add(root.name)
    }
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.computed &&
      node.property.type === 'BinaryExpression' && node.property.operator === '-' &&
      node.property.right.type === 'Literal' && typeof node.property.right.value === 'number') {
      feature.previous.add(node.object.name)
    }
  })

  const entry = candidates.find((item) => item.name === 'solve') ??
    candidates.find((item) => !calledHelpers.has(item.name)) ?? candidates[0]
  const script = ast.body.some((statement) => {
    if (statement.type === 'ExpressionStatement') return !isString(statement.expression)
    const top = declaration(statement)
    if (top?.type === 'VariableDeclaration') {
      return top.declarations.some((part) => {
        const init = part.init
        const name = init?.type === 'CallExpression' && init.callee.type === 'Identifier' ? init.callee.name : null
        return name !== null && candidates.some((candidate) => candidate.name === name)
      })
    }
    return !isDeclaration(statement) && statement.type !== 'EmptyStatement'
  }) || (!entry && ast.body.some((statement) => {
    const item = declaration(statement)
    return item?.type === 'VariableDeclaration' && item.declarations.some((variable) =>
      variable.id.type === 'Identifier' && variable.id.name !== '__model' && Boolean(variable.init))
  }))

  const matches = new Set()
  if (segmentShape) matches.add('segment-tree')
  for (const item of features.values()) {
    if (item.adjacency && [...item.shift].some((name) => item.push.has(name))) matches.add('graph')
    if ([...item.writes].some((name) => item.previous.has(name) &&
      (item.locals.has(name) || /^(dp|memo|f)$/i.test(name)))) matches.add('dp')
  }
  const structure = matches.size === 1 ? [...matches][0] : null
  const reason = structure === 'segment-tree' ? '递归函数具有 p/l/r 区间参数' :
    structure === 'graph' ? '邻接表遍历与队列出入队' :
    structure === 'dp' ? '状态表写入依赖前序索引' : ''
  return {
    entry: script ? null : entry?.name ?? null,
    parameters: entry?.parameters.map((param) =>
      param.type === 'Identifier' ? param.name : param.type === 'AssignmentPattern' && param.left.type === 'Identifier' ? param.left.name : '') ?? [],
    requiredParameters: entry?.parameters.filter((param) => !['AssignmentPattern', 'RestElement'].includes(param.type)).length ?? 0,
    script, declaredModel, structure, reason,
  }
}

export function argumentsFor(analysis, input) {
  if (analysis.script || !analysis.entry || analysis.parameters.length === 0) return []
  if (analysis.parameters.length === 1) return [input]
  if (Array.isArray(input)) {
    if (input.length < analysis.requiredParameters || input.length > analysis.parameters.length) {
      throw new Error(`函数 ${analysis.entry}() 需要 ${analysis.requiredParameters}～${analysis.parameters.length} 个参数；当前提供了 ${input.length} 个。`)
    }
    return analysis.parameters.map((_, index) => input[index])
  }
  if (input && typeof input === 'object') {
    const record = input
    if (analysis.parameters.every((name, index) => name &&
      (index >= analysis.requiredParameters || Object.hasOwn(record, name)))) {
      return analysis.parameters.map((name) => record[name])
    }
  }
  throw new Error(`函数 ${analysis.entry}() 有 ${analysis.parameters.length} 个参数；请输入按顺序排列的数组，或以参数名为键的对象。`)
}
