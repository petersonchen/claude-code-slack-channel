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
  // NOTE: no workspace-level replyService — the workspace default is fixed to
  // 'ubi-code' in resolveReplyService() and cannot be set via access.json. Only a
  // per-channel policy (or the SLACK_REPLY_SERVICE env) overrides it.
  /** Default ubi-code model profile when a channel routes to the ubi-code service
   *  without its own override. Absent → no profile sent → ubi-code rejects with 400. */
  ubiCodeProfile?: string
}

export type CustomChannelPolicy = ChannelPolicy & {
  /** Single switch governing when the bot auto-engages in a thread. Unified rule
   *  (first match wins), applied per inbound message:
   *    1. message @mentions the bot            → answer (explicit call wins)
   *    2. thread's FIRST message tags another   → mark thread ownerless, drop
   *       user and does NOT @bot
   *    3. thread is ownerless                   → drop (only @bot answers, via 1)
   *    4. owned thread, sender == owner,        → answer
   *       no other-user tag
   *    5. owned thread, anything else (non-owner;→ drop
   *       or owner tagging another user)
   *  Rule 5 drops tag-other messages (even the owner's), which is why no separate
   *  "drop if mentions other" flag is needed. Default-safe: absent/false = off. */
  ownerReplyGate?: boolean
  /** Post a "_Thinking..._" placeholder immediately on message receipt, then overwrite it
   *  with the real reply when Claude responds. Default-safe: absent/false = off. */
  thinkingIndicator?: boolean
  /** Per-channel reply service override. */
  replyService?: CustomReplyService
  /** Per-channel ubi-code model profile (only meaningful when replyService resolves to
   *  ubi-code). Sent to ubi-code as the `profile` field. No server-side default there —
   *  unknown / absent profile is rejected with 400. */
  ubiCodeProfile?: string
  /** Context recovery controls for ubi-code thread history fetches. */
  contextRecovery?: {
    includeUsers?: 'owner_and_bot_only' | 'allowlisted_and_bot' | 'all_sanitized'
  }
}

// Values match the service folder names. 'slack-cc' = slack-cc's own native Claude
// delivery; 'ubi-code' = route to the ubi-code service; 'off' = no auto reply. (Distinct
// from ubi-code's internal profile.engine = 'claude-cli' | 'ai-sdk', which only governs
// how the ubi-code service calls its LLM.)
export type CustomReplyService = 'slack-cc' | 'ubi-code' | 'off'

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

/** The single mandatory chokepoint for outbound *answer* text. Every reply service MUST
 *  route its user-facing answer through this — directly, or (preferred) via
 *  `sendServiceAnswer()` in reply.custom.ts, which calls it internally — before posting to
 *  Slack. This is what makes workspace `textSubstitutions` (branding masks, the `SLW-CMDB-ADMIN`
 *  escalation placeholder) apply uniformly across ALL reply services. A new reply service
 *  that posts answer text without going through here will leak raw placeholders.
 *
 *  System / receipt / audit / manifest / thinking-placeholder messages intentionally
 *  bypass this — substitutions apply to user answers only, never to those surfaces. */
export function prepareAnswerText(access: Access, text: string): string {
  return applySubstitutions(text, (access as CustomAccess).textSubstitutions)
}

export function isMentioned(event: Record<string, unknown>, botUserId: string): boolean {
  if (!botUserId) return false
  const text = (event.text as string | undefined) || ''
  return text.includes(`<@${botUserId}>`)
}

export function resolveReplyService(
  access: Access,
  channelId: string,
  env: Record<string, string | undefined> = process.env,
): CustomReplyService {
  const policy = access.channels[channelId] as CustomChannelPolicy | undefined
  // Workspace default is fixed to 'ubi-code' in code (NOT settable via access.json):
  // an unconfigured channel routes to ubi-code, sends no profile, and gets a 400 there —
  // forcing every ubi-code channel to declare its ubiCodeProfile. Only a per-channel
  // policy or the SLACK_REPLY_SERVICE env can override this default.
  const value = policy?.replyService ?? env.SLACK_REPLY_SERVICE ?? 'ubi-code'
  if (value === 'ubi-code' || value === 'off' || value === 'slack-cc') return value
  return 'ubi-code'
}

/** Resolve the ubi-code model profile for a channel. Precedence: per-channel policy →
 *  workspace default → UBI_CODE_MODEL_PROFILE env → undefined. Only meaningful when the
 *  resolved service is ubi-code; undefined → no profile sent → ubi-code rejects with 400. */
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

export function mentionsOtherUser(event: Record<string, unknown>, botUserId: string): boolean {
  const text = (event.text as string | undefined) || ''
  // User mentions, including the piped display form `<@U123|name>`.
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    if (m[1] !== botUserId) return true
  }
  // Broadcast + user-group mentions also target other people. `<!date^...>`
  // is a date format, NOT a mention, so it is intentionally excluded.
  if (/<!(?:here|channel|everyone|subteam\^[A-Z0-9]+)/.test(text)) return true
  return false
}

