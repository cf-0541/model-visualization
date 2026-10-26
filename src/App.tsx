import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Braces,
  ChevronDown,
  CircleDot,
  Cpu,
  Play,
  Share2,
  Sparkles,
  WandSparkles,
} from 'lucide-react'
import { CodePanel } from './components/CodePanel'
import { Controls } from './components/Controls'
import type { PlaybackMode } from './components/Controls'
import { EventInspector } from './components/EventInspector'
import { VisualizationStage } from './components/VisualizationStage'
import { examples } from './examples'
import { readShareHash, shareUrl } from './share'
import { compileTrace, createTraceCursor, keyFrameIndices } from './trace/compileTrace'
import { playbackDelay } from './trace/playback'
import { decideModel } from './trace/detectModel'
import { selectDpTarget } from './trace/selectDp'
import type { ModelPreference, RunResult, VisualStep } from './types'

const modelOptions: Array<{ value: ModelPreference; label: string }> = [
  { value: 'auto', label: '自动识别模型' },
  { value: 'array', label: '数组模型' },
  { value: 'dp', label: '动态规划模型' },
  { value: 'segment-tree', label: '线段树模型' },
  { value: 'graph', label: '图遍历模型' },
]

function resultText(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  const text = JSON.stringify(value)
  return text.length > 44 ? `${text.slice(0, 41)}…` : text
}

