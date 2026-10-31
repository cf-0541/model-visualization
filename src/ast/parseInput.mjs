// ESTree implementation. Public TypeScript contracts are declared in the adjacent .d.mts file.
import { parse } from 'acorn'

function literal(node) {
  if (node.type === 'Literal') {
    if (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value)) return node.value
  }
  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return undefined
    throw new Error('输入仅支持字面量，不能使用变量名。')
  }
  if (node.type === 'UnaryExpression' && ['-', '+'].includes(node.operator) &&
    node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
    return node.operator === '-' ? -node.argument.value : node.argument.value
  }
  if (node.type === 'ArrayExpression') return node.elements.map((part) => {
    if (!part || part.type === 'SpreadElement') throw new Error('输入不支持空位或展开运算符。')
    return literal(part)
  })
  if (node.type === 'SequenceExpression') return node.expressions.map(literal)
  if (node.type === 'ObjectExpression') {
    const result = Object.create(null)
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.computed) {
        throw new Error('输入仅支持普通对象字面量。')
      }
      const key = property.key.type === 'Identifier' ? property.key.name :
        property.key.type === 'Literal' && ['string', 'number'].includes(typeof property.key.value) ? String(property.key.value) : null
      if (key === null || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new Error('输入包含不支持的对象键。')
      }
      result[key] = literal(property.value)
    }
    return result
  }
  throw new Error('输入仅支持 JSON 或 JavaScript 字面量，不执行输入中的表达式。')
}

export function parseInput(text) {
  if (!text.trim()) return undefined
  try { return JSON.parse(text) } catch { /* JS literal fallback */ }
  try {
    const ast = parse('(' + text + '\n)', { ecmaVersion: 'latest' })
    if (ast.body.length !== 1 || ast.body[0].type !== 'ExpressionStatement') throw new Error('输入含多余内容。')
    return literal(ast.body[0].expression)
  } catch (error) {
    throw new Error(`输入格式无效：${error instanceof Error ? error.message : String(error)}`)
  }
}
