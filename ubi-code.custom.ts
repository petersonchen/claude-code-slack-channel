import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import type { WebClient } from '@slack/web-api'
import type { Access } from './lib.ts'
import { type CustomChannelPolicy, resolveReplyService, resolveUbiCodeProfile } from './lib.custom.ts'
import { sendServiceAnswer } from './reply.custom.ts'
import { traceReply } from './trace.custom.ts'

const UBI_ERROR_LOG = '/state/ubi-code-error.log'

function ubiLog(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra })
  try { appendFileSync(UBI_ERROR_LOG, line + '\n') } catch { /* state dir may not be mounted */ }
  if (level === 'error') console.error('[ubi-code]', msg, extra ?? '')
}

type JournalWrite = (input: any) => void

type UbiCodeStatus =
  | {
      status: 'answered'
      should_reply?: boolean
      answer?: string
      sources?: string[]
      confidence?: string
      rules?: string[]
    }
  | { status: 'needs_thread_history'; reason?: string }
  | { status: 'error'; error?: string }

type SanitizedSlackMessage = {
  ts: string
  user?: string
  text: string
  is_bot: boolean
}

type ThreadHistoryCacheEntry = {
  fetchedAt: number
  messages: SanitizedSlackMessage[]
}

export type MaybeHandleUbiCodeReplyOptions = {
  event: Record<string, unknown>
  access: Access
  web: WebClient
  botUserId: string
  ubiCodeUrl?: string
  sharedSecret?: string
  timeoutMs?: number
  journalWrite: JournalWrite
  activateSession: (channel: string, thread: string, ownerId: string | undefined) => Promise<void>
}

const historyCache = new Map<string, ThreadHistoryCacheEntry>()
const HISTORY_CACHE_TTL_MS = 60_000
const MAX_HISTORY_MESSAGES = 30
const MAX_HISTORY_CHARS = 12_000

function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text || '').digest('hex')}`
}

function stripBotMention(text: string, botUserId: string): string {
  if (!botUserId) return text
  return text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim()
}

function threadTsFor(ev: Record<string, unknown>): string {
  return (ev.thread_ts as string | undefined) ?? (ev.ts as string)
}


function contextRecoveryMode(access: Access, channel: string): string {
  const policy = access.channels[channel] as CustomChannelPolicy | undefined
  return policy?.contextRecovery?.includeUsers ?? 'owner_and_bot_only'
}

function sanitizeMessages(
  rawMessages: any[],
  access: Access,
  channel: string,
  currentUser: string,
  botUserId: string,
): SanitizedSlackMessage[] {
  const mode = contextRecoveryMode(access, channel)
  const rootUser = rawMessages.find((m) => typeof m?.user === 'string')?.user as string | undefined
  const allowlisted = new Set<string>([
    ...(access.allowFrom ?? []),
    ...(((access.channels[channel] as any)?.allowFrom ?? []) as string[]),
  ])
  const messages: SanitizedSlackMessage[] = []
  let chars = 0

  for (const msg of rawMessages.slice(-MAX_HISTORY_MESSAGES)) {
    const user = typeof msg?.user === 'string' ? msg.user : undefined
    const isBot = msg?.bot_id !== undefined || user === botUserId
    if (mode === 'owner_and_bot_only' && !isBot && user !== rootUser && user !== currentUser) continue
    if (mode === 'allowlisted_and_bot' && !isBot && (!user || !allowlisted.has(user))) continue

    const text = String(msg?.text || '').trim()
    if (!text) continue
    const remaining = MAX_HISTORY_CHARS - chars
    if (remaining <= 0) break
    const clipped = text.slice(0, remaining)
    chars += clipped.length
    messages.push({ ts: String(msg?.ts || ''), user, text: clipped, is_bot: isBot })
  }

  return messages
}

async function fetchThreadHistory(opts: {
  web: WebClient
  access: Access
  channel: string
  threadTs: string
  currentUser: string
  botUserId: string
}): Promise<SanitizedSlackMessage[]> {
  const key = `${opts.channel}:${opts.threadTs}`
  const cached = historyCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) return cached.messages

  const res = await opts.web.conversations.replies({
    channel: opts.channel,
    ts: opts.threadTs,
    limit: MAX_HISTORY_MESSAGES,
  })
  const messages = sanitizeMessages(
    res.messages || [],
    opts.access,
    opts.channel,
    opts.currentUser,
    opts.botUserId,
  )
  historyCache.set(key, { fetchedAt: Date.now(), messages })
  return messages
}

async function callUbiCode(
  url: string,
  body: Record<string, unknown>,
  sharedSecret: string | undefined,
  timeoutMs: number,
): Promise<UbiCodeStatus> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/answer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(sharedSecret ? { authorization: `Bearer ${sharedSecret}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const payload = (await res.json().catch(() => ({}))) as UbiCodeStatus
    if (!res.ok) return { status: 'error', error: `ubi_code_http_${res.status}` }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

async function postThinkingIfEnabled(opts: {
  web: WebClient
  access: Access
  channel: string
  threadTs: string
}): Promise<string | null> {
  const policy = opts.access.channels[opts.channel] as CustomChannelPolicy | undefined
  if (!policy?.thinkingIndicator) return null
  const res = await opts.web.chat.postMessage({
    channel: opts.channel,
    thread_ts: opts.threadTs,
    text: '_Thinking..._',
    unfurl_links: false,
    unfurl_media: false,
  })
  return (res.ts as string | undefined) ?? null
}