export default function App() {
  const initial = examples[0]
  const shared = useMemo(() => readShareHash(window.location.hash), [])
  const [selectedExample, setSelectedExample] = useState(shared ? 'custom' : initial.id)
  const [code, setCode] = useState(shared?.code ?? initial.code)
  const [input, setInput] = useState(shared?.input ?? initial.input)
  const [mode, setMode] = useState<'edit' | 'trace'>('edit')
  const [preference, setPreference] = useState<ModelPreference>(shared?.model ?? 'auto')
  const [runResult, setRunResult] = useState<RunResult | null>(null)
  const [steps, setSteps] = useState<VisualStep[]>([])
  const [stepIndex, setStepIndex] = useState(0)
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>('key')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState(shared ? '分享链接已载入，请检查代码后手动运行；链接中的代码不会自动执行。' : '')
  const runId = useRef(0)

  const execute = useCallback(
    async (
      source = code,
      inputText = input,
      selectedModel = preference,
    ) => {
      const id = ++runId.current
      setRunning(true)
      setPlaying(false)
      setError(null)
      setNotice('')
      setRunResult(null)
      setSteps([])
      try {
        // Keep Babel's parser and instrumentation out of the initial bundle.
        const [{ parseInput }, { runCode }] = await Promise.all([
          import('./parseInput'),
          import('./runtime/runCode'),
        ])
        if (id !== runId.current) return
        const parsedInput = parseInput(inputText)
        const result = await runCode(source, parsedInput)
        if (id !== runId.current) return
        const nextSteps = compileTrace(result.events)
        const nextKeyIndices = keyFrameIndices(result.events)
        if (result.truncated) setNotice(result.truncated)
        setRunResult(result)
        setSteps(nextSteps)
        setPlaybackMode('key')
        setStepIndex(result.truncated ? Math.max(0, nextKeyIndices.length - 1) : 0)
        setMode('trace')
        setPlaying(!result.truncated && nextKeyIndices.length > 1 &&
          decideModel(result.events, result.analysis, selectedModel).model !== 'unknown')
      } catch (runError) {
        if (id !== runId.current) return
        setError(runError instanceof Error ? runError.message : String(runError))
        setMode('edit')
      } finally {
        if (id === runId.current) setRunning(false)
      }
    },
    [code, input, preference],
  )

  const events = runResult?.events
  const keyIndices = useMemo(() => events ? keyFrameIndices(events) : [], [events])
  const cursor = useMemo(() => events ? createTraceCursor(events) : null, [events])
  const total = playbackMode === 'key' ? keyIndices.length : events?.length ?? 0
  const eventIndex = playbackMode === 'key' ? keyIndices[stepIndex] : stepIndex
  const currentStep = useMemo(() => cursor?.at(eventIndex ?? -1) ?? null, [cursor, eventIndex])

  useEffect(() => {
    if (!playing || total < 2) return
    if (stepIndex >= total - 1) {
      setPlaying(false)
      return
    }
    const nextEventIndex = playbackMode === 'key' ? keyIndices[stepIndex + 1] : stepIndex + 1
    const kind = playbackMode === 'key' ? 'key' : cursor?.kindAt(nextEventIndex) ?? 'minor'
    const timer = window.setTimeout(() => {
      setStepIndex((current) => Math.min(total - 1, current + 1))
    }, playbackDelay(kind, total, speed))
    return () => window.clearTimeout(timer)
  }, [playing, speed, stepIndex, total, playbackMode, keyIndices, cursor])

  const decision = runResult ? decideModel(runResult.events, runResult.analysis, preference) : null
  const model = decision?.model ?? 'unknown'
  const dpTarget = useMemo(() => selectDpTarget(steps), [steps])
  const changePlaybackMode = (next: PlaybackMode) => {
    if (next === playbackMode) return
    const currentEvent = eventIndex ?? 0
    setPlaying(false)
    setStepIndex(next === 'all' ? currentEvent : keyIndices.reduce((position, index, candidate) => index <= currentEvent ? candidate : position, 0))
    setPlaybackMode(next)
  }
  const selectedDefinition = examples.find((example) => example.id === selectedExample)
  const invalidate = () => {
    runId.current += 1
    setRunResult(null)
    setSteps([])
    setStepIndex(0)
    setPlaybackMode('key')
    setRunning(false)
    setPlaying(false)
    setMode('edit')
    setError(null)
    setNotice('')
    setSelectedExample('custom')
  }
  const share = async () => {
    try {
      const url = shareUrl({ code, input, model: preference }, window.location.href)
      await navigator.clipboard.writeText(url)
      setNotice('分享链接已复制；链接只载入代码，不会自动运行。请勿分享含隐私的代码或输入。')
    } catch (copyError) {
      setNotice(copyError instanceof Error ? copyError.message : '无法复制链接，请检查浏览器剪贴板权限。')
    }
  }

  const loadExample = (id: string) => {
    const example = examples.find((item) => item.id === id)
    if (!example) return
    setSelectedExample(id)
    setCode(example.code)
    setInput(example.input)
    setPreference('auto')
    setError(null)
    setNotice('')
    void execute(example.code, example.input, 'auto')
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><WandSparkles size={21} /></span>
          <div>
            <div className="brand-title">Algorithm Motion Lab</div>
            <div className="brand-subtitle">代码即动画 · 执行轨迹驱动</div>
          </div>
        </div>
        <div className="pipeline" aria-label="运行管线">
          <span><Braces size={14} /> AST 插桩</span>
          <i />
          <span><Cpu size={14} /> Worker 执行</span>
          <i />
          <span><Sparkles size={14} /> 动态模型</span>
        </div>
        <div className="top-status">
          <span className={`status-light${running ? ' pulse' : ''}`} />
          {running ? 'RUNNING' : runResult ? 'READY' : 'IDLE'}
        </div>
      </header>

      <section className="command-bar" aria-label="运行配置">
        <div className="select-group">
          <label htmlFor="example-select">示例</label>
          <div className="select-shell">
            <select
              id="example-select"
              value={selectedExample}
              onChange={(event) => loadExample(event.target.value)}
            >
              {selectedExample === 'custom' ? <option value="custom">自定义代码</option> : null}
              {examples.map((example) => (
                <option key={example.id} value={example.id}>{example.title}</option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </div>

        <div className="example-description">
          <CircleDot size={14} />
          <span>{selectedDefinition?.description ?? '粘贴函数或完整脚本，即可生成执行轨迹。'}</span>
        </div>

        <div className="select-group model-select">
          <label htmlFor="model-select">可视化模型</label>
          <div className="select-shell">
            <select
              id="model-select"
              value={preference}
              onChange={(event) => setPreference(event.target.value as ModelPreference)}
            >
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </div>

        <button className="share-button" type="button" onClick={() => void share()}>
          <Share2 size={16} /> 分享链接
        </button>
        <button
          className="run-button"
          type="button"
          onClick={() => void execute()}
          disabled={running}
        >
          <Play size={17} fill="currentColor" />
          {running ? '正在生成…' : '运行并生成动画'}
        </button>
      </section>

      {(decision || notice) ? (
        <div className={`model-notice${decision?.source === 'fallback' ? ' uncertain' : ''}`} role="status">
          {notice ? <span>{notice} </span> : null}
          {decision ? (decision.source === 'fallback'
            ? '无法可靠识别模型；轨迹仍可查看，请用上方菜单手动选择结构以显示动画。'
            : `当前${decision.source === 'manual' ? '手动选用' : '识别为'}「${modelOptions.find((option) => option.value === decision.model)?.label}」（${decision.reason}）；如不符可在上方一键切换。`) : null}
          {runResult?.analysis.script ? ' 完整脚本已自行调用；输入框内容不会传入脚本。' : ''}
        </div>
      ) : <div className="model-notice quiet">粘贴真实函数无需改名；多参数按顺序输入数组。自动识别不准时可手动切换模型。</div>}

      <section className="workspace">
        <CodePanel
          code={code}
          input={input}
          mode={mode}
          currentLine={currentStep?.line ?? 0}
          currentEvent={currentStep?.event ?? null}
          error={error}
          onCodeChange={(value) => {
            invalidate()
            setCode(value)
          }}
          onInputChange={(value) => {
            invalidate()
            setInput(value)
          }}
          onModeChange={setMode}
        />

        <div className="stage-column">
          <VisualizationStage model={model} step={currentStep} running={running} dpTarget={dpTarget} />
          <EventInspector step={currentStep} rawEvent={playbackMode === 'all' ? events?.[eventIndex] : null} />
          <Controls
            index={stepIndex}
            total={total}
            mode={playbackMode}
            playing={playing}
            speed={speed}
            disabled={running}
            onIndexChange={(next) => {
              setStepIndex(next)
              setPlaying(false)
            }}
            onPlayingChange={(nextPlaying) => {
              if (stepIndex >= total - 1 && nextPlaying) setStepIndex(0)
              setPlaying(nextPlaying)
            }}
            onSpeedChange={setSpeed}
            onModeChange={changePlaybackMode}
          />
        </div>
      </section>

      <footer className="footer-status">
        <span>本地 Worker 隔离执行 · 2.5 秒 / 4,000 事件 / 10,000 次迭代上限</span>
        <span className="footer-metrics">
          <strong>{runResult ? runResult.events.length.toLocaleString() : '0'}</strong> events
          <i />
          <strong>{runResult ? `${runResult.duration.toFixed(1)} ms` : '—'}</strong>
          <i />
          result <code>{runResult?.truncated ? '未完成' : runResult ? resultText(runResult.result) : '—'}</code>
        </span>
      </footer>
    </main>
  )
}
