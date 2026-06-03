// Unified per-channel reply trace — isolated custom feature (outside lib.ts).
// slack-cc is the one always-on choke point every message passes through, so a
// trace line written here is the single complete cross-service record: which
// channel ran which reply service (+ ubi-code profile), and — for the ubi-code
// service — the latency / status / readable Q+A.
//
// Two line shapes, appended to SLACK_TRACE_LOG (default /state/slack-trace.log,
// durable since slack-cc always runs with /state mounted):
//   <ts> | route | ch=.. thr=.. user=.. | service=.. [profile=..] [(dropped)]
//   <ts> | reply | ch=.. thr=.. | service=.. [profile=..] status=.. <ms> | q=".." a=".."
//
// Fire-and-forget: append failures are swallowed so tracing never blocks delivery.
// slack-cc-service outcome (latency / answer) is intentionally NOT captured yet —
// only its `route` line is written. See docs/backlog.md.

import { appendFile } from 'node:fs/promises'

const TRACE_LOG = process.env.SLACK_TRACE_LOG || '/state/slack-trace.log'

const clip = (s: string | undefined, n: number): string =>
  (s ?? '').replace(/\s+/g, ' ').slice(0, n)

/** One line per inbound message, for every reply service (slack-cc / ubi-code / off). */
export function traceRoute(o: {
  channel: string
  thread?: string
  user?: string
  service: string
  profile?: string
}): void {
  const profile = o.profile ? ` profile=${o.profile}` : ''
  const dropped = o.service === 'off' ? ' (dropped)' : ''
  const line = `${new Date().toISOString()} | route | ch=${o.channel} thr=${o.thread ?? '-'} user=${o.user ?? '-'} | service=${o.service}${profile}${dropped}\n`
  appendFile(TRACE_LOG, line).catch(() => {})
}

/** Outcome line for the ubi-code service — latency, status, picked rules, Q+A preview. */
export function traceReply(o: {
  channel: string
  thread?: string
  service: string
  profile?: string
  status: string
  latencyMs: number
  rules?: string[]
  question?: string
  answer?: string
}): void {
  const profile = o.profile ? ` profile=${o.profile}` : ''
  const rules = ` rules: ${o.rules?.length ? o.rules.join(',') : '-'}`
  const qa =
    o.question || o.answer ? ` | q="${clip(o.question, 80)}" a="${clip(o.answer, 100)}"` : ''
  const line = `${new Date().toISOString()} | reply | ch=${o.channel} thr=${o.thread ?? '-'} | service=${o.service}${profile} status=${o.status} ${o.latencyMs}ms${rules}${qa}\n`
  appendFile(TRACE_LOG, line).catch(() => {})
}
