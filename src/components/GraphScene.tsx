import type { VisualStep } from '../types'
import { formatCell } from '../trace/state'

function graphData(step: VisualStep): [string, Array<[string, string[]]>] | null {
  const entries = Object.entries(step.snapshot.tracked)
  const ordered = [...entries.filter(([name]) => /^(adj|graph|edges|network)$/i.test(name)), ...entries]
  for (const [name, value] of ordered) {
    if (Array.isArray(value) && value.length && value.every(Array.isArray)) {
      return [name, value.map((neighbors, index) => [String(index), neighbors.map(String)])]
    }
    if (value && !Array.isArray(value) && typeof value === 'object') {
      const record = Object.entries(value)
      if (record.length && record.every(([, neighbors]) => Array.isArray(neighbors))) {
        return [name, record.map(([node, neighbors]) => [node, (neighbors as unknown[]).map(String)])]
      }
    }
  }
  return null
}

export function GraphScene({ step }: { step: VisualStep }) {
  const selected = graphData(step)
  if (!selected) return <div className="scene-empty">未找到邻接表；请传入数组或对象形式的图。</div>
  const [target, graph] = selected
  const nodes = graph.slice(0, 18)
  const positions = new Map(nodes.map(([node], index) => [node, {
    x: 300 + Math.cos(index * 2 * Math.PI / nodes.length - Math.PI / 2) * 225,
    y: 190 + Math.sin(index * 2 * Math.PI / nodes.length - Math.PI / 2) * 130,
  }]))
  const seen = Object.entries(step.snapshot.tracked).find(([name, value]) =>
    /^(seen|visited|marked)$/i.test(name) && Array.isArray(value))?.[1] as unknown[] | undefined
  const queue = Object.entries(step.snapshot.tracked).find(([name, value]) =>
    /^(queue|q)$/i.test(name) && Array.isArray(value))?.[1] as unknown[] | undefined
  const current = step.snapshot.reads.filter((pointer) => pointer.target === target && pointer.path.length >= 2).at(-1)
  const activeNode = current ? String(current.path[0]) : null

  return (
    <div className="graph-scene">
      <div className="structure-caption"><span className="structure-name">{target}</span><span>{graph.length} 个节点 · 邻接表</span></div>
      <svg viewBox="0 0 600 380" role="img" aria-label={`${target} 图结构与遍历状态`}>
        {nodes.flatMap(([node, neighbors]) => neighbors.slice(0, 24).map((neighbor, index) => {
          const from = positions.get(node)
          const to = positions.get(neighbor)
          return from && to ? <line key={`${node}-${neighbor}-${index}`} className="graph-edge" x1={from.x} y1={from.y} x2={to.x} y2={to.y} /> : null
        }))}
        {nodes.map(([node]) => {
          const point = positions.get(node)!
          const visited = Array.isArray(seen) && Boolean(seen[Number(node)])
          return <g key={node} className={`graph-node${visited ? ' visited' : ''}${activeNode === node ? ' active' : ''}`}>
            <circle cx={point.x} cy={point.y} r="24" />
            <text x={point.x} y={point.y + 5} textAnchor="middle">{node}</text>
          </g>
        })}
      </svg>
      <div className="graph-details">
        <span>队列：{queue?.length ? queue.map(formatCell).join(' → ') : '—'}</span>
        <span>青色：当前读取 · 绿色：已访问</span>
        {graph.length > nodes.length ? <span>仅显示前 {nodes.length} 个节点</span> : null}
      </div>
    </div>
  )
}
