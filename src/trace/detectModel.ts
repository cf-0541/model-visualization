import type { ModelDecision, ModelKind, ModelPreference, RuntimeEvent } from '../types'
import type { SourceAnalysis } from '../sourceAnalysis'

export function decideModel(
  events: RuntimeEvent[],
  analysis: SourceAnalysis,
  preference: ModelPreference = 'auto',
): ModelDecision {
  if (preference !== 'auto') return { model: preference, source: 'manual', reason: '手动切换' }
  if (analysis.declaredModel) return { model: analysis.declaredModel, source: 'declared', reason: '代码显式声明' }
  if (analysis.structure) return { model: analysis.structure, source: 'structure', reason: analysis.reason }
  if (events.some((event) => event.type === 'call' && event.depth > 0 &&
    ['p', 'l', 'r'].every((key) => typeof event.args[key] === 'number'))) {
    return { model: 'segment-tree', source: 'trace', reason: '运行轨迹包含区间递归参数' }
  }
  const dependentWrite = events.some((event, index) => event.type === 'write' && event.path.length > 1 &&
    events.slice(Math.max(0, index - 12), index).some((previous) =>
      previous.type === 'read' && previous.target === event.target))
  if (dependentWrite) return { model: 'dp', source: 'trace', reason: '二维状态写入依赖同一表的读取' }
  if (events.some((event) => event.type === 'track' && /^(dp|memo|f)$/i.test(event.target))) {
    return { model: 'dp', source: 'trace', reason: '运行轨迹包含命名状态表' }
  }
  const arrayActivity = events.some((event) => (event.type === 'read' || event.type === 'write') &&
    typeof event.path[0] === 'number')
  if (arrayActivity) return { model: 'array', source: 'trace', reason: '运行轨迹包含数组索引操作' }
  return { model: 'array', source: 'fallback', reason: '没有足够的结构特征' }
}

// Keep the simple API for external users of the trace compiler.
export function detectModel(events: RuntimeEvent[], preference: ModelPreference = 'auto'): ModelKind {
  const empty: SourceAnalysis = { entry: null, parameters: [], requiredParameters: 0, script: false, declaredModel: null, structure: null, reason: '' }
  return decideModel(events, empty, preference).model
}
