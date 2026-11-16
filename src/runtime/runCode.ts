import { analyzeSource, argumentsFor } from '../sourceAnalysis'
import { instrumentCode } from '../instrumentation/instrument'
import { DEFAULT_MAX_EVENTS, DEFAULT_MAX_ITERATIONS } from './traceRuntime'
import type { RunResult, RuntimeEvent, TraceObservation } from '../types'

interface WorkerSuccess {
  ok: true
  events: RuntimeEvent[]
  result: unknown
  duration: number
  truncated?: string
  observation?: TraceObservation
}

interface WorkerFailure {
  ok: false
  events: RuntimeEvent[]
  error: string
}

type WorkerResponse = WorkerSuccess | WorkerFailure

export interface RunOptions {
  timeoutMs?: number
  maxEvents?: number
  maxIterations?: number
  signal?: AbortSignal
}

export async function runCode(
  source: string,
  input: unknown,
  options: RunOptions = {},
): Promise<RunResult> {
  const { signal } = options
  const cancelled = () => new DOMException('运行已取消。', 'AbortError')
  if (signal?.aborted) throw cancelled()
  const timeoutMs = options.timeoutMs ?? 2_500
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const analysis = analyzeSource(source)
  if (!analysis.script && !analysis.entry) throw new Error('没有找到可执行入口：请提供函数，或粘贴带调用语句的完整脚本。')
  const args = argumentsFor(analysis, input)
  const transformed = instrumentCode(source, analysis.script)
  const worker = new Worker(new URL('./runner.worker.ts', import.meta.url), {
    type: 'module',
    name: 'algorithm-trace-runner',
  })

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      return true
    }

    const abort = () => {
      if (finish()) reject(cancelled())
    }
    const timer = globalThis.setTimeout(() => {
      if (!finish()) return
      reject(new Error(`执行超过 ${timeoutMs}ms，已终止，未获得完整轨迹。请缩小输入，或检查是否存在死循环。`))
    }, timeoutMs)

    worker.onmessage = (message: MessageEvent<WorkerResponse>) => {
      if (!finish()) return
      if (!message.data || typeof message.data.ok !== 'boolean' ||
        (message.data.ok && (!Array.isArray(message.data.events) || !Number.isFinite(message.data.duration)))) {
        reject(new Error('Worker 返回了无效的轨迹响应。'))
        return
      }
      if (!message.data.ok) {
        reject(new Error(message.data.error))
        return
      }
      resolve({
        analysis,
        events: message.data.events,
        result: message.data.result,
        duration: message.data.duration,
        transformedCode: transformed.code,
        truncated: message.data.truncated,
        observation: message.data.observation,
      })
    }

    worker.onerror = (event) => {
      if (!finish()) return
      reject(new Error(event.message || 'Worker 执行失败。'))
    }

    worker.onmessageerror = () => {
      if (finish()) reject(new Error('无法读取 Worker 返回的轨迹。'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    try {
      worker.postMessage({ code: transformed.code, args, entry: analysis.entry, scriptResult: transformed.scriptResult, maxEvents, maxIterations })
    } catch (error) {
      if (finish()) reject(error)
    }
  })
}
