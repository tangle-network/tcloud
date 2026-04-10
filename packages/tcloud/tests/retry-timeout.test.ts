import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TCloudClient, TCloudError } from '../src/client'

function mockFetchSequence(responses: Array<{ ok: boolean; status: number; body?: unknown }>) {
  let i = 0
  return vi.fn().mockImplementation(async () => {
    const r = responses[Math.min(i++, responses.length - 1)]
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.ok ? 'OK' : 'Error',
      headers: new Headers(),
      json: async () => r.body ?? {},
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response
  })
}

describe('retry', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('retries on 502 and succeeds on second attempt', async () => {
    const fn = mockFetchSequence([
      { ok: false, status: 502 },
      { ok: true, status: 200, body: { data: [] } },
    ])
    globalThis.fetch = fn
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      retry: { maxRetries: 2, initialBackoffMs: 10 },
    })
    const models = await client.models()
    expect(models).toEqual([])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on 429 (rate limit)', async () => {
    const fn = mockFetchSequence([
      { ok: false, status: 429, body: { error: 'rate limited' } },
      { ok: true, status: 200, body: { data: [] } },
    ])
    globalThis.fetch = fn
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      retry: { maxRetries: 1, initialBackoffMs: 10 },
    })
    await client.models()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not retry on 400 (client error)', async () => {
    const fn = mockFetchSequence([
      { ok: false, status: 400, body: { error: { message: 'bad request' } } },
    ])
    globalThis.fetch = fn
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      retry: { maxRetries: 3, initialBackoffMs: 10 },
    })
    await expect(client.models()).rejects.toThrow('bad request')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 401', async () => {
    const fn = mockFetchSequence([
      { ok: false, status: 401, body: { error: 'unauthorized' } },
    ])
    globalThis.fetch = fn
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      retry: { maxRetries: 3, initialBackoffMs: 10 },
    })
    await expect(client.models()).rejects.toThrow(TCloudError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('exhausts all retries then throws', async () => {
    const fn = mockFetchSequence([
      { ok: false, status: 503, body: { error: 'unavailable' } },
      { ok: false, status: 503, body: { error: 'unavailable' } },
      { ok: false, status: 503, body: { error: 'unavailable' } },
    ])
    globalThis.fetch = fn
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      retry: { maxRetries: 2, initialBackoffMs: 10 },
    })
    await expect(client.models()).rejects.toThrow('unavailable')
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('retries on network error (fetch throws)', async () => {
    let calls = 0
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) throw new Error('ECONNRESET')
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: new Headers(),
        json: async () => ({ data: [] }),
      } as unknown as Response
    })
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      retry: { maxRetries: 1, initialBackoffMs: 10 },
    })
    const models = await client.models()
    expect(models).toEqual([])
    expect(calls).toBe(2)
  })

  it('respects retry: false — no retries', async () => {
    const fn = mockFetchSequence([
      { ok: false, status: 503, body: { error: 'unavailable' } },
    ])
    globalThis.fetch = fn
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      retry: false,
    })
    await expect(client.models()).rejects.toThrow(TCloudError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on 500 for billable _request methods', async () => {
    const fn = mockFetchSequence([
      { ok: false, status: 500 },
      { ok: true, status: 200, body: {} },
    ])
    globalThis.fetch = fn
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      retry: { maxRetries: 1, initialBackoffMs: 10 },
    })
    await client.embeddings({ input: 'test' })
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('timeout', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('throws TCloudError on timeout', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      // Wait for abort signal
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      timeout: 50, // 50ms timeout
      retry: false,
    })
    await expect(client.models()).rejects.toThrow(/timed out/)
  })

  it('timeout: 0 disables timeout', async () => {
    const fn = vi.fn().mockImplementation(async (_url: string, init: any) => {
      // Verify no abort signal timeout was set (signal should not abort)
      expect(init?.signal?.aborted).toBeFalsy()
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: new Headers(),
        json: async () => ({ data: [] }),
      } as unknown as Response
    })
    globalThis.fetch = fn
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      timeout: 0,
    })
    await client.models()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('custom timeout value is respected', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      timeout: 30,
      retry: false,
    })
    const start = Date.now()
    await expect(client.models()).rejects.toThrow(/timed out/)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(200) // should be ~30ms, not 60s default
  })
})

describe('retry + timeout interaction', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('timeout resets per retry attempt', async () => {
    let calls = 0
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      calls++
      if (calls === 1) {
        // First call: simulate timeout
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      }
      // Second call: succeed
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: new Headers(),
        json: async () => ({ data: [] }),
      } as unknown as Response
    })
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      timeout: 50,
      retry: { maxRetries: 1, initialBackoffMs: 10 },
    })
    const models = await client.models()
    expect(models).toEqual([])
    expect(calls).toBe(2)
  })
})
