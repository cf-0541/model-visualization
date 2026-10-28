import { describe, expect, it } from 'vitest'
import { compileTrace, createTraceCursor, keyFrameIndices, MAX_VISUAL_STEPS } from '../trace/compileTrace'
import { detectModel } from '../trace/detectModel'
import { playbackDelay } from '../trace/playback'
import type { RuntimeEvent } from '../types'

const events: RuntimeEvent[] = [
  { seq: 0, type: 'track', line: 2, target: 'dp', value: [0, 0, 0] },
  { seq: 1, type: 'line', line: 3 },
  { seq: 2, type: 'read', line: 3, target: 'dp', path: [0], value: 2 },
  { seq: 3, type: 'write', line: 3, target: 'dp', path: [1], before: 0, after: 2 },
  { seq: 4, type: 'done', line: 4, result: 2, duration: 0.5 },
]

describe('trace compiler', () => {
  it('replays writes into immutable visual snapshots', () => {
    const steps = compileTrace(events)
    expect(steps[0].snapshot.tracked.dp).toEqual([0, 0, 0])
    const write = steps.find((step) => step.event.type === 'write')!
    expect(write.snapshot.tracked.dp).toEqual([0, 2, 0])
    expect(write.snapshot.reads[0]).toMatchObject({ target: 'dp', path: [0] })
    expect(write.snapshot.write).toMatchObject({ target: 'dp', path: [1], value: 2 })
    expect(steps[0].snapshot.tracked.dp).toEqual([0, 0, 0])
    expect(steps.map((step) => step.event.type)).not.toContain('read')
  })

  it('replays all writes while keeping only bounded visual frames', () => {
    const many: RuntimeEvent[] = [{ seq: 0, type: 'track', line: 1, target: 'dp', value: [0] }]
    for (let value = 1; value <= 1_000; value++) {
      many.push({ seq: value, type: 'write', line: 2, target: 'dp', path: [0], before: value - 1, after: value })
    }
    many.push({ seq: 1_001, type: 'done', line: 3, result: 1_000, duration: 1 })
    const steps = compileTrace(many)
    expect(steps.length).toBeLessThanOrEqual(MAX_VISUAL_STEPS)
    expect(steps[0].snapshot.tracked.dp).toEqual([0])
    expect(steps.at(-1)?.snapshot.tracked.dp).toEqual([1_000])
    expect(steps.at(-1)?.event.type).toBe('done')
    expect(steps.map((step) => step.index)).toEqual(steps.map((_, index) => index))
  })

  it('keeps only recent call frames in visual snapshots', () => {
    const calls: RuntimeEvent[] = Array.from({ length: 100 }, (_, index) => ({
      seq: index, type: 'call', line: 1, name: 'recur', callId: index + 1, depth: index, args: { index },
    }))
    const last = compileTrace(calls).at(-1)!
    expect(last.snapshot.callStack).toHaveLength(24)
    expect(last.snapshot.callStack[0].callId).toBe(77)
  })

  it('does not allocate giant sparse arrays for out-of-view writes', () => {
    const steps = compileTrace([
      { seq: 0, type: 'track', line: 1, target: 'values', value: [0] },
      { seq: 1, type: 'write', line: 2, target: 'values', path: [100_000_000], before: 'undefined', after: 1 },
    ])
    expect((steps[1].snapshot.tracked.values as unknown[]).length).toBe(1)
    expect(steps[1].snapshot.write?.path).toEqual([100_000_000])
  })

  it('marks active lines and semantic events as key, and skips redundant reads', () => {
    const trace: RuntimeEvent[] = [
      { seq: 0, type: 'track', line: 1, target: 'a', value: [0] },
      { seq: 1, type: 'line', line: 2 },
      { seq: 2, type: 'read', line: 2, target: 'a', path: [0], value: 0 },
      { seq: 3, type: 'write', line: 2, target: 'a', path: [0], before: 0, after: 1 },
      { seq: 4, type: 'line', line: 3 },
      { seq: 5, type: 'line', line: 4 },
      { seq: 6, type: 'branch', line: 4, expression: 'a[0] > 0', result: true },
      { seq: 7, type: 'call', line: 4, name: 'f', callId: 1, depth: 0, args: {} },
      { seq: 8, type: 'return', line: 4, name: 'f', callId: 1, depth: 0, args: {}, value: 1 },
      { seq: 9, type: 'done', line: 5, result: 1, duration: 1 },
    ]
    const steps = compileTrace(trace)
    expect(steps.map(({ event, kind }) => [event.seq, kind])).toEqual([
      [0, 'minor'], [1, 'key'], [3, 'key'], [4, 'minor'], [5, 'key'],
      [6, 'key'], [7, 'key'], [8, 'key'], [9, 'key'],
    ])
    expect(steps[2].snapshot.reads).toMatchObject([{ path: [0] }])
  })

  it('keeps the last read when a line has no richer event, and retains terminal errors', () => {
    const steps = compileTrace([
      { seq: 0, type: 'line', line: 1 },
      { seq: 1, type: 'read', line: 1, target: 'a', path: [0], value: 1 },
      { seq: 2, type: 'read', line: 1, target: 'a', path: [1], value: 2 },
      { seq: 3, type: 'error', line: 1, message: 'stopped' },
    ])
    expect(steps.map(({ event, kind }) => [event.seq, kind])).toEqual([
      [0, 'key'], [2, 'minor'], [3, 'key'],
    ])
    expect(steps[1].snapshot.reads).toHaveLength(2)
  })

  it('prefers key updates over many empty lines under the frame cap', () => {
    const trace: RuntimeEvent[] = Array.from({ length: 700 }, (_, index) => ({
      seq: index, type: 'line', line: index + 1,
    }))
    trace.push({ seq: 700, type: 'track', line: 701, target: 'a', value: [0] })
    trace.push({ seq: 701, type: 'write', line: 701, target: 'a', path: [0], before: 0, after: 1 })
    trace.push({ seq: 702, type: 'done', line: 702, result: 1, duration: 1 })
    const steps = compileTrace(trace)
    expect(steps).toHaveLength(MAX_VISUAL_STEPS)
    expect(steps.some((step) => step.event.seq === 701 && step.kind === 'key')).toBe(true)
    expect(steps.at(-1)?.snapshot.tracked.a).toEqual([1])
  })

  it('keeps every write addressable in key mode even beyond the snapshot cap', () => {
    const trace: RuntimeEvent[] = [{ seq: 0, type: 'track', line: 1, target: 'a', value: [0] }]
    for (let i = 1; i <= 1_000; i++) {
      trace.push({ seq: i, type: 'write', line: 2, target: 'a', path: [0], before: i - 1, after: i })
    }
    trace.push({ seq: 1_001, type: 'done', line: 3, result: 1_000, duration: 1 })
    const indices = keyFrameIndices(trace)
    expect(indices).toHaveLength(1_002)
    expect(indices).toEqual(trace.map((_, index) => index))
    expect(compileTrace(trace)).toHaveLength(MAX_VISUAL_STEPS)
    const cursor = createTraceCursor(trace)
    expect(cursor.at(500)?.snapshot.tracked.a).toEqual([500])
    expect(cursor.at(999)?.snapshot.tracked.a).toEqual([999])
    expect(cursor.at(1)?.snapshot.tracked.a).toEqual([1]) // backward seek resets state
    expect(cursor.at(1_001)?.snapshot.result).toBe(1_000)
  })

  it('allows raw-event playback to inspect reads omitted from key mode', () => {
    expect(keyFrameIndices(events)).toEqual([0, 1, 3, 4])
    const cursor = createTraceCursor(events)
    const read = cursor.at(2)!
    expect(read.event).toEqual(events[2])
    expect(read.snapshot.reads).toMatchObject([{ target: 'dp', path: [0], value: 2 }])
    expect(read.snapshot.tracked.dp).toEqual([0, 0, 0])
    expect(cursor.at(3)?.snapshot.tracked.dp).toEqual([0, 2, 0])
    expect(cursor.at(2)?.snapshot.tracked.dp).toEqual([0, 0, 0])
  })

  it('paces minor frames faster and scales large traces without changing short key timing', () => {
    expect(playbackDelay('key', 20, 1)).toBe(680)
    expect(playbackDelay('minor', 20, 1)).toBe(272)
    expect(playbackDelay('key', 200, 1)).toBeLessThan(680)
    expect(playbackDelay('key', 200, 2)).toBe(playbackDelay('key', 200, 1) / 2)
    expect(playbackDelay('minor', 200, 1)).toBeCloseTo(playbackDelay('key', 200, 1) * 0.4)
  })

  it('detects DP and segment tree models from semantic events', () => {
    expect(detectModel(events)).toBe('dp')

    const treeEvents: RuntimeEvent[] = [
      {
        seq: 0,
        type: 'call',
        line: 1,
        name: 'build',
        callId: 1,
        depth: 0,
        args: { p: 1, l: 0, r: 7 },
      },
    ]
    expect(detectModel(treeEvents)).toBe('unknown') // a single p/l/r call is not sufficient evidence
    treeEvents.push({ seq: 1, type: 'call', line: 2, name: 'build', callId: 2, depth: 1, args: { p: 2, l: 0, r: 3 } })
    expect(detectModel(treeEvents)).toBe('segment-tree')
    expect(detectModel(events, 'array')).toBe('array')
    expect(detectModel([], 'graph')).toBe('graph')
    expect(detectModel([])).toBe('unknown')
    expect(detectModel([{ seq: 0, type: 'write', line: 1, target: 'items', path: [], before: [1, 2], after: [2, 1] }])).toBe('array')
  })
})
