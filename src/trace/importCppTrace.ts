import type { RunResult, RuntimeEvent } from '../types'

export const MAX_CPP_REPORT_BYTES = 8 * 1024 * 1024
export const CPP_REPLAY_NOTICE = 'C++ 实验轨迹回放（未在浏览器执行）：仅显示调试器行间采样；同行中间读写可能遗漏，写入行号为近似归属，return 的 null 表示未采集返回值。'

type Dict = Record<string, unknown>
type Sample = boolean | number | Sample[]

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`C++ 轨迹无效：${message}`)
}
function object(value: unknown): Dict {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), '应为对象')
  return value as Dict
}
function keys(value: Dict, expected: string[]) {
  check(Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)), '字段不匹配')
}
function integer(value: unknown, min: number, max: number): number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, '整数越界')
  return value
}
function text(value: unknown, max: number): string {
  check(typeof value === 'string' && value.length > 0 && value.length <= max, '文本长度不合法')
  return value
}
function identifier(value: unknown): string {
  const name = text(value, 65536)
  check(/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) && !['__proto__', 'prototype', 'constructor'].includes(name), '禁止的标识符')
  return name
}
function sample(value: unknown, budget = { remaining: 1024 }, depth = 0): Sample {
  check(--budget.remaining >= 0 && depth <= 3, '值超出快照预算')
  if (Array.isArray(value)) {
    check(value.length <= 120, '数组超过 120 项')
    return value.map(item => sample(item, budget, depth + 1))
  }
  if (typeof value === 'boolean') return value
  return integer(value, -2147483648, 4294967295)
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export interface ImportedCppTrace {
  source: string
  name: string
  status: 'complete' | 'error' | 'truncated'
  result: RunResult
}

/** Only versioned local debugger reports, never executable code or a JS parser. */
export function importCppTrace(json: string): ImportedCppTrace {
  check(json.length <= MAX_CPP_REPORT_BYTES && new TextEncoder().encode(json).length <= MAX_CPP_REPORT_BYTES, '文件超过 8 MiB')
  let decoded: unknown
  try { decoded = JSON.parse(json) } catch { throw new Error('C++ 轨迹无效：不是 JSON 文件') }
  const report = object(decoded)
  keys(report, ['schemaVersion', 'language', 'capture', 'status', 'reason', 'events', 'steps', 'limits', 'source'])
  check(report.schemaVersion === 1, '不支持的协议版本：仅接受 schemaVersion=1')
  check(report.language === 'cpp', '语言必须为 cpp')
  check(report.capture === 'debugger-line-sampling', '仅接受 debugger-line-sampling 行采样报告')
  check(report.status === 'complete' || report.status === 'error' || report.status === 'truncated', '未知完成状态')
  const status = report.status
  if (status === 'complete') check(report.reason === null, '完成状态不能带失败原因')
  else text(report.reason, 12000)
  const source = object(report.source)
  keys(source, ['name', 'text'])
  const name = text(source.name, 1024)
  const code = text(source.text, 65536)
  check(new TextEncoder().encode(code).length <= 65536 && code.split('\n').length <= 4096, '源码超过 64 KiB 或 4096 行')
  const maxLine = code.split('\n').length
  const limits = object(report.limits)
  keys(limits, ['maxSteps', 'maxEvents'])
  const maxSteps = integer(limits.maxSteps, 1, 5000)
  const maxEvents = integer(limits.maxEvents, 8, 10000)
  integer(report.steps, 0, maxSteps)
  check(Array.isArray(report.events) && report.events.length > 0 && report.events.length <= maxEvents, '事件数量越界')
  const values = new Map<string, Sample>()
  const stack: Array<{ name: string; callId: number; depth: number; args: Record<string, unknown> }> = []
  let lastCallId = 0
  // Charge values supplied by the report once, including patch before/after values.
  // Reconstructed states are validated separately against the per-snapshot limits.
  let valueNodes = 0
  const readSample = (value: unknown): Sample => {
    const budget = { remaining: 1024 }
    const parsed = sample(value, budget)
    valueNodes += 1024 - budget.remaining
    check(valueNodes <= 200000, '累计快照超过导入预算')
    return parsed
  }
  const events: RuntimeEvent[] = []
  for (const [seq, raw] of report.events.entries()) {
    try {
      const event = object(raw)
      check(event.seq === seq, '事件序号不连续')
      const line = integer(event.line, 0, maxLine)
      const base = { seq, line }
      const fields = (...names: string[]) => keys(event, ['seq', 'line', 'type', ...names])
      check(seq === report.events.length - 1 || (event.type !== 'done' && event.type !== 'error'), '终止事件必须在最后')
      switch (event.type) {
        case 'track': {
          fields('target', 'value')
          const target = identifier(event.target)
          check(!values.has(target) && values.size < 8, '重复或过多的追踪变量')
          const value = readSample(event.value)
          values.set(target, structuredClone(value))
          events.push({ ...base, type: 'track', target, value })
          break
        }
        case 'line':
          fields()
          events.push({ ...base, type: 'line' })
          break
        case 'write': {
          const patch = Object.hasOwn(event, 'arrayPatch')
          fields('target', 'path', ...(patch ? ['arrayPatch'] : ['before', 'after']))
          const target = identifier(event.target)
          check(values.has(target), '写入未追踪变量')
          check(Array.isArray(event.path) && event.path.length <= 3, '路径长度不合法')
          const path = event.path.map(part => integer(part, 0, 119))
          let current = values.get(target)!
          let parent: Sample[] | undefined
          for (const part of path) {
            check(Array.isArray(current) && part < current.length, '写入路径不存在')
            parent = current
            current = current[part]
          }
          if (patch) {
            const delta = object(event.arrayPatch)
            keys(delta, ['beforeLength', 'afterLength', 'changes'])
            const beforeLength = integer(delta.beforeLength, 0, 120)
            const afterLength = integer(delta.afterLength, 0, 120)
            check(Array.isArray(current) && current.length === beforeLength, '补丁初始长度不匹配')
            check(Array.isArray(delta.changes) && delta.changes.length <= 120, '补丁过大')
            const indices = new Set<number>()
            const changes = delta.changes.map(rawChange => {
              const change = object(rawChange)
              keys(change, ['index', 'beforePresent', 'afterPresent', 'before', 'after'])
              const index = integer(change.index, 0, Math.max(beforeLength, afterLength) - 1)
              check(!indices.has(index), '补丁索引重复')
              indices.add(index)
              check(change.beforePresent === (index < beforeLength) && change.afterPresent === (index < afterLength), '补丁存在标记不匹配')
              const before = change.beforePresent ? readSample(change.before) : null
              const after = change.afterPresent ? readSample(change.after) : null
              check(change.beforePresent || change.before === null, '缺失前值必须为 null')
              check(change.afterPresent || change.after === null, '缺失后值必须为 null')
              check(!change.beforePresent || equal(current[index], before), '补丁前值不匹配')
              return { index, beforePresent: index < beforeLength, afterPresent: index < afterLength, before, after }
            })
            for (let index = Math.min(beforeLength, afterLength); index < Math.max(beforeLength, afterLength); index++) {
              check(indices.has(index), '补丁缺少长度变化项')
            }
            for (const change of changes) if (change.afterPresent) current[change.index] = structuredClone(change.after!)
            current.length = afterLength
            // Revalidate total nesting/size after a patch, not just each changed leaf.
            // These values were already charged on input; do not charge them again.
            sample(values.get(target))
            events.push({ ...base, type: 'write', target, path, arrayPatch: { beforeLength, afterLength, changes } })
          } else {
            const before = readSample(event.before)
            const after = readSample(event.after)
            check(!Array.isArray(before) && !Array.isArray(after) && equal(current, before), '写入前值或类型不匹配')
            if (parent) parent[path[path.length - 1]] = after
            else values.set(target, after)
            events.push({ ...base, type: 'write', target, path, before, after })
          }
          break
        }
        case 'call':
        case 'return': {
          fields('name', 'callId', 'depth', 'args', ...(event.type === 'return' ? ['value'] : []))
          const name = text(event.name, 1024)
          const callId = integer(event.callId, 1, 10000)
          const depth = integer(event.depth, 0, 5000)
          const rawArgs = object(event.args)
          check(Object.keys(rawArgs).length <= 64, '参数过多')
          const args: Record<string, unknown> = {}
          for (const [key, rawValue] of Object.entries(rawArgs)) {
            identifier(key)
            const value = readSample(rawValue)
            check(!Array.isArray(value), '参数只能是标量')
            args[key] = value
          }
          if (event.type === 'call') {
            check(callId > lastCallId && depth === stack.length, '调用编号或深度不匹配')
            lastCallId = callId
            stack.push({ name, callId, depth, args })
            events.push({ ...base, type: 'call', name, callId, depth, args })
          } else {
            const call = stack.pop()
            check(call && call.name === name && call.callId === callId && call.depth === depth && equal(call.args, args), '返回与调用不匹配')
            check(event.value === null, '采样协议不提供函数返回值')
            events.push({ ...base, type: 'return', name, callId, depth, args, value: null })
          }
          break
        }
        case 'done': {
          fields('result', 'duration')
          check(status === 'complete' && stack.length === 0, '未完成的轨迹不能报告成功')
          let result: unknown
          if (event.result !== null && typeof event.result === 'object' && !Array.isArray(event.result)) {
            const exit = object(event.result)
            keys(exit, ['exitCode'])
            check(exit.exitCode === 0, '成功退出码必须为 0')
            result = { exitCode: 0 }
          } else result = readSample(event.result)
          check(typeof event.duration === 'number' && Number.isFinite(event.duration) && event.duration >= 0 && event.duration <= 120000, '耗时不合法')
          events.push({ ...base, type: 'done', result, duration: event.duration })
          break
        }
        case 'error':
          fields('message')
          check(status !== 'complete' && event.message === report.reason, '失败原因与状态不一致')
          events.push({ ...base, type: 'error', message: text(event.message, 12000) })
          break
        default:
          throw new Error('C++ 轨迹无效：不支持的采样事件')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^C\+\+ 轨迹无效：/, '') : '无效事件'
      throw new Error(`C++ 轨迹无效：第 ${seq + 1} 条事件（seq=${seq}）：${message}`)
    }
  }
  const terminal = events[events.length - 1]
  check(terminal.type === (status === 'complete' ? 'done' : 'error'), '缺少终止事件')
  return {
    source: code, name, status,
    result: {
      // Neutral metadata, NOT a claim that JavaScript analysis parsed C++.
      analysis: { entry: null, parameters: [], requiredParameters: 0, script: false, declaredModel: null, structure: null, reason: 'C++ 调试器轨迹；未进行源码结构分析' },
      events, result: terminal.type === 'done' ? terminal.result : undefined,
      duration: terminal.type === 'done' ? terminal.duration : 0,
      transformedCode: '',
      ...(status !== 'complete' ? { truncated: `C++ 轨迹未完成（${status}）：${report.reason}` } : {}),
    },
  }
}
