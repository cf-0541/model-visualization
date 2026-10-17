import type {
  RuntimeEvent,
  TracePath,
  TraceRuntime,
} from '../types'

interface ProxyMeta {
  target: string
  path: TracePath
  raw: object
}

interface RuntimeCall {
  callId: number
  name: string
  depth: number
  args: Record<string, unknown>
}

const MAX_SNAPSHOT_DEPTH = 7
export const MAX_COLLECTION_SIZE = 120
const MAX_SNAPSHOT_NODES = 512
const MAX_TRACKED_TARGETS = 12
export const DEFAULT_MAX_EVENTS = 4_000
export const DEFAULT_MAX_ITERATIONS = 10_000

type RuntimeEventInput = {
  [Kind in RuntimeEvent['type']]: Omit<Extract<RuntimeEvent, { type: Kind }>, 'seq'>
}[RuntimeEvent['type']]

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function displayKey(key: PropertyKey): string | number | null {
  if (typeof key === 'symbol') return null
  const text = String(key)
  if (/^(0|[1-9]\d*)$/.test(text)) return Number(text)
  return text
}

export class TraceLimitError extends Error {
  constructor(limit: number, kind: 'events' | 'iterations' = 'events') {
    super(kind === 'events'
      ? `已达 ${limit.toLocaleString()} 条事件上限，轨迹已截断；算法尚未完成。请缩小输入规模。`
      : `已达 ${limit.toLocaleString()} 次循环迭代上限，轨迹已截断；算法尚未完成。`)
    this.name = 'TraceLimitError'
  }
}

