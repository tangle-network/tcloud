import { describe, it, expect, vi } from 'vitest'
import type { AgentProfile } from '@tangle-network/sandbox'
import type { ChatCompletion } from '@tangle-network/tcloud'
import { Agent, agent, type AgentRunCriterion } from '../src/agent-runner'

// ---- Fake client ------------------------------------------------------------
//
// Minimal shape matching what Agent.runUntil() calls on TCloudClient: just
// `.bridge(cfg)` returning a session with `.chat(opts)`. Keeps tests offline.

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

function makeFakeClient(responses: Array<ChatCompletion | (() => ChatCompletion) | Error>) {
  const calls: BridgeCall[] = []
  let idx = 0
  const client = {
    bridge(cfg: Record<string, unknown>) {
      const call: BridgeCall = { cfg, chats: [] }
      calls.push(call)
      return {
        async chat(opts: Record<string, unknown>) {
          call.chats.push(opts)
          const r = responses[Math.min(idx, responses.length - 1)]
          idx++
          if (r instanceof Error) throw r
          return typeof r === 'function' ? r() : r
        },
      }
    },
  }
  return { client, calls }
}

// ---- Tests ------------------------------------------------------------------

describe('Agent.runUntil', () => {
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
    }).runUntil()

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
    }).runUntil()

    expect(result.verdict).toBe('verified')
    expect(result.iterations).toBe(2)

    // First user turn = brief; second user turn feeds the failure reason.
    const userTurns = result.transcript.filter((m) => m.role === 'user')
    expect(userTurns[0].content).toBe('finish')
    expect(userTurns[1].content).toContain("criterion 'says-done' failed")
    expect(userTurns[1].content).toContain('not finished yet')

    // Only one bridge session is opened; .chat() is called per turn.
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
    }).runUntil()

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
    }).runUntil()

    expect(result.verdict).toBe('budget-exhausted')
    // Either 0 (pre-call gate fired before the first chat finished) or 1
    // (post-call gate). Both are correct "wallSec exhausted after 1 turn at
    // most" behavior; assert the upper bound.
    expect(result.iterations).toBeLessThanOrEqual(1)
    now.mockRestore()
  })

  it('routes cataloged profile id to model: "<id>"', async () => {
    const { client, calls } = makeFakeClient([makeCompletion('ok')])
    await new Agent(client as any, { profile: 'sf-proposer', brief: 'hi' }).runUntil()
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
    await new Agent(client as any, { profile: inline, brief: 'topic: ocean' }).runUntil()

    expect(calls[0].cfg.model).toBe('sandbox')
    const provider = calls[0].chats[0].providerOptions as { agent_profile: AgentProfile }
    expect(provider.agent_profile).toStrictEqual(inline)
  })

  it('captures error verdict when the bridge throws', async () => {
    const { client } = makeFakeClient([new Error('bridge unreachable: ECONNREFUSED')])
    const result = await new Agent(client as any, {
      profile: 'sf-proposer',
      brief: 'whatever',
    }).runUntil()

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
    }).runUntil()

    expect(result.verdict).toBe('verified')
    expect(seenDir).toBe('/tmp/my-ws')
    expect(result.transcript[0].content).toContain('[workspace: /tmp/my-ws]')
  })
})
