// Deterministic replay benchmark. Serialized checkpoint bytes are NOT a heap measurement.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '../..')
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' })
try {
  const { createTraceCursor } = await server.ssrLoadModule('/src/trace/compileTrace.ts')
  const { createTraceRuntime } = await server.ssrLoadModule('/src/runtime/traceRuntime.ts')
  const runtime = createTraceRuntime()
  const a = runtime.track('a', Array(120).fill(0))
  for (let i = 0; i < 1300; i++) {
    runtime.line(2)
    a[i % 120] = a[i % 120] + 1
  }
  runtime.complete(1300, 0)
  const events = structuredClone(runtime.getEvents())
  const end = events.length - 1
  const seeks = Array.from({ length: 120 }, (_, i) => end - ((i * 47) % 900))
  // Includes distant backward seeks and forward recovery as well as local scrubbing.
  seeks.push(1, end, 128, 256, end, 0, end)
  const bytes = value => Buffer.byteLength(JSON.stringify(value))
  function median(fn) {
    fn()
    const times = []
    for (let i = 0; i < 7; i++) {
      const start = performance.now()
      fn()
      times.push(performance.now() - start)
    }
    return Number(times.sort((a, b) => a - b)[3].toFixed(3))
  }
  const plain = () => createTraceCursor(events, undefined, { maxCheckpoints: 0 })
  const cached = () => createTraceCursor(events)
  const reference = plain()
  const candidate = cached()
  reference.at(end)
  candidate.at(end)
  for (const index of seeks) assert.deepEqual(candidate.at(index), reference.at(index))
  assert.ok(candidate.stats().appliedEvents < reference.stats().appliedEvents / 2, 'Checkpoints must reduce replay work, independent of noisy timing')
  assert.ok(candidate.stats().checkpointCount <= 12)
  assert.ok(candidate.stats().checkpointBytes <= 1024 * 1024)
  const measure = make => {
    const cursor = make()
    cursor.at(end)
    for (const index of seeks) cursor.at(index)
    return cursor.stats?.() ?? { checkpoints: 'not implemented' }
  }
  console.log(JSON.stringify({
    label: 'Runtime-captured array, near 4000-event cap; identical snapshots at every seek',
    events: events.length, seekCount: seeks.length, eventJsonBytes: bytes(events),
    noCheckpoints: {
      initialEndMedianMs: median(() => plain().at(end)),
      seekSequenceMedianMs: median(() => measure(plain)), ...measure(plain),
    },
    checkpoints: {
      initialEndMedianMs: median(() => cached().at(end)),
      seekSequenceMedianMs: median(() => measure(cached)), ...measure(cached),
    },
    note: 'Local Vite SSR microbenchmark, not browser frame latency. checkpointBytes is retained UTF-8 JSON size, not JS heap usage.',
  }, null, 2))
} finally { await server.close() }
