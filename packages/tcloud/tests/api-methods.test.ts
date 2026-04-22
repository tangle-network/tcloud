import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TCloudClient, TCloudError } from '../src/client'

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response)
}

describe('models()', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('returns model list from data field', async () => {
    const models = [
      { id: 'gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.005', completion: '0.015' } },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', context_length: 200000, pricing: { prompt: '0.003', completion: '0.015' } },
    ]
    globalThis.fetch = mockFetch({ data: models })
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    const result = await client.models()
    expect(result).toEqual(models)
    expect(result).toHaveLength(2)
  })

  it('calls GET /models', async () => {
    const fn = mockFetch({ data: [] })
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.models()
    expect(fn.mock.calls[0][0]).toBe('https://router.tangle.tools/v1/models')
  })

  it('throws on error', async () => {
    globalThis.fetch = mockFetch({}, 500)
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await expect(client.models()).rejects.toThrow(TCloudError)
  })
})

describe('searchModels()', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('filters models by query', async () => {
    const models = [
      { id: 'gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.005', completion: '0.015' } },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet', context_length: 200000, pricing: { prompt: '0.003', completion: '0.015' } },
    ]
    globalThis.fetch = mockFetch({ data: models })
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    const result = await client.searchModels('claude')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('claude-sonnet-4-5')
  })

  it('is case-insensitive', async () => {
    const models = [
      { id: 'GPT-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.005', completion: '0.015' } },
    ]
    globalThis.fetch = mockFetch({ data: models })
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    const result = await client.searchModels('gpt')
    expect(result).toHaveLength(1)
  })
})

describe('operators()', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('calls /api/operators at root (not /v1)', async () => {
    const fn = mockFetch({ operators: [], stats: {} })
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.operators()
    expect(fn.mock.calls[0][0]).toBe('https://router.tangle.tools/api/operators')
  })
})

describe('credits()', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('calls id.tangle.tools /v1/billing/balance and unwraps { data }', async () => {
    const fn = mockFetch({ data: { balance: 100, transactions: [] } })
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    const result = await client.credits()
    expect(result.balance).toBe(100)
    expect(fn.mock.calls[0][0]).toBe('https://id.tangle.tools/v1/billing/balance')
  })
})

describe('addCredits()', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('posts amount to id.tangle.tools /v1/billing/topup and returns checkout URL', async () => {
    const fn = mockFetch({ data: { url: 'https://checkout.stripe.com/xyz' } })
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    const result = await client.addCredits(50)
    expect(result.url).toBe('https://checkout.stripe.com/xyz')
    expect(fn.mock.calls[0][0]).toBe('https://id.tangle.tools/v1/billing/topup')
    const body = JSON.parse(fn.mock.calls[0][1].body)
    expect(body.amount).toBe(50)
  })
})

describe('API key management', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('createKey() posts to id.tangle.tools /v1/keys and unwraps { data }', async () => {
    const fn = mockFetch({ data: { key: 'sk-tan-new', id: 'key-1' } })
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    const result = await client.createKey({ name: 'sandbox-prod' })
    expect(result.key).toBe('sk-tan-new')
    expect(fn.mock.calls[0][0]).toBe('https://id.tangle.tools/v1/keys')
    const body = JSON.parse(fn.mock.calls[0][1].body)
    expect(body.name).toBe('sandbox-prod')
  })

  it('keys() fetches id.tangle.tools /v1/keys and unwraps { data }', async () => {
    const fn = mockFetch({ data: [{ id: 'k1', name: 'test', prefix: 'sk-tan-te', createdAt: '2024-01-01', lastUsedAt: null }] })
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    const result = await client.keys()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('test')
    expect(fn.mock.calls[0][0]).toBe('https://id.tangle.tools/v1/keys')
  })

  it('revokeKey() deletes id.tangle.tools /v1/keys/:id', async () => {
    const fn = mockFetch({})
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.revokeKey('key-1')
    expect(fn.mock.calls[0][0]).toBe('https://id.tangle.tools/v1/keys/key-1')
    expect(fn.mock.calls[0][1].method).toBe('DELETE')
  })
})

describe('embeddings()', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('sends correct payload', async () => {
    const fn = mockFetch({ object: 'list', data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }], model: 'text-embedding-3-small', usage: { prompt_tokens: 5, total_tokens: 5 } })
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.embeddings({ input: 'hello world' })
    const body = JSON.parse(fn.mock.calls[0][1].body)
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.input).toBe('hello world')
  })

  it('accepts array input', async () => {
    const fn = mockFetch({ object: 'list', data: [], model: 'text-embedding-3-small', usage: { prompt_tokens: 0, total_tokens: 0 } })
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.embeddings({ input: ['a', 'b'], model: 'custom-embed' })
    const body = JSON.parse(fn.mock.calls[0][1].body)
    expect(body.input).toEqual(['a', 'b'])
    expect(body.model).toBe('custom-embed')
  })
})

describe('imageGenerate()', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('sends image generation request', async () => {
    const fn = mockFetch({ created: 1, data: [{ url: 'https://example.com/img.png' }] })
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.imageGenerate({ prompt: 'a cat', size: '1024x1024', quality: 'hd' })
    const [url, init] = fn.mock.calls[0]
    expect(url).toBe('https://router.tangle.tools/v1/images/generations')
    const body = JSON.parse(init.body)
    expect(body.prompt).toBe('a cat')
    expect(body.size).toBe('1024x1024')
    expect(body.quality).toBe('hd')
  })
})

describe('rerank()', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('sends rerank request', async () => {
    const fn = mockFetch({ results: [{ index: 0, relevance_score: 0.95 }] })
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.rerank({ query: 'best pizza', documents: ['pizza recipe', 'car manual'], top_n: 1 })
    const body = JSON.parse(fn.mock.calls[0][1].body)
    expect(body.query).toBe('best pizza')
    expect(body.documents).toHaveLength(2)
    expect(body.top_n).toBe(1)
  })
})

describe('speech()', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('calls /audio/speech', async () => {
    const fn = mockFetch({})
    globalThis.fetch = fn
    const client = new TCloudClient({ apiKey: 'sk-tan-test' })
    await client.speech({ input: 'hello', voice: 'nova' })
    expect(fn.mock.calls[0][0]).toBe('https://router.tangle.tools/v1/audio/speech')
    const body = JSON.parse(fn.mock.calls[0][1].body)
    expect(body.input).toBe('hello')
    expect(body.voice).toBe('nova')
  })
})

describe('TCLOUD_API_KEY env fallback', () => {
  let originalFetch: typeof globalThis.fetch
  const originalEnv = process.env.TCLOUD_API_KEY

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalEnv !== undefined) {
      process.env.TCLOUD_API_KEY = originalEnv
    } else {
      delete process.env.TCLOUD_API_KEY
    }
  })

  it('reads apiKey from TCLOUD_API_KEY env', async () => {
    process.env.TCLOUD_API_KEY = 'sk-tan-from-env'
    const fn = mockFetch({ data: [] })
    globalThis.fetch = fn
    const client = new TCloudClient({})
    await client.models()
    const headers = fn.mock.calls[0][1]?.headers
    expect(headers?.['Authorization']).toBe('Bearer sk-tan-from-env')
  })
})
