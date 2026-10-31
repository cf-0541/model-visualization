// Only the reference build is redirected. Production uses the real application imports.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

export const variants = ['baseline', 'production']
const root = resolve(import.meta.dirname, '../..')
const routes = [
  ['../instrumentation/instrument', '/src/runtime/runCode.ts', 'instrument'],
  ['../sourceAnalysis', '/src/runtime/runCode.ts', 'sourceAnalysis'],
  ['./parseInput', '/src/App.tsx', 'parseInput'],
]

export function astBuildVariant(variant) {
  assert.ok(variants.includes(variant), `Unknown AST build variant: ${variant}`)
  const redirects = new Set()
  return {
    name: `ast-reference-gate-${variant}`,
    enforce: 'pre',
    resolveId(id, importer) {
      if (variant !== 'baseline') return
      const from = importer?.replaceAll('\\', '/')
      for (const [specifier, parent, name] of routes) {
        if (id === specifier && from?.endsWith(parent)) {
          redirects.add(name)
          return resolve(root, 'experiments/lightweight-ast/babel', `${name}.ts`)
        }
      }
    },
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle).filter(item => item.type === 'chunk')
        .flatMap(chunk => Object.keys(chunk.modules)).map(id => id.replaceAll('\\', '/'))
      const names = routes.map(([, , name]) => name).sort()
      if (variant === 'baseline') {
        assert.deepEqual([...redirects].sort(), names, 'Babel reference not fully redirected')
        for (const name of names) assert.ok(modules.some(id => id.endsWith(`/babel/${name}.ts`)), `Missing Babel reference: ${name}`)
        assert.ok(modules.some(id => id.includes('/@babel/')), 'Baseline must actually contain Babel')
        assert.ok(!modules.some(id => id.includes('/src/ast/')), 'Baseline must not use the new implementation')
      } else {
        assert.equal(redirects.size, 0, 'Production must not redirect application imports')
        for (const name of names) assert.ok(modules.some(id => id.endsWith(`/src/ast/${name}.mjs`)), `Missing production implementation: ${name}`)
        assert.ok(!modules.some(id => id.includes('/@babel/') || id.includes('/experiments/')), 'Production must not ship Babel or experiment modules')
      }
      console.log(`${variant}: module-graph gate passed (${modules.length} emitted modules)`)
    },
  }
}
