import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createTraceRuntime } from '../runtime/traceRuntime'
import { createTraceCursor } from '../trace/compileTrace'
import { importCppTrace } from '../trace/importCppTrace'
import type { RuntimeEvent } from '../types'

function mixedTrace() {
  const trace = createTraceRuntime()
  const a = trace.track('a', Array.from({ length: 25 }, (_, i) => i))
  const call = trace.call('solve', { n: 25 }, 1)
  for (let i = 0; i < 300; i++) {
    trace.line(2)
    const value = a[i % a.length]
    trace.branch('a[i] >= 0', value >= 0, 2)
    a.fill(value + 1, i % a.length, i % a.length + 1)
    if (i % 50 === 0) a.splice(3, 1, 10, 11)
  }
  // A replacement following a lazy array write must freeze the old write view.
  trace.track('a', [100, 200], 3)
  trace.ret('solve', a.length, 4, call)
  trace.complete(a.length, 1)
  return structuredClone(trace.getEvents())
}

function compareSeeks(events: RuntimeEvent[], interval = 16) {
  const cached = createTraceCursor(events, undefined, { checkpointInterval: interval, maxCheckpoints: 32 })
  const plain = createTraceCursor(events, undefined, { maxCheckpoints: 0 })
  const end = events.length - 1
  const seeks = [end, ...Array.from({ length: 90 }, (_, i) => (i * 137) % events.length),
    ...Array.from({ length: Math.min(70, events.length) }, (_, i) => end - i), 0, end]
  for (const index of seeks) expect(cached.at(index), `seek ${index}`).toEqual(plain.at(index))
  return cached
}

describe('bounded replay checkpoints', () => {
  it('preserves reads, branches, calls, replacements and lazy array deltas on mixed seeks', () => {
    const events = mixedTrace()
    const cursor = compareSeeks(events)
    const final = cursor.at(events.length - 1)!
    expect(final.snapshot.callStack).toEqual([])
    expect(final.snapshot.tracked.a).toEqual([100, 200])
    expect(cursor.stats().checkpointCount).toBeLessThanOrEqual(32)
  })

  it.each(['bubble', 'grid', 'recursion', 'vector'])('matches checkpoint-free C++ %s replay', name => {
    const report = readFileSync(new URL(`../examples/cpp/${name}.json`, import.meta.url), 'utf8')
    compareSeeks(importCppTrace(report).result.events, 2)
  })

  it('restores the full recursion stack, not only the 24 visible call frames', () => {
    const trace = createTraceRuntime()
    const calls = Array.from({ length: 40 }, (_, i) => trace.call(`level${i}`, { i }, i + 1))
    trace.line(41)
    // Return from a frame outside the 24-frame visible tail. Replaying from a
    // screen-only snapshot would leave stale inner calls or lose outer calls.
    trace.ret('level4', 7, 42, calls[4])
    trace.complete(7, 0)
    const events = structuredClone(trace.getEvents())
    const cached = createTraceCursor(events, undefined, { checkpointInterval: 8 })
    const plain = createTraceCursor(events, undefined, { maxCheckpoints: 0 })
    for (const index of [events.length - 1, 39, 31, 40, 41, 32, events.length - 1]) {
      expect(cached.at(index)).toEqual(plain.at(index))
    }
    expect(cached.at(events.length - 1)!.snapshot.callStack.map(frame => frame.name))
      .toEqual(['level0', 'level1', 'level2', 'level3'])
  })

  it('bounds both checkpoint count and retained serialized bytes', () => {
    const events = mixedTrace()
    const cursor = createTraceCursor(events, undefined, { checkpointInterval: 8, maxCheckpoints: 3, maxCheckpointBytes: 5000 })
    for (let i = 0; i < events.length; i++) {
      cursor.at(i)
      expect(cursor.stats().checkpointCount).toBeLessThanOrEqual(3)
      expect(cursor.stats().checkpointBytes).toBeLessThanOrEqual(5000)
    }
    expect(cursor.stats().checkpointCount).toBeGreaterThan(0)
    const oversized = createTraceCursor(events, undefined, { checkpointInterval: 1, maxCheckpointBytes: 1 })
    oversized.at(events.length - 1)
    expect(oversized.stats().checkpointBytes).toBe(0)
    expect(oversized.at(100)).toEqual(createTraceCursor(events, undefined, { maxCheckpoints: 0 }).at(100))
  })

  it('replays fewer events when repeatedly scrubbing backwards near the tail', () => {
    const events = mixedTrace()
    const plain = createTraceCursor(events, undefined, { maxCheckpoints: 0 })
    const cached = createTraceCursor(events)
    for (let i = events.length - 1; i >= events.length - 100; i--) {
      expect(cached.at(i)).toEqual(plain.at(i))
    }
    expect(cached.stats().appliedEvents).toBeLessThan(plain.stats().appliedEvents / 2)
  })

  it('does not let a caller mutate saved states through returned frames', () => {
    const events = mixedTrace()
    const cached = createTraceCursor(events, undefined, { checkpointInterval: 8 })
    const frame = cached.at(events.length - 1)!
    ;(frame.snapshot.tracked.a as number[])[0] = -999
    cached.at(0)
    const restored = cached.at(events.length - 1)
    expect(restored).toEqual(createTraceCursor(events, undefined, { maxCheckpoints: 0 }).at(events.length - 1))
  })

  it('rejects invalid positions without changing replay state', () => {
    const cursor = createTraceCursor(mixedTrace())
    const frame = cursor.at(10)
    for (const index of [-1, NaN, 1.5, Infinity, 100000]) expect(cursor.at(index)).toBeNull()
    expect(cursor.at(10)).toBe(frame)
  })
})
