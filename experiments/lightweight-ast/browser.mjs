// Local browser E2E probe: real Chrome module Worker, real postMessage/structured cloning.
// Run explicitly with `pnpm pilot:browser`; never silently substitute Node stubs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { instrumentLightweight } from './instrument.mjs'
import { withBundles } from './measure.mjs'

const tests = [
  { label: 'sync mutation', source: 'function solve(a) { a.push(3); return a; }', args: [[1, 2]] },
  { label: 'generator', source: 'function solve(a) { const g = (function* () { yield a[0]; })(); return g.next().value; }', args: [[4]] },
  { label: 'nested async', source: 'async function solve(a) { const g = (async function* () { yield await Promise.resolve(a[0]); })(); return (await g.next()).value; }', args: [[6]] },
  { label: 'rejection', source: "async function solve() { await Promise.resolve(); throw new Error('browser failure'); }", args: [] },
  { label: 'script', source: 'const answer = [1, 2].map(x => x + 2); answer;', args: [], script: true },
  { label: 'event cap', source: 'function solve(a) { for (let i = 0; i < 20; i++) a.push(i); return a; }', args: [[]], maxEvents: 20 },
  { label: 'iteration cap', source: 'function solve() { while (true) {} }', args: [], maxIterations: 3 },
  { label: 'async finally', source: 'async function solve(a) { try { a.push(await Promise.resolve(4)); return a[0]; } finally { a.push(5); } }', args: [[2]] },
  { label: 'async iteration cap', source: 'async function solve(a) { await Promise.resolve(); while (true) { a.push(1); } }', args: [[]], maxIterations: 3 },
  { label: 'dynamic import', source: 'async function solve() { return (await import("data:text/javascript,export default 7")).default; }', args: [] },
  { label: 'script failure', source: 'const answer = (() => { throw new Error("script failed"); })();', args: [], script: true },
  { label: 'unbounded timeout', source: 'function solve() { eval("while (true) {}"); }', args: [], timeout: true },
  { label: 'missing entry', source: 'function solve() { return 1; }', args: [], entry: 'missing' },
]

function browserPath() {
  const candidates = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find(path => path && existsSync(path))
}

async function runBrowser(workerBundle, payload) {
  const profile = mkdtempSync(join(tmpdir(), 'ast-pilot-browser-'))
  const portFile = join(profile, 'DevToolsActivePort')
  const html = `<!doctype html><meta charset="utf-8"><script type="module">
    const tests = ${JSON.stringify(payload).replaceAll('<', '\\u003c')};
    window.browserResults = (async () => {
      const output = [];
      for (const test of tests) {
        const worker = new Worker('/runner.js', { type: 'module' });
        try {
          const response = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Worker timed out: ' + test.label)), test.timeout ? 300 : 10000);
            worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
            worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message || 'Worker error')); };
            worker.postMessage(test.request);
          });
          output.push({ label: test.label, variant: test.variant, response });
        } catch (error) {
          if (!test.timeout) throw new Error(test.variant + ' ' + test.label + ': ' + error.message);
          output.push({ label: test.label, variant: test.variant, timeout: error.message });
        } finally { worker.terminate(); }
      }
      return output;
    })();
  </script>`
  const server = createServer((request, response) => {
    if (request.url === '/runner.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      response.end(workerBundle)
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(html)
    }
  })
  let browser, socket
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const chrome = browserPath()
    if (!chrome) throw new Error('No Chrome/Edge executable found; set CHROME_PATH to a Chromium browser.')
    browser = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let port
    for (let i = 0; i < 100; i++) {
      if (existsSync(portFile)) { port = Number(readFileSync(portFile, 'utf8').split('\n')[0]); break }
      if (browser.exitCode !== null) throw new Error(`Browser exited early: ${browser.exitCode}`)
      await delay(100)
    }
    if (!port) throw new Error('Browser did not open a DevTools port.')
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const tab = tabs.find(item => item.type === 'page')
    if (!tab) throw new Error('Browser did not create a page.')
    socket = new WebSocket(tab.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let id = 0
    const pending = new Map()
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (!message.id) return
      const task = pending.get(message.id)
      if (!task) return
      pending.delete(message.id)
      if (message.error) task.reject(new Error(JSON.stringify(message.error)))
      else task.resolve(message.result)
    }
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id
      pending.set(requestId, { resolve, reject })
      socket.send(JSON.stringify({ id: requestId, method, params }))
    })
    await cdp('Page.enable')
    await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
    // The page registers its promise synchronously in a module script, after navigation.
    let ready = false
    for (let i = 0; i < 100; i++) {
      const probe = await cdp('Runtime.evaluate', { expression: 'typeof window.browserResults' })
      if (probe.result?.value === 'object') { ready = true; break }
      await delay(100)
    }
    if (!ready) throw new Error('Browser harness did not initialize.')
    const result = await Promise.race([
      cdp('Runtime.evaluate', { expression: 'window.browserResults', awaitPromise: true, returnByValue: true }),
      delay(60000, undefined, { ref: false }).then(() => { throw new Error('Browser E2E timed out.') }),
    ])
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description)
    return result.result.value
  } finally {
    socket?.close()
    browser?.kill()
    await new Promise(resolve => server.close(resolve))
    if (dirname(profile) !== resolve(tmpdir())) throw new Error(`Unexpected temporary profile: ${profile}`)
    // Browser shutdown can be asynchronous on Windows; retry only this uniquely owned profile.
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); break }
      catch (error) { if (attempt === 9) throw error; await delay(200) }
    }
  }
}

await withBundles(async bundles => {
  const { instrumentCode } = await import(bundles['Babel (full instrumentCode)'])
  const workerBundle = readFileSync(fileURLToPath(bundles['Worker runtime']), 'utf8')
  const payload = tests.flatMap(test => [
    ['Babel', instrumentCode], ['pilot', instrumentLightweight],
  ].map(([variant, instrument]) => {
    const transformed = instrument(test.source, test.script ?? false)
    return { label: test.label, variant, timeout: test.timeout ?? false, request: {
      code: transformed.code, args: test.args, entry: test.script ? null : (test.entry ?? 'solve'),
      scriptResult: transformed.scriptResult, maxEvents: test.maxEvents ?? 4000,
      maxIterations: test.maxIterations ?? 10000,
    } }
  }))
  const results = await runBrowser(workerBundle, payload)
  assert.equal(results.length, payload.length)
  const normalize = ({ duration, events, ...response }) => ({
    ...response, events: events.map(event => event.type === 'done' ? { ...event, duration: '<elapsed>' } : event),
  })
  for (let i = 0; i < results.length; i += 2) {
    const babel = results[i], pilot = results[i + 1]
    assert.equal(babel.label, pilot.label)
    if (babel.label === 'unbounded timeout') {
      assert.match(babel.timeout, /Worker timed out/)
      assert.match(pilot.timeout, /Worker timed out/)
      continue
    }
    assert.deepEqual(normalize(pilot.response), normalize(babel.response), `${babel.label}: browser Worker mismatch`)
    if (['event cap', 'iteration cap', 'async iteration cap'].includes(babel.label)) assert.match(babel.response.truncated, /上限/)
    if (['rejection', 'missing entry', 'script failure'].includes(babel.label)) assert.equal(babel.response.ok, false)
  }
  console.log(`${tests.length} paired cases matched inside a real Chromium module Worker.`)
})
