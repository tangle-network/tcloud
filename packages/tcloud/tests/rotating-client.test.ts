/**
 * Tests for `TCloudClient.rotating()` — the static factory that replaced the
 * ex-`PrivateAgent` / ex-`PrivateRouter` client surface in @tangle-network/tcloud-agent.
 *
 * Covers:
 *   - rotation strategy dispatches a different operator per call
 *   - getRotationStats() tracks callsByOperator + currentOperator
 *   - the sandbox-harness guard throws exactly the documented message
 *   - non-sandbox harnesses (claude-code, codex) are unaffected
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TCloudClient } from '../src/client'
import { TCloud } from '../src/index'
import type { OperatorInfo } from '../src/private-router'

function fakeOperators(n: number, model = 'gpt-4o-mini'): OperatorInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    slug: `op-${i}`,
    endpointUrl: `https://op-${i}.example.invalid`,
    region: `r-${i % 3}`,
    reputationScore: 90,
    avgLatencyMs: 50 + i,
    models: [model],
  }))
}

describe('TCloudClient.rotating() — construction', () => {
  it('returns a TCloudClient instance', () => {
    const c = TCloudClient.rotating({ routing: { pool: fakeOperators(3) } })
    expect(c).toBeInstanceOf(TCloudClient)
  })

  it('also exposed as TCloud.rotating()', () => {
    const c = TCloud.rotating({ routing: { pool: fakeOperators(3) } })
    expect(c).toBeInstanceOf(TCloudClient)
  })

  it('attaches a non-enumerable __tcloudRotating marker', () => {
    const c = TCloudClient.rotating({ routing: { pool: fakeOperators(3) } })
    const desc = Object.getOwnPropertyDescriptor(c, '__tcloudRotating')
    expect(desc).toBeDefined()
    expect(desc!.value).toBe(true)
    expect(desc!.enumerable).toBe(false)
    // Standard enumeration must not surface the marker.
    expect(Object.keys(c)).not.toContain('__tcloudRotating')
  })

  it('defaults to min-exposure strategy', () => {
    const c = TCloudClient.rotating({ routing: { pool: fakeOperators(3) } })
    expect(c.privateRouter).toBeDefined()
    expect(c.privateRouter!.getStats().strategy).toBe('min-exposure')
  })

  it('accepts round-robin and random strategies', () => {
    const rr = TCloudClient.rotating({ routing: { strategy: 'round-robin', pool: fakeOperators(3) } })
    const rnd = TCloudClient.rotating({ routing: { strategy: 'random', pool: fakeOperators(3) } })
    expect(rr.privateRouter!.getStats().strategy).toBe('round-robin')
    expect(rnd.privateRouter!.getStats().strategy).toBe('random')
  })

  it('a non-rotating client has no marker', () => {
    const c = new TCloudClient({})
    expect((c as unknown as Record<string, unknown>).__tcloudRotating).toBeUndefined()
  })
})

describe('TCloudClient.rotating() — routing + stats', () => {
  it('round-robin cycles operators across chat calls', async () => {
    const pool = fakeOperators(3)
    const c = TCloudClient.rotating({
      apiKey: 'sk-test',
      routing: { strategy: 'round-robin', pool },
    })

    // Stub fetch so chat() doesn't hit the network but still exercises the
    // _prepareChatRequest path that picks an operator and stamps
    // X-Tangle-Operator on the outbound request.
    const observedOperators: string[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url: any, init?: any) => {
        const hdrs = init?.headers as Record<string, string>
        observedOperators.push(hdrs['X-Tangle-Operator'])
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'c',
              object: 'chat.completion',
              created: 0,
              model: 'gpt-4o-mini',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      },
    )

    try {
      for (let i = 0; i < 6; i++) {
        await c.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
      }
    } finally {
      fetchMock.mockRestore()
    }

    expect(observedOperators).toEqual(['op-0', 'op-1', 'op-2', 'op-0', 'op-1', 'op-2'])
  })

  it('getRotationStats() returns callsByOperator + currentOperator', () => {
    const pool = fakeOperators(3)
    const c = TCloudClient.rotating({ routing: { strategy: 'round-robin', pool } })

    // Drive the router directly — the selection side-effects are what
    // getRotationStats reads from.
    c.privateRouter!.selectOperator('gpt-4o-mini')
    c.privateRouter!.selectOperator('gpt-4o-mini')
    c.privateRouter!.selectOperator('gpt-4o-mini')

    const stats = c.getRotationStats()
    expect(stats.callsByOperator).toEqual({ 'op-0': 1, 'op-1': 1, 'op-2': 1 })
    expect(stats.currentOperator).toBe('op-2')
  })

  it('getRotationStats() on a non-rotating client returns empty', () => {
    const c = new TCloudClient({})
    expect(c.getRotationStats()).toEqual({ callsByOperator: {}, currentOperator: null })
  })

  it('honors a pre-seeded pool without fetching /api/operators', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch should not be called when pool is pre-seeded')
    })
    try {
      const pool = fakeOperators(2)
      const c = TCloudClient.rotating({ routing: { strategy: 'round-robin', pool } })
      // Selecting directly exercises the router without triggering the cache
      // refresh — but the cache should also be seeded so subsequent chat
      // flows don't need the network.
      const sel = c.privateRouter!.selectOperator('gpt-4o-mini')
      expect(sel).not.toBeNull()
      expect(sel!.slug).toBe('op-0')
    } finally {
      fetchMock.mockRestore()
    }
  })
})

describe('TCloudClient.rotating() — sandbox harness guard', () => {
  const SANDBOX_MESSAGE =
    'TCloudClient.rotating() cannot dispatch sandbox-harness sessions.\n' +
    'Sandbox sessions bind to a single operator; rotation is meaningful only for\n' +
    'stateless calls. Use TCloudClient.shielded() + AgentProfile.confidential.tee\n' +
    'for privacy-preserving sandbox execution instead.'

  it('throws the exact documented message when harness is sandbox', () => {
    const c = TCloudClient.rotating({ routing: { pool: fakeOperators(3) } })
    expect(() => c.bridge({ harness: 'sandbox', unlock: 'u' })).toThrow(SANDBOX_MESSAGE)
  })

  it('allows claude-code harness on a rotating client', () => {
    const c = TCloudClient.rotating({ routing: { pool: fakeOperators(3) } })
    expect(() => c.bridge({ harness: 'claude-code', unlock: 'u' })).not.toThrow()
  })

  it('allows codex, opencode, kimi-code, openai harnesses on a rotating client', () => {
    const c = TCloudClient.rotating({ routing: { pool: fakeOperators(3) } })
    for (const harness of ['codex', 'opencode', 'kimi-code', 'openai'] as const) {
      expect(() => c.bridge({ harness, unlock: 'u' })).not.toThrow()
    }
  })

  it('does NOT block sandbox on a non-rotating client', () => {
    const c = new TCloudClient({})
    expect(() => c.bridge({ harness: 'sandbox', unlock: 'u' })).not.toThrow()
  })
})
