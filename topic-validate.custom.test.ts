import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
let traceLog: string
const savedWikiPath = process.env.WIKI_PATH
const savedTraceLog = process.env.SLACK_TRACE_LOG

/** Read the validate trace lines written this test (best-effort; may be empty). */
function readTrace(): string {
  try {
    return readFileSync(traceLog, 'utf8')
  } catch {
    return ''
  }
}

/** traceValidate appends fire-and-forget (not awaited), so poll until the
 *  expected marker shows up or we time out. */
async function waitForTrace(marker: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const t = readTrace()
    if (t.includes(marker)) return t
    await new Promise((r) => setTimeout(r, 10))
  }
  return readTrace()
}

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
  traceLog = join(topicRoot, 'trace.log')
  process.env.WIKI_PATH = topicRoot
  process.env.SLACK_TRACE_LOG = traceLog
  __resetAttemptsForTest()
})

afterEach(() => {
  rmSync(topicRoot, { recursive: true, force: true })
  if (savedWikiPath === undefined) delete process.env.WIKI_PATH
  else process.env.WIKI_PATH = savedWikiPath
  if (savedTraceLog === undefined) delete process.env.SLACK_TRACE_LOG
  else process.env.SLACK_TRACE_LOG = savedTraceLog
})

describe('runTopicValidator', () => {
  test('missing validator → ran=false (topic opts out)', async () => {
    expect(await runTopicValidator('any answer')).toEqual({
      violations: [],
      ran: false,
      failed: false,
      latencyMs: 0,
    })
  })

  test('clean answer (no stdout) → ran, no violations', async () => {
    installValidator('#!/usr/bin/env bash\nexit 0\n')
    const r = await runTopicValidator('```yaml\nok: true\n```')
    expect(r.violations).toEqual([])
    expect(r.ran).toBe(true)
    expect(r.failed).toBe(false)
  })

  test('parses JSON-lines violations from stdout', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' +
        `printf '{"rule":"yaml-syntax","detail":"fix indent"}\\n'\n` +
        `printf '{"rule":"dot-path","detail":"use ->"}\\n'\n` +
        'exit 0\n',
    )
    const r = await runTopicValidator('bad')
    expect(r.violations).toEqual([
      { rule: 'yaml-syntax', detail: 'fix indent' },
      { rule: 'dot-path', detail: 'use ->' },
    ])
    expect(r.failed).toBe(false)
  })

  test('ignores non-JSON / malformed lines (forward-compatible)', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' +
        "echo 'debug noise'\n" +
        `printf '{"rule":"r","detail":"d"}\\n'\n` +
        `printf '{"rule":"missing-detail"}\\n'\n` +
        'exit 0\n',
    )
    expect((await runTopicValidator('x')).violations).toEqual([{ rule: 'r', detail: 'd' }])
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
    expect((await runTopicValidator('contains BADMARKER here')).violations).toEqual([
      { rule: 'hit', detail: 'saw marker' },
    ])
    expect((await runTopicValidator('clean input')).violations).toEqual([])
  })

  test('un-spawnable validator (bad interpreter) → failed (fail-open)', async () => {
    // Executable bit set, but the shebang interpreter does not exist → the child
    // fails to exec. Must fail open: ran=true, failed=true, no violations.
    installValidator('#!/nonexistent/interp-xyz\nignored\n')
    const r = await runTopicValidator('x')
    expect(r.violations).toEqual([])
    expect(r.failed).toBe(true)
  })

  test('non-zero exit → failed (fail-open, output ignored)', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' +
        `printf '{"rule":"r","detail":"d"}\\n'\n` +
        'exit 2\n',
    )
    const r = await runTopicValidator('x')
    expect(r.violations).toEqual([])
    expect(r.failed).toBe(true)
  })

  test('timeout → failed (fail-open) — hanging validator is killed', async () => {
    installValidator('#!/usr/bin/env bash\nsleep 30\n')
    process.env.TOPIC_VALIDATOR_TIMEOUT_MS = '200' // tiny cap so the test is fast
    try {
      const start = Date.now()
      const r = await runTopicValidator('x')
      expect(r.violations).toEqual([])
      expect(r.failed).toBe(true)
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

describe('handleTopicValidation trace lines', () => {
  const baseOpts = (web: unknown) => ({
    web: asWeb(web),
    channel: 'C9',
    threadTs: '900.100',
  })

  test('clean → outcome=pass', async () => {
    installValidator('#!/usr/bin/env bash\nexit 0\n')
    await handleTopicValidation({ ...baseOpts(makeWeb().web), text: 'good' })
    const t = await waitForTrace('| validate |')
    expect(t).toContain('outcome=pass')
    expect(t).toContain('ch=C9 thr=900.100')
  })

  test('violation → outcome=violations with rules + attempt', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' + `printf '{"rule":"yaml-syntax","detail":"d"}\\n'\nexit 0\n`,
    )
    await handleTopicValidation({ ...baseOpts(makeWeb().web), text: 'bad' })
    const t = await waitForTrace('outcome=violations')
    expect(t).toContain('outcome=violations')
    expect(t).toContain('count=1')
    expect(t).toContain('rules=yaml-syntax')
    expect(t).toContain('attempt=1')
  })

  test('validator self-failure → outcome=error', async () => {
    installValidator('#!/usr/bin/env bash\nexit 2\n')
    await handleTopicValidation({ ...baseOpts(makeWeb().web), text: 'x' })
    const t = await waitForTrace('outcome=error')
    expect(t).toContain('outcome=error')
  })

  test('cap reached → outcome=cap_reached', async () => {
    installValidator(
      '#!/usr/bin/env bash\n' + `printf '{"rule":"r","detail":"d"}\\n'\nexit 0\n`,
    )
    const opts = { ...baseOpts(makeWeb().web), text: 'always-bad' }
    for (let i = 0; i < 4; i++) await handleTopicValidation(opts) // 3 reject + 1 cap
    const t = await waitForTrace('outcome=cap_reached')
    expect(t).toContain('outcome=cap_reached')
  })

  test('no validator → no validate trace line (silent opt-out)', async () => {
    // No installValidator() call → topic has no check.
    await handleTopicValidation({ ...baseOpts(makeWeb().web), text: 'anything' })
    await new Promise((r) => setTimeout(r, 50))
    expect(readTrace()).not.toContain('| validate |')
  })
})
