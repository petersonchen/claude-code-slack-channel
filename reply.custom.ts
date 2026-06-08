// Custom feature — shared outbound *answer* path for service-backed reply services.
// Isolated in its own *.custom.ts so upstream server.ts / lib.ts stay rebase-pristine.
//
// WHY THIS EXISTS
// ---------------
// Answer-text substitution (workspace `textSubstitutions`: branding masks + the
// `SLW-CMDB-ADMIN` escalation placeholder) was applied ad-hoc at each reply site. That meant
// every NEW reply service had to remember to call applySubstitutions itself; forgetting
// leaks raw `SLW-CMDB-ADMIN` to Slack and breaks the claude→LLM mask. `sendServiceAnswer()` is
// the shared chokepoint: it runs `prepareAnswerText()` INTERNALLY, then chunks and posts.
// Any service-backed reply path (ubi-code today, future services tomorrow) that routes
// its answer through here gets substitution for free — structurally, not by convention.
//
// The native MCP `reply` tool in server.ts (executeReply) is a separate, pre-existing
// path with its own streaming / file-upload / outbound-gate logic; it applies the same
// substitution via its own established custom line. New *reply services* (resolved by
// resolveReplyService → maybeHandle*) are the extension point and belong here.

import type { WebClient } from '@slack/web-api'
import type { Access } from './lib.ts'
import { prepareAnswerText } from './lib.custom.ts'

const SLACK_CHUNK_MAX_BYTES = 3000

/** Split text into Slack-postable chunks no larger than SLACK_CHUNK_MAX_BYTES bytes,
 *  never splitting a multi-byte character. Always returns at least one chunk. */
export function chunkByBytes(text: string): string[] {
  const enc = new TextEncoder()
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = start
    let bytes = 0
    while (end < text.length) {
      const b = enc.encode(text[end]).length
      if (bytes + b > SLACK_CHUNK_MAX_BYTES) break
      bytes += b
      end++
    }
    if (end === start) end = start + 1 // always advance past a single oversized char
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks.length > 0 ? chunks : ['']
}

export type SendServiceAnswerOpts = {
  web: WebClient
  /** Workspace access — source of `textSubstitutions`. */
  access: Access
  channel: string
  threadTs: string
  /** If set, the first chunk overwrites this thinking-placeholder message via
   *  chat.update; otherwise a fresh message is posted. */
  placeholderTs: string | null
  /** Raw answer text from the service. Substitutions are applied here — callers MUST
   *  pass the unsubstituted text so the chokepoint runs exactly once. */
  text: string
  /** Optional outbound value-exfiltration guard (ccsc-z0n.3). Bound to the live
   *  secret values by the caller (server.ts `assertNoSecretValues`). Checked once
   *  on the full substituted answer before anything is posted, so a leaked secret
   *  is blocked even if it would straddle a chunk boundary. Throws → nothing is
   *  posted. Absent → no value check (back-compat). */
  assertNoSecretValues?: (payload: string) => void
  /** Optional structured error logger (e.g. ubi-code's ubiLog). */
  log?: (level: 'error', msg: string, extra?: Record<string, unknown>) => void
}

/** Shared outbound answer path for service-backed reply services. Applies workspace
 *  textSubstitutions via prepareAnswerText(), chunks by Slack byte budget, then posts —
 *  overwriting a thinking placeholder on the first chunk when one is supplied. Returns the
 *  ts of the last posted/updated message (or null). Re-throws on Slack API failure. */
export async function sendServiceAnswer(opts: SendServiceAnswerOpts): Promise<string | null> {
  const text = prepareAnswerText(opts.access, opts.text)
  // Outbound secret-value guard runs on the full substituted text before any
  // post — a live token never reaches Slack, even split across chunks. Throws
  // before lastTs is touched, so a blocked answer posts nothing.
  opts.assertNoSecretValues?.(text)
  const chunks = chunkByBytes(text)
  let lastTs = opts.placeholderTs
  if (opts.placeholderTs) {
    try {
      await opts.web.chat.update({ channel: opts.channel, ts: opts.placeholderTs, text: chunks[0] })
    } catch (e) {
      opts.log?.('error', 'chat.update failed', {
        channel: opts.channel,
        chars: chunks[0].length,
        slack_error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  } else {
    const res = await opts.web.chat.postMessage({
      channel: opts.channel,
      thread_ts: opts.threadTs,
      text: chunks[0],
      unfurl_links: false,
      unfurl_media: false,
    })
    lastTs = (res.ts as string | undefined) ?? null
  }
  for (let i = 1; i < chunks.length; i++) {
    try {
      const res = await opts.web.chat.postMessage({
        channel: opts.channel,
        thread_ts: opts.threadTs,
        text: chunks[i],
        unfurl_links: false,
        unfurl_media: false,
      })
      lastTs = (res.ts as string | undefined) ?? lastTs
    } catch (e) {
      opts.log?.('error', 'chat.postMessage chunk failed', {
        channel: opts.channel,
        chunk_index: i,
        total_chunks: chunks.length,
        chars: chunks[i].length,
        slack_error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }
  return lastTs
}
