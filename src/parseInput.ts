import { parseExpression } from '@babel/parser'
import * as t from '@babel/types'

// Accept JSON and common JS literal syntax without evaluating input in the UI thread.
function literal(node: t.Expression): unknown {
  if (t.isStringLiteral(node)) return node.value
  if (t.isNumericLiteral(node)) return node.value
  if (t.isBooleanLiteral(node)) return node.value
  if (t.isNullLiteral(node)) return null
  if (t.isIdentifier(node)) {
    if (node.name === 'undefined') return undefined
    throw new Error('输入仅支持字面量，不能使用变量名。')
  }
  if (t.isUnaryExpression(node) && ['-', '+'].includes(node.operator) && t.isNumericLiteral(node.argument)) {
    return node.operator === '-' ? -node.argument.value : node.argument.value
  }
  if (t.isArrayExpression(node)) {
    return node.elements.map((part) => {
      if (!part || t.isSpreadElement(part)) throw new Error('输入不支持空位或展开运算符。')
      return literal(part)
    })
  }
  if (t.isSequenceExpression(node)) return node.expressions.map(literal)
  if (t.isObjectExpression(node)) {
    const result: Record<string, unknown> = Object.create(null)
    for (const property of node.properties) {
      if (!t.isObjectProperty(property) || property.computed || !t.isExpression(property.value)) {
        throw new Error('输入仅支持普通对象字面量。')
      }
      const key = t.isIdentifier(property.key) ? property.key.name :
        t.isStringLiteral(property.key) || t.isNumericLiteral(property.key) ? String(property.key.value) : null
      if (key === null || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new Error('输入包含不支持的对象键。')
      }
      result[key] = literal(property.value)
    }
    return result
  }
  throw new Error('输入仅支持 JSON 或 JavaScript 字面量，不执行输入中的表达式。')
}

export function parseInput(text: string): unknown {
  if (!text.trim()) return undefined
  try { return JSON.parse(text) } catch { /* JS literal fallback */ }
  try { return literal(parseExpression(text)) }
  catch (error) {
    throw new Error(`输入格式无效：${error instanceof Error ? error.message : String(error)}`)
  }
}