/** Outcome of the `ownerReplyGate` unified rule for one inbound message.
 *   - `deliver`        — answer it (also the owned-thread first-message path,
 *                        whose owner session is created downstream).
 *   - `drop`           — silence it.
 *   - `open-ownerless` — thread's first message opened an ownerless thread; the
 *                        caller must persist the ownerless marker and drop. */
export type OwnerReplyGateDecision = 'deliver' | 'drop' | 'open-ownerless'

/** Pure core of the `ownerReplyGate` gate. The caller has already confirmed the
 *  channel has `ownerReplyGate: true` and resolved `existingSession` (null when
 *  this is the thread's first message). See the rule table on
 *  `CustomChannelPolicy.ownerReplyGate`. */
export function decideOwnerReplyGate(
  ev: Record<string, unknown>,
  botUserId: string,
  existingSession: { ownerId: string; ownerless?: boolean } | null,
): OwnerReplyGateDecision {
  if (isMentioned(ev, botUserId)) return 'deliver' // rule 1: @bot always wins
  const tagsOther = mentionsOtherUser(ev, botUserId)
  if (existingSession === null) {
    // First message, no @bot.
    if (tagsOther) return 'open-ownerless' // rule 2
    return 'deliver' // rule 4: plain opener → owned thread
  }
  if (existingSession.ownerless) return 'drop' // rule 3
  if (existingSession.ownerId !== (ev.user as string)) return 'drop' // rule 5: non-owner
  if (tagsOther) return 'drop' // rule 5: owner tags another user
  return 'deliver' // rule 4
}

// ---------------------------------------------------------------------------
// Custom gate wrapper — reserved extension seam over libGate.
// ---------------------------------------------------------------------------

/** Thin wrapper around the upstream `libGate`. Currently a passthrough: the
 *  `ownerReplyGate` gating runs later, in `deliverEvent` (server.ts), so that an
 *  explicit @bot can still win on a thread's first message (rule 1) — a gate-stage
 *  drop could not see thread/session state. Kept as the single seam where future
 *  custom *gate-stage* drop rules would attach without editing the upstream call
 *  path in server.ts. */
export async function customGate(event: unknown, opts: GateOptions): Promise<GateResult> {
  return libGate(event, opts)
}

// ---------------------------------------------------------------------------
// Fetch authorization filter — close the gate-bypass via fetch_messages /
// context-recovery (see docs/known-issues-reply-gating.md, Issue 2).
// ---------------------------------------------------------------------------

/** Minimal shape of a Slack message needed for authorization filtering. */
type FetchableMessage = { user?: string; bot_id?: string; text?: string }

/** Filter raw Slack thread/history messages so a fetch (e.g. context-recovery)
 *  cannot re-ingest content the inbound push gate would have dropped.
 *
 *  Mirrors the push-path drops:
 *   - bot's own messages are always kept (legitimate prior context);
 *   - `contextRecovery.includeUsers`, when set, is the explicit allowlist and
 *     takes precedence;
 *   - otherwise `ownerReplyGate` (unified rule) is applied with the same
 *     semantics as on delivery (@bot wins; only the owner's non-tagging messages
 *     are kept; an ownerless thread is signalled by `ownerId === undefined`).
 *
 *  Pure — `ownerId` is resolved by the caller (session ownerId, else the
 *  thread's first non-bot sender). */
export function filterFetchedMessages<T extends FetchableMessage>(
  messages: readonly T[],
  opts: {
    botUserId: string
    ownerId: string | undefined
    policy: CustomChannelPolicy | undefined
    allowFrom: readonly string[]
  },
): T[] {
  const { botUserId, ownerId, policy, allowFrom } = opts
  const includeUsers = policy?.contextRecovery?.includeUsers
  const isBot = (m: T): boolean => Boolean(m.bot_id) || m.user === botUserId

  return messages.filter((m): boolean => {
    if (isBot(m)) return true

    // Explicit context-recovery allowlist wins when configured.
    if (includeUsers === 'owner_and_bot_only') return m.user === ownerId
    if (includeUsers === 'allowlisted_and_bot')
      return m.user !== undefined && allowFrom.includes(m.user)
    if (includeUsers === 'all_sanitized') return true

    // Otherwise mirror the push-gate drop rules.
    // `ownerReplyGate` is the unified rule (see server.ts
    // shouldDropForOwnerReplyGate): @bot wins; else keep only the owner's
    // non-tagging messages. Ownerless threads are passed `ownerId === undefined`
    // by the caller, so every non-bot message except explicit @bot is dropped.
    if (policy?.ownerReplyGate) {
      if (isMentioned(m as Record<string, unknown>, botUserId)) return true
      if (m.user !== ownerId) return false
      if (mentionsOtherUser(m as Record<string, unknown>, botUserId)) return false
      return true
    }
    return true
  })
}
