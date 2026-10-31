// Production-asset E2E: frozen Babel reference vs unaliased integrated app, actual UI/module Worker.
// This is a bounded parity gate, not a proof of equivalence or a sandbox test.
import assert from 'node:assert/strict'
import { astBuildVariant, variants } from './build-variants.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build, preview } from 'vite'
import { chromium, firefox, webkit } from 'playwright'

const root = resolve(import.meta.dirname, '../..')
const cases = [
  { label: 'array mutation', source: 'function solve(a) { a.push(3); return a; }', input: '[1, 2]', expected: [1, 2, 3] },
  { label: 'literal-only input', source: 'function solve(o) { return o.value[0] + 1; }', input: '{value: [2,],}', expected: 3 },
  { label: 'accessors', source: 'function solve(a) { const obj = { get x() { return a[0]; }, set x(n) { a[0] = n; } }; obj.x = obj.x + 1; return obj.x; }', input: '[2]', expected: 3 },
  { label: 'generator', source: 'function solve(a) { const g = (function* () { yield a[0]; })(); return g.next().value; }', input: '[4]', expected: 4 },
  { label: 'async', source: 'async function solve(a) { await Promise.resolve(); return a[0] + 1; }', input: '[5]', expected: 6 },
  { label: 'dynamic import', source: 'async function solve() { return (await import("data:text/javascript,export default 7")).default; }', input: '', expected: 7 },
  { label: 'script', source: 'const answer = [1, 2].map(x => x + 2); answer;', input: '', expected: [3, 4] },
]
const normalize = ({ duration, events, ...response }) => ({
  ...response, events: events.map(event => event.type === 'done' ? { ...event, duration: 0 } : event),
})
const temp = mkdtempSync(join(tmpdir(), 'ast-production-e2e-'))
const servers = []
try {
  const urls = {}
  for (const variant of variants) {
    const outDir = join(temp, variant)
    await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', plugins: [astBuildVariant(variant)],
      build: { outDir, emptyOutDir: true, sourcemap: false } })
    const server = await preview({ root, configFile: false, logLevel: 'error',
      build: { outDir }, preview: { host: '127.0.0.1', port: 0, strictPort: false } })
    servers.push(server)
    urls[variant] = `http://127.0.0.1:${server.httpServer.address().port}/`
  }

  for (const [engine, browserType] of Object.entries({ chromium, webkit, firefox })) {
    // No silent browser fallback: a missing engine fails this gate.
    const browser = await browserType.launch(engine === 'chromium' && process.platform === 'win32' ? { headless: true, channel: 'chrome' } : { headless: true })
    try {
      const results = {}
      for (const variant of variants) {
        const page = await browser.newPage()
        try {
          await page.addInitScript(() => {
            window.__workerRecords = []
            window.__workerStarts = 0
            const NativeWorker = window.Worker
            window.Worker = class extends NativeWorker {
              constructor(url, options) {
                if (!String(url).includes('/assets/') || options?.type !== 'module')
                  throw new Error('Expected built module Worker asset')
                super(url, options)
                window.__workerStarts += 1
                this.addEventListener('message', event => window.__workerRecords.push(event.data))
              }
            }
          })
          await page.goto(urls[variant])
          await page.locator('.code-editor').waitFor()
          results[variant] = []
          for (const test of cases) {
            await page.getByRole('tab', { name: '编辑' }).click()
            await page.getByRole('textbox', { name: '算法代码' }).fill(test.source)
            await page.locator('#algorithm-input').fill(test.input)
            const count = await page.evaluate(() => window.__workerRecords.length)
            await page.getByRole('button', { name: '运行并生成动画' }).click()
            await page.waitForFunction(n => window.__workerRecords.length > n, count, { timeout: 15000 })
            const response = await page.evaluate(n => window.__workerRecords[n], count)
            assert.equal(response.ok, true, `${engine}/${variant}/${test.label}: ${response.error}`)
            assert.deepEqual(response.result, test.expected, `${engine}/${variant}/${test.label}`)
            await page.waitForFunction(() => !document.querySelector('.run-button')?.disabled &&
              document.querySelector('.top-status')?.textContent?.includes('READY'))
            results[variant].push({ worker: normalize(response), notice: await page.locator('.model-notice').textContent() })
          }
          // Rejected source/input must fail before starting a Worker, without evaluating input.
          for (const test of [
            { label: 'static import', source: 'import x from "external"; function solve() { return x; }', input: '' },
            { label: 'TypeScript', source: 'function solve(x: number) { return x; }', input: '1' },
            { label: 'input expression', source: 'function solve(x) { return x; }', input: '({value: (globalThis.__astInputWasEvaluated = true)})' },
          ]) {
            await page.getByRole('tab', { name: '编辑' }).click()
            await page.getByRole('textbox', { name: '算法代码' }).fill(test.source)
            await page.locator('#algorithm-input').fill(test.input)
            const starts = await page.evaluate(() => window.__workerStarts)
            await page.getByRole('button', { name: '运行并生成动画' }).click()
            await page.getByRole('alert').waitFor({ timeout: 10000 })
            await page.waitForFunction(() => !document.querySelector('.run-button')?.disabled)
            assert.equal(await page.evaluate(() => window.__workerStarts), starts, `${engine}/${variant}/${test.label}: rejected before Worker`)
            assert.equal(await page.evaluate(() => '__astInputWasEvaluated' in window), false, `${engine}/${variant}: input must not execute`)
          }
          // UI timeout is the only backstop for eval bypassing loop instrumentation.
          await page.getByRole('tab', { name: '编辑' }).click()
          await page.getByRole('textbox', { name: '算法代码' }).fill('function solve() { eval("while (true) {}"); }')
          await page.locator('#algorithm-input').fill('')
          await page.getByRole('button', { name: '运行并生成动画' }).click()
          await page.getByRole('alert').filter({ hasText: /执行超过 2500ms，已终止/ }).waitFor({ timeout: 10000 })
          await page.getByRole('textbox', { name: '算法代码' }).fill('function solve() { return 7; }')
          const count = await page.evaluate(() => window.__workerRecords.length)
          await page.getByRole('button', { name: '运行并生成动画' }).click()
          await page.waitForFunction(n => window.__workerRecords.length > n, count, { timeout: 15000 })
          const recovery = await page.evaluate(n => window.__workerRecords[n], count)
          assert.equal(recovery.ok, true, `${engine}/${variant}: recovery Worker failed`)
          assert.equal(recovery.result, 7, `${engine}/${variant}: recovery after timeout`)
        } finally { await page.close() }
      }
      assert.deepEqual(results.production, results.baseline, `${engine}: production UI/Worker parity`)
      console.log(`${engine}: ${cases.length} production UI/Worker cases matched (Babel reference vs integrated production); 3 rejection cases and timeout/recovery passed in both variants`)
    } finally { await browser.close() }
  }
} finally {
  for (const server of servers) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
  if (dirname(temp) !== resolve(tmpdir())) throw new Error(`Unexpected temporary directory: ${temp}`)
  // Browser server handles may close asynchronously on Windows.
  for (let attempt = 0; attempt < 10; attempt++) {
    try { rmSync(temp, { recursive: true, force: true }); break }
    catch (error) { if (attempt === 9) throw error; await delay(200) }
  }
}
