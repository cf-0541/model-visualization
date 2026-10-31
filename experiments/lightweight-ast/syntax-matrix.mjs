import assert from 'node:assert/strict'
import { instrumentLightweight } from './instrument.mjs'
import { analyzeSource as analyzeLight } from './sourceAnalysis.mjs'
import { parseInput as parseLight } from './parseInput.mjs'

// These are explicitly bounded samples, not a claim of language-wide equivalence.
const accepted = [
  ['destructuring/rest/default', 'function solve({x = 2, ...rest}, ...items) { return x + items.length + Object.keys(rest).length; }'],
  ['optional chain/nullish', 'function solve(x) { return x?.a?.(2) ?? 0; }'],
  ['logical assignment', 'function solve(x) { x ||= 2; return x; }'],
  ['bigint and numeric separator', 'function solve() { return 1_000n + 2n; }'],
  ['regex and template', 'function solve(x) { return /[a-z]+/gi.test(`${x}`); }'],
  ['switch/try/catch', 'function solve(x) { try { switch(x) { case 1: return 3; default: throw new Error("x"); } } catch (e) { return e.message; } }'],
  ['labelled loop', 'function solve(x) { outer: for (;;) { break outer; } return x; }'],
  ['private field', 'function solve(n) { class C { #v = n; get value() { return this.#v; } } return new C().value; }'],
  ['class static block', 'function solve(n) { class C { static { this.v = n; } } return C.v; }'],
  ['async arrow', 'async function solve(x) { const f = async () => await x; return f(); }'],
  ['async generator', 'async function solve() { const f = async function* () { yield 1; }; return (await f().next()).value; }'],
  ['dynamic import', 'async function solve() { return (await import("data:text/javascript,export default 1")).default; }'],
  ['export declaration', 'export function solve(x) { return x; }'],
  ['nullish assignment', 'function solve(x) { return x ??= 2; }'],
  ['generator', 'function* solve() { yield 1; }'],
  ['no entry (instrumenter only)', 'const value = 1;'],
  ['unicode identifier', 'function solve(数值) { return 数值 + 1; }'],
  ['object spread/computed key', 'function solve(x) { return { ...x, ["y"]: 2 }; }'],
  ['tagged template', 'function solve(x) { const f = (parts, v) => parts[0] + v; return f`x${x}`; }'],
  ['new.target', 'function solve() { function Box() { return new.target?.name; } return new Box(); }'],
  ['yield delegation', 'function* solve() { yield* [1, 2]; }'],
  ['for await of', 'async function solve(values) { for await (const value of values) { if (value) return value; } }'],
  ['regular expression named group', 'function solve(x) { return /(?<n>\\d+)/.exec(x)?.groups?.n; }'],
  ['hashbang', '#!/usr/bin/env node\nfunction solve() { return 1; }'],
]
const rejected = [
  ['malformed binding', 'function solve() { const /x/ = 1; }'],
  ['incomplete initializer', 'function solve() { let x = ; }'],
  ['unbound private field', 'function solve() { return #x in this; }'],
  ['await in sync function', 'function solve() { await Promise.resolve(); }'],
  ['pipeline proposal', 'function solve(x) { return x |> f; }'],
  ['TypeScript', 'function solve(x: number) { return x; }'],
  ['JSX', 'function solve() { return <div/>; }'],
  ['module import', 'import x from "x"; function solve() { return x; }'],
  ['standalone export', 'export { solve }; function solve() { return 1; }'],
  ['default export', 'export default function solve() { return 1; }'],
  ['duplicate lexical binding', 'function solve() { const x = 1; const x = 2; }'],
  ['return outside function', 'return 1; function solve() {}'],
  ['optional chain assignment', 'function solve(x) { x?.a = 2; }'],
  ['with in module', 'function solve(x) { with (x) return 1; }'],
]
const inputAccepted = [
  '0', '-0', '1e3', 'null', 'undefined', '[1, 2, {a: 3}]',
  "{adj: [[1], [0]], start: 0, label: 'test'}", '(1, 2, 3)',
  '/* comment */ {x: +2, y: -3}', '[null, undefined, true]',
]
const inputRejected = [
  'globalThis.alert(1)', '{value: secret}', '1; doSomething()', '[1,,2]',
  '{__proto__: 1}', '{constructor: 1}', '{prototype: 1}', '{["x"]: 1}',
  '{...{x: 1}}', '[...[]]', '`${globalThis.alert(1)}`', '1 + 2',
  '/a/', 'new Date()', '(function(){ return 1 })()', '{a() { return 1 }}',
]

function outcome(fn) {
  try { return { ok: true, value: fn() } }
  catch (error) { return { ok: false, name: error.name, message: error.message } }
}

export function verifySyntaxMatrix(instrumentCode, analyzeSource, parseInput) {
  for (const [label, source, expected] of [...accepted.map(c => [...c, true]), ...rejected.map(c => [...c, false])]) {
    const original = outcome(() => instrumentCode(source))
    const pilot = outcome(() => instrumentLightweight(source))
    assert.equal(original.ok, expected, `${label}: Babel unexpected acceptance\n${source}\n${original.message ?? ''}`)
    assert.equal(pilot.ok, original.ok, `${label}: pilot differs from Babel\n${source}\nBabel: ${original.message}\nPilot: ${pilot.message}`)
    if (!original.ok) {
      // Exact parser messages/columns vary between Acorn and Babel; compare the
      // actual acceptance and failure category, not English parser wording.
      assert.equal(pilot.name, original.name, `${label}: error category differs\n${source}`)
      assert.ok(pilot.message, `${label}: empty pilot diagnostic`)
    }
  }
  for (const [label, source] of [
    ['import', 'import x from "x"; function solve() {}'],
    ['invalid model', '// @model trees\nfunction solve() {}'],
    ['model conflict', '// @model graph\nexport const __model = "array"; function solve() {}'],
    ['dynamic model', 'const __model = getModel(); function solve() {}'],
    ['invalid syntax', 'function solve( {'],
  ]) {
    const original = outcome(() => analyzeSource(source))
    const pilot = outcome(() => analyzeLight(source))
    assert.equal(original.ok, false, `${label}: source analysis unexpectedly accepted`)
    assert.equal(pilot.ok, false, `${label}: pilot source analysis unexpectedly accepted`)
    assert.equal(pilot.name, original.name, `${label}: source analysis error category differs`)
    assert.ok(pilot.message, `${label}: missing source analysis diagnostic`)
    if (label !== 'invalid syntax') assert.equal(pilot.message, original.message, `${label}: application diagnostic differs`)
  }
  for (const [text, expected] of [...inputAccepted.map(text => [text, true]), ...inputRejected.map(text => [text, false])]) {
    const original = outcome(() => parseInput(text))
    const pilot = outcome(() => parseLight(text))
    assert.equal(original.ok, expected, `Babel input unexpectedly ${expected ? 'rejected' : 'accepted'}: ${text}`)
    assert.equal(pilot.ok, original.ok, `Pilot input differs: ${text}\nBabel: ${original.message}\nPilot: ${pilot.message}`)
    if (expected) assert.deepEqual(pilot.value, original.value, `Input value differs: ${text}`)
    else {
      assert.equal(pilot.name, original.name, `Input error category differs: ${text}`)
      assert.match(pilot.message, /^输入格式无效：/, `Input lost user-facing diagnostic: ${text}`)
    }
  }
  console.log(`${accepted.length + rejected.length} source syntax/diagnostic, 5 analysis failures, and ${inputAccepted.length + inputRejected.length} input cases matched.`)
}
