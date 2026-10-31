import type { ModelKind } from './types'

export interface SourceAnalysis {
  entry: string | null
  parameters: string[]
  requiredParameters: number
  script: boolean
  declaredModel: ModelKind | null
  structure: ModelKind | null
  reason: string
}

export { analyzeSource, argumentsFor } from './ast/sourceAnalysis.mjs'
