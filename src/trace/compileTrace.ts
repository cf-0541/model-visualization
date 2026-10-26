import { MAX_COLLECTION_SIZE } from '../runtime/traceRuntime'
import type {
  CallFrame,
  RuntimeEvent,
  TracePath,
  TracePointer,
  VisualSnapshot,
  VisualStep,
} from '../types'

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = cloneValue(item)
  }
  return output as T
}

function setAtPath(root: unknown, path: TracePath, value: unknown): unknown {
  if (path.length === 0) return cloneValue(value)
  // The runtime captures at most the first 120 array entries. Do not expand
  // sparse visual arrays to a massive index seen later in the trace.
  if (path.some((part) => typeof part === 'number' && part >= MAX_COLLECTION_SIZE)) return root
  if (root === null || typeof root !== 'object') return root

  let cursor = root as Record<string | number, unknown>
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    let next = cursor[key]
    if (next === null || typeof next !== 'object') {
      next = typeof path[index + 1] === 'number' ? [] : {}
      cursor[key] = next
    }
    cursor = next as Record<string | number, unknown>
  }
  cursor[path[path.length - 1]] = cloneValue(value)
  return root
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value === 'undefined' ? 'undefined' : `“${value}”`
  if (value === null) return 'null'
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    return json.length > 48 ? `${json.slice(0, 45)}…` : json
  }
  return String(value)
}

function formatPath(target: string, path: TracePath): string {
  return `${target}${path
    .map((part) => (typeof part === 'number' ? `[${part}]` : `.${part}`))
    .join('')}`
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (!entries.length) return '无参数'
  return entries
    .slice(0, 5)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join('，')
}

function describe(event: RuntimeEvent): { title: string; description: string } {
  switch (event.type) {
    case 'line':
      return { title: `执行第 ${event.line} 行`, description: '代码指针移动到下一条语句。' }
    case 'track':
      return {
        title: `观察 ${event.target}`,
        description: `捕获 ${event.target} 的初始状态，后续读写会自动形成动画。`,
      }
    case 'read':
      return {
        title: `读取 ${formatPath(event.target, event.path)}`,
        description: `取得 ${formatValue(event.value)}，作为当前计算的输入。`,
      }
    case 'write':
      return {
        title: `更新 ${formatPath(event.target, event.path)}`,
        description: `${formatValue(event.before)} → ${formatValue(event.after)}，状态已经写回。`,
      }
    case 'branch':
      return {
        title: event.result ? '条件成立' : '条件不成立',
        description: `${event.expression} 的结果为 ${event.result ? 'true' : 'false'}。`,
      }
    case 'call':
      return {
        title: `进入 ${event.name}()` ,
        description: `${formatArgs(event.args)}；递归深度 ${event.depth}。`,
      }
    case 'return':
      return {
        title: `${event.name}() 返回`,
        description: `返回值 ${formatValue(event.value)}，结果回到上一层调用。`,
      }
    case 'done':
      return {
        title: '运行完成',
        description: `最终结果为 ${formatValue(event.result)}，耗时 ${event.duration.toFixed(1)}ms。`,
      }
    case 'error':
      return { title: '运行中止', description: event.message }
  }
}

export const MAX_VISUAL_STEPS = 400
const MAX_VISIBLE_CALL_FRAMES = 24

function pointerKey(pointer: TracePointer): string {
  return `${pointer.target}:${pointer.path.join('.')}`
}

type FrameKind = VisualStep['kind']
type FrameChoice = { index: number; kind: FrameKind; priority: number }

