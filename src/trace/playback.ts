import type { VisualStep } from '../types'

export function playbackDelay(kind: VisualStep['kind'], stepCount: number, speed: number): number {
  const density = Math.max(0.35, Math.sqrt(64 / Math.max(64, stepCount)))
  return (680 * (kind === 'minor' ? 0.4 : 1) * density) / speed
}
