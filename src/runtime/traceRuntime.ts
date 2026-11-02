import type {
  ArrayPatch,
  RuntimeEvent,
  TracePath,
  TraceRuntime,
} from '../types'

interface ProxyMeta {
  target: string
  path: TracePath
  raw: object
  arrayBaseline: { view: unknown[] | null; revision: number }
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
const ARRAY_MUTATORS = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'])

type RuntimeEventInput = {
  [Kind in RuntimeEvent['type']]: Omit<Extract<RuntimeEvent, { type: Kind }>, 'seq'>
}[RuntimeEvent['type']]

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

// Native internal-slot objects reject method calls made through an ordinary Proxy.
function opaqueKind(value: object): string | null {
  switch (Object.prototype.toString.call(value)) {
    case '[object Promise]': return 'Promise'
    case '[object Generator]': return 'Generator'
    case '[object AsyncGenerator]': return 'AsyncGenerator'
    default: return null
  }
}

// Proxies break native internal-slot methods (Map, Date, typed arrays, etc.).
// Accessors can mutate program state during a snapshot, so leave such objects
// unproxied too. This is a conservative observation boundary, not a sandbox.
function canProxy(value: object): boolean {
  if (opaqueKind(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value) ? prototype !== Array.prototype :
    prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor
  })
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
  let arrayRevision = 0

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
    const kind = opaqueKind(raw)
    if (kind) return `[${kind}]`
    const prototype = Object.getPrototypeOf(raw)
    if (Array.isArray(raw) ? prototype !== Array.prototype :
      prototype !== Object.prototype && prototype !== null) return '[Object]'
    if (depth >= MAX_SNAPSHOT_DEPTH) return '[…]'
    if (seen.has(raw)) return '[Circular]'
    seen.add(raw)

