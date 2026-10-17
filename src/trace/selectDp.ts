import type { VisualStep } from '../types'

// Select once for the whole run, so input reads cannot make the scene jump
// between an input array and a renamed state table during playback.
export function selectDpTarget(steps: VisualStep[]): string | null {
  const final = steps.at(-1)?.snapshot.tracked ?? {}
  const arrays = Object.entries(final).filter(([, value]) => Array.isArray(value))
  if (!arrays.length) return null

  const scores = new Map(arrays.map(([name, value]) => [
    name,
    (/^(dp|memo|f)$/i.test(name) ? 20 : 0) + ((value as unknown[]).some(Array.isArray) ? 10 : 0),
  ]))
  for (const step of steps) {
    const write = step.snapshot.write
    if (step.event.type !== 'write' || !write || !scores.has(write.target)) continue
    const dependent = step.snapshot.reads.some((read) => read.target === write.target &&
      read.path.length > 0 && read.path[0] !== write.path[0])
    scores.set(write.target, scores.get(write.target)! + (dependent ? 5 : 1))
  }
  // In ties, prefer the later declaration: inputs are usually tracked before
  // the array created to hold the algorithm's state.
  return arrays.reduce((best, [name]) => scores.get(name)! >= scores.get(best)! ? name : best, arrays[0][0])
}
