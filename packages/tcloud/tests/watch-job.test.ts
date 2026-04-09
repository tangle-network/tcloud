import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TCloudClient, TCloudError } from '../src/client'
import type { JobEvent } from '../src/types'

/** Encode lines as a text/event-stream chunk */
function sseChunk(events: JobEvent[]): Uint8Array {
  const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
  return new TextEncoder().encode(text)
}

/** Build a ReadableStream from an array of SSE chunks delivered sequentially */
function makeSSEStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
      } else {
        controller.close()
      }
    },
  })
}

function mockFetch(stream: ReadableStream<Uint8Array>, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: new Headers(),
    body: stream,
    json: async () => ({ error: 'mock error' }),
  } as unknown as Response)
}

describe('watchJob', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('resolves with the terminal event on completed', async () => {
    const events: JobEvent[] = [
      { status: 'queued', timestamp: 1 },
      { status: 'processing', progress: 50, timestamp: 2 },
      { status: 'completed', progress: 100, result: { url: 'https://example.com/out.mp4' }, timestamp: 3 },
    ]
    const stream = makeSSEStream([sseChunk(events)])
    globalThis.fetch = mockFetch(stream)

    const client = new TCloudClient({ model: 'test' })
    const result = await client.watchJob('job-123')

    expect(result.status).toBe('completed')
    expect(result.result).toEqual({ url: 'https://example.com/out.mp4' })
  })

  it('resolves with the terminal event on failed', async () => {
    const events: JobEvent[] = [
      { status: 'queued', timestamp: 1 },
      { status: 'failed', error: 'GPU OOM', timestamp: 2 },
    ]
    const stream = makeSSEStream([sseChunk(events)])
    globalThis.fetch = mockFetch(stream)

    const client = new TCloudClient({ model: 'test' })
    const result = await client.watchJob('job-456')

    expect(result.status).toBe('failed')
    expect(result.error).toBe('GPU OOM')
  })

  it('resolves with the terminal event on cancelled', async () => {
    const events: JobEvent[] = [
      { status: 'cancelled', timestamp: 1 },
    ]
    const stream = makeSSEStream([sseChunk(events)])
    globalThis.fetch = mockFetch(stream)

    const client = new TCloudClient({ model: 'test' })
    const result = await client.watchJob('job-789')

    expect(result.status).toBe('cancelled')
  })

  it('calls onEvent for each event', async () => {
    const events: JobEvent[] = [
      { status: 'queued', timestamp: 1 },
      { status: 'processing', progress: 50, timestamp: 2 },
      { status: 'completed', timestamp: 3 },
    ]
    const stream = makeSSEStream([sseChunk(events)])
    globalThis.fetch = mockFetch(stream)

    const onEvent = vi.fn()
    const client = new TCloudClient({ model: 'test' })
    await client.watchJob('job-cb', { onEvent })

    expect(onEvent).toHaveBeenCalledTimes(3)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing', progress: 50 }))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('handles events split across multiple chunks', async () => {
    const chunk1 = new TextEncoder().encode('data: {"status":"queued","timestamp":1}\n\n')
    const chunk2 = new TextEncoder().encode('data: {"status":"completed","timestamp":2}\n\n')
    const stream = makeSSEStream([chunk1, chunk2])
    globalThis.fetch = mockFetch(stream)

    const client = new TCloudClient({ model: 'test' })
    const result = await client.watchJob('job-split')

    expect(result.status).toBe('completed')
  })

  it('throws TCloudError on non-ok response', async () => {
    const stream = makeSSEStream([])
    globalThis.fetch = mockFetch(stream, 404)

    const client = new TCloudClient({ model: 'test' })
    await expect(client.watchJob('job-404')).rejects.toThrow(TCloudError)
  })

  it('throws TCloudError(502) when stream ends without terminal event', async () => {
    const events: JobEvent[] = [
      { status: 'queued', timestamp: 1 },
      { status: 'processing', progress: 50, timestamp: 2 },
    ]
    const stream = makeSSEStream([sseChunk(events)])
    globalThis.fetch = mockFetch(stream)

    const client = new TCloudClient({ model: 'test' })
    await expect(client.watchJob('job-incomplete')).rejects.toThrow(/SSE stream ended/)
  })

  it('throws TCloudError(408) on timeout', async () => {
    // fetch itself hangs, but respects the abort signal
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const client = new TCloudClient({ model: 'test' })
    await expect(client.watchJob('job-timeout', { timeout: 50 }))
      .rejects.toThrow(/timed out/)
  })

  it('uses operatorUrl when provided', async () => {
    const events: JobEvent[] = [
      { status: 'completed', timestamp: 1 },
    ]
    const stream = makeSSEStream([sseChunk(events)])
    const mockFn = mockFetch(stream)
    globalThis.fetch = mockFn

    const client = new TCloudClient({ model: 'test' })
    await client.watchJob('job-op', { operatorUrl: 'https://operator.example.com' })

    expect(mockFn).toHaveBeenCalledWith(
      'https://operator.example.com/v1/jobs/job-op/events',
      expect.anything(),
    )
  })

  it('skips malformed JSON lines', async () => {
    const raw = [
      'data: not-json\n\n',
      'data: {"status":"completed","timestamp":1}\n\n',
    ].join('')
    const stream = makeSSEStream([new TextEncoder().encode(raw)])
    globalThis.fetch = mockFetch(stream)

    const client = new TCloudClient({ model: 'test' })
    const result = await client.watchJob('job-bad-json')

    expect(result.status).toBe('completed')
  })

  it('sets Authorization header when sseToken is provided', async () => {
    const events: JobEvent[] = [
      { status: 'completed', timestamp: 1 },
    ]
    const stream = makeSSEStream([sseChunk(events)])
    const mockFn = mockFetch(stream)
    globalThis.fetch = mockFn

    const client = new TCloudClient({ model: 'test' })
    await client.watchJob('job-token', {
      operatorUrl: 'https://operator.example.com',
      sseToken: 'my-sse-token',
    })

    const callHeaders = mockFn.mock.calls[0][1].headers
    expect(callHeaders['Authorization']).toBe('Bearer my-sse-token')
  })

  it('continues processing when onEvent callback throws', async () => {
    const events: JobEvent[] = [
      { status: 'queued', timestamp: 1 },
      { status: 'completed', timestamp: 2 },
    ]
    const stream = makeSSEStream([sseChunk(events)])
    globalThis.fetch = mockFetch(stream)

    const onEvent = vi.fn().mockImplementationOnce(() => {
      throw new Error('callback exploded')
    })
    const client = new TCloudClient({ model: 'test' })
    const result = await client.watchJob('job-throw-cb', { onEvent })

    expect(result.status).toBe('completed')
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it('throws on SSE buffer overflow (>1MB without newline)', async () => {
    // Create a single chunk larger than 1MB with no newline
    const bigChunk = new Uint8Array(1_048_577).fill(65) // 'A' repeated
    const stream = makeSSEStream([bigChunk])
    globalThis.fetch = mockFetch(stream)

    const client = new TCloudClient({ model: 'test' })
    await expect(client.watchJob('job-overflow')).rejects.toThrow(/SSE buffer overflow/)
  })

  it('skips [DONE] sentinel', async () => {
    const raw = [
      'data: {"status":"completed","timestamp":1}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const stream = makeSSEStream([new TextEncoder().encode(raw)])
    globalThis.fetch = mockFetch(stream)

    const client = new TCloudClient({ model: 'test' })
    const result = await client.watchJob('job-done')

    expect(result.status).toBe('completed')
  })
})
