import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCode } from '../runtime/runCode'

class FakeWorker {
  static instances: FakeWorker[] = []
  static sendError = false
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminate = vi.fn()
  postMessage = vi.fn(() => { if (FakeWorker.sendError) throw new DOMException('not cloneable', 'DataCloneError') })
  constructor() { FakeWorker.instances.push(this) }
  reply(data = { ok: true, events: [], result: 7, duration: 1 }) {
    this.onmessage?.({ data } as MessageEvent)
  }
}
const source = 'function solve() { return 7; }'
const last = () => FakeWorker.instances.at(-1)!

beforeEach(() => {
  vi.useFakeTimers()
  FakeWorker.instances = []
  FakeWorker.sendError = false
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('runCode resource lifetime', () => {
  it('rejects an already aborted request before parsing or creating a Worker', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runCode('invalid syntax {', null, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('terminates immediately on cancellation and removes timers and handlers', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const promise = runCode(source, null, { signal: controller.signal })
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    const worker = last()
    const lateReply = worker.onmessage!
    controller.abort()
    await rejected
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.onmessage).toBeNull()
    expect(worker.onerror).toBeNull()
    expect(worker.onmessageerror).toBeNull()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    lateReply({ data: { ok: true, events: [], result: 999, duration: 1 } } as MessageEvent)
    await vi.runAllTimersAsync()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('does not let a cancelled request affect a subsequent run', async () => {
    const controller = new AbortController()
    const old = runCode(source, null, { signal: controller.signal })
    const rejection = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    const next = runCode(source, null)
    last().reply()
    await rejection
    await expect(next).resolves.toMatchObject({ result: 7 })
    expect(FakeWorker.instances.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up after success and ignores a later abort', async () => {
    const controller = new AbortController()
    const promise = runCode(source, null, { signal: controller.signal })
    last().reply()
    await expect(promise).resolves.toMatchObject({ result: 7 })
    controller.abort()
    expect(last().terminate).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('terminates on timeout and permits a successful retry', async () => {
    const promise = runCode(source, null, { timeoutMs: 20 })
    const rejected = expect(promise).rejects.toThrow(/已终止.*未获得完整轨迹/)
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(last().terminate).toHaveBeenCalledTimes(1)
    const next = runCode(source, null)
    last().reply()
    await expect(next).resolves.toMatchObject({ result: 7 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects malformed responses instead of leaving a settled-but-unresolved run', async () => {
    const promise = runCode(source, null)
    const rejected = expect(promise).rejects.toThrow('无效的轨迹响应')
    last().onmessage!({ data: null } as MessageEvent)
    await rejected
    expect(last().terminate).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['error', 'messageerror', 'workerFailure', 'postMessage'] as const)('cleans up on %s failure', async kind => {
    FakeWorker.sendError = kind === 'postMessage'
    const promise = runCode(source, null)
    const rejected = expect(promise).rejects.toThrow()
    if (kind === 'error') last().onerror!({ message: 'native failure' } as ErrorEvent)
    else if (kind === 'messageerror') last().onmessageerror!()
    else if (kind === 'workerFailure') last().reply({ ok: false, events: [], result: 0, duration: 0 })
    await rejected
    expect(last().terminate).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