export function createTraceRuntime(maxEvents = DEFAULT_MAX_EVENTS, maxIterations = DEFAULT_MAX_ITERATIONS): TraceRuntime {
  maxEvents = Number.isFinite(maxEvents) ? Math.min(DEFAULT_MAX_EVENTS, Math.max(2, Math.floor(maxEvents))) : DEFAULT_MAX_EVENTS
  maxIterations = Number.isFinite(maxIterations) ? Math.min(DEFAULT_MAX_ITERATIONS, Math.max(1, Math.floor(maxIterations))) : DEFAULT_MAX_ITERATIONS
  const events: RuntimeEvent[] = []
  const proxyMeta = new WeakMap<object, ProxyMeta>()
  const proxyCache = new WeakMap<object, Map<string, object>>()
  const trackedNames = new WeakMap<object, Set<string>>()
  const trackedTargets = new Set<string>()
  const callStack: RuntimeCall[] = []

  let currentLine = 1
  let nextCallId = 1
  let iterations = 0

  const snapshot = (
    input: unknown,
    depth = 0,
    seen = new WeakSet<object>(),
    budget = { remaining: MAX_SNAPSHOT_NODES },
  ): unknown => {
    if (budget.remaining-- <= 0) return '[…]'
    if (input === undefined) return 'undefined'
    if (input === null || typeof input === 'string' || typeof input === 'boolean') {
      return input
    }
    if (typeof input === 'number') {
      return Number.isFinite(input) ? input : String(input)
    }
    if (typeof input === 'bigint') return `${input.toString()}n`
    if (typeof input === 'function') return `[Function ${input.name || 'anonymous'}]`
    if (!isObject(input)) return String(input)

    const raw = proxyMeta.get(input)?.raw ?? input
    if (depth >= MAX_SNAPSHOT_DEPTH) return '[…]'
    if (seen.has(raw)) return '[Circular]'
    seen.add(raw)

    if (Array.isArray(raw)) {
      const values = raw
        .slice(0, MAX_COLLECTION_SIZE)
        .map((value) => snapshot(value, depth + 1, seen, budget))
      if (raw.length > MAX_COLLECTION_SIZE) values.push(`… +${raw.length - MAX_COLLECTION_SIZE}`)
      return values
    }

    const output: Record<string, unknown> = {}
    let count = 0
    for (const key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
      if (count++ >= MAX_COLLECTION_SIZE) {
        output['…'] = 'truncated'
        break
      }
      output[key] = snapshot((raw as Record<string, unknown>)[key], depth + 1, seen, budget)
    }
    return output
  }

  const ensureCapacity = (): void => {
    if (events.length >= maxEvents) throw new TraceLimitError(maxEvents)
  }

  const emit = (event: RuntimeEventInput): void => {
    ensureCapacity()
    events.push({ ...event, seq: events.length } as RuntimeEvent)
  }

  const proxyFor = <T extends object>(rawValue: T, target: string, path: TracePath): T => {
    const unwrapped = proxyMeta.get(rawValue)?.raw ?? rawValue
    const cacheKey = `${target}:${path.map(String).join('.')}`
    let cache = proxyCache.get(unwrapped)
    if (!cache) {
      cache = new Map()
      proxyCache.set(unwrapped, cache)
    }
    const cached = cache.get(cacheKey)
    if (cached) return cached as T

    const proxy = new Proxy(unwrapped, {
      get(raw, key, receiver) {
        const value = Reflect.get(raw, key, receiver)
        const part = displayKey(key)
        if (part === null || key === 'length' || typeof value === 'function') return value

        const nextPath = [...path, part]
        if (isObject(value)) return proxyFor(value, target, nextPath)

        ensureCapacity()
        emit({
          type: 'read',
          line: currentLine,
          target,
          path: nextPath,
          value: snapshot(value),
        })
        return value
      },
      set(raw, key, value, receiver) {
        const part = displayKey(key)
        if (part !== null) ensureCapacity()
        const before = Reflect.get(raw, key, receiver)
        const unwrappedValue = isObject(value) ? proxyMeta.get(value)?.raw ?? value : value
        const ok = Reflect.set(raw, key, unwrappedValue, receiver)

        if (ok && part !== null) {
          emit({
            type: 'write',
            line: currentLine,
            target,
            path: [...path, part],
            before: snapshot(before),
            after: snapshot(unwrappedValue),
          })
        }
        return ok
      },
    })

    proxyMeta.set(proxy, { target, path, raw: unwrapped })
    cache.set(cacheKey, proxy)
    return proxy as T
  }

  const runtime: TraceRuntime = {
    line(line) {
      currentLine = line
      emit({ type: 'line', line })
    },

    iteration(line) {
      currentLine = line
      if (++iterations > maxIterations) throw new TraceLimitError(maxIterations, 'iterations')
    },

    track(name, value, line = currentLine) {
      currentLine = line
      if (!isObject(value)) return value
      if (!trackedTargets.has(name)) {
        if (trackedTargets.size >= MAX_TRACKED_TARGETS) return value
        trackedTargets.add(name)
      }

      const raw = proxyMeta.get(value)?.raw ?? value
      let names = trackedNames.get(raw)
      if (!names) {
        names = new Set()
        trackedNames.set(raw, names)
      }

      const alreadyTracked = names.has(name)
      names.add(name)
      const proxy = proxyFor(raw, name, [])

      if (!alreadyTracked) {
        ensureCapacity()
        emit({
          type: 'track',
          line,
          target: name,
          value: snapshot(raw),
        })
      }
      return proxy as typeof value
    },

    call(name, args, line) {
      currentLine = line
      ensureCapacity()
      const callId = nextCallId++
      const depth = callStack.length
      const safeArgs = snapshot(args) as Record<string, unknown>
      const frame = { callId, name, depth, args: safeArgs }
      callStack.push(frame)
      emit({ type: 'call', line, ...frame })
      return callId
    },

    ret(name, value, line, callId) {
      currentLine = line
      ensureCapacity()
      let index = -1
      for (let cursor = callStack.length - 1; cursor >= 0; cursor -= 1) {
        if (callStack[cursor].callId === callId) {
          index = cursor
          break
        }
      }
      const frame = index >= 0 ? callStack[index] : undefined
      const depth = frame?.depth ?? Math.max(0, callStack.length - 1)
      const args = frame?.args ?? {}
      emit({
        type: 'return',
        line,
        name,
        callId,
        depth,
        args,
        value: snapshot(value),
      })
      if (index >= 0) callStack.splice(index)
      return value
    },

    branch(expression, value, line) {
      currentLine = line
      emit({
        type: 'branch',
        line,
        expression,
        result: Boolean(value),
      })
      return value
    },

    complete(result, duration) {
      ensureCapacity()
      emit({
        type: 'done',
        line: currentLine,
        result: snapshot(result),
        duration,
      })
    },

    fail(message) {
      emit({ type: 'error', line: currentLine, message })
    },

    truncate(message) {
      const event: RuntimeEvent = { type: 'error', seq: Math.min(events.length, maxEvents - 1), line: currentLine, message }
      if (events.length >= maxEvents) events[events.length - 1] = event
      else events.push(event)
    },

    getEvents() {
      return events
    },
  }

  return runtime
}


