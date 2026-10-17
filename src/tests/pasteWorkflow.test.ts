import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DpScene } from '../components/DpScene'
import { selectDpTarget } from '../trace/selectDp'
import { instrumentCode } from '../instrumentation/instrument'
import { parseInput } from '../parseInput'
import { createTraceRuntime } from '../runtime/traceRuntime'
import { analyzeSource, argumentsFor } from '../sourceAnalysis'
import { decideModel } from '../trace/detectModel'
import { compileTrace } from '../trace/compileTrace'
import { examples } from '../examples'
import { readShareHash, shareUrl } from '../share'

function runSnippet(source: string, input: string) {
  const analysis = analyzeSource(source)
  const { code, scriptResult } = instrumentCode(source, analysis.script)
  const trace = createTraceRuntime()
  const args = argumentsFor(analysis, parseInput(input))
  const entry = analysis.entry
  const execute = new Function('__trace', '__args', `"use strict"; ${code}; ${entry ? `return ${entry}(...__args);` : `return ${scriptResult ?? 'undefined'};`}`)
  const result: unknown = execute(trace, args)
  trace.complete(result, 1)
  return { analysis, result, events: trace.getEvents() }
}

describe('paste-and-run workflow', () => {
  it('uses explicit model declarations without requiring module execution', () => {
    const source = `export const __model = 'graph';\nfunction bfs(adj, start) { return adj[start]; }`
    const run = runSnippet(source, '[[[1], [0]], 0]')
    expect(run.result).toEqual([1])
    expect(decideModel(run.events, run.analysis).model).toBe('graph')
    expect(decideModel(run.events, run.analysis).source).toBe('declared')
    expect(decideModel(run.events, run.analysis, 'array').model).toBe('array')
  })

  it('understands comment declarations and rejects unknown models', () => {
    expect(analyzeSource('// @model graph\nfunction walk(g) { return g; }').declaredModel).toBe('graph')
    expect(() => analyzeSource('// @model not-a-model\nfunction walk(g) { return g; }')).toThrow(/不支持/)
  })

  it('detects BFS structurally and maps positional arguments in order', () => {
    const example = examples.find((item) => item.id === 'bfs')!
    const run = runSnippet(example.code, example.input)
    expect(run.result).toEqual([0, 1, 2, 3])
    expect(run.analysis.entry).toBe('bfs')
    expect(decideModel(run.events, run.analysis)).toMatchObject({ model: 'graph', source: 'structure' })
    const last = compileTrace(run.events).at(-1)!
    expect(last.snapshot.tracked.queue).toEqual([])
    expect(last.snapshot.tracked.seen).toEqual([true, true, true, true])
  })

  it('detects a renamed DP table from indexed dependencies', () => {
    const source = `function fib(n) {
      const states = Array(n + 1).fill(0);
      states[0] = 0; states[1] = 1;
      for (let i = 2; i <= n; i++) states[i] = states[i - 1] + states[i - 2];
      return states[n];
    }`
    const run = runSnippet(source, '6')
    expect(run.result).toBe(8)
    expect(decideModel(run.events, run.analysis)).toMatchObject({ model: 'dp', source: 'structure' })
    const steps = compileTrace(run.events)
    expect(selectDpTarget(steps)).toBe('states')
    const written = steps.find((step) => step.event.type === 'write' && step.event.target === 'states' &&
      step.event.path[0] === 6)!
    expect(renderToStaticMarkup(createElement(DpScene, { step: written, targetHint: selectDpTarget(steps) })))
      .toContain('states 动态规划状态转移图')
  })

  it('keeps a renamed DP table selected when an input array is also tracked', () => {
    const source = `function calculate(nums) {
      const states = Array(nums.length).fill(0);
      states[0] = nums[0];
      for (let i = 1; i < nums.length; i++) states[i] = states[i - 1] + nums[i];
      return states[nums.length - 1];
    }`
    const run = runSnippet(source, '[2, 3, 4]')
    const steps = compileTrace(run.events)
    expect(selectDpTarget(steps)).toBe('states')
    const last = steps.at(-1)!
    expect(renderToStaticMarkup(createElement(DpScene, { step: last, targetHint: selectDpTarget(steps) })))
      .toContain('states 动态规划状态转移图')
  })

  it('does not call the first function a second time for complete scripts', () => {
    const source = `function total(items) { return items[0] + items[1]; }\nconst values = [2, 4];\ntotal(values);`
    const run = runSnippet(source, '')
    expect(run.analysis.script).toBe(true)
    expect(run.events.filter((event) => event.type === 'call' && event.name === 'total')).toHaveLength(1)
    expect(run.result).toBe(6)
  })

  it('captures a top-level call assignment and supports scripts with no named function', () => {
    const source = `function total(a, b) { return a + b; }\nconst answer = total(2, 4);`
    const run = runSnippet(source, '')
    expect(run.result).toBe(6)
    expect(run.events.filter((event) => event.type === 'call' && event.name === 'total')).toHaveLength(1)
    expect(runSnippet('const answer = [2, 4].reduce((a, b) => a + b);', '').result).toBe(6)
    expect(runSnippet('const __traceScriptResult = 1;\nfunction foo() { return 7; }\nfoo();', '').result).toBe(7)
    const exported = runSnippet('function foo() { return 7; }\nexport const answer = foo();', '')
    expect(exported.analysis.script).toBe(true)
    expect(exported.result).toBe(7)
    expect(exported.events.filter((event) => event.type === 'call' && event.name === 'foo')).toHaveLength(1)
  })

  it('prefers the calling function over an earlier helper and avoids weak structure guesses', () => {
    const source = `function plus(a) { return a + 1; }\nfunction calculate(n) { return plus(n); }`
    expect(runSnippet(source, '3').result).toBe(4)
    expect(analyzeSource(source).entry).toBe('calculate')
    expect(analyzeSource('function paint(matrix) { matrix[0][0] = 1; }').structure).toBeNull()
    const paint = runSnippet('function paint(matrix) { matrix[0][0] = 1; return matrix; }', '[[0]]')
    expect(decideModel(paint.events, paint.analysis).model).toBe('array')
    expect(analyzeSource('function shift(q) { q.shift(); }\nfunction other(adj, q) { for (const n of adj[0]) q.push(n); }').structure).toBeNull()
    expect(analyzeSource('function rotate(arr) { arr[1] = arr[0]; arr[2] = arr[1]; }').structure).toBeNull()
  })

  it('supports LeetCode-style variable functions and named argument objects', () => {
    const example = examples.find((item) => item.id === 'two-sum')!
    expect(runSnippet(example.code, example.input).result).toEqual([0, 1])
    const analysis = analyzeSource('const add = (a, b) => a + b;')
    expect(argumentsFor(analysis, parseInput('{a: 2, b: 3}'))).toEqual([2, 3])
  })

  it('accepts safe JS literals but never evaluates expressions in the input', () => {
    expect(parseInput("{adj: [[1], [0]], start: 0, label: 'test'}")).toEqual({ adj: [[1], [0]], start: 0, label: 'test' })
    expect(() => parseInput('globalThis.alert(1)')).toThrow(/仅支持/)
    expect(() => parseInput('{value: secret}')).toThrow(/字面量/)
    expect(() => parseInput('1; doSomething()')).toThrow(/输入格式无效/)
    expect(() => argumentsFor(analyzeSource('function bfs(adj, start) {}'), [0])).toThrow(/需要 2/)
    expect(argumentsFor(analyzeSource('function add(a, b = 2) { return a + b; }'), [3])).toEqual([3, undefined])
  })

  it('returns the captured script result through the actual Worker handler', async () => {
    const responses: Array<{ ok: boolean; result?: unknown; events?: Array<{ type: string; name?: string }> }> = []
    const workerScope = {
      postMessage: (response: typeof responses[number]) => responses.push(response),
    } as unknown as {
      postMessage: (response: typeof responses[number]) => void
      onmessage: (event: MessageEvent<unknown>) => void
    }
    vi.stubGlobal('self', workerScope)
    try {
      await import('../runtime/runner.worker')
      const source = 'function twice(x) { return x * 2; }\ntwice(3);'
      const transformed = instrumentCode(source, true)
      workerScope.onmessage({ data: {
        code: transformed.code, entry: null, scriptResult: transformed.scriptResult,
        args: [], maxEvents: 1_000,
      } } as MessageEvent<unknown>)
      expect(responses[0]).toMatchObject({ ok: true, result: 6 })
      expect(responses[0].events?.filter((event) => event.type === 'call' && event.name === 'twice')).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('round-trips a Unicode share link without executing the code', () => {
    const project = { code: '// 中文\nfunction demo(x) { return x; }', input: "{value: '喵'}", model: 'graph' as const }
    const url = shareUrl(project, 'https://example.org/app?ignored=1')
    expect(readShareHash(new URL(url).hash)).toEqual(project)
    expect(readShareHash('#share=malformed')).toBeNull()
  })
})
