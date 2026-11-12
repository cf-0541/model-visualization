import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importCppTrace, MAX_CPP_REPORT_BYTES } from '../trace/importCppTrace'
import { compileTrace, createTraceCursor, keyFrameIndices } from '../trace/compileTrace'
import { decideModel } from '../trace/detectModel'

const read = (name = 'bubble') => JSON.parse(readFileSync(new URL(`../../experiments/cpp/samples/${name}.json`, import.meta.url), 'utf8'))
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
  it('bounds bytes before parsing and rejects malformed JSON', () => {
    expect(() => importCppTrace('x'.repeat(MAX_CPP_REPORT_BYTES + 1))).toThrow('8 MiB')
    expect(() => importCppTrace('[]')).toThrow('C++ 轨迹无效')
    expect(() => importCppTrace('{')).toThrow('不是 JSON')
  })
})
