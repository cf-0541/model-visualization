// Actual production build + existing UI. Stored reports are replay fixtures, not live browser C++ execution.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, preview } from 'vite'
import { chromium, firefox, webkit } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const temporary = mkdtempSync(join(tmpdir(), 'cpp-replay-e2e-'))
const engines = { chromium, firefox, webkit }
const requested = (process.env.CPP_BROWSERS ?? 'chromium').split(',')
let server
try {
  await build({ root, logLevel: 'error', build: { outDir: join(temporary, 'dist'), emptyOutDir: true } })
  server = await preview({ root, configFile: false, build: { outDir: join(temporary, 'dist') },
    preview: { host: '127.0.0.1', port: 0, strictPort: false } })
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`
  for (const engine of requested) {
    assert.ok(engines[engine], `Unknown browser ${engine}`)
    const browser = await engines[engine].launch({ headless: true,
      ...(engine === 'chromium' && process.platform === 'win32' ? { channel: process.env.CPP_CHROMIUM_CHANNEL ?? 'chrome' } : {}) })
    try {
      const page = await browser.newPage({ viewport: { width: Number(process.env.CPP_VIEWPORT_WIDTH ?? 1440), height: 1000 } })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(() => {
        window.__workerStarts = 0
        const NativeWorker = window.Worker
        window.Worker = class extends NativeWorker {
          constructor(...args) { super(...args); window.__workerStarts++ }
        }
      })
      await page.goto(url)
      const original = await page.getByRole('textbox', { name: '算法代码', exact: true }).inputValue()
      const upload = async (name, payload) => {
        const buffer = Buffer.from(payload ?? readFileSync(join(root, `src/examples/cpp/${name}.json`)))
        await page.getByLabel('C++ 轨迹 JSON', { exact: true }).setInputFiles({ name: `${name}.json`, mimeType: 'application/json', buffer })
      }
      const last = async () => {
        await page.getByRole('button', { name: '全程事件', exact: true }).click()
        const slider = page.getByRole('slider', { name: '执行时间轴' })
        await slider.focus()
        await slider.press('End')
      }
      for (const [name, model, expected] of [
        ['bubble', 'array', [1, 3, 5, 7]], ['vector', 'array', [2, 1, 3]],
        ['grid', 'dp', null], ['recursion', 'unknown', null],
      ]) {
        await upload(name)
        await page.waitForFunction(name => document.querySelector('.example-description')?.textContent?.includes(name) &&
          document.querySelector('.top-status')?.textContent?.includes('READY'), `${name}.cpp`)
        assert.equal(await page.getByRole('button', { name: 'C++ 仅支持导入回放' }).isDisabled(), true)
        assert.equal(await page.getByRole('button', { name: '分享链接' }).isDisabled(), true)
        await page.getByRole('tab', { name: '源码（只读）' }).click()
        assert.equal(await page.getByRole('textbox', { name: 'C++ 源码（只读）' }).getAttribute('readonly'), '')
        await page.getByRole('tab', { name: '执行轨迹', exact: true }).click()
        await last()
        await page.locator(`.scene-viewport.model-${model}`).waitFor()
        if (expected) {
          await page.waitForFunction(expected => JSON.stringify(Array.from(document.querySelectorAll('.array-value'), e => Number(e.textContent))) === JSON.stringify(expected), expected)
        }
        if (name === 'grid') {
          await page.locator('.dp-grid').waitFor()
          assert.deepEqual(await page.getByRole('gridcell').allTextContents(), ['1', '1', '1', '1', '2', '3', '1', '3', '6'])
        }
        if (name === 'recursion') assert.match(await page.locator('.footer-metrics').innerText(), /120/)
        if (name === 'bubble') {
          await page.getByRole('button', { name: '回到开头', exact: true }).click()
          await page.getByRole('button', { name: '播放', exact: true }).click()
          await page.waitForFunction(() => Number(document.querySelector('.timeline')?.value) > 0)
          await page.getByRole('button', { name: '暂停', exact: true }).click()
          await last()
          await page.waitForTimeout(600) // let bar/layout transitions settle before visual QA
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'No horizontal page overflow')
          if (process.env.CPP_SCREENSHOT) await page.screenshot({ path: process.env.CPP_SCREENSHOT, fullPage: true })
        }
        // Seeking back is a real UI action, then replay reaches the same terminal.
        await page.getByRole('button', { name: '回到开头', exact: true }).click()
        await last()
        assert.equal(await page.evaluate(() => window.__workerStarts), 0, 'Import must never start a JS Worker')
        console.log(`PASS ${engine}: ${name} import, model, final state, back-seek`)
      }
      // Failure does not replace the current replay with attacker-controlled source.
      await upload('invalid', '{"schemaVersion":2}')
      await page.getByRole('alert').filter({ hasText: 'C++ 轨迹无效' }).waitFor()
      assert.match(await page.locator('.example-description').innerText(), /recursion.cpp/)
      console.log(`PASS ${engine}: invalid import preserves previous replay`)

      const partial = JSON.parse(readFileSync(join(root, 'src/examples/cpp/bubble.json'), 'utf8'))
      partial.status = 'truncated'
      partial.reason = 'explicit test event limit'
      partial.events = partial.events.slice(0, 8)
      partial.events.push({ seq: 8, line: 1, type: 'error', message: partial.reason })
      await upload('partial', JSON.stringify(partial))
      await page.getByRole('status').filter({ hasText: 'C++ 轨迹未完成' }).waitFor()
      assert.match(await page.locator('.footer-metrics').innerText(), /未完成/)
      console.log(`PASS ${engine}: truncated report is never presented as success`)

      // Switching from C++ to JS must preserve the editor and still run real Worker code.
      await page.getByRole('button', { name: '返回 JavaScript' }).click()
      assert.equal(await page.getByRole('textbox', { name: '算法代码', exact: true }).inputValue(), original)
      await page.getByRole('textbox', { name: '算法代码', exact: true }).fill('function solve(a) { a[0] += 1; return a[0]; }')
      await page.locator('#algorithm-input').fill('[2]')
      await page.getByRole('button', { name: '运行并生成动画', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.top-status')?.textContent?.includes('READY'))
      assert.equal(await page.evaluate(() => window.__workerStarts), 1)
      assert.match(await page.locator('.footer-metrics').innerText(), /result\s+3/)
      console.log(`PASS ${engine}: return to JavaScript and execute Worker`)
      assert.deepEqual(errors, [])
      await page.close()
    } finally { await browser.close() }
  }
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve))
  // Only remove our explicitly owned mkdtemp directory, never a computed project path.
  assert.equal(dirname(temporary), tmpdir())
  rmSync(temporary, { recursive: true, force: true })
}
