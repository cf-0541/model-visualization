// Candidate-copy microbenchmark, not browser latency or heap measurement.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '../..')
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' })
try {
  const { copyCheckpoint } = await server.ssrLoadModule('/src/trace/checkpoint.ts')
  // Frozen local reference of 361ad0d's checkpoint copy + byte measurement.
  function clone(value) {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(clone)
    const output = {}
    for (const [key, item] of Object.entries(value)) output[key] = clone(item)
    return output
  }
  function serializedCopy(value, maxBytes) {
    const saved = clone(value)
    const bytes = new TextEncoder().encode(JSON.stringify(saved)).byteLength
    return bytes <= maxBytes ? { saved, bytes } : null
  }
  const maxBytes = 1024 * 1024
  const cases = [
    ['120-number array', { tracked: { a: Array(120).fill(1) }, callStack: [], result: undefined }],
    ['synthetic 120x120 tracked grid', { tracked: { dp: Array.from({ length: 120 }, () => Array(120).fill(1)) }, callStack: [] }],
    ['synthetic oversized string', { tracked: { text: 'x'.repeat(maxBytes + 1) }, callStack: [] }],
  ]
  function median(make, value) {
    const times = []
    for (let run = 0; run < 8; run++) {
      const start = performance.now()
      for (let i = 0; i < 16; i++) make(value, maxBytes)
      if (run) times.push(performance.now() - start)
    }
    return Number(times.sort((a, b) => a - b)[3].toFixed(3))
  }
  for (const [label, value] of cases) {
    const previous = serializedCopy(value, maxBytes)
    const current = copyCheckpoint(value, maxBytes)
    assert.deepEqual(current?.saved, previous?.saved)
    if (current) assert.ok(current.bytes >= previous.bytes && current.bytes <= maxBytes)
    console.log(JSON.stringify({ label, candidates: 16,
      serializedCopyMedianMs: median(serializedCopy, value),
      boundedCopyMedianMs: median(copyCheckpoint, value),
      exactSerializedBytes: previous?.bytes ?? null,
      chargedUpperBoundBytes: current?.bytes ?? null,
    }))
  }
} finally { await server.close() }
