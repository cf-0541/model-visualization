import { describe, expect, it } from 'vitest'
import { examples } from '../examples'
import { instrumentCode } from '../instrumentation/instrument'
import { parseInput } from '../parseInput'
import { createTraceRuntime } from '../runtime/traceRuntime'
import { analyzeSource, argumentsFor } from '../sourceAnalysis'
import { compileTrace, createTraceCursor, summarizeTraceTargets } from '../trace/compileTrace'
import { selectDpTarget, selectDpTargetFromEvents } from '../trace/selectDp'
import type { RuntimeEvent } from '../types'

function run(source: string, input = ''): RuntimeEvent[] {
  const analysis = analyzeSource(source)
  const { code, scriptResult } = instrumentCode(source, analysis.script)
  const trace = createTraceRuntime()
  const execute = new Function('__trace', '__args', `"use strict"; ${code}; ${analysis.entry
    ? `return ${analysis.entry}(...__args);` : `return ${scriptResult ?? 'undefined'};`}`)
  const result: unknown = execute(trace, argumentsFor(analysis, parseInput(input)))
  trace.complete(result, 1)
  return structuredClone(trace.getEvents())
}

function expectLegacySelection(events: RuntimeEvent[], expected?: string | null) {
  const original = structuredClone(events)
  const legacy = selectDpTarget(compileTrace(events))
  expect(selectDpTargetFromEvents(events)).toBe(legacy)
  if (expected !== undefined) expect(legacy).toBe(expected)
  expect(events).toEqual(original)
}

describe('snapshot-free DP target selection', () => {
  it.each(examples.map((example) => [example.id, example.code, example.input]))(
    'matches bounded snapshot selection for the built-in %s example', (_id, source, input) => {
      expectLegacySelection(run(source, input))
    },
  )

  it('keeps a renamed state table instead of the input array', () => {
    expectLegacySelection(run(`function solve(nums) {
      const states = Array(nums.length).fill(0);
      states[0] = nums[0];
      for (let i = 1; i < nums.length; i++) states[i] = states[i - 1] + nums[i];
      return states[nums.length - 1];
    }`, '[2, 3, 4]'), 'states')
  })

  it('handles empty traces, non-array targets, and later-declaration ties', () => {
    expectLegacySelection([], null)
    expectLegacySelection([{ seq: 0, type: 'track', line: 1, target: 'obj', value: { x: 1 } }], null)
    expectLegacySelection([
      { seq: 0, type: 'track', line: 1, target: 'first', value: [0] },
      { seq: 1, type: 'track', line: 1, target: 'second', value: [0] },
    ], 'second')
  })

  it('retains name and nested-array bonuses', () => {
    expectLegacySelection([
      { seq: 0, type: 'track', line: 1, target: 'memo', value: [0] },
      { seq: 1, type: 'track', line: 1, target: 'matrix', value: [[0]] },
    ], 'memo')
    expectLegacySelection([
      { seq: 0, type: 'track', line: 1, target: 'matrix', value: [[0]] },
      { seq: 1, type: 'track', line: 1, target: 'input', value: [0] },
    ], 'matrix')
  })

  it('preserves recent-read deduplication, line boundaries, and dependency tails', () => {
    const trace = createTraceRuntime()
    const states = trace.track('states', [0, 0, 0, 0])
    trace.track('input', [1, 2, 3, 4])
    trace.line(2)
    states[1] = states[0] + states[0] + 1
    trace.line(3)
    states[2] = 2
    states[3] = states[2] + 1
    const events = structuredClone(trace.getEvents())
    expectLegacySelection(events, 'states')
    expect(summarizeTraceTargets(events).find(({ target }) => target === 'states')?.writeScore).toBe(15)
  })

  it('uses final target shape after root replacement and target-name reuse', () => {
    expectLegacySelection([
      { seq: 0, type: 'track', line: 1, target: 'dp', value: [[0]] },
      { seq: 1, type: 'track', line: 1, target: 'other', value: [0] },
      { seq: 2, type: 'write', line: 2, target: 'dp', path: [], before: [[0]], after: { x: 1 } },
      { seq: 3, type: 'track', line: 3, target: 'other', value: [[1]] },
    ], 'other')
  })

  it('recognizes nested arrays created by writes without modifying event values', () => {
    expectLegacySelection([
      { seq: 0, type: 'track', line: 1, target: 'table', value: [] },
      { seq: 1, type: 'track', line: 1, target: 'input', value: [] },
      { seq: 2, type: 'write', line: 2, target: 'table', path: [0, 0], before: 'undefined', after: 1 },
    ], 'table')
  })

  it('scores valid root/nested array patches and ignores patches with no replay array', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', Array(1_000).fill(0))
    a.fill(9, 5, 6)
    a.push(7)
    const holder = trace.track('holder', { values: Array(1_000).fill(0) })
    holder.values.fill(1, 3, 4)
    holder.values.fill(2, 4, 5)
    const events = structuredClone(trace.getEvents())
    expect(events.filter((event) => event.type === 'write' && event.arrayPatch)).toHaveLength(3)
    expectLegacySelection(events, 'a')
    expectLegacySelection([{
      seq: 0, type: 'write', line: 1, target: 'missing', path: ['values'],
      arrayPatch: { beforeLength: 0, afterLength: 0, changes: [] },
    }], 'missing')
    expect(summarizeTraceTargets([{
      seq: 0, type: 'write', line: 1, target: 'missing', path: ['values'],
      arrayPatch: { beforeLength: 0, afterLength: 0, changes: [] },
    }])[0].writeScore).toBe(0)
  })

  it('preserves the bounded compiler sampling policy above 400 frames', () => {
    const events: RuntimeEvent[] = [
      { seq: 0, type: 'track', line: 1, target: 'left', value: [0, 0] },
      { seq: 1, type: 'track', line: 1, target: 'right', value: [0, 0] },
    ]
    for (let i = 0; i < 900; i++) {
      const target = i % 3 === 0 ? 'left' : 'right'
      events.push({ seq: events.length, type: 'read', line: 2, target, path: [0], value: 0 })
      events.push({ seq: events.length, type: 'write', line: 2, target, path: [1], before: i, after: i + 1 })
    }
    expect(compileTrace(events)).toHaveLength(400)
    expectLegacySelection(events)
  })

  it('returns compact scalar metadata rather than retaining complete snapshots', () => {
    const events: RuntimeEvent[] = [{ seq: 0, type: 'track', line: 1, target: 'dp',
      value: Array.from({ length: 120 }, () => Array(120).fill(0)) }]
    for (let i = 0; i < 600; i++) events.push({ seq: i + 1, type: 'write', line: 2,
      target: 'dp', path: [Math.floor(i / 120), i % 120], before: 0, after: i + 1 })
    const current = createTraceCursor(events).at(events.length - 1)
    const summary = summarizeTraceTargets(events)
    expect(summary).toEqual([{ target: 'dp', nested: true, writeScore: 399 }])
    expect(JSON.stringify(summary).length).toBeLessThan(100)
    expectLegacySelection(events, 'dp')
    expect(createTraceCursor(events).at(events.length - 1)).toEqual(current)
  })
})
