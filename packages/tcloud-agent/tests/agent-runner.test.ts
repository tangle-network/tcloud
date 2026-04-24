import { describe, it, expect, vi } from 'vitest'
import type { AgentProfile } from '@tangle-network/sandbox'
import type { ChatCompletion, ChatCompletionChunk } from '@tangle-network/tcloud'
import {
  Agent,
  agent,
  type AgentEvent,
  type AgentRunCriterion,
  type AgentRunOptions,
  type AgentRunResult,
} from '../src/agent-runner'

// ---- Fake client ------------------------------------------------------------
//
// Minimal shape matching what Agent.stream() calls on TCloudClient: just
// `.bridge(cfg)` returning a session with `.chatStream(opts)` +
// `.chat(opts)`. Keeps tests offline.

interface BridgeCall {
  cfg: Record<string, unknown>
  chats: Array<Record<string, unknown>>
}

function makeCompletion(content: string, extra: Partial<ChatCompletion> = {}): ChatCompletion {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'sandbox',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    ...extra,
  }
}

/** Build a chunked stream from a completion's message content (1-3 chunks). */
function chunksFor(completion: ChatCompletion): ChatCompletionChunk[] {
  const text = completion.choices[0]?.message?.content ?? ''
  // Split into a couple of deltas so tests can assert on streaming behaviour.
  const mid = Math.max(1, Math.floor(text.length / 2))
  const head = text.slice(0, mid)
  const tail = text.slice(mid)
  const base = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model }
  const out: ChatCompletionChunk[] = []
  if (head) out.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: head }, finish_reason: null }] })
  if (tail) out.push({ ...base, choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] })
  out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  return out
}

type ResponseSpec = ChatCompletion | (() => ChatCompletion) | Error

