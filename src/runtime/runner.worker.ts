/// <reference lib="webworker" />

import type { RuntimeEvent } from '../types'
import { createTraceRuntime, TraceLimitError } from './traceRuntime'

interface RunnerRequest {
  code: string
  args: unknown[]
  entry: string | null
  scriptResult: string | null
  maxEvents: number
  maxIterations: number
}

interface RunnerSuccess {
  ok: true
  events: RuntimeEvent[]
  result: unknown
  duration: number
  truncated?: string
}

interface RunnerFailure {
  ok: false
  events: RuntimeEvent[]
  error: string
}

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (message: MessageEvent<RunnerRequest>) => {
  const { code, args, entry, scriptResult, maxEvents, maxIterations } = message.data
  const trace = createTraceRuntime(maxEvents, maxIterations)
  const startedAt = performance.now()

  const fail = (error: unknown): void => {
    if (error instanceof TraceLimitError) {
      trace.truncate(error.message)
      scope.postMessage({ ok: true, events: trace.getEvents(), result: undefined,
        duration: performance.now() - startedAt, truncated: error.message } satisfies RunnerSuccess)
      return
    }
    const text = error instanceof Error ? error.message : String(error)
    try {
      trace.fail(text)
    } catch {
      // The event cap may itself be the reason execution stopped.
    }
    const response: RunnerFailure = { ok: false, events: trace.getEvents(), error: text }
    scope.postMessage(response)
  }

  const complete = (result: unknown): void => {
    try {
      const duration = performance.now() - startedAt
      trace.complete(result, duration)
      const events = trace.getEvents()
      const doneEvent = events.at(-1)
      const serializableResult = doneEvent?.type === 'done' ? doneEvent.result : result
      const response: RunnerSuccess = { ok: true, events, result: serializableResult, duration }
      scope.postMessage(response)
    } catch (error) {
      fail(error)
    }
  }

  try {
    const execute = new Function(
      '__trace',
      '__args',
      `"use strict";
const window = undefined;
const document = undefined;
const globalThis = undefined;
const fetch = undefined;
const XMLHttpRequest = undefined;
const WebSocket = undefined;
const importScripts = undefined;
${code}
${entry ? `if (typeof ${entry} !== "function") throw new Error("找不到入口函数 ${entry}。");
return ${entry}(...__args);` : `return ${scriptResult ?? 'undefined'};`}
`,
    ) as (runtime: ReturnType<typeof createTraceRuntime>, values: unknown[]) => unknown

    const result = execute(trace, args)
    // Keep synchronous runs synchronous. For async results, settle the trace only
    // after the algorithm has finished; the owning runCode timeout still kills a stuck Worker.
    if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
      typeof (result as PromiseLike<unknown>).then === 'function') {
      Promise.resolve(result).then(complete, fail)
    } else {
      complete(result)
    }
  } catch (error) {
    fail(error)
  }
}

export {}

