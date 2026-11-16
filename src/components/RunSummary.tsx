import type { RunResult } from '../types'

export function RunSummary({ result, cpp = false }: { result: RunResult; cpp?: boolean }) {
  const incomplete = Boolean(result.truncated)
  return <section className={`run-summary${incomplete ? ' incomplete' : ''}`} role="status" aria-label="执行结果"
    data-completion={incomplete ? 'incomplete' : 'complete'}>
    <strong>{incomplete ? '执行未完成' : cpp ? '报告标记采集完成' : '算法执行完成'}</strong>
    <span>{result.events.length.toLocaleString()} 条事件 · {cpp ? '调试采集' : '执行'} {result.duration.toFixed(1)} ms</span>
    {incomplete ? <span>当前仅为部分轨迹，没有完整结果；请缩小输入或检查循环。</span> : null}
    {result.observation?.collectionTruncated ? <span>
      可视快照中的集合最多显示前 {result.observation.collectionLimit} 项，超出部分不完整展示；这不代表算法被截断。
    </span> : null}
    {cpp ? <span>C++ 仅回放本地调试器报告；行间采样不是完整读写追踪，耗时包含调试器开销。</span> : null}
  </section>
}
