import assert from 'node:assert/strict'
import { createTraceRuntime, TraceLimitError } from '../../src/runtime/traceRuntime.ts'
import { instrumentLightweight } from './instrument.mjs'
import { analyzeSource as analyzeLight, argumentsFor as argumentsLight } from './sourceAnalysis.mjs'
import { parseInput as parseLight } from './parseInput.mjs'

// Fixed seed and bounded inputs make a failing differential case reproducible.
const SEED = 0x5eed1234
const CONDITIONS = [
  'item > 0', 'item % 2 === 0', 'i < values.length - 1',
  '(item ?? 0) >= 0', 'item + +item > 0', 'values?.[i] === item',
  'item ** 2 > 1', 'item > 1 && i < 2', 'item <= -1 || i === 0',
  'item in {0: true, 1: true}',
]
const EDGE_CONDITIONS = [
  'item / 2 > 1', 'item - -item > 0', 'typeof item === "number"',
  '[item][0] > 1', '({ value: item }).value >= 0',
  'item > (i ? 0 : -1)', '~item < 0',
  '(item > 0 ? item : i) >= 0', '/x/.test("x") && item >= 0',
  'Object.is(item, -0)', '`${item}` === "0"', 'item + 1_0 > 0',
  'item > 0 || item < -1', '(item | 1) > 0', 'item === 0 ? i > 0 : item > 1',
]
const BODIES = [
  'if (TEST) output.push(item + 1); else output.push(item - 1);',
  'output.push(TEST ? item : -item);',
  'if (TEST) { output.push(item); continue; } output.push(i);',
]
const SPECIAL = [
  ['tracked generator', `function solve(values) {
    const sequence = (function* () { for (const n of values) yield n * 2; })();
    const output = []; for (const value of sequence) output.push(value); return output;
  }`, [[2, 3]]],
  ['nested generator', `function solve(values) {
    const state = { iterator: (function* () { yield values[0]; })() };
    return state.iterator.next().value;
  }`, [[4]]],
  ['finally mutation', `function solve(values) {
    try { if (values[0] > 0) return values[0]; return 0; }
    finally { values[0] = 9; }
  }`, [[2]]],
  ['caught exception', `function solve(values) {
    try { if (values[0] < 0) throw new Error('negative'); }
    catch (error) { return error.message; }
    return 'positive';
  }`, [[-1]]],
  ['async all', `async function solve(values) {
    const jobs = values.map(async (value) => value + 1);
    const output = await Promise.all(jobs);
    return output;
  }`, [[1, 3]]],
  ['async rejection', `async function solve() { await Promise.resolve(); throw new Error('bad'); }`, []],
  ['async generator', `async function solve() {
    const iterator = (async function* () { yield 3; })();
    const first = await iterator.next(); return first.value;
  }`, []],
  ['async finally', `async function solve(values) {
    try { values.push(await Promise.resolve(4)); return values[0]; }
    finally { values.push(5); }
  }`, [[2]]],
  ['nested async closure', `async function solve(values) {
    const collect = async (value) => { const next = await Promise.resolve(value + 1); return next; };
    return await Promise.all(values.map(collect));
  }`, [[1, 2]]],
  ['generator delegation', `function solve(values) {
    function* collect() { yield* values; yield 5; }
    return [...collect()];
  }`, [[2, 3]]],
  ['rethrow finally', `function solve(values) {
    try { throw new Error('failure'); }
    finally { values.push(4); }
  }`, [[1]]],
  ['rest destructuring', `function solve({values, offset = 1}, ...extras) {
    let sum = 0; for (const item of values) sum += item;
    return sum + offset + extras.length;
  }`, [{ values: [1, 2] }, 4]],
  ['switch and labeled break', `function solve(values) {
    let answer = 0; outer: for (const item of values) {
      switch (item) { case 1: answer += 1; break; case 3: break outer; default: answer += item; }
    } return answer;
  }`, [[1, 2, 3, 4]]],
  ['async iteration cap', `async function solve(values) {
    await Promise.resolve(); while (true) { values.push(1); }
  }`, [[]], null, false, 4000, 3],
  ['script thrown exception', `const answer = (() => { throw new Error('script failed'); })();`, [], null, true],
  ['unicode bindings', `function solve(数值) { const 结果 = 数值 + 1; return 结果; }`, [2]],
  ['object spread and computed key', `function solve(value) { const result = { ...value, ["next"]: value.x + 1 }; return result.next; }`, [{ x: 2 }]],
  ['tagged template', 'function solve(value) { const tag = (parts, n) => parts[0] + n; return tag`x${value}`; }', [4]],
  ['private class field', `function solve(value) { class Box { #n = value; get() { return this.#n; } } return new Box().get(); }`, [5]],
  ['class static block', `function solve(value) { class Box { static { this.n = value; } } return Box.n; }`, [3]],
  ['getter and setter', `function solve(value) { const obj = { get x() { return value[0]; }, set x(next) { value[0] = next; } }; obj.x = obj.x + 1; return obj.x; }`, [[2]]],
  ['array destructuring default', `function solve(value) { const [first = 3, ...rest] = value; return first + rest.length; }`, [[undefined, 2, 4]]],
  ['named regex group', `function solve(value) { return /(?<n>\\d+)/.exec(value)?.groups?.n; }`, ['item42']],
  ['for await of', `async function solve(values) { const out = []; for await (const value of values) out.push(value + 1); return out; }`, [[2, 3]]],
  ['yield delegation', `function solve() { function* items() { yield* [1, 2]; } return [...items()]; }`, []],
  ['new target', `function solve() { function Box() { this.name = new.target?.name; } return new Box().name; }`, []],
  ['conditional optional call', `function solve(value) { const fn = value ? (n) => n + 1 : null; return fn?.(2) ?? 0; }`, [true]],
  ['script result', `function twice(n) { return n * 2; }
const answer = twice(3);`, [], null, true],
  ['script expression', `const answer = [2, 4].map((value) => value + 1);
answer;`, [], null, true],
]

