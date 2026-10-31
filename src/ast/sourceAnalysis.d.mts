import type { SourceAnalysis } from '../sourceAnalysis'

export function analyzeSource(source: string): SourceAnalysis
export function argumentsFor(analysis: SourceAnalysis, input: unknown): unknown[]
