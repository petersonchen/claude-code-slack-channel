// FIFO thinking-placeholder store — isolated custom fix (outside upstream code).
//
// Bug it fixes: the thinking-indicator placeholder was kept in a
// Map<channel:thread, ts> with a SINGLE ts per key. When two messages in the
// same thread were in flight at once, the second message's placeholder
// overwrote the first's — so the first answer updated the WRONG bubble and the
// first placeholder was orphaned as a permanent "_Thinking..._".
//
// The reply side only knows (channel, thread_ts) — never which specific
// message it is answering — so we cannot key by message ts. Instead we keep a
// FIFO queue per (channel:thread) key: questions in a thread are answered in
// arrival order, so the oldest pending placeholder is the right one to consume.
//
// Bounded per key so a question that never produces a reply (rare — the bot is
// instructed to always reply) cannot grow the queue without limit.

/** Cap on pending placeholders per key. Dropping the oldest on overflow keeps
 *  memory bounded; a thread with this many unanswered placeholders is already
 *  pathological. */
const MAX_PER_KEY = 16

const store = new Map<string, string[]>()

/** Record a freshly-posted placeholder ts for a (channel:thread) key. */
export function pushPlaceholder(key: string, ts: string): void {
  const q = store.get(key)
  if (q === undefined) {
    store.set(key, [ts])
    return
  }
  q.push(ts)
  if (q.length > MAX_PER_KEY) q.shift()
}

/** Consume (remove + return) the OLDEST pending placeholder for a key.
 *  Returns undefined when none is pending — caller then posts a fresh message,
 *  exactly as before. */
export function consumePlaceholder(key: string): string | undefined {
  const q = store.get(key)
  if (q === undefined || q.length === 0) return undefined
  const ts = q.shift()
  if (q.length === 0) store.delete(key)
  return ts
}
