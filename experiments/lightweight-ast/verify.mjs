import assert from 'node:assert/strict'
import { examples } from '../../src/examples.ts'
import { createTraceRuntime, TraceLimitError } from '../../src/runtime/traceRuntime.ts'
import { instrumentLightweight } from './instrument.mjs'
import { analyzeSource as analyzeLight, argumentsFor as argumentsLight } from './sourceAnalysis.mjs'
import { parseInput as parseLight } from './parseInput.mjs'
import { withBundles } from './measure.mjs'
import { verifyDifferential } from './differential.mjs'
import { verifySyntaxMatrix } from './syntax-matrix.mjs'

function run(instrument, source, args, script = false) {
  const { code, entry, scriptResult } = instrument(source, script)
  const trace = createTraceRuntime()
  const returnCode = script ? `return ${scriptResult ?? 'undefined'};` : `return ${entry}(...__args);`
  const execute = new Function('__trace', '__args', `"use strict"; ${code}; ${returnCode}`)
  const result = execute(trace, structuredClone(args))
  trace.complete(result, 1)
  return trace.getEvents()
}

async function runAwaited(instrument, source, args, entry) {
  const { code } = instrument(source)
  const trace = createTraceRuntime()
  const execute = new Function('__trace', '__args', `"use strict"; ${code}; return ${entry}(...__args);`)
  const result = await execute(trace, structuredClone(args))
  trace.complete(result, 1)
  return trace.getEvents()
}

