import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CodePanel } from '../components/CodePanel'
import { DpScene } from '../components/DpScene'
import { GraphScene } from '../components/GraphScene'
import { VisualizationStage } from '../components/VisualizationStage'
import { Controls } from '../components/Controls'
import { EventInspector } from '../components/EventInspector'
import { selectDpTarget } from '../trace/selectDp'
import { instrumentCode } from '../instrumentation/instrument'
import { parseInput } from '../parseInput'
import { createTraceRuntime } from '../runtime/traceRuntime'
import { runCode } from '../runtime/runCode'
import { analyzeSource, argumentsFor } from '../sourceAnalysis'
import { decideModel } from '../trace/detectModel'
import { compileTrace, createTraceCursor, keyFrameIndices } from '../trace/compileTrace'
import { playbackDelay } from '../trace/playback'
import { examples } from '../examples'
import { readShareHash, shareUrl } from '../share'
import type { RuntimeEvent } from '../types'

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
  it('compiles the real bubble-sort example into shorter, correctly paced playback', () => {
    const example = examples.find((item) => item.id === 'bubble-sort')!
    const run = runSnippet(example.code, example.input)
    const steps = compileTrace(run.events)
    expect(run.result).toEqual([1, 2, 3, 5, 6, 7])
    expect(steps.length).toBeLessThan(run.events.length)
    const keyIndices = keyFrameIndices(run.events)
    expect(keyIndices.length).toBeLessThan(steps.length)
    expect(keyIndices.filter((index) => run.events[index].type === 'write')).toHaveLength(
      run.events.filter((event) => event.type === 'write').length,
    )
    expect(steps.at(-1)?.snapshot.tracked.arr).toEqual(run.result)
    expect(steps.some((step) => step.kind === 'minor')).toBe(true)
    const playbackMs = steps.slice(1).reduce((total, step) => total + playbackDelay(step.kind, steps.length, 1), 0)
    expect(playbackMs).toBeLessThan((run.events.length - 1) * 680 * 0.7)
  })

  it('keeps the traced line in a dedicated code pane alongside the model', () => {
    const props = {
      code: 'const x = 1;\nreturn x;', input: '1', currentLine: 2,
      currentEvent: { seq: 0, type: 'line' as const, line: 2 }, error: null,
      onCodeChange: () => {}, onInputChange: () => {}, onModeChange: () => {},
    }
    const trace = renderToStaticMarkup(createElement(CodePanel, { ...props, mode: 'trace' }))
    expect(trace).toContain('code-panel panel-shell tracing')
    expect(trace).toContain('逐行执行代码')
    expect(trace).toContain('return x;')
    expect(trace).toContain('code-line active')
    expect(renderToStaticMarkup(createElement(CodePanel, { ...props, mode: 'edit' })))
      .not.toContain('panel-shell tracing')
  })

  it('renders the mode switch and the original raw event in full playback', () => {
    const eventTrace: RuntimeEvent[] = [
      { seq: 0, type: 'line', line: 1 },
      { seq: 1, type: 'read', line: 1, target: 'arr', path: [0], value: 7 },
    ]
    const controls = renderToStaticMarkup(createElement(Controls, {
      index: 1, total: 2, playing: false, speed: 1, mode: 'all',
      onIndexChange: () => {}, onPlayingChange: () => {}, onSpeedChange: () => {}, onModeChange: () => {},
    }))
    expect(controls).toContain('关键帧')
    expect(controls).toContain('全程事件')
    expect(controls).toContain('aria-label="播放模式"')
    const inspector = renderToStaticMarkup(createElement(EventInspector, {
      step: createTraceCursor(eventTrace).at(1), rawEvent: eventTrace[1],
    }))
    expect(inspector).toContain('READ')
    expect(inspector).toContain('arr[0]')
    expect(inspector).toContain('&quot;value&quot;:7')
  })

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
    const cursor = createTraceCursor(run.events)
    const initial = renderToStaticMarkup(createElement(GraphScene, { step: cursor.at(0)! }))
    expect(initial).toContain('等待捕获邻接表')
    expect(initial).not.toContain('未找到邻接表')
    for (let index = 0; index < run.events.length; index += 1) {
      const queue = cursor.at(index)?.snapshot.tracked.queue
      if (Array.isArray(queue)) expect(new Set(queue).size).toBe(queue.length)
    }
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

  it('keeps unrecognized code as unknown until the user picks a model', () => {
    const run = runSnippet('function add(a, b) { return a + b; }', '[2, 3]')
    const decision = decideModel(run.events, run.analysis)
    expect(decision).toMatchObject({ model: 'unknown', source: 'fallback' })
    const step = compileTrace(run.events)[0]
    const stage = renderToStaticMarkup(createElement(VisualizationStage, { model: decision.model, step, running: false }))
    expect(stage).toContain('尚未识别出可视化结构')
    expect(stage).not.toContain('数组状态模型')
    expect(decideModel(run.events, run.analysis, 'graph')).toMatchObject({ model: 'graph', source: 'manual' })
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
    const responses: Array<{ ok: boolean; result?: unknown; error?: string; truncated?: string; events?: Array<{ type: string; name?: string }> }> = []
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
        args: [], maxEvents: 1_000, maxIterations: 10_000,
      } } as MessageEvent<unknown>)
      expect(responses[0]).toMatchObject({ ok: true, result: 6 })
      expect(responses[0].events?.filter((event) => event.type === 'call' && event.name === 'twice')).toHaveLength(1)

      const sort = instrumentCode('function solve(values) { for (let i = 0; i < values.length; i++) for (let j = 0; j < values.length - i - 1; j++) if (values[j] > values[j + 1]) { const t = values[j]; values[j] = values[j + 1]; values[j + 1] = t; } return values; }')
      workerScope.onmessage({ data: { code: sort.code, entry: 'solve', scriptResult: null,
        args: [Array.from({ length: 1_000 }, (_, index) => 1_000 - index)], maxEvents: 80, maxIterations: 10_000,
      } } as MessageEvent<unknown>)
      expect(responses[1]).toMatchObject({ ok: true, truncated: expect.stringContaining('80 条事件上限') })
      expect(responses[1].events?.length).toBeLessThanOrEqual(80)
      expect(responses[1].events?.at(-1)).toMatchObject({ type: 'error' })
      expect(responses[1].events?.some((event) => event.type === 'done')).toBe(false)

      workerScope.onmessage({ data: { code: sort.code, entry: 'solve', scriptResult: null,
        args: [Array.from({ length: 1_000 }, (_, index) => 1_000 - index)], maxEvents: 4_000, maxIterations: 10_000,
      } } as MessageEvent<unknown>)
      expect(responses[2].truncated).toContain('4,000 条事件上限')
      expect(responses[2].events).toHaveLength(4_000)
      const sampled = compileTrace(responses[2].events as RuntimeEvent[])
      expect(sampled.length).toBeLessThanOrEqual(400)
      expect(sampled.at(-1)?.event.type).toBe('error')

      const emptyLoop = instrumentCode('function solve() { for (;;) ; }')
      workerScope.onmessage({ data: { code: emptyLoop.code, entry: 'solve', scriptResult: null,
        args: [], maxEvents: 80, maxIterations: 5,
      } } as MessageEvent<unknown>)
      expect(responses[3]).toMatchObject({ ok: true, truncated: expect.stringContaining('5 次循环迭代上限') })
      expect(responses[3].events?.at(-1)).toMatchObject({ type: 'error' })

      const asyncSuccess = instrumentCode('async function solve(values) { const pending = Promise.resolve(5); values[0] = await pending; return values; }')
      workerScope.onmessage({ data: { code: asyncSuccess.code, entry: 'solve', scriptResult: null,
        args: [[0]], maxEvents: 100, maxIterations: 100,
      } } as MessageEvent<unknown>)
      await vi.waitFor(() => expect(responses).toHaveLength(5))
      expect(responses[4]).toMatchObject({ ok: true, result: [5] })
      expect(responses[4].events?.at(-1)).toMatchObject({ type: 'done' })

      const asyncFailure = instrumentCode('async function solve() { await Promise.resolve(); throw new Error("异步失败"); }')
      workerScope.onmessage({ data: { code: asyncFailure.code, entry: 'solve', scriptResult: null,
        args: [], maxEvents: 100, maxIterations: 100,
      } } as MessageEvent<unknown>)
      await vi.waitFor(() => expect(responses).toHaveLength(6))
      expect(responses[5]).toMatchObject({ ok: false, error: '异步失败' })
      expect(responses[5].events?.at(-1)).toMatchObject({ type: 'error' })

      const asyncLimit = instrumentCode('async function solve(values) { await Promise.resolve(); for (let i = 0; i < 20; i++) values.push(i); return values; }')
      workerScope.onmessage({ data: { code: asyncLimit.code, entry: 'solve', scriptResult: null,
        args: [[]], maxEvents: 10, maxIterations: 100,
      } } as MessageEvent<unknown>)
      await vi.waitFor(() => expect(responses).toHaveLength(7))
      expect(responses[6]).toMatchObject({ ok: true, truncated: expect.stringContaining('10 条事件上限') })
      expect(responses[6].events?.at(-1)).toMatchObject({ type: 'error' })

      const generator = instrumentCode('function solve() { const values = (function* () { yield 2; yield 3; })(); return values.next().value + values.next().value; }')
      workerScope.onmessage({ data: { code: generator.code, entry: 'solve', scriptResult: null,
        args: [], maxEvents: 100, maxIterations: 100,
      } } as MessageEvent<unknown>)
      expect(responses[7]).toMatchObject({ ok: true, result: 5 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('terminates a Worker that never settles within the execution timeout', async () => {
    let terminated = 0
    class IdleWorker {
      onmessage = null
      onerror = null
      postMessage() {}
      terminate() { terminated++ }
    }
    vi.stubGlobal('Worker', IdleWorker)
    vi.stubGlobal('window', { setTimeout })
    try {
      await expect(runCode('async function solve() { await new Promise(() => {}); }', null, { timeoutMs: 10 }))
        .rejects.toThrow(/执行超过 10ms/)
      expect(terminated).toBe(1)
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
