// Local preparation microbenchmark, not browser latency or a heap-memory measurement.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '../..')
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' })
try {
  const { compileTrace, createTraceCursor, summarizeTraceTargets } = await server.ssrLoadModule('/src/trace/compileTrace.ts')
  const { selectDpTarget, selectDpTargetFromEvents } = await server.ssrLoadModule('/src/trace/selectDp.ts')
  const { createTraceRuntime } = await server.ssrLoadModule('/src/runtime/traceRuntime.ts')
  const synthetic = [{ seq: 0, type: 'track', line: 1, target: 'dp',
    value: Array.from({ length: 120 }, () => Array(120).fill(0)) }]
  for (let i = 0; i < 3500; i++) synthetic.push({ seq: i + 1, type: 'write', line: 2,
    target: 'dp', path: [Math.floor(i / 120), i % 120], before: 0, after: i + 1 })
  synthetic.push({ seq: 3501, type: 'done', line: 3, result: 3500, duration: 1 })
  const runtime = createTraceRuntime()
  const table = runtime.track('dp', Array.from({ length: 120 }, () => Array(120).fill(0)))
  for (let i = 0; i < 3500; i++) table[Math.floor(i / 120)][i % 120] = i + 1
  runtime.complete(3500, 1)
  function median(fn) {
    for (let i = 0; i < 3; i++) fn()
    const timings = []
    for (let i = 0; i < 9; i++) {
      const start = performance.now()
      fn()
      timings.push(performance.now() - start)
    }
    return Number(timings.sort((a, b) => a - b)[4].toFixed(2))
  }
  const bytes = value => Buffer.byteLength(JSON.stringify(value))
  for (const [label, events] of [
    ['Synthetic 120x120 DP, 3500 writes (deliberately uncapped initial snapshot)', synthetic],
    ['Runtime-captured 120x120 DP, 3500 writes (normal snapshot limits)', structuredClone(runtime.getEvents())],
  ]) {
    const frames = compileTrace(events)
    const legacy = selectDpTarget(frames)
    assert.equal(selectDpTargetFromEvents(events), legacy)
    const current = createTraceCursor(events).at(events.length - 1)
    assert.deepEqual(current.snapshot, frames.at(-1).snapshot)
    console.log(JSON.stringify({ label, events: events.length, oldRetainedFrames: frames.length,
      newRetainedPrecomputedFrames: 0, oldFramesJsonBytes: bytes(frames),
      newTargetMetadataJsonBytes: bytes(summarizeTraceTargets(events)), currentFrameJsonBytes: bytes(current),
      oldPreparationMedianMs: median(() => selectDpTarget(compileTrace(events))),
      newPreparationMedianMs: median(() => selectDpTargetFromEvents(events)),
      initialCursorMedianMs: median(() => createTraceCursor(events).at(0)),
      selectedTarget: legacy,
    }, null, 2))
  }
} finally {
  await server.close()
}
