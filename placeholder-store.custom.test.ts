import { describe, expect, test } from 'bun:test'
import { consumePlaceholder, pushPlaceholder } from './placeholder-store.custom.ts'

// Unique keys per test so the module-level store does not bleed across cases.
let n = 0
const k = () => `C:thread-${n++}`

describe('placeholder-store FIFO', () => {
  test('consume returns undefined when nothing pending', () => {
    expect(consumePlaceholder(k())).toBeUndefined()
  })

  test('single push/consume round-trips', () => {
    const key = k()
    pushPlaceholder(key, 'ts-1')
    expect(consumePlaceholder(key)).toBe('ts-1')
    expect(consumePlaceholder(key)).toBeUndefined()
  })

  test('THE BUG FIX: two same-thread placeholders consume oldest-first, no overwrite', () => {
    const key = k()
    pushPlaceholder(key, 'ts-A') // first question's placeholder
    pushPlaceholder(key, 'ts-B') // second question's placeholder (used to overwrite ts-A)
    // First reply must land on the first placeholder, not the second.
    expect(consumePlaceholder(key)).toBe('ts-A')
    expect(consumePlaceholder(key)).toBe('ts-B')
    expect(consumePlaceholder(key)).toBeUndefined()
  })

  test('keys are isolated', () => {
    const a = k()
    const b = k()
    pushPlaceholder(a, 'ts-a')
    pushPlaceholder(b, 'ts-b')
    expect(consumePlaceholder(b)).toBe('ts-b')
    expect(consumePlaceholder(a)).toBe('ts-a')
  })

  test('bounded: overflow drops the oldest, never grows past the cap', () => {
    const key = k()
    // MAX_PER_KEY is 16; push 20 → oldest 4 (ts-0..ts-3) dropped.
    for (let i = 0; i < 20; i++) pushPlaceholder(key, `ts-${i}`)
    expect(consumePlaceholder(key)).toBe('ts-4') // ts-0..ts-3 dropped
    let count = 1
    while (consumePlaceholder(key) !== undefined) count++
    expect(count).toBe(16)
  })
})