    if (Array.isArray(raw)) {
      const values: unknown[] = new Array(Math.min(raw.length, MAX_COLLECTION_SIZE))
      for (let index = 0; index < values.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, index)
        if (descriptor) values[index] = 'value' in descriptor
          ? snapshot(descriptor.value, depth + 1, seen, budget) : '[Accessor]'
      }
      if (raw.length > MAX_COLLECTION_SIZE) values.push(`… +${raw.length - MAX_COLLECTION_SIZE}`)
      return values
    }

    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    let count = 0
    for (const key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
      if (count++ >= MAX_COLLECTION_SIZE) {
        output['…'] = 'truncated'
        break
      }
      const descriptor = Object.getOwnPropertyDescriptor(raw, key)
      output[key] = descriptor && 'value' in descriptor
        ? snapshot(descriptor.value, depth + 1, seen, budget) : '[Accessor]'
    }
    return output
  }

  // Capture only bounded primitive slots. Object/accessor elements need the
  // existing deep snapshot fallback: a native callback may mutate them in place.
  const primitiveArrayView = (raw: unknown[]): unknown[] | null => {
    const view = new Array(Math.min(raw.length, MAX_COLLECTION_SIZE))
    for (let index = 0; index < view.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, index)
      if (!descriptor) continue
      if (!('value' in descriptor) || isObject(descriptor.value) || typeof descriptor.value === 'function') return null
      view[index] = descriptor.value
    }
    if (raw.length > MAX_COLLECTION_SIZE) view.push(`… +${raw.length - MAX_COLLECTION_SIZE}`)
    return view
  }

  const sameArrayView = (left: unknown[] | null, right: unknown[]): boolean => {
    if (left === null || left.length !== right.length) return false
    for (let index = 0; index < right.length; index += 1) {
      if (Object.hasOwn(left, index) !== Object.hasOwn(right, index) ||
        !Object.is(left[index], right[index])) return false
    }
    return true
  }

  const arrayPatch = (before: unknown[], after: unknown[]): ArrayPatch | null => {
    const changes: ArrayPatch['changes'] = []
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
      const beforePresent = Object.hasOwn(before, index)
      const afterPresent = Object.hasOwn(after, index)
      if (beforePresent === afterPresent && Object.is(before[index], after[index])) continue
      // Stop early on dense changes: full snapshots are cheaper to encode.
      if ((changes.length + 1) * 16 > before.length + after.length) return null
      changes.push({ index, beforePresent, afterPresent,
        before: beforePresent ? snapshot(before[index]) : undefined,
        after: afterPresent ? snapshot(after[index]) : undefined })
    }
    return { beforeLength: before.length, afterLength: after.length, changes }
  }

  const ensureCapacity = (): void => {
    if (events.length >= maxEvents) throw new TraceLimitError(maxEvents)
  }

  const emit = (event: RuntimeEventInput): void => {
    const previous = events[events.length - 1]
    // Only adjacent reads of the same address on the same line are redundant.
    // Keep the latest observation and its seq, without crossing any other event.
    // Check before capacity: replacing a read must also work at the event limit.
    if (event.type === 'read' && previous?.type === 'read' &&
      previous.line === event.line && previous.target === event.target &&
      previous.path.length === event.path.length &&
      previous.path.every((part, index) => part === event.path[index])) {
      previous.value = event.value
      return
    }
    ensureCapacity()
    events.push({ ...event, seq: events.length } as RuntimeEvent)
    // A full replacement can invalidate a cached nested array's visual base.
    if (event.type === 'track' || (event.type === 'write' && !event.arrayPatch)) arrayRevision += 1
  }

  const proxyFor = <T extends object>(rawValue: T, target: string, path: TracePath): T => {
    const unwrapped = proxyMeta.get(rawValue)?.raw ?? rawValue
    if (!canProxy(unwrapped)) return unwrapped as T
    const cacheKey = `${target}:${path.map(String).join('.')}`
    let cache = proxyCache.get(unwrapped)
    if (!cache) {
      cache = new Map()
      proxyCache.set(unwrapped, cache)
    }
    const cached = cache.get(cacheKey)
    if (cached) return cached as T

    // A top-level array has a matching initial track snapshot. A nested array
    // may have changed via an unproxied alias since track: establish its first
    // baseline with the full fallback rather than assuming its initial state.
    const arrayBaseline = {
      view: Array.isArray(unwrapped) && path.length === 0 ? primitiveArrayView(unwrapped) : null,
      revision: arrayRevision,
    }
    const proxy = new Proxy(unwrapped, {
      get(raw, key, receiver) {
        const value = Reflect.get(raw, key, receiver)
        const part = displayKey(key)
        // Native array methods write several indices before updating length.
        // Record one completed mutation so playback never presents their
        // intermediate (e.g. shift()'s duplicated) queue as a stable state.
        if (Array.isArray(raw) && typeof key === 'string' && ARRAY_MUTATORS.has(key) &&
          value === (Array.prototype as unknown as Record<string, unknown>)[key]) {
          return function (this: unknown, ...args: unknown[]) {
            if (this !== receiver) return Reflect.apply(value, this, args)
            ensureCapacity()
            const beforeView = primitiveArrayView(raw)
            const before = beforeView === null ? snapshot(raw) : undefined
            const unwrappedArgs = args.map((arg) => isObject(arg) ? proxyMeta.get(arg)?.raw ?? arg : arg)
            let result: unknown
            try {
              result = Reflect.apply(value, raw, unwrappedArgs)
            } finally {
              const afterView = beforeView === null ? null : primitiveArrayView(raw)
              const patch = beforeView !== null && afterView !== null && beforeView.length >= 16 &&
                arrayBaseline.revision === arrayRevision && sameArrayView(arrayBaseline.view, beforeView)
                ? arrayPatch(beforeView, afterView) : null
              // Dense rewrites and tiny arrays cost less in the original format.
              // A delta must save substantially more slots than its field overhead.
              if (patch) {
                emit({ type: 'write', line: currentLine, target, path: [...path],
                  arrayPatch: patch })
              } else {
                emit({ type: 'write', line: currentLine, target, path: [...path],
                  before: beforeView === null ? before : beforeView.map((item) => snapshot(item)),
                  after: afterView === null ? snapshot(raw) : afterView.map((item) => snapshot(item)) })
              }
              arrayBaseline.view = afterView
              arrayBaseline.revision = arrayRevision
            }
            return result === raw ? receiver : result
          }
        }
        if (part === null || key === 'length' || typeof value === 'function') return value

        const nextPath = [...path, part]
        if (isObject(value)) return proxyFor(value, target, nextPath)

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
        const descriptor = Object.getOwnPropertyDescriptor(raw, key)
        const before = descriptor && 'value' in descriptor ? descriptor.value : undefined
        const unwrappedValue = isObject(value) ? proxyMeta.get(value)?.raw ?? value : value
        const ok = Reflect.set(raw, key, unwrappedValue, receiver)

        if (ok && part !== null) {
          // A scalar write may also change length or replace an object-valued
          // slot. Re-establish a full baseline before the next array delta.
          arrayBaseline.view = null
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

    proxyMeta.set(proxy, { target, path, raw: unwrapped, arrayBaseline })
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
      if (!canProxy(raw)) return raw as typeof value
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
        proxyMeta.get(proxy)!.arrayBaseline.revision = arrayRevision
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


