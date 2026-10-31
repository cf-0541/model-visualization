import { build } from 'vite'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

export async function withBundles(verify) {
  const temp = mkdtempSync(join(tmpdir(), 'ast-pilot-'))
  const root = resolve(import.meta.dirname, '../..')
  try {
    const babelBundles = {}
    for (const [name, entry] of [
      ['Babel (full instrumentCode)', 'experiments/lightweight-ast/babel/instrument.ts'],
      ['Acorn (integrated instrumentCode)', 'experiments/lightweight-ast/instrument.mjs'],
      ['Babel sourceAnalysis', 'experiments/lightweight-ast/babel/sourceAnalysis.ts'],
      ['Babel parseInput', 'experiments/lightweight-ast/babel/parseInput.ts'],
      ['Worker runtime', 'src/runtime/runner.worker.ts'],
    ]) {
      const outDir = join(temp, name.replace(/[^a-zA-Z]/g, '-'))
      await build({ configFile: false, root, logLevel: 'error', build: {
        outDir, emptyOutDir: true, minify: 'esbuild', sourcemap: false,
        lib: { entry: resolve(root, entry), formats: ['es'], fileName: 'instrument' },
      } })
      const file = readdirSync(outDir).find((item) => item.endsWith('.js'))
      if (!file) throw new Error(`Missing JS bundle for ${name}`)
      const bundlePath = join(outDir, file)
      const bytes = readFileSync(bundlePath)
      console.log(`${name}: ${bytes.length} B raw / ${gzipSync(bytes).length} B gzip`)
      if (name.startsWith('Babel') || name === 'Worker runtime') babelBundles[name] = pathToFileURL(bundlePath).href
    }
    await verify(babelBundles)
  } finally {
    // Only remove the unique directory created under the OS temp directory.
    if (dirname(temp) !== resolve(tmpdir()) || !statSync(temp).isDirectory()) {
      throw new Error(`Unexpected temporary output path: ${temp}`)
    }
    rmSync(temp, { recursive: true, force: true })
  }
}