// A line points to the work that follows it, until the next line event.
// Reads only need their own frame when no richer event in that line will show them.
function frameCandidates(events: RuntimeEvent[]): FrameChoice[] {
  const choices: FrameChoice[] = []
  let lineIndex = -1
  let hasActivity = false
  let hasKeyEvent = false
  let lastRead = -1

  function finishLine() {
    if (lineIndex >= 0) {
      choices.push({ index: lineIndex, kind: hasActivity ? 'key' : 'minor', priority: hasActivity ? 1 : 0 })
    }
    if (lastRead >= 0 && !hasKeyEvent) {
      choices.push({ index: lastRead, kind: 'minor', priority: 0 })
    }
  }

  events.forEach((event, index) => {
    if (event.type === 'line') {
      finishLine()
      lineIndex = index
      hasActivity = false
      hasKeyEvent = false
      lastRead = -1
      return
    }
    if (event.type === 'read') {
      hasActivity = true
      lastRead = index
    } else if (event.type === 'write' || event.type === 'branch' ||
      event.type === 'call' || event.type === 'return') {
      hasActivity = true
      hasKeyEvent = true
      choices.push({ index, kind: 'key', priority: event.type === 'write' ? 2 : 3 })
    } else if (event.type === 'done' || event.type === 'error') {
      choices.push({ index, kind: 'key', priority: 4 })
    } else if (event.type === 'track') {
      choices.push({ index, kind: 'minor', priority: 0 })
    }
  })
  finishLine()
  return choices
}

// When key events alone exceed the memory cap, prefer semantic events over
// line/reading frames, and spread the remaining slots across the trace.
function selectFrames(events: RuntimeEvent[]): Map<number, FrameKind> {
  if (!events.length) return new Map()
  const candidates = frameCandidates(events)
  const byIndex = new Map(candidates.map((choice) => [choice.index, choice]))
  for (const index of [0, events.length - 1]) {
    if (!byIndex.has(index)) {
      const type = events[index].type
      byIndex.set(index, { index, kind: type === 'error' || type === 'done' ? 'key' : 'minor', priority: 4 })
    }
  }
  if (byIndex.size <= MAX_VISUAL_STEPS) {
    return new Map([...byIndex.values()].map(({ index, kind }) => [index, kind]))
  }
  const selected = new Map<number, FrameKind>()
  const anchors = [0, events.length - 1]
  for (const index of anchors) selected.set(index, byIndex.get(index)!.kind)

  const positions = [...selected.keys()].sort((a, b) => a - b)
  function insertionPoint(index: number): number {
    let low = 0
    let high = positions.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (positions[middle] < index) low = middle + 1
      else high = middle
    }
    return low
  }

  for (let priority = 4; priority >= 0 && selected.size < MAX_VISUAL_STEPS; priority -= 1) {
    const pending = [...byIndex.values()].filter((choice) => choice.priority === priority && !selected.has(choice.index))
    while (pending.length && selected.size < MAX_VISUAL_STEPS) {
      // Farthest-first fills the largest uncovered region, rather than taking
      // every Nth raw event (which can silently discard the interesting ones).
      let best = 0
      let bestDistance = -1
      for (let i = 0; i < pending.length; i += 1) {
        const index = pending[i].index
        const insertion = insertionPoint(index)
        const distance = Math.min(
          insertion > 0 ? index - positions[insertion - 1] : Infinity,
          insertion < positions.length ? positions[insertion] - index : Infinity,
        )
        if (distance > bestDistance) {
          bestDistance = distance
          best = i
        }
      }
      const [choice] = pending.splice(best, 1)
      selected.set(choice.index, choice.kind)
      positions.splice(insertionPoint(choice.index), 0, choice.index)
    }
  }
  return selected
}

// The key-mode timeline is not capped: even a dense run of writes keeps each
// write addressable. Only the bounded compiler materializes 400 snapshots.
export function keyFrameIndices(events: RuntimeEvent[]): number[] {
  if (!events.length) return []
  const indices = new Set(frameCandidates(events)
    .filter(({ kind }) => kind === 'key')
    .map(({ index }) => index))
  indices.add(0) // Initial state, even if it is only a track event.
  indices.add(events.length - 1) // Final state or error.
  return [...indices].sort((a, b) => a - b)
}

