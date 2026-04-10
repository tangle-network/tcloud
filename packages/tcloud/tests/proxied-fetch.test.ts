import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TCloudClient, TCloudError } from '../src/client'

describe('proxiedFetch modes', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('direct mode: passes request through to fetch', async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ data: [] }),
    } as unknown as Response)
    globalThis.fetch = fn

    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      privacy: { mode: 'direct' },
      retry: false,
    })
    await client.models()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0][0]).toBe('https://router.tangle.tools/v1/models')
  })

  it('relayer mode: rewrites to relayer URL for non-streaming', async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ data: [] }),
    } as unknown as Response)
    globalThis.fetch = fn

    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      privacy: { mode: 'relayer', relayerUrl: 'http://localhost:3030' },
      retry: false,
    })
    await client.models()
    expect(fn).toHaveBeenCalledTimes(1)
    // Relayer wraps the request to /relay/proxy
    expect(fn.mock.calls[0][0]).toBe('http://localhost:3030/relay/proxy')
    const relayBody = JSON.parse(fn.mock.calls[0][1].body)
    expect(relayBody.target).toBe('https://router.tangle.tools/v1/models')
    expect(relayBody.headers).toBeDefined()
  })

  it('relayer mode: uses /relay/proxy-stream for streaming', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    const fn = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers(),
      body: stream,
    } as unknown as Response)
    globalThis.fetch = fn

    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      privacy: { mode: 'relayer', relayerUrl: 'http://localhost:3030' },
      retry: false,
    })
    for await (const _ of client.chatStream({ messages: [{ role: 'user', content: 'hi' }] })) {
      // drain
    }
    expect(fn.mock.calls[0][0]).toBe('http://localhost:3030/relay/proxy-stream')
  })

  it('relayer mode: throws if relayerUrl is missing', async () => {
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      privacy: { mode: 'relayer' }, // no relayerUrl
      retry: false,
    })
    await expect(client.models()).rejects.toThrow(/relayerUrl is required/)
  })

  it('socks5 mode: throws if socksProxy is missing', async () => {
    const client = new TCloudClient({
      apiKey: 'sk-tan-test',
      privacy: { mode: 'socks5' }, // no socksProxy
      retry: false,
    })
    await expect(client.models()).rejects.toThrow(/socksProxy is required/)
  })

  it('no privacy config: uses direct fetch', async () => {
    const fn = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ data: [] }),
    } as unknown as Response)
    globalThis.fetch = fn

    const client = new TCloudClient({ apiKey: 'sk-tan-test', retry: false })
    await client.models()
    // Should call fetch directly with the actual URL
    expect(fn.mock.calls[0][0]).toBe('https://router.tangle.tools/v1/models')
  })
})
