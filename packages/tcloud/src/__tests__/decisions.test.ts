import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TCloudClient } from '../client'
import {
  MIN_CHILD_KEY_BUDGET_USD,
  ParentBudgetExhaustedError,
  deriveChildBudgetUsd,
  formatModelNotAllowedRefusal,
  parseModelNotAllowed,
  resolveModelWithinAllowList,
} from '../decisions'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeClient() {
  return new TCloudClient({ baseURL: 'http://router.test/v1', apiKey: 'sk-tan-test', model: 'default-model' })
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return { ok: true, status: 200, headers: new Headers(headers), json: () => Promise.resolve(body) }
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('client.decisions.create — the native OpenAI wire', () => {
  const specExample = {
    model: 'gpt-6-luna',
    input: 'The package arrived with a broken screen.',
    questions: [{ type: 'predicate' as const, name: 'damaged', instructions: 'Does the customer report a damaged item?' }],
  }

  it('sends the OpenAI field names verbatim (snake_case, model first-class)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      model: 'gpt-6-luna',
      answers: [{ type: 'predicate', name: 'damaged', probability: 0.95 }],
      usage: { input_tokens: 42, output_tokens: 0, total_tokens: 42 },
    }, {
      'X-Generation-Id': 'gen-1',
      'X-Tangle-Served-Model': 'gpt-6-luna',
      'X-Tangle-Cost-USD': '0.00000504',
      'X-Tangle-Provider-Cost-USD': '0.0000042',
      'X-Tangle-Max-Cost-USD': '0.0262144',
    }))
    const client = makeClient()
    const { decision, receipts } = await client.decisions.create({
      ...specExample,
      safetyIdentifier: 'caller-user',
      promptCacheKey: 'caller-key',
    })
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://router.test/v1/decisions')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      model: 'gpt-6-luna',
      input: specExample.input,
      questions: specExample.questions,
      safety_identifier: 'caller-user',
      prompt_cache_key: 'caller-key',
    })
    expect(decision.answers[0]).toEqual({ type: 'predicate', name: 'damaged', probability: 0.95 })
    expect(receipts).toEqual({
      generationId: 'gen-1', servedModel: 'gpt-6-luna',
      costUsd: 0.00000504, providerCostUsd: 0.0000042, maxCostUsd: 0.0262144,
      replayed: false,
    })
  })

  it('carries idempotency and cost-limit headers when asked', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      model: 'gpt-6-luna', answers: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    }))
    await makeClient().decisions.create({ ...specExample, idempotencyKey: 'op-1', maxCostUsd: 0.01 })
    const headers = new Headers(mockFetch.mock.calls[0][1].headers)
    expect(headers.get('Idempotency-Key')).toBe('op-1')
    expect(headers.get('X-Tangle-Max-Cost-USD')).toBe('0.01')
  })

  it('per-question refusals flow through with native semantics', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      model: 'gpt-6-luna',
      answers: [{ type: 'refusal', name: 'damaged' }],
      usage: { input_tokens: 7, output_tokens: 0, total_tokens: 7 },
    }))
    const { decision } = await makeClient().decisions.create(specExample)
    expect(decision.answers[0]).toEqual({ type: 'refusal', name: 'damaged' })
  })
})

describe('client.systemone — the fleet wire', () => {
  it('sends state + named questions and returns answers by name with receipts', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      model: 'openai/gpt-6-luna',
      answers: { damaged: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 10, output_tokens: 0 },
    }, { 'X-Generation-Id': 'gen-2', 'X-Tangle-Cost-USD': '0.0000012' }))
    const client = makeClient()
    const { result, receipts } = await client.systemone({
      model: 'openai/gpt-6-luna',
      state: 'The package arrived with a broken screen.',
      questions: { damaged: { type: 'noul', instructions: 'Does the customer report a damaged item?' } },
      idempotencyKey: 'op-2',
    })
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://router.test/v1/systemone')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'openai/gpt-6-luna',
      state: 'The package arrived with a broken screen.',
      questions: { damaged: { type: 'noul', instructions: 'Does the customer report a damaged item?' } },
    })
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('op-2')
    expect(result.answers.damaged).toEqual({ type: 'noul', noul: 0.9 })
    expect(receipts.generationId).toBe('gen-2')
    expect(receipts.costUsd).toBe(0.0000012)
  })
})

