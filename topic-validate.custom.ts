// Custom feature — per-topic answer validator for the native `reply` path.
// Isolated in its own *.custom.ts so upstream server.ts stays rebase-pristine
// (executeReply carries only a minimal hook line, same pattern as applySubstitutions).
//
// WHAT THIS IS
// -----------
// Each wiki-topic ships an executable at `${WIKI_PATH}/.wikimeta/response/check`
// (contract: docs/wiki-topic-validator-spec.md). Before the native reply path
// finalizes, we run that validator over the answer text. It emits JSON-lines
// violations on stdout; we feed those back to the agent so it regenerates a
// corrected answer IN-SESSION.
//
// WHY CODE-GATE, NOT SKILL
// ------------------------
// The validator must be engine-agnostic and not skippable by the model. Running
// it here (child_process, after the agent calls reply) means the model can't
// route around it, and the agent never executes the script itself (it's blocked
// from Bash anyway). See the design plan + spec for the full rationale.
//
// TRANSPARENCY (Plan A)
// ---------------------
// The bad draft is already posted to Slack when we validate (executeReply posts,
// then calls us). We append a "regenerating" notice and return an isError tool
// result; the agent regenerates and calls reply again, appending the fixed draft.
// Because the bad draft is visible to the user, "claude references something the
// user never saw" cannot happen — what the model saw == what Slack shows.
//
// INFINITE-REGEN GUARD
// --------------------
// A model that keeps producing bad YAML + a gate that keeps rejecting = infinite
// loop + thread spam. We cap regen attempts per (channel:thread); past the cap we
// accept the answer with a warning notice instead of rejecting again.

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { WebClient } from '@slack/web-api'

/** Minimal mirror of server.ts's ToolResult — kept local to avoid importing
 *  upstream-private types into a custom module. */
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean }

/** One violation as emitted by the topic validator (one JSON object per stdout line). */
type Violation = { rule: string; detail: string }

/** Wiki content root inside the container. slack-cc has no WIKI_PATH env set, but
 *  mounts the active topic at /app/wiki — same convention as ubi-code guard.mjs.
 *  Resolved lazily (per call) so the active-topic mount / tests can vary it. */
function wikiPath(): string {
  return process.env.WIKI_PATH || '/app/wiki'
}

/** Validator entry path, per docs/wiki-topic-validator-spec.md. */
function validatorPath(): string {
  return join(wikiPath(), '.wikimeta', 'response', 'check')
}

/** Hard wall-clock cap on the validator. Past this we kill it and fail-open.
 *  Default 15s (the spec contract); overridable via env for ops tuning / tests. */
