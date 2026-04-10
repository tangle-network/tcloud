import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TCloudClient, TCloudError } from '../src/client'

function mockFetchJson(body: unknown = {}, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response)
}

describe('request counting consistency', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  const billableMethods: Array<{ name: string; call: (c: TCloudClient) => Promise<any> }> = [
    { name: 'embeddings', call: c => c.embeddings({ input: 'test' }) },
    { name: 'imageGenerate', call: c => c.imageGenerate({ prompt: 'test' }) },
    { name: 'rerank', call: c => c.rerank({ query: 'q', documents: ['d'] }) },
    { name: 'speech', call: c => c.speech({ input: 'test' }) },
    { name: 'completions', call: c => c.completions({ prompt: 'test' }) },
    { name: 'fineTuneCreate', call: c => c.fineTuneCreate({ model: 'm', training_file: 'f' }) },
    { name: 'batch', call: c => c.batch([{ model: 'm', messages: [{ role: 'user', content: 'hi' }] }]) },
    { name: 'videoGenerate', call: c => c.videoGenerate({ prompt: 'test' }) },
    { name: 'avatarGenerate', call: c => c.avatarGenerate({ audio_url: 'https://example.com/audio.wav' }) },
    { name: 'createCollection', call: c => c.createCollection({ name: 'test', dimensions: 128 }) },
    { name: 'upsertVectors', call: c => c.upsertVectors('col', [{ id: '1', vector: [0.1] }]) },
    { name: 'queryVectors', call: c => c.queryVectors('col', { vector: [0.1] }) },
    { name: 'ragQuery', call: c => c.ragQuery({ query: 'test', collection: 'col' }) },
  ]

  for (const { name, call } of billableMethods) {
    it(`${name}() increments requestCount`, async () => {
      globalThis.fetch = mockFetchJson({})
      const client = new TCloudClient({ apiKey: 'sk-tan-test' })
      expect(client.usage.requestCount).toBe(0)
      await call(client)
      expect(client.usage.requestCount).toBe(1)
    })
  }

  const readOnlyMethods: Array<{ name: string; call: (c: TCloudClient) => Promise<any> }> = [
    { name: 'models', call: c => c.models() },
    { name: 'operators', call: c => c.operators() },
    { name: 'credits', call: c => c.credits() },
    { name: 'keys', call: c => c.keys() },
    { name: 'fineTuneList', call: c => c.fineTuneList() },
    { name: 'batchStatus', call: c => c.batchStatus('job-1') },
    { name: 'videoStatus', call: c => c.videoStatus('v-1') },
    { name: 'avatarJobStatus', call: c => c.avatarJobStatus('j-1') },
    { name: 'listCollections', call: c => c.listCollections() },
  ]

  for (const { name, call } of readOnlyMethods) {
    it(`${name}() does NOT increment requestCount (read-only)`, async () => {
      globalThis.fetch = mockFetchJson({ data: [], operators: [], balance: 0, transactions: [] })
      const client = new TCloudClient({ apiKey: 'sk-tan-test' })
      await call(client)
      expect(client.usage.requestCount).toBe(0)
    })
  }
})

