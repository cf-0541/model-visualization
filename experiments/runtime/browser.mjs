// Real production UI/Worker resource-lifetime regression, trusted snippets only.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build, preview } from 'vite'
import { chromium, firefox, webkit } from 'playwright'

const root = resolve(import.meta.dirname, '../..')
const temporary = mkdtempSync(join(tmpdir(), 'runtime-ui-e2e-'))
const engines = { chromium, firefox, webkit }
const requested = (process.env.RUNTIME_BROWSERS ?? 'chromium').split(',')
let server
try {
  const outDir = join(temporary, 'dist')
  await build({ root, logLevel: 'error', build: { outDir, emptyOutDir: true } })
  server = await preview({ root, configFile: false, build: { outDir },
    preview: { host: '127.0.0.1', port: 0, strictPort: false } })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  for (const engine of requested) {
    assert.ok(engines[engine], `Unknown browser ${engine}`)
    // A requested engine must launch and pass. No silent fallback or skip.
    const browser = await engines[engine].launch({ headless: true,
      ...(engine === 'chromium' && process.platform === 'win32' ? { channel: 'chrome' } : {}) })
    try {
      for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        try {
          await page.addInitScript(() => {
            window.__runs = []
            const NativeWorker = window.Worker
            window.Worker = class extends NativeWorker {
              constructor(...args) {
                super(...args)
                this.record = { terminated: 0, response: null }
                window.__runs.push(this.record)
                this.addEventListener('message', event => { this.record.response = event.data })
              }
              terminate() { this.record.terminated++; super.terminate() }
            }
          })
          await page.goto(url)
          const editor = page.getByRole('textbox', { name: '算法代码', exact: true })
          const edit = async source => {
            await page.getByRole('tab', { name: '编辑', exact: true }).click()
            await editor.fill(source)
            await page.locator('#algorithm-input').fill('')
          }
          const start = async source => {
            await edit(source)
            const count = await page.evaluate(() => window.__runs.length)
            await page.getByRole('button', { name: '运行并生成动画', exact: true }).click()
            await page.waitForFunction(n => window.__runs.length > n, count)
            return count
          }
          const pending = 'async function solve() { await new Promise(() => {}); }'
          const complete = async value => {
            const index = await start(`function solve() { return ${value}; }`)
            await page.locator('.run-summary[data-completion="complete"]').waitFor()
            assert.match(await page.locator('.footer-metrics').innerText(), new RegExp(`result\\s+${value}`))
            const record = await page.evaluate(i => window.__runs[i], index)
            assert.equal(record.response.result, value)
            assert.equal(record.terminated, 1)
          }

          // Stop before the normal timeout, and then immediately start a fresh run.
          let index = await start(pending)
          await page.getByRole('button', { name: '停止当前任务', exact: true }).click()
          await page.waitForFunction(i => window.__runs[i].terminated === 1, index)
          assert.equal(await page.getByRole('alert').count(), 0)
          assert.match(await page.locator('.model-notice').innerText(), /已取消/)
          await complete(7)

          // Editing must terminate work, not merely ignore its eventual response.
          index = await start(pending)
          await editor.fill('function solve() { return 8; }')
          await page.waitForFunction(i => window.__runs[i].terminated === 1, index)
          assert.equal((await page.evaluate(i => window.__runs[i], index)).response, null)
          assert.equal(await page.getByRole('button', { name: '停止当前任务', exact: true }).count(), 0)

          // Selecting an example is a replacement run with a different Worker.
          index = await start(pending)
          const example = await page.locator('#example-select option').evaluateAll(options => options.find(option => option.value !== 'custom').value)
          await page.locator('#example-select').selectOption(example)
          await page.waitForFunction(i => window.__runs[i].terminated === 1 && window.__runs.length > i + 1 && window.__runs.at(-1).terminated === 1, index)
          await page.locator('.run-summary[data-completion="complete"]').waitFor()

          // A real timeout remains distinct from user cancellation, and recovery works.
          await start(pending)
          await page.getByRole('alert').filter({ hasText: /执行超过 2500ms.*未获得完整轨迹/ }).waitFor({ timeout: 10000 })
          await complete(9)

          // Large visual snapshots do not mean that the algorithm was interrupted.
          await start('function solve() { return Array(130).fill(1); }')
          const summary = page.locator('.run-summary')
          await page.locator('.run-summary[data-completion="complete"]').waitFor()
          assert.match(await summary.innerText(), /前 120 项/)
          await start('function solve() { for (let i = 0; i < 20000; i++) {} return 1; }')
          await page.locator('.run-summary[data-completion="incomplete"]').waitFor()
          assert.match(await summary.innerText(), /没有完整结果/)
          assert.match(await page.locator('.footer-metrics').innerText(), /未完成/)
          await complete(10)

          // Built-in reports are lazy data imports, never native/JS execution.
          const starts = await page.evaluate(() => window.__runs.length)
          const requests = []
          page.on('request', request => requests.push(request.url()))
          await page.locator('#cpp-example-select').selectOption('bubble')
          await page.waitForFunction(() => document.querySelector('.example-description')?.textContent?.includes('bubble.cpp'))
          assert.match(await page.locator('.model-notice').innerText(), /内置固定示例报告/)
          await page.getByRole('slider', { name: '执行时间轴', exact: true }).press('End')
          await page.waitForFunction(() => Array.from(document.querySelectorAll('.array-value'), node => node.textContent).join(',') === '1,3,5,7')
          assert.equal(await page.evaluate(() => window.__runs.length), starts)
          assert.equal(await page.getByRole('button', { name: 'C++ 仅支持导入回放', exact: true }).isDisabled(), true)
          assert.ok(requests.some(url => /bubble-.*\.js/.test(url)), 'Sample must load as a separate production asset')
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow')
          if (process.env.RUNTIME_SCREENSHOT && engine === requested[0]) {
            await page.screenshot({ path: process.env.RUNTIME_SCREENSHOT.replace('{width}', String(width)), fullPage: true })
          }
          await page.getByRole('button', { name: '返回 JavaScript', exact: true }).click()
          await complete(11)
          assert.deepEqual(errors, [])
          assert.ok(await page.evaluate(() => window.__runs.every(run => run.terminated === 1)), 'Every Worker must be terminated exactly once')
          console.log(`PASS ${engine}/${width}: stop, edit cancellation, replacement, timeout/recovery, snapshot/trace limits, lazy C++ sample, JS recovery`)
        } finally { await page.close() }
      }
    } finally { await browser.close() }
  }
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve))
  assert.equal(dirname(temporary), tmpdir())
  rmSync(temporary, { recursive: true, force: true })
}
