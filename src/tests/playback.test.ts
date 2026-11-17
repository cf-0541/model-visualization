import { describe, expect, it } from 'vitest'
import { playbackDelay } from '../trace/playback'
import { keyFrameIndices } from '../trace/compileTrace'
import type { RuntimeEvent } from '../types'

describe('key-mode pacing without dropping events', () => {
  it('keeps short-trace timing and the legacy all-event API unchanged', () => {
    expect(playbackDelay('key', 20, 1, 'key')).toBe(680)
    expect(playbackDelay('minor', 20, 1, 'key')).toBe(272)
    expect(playbackDelay('key', 4000, 1, 'all')).toBeCloseTo(238)
    expect(playbackDelay('key', 4000, 1)).toBe(playbackDelay('key', 4000, 1, 'all'))
  })

  it.each([1000, 2000, 4000])('bounds scheduled key playback at 1x for %i frames', count => {
    const delay = playbackDelay('key', count, 1, 'key')
    expect(delay).toBeGreaterThanOrEqual(16)
    expect(delay * (count - 1)).toBeLessThanOrEqual(64000)
    expect(playbackDelay('key', count, 2, 'key')).toBe(delay / 2)
    expect(playbackDelay('minor', count, 1, 'key')).toBeCloseTo(delay * 0.4)
  })

  it('accelerates dense write traces but leaves every write addressable', () => {
    const events: RuntimeEvent[] = [{ seq: 0, type: 'track', line: 1, target: 'a', value: [0] }]
    for (let i = 1; i <= 1998; i++) events.push({ seq: i, type: 'write', line: 2, target: 'a', path: [0], before: i - 1, after: i })
    events.push({ seq: 1999, type: 'done', line: 3, result: 1998, duration: 1 })
    const indices = keyFrameIndices(events)
    expect(indices).toEqual(events.map((_, index) => index))
    const duration = playbackDelay('key', indices.length, 1, 'key') * (indices.length - 1)
    expect(duration).toBeLessThan(60000)
    expect(duration).toBeLessThan(playbackDelay('key', indices.length, 1, 'all') * (indices.length - 1) / 5)
  })
})
