import { describe, expect, test } from 'bun:test'
import { type Access, defaultAccess } from './lib.ts'
import {
  type CustomChannelPolicy,
  customGate,
  decideOwnerReplyGate,
  filterFetchedMessages,
  mentionsOtherUser,
} from './lib.custom.ts'

const BOT = 'UBOT'

function makeGateOpts(access: Access) {
  return {
    access,
    staticMode: true,
    saveAccess: () => {},
    botUserId: BOT,
    selfBotId: 'B_BOT',
    selfAppId: 'A_BOT',
  }
}

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

  test('ownerReplyGate: drops non-owner without bot mention, keeps owner + bot', () => {
    const policy = { ownerReplyGate: true } as CustomChannelPolicy
    const msgs = [
      { user: owner, text: 'q1' },
      { user: other, text: 'i want to ask too' }, // dropped
      { bot_id: 'B1', text: 'bot answer' }, // kept (bot)
      { user: other, text: `hey <@${BOT}> what is X` }, // kept (mentions bot)
    ]
    const kept = filterFetchedMessages(msgs, { botUserId: BOT, ownerId: owner, policy, allowFrom })
    expect(kept.map((m) => m.text)).toEqual(['q1', 'bot answer', `hey <@${BOT}> what is X`])
  })

  test('contextRecovery.includeUsers=owner_and_bot_only overrides', () => {
    const policy = {
      ownerReplyGate: false,
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
    const policy = { ownerReplyGate: true } as CustomChannelPolicy
    const msgs = [
      { user: owner, text: 'usera starts' },
      { user: other, text: 'please ask the bot about RefVar' }, // the offending message
      { bot_id: 'B1', text: 'prior bot reply' },
    ]
    const kept = filterFetchedMessages(msgs, { botUserId: BOT, ownerId: owner, policy, allowFrom })
    expect(kept.some((m) => m.text?.includes('RefVar'))).toBe(false)
  })

  test('ownerReplyGate: owner tagging another user (no @bot) is dropped (rule 5)', () => {
    const policy = { ownerReplyGate: true } as CustomChannelPolicy
    const msgs = [
      { user: owner, text: 'plain owner msg' }, // kept (rule 4)
      { user: owner, text: `cc <@${other}> please look` }, // dropped (rule 5: owner tags other)
      { user: owner, text: `<@${BOT}> and <@${other}> see this` }, // kept (rule 1: @bot wins)
    ]
    const kept = filterFetchedMessages(msgs, { botUserId: BOT, ownerId: owner, policy, allowFrom })
    expect(kept.map((m) => m.text)).toEqual(['plain owner msg', `<@${BOT}> and <@${other}> see this`])
  })

  test('ownerReplyGate ownerless thread (ownerId undefined): keeps only bot + @bot', () => {
    const policy = { ownerReplyGate: true } as CustomChannelPolicy
    const msgs = [
      { user: owner, text: `hey <@${other}> lets chat` }, // dropped (no owner, no @bot)
      { user: other, text: 'plain reply' }, // dropped
      { bot_id: 'B1', text: 'bot answer' }, // kept (bot)
      { user: owner, text: `<@${BOT}> what is X` }, // kept (rule 1)
    ]
    const kept = filterFetchedMessages(msgs, {
      botUserId: BOT,
      ownerId: undefined,
      policy,
      allowFrom,
    })
    expect(kept.map((m) => m.text)).toEqual(['bot answer', `<@${BOT}> what is X`])
  })
})

describe('decideOwnerReplyGate', () => {
  const owner = 'U1'
  const other = 'U2'
  const owned = { ownerId: owner }
  const ownerless = { ownerId: owner, ownerless: true }

  test('rule 1: @bot always delivers, even when it also tags another user', () => {
    expect(decideOwnerReplyGate({ user: other, text: `<@${BOT}> <@${owner}> hi` }, BOT, null)).toBe(
      'deliver',
    )
    expect(
      decideOwnerReplyGate({ user: other, text: `<@${BOT}> ping` }, BOT, ownerless),
    ).toBe('deliver')
  })

  test('rule 2: first message tagging another user, no @bot → open-ownerless', () => {
    expect(
      decideOwnerReplyGate({ user: owner, text: `hey <@${other}> lets discuss` }, BOT, null),
    ).toBe('open-ownerless')
  })

  test('rule 4: plain first message → deliver (owned thread)', () => {
    expect(decideOwnerReplyGate({ user: owner, text: 'just asking' }, BOT, null)).toBe('deliver')
  })

  test('rule 3: ownerless thread, no @bot → drop (even from the opener)', () => {
    expect(decideOwnerReplyGate({ user: owner, text: 'follow up' }, BOT, ownerless)).toBe('drop')
    expect(decideOwnerReplyGate({ user: other, text: 'me too' }, BOT, ownerless)).toBe('drop')
  })

  test('rule 5: owned thread, non-owner without @bot → drop', () => {
    expect(decideOwnerReplyGate({ user: other, text: 'sneak in' }, BOT, owned)).toBe('drop')
  })

  test('rule 5: owned thread, owner tagging another user → drop', () => {
    expect(
      decideOwnerReplyGate({ user: owner, text: `cc <@${other}> heads up` }, BOT, owned),
    ).toBe('drop')
  })

  test('rule 4: owned thread, owner plain message → deliver', () => {
    expect(decideOwnerReplyGate({ user: owner, text: 'another question' }, BOT, owned)).toBe(
      'deliver',
    )
  })
})

describe('customGate', () => {
  const ev = {
    user: 'USENDER',
    channel: 'C1',
    channel_type: 'channel',
    text: `cc <@UOTHER2> please look`,
  }

  test('passes a tag-other message through (ownerReplyGate gating runs later in deliverEvent)', async () => {
    const access = defaultAccess()
    access.channels.C1 = {
      requireMention: false,
      allowFrom: [],
      ownerReplyGate: true,
    } as CustomChannelPolicy
    const result = await customGate(ev, makeGateOpts(access))
    expect(result.action).toBe('deliver')
  })

  test('still drops what upstream libGate drops (no channel policy)', async () => {
    const result = await customGate(ev, makeGateOpts(defaultAccess()))
    expect(result.action).toBe('drop')
  })
})
