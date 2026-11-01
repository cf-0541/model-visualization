import { describe, expect, it } from 'vitest'
import { createTraceRuntime, TraceLimitError } from '../runtime/traceRuntime'
import { createTraceCursor } from '../trace/compileTrace'
import { instrumentCode } from '../instrumentation/instrument'
import type { TraceRuntime } from '../types'

describe('consecutive read coalescing', () => {
  it('keeps 5,000 identical reads below the event limit and completes playback', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', [7])
    trace.line(2)
    let result = 0
    for (let index = 0; index < 5_000; index += 1) result += a[0]
    trace.complete(result, 1)

    const events = trace.getEvents()
    expect(result).toBe(35_000)
    expect(events.map((event) => event.type)).toEqual(['track', 'line', 'read', 'done'])
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3])
    const final = createTraceCursor(events).at(events.length - 1)
    expect(final?.snapshot.result).toBe(35_000)
    expect(final?.snapshot.reads).toEqual([{ target: 'a', path: [0], value: 7 }])
  })

  it('retains the latest value without consuming a new sequence number', () => {
    const trace = createTraceRuntime()
    const raw = [1]
    const a = trace.track('a', raw)
    expect(a[0]).toBe(1)
    raw[0] = 9 // An unproxied alias can change the next observed value.
    expect(a[0]).toBe(9)
    expect(trace.getEvents()).toHaveLength(2)
    expect(trace.getEvents()[1]).toMatchObject({ type: 'read', seq: 1, value: 9 })
  })

  it('allows coalescing at capacity but rejects new reads and writes before mutation', () => {
    const trace = createTraceRuntime(2)
    const raw = [1, 2]
    const a = trace.track('a', raw)
    expect(a[0]).toBe(1)
    expect(() => a[0]).not.toThrow()
    expect(() => a[1]).toThrow(TraceLimitError)
    expect(() => { a[0] = 8 }).toThrow(TraceLimitError)
    expect(raw).toEqual([1, 2])
    expect(() => trace.complete(1, 1)).toThrow(TraceLimitError)
    trace.truncate('limit')
    expect(trace.getEvents().map((event) => event.type)).toEqual(['track', 'error'])
  })

  it('does not merge different paths or targets, including alternating reads', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', [1, 2])
    const b = trace.track('b', [3])
    void a[0]; void a[1]; void a[0]; void b[0]
    expect(trace.getEvents().filter((event) => event.type === 'read')
      .map(({ target, path }) => [target, path])).toEqual([
      ['a', [0]], ['a', [1]], ['a', [0]], ['b', [0]],
    ])
  })

  it('compares complete path components rather than joined strings', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', { 'x.y': 1, x: { y: 2 } })
    void a['x.y']; void a.x.y
    expect(trace.getEvents().filter((event) => event.type === 'read')
      .map(({ path }) => path)).toEqual([['x.y'], ['x', 'y']])
  })

  it('does not merge reads whose line changed without emitting a line event', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', [1])
    void a[0]
    trace.iteration(2)
    void a[0]
    expect(trace.getEvents().filter((event) => event.type === 'read')
      .map(({ line }) => line)).toEqual([1, 2])
  })

  const barriers: Array<[string, (trace: TraceRuntime) => void]> = [
    ['line', (trace) => trace.line(1)],
    ['branch', (trace) => { trace.branch('true', true, 1) }],
    ['call', (trace) => { trace.call('f', {}, 1) }],
    ['return', (trace) => { trace.ret('f', 1, 1, 1) }],
    ['track', (trace) => { trace.track('b', [2]) }],
    ['error', (trace) => trace.fail('test')],
  ]
  it.each(barriers)('does not coalesce across a %s event', (_, barrier) => {
    const trace = createTraceRuntime()
    const a = trace.track('a', [1])
    void a[0]
    barrier(trace)
    void a[0]
    expect(trace.getEvents().filter((event) => event.type === 'read')).toHaveLength(2)
  })

  it('preserves read/write/read ordering and write dependencies in playback', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', [1])
    void a[0]; void a[0]
    a[0] = 2
    void a[0]; void a[0]
    trace.complete(2, 1)
    const events = trace.getEvents()
    expect(events.map((event) => event.type)).toEqual(['track', 'read', 'write', 'read', 'done'])
    const cursor = createTraceCursor(events)
    expect(cursor.at(2)?.snapshot.reads).toEqual([{ target: 'a', path: [0], value: 1 }])
    expect(cursor.at(4)?.snapshot.tracked.a).toEqual([2])
    expect(cursor.at(4)?.snapshot.reads).toEqual([{ target: 'a', path: [0], value: 2 }])
  })

  it('still enforces the iteration limit when repeated reads coalesce', () => {
    const trace = createTraceRuntime(10, 3)
    const a = trace.track('a', [1])
    for (let index = 0; index < 3; index += 1) {
      trace.iteration(1)
      void a[0]
    }
    expect(trace.getEvents()).toHaveLength(2)
    expect(() => trace.iteration(1)).toThrow(/循环迭代上限/)
  })

  it('finishes an instrumented loop whose redundant reads previously filled the trace', () => {
    const { code } = instrumentCode(`function solve(input) {
      const a = input;
      let sum = 0;
      for (let i = 0; i < 600; i++) {
        sum += a[0] + a[0] + a[0] + a[0] + a[0] + a[0];
      }
      return sum;
    }`)
    const trace = createTraceRuntime()
    const run = new Function('__trace', '__input', code + '; return solve(__input);')
    const result = run(trace, [1])
    trace.complete(result, 1)
    expect(result).toBe(3_600)
    expect(trace.getEvents().filter((event) => event.type === 'read')).toHaveLength(600)
    expect(trace.getEvents().at(-1)?.type).toBe('done')
    expect(trace.getEvents().length).toBeLessThan(4_000)
  })
})
