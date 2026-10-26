import { Box, BrainCircuit, Network, Rows3 } from 'lucide-react'
import type { DetectedModel, VisualStep } from '../types'
import { ArrayScene } from './ArrayScene'
import { DpScene } from './DpScene'
import { GraphScene } from './GraphScene'
import { SegmentTreeScene } from './SegmentTreeScene'

interface VisualizationStageProps {
  model: DetectedModel
  step: VisualStep | null
  running: boolean
  dpTarget?: string | null
}

const modelMeta: Record<
  DetectedModel,
  { label: string; eyebrow: string; icon: typeof Box }
> = {
  unknown: { label: '未识别数据结构', eyebrow: 'UNKNOWN MODEL', icon: Box },
  array: { label: '数组状态模型', eyebrow: 'ARRAY MODEL', icon: Rows3 },
  dp: { label: '动态规划模型', eyebrow: 'DP MODEL', icon: BrainCircuit },
  'segment-tree': { label: '线段树模型', eyebrow: 'TREE MODEL', icon: Network },
  graph: { label: '图遍历模型', eyebrow: 'GRAPH MODEL', icon: Network },
}

export function VisualizationStage({ model, step, running, dpTarget }: VisualizationStageProps) {
  const meta = modelMeta[model]
  const ModelIcon = meta.icon

  return (
    <section className="visual-stage panel-shell" aria-label="算法动态模型">
      <div className="stage-grid" aria-hidden="true" />
      <div className="stage-heading">
        <div className="model-identity">
          <span className="model-icon"><ModelIcon size={18} /></span>
          <div>
            <span className="eyebrow">{step ? meta.eyebrow : 'MODEL STAGE'}</span>
            <h2>{step ? meta.label : '可视化舞台'}</h2>
          </div>
        </div>
        <div className={`runtime-status${running ? ' running' : ''}`}>
          <i /> {running ? '正在构建轨迹' : step ? '轨迹已就绪' : '等待运行'}
        </div>
      </div>

      <div className="scene-copy" aria-live="polite">
        <div>
          <span className="step-kicker">CURRENT STEP</span>
          <h3>{running ? '执行代码中…' : step?.title ?? '等待运行'}</h3>
        </div>
        <p>{running ? '代码正在隔离的 Worker 中执行并采集事件。' : step?.description ?? '点击“运行并生成动画”开始。'}</p>
      </div>

      <div className={`scene-viewport model-${model}${running ? ' is-running' : ''}`}>
        {running ? (
          <div className="stage-loader" role="status">
            <span className="loader-orbit"><i /><i /><i /></span>
            <strong>解析 AST · 注入追踪 · 执行</strong>
          </div>
        ) : step && model === 'unknown' ? (
          <div className="stage-placeholder" role="status">
            <span><Box size={30} /></span>
            <strong>尚未识别出可视化结构</strong>
            <p>轨迹已生成，请在上方“可视化模型”菜单手动选择结构，再查看动画。</p>
          </div>
        ) : step ? (
          model === 'dp' ? (
            <DpScene step={step} targetHint={dpTarget} />
          ) : model === 'segment-tree' ? (
            <SegmentTreeScene step={step} />
          ) : model === 'graph' ? (
            <GraphScene step={step} />
          ) : (
            <ArrayScene step={step} />
          )
        ) : (
          <div className="stage-placeholder">
            <span><Box size={30} /></span>
            <strong>可视化舞台</strong>
            <p>运行左侧代码，数据结构会在这里随执行轨迹变化。</p>
          </div>
        )}
      </div>
    </section>
  )
}
