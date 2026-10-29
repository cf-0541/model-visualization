// Builds both variants into an OS temporary directory. Neither output is shipped.
import assert from 'node:assert/strict'
import { build } from 'vite'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '../..')
const temp = mkdtempSync(join(tmpdir(), 'ast-app-'))
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}
function sizes(outDir) {
  const bundles = files(outDir).filter((file) => file.endsWith('.js')).map((file) => {
    const bytes = readFileSync(file)
    return { file: file.slice(outDir.length + 1), raw: bytes.length, gzip: gzipSync(bytes).length }
  }).sort((a, b) => b.raw - a.raw)
  return { totalRaw: bundles.reduce((sum, item) => sum + item.raw, 0),
    totalGzip: bundles.reduce((sum, item) => sum + item.gzip, 0), bundles }
}
try {
  const result = {}
  for (const variant of ['baseline', 'pilot']) {
    const redirects = new Set()
    const alias = {
      name: 'pilot-ast-only-in-this-build',
      enforce: 'pre',
      resolveId(id, importer) {
        if (variant !== 'pilot') return
        const from = importer?.replaceAll('\\', '/')
        const replacements = [
          ['../instrumentation/instrument', '/src/runtime/runCode.ts', 'instrument.mjs'],
          ['../sourceAnalysis', '/src/runtime/runCode.ts', 'sourceAnalysis.mjs'],
          ['./parseInput', '/src/App.tsx', 'parseInput.mjs'],
        ]
        for (const [specifier, parent, file] of replacements) {
          if (id === specifier && from?.endsWith(parent)) {
            redirects.add(file)
            return resolve(root, 'experiments/lightweight-ast', file)
          }
        }
      },
    }
    const outDir = join(temp, variant)
    await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'error',
      plugins: [alias], build: { outDir, emptyOutDir: true, sourcemap: false } })
    if (variant === 'pilot') assert.deepEqual([...redirects].sort(),
      ['instrument.mjs', 'parseInput.mjs', 'sourceAnalysis.mjs'], 'Not all Babel imports were redirected.')
    result[variant] = sizes(outDir)
  }
  for (const variant of ['baseline', 'pilot']) {
    const { totalRaw, totalGzip, bundles } = result[variant]
    console.log(`${variant}: ${totalRaw} B raw / ${totalGzip} B gzip (all emitted JS, including worker)`)
    for (const { file, raw, gzip } of bundles.slice(0, 3)) console.log(`  ${file}: ${raw} B / ${gzip} B gzip`)
  }
  console.log(`Pilot minus baseline: ${result.pilot.totalRaw - result.baseline.totalRaw} B raw / ${result.pilot.totalGzip - result.baseline.totalGzip} B gzip`)
  console.log('Experimental build only: full behavior equivalence is not established.')
} finally {
  if (dirname(temp) !== resolve(tmpdir()) || !statSync(temp).isDirectory()) {
    throw new Error(`Unexpected temporary output path: ${temp}`)
  }
  rmSync(temp, { recursive: true, force: true })
}
