import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importCppTrace, MAX_CPP_REPORT_BYTES } from '../trace/importCppTrace'
import { compileTrace, createTraceCursor, keyFrameIndices } from '../trace/compileTrace'
import { decideModel } from '../trace/detectModel'
import type { ArrayPatch } from '../types'

const read = (name = 'bubble') => JSON.parse(readFileSync(new URL(`../examples/cpp/${name}.json`, import.meta.url), 'utf8'))
const load = (name = 'bubble') => importCppTrace(JSON.stringify(read(name)))

describe('C++ sampled report → existing animation replay', () => {
  for (const [name, expected, model] of [
    ['bubble', { numbers: [1, 3, 5, 7] }, 'array'],
    ['grid', { dp: [[1, 1, 1], [1, 2, 3], [1, 3, 6]] }, 'dp'],
    ['recursion', { answer: 120 }, 'unknown'],
    ['vector', { numbers: [2, 1, 3] }, 'array'],
  ] as const) {
    it(`replays real generated ${name} report and supports backward seeking`, () => {
      const imported = load(name)
      const { events, analysis } = imported.result
      expect(imported.status).toBe('complete')
      expect(analysis.structure).toBeNull() // Never JS-parse C++ or claim inferred structure.
      expect(decideModel(events, analysis).model).toBe(model)
      const cursor = createTraceCursor(events)
      const frames = compileTrace(events)
      expect(frames.at(-1)!.snapshot.tracked).toEqual(expected)
      expect(frames.at(-1)!.snapshot.callStack).toEqual([])
      // Different access orders must reproduce every frame, without mutating events.
      const before = JSON.stringify(events)
      const snapshots = events.map((_, index) => cursor.at(index)!.snapshot)
      for (let index = events.length - 1; index >= 0; index--) {
        expect(cursor.at(index)!.snapshot).toEqual(snapshots[index])
      }
      expect(JSON.stringify(events)).toBe(before)
      expect(keyFrameIndices(events).at(-1)).toBe(events.length - 1)
    })
  }

  it('replays vector expansion/shrink with lazy before/after views', () => {
    const { events } = load('vector').result
    const cursor = createTraceCursor(events)
    const expand = events.findIndex(event => event.type === 'write' && event.arrayPatch?.afterLength === 4)
    expect(cursor.at(expand)!.snapshot.write).toMatchObject({ before: [2, 1, 3], value: [2, 1, 3, 5] })
    const shrink = events.findIndex(event => event.type === 'write' && event.arrayPatch?.afterLength === 3)
    expect(cursor.at(shrink)!.snapshot.write).toMatchObject({ before: [2, 1, 3, 5], value: [2, 1, 3] })
    expect(cursor.at(expand)!.snapshot.tracked.numbers).toEqual([2, 1, 3, 5])
  })

  it.each(['error', 'truncated'])('keeps partial %s report replayable without a success result', status => {
    const report = read()
    report.events = report.events.slice(0, 8)
    report.events.push({ seq: 8, line: 1, type: 'error', message: 'intentional incomplete capture' })
    report.status = status
    report.reason = 'intentional incomplete capture'
    const imported = importCppTrace(JSON.stringify(report))
    expect(imported.result.truncated).toContain(status)
    expect(imported.result.result).toBeUndefined()
    expect(compileTrace(imported.result.events).at(-1)!.event.type).toBe('error')
  })

  it('preserves captured global result and does not fabricate read/branch/return values', () => {
    const { events, result } = load('recursion').result
    expect(result).toBe(120)
    expect(events.filter(event => event.type === 'return').every(event => event.value === null)).toBe(true)
    expect(events.some(event => event.type === 'read' || event.type === 'branch')).toBe(false)
  })
})