// A seekable cursor holds only mutable replay state and its current snapshot.
// Backward seeks restart the replay; forward playback never clones skipped frames.
export function createTraceCursor(events: RuntimeEvent[], kinds?: ReadonlyMap<number, FrameKind>) {
  const eventKinds = kinds ?? new Map(frameCandidates(events).map(({ index, kind }) => [index, kind]))
  let state = createState()
  let next = 0
  let currentIndex = -1
  let current: VisualStep | null = null

  function at(index: number): VisualStep | null {
    if (index < 0 || index >= events.length) return null
    if (index === currentIndex) return current
    if (index < currentIndex) {
      state = createState()
      next = 0
    }
    while (next <= index) state.apply(events[next++])
    current = state.frame(events[index], index, eventKinds.get(index) ?? 'minor')
    currentIndex = index
    return current
  }
  function kindAt(index: number): FrameKind {
    return eventKinds.get(index) ?? 'minor'
  }
  return { at, kindAt }
}

function createState() {
  const tracked: Record<string, unknown> = {}
  const callStack: CallFrame[] = []
  let pendingReads: TracePointer[] = []
  let activeReads: TracePointer[] = []
  let activeWrite: (TracePointer & { before: unknown }) | null = null
  let branch: { expression: string; result: boolean } | null = null
  let result: unknown = undefined

  function apply(event: RuntimeEvent) {
    if (event.type === 'line') {
      activeWrite = null
      branch = null
    }

    if (event.type === 'track') {
      tracked[event.target] = cloneValue(event.value)
    }

    if (event.type === 'read') {
      const pointer: TracePointer = {
        target: event.target,
        path: [...event.path],
        value: cloneValue(event.value),
      }
      const key = pointerKey(pointer)
      pendingReads = [
        ...pendingReads.filter((item) => pointerKey(item) !== key),
        pointer,
      ].slice(-8)
      activeReads = [...pendingReads]
      activeWrite = null
    }

    if (event.type === 'write') {
      if (!(event.target in tracked)) tracked[event.target] = []
      setAtPath(tracked[event.target], event.path, event.after)
      activeReads = [...pendingReads]
      activeWrite = {
        target: event.target,
        path: [...event.path],
        value: cloneValue(event.after),
        before: cloneValue(event.before),
      }
      // Keep a short dependency tail so adjacent swap writes still read naturally.
      pendingReads = pendingReads.slice(-3)
    }

    if (event.type === 'branch') {
      branch = { expression: event.expression, result: event.result }
    }

    if (event.type === 'call') {
      callStack.push({
        name: event.name,
        callId: event.callId,
        depth: event.depth,
        line: event.line,
        args: cloneValue(event.args),
      })
    }

    if (event.type === 'return') {
      const frameIndex = callStack.findIndex((frame) => frame.callId === event.callId)
      if (frameIndex >= 0) callStack.splice(frameIndex)
    }

    if (event.type === 'done') result = cloneValue(event.result)
  }

  function frame(event: RuntimeEvent, index: number, kind: FrameKind): VisualStep {
    const snapshot: VisualSnapshot = {
      tracked: cloneValue(tracked),
      reads: cloneValue(activeReads),
      write: cloneValue(activeWrite),
      callStack: cloneValue(callStack.slice(-MAX_VISIBLE_CALL_FRAMES)),
      branch: cloneValue(branch),
      result: cloneValue(result),
    }
    const copy = cloneValue(event)
    const text = describe(copy)

    return {
      index,
      kind,
      event: copy,
      line: event.line,
      title: text.title,
      description: text.description,
      snapshot,
    }
  }
  return { apply, frame }
}

export function compileTrace(events: RuntimeEvent[]): VisualStep[] {
  const selected = selectFrames(events)
  const cursor = createTraceCursor(events, selected)
  const steps: VisualStep[] = []
  for (const index of [...selected.keys()].sort((a, b) => a - b)) {
    const step = cursor.at(index)!
    steps.push({ ...step, index: steps.length })
  }
  return steps
}
