import type { VisualStep } from '../types'

export function playbackDelay(
  kind: VisualStep['kind'], stepCount: number, speed: number, mode: 'key' | 'all' = 'all',
): number {
  const density = Math.max(0.35, Math.sqrt(64 / Math.max(64, stepCount)))
  const normal = 680 * density
  // Key mode keeps every semantic event addressable, even for thousands of
  // writes. Target ~60s of timer delays at 1x, without dropping any frames.
  // Keep >=16ms before speed scaling; rendering/background throttling may add time.
  const key = Math.max(16, Math.min(normal, 60_000 / Math.max(1, stepCount)))
  const delay = mode === 'key' ? key : normal
  return (delay * (kind === 'minor' ? 0.4 : 1)) / speed
}
