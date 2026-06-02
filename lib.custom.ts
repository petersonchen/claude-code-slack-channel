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

export type CustomAccess = Access & {
  /** Ordered list of case-insensitive string substitutions applied to all
   *  outbound reply text before sending. Earlier entries take priority. */
  textSubstitutions?: Array<{ from: string; to: string }>
  /** Default automatic reply engine. Absent keeps upstream Claude delivery. */
  replyEngine?: CustomReplyEngine
  /** Default ubi-code model profile when a channel routes to the ubi_code engine
   *  without its own override. Absent lets ubi-code pick its own default. */
  ubiCodeProfile?: string
}

export type CustomChannelPolicy = ChannelPolicy & {
  /** Drop messages that @-mention any user other than this bot.
   *  Prevents responding to cross-user conversations. Default-safe: absent/false = no drop. */
  dropIfMentionsOther?: boolean
  /** Within a thread, only the thread's owner (first sender) gets bot responses.
   *  Other users are silenced unless they explicitly @mention the bot. Default-safe: absent/false = off. */
  threadOwnerOnly?: boolean
  /** Post a "_Thinking..._" placeholder immediately on message receipt, then overwrite it
   *  with the real reply when Claude responds. Default-safe: absent/false = off. */
  thinkingIndicator?: boolean
  /** Per-channel automatic reply engine override. */
  replyEngine?: CustomReplyEngine
  /** Per-channel ubi-code model profile (only meaningful when replyEngine resolves to
   *  ubi_code). Sent to ubi-code as the `profile` field; unknown there falls back to
   *  ubi-code's own default. */
  ubiCodeProfile?: string
  /** Context recovery controls for ubi-code thread history fetches. */
  contextRecovery?: {
    includeUsers?: 'owner_and_bot_only' | 'allowlisted_and_bot' | 'all_sanitized'
  }
}

export type CustomReplyEngine = 'claude' | 'ubi_code' | 'off'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function applySubstitutions(
  text: string,
  subs: ReadonlyArray<{ from: string; to: string }> | undefined,
): string {
  if (!subs || subs.length === 0) return text
  let result = text
  for (const { from, to } of subs) {
    if (!from) continue
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(escaped, 'gi'), to)
  }
  return result
}

export function isMentioned(event: Record<string, unknown>, botUserId: string): boolean {
  if (!botUserId) return false
  const text = (event.text as string | undefined) || ''
  return text.includes(`<@${botUserId}>`)
}

export function resolveReplyEngine(
  access: Access,
  channelId: string,
  env: Record<string, string | undefined> = process.env,
): CustomReplyEngine {
  const customAccess = access as CustomAccess
  const policy = access.channels[channelId] as CustomChannelPolicy | undefined
  const value = policy?.replyEngine ?? customAccess.replyEngine ?? env.SLACK_REPLY_ENGINE ?? 'claude'
  if (value === 'ubi_code' || value === 'off' || value === 'claude') return value
  return 'claude'
}

/** Resolve the ubi-code model profile for a channel. Precedence: per-channel policy →
 *  workspace default → UBI_CODE_MODEL_PROFILE env → undefined (ubi-code uses its own
 *  default). Only meaningful when the resolved engine is ubi_code. */
export function resolveUbiCodeProfile(
  access: Access,
  channelId: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const customAccess = access as CustomAccess
  const policy = access.channels[channelId] as CustomChannelPolicy | undefined
  const value = policy?.ubiCodeProfile ?? customAccess.ubiCodeProfile ?? env.UBI_CODE_MODEL_PROFILE
  return value || undefined
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