function makeFakeClient(responses: ResponseSpec[]) {
  const calls: BridgeCall[] = []
  let idx = 0
  function next(): ResponseSpec {
    const r = responses[Math.min(idx, responses.length - 1)]
    idx++
    return r
  }
  const client = {
    bridge(cfg: Record<string, unknown>) {
      const call: BridgeCall = { cfg, chats: [] }
      calls.push(call)
      return {
        async chat(opts: Record<string, unknown>) {
          call.chats.push({ ...opts, __mode: 'chat' })
          const r = next()
          if (r instanceof Error) throw r
          return typeof r === 'function' ? r() : r
        },
        async *chatStream(opts: Record<string, unknown>) {
          call.chats.push({ ...opts, __mode: 'chatStream' })
          const r = next()
          if (r instanceof Error) throw r
          const completion = typeof r === 'function' ? r() : r
          for (const chunk of chunksFor(completion)) {
            yield chunk
          }
        },
      }
    },
  }
  return { client, calls }
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

// ---- run() tests (renamed from runUntil) -----------------------------------

describe('Agent.run', () => {
  it('returns verified on iteration 1 when all criteria pass', async () => {
    const { client, calls } = makeFakeClient([makeCompletion('build passed, tsc ok')])
    const criterion: AgentRunCriterion = {
      name: 'mentions-passed',
      check: async (ctx) =>
        ctx.lastMessage.includes('passed') ? { ok: true } : { ok: false, reason: 'no pass claim' },
    }
    const result = await new Agent(client as any, {
      profile: 'sf-proposer',
      brief: 'do the thing',
      criteria: [criterion],
    }).run()

    expect(result.verdict).toBe('verified')
    expect(result.iterations).toBe(1)
    expect(result.transcript).toHaveLength(2)
    expect(result.transcript[0]).toEqual({ role: 'user', content: 'do the thing' })
    expect(result.transcript[1]).toEqual({ role: 'assistant', content: 'build passed, tsc ok' })
    expect(calls).toHaveLength(1)
  })

  it('iterates when a criterion fails and feeds the reason to the next turn', async () => {
    const { client, calls } = makeFakeClient([
      makeCompletion('still working on it'),
      makeCompletion('OK DONE'),
    ])
    const criterion: AgentRunCriterion = {
      name: 'says-done',
      check: async (ctx) => (ctx.lastMessage.includes('DONE') ? { ok: true } : { ok: false, reason: 'not finished yet' }),
    }
    const result = await agent(client as any, {
      profile: 'sf-proposer',
      brief: 'finish',
      criteria: [criterion],
    }).run()

    expect(result.verdict).toBe('verified')
    expect(result.iterations).toBe(2)

    // First user turn = brief; second user turn feeds the failure reason.
    const userTurns = result.transcript.filter((m) => m.role === 'user')
    expect(userTurns[0].content).toBe('finish')
    expect(userTurns[1].content).toContain("criterion 'says-done' failed")
    expect(userTurns[1].content).toContain('not finished yet')

    // Only one bridge session is opened; .chatStream() is called per turn.
    expect(calls).toHaveLength(1)
    expect(calls[0].chats).toHaveLength(2)
  })

  it('exits budget-exhausted after the iteration cap', async () => {
    const { client } = makeFakeClient([makeCompletion('nope'), makeCompletion('nope again')])
    const result = await new Agent(client as any, {
      profile: 'sf-proposer',
      brief: 'please say done',
      criteria: [{ name: 'never-passes', check: async () => ({ ok: false, reason: 'nope' }) }],
      budget: { iterations: 2 },
    }).run()

    expect(result.verdict).toBe('budget-exhausted')
    expect(result.iterations).toBe(2)
    expect(result.blockedBy).toBe('never-passes')
  })

  it('exits budget-exhausted when wallSec is breached', async () => {
    // Build the completion BEFORE spying on Date.now — `makeCompletion` reads
    // Date.now internally and would otherwise consume from the mock queue.
    const completion = makeCompletion('still thinking')
    const now = vi.spyOn(Date, 'now')
    // Each iteration consumes roughly: start-or-pre-call, post-call wallSec
    // check, wallMs-on-return. Returning a flat `60_000` (=60s) means the
    // very first post-call wallSec check (10s budget) triggers exit on iter 1.
    now.mockReturnValueOnce(0) // start
    now.mockReturnValue(60_000)

    const { client } = makeFakeClient([completion])
    const result = await new Agent(client as any, {
      profile: 'sf-proposer',
      brief: 'do it',
      criteria: [{ name: 'x', check: async () => ({ ok: false, reason: 'no' }) }],
      budget: { wallSec: 10 },
    }).run()

    expect(result.verdict).toBe('budget-exhausted')
    // Either 0 (pre-call gate fired before the first chat finished) or 1
    // (post-call gate). Both are correct "wallSec exhausted after 1 turn at
    // most" behavior; assert the upper bound.
    expect(result.iterations).toBeLessThanOrEqual(1)
    now.mockRestore()
  })

  it('routes cataloged profile id to model: "<id>"', async () => {
    const { client, calls } = makeFakeClient([makeCompletion('ok')])
    await new Agent(client as any, { profile: 'sf-proposer', brief: 'hi' }).run()
    expect(calls[0].cfg.harness).toBe('sandbox')
    expect(calls[0].cfg.model).toBe('sf-proposer')
    // No inline profile body.
    expect(calls[0].chats[0].providerOptions).toBeUndefined()
  })

  it('routes inline AgentProfile to model "sandbox" + providerOptions.agent_profile', async () => {
    const inline: AgentProfile = {
      name: 'haiku-bot',
      prompt: { systemPrompt: 'You write haiku.' },
      model: { provider: 'anthropic', default: 'claude-sonnet-4-5' },
      permissions: { Bash: 'deny' },
      tools: { Bash: false },
    }
    const { client, calls } = makeFakeClient([makeCompletion('cherry blossom done')])
    await new Agent(client as any, { profile: inline, brief: 'topic: ocean' }).run()

    expect(calls[0].cfg.model).toBe('sandbox')
    const provider = calls[0].chats[0].providerOptions as { agent_profile: AgentProfile }
    expect(provider.agent_profile).toStrictEqual(inline)
  })

  it('captures error verdict when the bridge throws', async () => {
    const { client } = makeFakeClient([new Error('bridge unreachable: ECONNREFUSED')])
    const result = await new Agent(client as any, {
      profile: 'sf-proposer',
      brief: 'whatever',
    }).run()

    expect(result.verdict).toBe('error')
    expect(result.error).toContain('ECONNREFUSED')
    expect(result.iterations).toBe(1)
  })

  it('appends workspace dir to the first user turn and surfaces it on context', async () => {
    const { client } = makeFakeClient([makeCompletion('ok')])
    let seenDir: string | undefined
    const result = await new Agent(client as any, {
      profile: 'sf-proposer',
      brief: 'review the repo',
      workspace: { dir: '/tmp/my-ws' },
      criteria: [
        {
          name: 'saw-ws',
          check: async (ctx) => {
            seenDir = ctx.workspaceDir
            return { ok: true }
          },
        },
      ],
    }).run()

    expect(result.verdict).toBe('verified')
    expect(seenDir).toBe('/tmp/my-ws')
    expect(result.transcript[0].content).toContain('[workspace: /tmp/my-ws]')
  })
})

// ---- stream() tests --------------------------------------------------------

describe('Agent.stream', () => {
  it('emits iteration.start → message.delta* → iteration.complete → criterion.check* → verdict', async () => {
    const { client } = makeFakeClient([makeCompletion('build passed, tsc ok')])
    const events = await collect(
      new Agent(client as any, {
        profile: 'sf-proposer',
        brief: 'do the thing',
        criteria: [
          { name: 'mentions-passed', check: async (ctx) => ({ ok: ctx.lastMessage.includes('passed') }) },
        ],
      }).stream(),
    )

    const types = events.map((e) => e.type)
    // Ordering: start → (delta)+ → complete → check → verdict
    expect(types[0]).toBe('iteration.start')
    expect(types[types.length - 1]).toBe('verdict')

    const deltaCount = events.filter((e) => e.type === 'message.delta').length
    expect(deltaCount).toBeGreaterThanOrEqual(1)

    const completeIdx = types.indexOf('iteration.complete')
    const checkIdx = types.indexOf('criterion.check')
    const verdictIdx = types.indexOf('verdict')

    expect(completeIdx).toBeGreaterThan(0)
    expect(checkIdx).toBeGreaterThan(completeIdx)
    expect(verdictIdx).toBeGreaterThan(checkIdx)
    // All deltas land before the iteration.complete event.
    for (let i = 0; i < completeIdx; i++) {
      expect(['iteration.start', 'message.delta']).toContain(types[i])
    }
  })

  it('final event is always verdict, carrying the same payload run() returns', async () => {
    const opts: AgentRunOptions = {
      profile: 'sf-proposer',
      brief: 'finish',
      criteria: [{ name: 'mentions-passed', check: async (ctx) => ({ ok: ctx.lastMessage.includes('passed') }) }],
    }
    const client1 = makeFakeClient([makeCompletion('build passed')]).client
    const events = await collect(new Agent(client1 as any, opts).stream())
    const last = events[events.length - 1]
    expect(last.type).toBe('verdict')
    if (last.type !== 'verdict') throw new Error('unreachable')

    const client2 = makeFakeClient([makeCompletion('build passed')]).client
    const result = await new Agent(client2 as any, opts).run()

    // Same payload (sans the `type` discriminator).
    const { type: _t, ...verdictPayload } = last
    expect(verdictPayload.verdict).toBe(result.verdict)
    expect(verdictPayload.iterations).toBe(result.iterations)
    expect(verdictPayload.transcript).toEqual(result.transcript)
  })

  it('run() and stream() produce identical verdicts across iterations + failures', async () => {
    const opts: AgentRunOptions = {
      profile: 'sf-proposer',
      brief: 'finish',
      criteria: [{ name: 'says-done', check: async (ctx) => ctx.lastMessage.includes('DONE') ? { ok: true } : { ok: false, reason: 'keep going' } }],
    }
    // Deterministic multi-iteration trajectory.
    const responses = [makeCompletion('not yet'), makeCompletion('DONE')]
    const streamEvents = await collect(
      new Agent(makeFakeClient(responses).client as any, opts).stream(),
    )
    const runResult = await new Agent(makeFakeClient(responses).client as any, opts).run()

    const lastVerdict = streamEvents[streamEvents.length - 1]
    if (lastVerdict.type !== 'verdict') throw new Error('expected verdict')

    expect(lastVerdict.verdict).toBe(runResult.verdict)
    expect(lastVerdict.iterations).toBe(runResult.iterations)
    expect(lastVerdict.transcript).toEqual(runResult.transcript)
    expect(lastVerdict.blockedBy).toBe(runResult.blockedBy)
    expect(lastVerdict.verdict).toBe('verified')
    expect(lastVerdict.iterations).toBe(2)

    // criterion.check events mirror the progression (first fails, second passes).
    const checks = streamEvents.filter((e): e is Extract<AgentEvent, { type: 'criterion.check' }> => e.type === 'criterion.check')
    expect(checks).toHaveLength(2)
    expect(checks[0].ok).toBe(false)
    expect(checks[0].reason).toBe('keep going')
    expect(checks[1].ok).toBe(true)
  })

  it('surfaces mid-iteration errors as a verdict: "error" event, never throws', async () => {
    const { client } = makeFakeClient([new Error('bridge unreachable: EHOSTDOWN')])
    let threw: unknown = null
    let events: AgentEvent[] = []
    try {
      events = await collect(
        new Agent(client as any, { profile: 'sf-proposer', brief: 'hi' }).stream(),
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    const last = events[events.length - 1]
    expect(last.type).toBe('verdict')
    if (last.type !== 'verdict') throw new Error('unreachable')
    expect(last.verdict).toBe('error')
    expect(last.error).toContain('EHOSTDOWN')
    expect(last.iterations).toBe(1)
  })

  it('emits verdict: "budget-exhausted" after the iteration cap', async () => {
    const { client } = makeFakeClient([makeCompletion('nope'), makeCompletion('nope again')])
    const events = await collect(
      new Agent(client as any, {
        profile: 'sf-proposer',
        brief: 'please say done',
        criteria: [{ name: 'never-passes', check: async () => ({ ok: false, reason: 'nope' }) }],
        budget: { iterations: 2 },
      }).stream(),
    )

    const last = events[events.length - 1]
    expect(last.type).toBe('verdict')
    if (last.type !== 'verdict') throw new Error('unreachable')
    expect(last.verdict).toBe('budget-exhausted')
    expect(last.iterations).toBe(2)
    expect(last.blockedBy).toBe('never-passes')

    // Two full iteration blocks streamed.
    const starts = events.filter((e) => e.type === 'iteration.start')
    expect(starts).toHaveLength(2)
  })

  it('accumulates streamed deltas into the transcript assistant message', async () => {
    // `chunksFor` splits the content into two halves.
    const { client } = makeFakeClient([makeCompletion('hello there friend')])
    const events = await collect(
      new Agent(client as any, { profile: 'sf-proposer', brief: 'greet' }).stream(),
    )
    const deltaText = events
      .filter((e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta')
      .map((e) => e.text)
      .join('')
    expect(deltaText).toBe('hello there friend')

    const last = events[events.length - 1]
    if (last.type !== 'verdict') throw new Error('unreachable')
    expect(last.transcript.at(-1)?.content).toBe('hello there friend')
  })

  it('honors stream: false by falling back to the non-streaming chat() path', async () => {
    const { client, calls } = makeFakeClient([makeCompletion('ok')])
    const events = await collect(
      new Agent(client as any, {
        profile: 'sf-proposer',
        brief: 'hi',
        stream: false,
      }).stream(),
    )

    // Non-streaming path: exactly one message.delta carrying the full message.
    const deltas = events.filter((e): e is Extract<AgentEvent, { type: 'message.delta' }> => e.type === 'message.delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0].text).toBe('ok')
    expect(calls[0].chats[0].__mode).toBe('chat')
  })
})

// ---- run()/stream() parity type-level sanity -------------------------------

describe('Agent.run is a thin consumer of stream()', () => {
  it('returns a well-shaped AgentRunResult', async () => {
    const { client } = makeFakeClient([makeCompletion('done')])
    const r: AgentRunResult = await new Agent(client as any, {
      profile: 'sf-proposer',
      brief: 'go',
    }).run()
    expect(typeof r.verdict).toBe('string')
    expect(typeof r.iterations).toBe('number')
    expect(typeof r.wallMs).toBe('number')
    expect(Array.isArray(r.transcript)).toBe(true)
  })
})
