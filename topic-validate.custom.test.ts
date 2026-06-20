import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetAttemptsForTest,
  handleTopicValidation,
  runTopicValidator,
} from './topic-validate.custom.ts'

// biome-ignore lint/suspicious/noExplicitAny: test double for WebClient
const asWeb = (w: unknown) => w as any

function makeWeb() {
  const postMessage = mock(async () => ({ ts: '111.222' }))
  return { web: { chat: { postMessage } }, postMessage }
}

let topicRoot: string
const savedWikiPath = process.env.WIKI_PATH

/** Write an executable validator script at <topicRoot>/.wikimeta/response/check. */
function installValidator(body: string): void {
  const dir = join(topicRoot, '.wikimeta', 'response')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'check')
  writeFileSync(p, body)
  chmodSync(p, 0o755)
}

beforeEach(() => {
  topicRoot = mkdtempSync(join(tmpdir(), 'topic-validate-'))
  process.env.WIKI_PATH = topicRoot
  __resetAttemptsForTest()
})

afterEach(() => {
  rmSync(topicRoot, { recursive: true, force: true })
  if (savedWikiPath === undefined) delete process.env.WIKI_PATH
  else process.env.WIKI_PATH = savedWikiPath
})

describe('runTopicValidator', () => {
  test('missing validator → [] (topic opts out)', async () => {
    expect(await runTopicValidator('any answer')).toEqual([])
  })

  test('clean answer (no stdout) → []', async () => {
    installValidator('#!/usr/bin/env bash\nexit 0\n')
    expect(await runTopicValidator('```yaml\nok: true\n```')).toEqual([])
  })

  test('parses JSON-lines violations from stdout', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' +
        `printf '{"rule":"yaml-syntax","detail":"fix indent"}\\n'\n` +
        `printf '{"rule":"dot-path","detail":"use ->"}\\n'\n` +
        'exit 0\n',
    )
    const v = await runTopicValidator('bad')
    expect(v).toEqual([
      { rule: 'yaml-syntax', detail: 'fix indent' },
      { rule: 'dot-path', detail: 'use ->' },
    ])
  })

  test('ignores non-JSON / malformed lines (forward-compatible)', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' +
        "echo 'debug noise'\n" +
        `printf '{"rule":"r","detail":"d"}\\n'\n` +
        `printf '{"rule":"missing-detail"}\\n'\n` +
        'exit 0\n',
    )
    expect(await runTopicValidator('x')).toEqual([{ rule: 'r', detail: 'd' }])
  })

  test('reads the answer from stdin', async () => {
    // Validator echoes a violation only when stdin contains the marker.
    installValidator(
      '#!/usr/bin/env bash\n' +
        'in=$(cat)\n' +
        'case "$in" in\n' +
        `  *BADMARKER*) printf '{"rule":"hit","detail":"saw marker"}\\n' ;;\n` +
        'esac\n' +
        'exit 0\n',
    )
    expect(await runTopicValidator('contains BADMARKER here')).toEqual([
      { rule: 'hit', detail: 'saw marker' },
    ])
    expect(await runTopicValidator('clean input')).toEqual([])
  })

  test('un-spawnable validator (bad interpreter) → [] (fail-open)', async () => {
    // Executable bit set, but the shebang interpreter does not exist → the child
    // fails to exec and the spawn "error" event fires. Must fail open.
    installValidator('#!/nonexistent/interp-xyz\nignored\n')
    expect(await runTopicValidator('x')).toEqual([])
  })

  test('non-zero exit → [] (fail-open, output ignored)', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' +
        `printf '{"rule":"r","detail":"d"}\\n'\n` +
        'exit 2\n',
    )
    expect(await runTopicValidator('x')).toEqual([])
  })

  test('timeout → [] (fail-open) — hanging validator is killed', async () => {
    installValidator('#!/usr/bin/env bash\nsleep 30\n')
    process.env.TOPIC_VALIDATOR_TIMEOUT_MS = '200' // tiny cap so the test is fast
    try {
      const start = Date.now()
      expect(await runTopicValidator('x')).toEqual([])
      expect(Date.now() - start).toBeLessThan(5000) // killed, not waited out
    } finally {
      delete process.env.TOPIC_VALIDATOR_TIMEOUT_MS
    }
  })
})

describe('handleTopicValidation (Plan A transparency + regen cap)', () => {
  const baseOpts = (web: unknown) => ({
    web: asWeb(web),
    channel: 'C1',
    threadTs: '100.200',
  })

  test('clean answer → null, no notice', async () => {
    installValidator('#!/usr/bin/env bash\nexit 0\n')
    const { web, postMessage } = makeWeb()
    const r = await handleTopicValidation({ ...baseOpts(web), text: 'good' })
    expect(r).toBeNull()
    expect(postMessage).not.toHaveBeenCalled()
  })

  test('violation → isError result + regenerating notice', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' + `printf '{"rule":"r","detail":"do X"}\\n'\nexit 0\n`,
    )
    const { web, postMessage } = makeWeb()
    const r = await handleTopicValidation({ ...baseOpts(web), text: 'bad' })
    expect(r?.isError).toBe(true)
    expect(r?.content[0].text).toContain('do X')
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  test('rejects up to MAX_REGEN then accepts with warning', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' + `printf '{"rule":"r","detail":"d"}\\n'\nexit 0\n`,
    )
    const { web, postMessage } = makeWeb()
    const opts = { ...baseOpts(web), text: 'always-bad' }

    // attempts 1..3 reject (isError)
    for (let i = 0; i < 3; i++) {
      const r = await handleTopicValidation(opts)
      expect(r?.isError).toBe(true)
    }
    // 4th: cap exceeded → accept (null) + final warning notice
    const last = await handleTopicValidation(opts)
    expect(last).toBeNull()
    // 3 "regenerating" notices + 1 final warning = 4 posts
    expect(postMessage).toHaveBeenCalledTimes(4)
  })

  test('clean answer resets the attempt counter', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' +
        'in=$(cat)\n' +
        'case "$in" in\n' +
        `  *BAD*) printf '{"rule":"r","detail":"d"}\\n' ;;\n` +
        'esac\n' +
        'exit 0\n',
    )
    const { web } = makeWeb()
    const opts = baseOpts(web)

    await handleTopicValidation({ ...opts, text: 'BAD 1' }) // attempt 1
    await handleTopicValidation({ ...opts, text: 'BAD 2' }) // attempt 2
    const reset = await handleTopicValidation({ ...opts, text: 'clean' }) // resets
    expect(reset).toBeNull()
    // After reset, a fresh bad answer should reject again (attempt back to 1).
    const after = await handleTopicValidation({ ...opts, text: 'BAD 3' })
    expect(after?.isError).toBe(true)
  })

  test('notice post failure does not throw', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' + `printf '{"rule":"r","detail":"d"}\\n'\nexit 0\n`,
    )
    const postMessage = mock(async () => {
      throw new Error('slack down')
    })
    const web = { chat: { postMessage } }
    const r = await handleTopicValidation({ ...baseOpts(web), text: 'bad' })
    // Still returns the isError result so the agent regenerates.
    expect(r?.isError).toBe(true)
  })
})
