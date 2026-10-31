// Compare frozen Babel reference with an unaliased build of the integrated app.
import { astBuildVariant, variants } from './build-variants.mjs'
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
  for (const variant of variants) {
    const outDir = join(temp, variant)
    await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'error',
      plugins: [astBuildVariant(variant)], build: { outDir, emptyOutDir: true, sourcemap: false } })
    result[variant] = sizes(outDir)
  }
  for (const variant of variants) {
    const { totalRaw, totalGzip, bundles } = result[variant]
    console.log(`${variant}: ${totalRaw} B raw / ${totalGzip} B gzip (all emitted JS, including worker)`)
    for (const { file, raw, gzip } of bundles.slice(0, 3)) console.log(`  ${file}: ${raw} B / ${gzip} B gzip`)
  }
  console.log(`Integrated production minus Babel reference: ${result.production.totalRaw - result.baseline.totalRaw} B raw / ${result.production.totalGzip - result.baseline.totalGzip} B gzip`)
  console.log('Production imports are unmodified; reference-only aliases are verified. Bounded parity is not arbitrary-code equivalence or a release.')
} finally {
  if (dirname(temp) !== resolve(tmpdir()) || !statSync(temp).isDirectory()) {
    throw new Error(`Unexpected temporary output path: ${temp}`)
  }
  rmSync(temp, { recursive: true, force: true })
}
