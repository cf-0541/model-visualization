import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RunSummary } from '../components/RunSummary'
import { createTraceRuntime, TraceLimitError } from '../runtime/traceRuntime'
import type { RunResult } from '../types'

const result: RunResult = {
  analysis: { entry: 'solve', parameters: [], requiredParameters: 0, script: false, declaredModel: null, structure: null, reason: '' },
  events: [], result: 7, transformedCode: '', duration: 1,
}
const render = (value: RunResult, cpp = false) => renderToStaticMarkup(createElement(RunSummary, { result: value, cpp }))

describe('completion and observation limits', () => {
  it('reports complete execution separately from a bounded collection snapshot', () => {
    const trace = createTraceRuntime()
    const raw = Array(130).fill(1)
    const value = trace.track('a', raw)
    value[129] = 9
    trace.complete(raw.length, 1)
    expect(raw).toHaveLength(130)
    expect(raw[129]).toBe(9)
    expect(trace.getEvents().at(-1)?.type).toBe('done')
    expect(trace.getObservation()).toEqual({ collectionLimit: 120, collectionTruncated: true })
    const html = render({ ...result, events: trace.getEvents(), observation: trace.getObservation() })
    expect(html).toContain('算法执行完成')
    expect(html).toContain('前 120 项')
    expect(html).not.toContain('执行未完成')
  })

  it('does not guess truncation from user strings that resemble snapshot markers', () => {
    const trace = createTraceRuntime()
    trace.track('a', ['… +100', '[…]'])
    trace.complete(2, 1)
    expect(trace.getObservation().collectionTruncated).toBe(false)
    expect(render({ ...result, observation: trace.getObservation() })).not.toContain('前 120 项')
  })

  it('detects oversized result values and collections grown by native mutators', () => {
    const trace = createTraceRuntime()
    const a = trace.track('a', Array(120).fill(0))
    expect(trace.getObservation().collectionTruncated).toBe(false)
    a.push(1)
    expect(trace.getObservation().collectionTruncated).toBe(true)
    const other = createTraceRuntime()
    other.complete({ a: Array(121).fill(0) }, 0)
    expect(other.getObservation().collectionTruncated).toBe(true)
  })

  it('marks oversized object snapshots without truncating the actual object', () => {
    const trace = createTraceRuntime()
    const raw = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`key${i}`, i]))
    trace.track('values', raw)
    expect(Object.keys(raw)).toHaveLength(130)
    expect(trace.getObservation().collectionTruncated).toBe(true)
  })

  it('does not label an event-limited partial trace as completed', () => {
    const trace = createTraceRuntime(3)
    try { for (let i = 0; i < 10; i++) trace.line(i + 1) }
    catch (error) { expect(error).toBeInstanceOf(TraceLimitError); trace.truncate((error as Error).message) }
    const html = render({ ...result, result: undefined, events: trace.getEvents(), truncated: '已达事件上限' })
    expect(html).toContain('执行未完成')
    expect(html).toContain('没有完整结果')
    expect(html).not.toContain('算法执行完成')
    expect(trace.getEvents().at(-1)?.type).toBe('error')
  })

  it('explains that completed C++ reports are debugger samples, not browser execution', () => {
    const html = render(result, true)
    expect(html).toContain('报告标记采集完成')
    expect(html).toContain('耗时包含调试器开销')
    expect(html).not.toContain('算法执行完成')
  })
})
