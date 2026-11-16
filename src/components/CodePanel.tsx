import { useEffect, useRef } from 'react'
import { Braces, Code2, PlayCircle, ScanLine } from 'lucide-react'
import type { RuntimeEvent } from '../types'

interface CodePanelProps {
  readOnly?: boolean
  code: string
  input: string
  mode: 'edit' | 'trace'
  currentLine: number
  currentEvent: RuntimeEvent | null
  error: string | null
  onCodeChange: (value: string) => void
  onInputChange: (value: string) => void
  onModeChange: (mode: 'edit' | 'trace') => void
}

const eventLabels: Record<RuntimeEvent['type'], string> = {
  line: 'LINE',
  track: 'TRACK',
  read: 'READ',
  write: 'WRITE',
  branch: 'BRANCH',
  call: 'CALL',
  return: 'RETURN',
  done: 'DONE',
  error: 'ERROR',
}

export function CodePanel({
  readOnly = false,
  code,
  input,
  mode,
  currentLine,
  currentEvent,
  error,
  onCodeChange,
  onInputChange,
  onModeChange,
}: CodePanelProps) {
  const traceRef = useRef<HTMLDivElement>(null)
  const lines = code.split('\n')

  useEffect(() => {
    if (mode !== 'trace') return
    const container = traceRef.current
    const active = container?.querySelector(`[data-line="${currentLine}"]`)
    if (!container || !active) return
    // Only scroll the code viewport. scrollIntoView() also scrolls the page,
    // hiding the model when the panels are stacked on a narrow screen.
    const offset = active.getBoundingClientRect().top - container.getBoundingClientRect().top
    const desired = container.scrollTop + offset - (container.clientHeight - active.clientHeight) / 2
    container.scrollTo({ top: Math.max(0, desired), behavior: 'smooth' })
  }, [currentLine, mode])

  return (
    <aside className={`code-panel panel-shell${mode === 'trace' ? ' tracing' : ''}`} aria-label="代码与输入">
      <div className="panel-heading code-heading">
        <div className="heading-copy">
          <span className="eyebrow">SOURCE</span>
          <h2>代码轨道</h2>
        </div>
        <div className="segmented" role="tablist" aria-label="代码模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'edit'}
            className={mode === 'edit' ? 'active' : ''}
            onClick={() => onModeChange('edit')}
          >
            <Code2 size={14} /> {readOnly ? '源码（只读）' : '编辑'}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'trace'}
            className={mode === 'trace' ? 'active' : ''}
            onClick={() => onModeChange('trace')}
          >
            <ScanLine size={14} /> 执行轨迹
          </button>
        </div>
      </div>

      <div className="code-surface">
        {mode === 'edit' ? (
          <textarea
            className="code-editor"
            value={code}
            readOnly={readOnly}
            onChange={(event) => onCodeChange(event.target.value)}
            spellCheck={false}
            aria-label={readOnly ? 'C++ 源码（只读）' : '算法代码'}
          />
        ) : (
          <div className="trace-code" ref={traceRef} aria-label="逐行执行代码">
            {lines.map((line, index) => {
              const lineNumber = index + 1
              const active = lineNumber === currentLine
              return (
                <div
                  className={`code-line${active ? ' active' : ''}`}
                  data-line={lineNumber}
                  key={`${lineNumber}-${line}`}
                >
                  <span className="line-gutter">
                    {active ? <PlayCircle size={13} /> : null}
                    <span>{lineNumber}</span>
                  </span>
                  <code>{line || ' '}</code>
                  {active && currentEvent ? (
                    <span className={`event-token event-${currentEvent.type}`}>
                      {eventLabels[currentEvent.type]}
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className={`input-section${error ? ' has-error' : ''}`}>
        {readOnly ? (
          <p className="input-hint">
            实验回放：先用本地 g++ / GDB 采集可信 C++ 代码的轨迹，再导入 JSON；此处不编译、不执行 C++。
            不支持输入或编辑后重跑。未捕获 read / branch，写入行号仅近似。
          </p>
        ) : (
          <>
            <label htmlFor="algorithm-input">
              <span className="input-label">
                <Braces size={14} /> 算法输入
              </span>
              <span className="input-hint">单参数直接传值；多参数用 [arg1, arg2] 或同名对象</span>
            </label>
            <textarea
              id="algorithm-input"
              className="input-editor"
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              spellCheck={false}
              aria-invalid={Boolean(error && error.includes('输入'))}
            />
          </>
        )}
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
      </div>
    </aside>
  )
}
