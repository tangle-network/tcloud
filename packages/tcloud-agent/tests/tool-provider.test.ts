import { describe, expect, it, vi } from 'vitest'
import type { TCloudClient } from '@tangle-network/tcloud'
import { TangleToolProvider } from '../src/tool-provider'

/** Stub client exposing only the methods the search/research capabilities call. */
function makeStubClient(overrides: Partial<Record<'search' | 'research', any>> = {}) {
  const search = overrides.search ?? vi.fn(async (opts: any) => ({
    id: 'search_1',
    object: 'search.result',
    provider: 'exa',
    model: 'exa',
    query: opts.query,
    data: [{ title: 'Hit', url: 'https://hit.example', snippet: 'snip' }],
    citations: ['https://hit.example'],
    usage: { billed_cost: 0.002 },
  }))
  const research = overrides.research ?? vi.fn(async (opts: any) => ({
    id: 'research_1',
    object: 'research.result',
    provider: 'you',
    query: opts.query,
    answer: 'Synthesized answer.',
    results: [{ title: 'Source', url: 'https://src.example' }],
    citations: ['https://src.example'],
    structured: { ok: true },
    usage: { billed_cost: 0.05 },
  }))
  return { client: { search, research } as unknown as TCloudClient, search, research }
}

describe('TangleToolProvider', () => {
  it('registers search and research capabilities', () => {
    const { client } = makeStubClient()
    const provider = new TangleToolProvider(client)
    const caps = provider.listCapabilities()
    expect(caps).toContain('search')
    expect(caps).toContain('research')
  })

  it('search forwards params to client.search and maps the response', async () => {
    const { client, search } = makeStubClient()
    const provider = new TangleToolProvider(client)
    const result = await provider.execute('search', {
      query: 'webgpu',
      provider: 'exa',
      model: 'exa',
      maxResults: 3,
      searchRecency: 'week',
      includeDomains: ['gpuweb.github.io'],
      excludeDomains: ['spam.example'],
    })
    expect(search).toHaveBeenCalledWith({
      query: 'webgpu',
      provider: 'exa',
      model: 'exa',
      maxResults: 3,
      searchRecency: 'week',
      includeDomains: ['gpuweb.github.io'],
      excludeDomains: ['spam.example'],
    })
    expect(result.type).toBe('search')
    expect(result.data).toMatchObject({
      provider: 'exa',
      query: 'webgpu',
      results: [{ title: 'Hit', url: 'https://hit.example', snippet: 'snip' }],
      citations: ['https://hit.example'],
      usage: { billed_cost: 0.002 },
    })
  })

  it('research forwards params to client.research and maps answer/citations/results + structured', async () => {
    const { client, research } = makeStubClient()
    const outputSchema = { type: 'object' }
    const provider = new TangleToolProvider(client)
    const result = await provider.execute('research', {
      query: 'state of webgpu',
      provider: 'you',
      model: 'you',
      effort: 'deep',
      maxResults: 5,
      searchRecency: 'month',
      includeDomains: ['gpuweb.github.io'],
      excludeDomains: ['spam.example'],
      outputSchema,
    })
    expect(research).toHaveBeenCalledWith({
      query: 'state of webgpu',
      provider: 'you',
      model: 'you',
      effort: 'deep',
      maxResults: 5,
      searchRecency: 'month',
      includeDomains: ['gpuweb.github.io'],
      excludeDomains: ['spam.example'],
      outputSchema,
    })
    expect(result.type).toBe('research')
    expect(result.data).toMatchObject({
      provider: 'you',
      query: 'state of webgpu',
      answer: 'Synthesized answer.',
      citations: ['https://src.example'],
      results: [{ title: 'Source', url: 'https://src.example' }],
      usage: { billed_cost: 0.05 },
      structured: { ok: true },
    })
  })

  it('research omits structured when the provider did not return it', async () => {
    const research = vi.fn(async (opts: any) => ({
      id: 'research_2',
      object: 'research.result',
      provider: 'you',
      query: opts.query,
      answer: 'No structured output.',
      results: [],
      citations: [],
    }))
    const { client } = makeStubClient({ research })
    const provider = new TangleToolProvider(client)
    const result = await provider.execute('research', { query: 'q' })
    expect(result.data).not.toHaveProperty('structured')
  })

  it('search throws a clear error on a missing query', async () => {
    const { client, search } = makeStubClient()
    const provider = new TangleToolProvider(client)
    await expect(provider.execute('search', {})).rejects.toThrow(/query/)
    expect(search).not.toHaveBeenCalled()
  })

  it('research throws a clear error on a missing query', async () => {
    const { client, research } = makeStubClient()
    const provider = new TangleToolProvider(client)
    await expect(provider.execute('research', {})).rejects.toThrow(/query/)
    expect(research).not.toHaveBeenCalled()
  })
})
