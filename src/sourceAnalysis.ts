import { parse } from '@babel/parser'
import traverse from '@babel/traverse'
import * as t from '@babel/types'
import type { ModelKind } from './types'

const models: ModelKind[] = ['array', 'dp', 'segment-tree', 'graph']

export interface SourceAnalysis {
  entry: string | null
  parameters: string[]
  requiredParameters: number
  script: boolean
  declaredModel: ModelKind | null
  structure: ModelKind | null
  reason: string
}

function declaration(statement: t.Statement | t.ModuleDeclaration): t.Declaration | null {
  if (t.isExportNamedDeclaration(statement)) return statement.declaration ?? null
  return t.isDeclaration(statement) ? statement : null
}

export function analyzeSource(source: string): SourceAnalysis {
  const ast = parse(source, { sourceType: 'module' })
  let declaredModel: ModelKind | null = null
  const declare = (value: string) => {
    if (!models.includes(value as ModelKind)) {
      throw new Error(`不支持 @model ${value}。可选：${models.join('、')}。`)
    }
    if (declaredModel && declaredModel !== value) throw new Error('模型声明冲突，请只声明一种模型。')
    declaredModel = value as ModelKind
  }
  for (const comment of ast.comments ?? []) {
    const marker = comment.value.match(/(?:^|\s)@model\s+([\w-]+)/)
    if (marker) declare(marker[1])
  }

  const candidates: Array<{ name: string; parameters: t.Function['params'] }> = []
  for (const statement of ast.program.body) {
    if (t.isImportDeclaration(statement) || t.isExportAllDeclaration(statement) ||
      t.isExportDefaultDeclaration(statement) ||
      (t.isExportNamedDeclaration(statement) && (!statement.declaration || statement.source))) {
      throw new Error('暂不支持模块导入或再导出；请粘贴独立可运行的 JavaScript。')
    }
    const item = declaration(statement)
    if (t.isFunctionDeclaration(item) && item.id) {
      candidates.push({ name: item.id.name, parameters: item.params })
    }
    if (t.isVariableDeclaration(item)) {
      for (const variable of item.declarations) {
        if (!t.isIdentifier(variable.id)) continue
        if (variable.id.name === '__model') {
          if (!t.isStringLiteral(variable.init)) throw new Error('__model 必须是静态字符串。')
          declare(variable.init.value)
        }
        if (t.isFunctionExpression(variable.init) || t.isArrowFunctionExpression(variable.init)) {
          candidates.push({ name: variable.id.name, parameters: variable.init.params })
        }
      }
    }
  }
  const calledHelpers = new Set<string>()
  traverse(ast, {
    CallExpression(path) {
      if (!path.getFunctionParent() || !t.isIdentifier(path.node.callee)) return
      const functionPath = path.getFunctionParent()!
      const caller = functionPath.node
      const parent = functionPath.parentPath
      const self = t.isFunctionDeclaration(caller) || t.isFunctionExpression(caller) ? caller.id?.name :
        parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id) ? parent.node.id.name : null
      const calleeName = path.node.callee.name
      if (calleeName !== self && candidates.some((item) => item.name === calleeName)) {
        calledHelpers.add(calleeName)
      }
    },
  })
  const entry = candidates.find((item) => item.name === 'solve') ??
    candidates.find((item) => !calledHelpers.has(item.name)) ?? candidates[0]
  // A top-level call of a defined function means the pasted script already invokes it.
  const script = ast.program.body.some((statement) => {
    if (t.isExpressionStatement(statement)) return !t.isStringLiteral(statement.expression)
    const topDeclaration = declaration(statement)
    if (t.isVariableDeclaration(topDeclaration)) {
      return topDeclaration.declarations.some((item) => {
        const init = item.init
        const callName = t.isCallExpression(init) && t.isIdentifier(init.callee) ? init.callee.name : null
        return callName !== null && candidates.some((candidate) => candidate.name === callName)
      })
    }
    return !t.isDeclaration(statement) && !t.isExportNamedDeclaration(statement) && !t.isEmptyStatement(statement)
  }) || (!entry && ast.program.body.some((statement) => {
    const item = declaration(statement)
    return t.isVariableDeclaration(item) && item.declarations.some((variable) =>
      t.isIdentifier(variable.id) && variable.id.name !== '__model' && Boolean(variable.init))
  }))

  const features = new Map<t.Node, {
    shift: Set<string>; push: Set<string>; adjacency: boolean
    writes: Set<string>; previous: Set<string>; locals: Set<string>
  }>()
  const featureFor = (path: { getFunctionParent(): { node: t.Node } | null }) => {
    const key = path.getFunctionParent()?.node ?? ast.program
    let feature = features.get(key)
    if (!feature) {
      feature = { shift: new Set(), push: new Set(), adjacency: false,
        writes: new Set(), previous: new Set(), locals: new Set() }
      features.set(key, feature)
    }
    return feature
  }
  let segmentShape = false
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property)) return
      if (!t.isIdentifier(callee.object)) return
      if (callee.property.name === 'shift') featureFor(path).shift.add(callee.object.name)
      if (callee.property.name === 'push') featureFor(path).push.add(callee.object.name)
    },
    ForOfStatement(path) {
      if (t.isMemberExpression(path.node.right)) featureFor(path).adjacency = true
    },
    VariableDeclarator(path) {
      if (t.isIdentifier(path.node.id) && path.node.init &&
        (t.isArrayExpression(path.node.init) || t.isCallExpression(path.node.init))) {
        featureFor(path).locals.add(path.node.id.name)
      }
    },
    Function(path) {
      const node = path.node
      const name = t.isFunctionDeclaration(node) || t.isFunctionExpression(node) ? node.id?.name : null
      if (!name || !['p', 'l', 'r'].every((param) => node.params.some((item) => t.isIdentifier(item, { name: param })))) return
      path.traverse({ CallExpression(inner) {
        if (t.isIdentifier(inner.node.callee, { name })) segmentShape = true
      } })
    },
    AssignmentExpression(path) {
      const left = path.node.left
      if (!t.isMemberExpression(left)) return
      const root = t.isMemberExpression(left.object) ? left.object.object : left.object
      if (t.isIdentifier(root) && left.computed) featureFor(path).writes.add(root.name)
    },
    MemberExpression(path) {
      const node = path.node
      if (!t.isIdentifier(node.object) || !node.computed) return
      if (t.isBinaryExpression(node.property, { operator: '-' }) && t.isNumericLiteral(node.property.right)) {
        featureFor(path).previous.add(node.object.name)
      }
    },
  })

  const matches = new Set<ModelKind>()
  if (segmentShape) matches.add('segment-tree')
  for (const feature of features.values()) {
    if (feature.adjacency && [...feature.shift].some((name) => feature.push.has(name))) matches.add('graph')
    if ([...feature.writes].some((name) => feature.previous.has(name) &&
      (feature.locals.has(name) || /^(dp|memo|f)$/i.test(name)))) matches.add('dp')
  }
  // Multiple incompatible patterns are ambiguous; let the user correct the
  // lower-confidence trace fallback rather than pretending to know the model.
  const structure = matches.size === 1 ? [...matches][0] : null
  const reason = structure === 'segment-tree' ? '递归函数具有 p/l/r 区间参数' :
    structure === 'graph' ? '邻接表遍历与队列出入队' :
    structure === 'dp' ? '状态表写入依赖前序索引' : ''

  return {
    entry: script ? null : entry?.name ?? null,
    parameters: entry?.parameters.map((param) =>
      t.isIdentifier(param) ? param.name : t.isAssignmentPattern(param) && t.isIdentifier(param.left) ? param.left.name : '',
    ) ?? [],
    requiredParameters: entry?.parameters.filter((param) => !t.isAssignmentPattern(param) && !t.isRestElement(param)).length ?? 0,
    script,
    declaredModel,
    structure,
    reason,
  }
}

export function argumentsFor(analysis: SourceAnalysis, input: unknown): unknown[] {
  if (analysis.script || !analysis.entry || analysis.parameters.length === 0) return []
  if (analysis.parameters.length === 1) return [input]
  if (Array.isArray(input)) {
    if (input.length < analysis.requiredParameters || input.length > analysis.parameters.length) {
      throw new Error(`函数 ${analysis.entry}() 需要 ${analysis.requiredParameters}～${analysis.parameters.length} 个参数；当前提供了 ${input.length} 个。`)
    }
    return analysis.parameters.map((_, index) => input[index])
  }
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    if (analysis.parameters.every((name, index) => name &&
      (index >= analysis.requiredParameters || Object.hasOwn(record, name)))) {
      return analysis.parameters.map((name) => record[name])
    }
  }
  throw new Error(`函数 ${analysis.entry}() 有 ${analysis.parameters.length} 个参数；请输入按顺序排列的数组，或以参数名为键的对象。`)
}

