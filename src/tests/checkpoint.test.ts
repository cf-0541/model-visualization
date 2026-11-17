import { describe, expect, it } from 'vitest'
import { copyCheckpoint } from '../trace/checkpoint'

const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

describe('checkpoint copy and conservative byte accounting', () => {
  it('bounds JSON size for escapes, Unicode, holes, undefined and numeric extremes', () => {
    const strings = ['ASCII', '中文😀', '\u0000\n\t"\\', '\ud800', '\udc00', '']
    const numbers = [0, -0, -Number.MAX_VALUE, Number.MIN_VALUE, 0.0000010000000000000002, NaN, Infinity]
    const values = [null, undefined, true, false, ...strings, ...numbers,
      [1, , undefined, null], { missing: undefined, nested: [strings, numbers] },
      Object.fromEntries(strings.map(key => [key, strings]))]
    for (const value of values) {
      const copied = copyCheckpoint(value, 1024 * 1024)!
      expect(copied.saved).toEqual(value)
      if (value !== undefined) expect(copied.bytes).toBeGreaterThanOrEqual(encodedBytes(value))
      expect(copyCheckpoint(value, copied.bytes)).not.toBeNull()
      expect(copyCheckpoint(value, copied.bytes - 1)).toBeNull()
    }
  })

  it('preserves nested copy isolation and sparse array slots', () => {
    const original = { items: [{ n: 1 }, , undefined], extra: { ok: true } }
    const { saved } = copyCheckpoint(original, 10000)!
    saved.items[0]!.n = 99
    saved.extra.ok = false
    expect(original.items[0]!.n).toBe(1)
    expect(original.extra.ok).toBe(true)
    expect(1 in saved.items).toBe(false)
    expect(2 in saved.items).toBe(true)
  })

  it('stops copying once the budget is exceeded', () => {
    const state = { large: 'x'.repeat(1000), get untouched() { throw new Error('should not be read') } }
    expect(copyCheckpoint(state, 100)).toBeNull()
    expect(copyCheckpoint({ hugeSparseArray: new Array(1000000) }, 100)).toBeNull()
  })

  it('does not turn a __proto__ data key into an inherited property', () => {
    const value = JSON.parse('{"__proto__":{"value":7}}')
    const { saved } = copyCheckpoint(value, 10000)!
    expect(Object.hasOwn(saved, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(saved)).toBe(Object.prototype)
    expect(saved).toEqual(value)
  })

  it('declines to cache unsupported values rather than failing a seek', () => {
    for (const value of [1n, Symbol('x'), () => 1]) expect(copyCheckpoint({ value }, 10000)).toBeNull()
  })
})