function validatorTimeoutMs(): number {
  const raw = Number(process.env.TOPIC_VALIDATOR_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000
}

/** Max in-session regenerations before we stop rejecting and accept with a warning. */
const MAX_REGEN = 3

/** Per-(channel:thread) regen attempt counter. Module-level, same lifetime model
 *  as placeholder-store.custom.ts. */
const attempts = new Map<string, number>()

function bumpAttempt(key: string): number {
  const n = (attempts.get(key) ?? 0) + 1
  attempts.set(key, n)
  return n
}

function resetAttempt(key: string): void {
  attempts.delete(key)
}

/** Test-only: clear the per-thread attempt counter so cases don't bleed state. */
export function __resetAttemptsForTest(): void {
  attempts.clear()
}

/** Run the topic validator over the answer text. Returns the violations it
 *  reports, or [] when the topic has no validator OR the validator itself fails
 *  (fail-open: a broken validator must never block answering). Never throws. */
export async function runTopicValidator(answerText: string): Promise<Violation[]> {
  const validator = validatorPath()
  // Missing or non-executable → topic opts out of validation. Silent no-op.
  try {
    accessSync(validator, constants.X_OK)
  } catch {
    return []
  }

  return new Promise<Violation[]>((resolve) => {
    let settled = false
    const done = (v: Violation[]) => {
      if (settled) return
      settled = true
      resolve(v)
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(validator, [], {
        env: { ...process.env, WIKI_PATH: wikiPath() },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      console.error('[topic-validate] spawn failed', e instanceof Error ? e.message : String(e))
      return done([])
    }

    const timer = setTimeout(() => {
      console.error('[topic-validate] timeout, killing validator')
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      done([]) // fail-open on timeout
    }, validatorTimeoutMs())

    let stdout = ''
    proc.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    // Drain stderr so a chatty validator can't block on a full pipe; ignore content.
    proc.stderr?.on('data', () => {})

    proc.on('error', (e) => {
      clearTimeout(timer)
      console.error('[topic-validate] process error', e instanceof Error ? e.message : String(e))
      done([]) // fail-open
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      // Non-zero exit = validator self-failure → fail-open (ignore output).
      if (code !== 0) {
        if (code !== null) console.error(`[topic-validate] validator exit ${code}, fail-open`)
        return done([])
      }
      done(parseViolations(stdout))
    })

    // Feed the answer on stdin, then close it.
    try {
      proc.stdin?.write(answerText)
      proc.stdin?.end()
    } catch (e) {
      clearTimeout(timer)
      console.error('[topic-validate] stdin write failed', e instanceof Error ? e.message : String(e))
      done([])
    }
  })
}

/** Parse JSON-lines stdout into violations. Lines that don't parse into a
 *  {rule, detail} shape are ignored (forward-compatible). */
function parseViolations(stdout: string): Violation[] {
  const out: Violation[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (o && typeof o.rule === 'string' && typeof o.detail === 'string') {
        out.push({ rule: o.rule, detail: o.detail })
      }
    } catch {
      // non-JSON line (e.g. stray debug) — ignore
    }
  }
  return out
}

/** Build the tool-error text fed back to the agent so it regenerates. The
 *  `detail` strings are authored by the topic as actionable fix instructions. */
function buildFixInstruction(violations: Violation[]): string {
  const lines = violations.map((v) => `- [${v.rule}] ${v.detail}`).join('\n')
  return (
    '你剛送出的回答未通過該 wiki topic 的語法檢查,違規如下:\n' +
    lines +
    '\n\n請修正後用 reply tool 重新送出完整回答。'
  )
}

export type HandleTopicValidationOpts = {
  web: WebClient
  channel: string
  threadTs: string | undefined
  /** The substituted answer text that was just posted to Slack. */
  text: string
}

/** Plan-A transparency handler. Validates the just-posted answer; on violations
 *  (under the regen cap) posts a "regenerating" notice and returns an isError
 *  ToolResult so the agent regenerates in-session. Returns null to let
 *  executeReply finalize normally (clean answer, or cap reached). Never throws —
 *  any internal failure fails open to null. */
export async function handleTopicValidation(
  opts: HandleTopicValidationOpts,
): Promise<ToolResult | null> {
  const key = `${opts.channel}:${opts.threadTs ?? ''}`
  // runTopicValidator never rejects — it resolves [] on every internal failure
  // (fail-open is its contract), so no try/catch is needed here.
  const violations = await runTopicValidator(opts.text)

  if (violations.length === 0) {
    resetAttempt(key)
    return null
  }

  const attempt = bumpAttempt(key)
  if (attempt > MAX_REGEN) {
    // Cap reached — accept the answer (already posted) but warn the user.
    resetAttempt(key)
    await postNotice(opts, '⚠️ 範例可能未通過語法檢查,已嘗試重新產生但未成功,請人工確認。')
    return null
  }

  await postNotice(opts, '⚠️ 範例未通過語法檢查,重新產生中…')
  return {
    content: [{ type: 'text', text: buildFixInstruction(violations) }],
    isError: true,
  }
}

/** Append a plain notice message to the thread. Best-effort: a failed notice
 *  must not break the regen flow (the tool-error return is what matters). */
async function postNotice(opts: HandleTopicValidationOpts, text: string): Promise<void> {
  try {
    await opts.web.chat.postMessage({
      channel: opts.channel,
      thread_ts: opts.threadTs,
      text: `_${text}_`,
      unfurl_links: false,
      unfurl_media: false,
    })
  } catch (e) {
    console.error('[topic-validate] notice post failed', e instanceof Error ? e.message : String(e))
  }
}