describe('spending limits enforcement', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  const billableMethods: Array<{ name: string; call: (c: TCloudClient) => Promise<any> }> = [
    { name: 'embeddings', call: c => c.embeddings({ input: 'test' }) },
    { name: 'imageGenerate', call: c => c.imageGenerate({ prompt: 'test' }) },
    { name: 'rerank', call: c => c.rerank({ query: 'q', documents: ['d'] }) },
    { name: 'speech', call: c => c.speech({ input: 'test' }) },
    { name: 'completions', call: c => c.completions({ prompt: 'test' }) },
    { name: 'fineTuneCreate', call: c => c.fineTuneCreate({ model: 'm', training_file: 'f' }) },
    { name: 'batch', call: c => c.batch([{ model: 'm', messages: [{ role: 'user', content: 'hi' }] }]) },
    { name: 'videoGenerate', call: c => c.videoGenerate({ prompt: 'test' }) },
    { name: 'avatarGenerate', call: c => c.avatarGenerate({ audio_url: 'https://example.com/audio.wav' }) },
    { name: 'createCollection', call: c => c.createCollection({ name: 'test', dimensions: 128 }) },
    { name: 'upsertVectors', call: c => c.upsertVectors('col', [{ id: '1', vector: [0.1] }]) },
    { name: 'queryVectors', call: c => c.queryVectors('col', { vector: [0.1] }) },
    { name: 'ragQuery', call: c => c.ragQuery({ query: 'test', collection: 'col' }) },
  ]

  for (const { name, call } of billableMethods) {
    it(`${name}() blocks when maxRequests limit reached`, async () => {
      globalThis.fetch = mockFetchJson({})
      const client = new TCloudClient({
        apiKey: 'sk-tan-test',
        limits: { maxRequests: 1 },
      }) as any
      // Simulate having already used the one allowed request
      client._requestCount = 1
      await expect(call(client)).rejects.toThrow(/Request limit reached/)
    })
  }
})

describe('error handling consistency', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  const allMethods: Array<{ name: string; call: (c: TCloudClient) => Promise<any> }> = [
    { name: 'models', call: c => c.models() },
    { name: 'operators', call: c => c.operators() },
    { name: 'credits', call: c => c.credits() },
    { name: 'addCredits', call: c => c.addCredits(10) },
    { name: 'createKey', call: c => c.createKey('test') },
    { name: 'keys', call: c => c.keys() },
    { name: 'revokeKey', call: c => c.revokeKey('k-1') },
    { name: 'embeddings', call: c => c.embeddings({ input: 'test' }) },
    { name: 'imageGenerate', call: c => c.imageGenerate({ prompt: 'test' }) },
    { name: 'rerank', call: c => c.rerank({ query: 'q', documents: ['d'] }) },
    { name: 'speech', call: c => c.speech({ input: 'test' }) },
    { name: 'completions', call: c => c.completions({ prompt: 'test' }) },
    { name: 'fineTuneCreate', call: c => c.fineTuneCreate({ model: 'm', training_file: 'f' }) },
    { name: 'fineTuneList', call: c => c.fineTuneList() },
    { name: 'batch', call: c => c.batch([{ model: 'm', messages: [{ role: 'user', content: 'hi' }] }]) },
    { name: 'batchStatus', call: c => c.batchStatus('j-1') },
    { name: 'videoGenerate', call: c => c.videoGenerate({ prompt: 'test' }) },
    { name: 'videoStatus', call: c => c.videoStatus('v-1') },
    { name: 'avatarGenerate', call: c => c.avatarGenerate({ audio_url: 'https://example.com/audio.wav' }) },
    { name: 'avatarJobStatus', call: c => c.avatarJobStatus('j-1') },
    { name: 'createCollection', call: c => c.createCollection({ name: 'test', dimensions: 128 }) },
    { name: 'listCollections', call: c => c.listCollections() },
    { name: 'upsertVectors', call: c => c.upsertVectors('col', [{ id: '1', vector: [0.1] }]) },
    { name: 'queryVectors', call: c => c.queryVectors('col', { vector: [0.1] }) },
    { name: 'ragQuery', call: c => c.ragQuery({ query: 'test', collection: 'col' }) },
  ]

  for (const { name, call } of allMethods) {
    it(`${name}() throws TCloudError with server message on 400`, async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Headers(),
        json: async () => ({ error: { message: 'specific error from server' } }),
      } as unknown as Response)

      const client = new TCloudClient({ apiKey: 'sk-tan-test' })
      try {
        await call(client)
        expect.unreachable('should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(TCloudError)
        expect(e.message).toContain('specific error from server')
      }
    })
  }

  for (const { name, call } of allMethods) {
    it(`${name}() handles non-JSON error responses gracefully`, async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        headers: new Headers(),
        json: async () => { throw new Error('not json') },
      } as unknown as Response)

      const client = new TCloudClient({ apiKey: 'sk-tan-test' })
      await expect(call(client)).rejects.toThrow(TCloudError)
    })
  }
})