async function execute(instrument, { source, args, entry = 'solve', script = false, maxEvents = 4000, maxIterations = 10000 }) {
  let transformed
  try {
    transformed = instrument(source, script)
  } catch (error) {
    return { phase: 'instrument', error: error.name }
  }
  const trace = createTraceRuntime(maxEvents, maxIterations)
  try {
    const returnCode = script ? `return ${transformed.scriptResult ?? 'undefined'};` : `return ${entry}(...__args);`
    const fn = new Function('__trace', '__args', `"use strict"; ${transformed.code}; ${returnCode}`)
    const result = await fn(trace, structuredClone(args))
    trace.complete(result, 1)
    return { phase: 'done', events: trace.getEvents() }
  } catch (error) {
    if (error instanceof TraceLimitError) trace.truncate(error.message)
    else trace.fail(error instanceof Error ? error.message : String(error))
    return { phase: 'error', error: error.name, events: trace.getEvents() }
  }
}

export async function verifyDifferential(instrumentCode, analyzeSource, argumentsFor, parseInput, workerUrl) {
  const cases = SPECIAL.map(([label, source, args, entry, script, maxEvents, maxIterations]) => ({ label, source, args, entry, script, maxEvents, maxIterations }))
  let state = SEED
  const seenConditions = new Set()
  const seenBodies = new Set()
  const seenLengths = new Set()
  const random = (max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % max
  }
  for (let index = 0; index < 120; index++) {
    const condition = CONDITIONS[random(CONDITIONS.length)]
    const body = BODIES[random(BODIES.length)].replaceAll('TEST', condition)
    const length = random(5)
    seenConditions.add(condition)
    seenBodies.add(body.replace(condition, "TEST"))
    seenLengths.add(length)
    const values = Array.from({ length }, () => random(7) - 3)
    const source = `function solve(values) {
  const output = [];
  for (let i = 0; i < values.length; i++) {
    const item = values[i];
    ${body}
  }
  return output;
}`
    cases.push({ label: `seed ${SEED.toString(16)} case ${index}`, source, args: [values] })
  }
  assert.equal(seenConditions.size, CONDITIONS.length, "Generator missed a condition")
  assert.equal(seenBodies.size, BODIES.length, "Generator missed a body")
  assert.equal(seenLengths.size, 5, "Generator missed an input size")
  // Cross product of statement/loop forms and short arrays. This probes AST
  // composition, not merely new spellings of conditions in the seeded loop.
  const loopForms = [
    'for (let i = 0; i < values.length; i++) visit(values[i], i);',
    'let i = 0; while (i < values.length) { visit(values[i], i); i++; }',
    'let i = 0; if (values.length) do { visit(values[i], i); i++; } while (i < values.length);',
    'let i = 0; for (const item of values) visit(item, i++);',
    'for (const key in values) visit(values[key], Number(key));',
  ]
  const visitForms = [
    'if (item > 0) output.push(item + i); else output.push(i - item);',
    'switch (item) { case 0: output.push(i); break; case 2: output.push(item); break; default: output.push(-item); }',
    'try { if (item < 0) throw new Error("negative"); output.push(item); } catch (error) { output.push(error.message); }',
    'const op = { step(n) { return n > 0 ? n : i; } }; output.push(op.step(item));',
    'const op = (n) => n >= 0 ? n : -n; output.push(op(item));',
  ]
  const lengths = [0, 1, 3]
  for (const [loopIndex, loop] of loopForms.entries()) {
    for (const [visitIndex, visit] of visitForms.entries()) {
      for (const length of lengths) {
        const values = [-1, 0, 2].slice(0, length)
        cases.push({
          label: `composition loop ${loopIndex} visit ${visitIndex} length ${length}`,
          source: `function solve(values) {
  const output = [];
  const visit = (item, i) => { ${visit} };
  ${loop}
  return output;
}`,
          args: [values],
        })
      }
    }
  }
  assert.equal(loopForms.length * visitForms.length * lengths.length, 75)
  for (const [index, condition] of EDGE_CONDITIONS.entries()) {
    cases.push({
      label: `edge expression ${index}: ${condition}`,
      source: `function solve(values) { const output = []; for (let i = 0; i < values.length; i++) { const item = values[i]; if (${condition}) output.push(item); else output.push(i); } return output; }`,
      args: [[-2, 0, 3]],
    })
  }
  cases.push({ label: 'event cap', source: 'function solve(values) { for (let i = 0; i < 30; i++) values.push(i); return values; }', args: [[]], maxEvents: 20 })
  cases.push({ label: 'iteration cap', source: 'function solve() { while (true) {} }', args: [], maxIterations: 3 })
  for (const test of cases) {
    const babel = await execute(instrumentCode, test)
    const pilot = await execute(instrumentLightweight, test)
    assert.deepEqual(pilot, babel, `${test.label}: differential mismatch\n${test.source}\nargs: ${JSON.stringify(test.args)}`)
    if (["async rejection", "event cap", "iteration cap", "async iteration cap", "rethrow finally", "script thrown exception"].includes(test.label)) {
      assert.equal(babel.phase, "error", `${test.label}: did not exercise the failure path`)
      assert.equal(babel.events.at(-1)?.type, "error")
    }
  }
  const workflows = [
    ['positional arguments', 'function add(a, b) { return a + b; }', '[2, 3]'],
    ['named arguments', 'function add(a, b = 3) { return a + b; }', '{a: 2, b: 4}'],
    ['helper selection', 'function helper(n) { return n * 2; } function main(value) { return helper(value); }', '4'],
    ['complete script', 'function square(n) { return n * n; } square(4);', ''],
    ['arrow script', 'const answer = [2, 4].map((n) => n + 1); answer;', ''],
    ['export declaration script', 'export function plus(n) { return n + 1; } const answer = plus(3);', ''],
    ['model comment', '// @model array\nfunction solve(values) { return values[0] + values[1]; }', '[3, 4]'],
    ['destructured named arg', 'function solve({ values, bonus = 0 }) { return values[0] + bonus; }', '{values: [3], bonus: 4}'],
    ['async entry', 'async function solve(n) { const value = await Promise.resolve(n); return value + 1; }', '3'],
  ]
  for (const [label, source, text] of workflows) {
    const babelInput = parseInput(text)
    const pilotInput = parseLight(text)
    assert.deepEqual(pilotInput, babelInput, `${label}: parsed input differs`)
    const babelAnalysis = analyzeSource(source)
    const pilotAnalysis = analyzeLight(source)
    assert.deepEqual(pilotAnalysis, babelAnalysis, `${label}: source analysis differs`)
    const babelArgs = argumentsFor(babelAnalysis, babelInput)
    const pilotArgs = argumentsLight(pilotAnalysis, pilotInput)
    assert.deepEqual(pilotArgs, babelArgs, `${label}: arguments differ`)
    const config = { source, args: babelArgs, entry: babelAnalysis.entry, script: babelAnalysis.script }
    assert.deepEqual(await execute(instrumentLightweight, config), await execute(instrumentCode, config),
      `${label}: paste-to-trace workflow differs`)
  }
  const previousSelf = globalThis.self
  let deliver = null
  const scope = {
    onmessage: null,
    postMessage(response) {
      if (!deliver) throw new Error('Unexpected Worker response')
      deliver(structuredClone(response))
      deliver = null
    },
  }
  globalThis.self = scope
  try {
    // Bundle the real Worker because its TypeScript imports are extensionless.
    await import(workerUrl)
    const runWorker = (instrument, test) => {
      const transformed = instrument(test.source, test.script ?? false)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker parity case did not settle')), 1000)
        deliver = (response) => { clearTimeout(timer); resolve(response) }
        scope.onmessage({ data: { code: transformed.code, args: structuredClone(test.args),
          entry: test.entry === undefined ? 'solve' : test.entry, scriptResult: transformed.scriptResult,
          maxEvents: test.maxEvents ?? 4000, maxIterations: test.maxIterations ?? 10000 } })
      })
    }
    const normalized = ({ duration, events, ...response }) => ({
      ...response, events: events.map((event) => event.type === 'done'
        ? { ...event, duration: '<elapsed>' } : event),
    })
    const workerLabels = ['tracked generator', 'async generator', 'async all', 'async rejection', 'script result',
      'event cap', 'iteration cap', 'async finally', 'nested async closure', 'generator delegation',
      'rethrow finally', 'rest destructuring', 'switch and labeled break', 'async iteration cap', 'script thrown exception']
    for (const label of workerLabels) {
      const test = cases.find((item) => item.label === label)
      assert.deepEqual(normalized(await runWorker(instrumentLightweight, test)),
        normalized(await runWorker(instrumentCode, test)), `${label}: real Worker response differs`)
    }
  } finally {
    if (previousSelf === undefined) delete globalThis.self
    else globalThis.self = previousSelf
  }
  console.log(`Seed ${SEED.toString(16)}: ${cases.length} bounded cases, ${workflows.length} paste workflows, and 15 Node-invoked Worker handler responses matched.`)
}
