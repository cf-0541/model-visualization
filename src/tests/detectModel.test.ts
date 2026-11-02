import { describe, expect, it } from 'vitest'
import { analyzeSource } from '../sourceAnalysis'
import { detectModel } from '../trace/detectModel'
import type { ModelKind, RuntimeEvent } from '../types'

const arrayEvents: RuntimeEvent[] = [
  { seq: 0, type: 'read', line: 1, target: 'values', path: [0], value: 1 },
]
const dpSource = `function solve(n) {
  const states = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) states[i] = states[i - 1] + 1;
  return states[n];
}`

describe('detectModel compatibility API', () => {
  it('preserves trace-only detection and the default auto preference', () => {
    expect(detectModel(arrayEvents)).toBe('array')
    expect(detectModel([])).toBe('unknown')
    expect(detectModel(arrayEvents, 'auto')).toBe('array')
  })

  it('preserves the two-argument manual override', () => {
    expect(detectModel(arrayEvents, 'graph')).toBe('graph')
    expect(detectModel([], 'dp')).toBe('dp')
  })

  it.each<ModelKind>(['array', 'dp', 'graph', 'segment-tree'])(
    'uses the source declaration %s even without trace events', (model) => {
      const analysis = analyzeSource(`// @model ${model}\nfunction solve() { return 1; }`)
      expect(analysis.declaredModel).toBe(model)
      expect(detectModel([], 'auto', analysis)).toBe(model)
    },
  )

  it('uses source structure ahead of conflicting array trace heuristics', () => {
    const analysis = analyzeSource(dpSource)
    expect(analysis.declaredModel).toBeNull()
    expect(analysis.structure).toBe('dp')
    expect(detectModel([], 'auto', analysis)).toBe('dp')
    expect(detectModel(arrayEvents, 'auto', analysis)).toBe('dp')
  })

  it('prefers source declarations over source structure', () => {
    const analysis = analyzeSource(`// @model graph\n${dpSource}`)
    expect(analysis.declaredModel).toBe('graph')
    expect(analysis.structure).toBe('dp')
    expect(detectModel(arrayEvents, 'auto', analysis)).toBe('graph')
  })

  it('prefers manual selection over both source declarations and structure', () => {
    const analysis = analyzeSource(`// @model graph\n${dpSource}`)
    expect(detectModel([], 'array', analysis)).toBe('array')
  })

  it('accepts an omitted preference when analysis is supplied', () => {
    const analysis = analyzeSource(dpSource)
    expect(detectModel([], undefined, analysis)).toBe('dp')
  })

  it('falls back to trace or unknown when source analysis has no model clues', () => {
    const analysis = analyzeSource('function solve(value) { return value; }')
    expect(analysis.declaredModel).toBeNull()
    expect(analysis.structure).toBeNull()
    expect(detectModel(arrayEvents, 'auto', analysis)).toBe('array')
    expect(detectModel([], 'auto', analysis)).toBe('unknown')
    expect(detectModel(arrayEvents, 'auto', undefined)).toBe('array')
  })
})
