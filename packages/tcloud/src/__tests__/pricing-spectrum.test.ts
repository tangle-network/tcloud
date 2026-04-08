import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TCloudClient } from '../client'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeClient() {
  return new TCloudClient({ baseURL: 'http://test', apiKey: 'test-key' })
}

function mockOperators(operators: any[]) {
  return { operators, stats: {} }
}

function mockModels(models: any[]) {
  return models
}

describe('pricingSpectrum', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns tiers with operator counts', async () => {
    const client = makeClient()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockOperators([
          { id: 'op1', gpu_count: 1, tee_attested: false },
          { id: 'op2', gpu_count: 2, tee_attested: true },
          { id: 'op3', gpu_count: 0, tee_attested: false },
        ])),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels([
          { id: 'test-model', pricing: { prompt: '0.000001' } },
        ])),
      })

    const spectrum = await client.pricingSpectrum({ model: 'test-model', tiers: 3 })

    expect(spectrum.length).toBeLessThanOrEqual(3)
    expect(spectrum[0].tier).toBeDefined()
    expect(spectrum[0].config).toBeDefined()
    expect(spectrum[0].config.cpu).toBeGreaterThan(0)
    expect(typeof spectrum[0].availableOperators).toBe('number')
  })

  it('filters operators by GPU requirement', async () => {
    const client = makeClient()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockOperators([
          { id: 'op1', gpu_count: 0 },
          { id: 'op2', gpu_count: 1 },
          { id: 'op3', gpu_count: 4 },
        ])),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels([
          { id: 'model', pricing: { prompt: '0.001' } },
        ])),
      })

    const spectrum = await client.pricingSpectrum({ model: 'model', tiers: 7 })

    // cpu-only tier (gpu=0): all 3 operators match
    const cpuTier = spectrum.find(t => t.config.gpu === 0)
    expect(cpuTier).toBeDefined()
    expect(cpuTier!.availableOperators).toBe(3)

    // gpu tier (gpu=1): op2 + op3 match
    const gpuTier = spectrum.find(t => t.config.gpu === 1 && !t.config.tee)
    if (gpuTier) {
      expect(gpuTier.availableOperators).toBe(2)
    }

    // multi-gpu tier (gpu=2): only op3 matches
    const multiGpu = spectrum.find(t => t.config.gpu === 2)
    if (multiGpu) {
      expect(multiGpu.availableOperators).toBe(1)
    }

    // max-gpu tier (gpu=4): only op3 matches
    const maxGpu = spectrum.find(t => t.config.gpu === 4 && !t.config.tee)
    if (maxGpu) {
      expect(maxGpu.availableOperators).toBe(1)
    }
  })

  it('filters operators by TEE requirement', async () => {
    const client = makeClient()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockOperators([
          { id: 'op1', gpu_count: 2, tee_attested: false },
          { id: 'op2', gpu_count: 2, tee_attested: true },
        ])),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels([
          { id: 'model', pricing: { prompt: '0.001' } },
        ])),
      })

    const spectrum = await client.pricingSpectrum({ model: 'model', tiers: 7 })

    // Non-TEE tiers: both operators
    const nonTee = spectrum.find(t => t.config.gpu > 0 && !t.config.tee)
    if (nonTee) {
      expect(nonTee.availableOperators).toBe(2)
    }

    // TEE tiers: only op2
    const teeTier = spectrum.find(t => t.config.tee)
    if (teeTier) {
      expect(teeTier.availableOperators).toBe(1)
    }
  })

  it('handles no operators gracefully', async () => {
    const client = makeClient()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockOperators([])),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels([])),
      })

    const spectrum = await client.pricingSpectrum({ tiers: 3 })

    expect(spectrum.length).toBeGreaterThan(0)
    spectrum.forEach(tier => {
      expect(tier.availableOperators).toBe(0)
      expect(tier.cheapest).toBe('no pricing available')
    })
  })

  it('handles missing model pricing gracefully', async () => {
    const client = makeClient()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockOperators([{ id: 'op1', gpu_count: 1 }])),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels([
          { id: 'other-model', pricing: { prompt: '0.001' } },
        ])),
      })

    // Request model that doesn't exist
    const spectrum = await client.pricingSpectrum({ model: 'nonexistent', tiers: 2 })

    spectrum.forEach(tier => {
      expect(tier.cheapest).toBe('no pricing available')
    })
  })

  it('respects tiers parameter', async () => {
    const client = makeClient()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockOperators([])),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels([])),
      })

    const spectrum = await client.pricingSpectrum({ tiers: 2 })
    expect(spectrum.length).toBeLessThanOrEqual(2)
  })

  it('defaults to 5 tiers', async () => {
    const client = makeClient()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockOperators([])),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels([])),
      })

    const spectrum = await client.pricingSpectrum({})
    expect(spectrum.length).toBeLessThanOrEqual(5)
    expect(spectrum.length).toBeGreaterThan(0)
  })

  it('makes exactly 2 API calls (operators + models)', async () => {
    const client = makeClient()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockOperators([])),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels([])),
      })

    await client.pricingSpectrum({ tiers: 5 })

    // Should fetch operators and models in parallel — exactly 2 calls
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('tier configs increase monotonically in resources', async () => {
    const client = makeClient()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockOperators([])),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels([])),
      })

    const spectrum = await client.pricingSpectrum({ tiers: 7 })

    for (let i = 1; i < spectrum.length; i++) {
      const prev = spectrum[i - 1].config
      const curr = spectrum[i].config
      // Each tier should have >= resources of the previous
      expect(curr.cpu).toBeGreaterThanOrEqual(prev.cpu)
    }
  })

  it('handles operator response with varying field names', async () => {
    const client = makeClient()
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockOperators([
          // Different field naming conventions from different router versions
          { id: 'op1', gpuCount: 2, teeAttested: true },
          { id: 'op2', capabilities: { gpuCount: 1, teeAttested: false } },
          { id: 'op3', gpu_count: 3 },
        ])),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockModels([
          { id: 'model', pricing: { prompt: '0.001' } },
        ])),
      })

    const spectrum = await client.pricingSpectrum({ model: 'model', tiers: 3 })

    // Should handle all naming conventions without crashing
    expect(spectrum.length).toBeGreaterThan(0)
  })
})