describe('C++ import trust boundary', () => {
  const invalid = [
    ['schema', (r: ReturnType<typeof read>) => { r.schemaVersion = 2 }],
    ['capture', (r: ReturnType<typeof read>) => { r.capture = 'complete-instrumentation' }],
    ['sequence', (r: ReturnType<typeof read>) => { r.events[1].seq = 999 }],
    ['line', (r: ReturnType<typeof read>) => { r.events[1].line = 99999 }],
    ['target', (r: ReturnType<typeof read>) => { r.events[0].target = '__proto__' }],
    ['extra field', (r: ReturnType<typeof read>) => { r.events[0].extra = true }],
    ['unknown type', (r: ReturnType<typeof read>) => { r.events[1].type = 'read' }],
    ['terminal', (r: ReturnType<typeof read>) => { r.events.pop() }],
    ['wrong status', (r: ReturnType<typeof read>) => { r.status = 'truncated' }],
    ['early terminal', (r: ReturnType<typeof read>) => { r.events[1] = { seq: 1, type: 'done', line: 1, result: 0, duration: 0 } }],
    ['long array', (r: ReturnType<typeof read>) => { r.events[0].value = Array(121).fill(0) }],
    ['nested value', (r: ReturnType<typeof read>) => { r.events[0].value = [[[[0]]]] }],
    ['object value', (r: ReturnType<typeof read>) => { r.events[0].value = { constructor: { polluted: true } } }],
    ['bad duration', (r: ReturnType<typeof read>) => { r.events.at(-1).duration = -1 }],
    ['too many lines', (r: ReturnType<typeof read>) => { r.source.text = '\n'.repeat(4097) }],
    ['unbalanced call', (r: ReturnType<typeof read>) => { r.events.find((e: { type: string }) => e.type === 'call').depth = 3 }],
    ['unsafe args', (r: ReturnType<typeof read>) => { r.events.find((e: { type: string }) => e.type === 'call').args = JSON.parse('{"__proto__":1}') }],
    ['foreign target', (r: ReturnType<typeof read>) => { r.events.find((e: { type: string }) => e.type === 'write').target = 'missing' }],
    ['string path', (r: ReturnType<typeof read>) => { r.events.find((e: { type: string }) => e.type === 'write').path = ['__proto__'] }],
    ['bad before', (r: ReturnType<typeof read>) => { r.events.find((e: { type: string }) => e.type === 'write').before = 999 }],
  ] as const
  it.each(invalid)('rejects %s', (_, change) => {
    const report = read()
    change(report)
    expect(() => importCppTrace(JSON.stringify(report))).toThrow('C++ 轨迹无效')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  it.each(['duplicate', 'missing', 'out of range', 'before length', 'presence', 'before value'])('rejects malformed vector patch: %s', kind => {
    const report = read('vector')
    const patch = report.events.find((e: { arrayPatch?: unknown }) => e.arrayPatch).arrayPatch
    if (kind === 'duplicate') patch.changes.push(patch.changes[0])
    if (kind === 'missing') patch.changes = []
    if (kind === 'out of range') patch.changes[0].index = 120
    if (kind === 'before length') patch.beforeLength = 99
    if (kind === 'presence') patch.changes[0].beforePresent = true
    if (kind === 'before value') patch.changes.unshift({ index: 0, beforePresent: true, afterPresent: true, before: 99, after: 2 })
    expect(() => importCppTrace(JSON.stringify(report))).toThrow('C++ 轨迹无效')
  })
  it('identifies the offending event and the accepted protocol version', () => {
    const report = read()
    report.events[1].seq = 12345
    expect(() => importCppTrace(JSON.stringify(report))).toThrow(/第 2 条事件（seq=1）.*序号不连续/)
    report.schemaVersion = 2
    expect(() => importCppTrace(JSON.stringify(report))).toThrow(/协议版本.*schemaVersion=1/)
  })
  it('bounds bytes before parsing and rejects malformed JSON', () => {
    expect(() => importCppTrace('x'.repeat(MAX_CPP_REPORT_BYTES + 1))).toThrow('8 MiB')
    expect(() => importCppTrace('[]')).toThrow('C++ 轨迹无效')
    expect(() => importCppTrace('{')).toThrow('不是 JSON')
  })
})

describe('C++ patch import budgets', () => {
  const reportFor = (
    value: unknown,
    patches: Array<{ path: number[]; arrayPatch: ArrayPatch }>,
    result: unknown = { exitCode: 0 },
  ) => ({
    schemaVersion: 1, language: 'cpp', capture: 'debugger-line-sampling',
    status: 'complete', reason: null,
    source: { name: 'patch.cpp', text: 'int main() { return 0; }' },
    steps: patches.length, limits: { maxSteps: 5000, maxEvents: 10000 },
    events: [
      { seq: 0, line: 0, type: 'track', target: 'numbers', value },
      ...patches.map((patch, index) => ({ seq: index + 1, line: 1, type: 'write', target: 'numbers', ...patch })),
      { seq: patches.length + 1, line: 1, type: 'done', result, duration: 0 },
    ],
  })

  it.each([1625, 1626, 5000])('imports and seeks through %i single-element patches without recharging unchanged values', count => {
    const initial = Array(120).fill(0)
    const report = reportFor(initial, Array.from({ length: count }, (_, index) => ({
      path: [],
      arrayPatch: {
        beforeLength: 120, afterLength: 120,
        changes: [{ index: 0, beforePresent: true, afterPresent: true, before: index % 2, after: 1 - index % 2 }],
      },
    })))
    const json = JSON.stringify(report)
    expect(new TextEncoder().encode(json).length).toBeLessThan(MAX_CPP_REPORT_BYTES)
    const imported = importCppTrace(json)
    expect(imported.status).toBe('complete')
    expect(imported.result.events).toHaveLength(count + 2)
    const eventsBeforeReplay = JSON.stringify(imported.result.events)
    const cursor = createTraceCursor(imported.result.events)
    const expected = [count % 2, ...initial.slice(1)]
    expect(cursor.at(count + 1)!.snapshot.tracked.numbers).toEqual(expected)
    expect(cursor.at(0)!.snapshot.tracked.numbers).toEqual(initial)
    expect(cursor.at(count + 1)!.snapshot.tracked.numbers).toEqual(expected)
    expect(JSON.stringify(imported.result.events)).toBe(eventsBeforeReplay)
  })

  it.each([200000, 200001])('enforces the cumulative input-value budget at %i nodes', nodes => {
    // Each matrix has 1 + 9 * (1 + 110) = 1000 nodes. The tracked
    // wrapper contributes 1001; 99 before/after pairs contribute 198000.
    const matrix = Array.from({ length: 9 }, () => Array(110).fill(0))
    const result = structuredClone(matrix)
    if (nodes === 200000) result[0].pop() // Terminal value: 999 rather than 1000 nodes.
    const report = reportFor([matrix], Array.from({ length: 99 }, () => ({
      path: [],
      arrayPatch: {
        beforeLength: 1, afterLength: 1,
        changes: [{ index: 0, beforePresent: true, afterPresent: true, before: matrix, after: matrix }],
      },
    })), result)
    const json = JSON.stringify(report)
    expect(new TextEncoder().encode(json).length).toBeLessThan(MAX_CPP_REPORT_BYTES)
    if (nodes === 200000) expect(importCppTrace(json).result.result).toEqual(result)
    else expect(() => importCppTrace(json)).toThrow(/seq=100.*累计快照超过导入预算/)
  })

  it.each([1024, 1025])('revalidates the reconstructed snapshot at %i nodes', nodes => {
    // Initially 1 + 8 * 121 + 54 = 1023 nodes; each added scalar costs one.
    const initial = [...Array.from({ length: 8 }, () => Array(120).fill(0)), Array(53).fill(0)]
    const report = reportFor(initial, [{
      path: [8],
      arrayPatch: {
        beforeLength: 53, afterLength: 53 + nodes - 1023,
        changes: Array.from({ length: nodes - 1023 }, (_, index) => ({
          index: 53 + index, beforePresent: false, afterPresent: true, before: null, after: 0,
        })),
      },
    }])
    const json = JSON.stringify(report)
    if (nodes === 1024) {
      const cursor = createTraceCursor(importCppTrace(json).result.events)
      expect(cursor.at(2)!.snapshot.tracked.numbers).toEqual([...initial.slice(0, 8), Array(54).fill(0)])
    } else expect(() => importCppTrace(json)).toThrow(/seq=1.*值超出快照预算/)
  })

  it.each([3, 4])('revalidates reconstructed nesting at depth %i', depth => {
    const initial = depth === 3 ? [[0]] : [[[0]]]
    const report = reportFor(initial, [{
      path: depth === 3 ? [0] : [0, 0],
      arrayPatch: {
        beforeLength: 1, afterLength: 1,
        changes: [{ index: 0, beforePresent: true, afterPresent: true, before: 0, after: [1] }],
      },
    }])
    const json = JSON.stringify(report)
    if (depth === 3) {
      const cursor = createTraceCursor(importCppTrace(json).result.events)
      expect(cursor.at(2)!.snapshot.tracked.numbers).toEqual([[[1]]])
    } else expect(() => importCppTrace(json)).toThrow(/seq=1.*值超出快照预算/)
  })

  it('still rejects oversized array values supplied by a patch', () => {
    const report = reportFor([0], [{
      path: [],
      arrayPatch: {
        beforeLength: 1, afterLength: 1,
        changes: [{ index: 0, beforePresent: true, afterPresent: true, before: 0, after: Array(121).fill(0) }],
      },
    }])
    expect(() => importCppTrace(JSON.stringify(report))).toThrow(/seq=1.*数组超过 120 项/)
  })
})
