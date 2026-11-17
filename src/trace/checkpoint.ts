// Replay values are bounded, acyclic snapshot data, not live user objects.
// Copy and account in one pass: no full JSON string or UTF-8 buffer allocation.
// The charge is a conservative upper bound on JSON UTF-8 size, NOT JS heap size.
export function copyCheckpoint<T>(value: T, maxBytes: number): { saved: T; bytes: number } | null {
  let bytes = 0
  const copy = (input: unknown): unknown => {
    if (bytes > maxBytes) return undefined
    if (input === null || input === undefined) { bytes += 4; return input }
    if (typeof input === 'string') {
      // Each UTF-16 code unit needs at most six JSON bytes (\uXXXX), plus quotes.
      bytes += 2 + input.length * 6
      return input
    }
    if (typeof input === 'number') { bytes += 32; return input }
    if (typeof input === 'boolean') { bytes += 5; return input }
    if (typeof input !== 'object') {
      // Functions, symbols and bigint are not replay snapshot values. Do not
      // cache them, rather than letting a size serializer throw during a seek.
      bytes = Infinity
      return undefined
    }
    if (Array.isArray(input)) {
      bytes += 2 + Math.max(0, input.length - 1) // Brackets and commas.
      if (bytes > maxBytes) return undefined
      const output = new Array(input.length)
      for (let i = 0; i < input.length; i++) {
        if (Object.prototype.hasOwnProperty.call(input, i)) output[i] = copy(input[i])
        else bytes += 4 // Holes serialize to null; keep holes in the copy.
        if (bytes > maxBytes) return undefined
      }
      return output
    }
    bytes += 2
    const output: Record<string, unknown> = {}
    for (const key in input) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue
      // Charge a comma even for the first property and count undefined fields
      // even though JSON omits them. Both deliberately overestimate the size.
      bytes += 4 + key.length * 6 // Quoted key, colon, comma.
      if (bytes > maxBytes) return undefined
      const item = copy((input as Record<string, unknown>)[key])
      if (bytes > maxBytes) return undefined
      Object.defineProperty(output, key, { value: item, writable: true, enumerable: true, configurable: true })
    }
    return output
  }
  const saved = copy(value) as T
  return bytes <= maxBytes ? { saved, bytes } : null
}
