// Custom feature extensions — isolated so lib.ts stays upstream-pristine.
// When upstream ships a new lib.ts: overwrite it freely; this file and the
// server.ts import lines below never conflict.

import {
  type Access,
  type ChannelPolicy,
  type GateOptions,
  type GateResult,
  gate as libGate,
} from './lib.ts'

// ---------------------------------------------------------------------------
// Extended types (intersection — no lib.ts interface pollution)
// ---------------------------------------------------------------------------

export type CustomChannelPolicy = ChannelPolicy & {
  /** Drop messages that @-mention any user other than this bot.
   *  Prevents responding to cross-user conversations. Default-safe: absent/false = no drop. */
  dropIfMentionsOther?: boolean
  /** Within a thread, only the thread's owner (first sender) gets bot responses.
   *  Other users are silenced unless they explicitly @mention the bot. Default-safe: absent/false = off. */
  threadOwnerOnly?: boolean
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isMentioned(event: Record<string, unknown>, botUserId: string): boolean {
  if (!botUserId) return false
  const text = (event.text as string | undefined) || ''
  return text.includes(`<@${botUserId}>`)
}

function mentionsOtherUser(event: Record<string, unknown>, botUserId: string): boolean {
  const text = (event.text as string | undefined) || ''
  const matches = text.matchAll(/<@([A-Z0-9]+)>/g)
  for (const m of matches) {
    if (m[1] !== botUserId) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Custom gate wrapper — runs after libGate delivers, applies extra drop rules
// ---------------------------------------------------------------------------

export async function customGate(event: unknown, opts: GateOptions): Promise<GateResult> {
  const result = await libGate(event, opts)
  if (result.action !== 'deliver') return result

  const ev = event as Record<string, unknown>
  const channelId = ev.channel as string
  const policy = result.access?.channels[channelId] as CustomChannelPolicy | undefined

  if (policy?.dropIfMentionsOther && mentionsOtherUser(ev, opts.botUserId)) {
    return { action: 'drop' }
  }

  return result
}
