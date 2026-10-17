import { describe, expect, it } from 'vitest'
import { compileTrace, MAX_VISUAL_STEPS } from '../trace/compileTrace'
import { detectModel } from '../trace/detectModel'
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
    expect(steps[3].snapshot.tracked.dp).toEqual([0, 2, 0])
    expect(steps[3].snapshot.reads[0]).toMatchObject({ target: 'dp', path: [0] })
    expect(steps[3].snapshot.write).toMatchObject({ target: 'dp', path: [1], value: 2 })
    expect(steps[0].snapshot.tracked.dp).toEqual([0, 0, 0])
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
    expect(detectModel(treeEvents)).toBe('array') // a single p/l/r call is not sufficient evidence
    treeEvents.push({ seq: 1, type: 'call', line: 2, name: 'build', callId: 2, depth: 1, args: { p: 2, l: 0, r: 3 } })
    expect(detectModel(treeEvents)).toBe('segment-tree')
    expect(detectModel(events, 'array')).toBe('array')
  })
})
