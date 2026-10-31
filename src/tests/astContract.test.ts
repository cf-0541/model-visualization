import { describe, expect, it } from 'vitest'
import { instrumentCode } from '../instrumentation/instrument'
import { parseInput } from '../parseInput'
import { analyzeSource, argumentsFor } from '../sourceAnalysis'
import { createTraceRuntime } from '../runtime/traceRuntime'

describe('integrated AST public contract', () => {
  it('keeps repeated compilations independent and avoids script-result name collisions', () => {
    const source = 'const __traceScriptResult = 2; __traceScriptResult + 1;'
    const first = instrumentCode(source, true)
    instrumentCode('function another(x) { return x > 0 ? x : 0; }')
    expect(instrumentCode(source, true)).toEqual(first)
    expect(first.scriptResult).not.toBe('__traceScriptResult')
    const execute = new Function('__trace', `${first.code}; return ${first.scriptResult};`)
    expect(execute(createTraceRuntime())).toBe(3)
  })

  it('preserves named model declarations and named multi-parameter input', () => {
    const source = "export const __model = 'graph'; function bfs(adj, start) { return adj[start]; }"
    const analysis = analyzeSource(source)
    expect(analysis.declaredModel).toBe('graph')
    expect(analysis.entry).toBe('bfs')
    expect(argumentsFor(analysis, parseInput('{adj: [[1], [0]], start: 0}'))).toEqual([[[1], [0]], 0])
    expect(() => new Function('__trace', instrumentCode(source).code)).not.toThrow()
  })

  it.each([
    'import x from "external"; function solve() { return x; }',
    'export default function solve() { return 1; }',
    'export { solve }; function solve() { return 1; }',
    'export * from "external";',
    'function solve(x: number) { return x; }',
    'function solve() { return <div/>; }',
  ])('rejects source outside the paste contract: %s', source => {
    expect(() => instrumentCode(source)).toThrow()
  })

  it('rejects input expressions without evaluating them', () => {
    const marker = '__astInputWasEvaluated'
    expect(marker in globalThis).toBe(false)
    expect(() => parseInput(`({value: (globalThis.${marker} = true)})`)).toThrow()
    expect(marker in globalThis).toBe(false)
  })

  it('returns cloneable literal data and rejects accessor input', () => {
    expect(structuredClone(parseInput("{value: [undefined, -2, 'x'],}"))).toEqual({ value: [undefined, -2, 'x'] })
    expect(() => parseInput('{get value() { return 1; }}')).toThrow()
  })
})
