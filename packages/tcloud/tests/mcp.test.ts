import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMcpServer } from '../src/mcp'
import type { TCloud } from '../src/index'

/** Stub client exposing just the surface the MCP server calls: search + research. */
function makeStubClient(overrides: Partial<Record<'search' | 'research', any>> = {}) {
  const search = overrides.search ?? vi.fn(async (opts: any) => ({
    id: 'search_1',
    object: 'search.result',
    provider: 'exa',
    model: 'exa',
    query: opts.query,
    data: [{ title: 'Result One', url: 'https://one.example', snippet: 'first hit' }],
    citations: ['https://one.example'],
  }))
  const research = overrides.research ?? vi.fn(async (opts: any) => ({
    id: 'research_1',
    object: 'research.result',
    provider: 'you',
    query: opts.query,
    answer: 'A synthesized answer.',
    results: [{ title: 'Source One', url: 'https://src.example' }],
    citations: ['https://src.example'],
  }))
  return { client: { search, research } as unknown as TCloud, search, research }
}

interface JsonRpcResponse {
  jsonrpc: string
  id: unknown
  result?: any
  error?: { code: number; message: string }
}

/**
 * Drive a list of JSON-RPC frames through the server over PassThrough streams
 * and collect the response frames. Waits until `expected` frames arrive (the
 * dispatcher is non-blocking, so responses can land after the read loop ends).
 */
async function drive(
  client: TCloud,
  frames: unknown[],
  opts: { expected?: number; raw?: string[] } = {},
): Promise<JsonRpcResponse[]> {
  const input = new PassThrough()
  const output = new PassThrough()
  const responses: JsonRpcResponse[] = []
  const expected = opts.expected ?? frames.length

  output.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (line.trim()) responses.push(JSON.parse(line) as JsonRpcResponse)
    }
  })

  const done = runMcpServer(client, { input, output })

  for (const frame of frames) input.write(`${JSON.stringify(frame)}\n`)
  for (const line of opts.raw ?? []) input.write(`${line}\n`)
  input.end()
  await done

  // Allow any fire-and-forget tool dispatches to settle.
  const deadline = Date.now() + 1000
  while (responses.length < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5))
  }
  return responses
}

describe('runMcpServer', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('responds to the initialize handshake and clamps the protocol version', async () => {
    const { client } = makeStubClient()
    const [resp] = await drive(client, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    ])
    expect(resp.id).toBe(1)
    expect(resp.result.protocolVersion).toBe('2025-06-18')
    expect(resp.result.capabilities).toEqual({ tools: {} })
    expect(resp.result.serverInfo.name).toBe('tangle-tcloud')
    // Version is read from package.json — not the old hardcoded 0.1.0.
    expect(resp.result.serverInfo.version).not.toBe('0.1.0')
  })

  it('falls back to the newest supported protocol version when the client requests an unknown one', async () => {
    const { client } = makeStubClient()
    const [resp] = await drive(client, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    ])
    expect(resp.result.protocolVersion).toBe('2025-06-18')
  })

  it('lists both web_search and deep_research tools', async () => {
    const { client } = makeStubClient()
    const [resp] = await drive(client, [{ jsonrpc: '2.0', id: 2, method: 'tools/list' }])
    const names = resp.result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('web_search')
    expect(names).toContain('deep_research')
  })

  it('dispatches web_search and forwards args + renders result text', async () => {
    const { client, search } = makeStubClient()
    const [resp] = await drive(client, [
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'web_search',
          arguments: {
            query: 'webgpu status',
            provider: 'exa',
            maxResults: 5,
            recency: 'week',
            includeDomains: ['gpuweb.github.io'],
            excludeDomains: ['spam.example'],
          },
        },
      },
    ])
    expect(search).toHaveBeenCalledWith({
      query: 'webgpu status',
      provider: 'exa',
      maxResults: 5,
      searchRecency: 'week',
      includeDomains: ['gpuweb.github.io'],
      excludeDomains: ['spam.example'],
    })
    expect(resp.result.content[0].text).toContain('Result One')
    expect(resp.result.content[0].text).toContain('https://one.example')
    expect(resp.result.isError).toBeUndefined()
  })

  it('dispatches deep_research and forwards args + renders answer + sources', async () => {
    const { client, research } = makeStubClient()
    const outputSchema = { type: 'object' }
    const [resp] = await drive(client, [
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'deep_research',
          arguments: {
            query: 'state of WebGPU',
            provider: 'you',
            effort: 'deep',
            searchRecency: 'month',
            includeDomains: ['gpuweb.github.io'],
            outputSchema,
          },
        },
      },
    ])
    expect(research).toHaveBeenCalledWith({
      query: 'state of WebGPU',
      provider: 'you',
      effort: 'deep',
      searchRecency: 'month',
      includeDomains: ['gpuweb.github.io'],
      outputSchema,
    })
    expect(resp.result.content[0].text).toContain('A synthesized answer.')
    expect(resp.result.content[0].text).toContain('Source One')
    expect(resp.result.content[0].text).toContain('https://src.example')
  })

  it('omits a non-finite maxResults instead of forwarding NaN', async () => {
    const { client, search } = makeStubClient()
    await drive(client, [
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'web_search', arguments: { query: 'q', maxResults: 'not-a-number' } },
      },
    ])
    expect(search).toHaveBeenCalledWith({ query: 'q' })
  })

  it('rejects an unknown provider with -32602', async () => {
    const { client, research } = makeStubClient()
    const [resp] = await drive(client, [
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'deep_research', arguments: { query: 'q', provider: 'brave' } },
      },
    ])
    expect(resp.error?.code).toBe(-32602)
    expect(research).not.toHaveBeenCalled()
  })

  it('rejects an empty query with -32602', async () => {
    const { client } = makeStubClient()
    const [resp] = await drive(client, [
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'web_search', arguments: { query: '   ' } },
      },
    ])
    expect(resp.error?.code).toBe(-32602)
  })

  it('rejects an unknown tool with -32602', async () => {
    const { client } = makeStubClient()
    const [resp] = await drive(client, [
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'nope', arguments: {} },
      },
    ])
    expect(resp.error?.code).toBe(-32602)
  })

  it('rejects an unknown method with -32601', async () => {
    const { client } = makeStubClient()
    const [resp] = await drive(client, [{ jsonrpc: '2.0', id: 9, method: 'does/not/exist' }])
    expect(resp.error?.code).toBe(-32601)
  })

  it('returns a -32700 Parse error for a malformed JSON line', async () => {
    const { client } = makeStubClient()
    const responses = await drive(client, [], { raw: ['{ not json'], expected: 1 })
    expect(responses[0].id).toBe(null)
    expect(responses[0].error?.code).toBe(-32700)
  })

  it('returns isError content (not a protocol error) when the tool call throws', async () => {
    const search = vi.fn(async () => {
      throw new Error('upstream 502')
    })
    const { client } = makeStubClient({ search })
    const [resp] = await drive(client, [
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'web_search', arguments: { query: 'q' } },
      },
    ])
    expect(resp.error).toBeUndefined()
    expect(resp.result.isError).toBe(true)
    expect(resp.result.content[0].text).toContain('upstream 502')
  })

  it('ignores notifications (no id) without responding', async () => {
    const { client } = makeStubClient()
    const responses = await drive(
      client,
      [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 11, method: 'tools/list' },
      ],
      { expected: 1 },
    )
    expect(responses).toHaveLength(1)
    expect(responses[0].id).toBe(11)
  })
})
