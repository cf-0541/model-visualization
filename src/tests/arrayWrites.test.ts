import { describe, expect, it } from 'vitest'
import { createTraceRuntime, TraceLimitError } from '../runtime/traceRuntime'
import { compileTrace, createTraceCursor } from '../trace/compileTrace'
import { detectModel } from '../trace/detectModel'

function writes(trace: ReturnType<typeof createTraceRuntime>) {
  return trace.getEvents().filter((event) => event.type === 'write')
}

// Mirrors the existing bounded visual representation, including sparse holes.
function visible(a: unknown[]) {
  const result = a.slice(0, 120)
  if (a.length > 120) result.push(`… +${a.length - 120}`)
  return result
}

describe('atomic array write deltas', () => {
  it('stores only changed slots for a one-slot fill and defers full write views to playback', () => {
    const trace = createTraceRuntime()
    const raw = Array.from({ length: 1_000 }, (_, i) => i)
    const a = trace.track('a', raw)
    expect(a.fill(99, 5, 6)).toBe(a)
    const event = writes(trace)[0]
    expect(event).toMatchObject({ arrayPatch: { beforeLength: 121, afterLength: 121,
      changes: [{ index: 5, before: 5, after: 99, beforePresent: true, afterPresent: true }] } })
    expect(event).not.toHaveProperty('before')
    expect(event).not.toHaveProperty('after')
    const frame = createTraceCursor(trace.getEvents()).at(event.seq)!
    expect(frame.snapshot.write?.before).toEqual(visible(Array.from({ length: 1_000 }, (_, i) => i)))
    expect(frame.snapshot.write?.value).toEqual(visible(raw))
    expect(frame.snapshot.tracked.a).toEqual(visible(raw))
    expect(frame.description).not.toContain('undefined')
    expect(detectModel([event])).toBe('array')
  })

  it('does not serialize unchanged prefixes for thousands of large-array pushes', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', Array(1_000).fill(123456))
    for (let i = 0; i < 2_000; i++) a.push(i)
    expect(writes(trace)).toHaveLength(2_000)
    expect(JSON.stringify(writes(trace)).length).toBeLessThan(600_000)
    expect(writes(trace).every((event) => 'arrayPatch' in event)).toBe(true)
    expect(() => structuredClone(trace.getEvents())).not.toThrow()
  })

  it('preserves every atomic state, backward seeks, holes, and truncation markers', () => {
    const trace = createTraceRuntime()
    const raw: number[] = Array.from({ length: 118 }, (_, i) => i)
    delete raw[3]
    const a = trace.track('a', raw)
    const expected: unknown[][] = []
    const mutate = (fn: () => unknown) => { fn(); expected.push(visible(raw)) }
    mutate(() => a.push(118, 119, 120, 121))
    mutate(() => a.pop())
    mutate(() => a.shift())
    mutate(() => a.unshift(42))
    mutate(() => a.splice(117, 5, 9))
    mutate(() => a.copyWithin(1, 4, 8))
    mutate(() => a.reverse())
    mutate(() => a.sort((left, right) => left - right))
    mutate(() => a.fill(0, 2, 4))
    mutate(() => a.splice(0, a.length))
    mutate(() => a.pop())
    const events = structuredClone(trace.getEvents())
    const cursor = createTraceCursor(events)
    const mutations = events.filter((event) => event.type === 'write')
    mutations.forEach((event, index) => {
      const frame = cursor.at(event.seq)!
      expect(frame.snapshot.tracked.a).toStrictEqual(expected[index])
      expect(frame.snapshot.write?.value).toStrictEqual(expected[index])
      const before = index === 0 ? events[0].type === 'track' ? events[0].value : null : expected[index - 1]
      expect(frame.snapshot.write?.before).toStrictEqual(before)
    })
    expect(cursor.at(mutations[0].seq)?.snapshot.tracked.a).toStrictEqual(expected[0])
    expect(cursor.at(mutations.at(-1)!.seq)?.snapshot.tracked.a).toStrictEqual([])
    expect(compileTrace(events).filter((step) => step.event.type === 'write')).toHaveLength(mutations.length)
  })

  it('preserves nested array addresses and immutable history after later mutations', () => {
    const trace = createTraceRuntime()
    const raw = [[1, 2], [3]]
    const a = trace.track('grid', raw)
    a[0].push(4)
    const saved = structuredClone(trace.getEvents())
    a[0].reverse()
    raw[0][0] = 999
    expect(trace.getEvents().slice(0, saved.length)).toEqual(saved)
    const cursor = createTraceCursor(trace.getEvents())
    expect(cursor.at(1)?.snapshot.tracked.grid).toEqual([[1, 2, 4], [3]])
    expect(cursor.at(2)?.snapshot.tracked.grid).toEqual([[4, 2, 1], [3]])
  })

  it('keeps the full bounded fallback when a sort callback mutates object elements', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', [{ n: 2 }, { n: 1 }])
    a.sort((left, right) => { left.n = 10; return right.n - left.n })
    const event = writes(trace)[0]
    expect(event).not.toHaveProperty('arrayPatch')
    expect(event.before).toEqual([{ n: 2 }, { n: 1 }])
    expect(createTraceCursor(trace.getEvents()).at(event.seq)?.snapshot.tracked.a).toEqual(event.after)
  })

  it('falls back safely if a primitive array gains an object element', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', [1, 2] as unknown[])
    const item = { n: 3 }
    a.push(item)
    item.n = 8
    expect(writes(trace)[0]).toMatchObject({ before: [1, 2], after: [1, 2, { n: 3 }] })
  })

  it('keeps index assignments scalar and rejects mutation at the event limit', () => {
    const trace = createTraceRuntime(2)
    const raw = Array(1_000).fill(0)
    const a = trace.track('a', raw)
    a[50] = 2
    expect(writes(trace)[0]).toMatchObject({ path: [50], before: 0, after: 2 })
    expect(() => a.push(1)).toThrow(TraceLimitError)
    expect(raw).toHaveLength(1_000)
  })

  it('resynchronizes after unproxied aliases and scalar assignments change the baseline', () => {
    const trace = createTraceRuntime()
    const raw = Array(40).fill(0)
    const a = trace.track('a', raw)
    raw[0] = 8
    a.fill(1, 1, 2)
    a[2] = 9
    a.fill(2, 3, 4)
    a.fill(3, 4, 5)
    const events = writes(trace)
    expect(events[0]).toMatchObject({ before: [8, ...Array(39).fill(0)] })
    expect(events[2]).not.toHaveProperty('arrayPatch')
    expect(events[3]).toHaveProperty('arrayPatch')
    expect(createTraceCursor(trace.getEvents()).at(events[3].seq)?.snapshot.tracked.a).toEqual(raw)
  })

  it('invalidates nested deltas when an ancestor is fully replaced', () => {
    const trace = createTraceRuntime()
    const raw = [Array(40).fill(0), Array(40).fill(5)]
    const root = trace.track('root', raw)
    root[0].fill(1, 0, 1)
    root[0].fill(2, 1, 2)
    expect(writes(trace)[1]).toHaveProperty('arrayPatch')
    root.reverse()
    root.reverse()
    root[0].fill(3, 2, 3)
    const last = writes(trace).at(-1)!
    expect(last).not.toHaveProperty('arrayPatch')
    expect(createTraceCursor(trace.getEvents()).at(last.seq)?.snapshot.tracked.root).toEqual(raw)
  })

  it('uses the smaller full format for dense reorders rather than inflating a delta', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', Array.from({ length: 120 }, (_, i) => i))
    a.reverse()
    expect(writes(trace)[0]).not.toHaveProperty('arrayPatch')
  })

  it('does not retain a pending array write after a read or line boundary', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', Array(40).fill(0))
    a.fill(1, 0, 1)
    void a[0]
    a.fill(2, 1, 2)
    trace.line(4)
    const cursor = createTraceCursor(trace.getEvents())
    expect(cursor.at(2)?.snapshot.write).toBeNull()
    expect(cursor.at(4)?.snapshot.write).toBeNull()
    expect(cursor.at(1)?.snapshot.write?.before).toEqual(Array(40).fill(0))
  })

  it('replays deterministic mixed operations exactly across sparse and full events', () => {
    const trace = createTraceRuntime()
    const raw = Array.from({ length: 35 }, (_, i) => i)
    const a = trace.track('a', raw)
    let seed = 12345
    const cursor = createTraceCursor(trace.getEvents())
    for (let i = 0; i < 180; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const before = visible(raw)
      const index = seed % Math.max(1, raw.length)
      switch (seed % 9) {
        case 0: a.fill(i, index, index + 1); break
        case 1: a.push(i); break
        case 2: a.pop(); break
        case 3: a.shift(); break
        case 4: a.unshift(i); break
        case 5: a.reverse(); break
        case 6: a.splice(index, 1, i, i + 1); break
        case 7: a.sort((left, right) => left - right); break
        default: a.copyWithin(index, 0, 2)
      }
      const last = trace.getEvents().at(-1)!
      const frame = cursor.at(last.seq)!
      expect(frame.snapshot.tracked.a).toStrictEqual(visible(raw))
      expect(frame.snapshot.write?.before).toStrictEqual(before)
      expect(frame.snapshot.write?.value).toStrictEqual(visible(raw))
    }
  })

  it('does not reinterpret a lazy write when a track event reuses its target name', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', Array(40).fill(0))
    a.fill(1, 0, 1)
    trace.track('a', Array(40).fill(9))
    const last = createTraceCursor(trace.getEvents()).at(2)!
    expect(last.snapshot.tracked.a).toEqual(Array(40).fill(9))
    expect(last.snapshot.write?.before).toEqual(Array(40).fill(0))
    expect(last.snapshot.write?.value).toEqual([1, ...Array(39).fill(0)])
  })

  it('records state on a throwing sort and preserves the exception', () => {
    const trace = createTraceRuntime()
    const raw = [3, 2, 1]
    const a = trace.track('a', raw)
    expect(() => a.sort(() => { throw new Error('comparison failed') })).toThrow('comparison failed')
    expect(writes(trace)).toHaveLength(1)
    const last = trace.getEvents().length - 1
    expect(createTraceCursor(trace.getEvents()).at(last)?.snapshot.tracked.a).toEqual(raw)
  })
})