export async function maybeHandleUbiCodeReply(opts: MaybeHandleUbiCodeReplyOptions): Promise<boolean> {
  const channel = opts.event.channel as string
  const service = resolveReplyService(opts.access, channel)
  if (service === 'slack-cc') return false
  if (service === 'off') return true

  const ubiCodeUrl = opts.ubiCodeUrl || process.env.UBI_CODE_URL
  if (!ubiCodeUrl) {
    opts.journalWrite({
      kind: 'ubi_code.error',
      outcome: 'deny',
      reason: 'missing_UBI_CODE_URL',
      input: { channel },
    })
    return false
  }

  const threadTs = threadTsFor(opts.event)
  const messageTs = opts.event.ts as string
  const user = opts.event.user as string | undefined
  const text = stripBotMention((opts.event.text as string | undefined) || '', opts.botUserId)
  const requestId = randomUUID()

  await opts.activateSession(channel, threadTs, user)

  let placeholderTs: string | null = null
  try {
    placeholderTs = await postThinkingIfEnabled({
      web: opts.web,
      access: opts.access,
      channel,
      threadTs,
    })

    const ubiCodeProfile = resolveUbiCodeProfile(opts.access, channel)
    const baseRequest = {
      request_id: requestId,
      channel,
      thread_ts: threadTs,
      message_ts: messageTs,
      user: user ?? 'unknown',
      text,
      metadata: { is_dm: String(opts.event.channel_type || '') === 'im' },
      ...(ubiCodeProfile ? { profile: ubiCodeProfile } : {}),
    }

    const startedAt = Date.now()
    let response = await callUbiCode(
      ubiCodeUrl,
      baseRequest,
      opts.sharedSecret ?? process.env.UBI_CODE_SHARED_SECRET,
      opts.timeoutMs ?? 120_000,
    )

    if (response.status === 'needs_thread_history') {
      try {
        const threadHistory = await fetchThreadHistory({
          web: opts.web,
          access: opts.access,
          channel,
          threadTs,
          currentUser: user ?? '',
          botUserId: opts.botUserId,
        })
        response = await callUbiCode(
          ubiCodeUrl,
          { ...baseRequest, thread_history: threadHistory },
          opts.sharedSecret ?? process.env.UBI_CODE_SHARED_SECRET,
          opts.timeoutMs ?? 120_000,
        )
      } catch {
        response = await callUbiCode(
          ubiCodeUrl,
          { ...baseRequest, thread_history_error: 'not_available' },
          opts.sharedSecret ?? process.env.UBI_CODE_SHARED_SECRET,
          opts.timeoutMs ?? 120_000,
        )
      }
    }

    if (response.status !== 'answered' || response.should_reply === false) {
      opts.journalWrite({
        kind: 'ubi_code.no_reply',
        outcome: 'n/a',
        input: { channel, thread_ts: threadTs, request_id: requestId, status: response.status },
      })
      traceReply({
        channel,
        thread: threadTs,
        service: 'ubi-code',
        profile: ubiCodeProfile,
        status: response.status ?? 'no_reply',
        latencyMs: Date.now() - startedAt,
        question: text,
      })
      return true
    }

    // Raw model output. Workspace textSubstitutions (SLW-CMDB-ADMIN escalation placeholder +
    // claude→LLM masking) are applied inside sendServiceAnswer() — the shared chokepoint
    // every service-backed reply path funnels through — not here. trace/journal log the
    // pre-substitution model output on purpose.
    const answer = response.answer || 'wiki 中沒有相關資料'
    traceReply({
      channel,
      thread: threadTs,
      service: 'ubi-code',
      profile: ubiCodeProfile,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      rules: response.rules,
      question: text,
      answer,
    })
    const replyTs = await sendServiceAnswer({
      web: opts.web,
      access: opts.access,
      channel,
      threadTs,
      placeholderTs,
      text: answer,
      log: ubiLog,
    })
    opts.journalWrite({
      kind: 'ubi_code.reply',
      outcome: 'allow',
      input: {
        channel,
        thread_ts: threadTs,
        request_id: requestId,
        question_hash: hashText(text),
        answer_hash: hashText(answer),
        sources: response.sources ?? [],
        confidence: response.confidence,
        reply_ts: replyTs,
      },
    })
    return true
  } catch (err) {
    ubiLog('error', 'maybeHandleUbiCodeReply failed', {
      channel,
      thread_ts: threadTs,
      request_id: requestId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? (err.stack ?? '') : '',
    })
    const fallback = '發生錯誤，暫時無法回答。請稍後再試。'
    try {
      await sendServiceAnswer({
        web: opts.web,
        access: opts.access,
        channel,
        threadTs,
        placeholderTs,
        text: fallback,
        log: ubiLog,
      })
    } catch {
      // Best effort. The journal entry below is the durable signal.
    }
    opts.journalWrite({
      kind: 'ubi_code.error',
      outcome: 'deny',
      reason: err instanceof Error ? err.message : String(err),
      input: { channel, thread_ts: threadTs, request_id: requestId, question_hash: hashText(text) },
    })
    return true
  }
}
