import { describe, expect, test } from 'bun:test'
import {
  type CustomChannelPolicy,
  filterFetchedMessages,
  mentionsOtherUser,
} from './lib.custom.ts'

const BOT = 'UBOT'

describe('mentionsOtherUser', () => {
  test('bare user mention of another user', () => {
    expect(mentionsOtherUser({ text: 'hey <@U123> look' }, BOT)).toBe(true)
  })

  test('mention of only the bot is not "other"', () => {
    expect(mentionsOtherUser({ text: `hi <@${BOT}> please` }, BOT)).toBe(false)
  })

  test('piped display form is detected', () => {
    expect(mentionsOtherUser({ text: 'ping <@U123|alice> thanks' }, BOT)).toBe(true)
  })

  test('broadcast @here / @channel / @everyone are "other"', () => {
    expect(mentionsOtherUser({ text: '<!here> ping' }, BOT)).toBe(true)
    expect(mentionsOtherUser({ text: '<!channel>' }, BOT)).toBe(true)
    expect(mentionsOtherUser({ text: '<!everyone>' }, BOT)).toBe(true)
  })

  test('user-group (subteam) mention is "other"', () => {
    expect(mentionsOtherUser({ text: '<!subteam^S012|@devs> heads up' }, BOT)).toBe(true)
  })

  test('date format <!date^...> is NOT a mention', () => {
    expect(mentionsOtherUser({ text: 'due <!date^1700000000^{date}|fallback>' }, BOT)).toBe(false)
  })

  test('plain text without mentions', () => {
    expect(mentionsOtherUser({ text: 'just a normal message' }, BOT)).toBe(false)
  })
})

describe('filterFetchedMessages', () => {
  const owner = 'UOWNER'
  const other = 'UOTHER'
  const allowFrom = [owner, other]

  test('threadOwnerOnly: drops non-owner without bot mention, keeps owner + bot', () => {
    const policy = { threadOwnerOnly: true } as CustomChannelPolicy
    const msgs = [
      { user: owner, text: 'q1' },
      { user: other, text: 'i want to ask too' }, // dropped
      { bot_id: 'B1', text: 'bot answer' }, // kept (bot)
      { user: other, text: `hey <@${BOT}> what is X` }, // kept (mentions bot)
    ]
    const kept = filterFetchedMessages(msgs, { botUserId: BOT, ownerId: owner, policy, allowFrom })
    expect(kept.map((m) => m.text)).toEqual(['q1', 'bot answer', `hey <@${BOT}> what is X`])
  })

  test('dropIfMentionsOther: drops messages mentioning another user', () => {
    const policy = { dropIfMentionsOther: true } as CustomChannelPolicy
    const msgs = [
      { user: owner, text: 'normal' },
      { user: owner, text: `cc <@${other}> please look` }, // dropped (mentions other)
    ]
    const kept = filterFetchedMessages(msgs, { botUserId: BOT, ownerId: owner, policy, allowFrom })
    expect(kept.map((m) => m.text)).toEqual(['normal'])
  })

  test('contextRecovery.includeUsers=owner_and_bot_only overrides', () => {
    const policy = {
      threadOwnerOnly: false,
      contextRecovery: { includeUsers: 'owner_and_bot_only' },
    } as CustomChannelPolicy
    const msgs = [
      { user: owner, text: 'q' },
      { user: other, text: 'noise' }, // dropped
      { bot_id: 'B1', text: 'a' }, // kept (bot)
    ]
    const kept = filterFetchedMessages(msgs, { botUserId: BOT, ownerId: owner, policy, allowFrom })
    expect(kept.map((m) => m.text)).toEqual(['q', 'a'])
  })

  test('no policy flags: passes everything through (unchanged behavior)', () => {
    const msgs = [
      { user: owner, text: 'a' },
      { user: other, text: 'b' },
    ]
    const kept = filterFetchedMessages(msgs, {
      botUserId: BOT,
      ownerId: owner,
      policy: undefined,
      allowFrom,
    })
    expect(kept.length).toBe(2)
  })

  test('THE BUG FIX: a gate-dropped non-owner question is NOT re-ingested via fetch', () => {
    const policy = { threadOwnerOnly: true, dropIfMentionsOther: true } as CustomChannelPolicy
    const msgs = [
      { user: owner, text: 'usera starts' },
      { user: other, text: 'please ask the bot about RefVar' }, // the offending message
      { bot_id: 'B1', text: 'prior bot reply' },
    ]
    const kept = filterFetchedMessages(msgs, { botUserId: BOT, ownerId: owner, policy, allowFrom })
    expect(kept.some((m) => m.text?.includes('RefVar'))).toBe(false)
  })
})
