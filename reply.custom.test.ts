import { describe, expect, mock, test } from 'bun:test'
import { defaultAccess } from './lib.ts'
import { chunkByBytes, sendServiceAnswer } from './reply.custom.ts'

const BIG = 'a'.repeat(3000)

function makeWeb() {
  const postMessage = mock(async () => ({ ts: '111.222' }))
  const update = mock(async () => ({ ts: '111.000' }))
  return { web: { chat: { postMessage, update } }, postMessage, update }
}

// biome-ignore lint/suspicious/noExplicitAny: test double for WebClient
const asWeb = (w: unknown) => w as any

describe('chunkByBytes', () => {
  test('short text → one chunk', () => {
    expect(chunkByBytes('hello')).toEqual(['hello'])
  })

  test('empty text → one empty chunk', () => {
    expect(chunkByBytes('')).toEqual([''])
  })

  test('splits at the byte budget without exceeding it', () => {
    const chunks = chunkByBytes(`${BIG}${BIG}`)
    expect(chunks.length).toBe(2)
    for (const c of chunks) expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(3000)
  })

  test('never splits a multi-byte character', () => {
    // 3-byte chars; 1001 of them = 3003 bytes > 3000 → must split on a char boundary.
    const chunks = chunkByBytes('好'.repeat(1001))
    for (const c of chunks) expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(3000)
    expect(chunks.join('')).toBe('好'.repeat(1001))
  })
})

describe('sendServiceAnswer secret-value guard', () => {
  const base = {
    access: defaultAccess(),
    channel: 'C1',
    threadTs: '100.200',
    placeholderTs: null,
  }

  test('clean text passes the guard and posts', async () => {
    const { web, postMessage } = makeWeb()
    const guard = mock((_: string) => {})
    const ts = await sendServiceAnswer({
      ...base,
      web: asWeb(web),
      text: 'a normal answer',
      assertNoSecretValues: guard,
    })
    expect(guard).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(ts).toBe('111.222')
  })

  test('a leaked secret is blocked — guard throws, nothing is posted', async () => {
    const { web, postMessage, update } = makeWeb()
    const guard = mock((payload: string) => {
      if (payload.includes('xoxb-LEAK')) throw new Error('secret-value-blocked')
    })
    await expect(
      sendServiceAnswer({
        ...base,
        web: asWeb(web),
        text: 'here is the token xoxb-LEAK-123',
        assertNoSecretValues: guard,
      }),
    ).rejects.toThrow('secret-value-blocked')
    expect(postMessage).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  test('guard runs on the FULL text before chunking (catches a cross-chunk split)', async () => {
    const { web, postMessage } = makeWeb()
    // Secret straddles the 3000-byte chunk boundary; a per-chunk check could miss it,
    // the full-text check must not.
    const text = `${'a'.repeat(2999)}xoxb-LEAK${'b'.repeat(2999)}`
    const guard = mock((payload: string) => {
      if (payload.includes('xoxb-LEAK')) throw new Error('secret-value-blocked')
    })
    await expect(
      sendServiceAnswer({ ...base, web: asWeb(web), text, assertNoSecretValues: guard }),
    ).rejects.toThrow('secret-value-blocked')
    expect(postMessage).not.toHaveBeenCalled()
  })

  test('no guard supplied → posts normally (back-compat)', async () => {
    const { web, postMessage } = makeWeb()
    const ts = await sendServiceAnswer({
      ...base,
      web: asWeb(web),
      text: 'no guard here',
    })
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(ts).toBe('111.222')
  })
})
