import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TCloudClient, TCloudError } from '../src/client'
import type { ChatCompletion } from '../src/types'

const COMPLETION: ChatCompletion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1700000000,
  model: 'anthropic/claude-opus-4-8',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1_000, completion_tokens: 2_000, total_tokens: 3_000 },
}

/** Completion fully funded by a Surplus credit: every metered token debited at the strike. */
const CREDIT_COMPLETION: ChatCompletion = {
  ...COMPLETION,
  surplus: {
    redemptions: [
      { credit_id: 'cr_in', token_kind: 'input', tokens_debited: 1_000, overflow_tokens: 0, strike_micro_per_m: 100_000, payout_micro: 100 },
      { credit_id: 'cr_out', token_kind: 'output', tokens_debited: 2_000, overflow_tokens: 0, strike_micro_per_m: 14_900_000, payout_micro: 29_800 },
    ],
  },
}

function mockFetchJson(body: unknown, headers?: Record<string, string>, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response)
}

describe('pricing wire format', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('serializes a limit order with credit spending to snake_case', async () => {
    const fn = mockFetchJson(COMPLETION)
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.chat({
      model: 'anthropic/claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }],
      pricing: {
        mode: 'limit',
        maxInputMicroPerM: 1_200_000,
        maxOutputMicroPerM: 15_000_000,
        credits: true,
      },
    })
    const body = JSON.parse(fn.mock.calls[0][1].body)
    expect(body.pricing).toEqual({
      mode: 'limit',
      max_input_micro_per_m: 1_200_000,
      max_output_micro_per_m: 15_000_000,
      credits: true,
    })
  })

  it('serializes a pinned credit and market mode', async () => {
    const fn = mockFetchJson(COMPLETION)
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      pricing: { mode: 'market', credits: { creditId: 'cr_42' } },
    })
    const body = JSON.parse(fn.mock.calls[0][1].body)
    expect(body.pricing).toEqual({ mode: 'market', credits: { credit_id: 'cr_42' } })
  })

  it('omits pricing from the body when not set', async () => {
    const fn = mockFetchJson(COMPLETION)
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] })
    const body = JSON.parse(fn.mock.calls[0][1].body)
    expect('pricing' in body).toBe(false)
  })

  it('rejects limit mode without a cap before any request is sent', async () => {
    const fn = mockFetchJson(COMPLETION)
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hi' }], pricing: { mode: 'limit' } }),
    ).rejects.toThrow(/limit.*requires/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects non-integer and non-positive caps', async () => {
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        pricing: { mode: 'limit', maxOutputMicroPerM: 14.9 },
      }),
    ).rejects.toThrow(TCloudError)
    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        pricing: { mode: 'limit', maxOutputMicroPerM: 0 },
      }),
    ).rejects.toThrow(/positive integer/)
  })

  it('blocks pricing smuggled through providerOptions', async () => {
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        providerOptions: { pricing: { mode: 'limit' } },
      }),
    ).rejects.toThrow(/protected chat field "pricing"/)
  })
})

describe('credit-funded cost tracking', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('does not bill credit-debited tokens against the USD spend meter', async () => {
    globalThis.fetch = mockFetchJson(CREDIT_COMPLETION, {
      'x-tangle-price-input': '0.000001',
      'x-tangle-price-output': '0.000015',
    })
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    const result = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      pricing: { credits: true },
    })
    expect(result.surplus?.redemptions).toHaveLength(2)
    expect(client.usage.totalSpent).toBe(0)
  })

  it('bills only the overflow tokens a credit could not cover', async () => {
    const partial: ChatCompletion = {
      ...COMPLETION,
      surplus: {
        redemptions: [
          { credit_id: 'cr_out', token_kind: 'output', tokens_debited: 1_500, overflow_tokens: 500, strike_micro_per_m: 14_900_000, payout_micro: 22_350 },
        ],
      },
    }
    globalThis.fetch = mockFetchJson(partial, {
      'x-tangle-price-input': '0.000001',
      'x-tangle-price-output': '0.000015',
    })
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.chat({ messages: [{ role: 'user', content: 'hi' }], pricing: { credits: true } })
    // 1_000 input tokens at $1/M + 500 uncovered output tokens at $15/M
    expect(client.usage.totalSpent).toBeCloseTo(1_000 * 0.000001 + 500 * 0.000015)
  })

  it('keeps full billing when no credit applied', async () => {
    globalThis.fetch = mockFetchJson(COMPLETION, {
      'x-tangle-price-input': '0.000001',
      'x-tangle-price-output': '0.000015',
    })
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(client.usage.totalSpent).toBeCloseTo(1_000 * 0.000001 + 2_000 * 0.000015)
  })
})