await withBundles(async (babelBundles) => {
  const { instrumentCode } = await import(babelBundles['Babel (full instrumentCode)'])
  const { analyzeSource, argumentsFor } = await import(babelBundles['Babel sourceAnalysis'])
  const { parseInput } = await import(babelBundles['Babel parseInput'])
  function compare(label, source, args, entry, script = false) {
    const babelEvents = run((code, capture) => ({ ...instrumentCode(code, capture), entry }), source, args, script)
    const pilotEvents = run(instrumentLightweight, source, args, script)

    // Returned arrays are trace Proxies: reading them would itself append events.
    assert.deepEqual(pilotEvents.at(-1)?.result, babelEvents.at(-1)?.result, `${label}: result differs.`)
    assert.equal(pilotEvents.length, babelEvents.length,
      `${label}: event counts differ: pilot ${pilotEvents.length}, Babel ${babelEvents.length}`)
    for (let index = 0; index < pilotEvents.length; index += 1) {
      assert.deepEqual(pilotEvents[index], babelEvents[index],
        `${label}: event differs at index ${index}.`)
    }
    console.log(`${label}: ${pilotEvents.length} events matched`)
    return pilotEvents
  }
  async function compareAwaited(label, source, args, entry) {
    assert.deepEqual(analyzeLight(source), analyzeSource(source), `${label}: analysis differs.`)
    const babelEvents = await runAwaited((code) => instrumentCode(code), source, args, entry)
    const pilotEvents = await runAwaited(instrumentLightweight, source, args, entry)
    assert.deepEqual(pilotEvents, babelEvents, `${label}: awaited event trace differs.`)
    console.log(`${label}: ${pilotEvents.length} awaited events matched (instrumenter comparison outside the Worker)`)
  }

  for (const sample of examples) {
    const input = JSON.parse(sample.input)
    const args = ['bfs', 'two-sum'].includes(sample.id) ? input : [input]
    const entry = sample.id === 'bfs' ? 'bfs' : sample.id === 'two-sum' ? 'twoSum' : 'solve'
    assert.deepEqual(analyzeLight(sample.code), analyzeSource(sample.code), `${sample.id}: analysis differs.`)
    assert.deepEqual(argumentsLight(analyzeLight(sample.code), input), argumentsFor(analyzeSource(sample.code), input),
      `${sample.id}: argument mapping differs.`)
    assert.deepEqual(parseLight(sample.input), parseInput(sample.input), `${sample.id}: input parsing differs.`)
    const events = compare(sample.id, sample.code, args, entry)
    assert.ok(events.some((event) => event.type === 'return'), `${sample.id}: no returns`)
  }

  const cases = [
    ['recursive helper', `function solve(n) {
  function sum(value) {
    if (value === 0) return 0;
    return value + sum(value - 1);
  }
  return sum(n);
}`, [4], 'solve'],
    ['arrow and ternary', `const solve = (nums) => nums.length > 1 ? nums[0] : 0;`, [[5, 7]], 'solve'],
    ['for-in and do-while', `function solve(values) {
  let total = 0;
  for (const key in values) total += values[key];
  do { total--; } while (total > 4);
  return total;
}`, [{ a: 2, b: 3 }], 'solve'],
    ['script expression', `function total(items) { return items[0] + items[1]; }
const values = [2, 4];
total(values);`, [], null, true],
    ['script assignment', `function total(a, b) { return a + b; }
const answer = total(2, 4);`, [], null, true],
    ['script arrow callback', `const answer = [2, 4].reduce((a, b) => a + b);`, [], null, true],
    ['script name collision', `const __traceScriptResult = 1;
function foo() { return 7; }
foo();`, [], null, true],
    ['script export', `function foo() { return 7; }
export const answer = foo();`, [], null, true],
    ['model declaration', `export const __model = 'graph';
function bfs(adj, start) { return adj[start]; }`, [[[1], [0]], 0], 'bfs'],
    ['try catch', `function solve(n) {
  try { if (n < 0) throw new Error('negative'); return n + 1; }
  catch (error) { return 0; }
}`, [-1], 'solve'],
    ['try finally', `function solve(values) {
  try { values.push(3); return values.length; }
  finally { values.push(4); }
}`, [[1, 2]], 'solve'],
    ['switch fallthrough', `function solve(n) {
  let result = 0;
  switch (n) { case 1: result++; case 2: result += 2; break; default: result = -1; }
  return result;
}`, [1], 'solve'],
    ['class method', `class Counter {
  constructor(n) { this.value = n; }
  inc() { return ++this.value; }
}
function solve(n) { const counter = new Counter(n); return counter.inc(); }`, [2], 'solve'],
    ['optional chaining', `function solve(obj) {
  return obj?.next?.value ?? 0;
}`, [{next: {value: 4}}], 'solve'],
    ['optional chaining null', `function solve(obj) { return obj?.next?.value ?? 0; }`, [null], 'solve'],
    ['class fields', `class Counter { value = 3; add(n) { return this.value + n; } }
function solve(n) { return new Counter().add(n); }`, [2], 'solve'],
    ['template and regex', `function solve(text) { if (/a+/.test(text)) return ` + '`found ${text}`' + `; return 'none'; }`, ['aa'], 'solve'],
    ['catch destructuring', `function solve(obj) {
  try { throw {value: obj.value}; } catch ({value}) { return value; }
}`, [{value: 3}], 'solve'],
    ['labeled loop', `function solve(n) {
  let total = 0;
  outer: for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { total++; break outer; } }
  return total;
}`, [3], 'solve'],
    ['object method', `function solve(n) {
  const obj = { add(value) { return value + 1; } };
  return obj.add(n);
}`, [4], 'solve'],
    ['private class field', `class Counter {
  #value = 2;
  getValue() { return this.#value; }
}
function solve() { return new Counter().getValue(); }`, [], 'solve'],
    ['class static block', `class Counter { static value; static { this.value = 3; } }
function solve() { return Counter.value; }`, [], 'solve'],
    ['private field branch', `class Counter { #value = 3; isPositive() { if (this.#value > 0) return true; return false; } }
function solve() { return new Counter().isPositive(); }`, [], 'solve'],
    ['destructuring defaults', `function solve({ values, add = 0 }, ...rest) {
  return values[0] + add + rest.length;
}`, [{ values: [2] }, 9], 'solve'],
    ['generator yield', `function solve(n) {
  return (function* sequence(value) { if (value > 0) yield value; return 0; })(n).next().value;
}`, [3], 'solve'],
    ['compact lexical boundaries', `function solve(x) {
  if (typeof x === 'number' && x + +x > 0 && x - -x > 0 && /a+/.test('aa')) return 1;
  return 0;
}`, [2], 'solve'],
    ['compact parentheses and template', `function solve(obj) {
  if ((obj?.value ?? 0) > 2 && (obj.value in {3: true}) && ` + '`n ${obj.value}`' + `.length > 0) return 1;
  return 0;
}`, [{value: 3}], 'solve'],
    ['compact comments and numeric separators', `function solve(n) {
  if ((n/* note */ + 1) > 1_000 || (n in {42: true})) return 1;
  return 0;
}`, [42], 'solve'],
    ['compact precedence and literals', `function solve(n) {
  if (n ** (1 + 1) > 0 && n === 'a b' || n instanceof Number) return true;
  return false;
}`, [2], 'solve'],
  ]
  for (const [label, source, args, entry, script] of cases) {
    assert.deepEqual(analyzeLight(source), analyzeSource(source), `${label}: analysis differs.`)
    compare(label, source, args, entry, script)
  }

  await compareAwaited('async await', `async function solve(n) {
    const value = await Promise.resolve(n);
    if (await Promise.resolve(value > 0)) return value + 1;
    return 0;
  }`, [2], 'solve')
  await compareAwaited('dynamic import', `async function solve() {
    if ((await import('data:text/javascript,export default 7')).default === 7) return 7;
    return 0;
  }`, [], 'solve')

  const analysisCases = [
    '// @model graph\nfunction walk(g) { return g; }',
    'function fib(n) { const states = Array(n + 1).fill(0); states[0] = 0; states[1] = 1; for (let i = 2; i <= n; i++) states[i] = states[i - 1] + states[i - 2]; return states[n]; }',
    'function calculate(nums) { const states = Array(nums.length).fill(0); states[0] = nums[0]; for (let i = 1; i < nums.length; i++) states[i] = states[i - 1] + nums[i]; return states[nums.length - 1]; }',
    'function bfs(adj, start) {}',
    'function add(a, b = 2) { return a + b; }',
    'function helper(x) { return x; } function main(y) { return helper(y); }',
    'function solve(...values) { return values.length; }',
    'class Helper { run(x) { return x; } } function solve(n) { return new Helper().run(n); }',
    'function solve(obj = {}) { return obj?.value ?? 1; }',
    'function helper(x) { return x; } const run = (value) => helper(value);',
    'const fn = function named(x) { return x; };',
    'export function solve({a, b = 1}, ...rest) { return a + b + rest.length; }',
    'const answer = 3; answer;',
    "export const __model = 'dp'; function solve({values}) { return values; }",
  ]
  for (const source of analysisCases) assert.deepEqual(analyzeLight(source), analyzeSource(source), `Analysis differs: ${source}`)

  const mappingCases = [
    ['function sum(a, b = 3) { return a + b; }', [2], [2, undefined]],
    ['function sum(a, b = 3) { return a + b; }', {a: 2}, [2, undefined]],
    ['function sum(a, b = 3) { return a + b; }', {a: 2, b: 4}, [2, 4]],
    ['function sum(a, b = 3) { return a + b; }', {a: 1, b: 2, c: 3}, [1, 2]],
    ['function solve({a}, b) { return a + b; }', [{a: 2}, 4], [{a: 2}, 4]],
    ['function solve(value) { return value; }', [1, 2], [[1, 2]]],
    ['const output = 3;', [], []],
  ]
  for (const [source, input, expected] of mappingCases) {
    const light = analyzeLight(source)
    const babel = analyzeSource(source)
    assert.deepEqual(light, babel, `Mapping analysis differs: ${source}`)
    assert.deepEqual(argumentsLight(light, input), expected, `Mapping result differs: ${source}`)
    assert.deepEqual(argumentsLight(light, input), argumentsFor(babel, input), `Mapping differs: ${source}`)
  }
  for (const input of [[], [1, 2, 3], {b: 3}]) {
    const source = 'function sum(a, b = 3) { return a + b; }'
    assert.throws(() => argumentsLight(analyzeLight(source), input))
    assert.throws(() => argumentsFor(analyzeSource(source), input))
  }

  const inputCases = [
    '', '0', '-2', 'null', 'true', 'undefined', '[1, 2, {a: 3}]',
    "{adj: [[1], [0]], start: 0, label: 'test'}", '(1, 2, 3)',
    '{42: 1, "safe-key": -3, nested: {ok: true}}', '[+3, -0, 1e3]',
    '/* comment */ [1, 2]', '({a: 1})', '"escaped\\ntext"',
  ]
  for (const text of inputCases) assert.deepEqual(parseLight(text), parseInput(text), `Input differs: ${text}`)
  for (const text of ['globalThis.alert(1)', '{value: secret}', '1; doSomething()', '[1,,2]', '{__proto__: 1}',
    '{constructor: 1}', '{prototype: 1}', '{["x"]: 1}', '{...{x: 1}}', '[...[]]',
    '`${globalThis.alert(1)}`', '1 + 2', '/a/', 'new Date()', '(function(){ return 1 })()',
    '{a() { return 1 }}']) {
    assert.throws(() => parseLight(text), /输入/)
    assert.throws(() => parseInput(text), /输入/)
  }
  for (const source of ['// @model invalid\nfunction x() {}', 'export const __model = 3; function x() {}', "import x from 'x';"]) {
    assert.throws(() => analyzeLight(source))
    assert.throws(() => analyzeSource(source))
  }

  const collision = run(instrumentLightweight,
    'function solve(values) { const _traceCallId = 7; values[0] = _traceCallId; return values; }', [[0]])
  assert.deepEqual(collision.at(-1)?.result, [7])
  assert.equal(collision.filter((event) => event.type === 'return').length, 1)
  assert.deepEqual(instrumentLightweight('const value = 1;').entry, instrumentCode('const value = 1;').entry)

  const emptyLoop = instrumentLightweight('function solve(value) { for (;;) ; }')
  const trace = createTraceRuntime(100, 3)
  assert.throws(() => new Function('__trace', '"use strict"; ' + emptyLoop.code + '; return solve(0);')(trace), TraceLimitError)
  verifySyntaxMatrix(instrumentCode, analyzeSource, parseInput)
  await verifyDifferential(instrumentCode, analyzeSource, argumentsFor, parseInput, babelBundles['Worker runtime'])
  console.log(`All ${examples.length} bundled examples and ${cases.length} additional snippets matched production event traces and result snapshots.`)
})