describe('client.keyInfo / allowedModels / resolveModel — the key scope', () => {
  const scopedKey = () => jsonResponse({
    data: {
      allowed_models: ['zai/glm-5.3', 'gpt-5.5'],
      limit: 50, limit_remaining: 41.5, limit_reset: 'monthly',
      rate_limit: { interval: '1m', requests: 60 },
      expires_at: null,
    },
  })

  it('reads the allow-list in its positive form, with budgets and rate limit', async () => {
    mockFetch.mockResolvedValue(scopedKey())
    const info = await makeClient().keyInfo()
    expect(mockFetch.mock.calls[0][0]).toBe('http://router.test/v1/key')
    expect(info).toEqual({
      allowedModels: ['zai/glm-5.3', 'gpt-5.5'],
      limit: 50, limitRemaining: 41.5, limitReset: 'monthly',
      rateLimitRequests: 60, expiresAt: null,
    })
  })

  it('an unscoped key reads allowedModels null', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { allowed_models: null, limit: null } }))
    expect((await makeClient().keyInfo()).allowedModels).toBeNull()
  })

  it('allowedModels caches for five minutes; refresh forces a re-read', async () => {
    mockFetch.mockResolvedValue(scopedKey())
    const client = makeClient()
    await client.allowedModels()
    await client.allowedModels()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await client.allowedModels({ refresh: true })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('resolveModel: permitted stands, blocked reroutes by fallback order, nothing → refused with the set', async () => {
    mockFetch.mockResolvedValue(scopedKey())
    const client = makeClient()
    expect(await client.resolveModel('zai/glm-5.3')).toEqual({ status: 'allowed', model: 'zai/glm-5.3', rerouted: false })
    expect(await client.resolveModel('gpt-6-luna', { fallbacks: ['kimi-k3', 'gpt-5.5'] }))
      .toEqual({ status: 'rerouted', model: 'gpt-5.5', rerouted: true, blockedModel: 'gpt-6-luna' })
    expect(await client.resolveModel('gpt-6-luna'))
      .toEqual({ status: 'refused', model: null, allowedModels: ['zai/glm-5.3', 'gpt-5.5'] })
  })
})

describe('createKey budget derivation', () => {
  it('derives the ask within the parent\'s remaining instead of sending the flat default', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { id: 'k1', key: 'sk-tan-child' } }))
    await makeClient().createKey({ name: 'child', budgetUsd: 25, parentBudgetRemainingUsd: 5 })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    expect(body.budgetUsd).toBe(5)
    expect(body.parentBudgetRemainingUsd).toBeUndefined()
  })

  it('sends no derived field when the caller supplies no budget', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { id: 'k1', key: 'sk-tan-child' } }))
    await makeClient().createKey({ name: 'child', parentBudgetRemainingUsd: 5 })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    expect('budgetUsd' in body).toBe(false)
  })

  it('without a reported parent, the configured ask stands untouched', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { id: 'k1', key: 'sk-tan-child' } }))
    await makeClient().createKey({ name: 'child', budgetUsd: 25 })
    expect(JSON.parse(mockFetch.mock.calls[0][1].body as string).budgetUsd).toBe(25)
  })
})

describe('deriveChildBudgetUsd — the live-bisected contract', () => {
  it('asks the default when the parent is unknown', () => {
    for (const parentRemainingUsd of [undefined, null]) {
      expect(deriveChildBudgetUsd({ requestedUsd: 25, parentRemainingUsd })).toBe(25)
    }
    expect(deriveChildBudgetUsd({ requestedUsd: 25, parentRemainingUsd: Number.NaN })).toBe(25)
  })
  it('asks the parent remaining when it holds less (the killer case)', () => {
    expect(deriveChildBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 5 })).toBe(5)
  })
  it('floors fractional remaining to cents', () => {
    expect(deriveChildBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 8.37 })).toBe(8.36)
  })
  it('asks the default when the parent holds more', () => {
    expect(deriveChildBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 500 })).toBe(25)
  })
  it(`keeps the $${MIN_CHILD_KEY_BUDGET_USD} floor`, () => {
    expect(deriveChildBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 0.1 })).toBe(0.5)
  })
  it('refuses an exhausted parent correctably, before any mint', () => {
    expect(() => deriveChildBudgetUsd({ requestedUsd: 25, parentRemainingUsd: 0 })).toThrow(ParentBudgetExhaustedError)
  })
})

describe('allow-list utilities', () => {
  it('parses both router refusal shapes and returns null for unknown shapes', () => {
    expect(parseModelNotAllowed('Model "gpt-6-luna" is not in this key\'s allow-list. Allowed: glm-5.3, gpt-5.5.'))
      .toEqual(['glm-5.3', 'gpt-5.5'])
    expect(parseModelNotAllowed('Fallback model(s) "x" are not in this key\'s allow-list. Allowed: glm-5.3')).toEqual(['glm-5.3'])
    expect(parseModelNotAllowed('unexpected')).toBeNull()
  })
  it('resolves: unscoped passes, permitted passes, fallback reroutes named, else refused', () => {
    expect(resolveModelWithinAllowList({ requested: 'x', allowedModels: [] })).toEqual({ status: 'allowed', model: 'x', rerouted: false })
    expect(resolveModelWithinAllowList({ requested: 'a', allowedModels: ['a'] })).toEqual({ status: 'allowed', model: 'a', rerouted: false })
    expect(resolveModelWithinAllowList({ requested: 'x', allowedModels: ['a', 'b'], fallbacks: ['c', 'b'] }))
      .toEqual({ status: 'rerouted', model: 'b', rerouted: true, blockedModel: 'x' })
    expect(resolveModelWithinAllowList({ requested: 'x', allowedModels: ['a'] }))
      .toEqual({ status: 'refused', model: null, allowedModels: ['a'] })
  })
  it('formats the loud refusal naming the set', () => {
    expect(formatModelNotAllowedRefusal({ requested: 'x', allowedModels: ['a'] })).toContain('Allowed: a.')
  })
})
