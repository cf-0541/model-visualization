import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Braces,
  ChevronDown,
  CircleDot,
  Cpu,
  Play,
  Share2,
  Sparkles,
  Square,
  WandSparkles,
  Upload,
} from 'lucide-react'
import { CodePanel } from './components/CodePanel'
import { RunSummary } from './components/RunSummary'
import { Controls } from './components/Controls'
import type { PlaybackMode } from './components/Controls'
import { EventInspector } from './components/EventInspector'
import { VisualizationStage } from './components/VisualizationStage'
import { examples } from './examples'
import { readShareHash, shareUrl } from './share'
import { createTraceCursor, keyFrameIndices } from './trace/compileTrace'
import { playbackDelay } from './trace/playback'
import { decideModel } from './trace/detectModel'
import { selectDpTargetFromEvents } from './trace/selectDp'
import type { ModelPreference, RunResult } from './types'

const modelOptions: Array<{ value: ModelPreference; label: string }> = [
  { value: 'auto', label: '自动识别模型' },
  { value: 'array', label: '数组模型' },
  { value: 'dp', label: '动态规划模型' },
  { value: 'segment-tree', label: '线段树模型' },
  { value: 'graph', label: '图遍历模型' },
]

const cppSamples = [
  { id: 'bubble', label: 'C++ 冒泡排序', load: () => import('./examples/cpp/bubble.json?raw') },
  { id: 'grid', label: 'C++ 二维 DP', load: () => import('./examples/cpp/grid.json?raw') },
  { id: 'vector', label: 'C++ vector', load: () => import('./examples/cpp/vector.json?raw') },
  { id: 'recursion', label: 'C++ 递归调用', load: () => import('./examples/cpp/recursion.json?raw') },
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
  const [stepIndex, setStepIndex] = useState(0)
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>('key')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState(shared ? '分享链接已载入，请检查代码后手动运行；链接中的代码不会自动执行。' : '')
  const [cppReplay, setCppReplay] = useState<{ source: string; name: string } | null>(null)
  const [loadingCpp, setLoadingCpp] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const activeRun = useRef<AbortController | null>(null)
  const runId = useRef(0)
  const workspaceRef = useRef<HTMLElement>(null)

  const cancelWorker = useCallback(() => {
    activeRun.current?.abort()
    activeRun.current = null
  }, [])

  useEffect(() => () => {
    runId.current += 1
    cancelWorker()
  }, [cancelWorker])

  const stopRun = () => {
    runId.current += 1
    cancelWorker()
    setRunning(false)
    setLoadingCpp(false)
    setPlaying(false)
    setNotice('已取消当前任务；没有将未完成的运行标为成功。')
  }

  const execute = useCallback(
    async (
      source = code,
      inputText = input,
      selectedModel = preference,
    ) => {
      const id = ++runId.current
      cancelWorker()
      const controller = new AbortController()
      activeRun.current = controller
      setRunning(true)
      setLoadingCpp(false)
      setPlaying(false)
      setError(null)
      setNotice('')
      setRunResult(null)
      try {
        // Keep source parsing and instrumentation out of the initial bundle.
        const [{ parseInput }, { runCode }] = await Promise.all([
          import('./parseInput'),
          import('./runtime/runCode'),
        ])
        if (id !== runId.current) return
        const parsedInput = parseInput(inputText)
        const result = await runCode(source, parsedInput, { signal: controller.signal })
        if (id !== runId.current) return
        const nextKeyIndices = keyFrameIndices(result.events)
        if (result.truncated) setNotice(result.truncated)
        setRunResult(result)
        setPlaybackMode('key')
        setStepIndex(result.truncated ? Math.max(0, nextKeyIndices.length - 1) : 0)
        setMode('trace')
        setPlaying(!result.truncated && nextKeyIndices.length > 1 &&
          decideModel(result.events, result.analysis, selectedModel).model !== 'unknown')
      } catch (runError) {
        if (id !== runId.current || controller.signal.aborted) return
        setError(runError instanceof Error ? runError.message : String(runError))
        setMode('edit')
      } finally {
        if (id === runId.current) {
          activeRun.current = null
          setRunning(false)
        }
      }
    },
    [code, input, preference, cancelWorker],
  )

  useEffect(() => {
    if (runResult && window.matchMedia('(max-width: 700px)').matches) {
      // Show both the compact trace and the model after running on narrow screens.
      // This runs once per result; playback only scrolls inside the code panel.
      workspaceRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }, [runResult])

  const events = runResult?.events
  const keyIndices = useMemo(() => events ? keyFrameIndices(events) : [], [events])
  const cursor = useMemo(() => events ? createTraceCursor(events) : null, [events])
  const total = playbackMode === 'key' ? keyIndices.length : events?.length ?? 0
  const eventIndex = playbackMode === 'key' ? keyIndices[stepIndex] : stepIndex
  const currentStep = useMemo(() => {
    const step = cursor?.at(eventIndex ?? -1) ?? null
    if (cppReplay && step?.event.type === 'return') return {
      ...step, title: `${step.event.name} 调用离开`,
      description: '调试器观察到调用栈退出；未采集该函数的返回值（null 不代表 C++ 返回了空值）。',
    }
    if (cppReplay && step?.event.type === 'done') return {
      ...step, title: 'C++ 轨迹采集完成',
      description: `采集结果 ${JSON.stringify(step.event.result)}；调试采集耗时 ${step.event.duration.toFixed(1)}ms，含调试器开销，不是原生运行速度。`,
    }
    return step
  }, [cursor, eventIndex, cppReplay])

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
    }, playbackDelay(kind, total, speed, playbackMode))
    return () => window.clearTimeout(timer)
  }, [playing, speed, stepIndex, total, playbackMode, keyIndices, cursor])

  const decision = useMemo(() => runResult
    ? decideModel(runResult.events, runResult.analysis, preference) : null, [runResult, preference])
  const model = decision?.model ?? 'unknown'
  const dpTarget = useMemo(() => events && model === 'dp'
    ? selectDpTargetFromEvents(events) : null, [events, model])
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
    cancelWorker()
    setRunResult(null)
    setStepIndex(0)
    setPlaybackMode('key')
    setRunning(false)
    setLoadingCpp(false)
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
    setCppReplay(null)
    setSelectedExample(id)
    setCode(example.code)
    setInput(example.input)
    setPreference('auto')
    setError(null)
    setNotice('')
    void execute(example.code, example.input, 'auto')
  }

  const importTrace = async (file: { size?: number; text(): Promise<string>; sample?: boolean }) => {
    const id = ++runId.current
    cancelWorker()
    setRunning(true)
    setLoadingCpp(true)
    setPlaying(false)
    setError(null)
    try {
      if (file.size !== undefined && file.size > 8 * 1024 * 1024) throw new Error('C++ 轨迹文件超过 8 MiB。')
      const { importCppTrace, CPP_REPLAY_NOTICE } = await import('./trace/importCppTrace')
      if (id !== runId.current) return
      const text = await file.text()
      if (id !== runId.current) return
      const imported = importCppTrace(text)
      if (id !== runId.current) return
      setCppReplay({ source: imported.source, name: imported.name })
      setRunResult(imported.result)
      setSelectedExample('custom')
      setPreference('auto')
      setPlaybackMode('key')
      setStepIndex(imported.status === 'complete' ? 0 : Math.max(0, keyFrameIndices(imported.result.events).length - 1))
      setMode('trace')
      setNotice(`${file.sample ? '内置固定示例报告，不是本次现场执行。' : ''}${CPP_REPLAY_NOTICE}${imported.result.truncated ? ` ${imported.result.truncated}` : ''}`)
    } catch (importError) {
      if (id !== runId.current) return
      setError(importError instanceof Error ? importError.message : String(importError))
    } finally {
      if (id === runId.current) {
        setRunning(false)
        setLoadingCpp(false)
      }
    }
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
          <span><Braces size={14} /> {cppReplay ? 'C++ 行采样' : 'AST 插桩'}</span>
          <i />
          <span><Cpu size={14} /> {cppReplay ? 'JSON 回放' : 'Worker 执行'}</span>
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
          <span>{selectedDefinition?.description ?? (cppReplay ? `C++ 只读轨迹：${cppReplay.name}` : '粘贴函数或完整脚本，即可生成执行轨迹。')}</span>
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

        <div className="select-group cpp-example-select">
          <label htmlFor="cpp-example-select">C++ 实验</label>
          <div className="select-shell">
            <select id="cpp-example-select" value="" disabled={running} onChange={event => {
              const sample = cppSamples.find(item => item.id === event.target.value)
              if (sample) void importTrace({ sample: true, text: async () => (await sample.load()).default })
            }}>
              <option value="" disabled>选择只读回放示例</option>
              {cppSamples.map(sample => <option key={sample.id} value={sample.id}>{sample.label}</option>)}
            </select>
            <ChevronDown size={15} />
          </div>
        </div>
        <input ref={importRef} type="file" accept=".json,application/json" hidden aria-label="C++ 轨迹 JSON"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void importTrace(file)
          }} />
        <button className="share-button" type="button" disabled={running} onClick={() => importRef.current?.click()}>
          <Upload size={16} /> 导入 C++ 轨迹（实验）
        </button>
        {cppReplay ? <button className="share-button" type="button" onClick={() => {
          invalidate()
          setCppReplay(null)
        }}>返回 JavaScript</button> : null}
        <button className="share-button" type="button" disabled={Boolean(cppReplay) || running} onClick={() => void share()}>
          <Share2 size={16} /> 分享链接
        </button>
        <button
          className="run-button"
          type="button"
          onClick={() => { if (!cppReplay) void execute() }}
          disabled={running || Boolean(cppReplay)}
        >
          <Play size={17} fill="currentColor" />
          {loadingCpp ? '正在导入…' : running ? '正在生成…' : cppReplay ? 'C++ 仅支持导入回放' : '运行并生成动画'}
        </button>
        {running ? <button className="share-button stop-button" type="button" onClick={stopRun}>
          <Square size={16} /> 停止当前任务
        </button> : null}
      </section>

      <div className="execution-notices">
      {(decision || notice) ? (
        <div className={`model-notice${decision?.source === 'fallback' ? ' uncertain' : ''}`} role="status">
          {notice ? <span>{notice} </span> : null}
          {decision ? (decision.source === 'fallback'
            ? '无法可靠识别模型；轨迹仍可查看，请用上方菜单手动选择结构以显示动画。'
            : `当前${decision.source === 'manual' ? '手动选用' : '识别为'}「${modelOptions.find((option) => option.value === decision.model)?.label}」（${decision.reason}）；如不符可在上方一键切换。`) : null}
          {runResult?.analysis.script ? ' 完整脚本已自行调用；输入框内容不会传入脚本。' : ''}
        </div>
      ) : <div className="model-notice quiet">粘贴真实函数无需改名；多参数按顺序输入数组。自动识别不准时可手动切换模型。</div>}

      {runResult ? <RunSummary result={runResult} cpp={Boolean(cppReplay)} /> : null}

      </div>

      <section className="workspace" ref={workspaceRef}>
        <CodePanel
          code={cppReplay?.source ?? code}
          readOnly={Boolean(cppReplay)}
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
          <VisualizationStage importing={loadingCpp} model={model} step={currentStep} running={running} dpTarget={dpTarget} />
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
        <span>{cppReplay ? 'C++ 本地调试器轨迹 · 浏览器只读回放 · 不是逐次读写插桩' : '仅运行可信 JavaScript · Worker 不是安全沙箱 · 2.5 秒 / 4,000 事件 / 10,000 次迭代上限'}</span>
        <span className="footer-metrics">
          <strong>{runResult ? runResult.events.length.toLocaleString() : '0'}</strong> events
          <i />
          <strong>{runResult && !runResult.truncated ? `${runResult.duration.toFixed(1)} ms${cppReplay ? '（调试采集）' : ''}` : '—'}</strong>
          <i />
          result <code>{runResult?.truncated ? '未完成' : runResult ? resultText(runResult.result) : '—'}</code>
        </span>
      </footer>
    </main>
  )
}
