import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TCloudClient, selectTiers } from '../client'
import type { TierConfig } from '../client'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeClient() {
  return new TCloudClient({ baseURL: 'http://test', apiKey: 'test-key', model: 'default-model' })
}

function mockOperatorsResponse(operators: any[]) {
  return { ok: true, json: () => Promise.resolve({ operators, stats: {} }) }
}

describe('selectTiers', () => {
  const tiers: TierConfig[] = [
    { name: 'a', cpu: 1, ramGb: 1, gpu: 0, tee: false },
    { name: 'b', cpu: 2, ramGb: 2, gpu: 1, tee: false },
    { name: 'c', cpu: 3, ramGb: 3, gpu: 1, tee: true },
    { name: 'd', cpu: 4, ramGb: 4, gpu: 2, tee: false },
    { name: 'e', cpu: 5, ramGb: 5, gpu: 2, tee: true },
    { name: 'f', cpu: 6, ramGb: 6, gpu: 4, tee: false },
    { name: 'g', cpu: 7, ramGb: 7, gpu: 4, tee: true },
  ]

  it('returns all items when n >= length', () => {
    expect(selectTiers(tiers, 7)).toHaveLength(7)
    expect(selectTiers(tiers, 10)).toHaveLength(7)
  })

  it('returns first item when n=1', () => {
    const result = selectTiers(tiers, 1)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('a')
  })

  it('returns first and last when n=2', () => {
    const result = selectTiers(tiers, 2)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('a')
    expect(result[1].name).toBe('g')
  })

  it('always includes first and last when n=3', () => {
    const result = selectTiers(tiers, 3)
    expect(result).toHaveLength(3)
    expect(result[0].name).toBe('a')
    expect(result[result.length - 1].name).toBe('g')
  })

  it('produces exactly n items for n=5', () => {
    const result = selectTiers(tiers, 5)
    expect(result).toHaveLength(5)
    expect(result[0].name).toBe('a')
    expect(result[result.length - 1].name).toBe('g')
  })
})

describe('pricingSpectrum', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('uses per-operator pricing, not model-level pricing', async () => {
    const client = makeClient()
    mockFetch.mockResolvedValueOnce(mockOperatorsResponse([
      {
        id: 'op1', gpuCount: 1,
        models: [{ modelId: 'default-model', inputPrice: 0.001, outputPrice: 0.002 }],
      },
      {
        id: 'op2', gpuCount: 1,
        models: [{ modelId: 'default-model', inputPrice: 0.005, outputPrice: 0.010 }],
      },
    ]))

    const spectrum = await client.pricingSpectrum({ tiers: 2 })
    const gpuTier = spectrum.find(t => t.config.gpu >= 1 && !t.config.tee)

    // Should have DIFFERENT cheapest vs priciest (op1 vs op2)
    expect(gpuTier).toBeDefined()
    expect(gpuTier!.cheapestPrice).toBe(0.001)
    expect(gpuTier!.priciestPrice).toBe(0.005)
    expect(gpuTier!.cheapest).not.toBe(gpuTier!.priciest)
    expect(gpuTier!.operatorsWithModel).toBe(2)
  })

  it('filters operators by GPU count using typed field', async () => {
    const client = makeClient()
    mockFetch.mockResolvedValueOnce(mockOperatorsResponse([
      { id: 'op1', gpuCount: 0, models: [{ modelId: 'm', inputPrice: 0.001, outputPrice: 0 }] },
      { id: 'op2', gpuCount: 1, models: [{ modelId: 'm', inputPrice: 0.002, outputPrice: 0 }] },
      { id: 'op3', gpuCount: 4, models: [{ modelId: 'm', inputPrice: 0.008, outputPrice: 0 }] },
    ]))

    const spectrum = await client.pricingSpectrum({ model: 'm', tiers: 7 })

    // cpu-only (gpu=0): all operators pass (no GPU filter when tier.gpu=0)
    const cpuOnly = spectrum.find(t => t.tier === 'cpu-only')!
    expect(cpuOnly.availableOperators).toBe(3)

    // gpu (gpu=1): op2 + op3 match
    const gpu = spectrum.find(t => t.tier === 'gpu')!
    expect(gpu.availableOperators).toBe(2)

    // multi-gpu (gpu=2): only op3 matches
    const multiGpu = spectrum.find(t => t.tier === 'multi-gpu')!
    expect(multiGpu.availableOperators).toBe(1)

    // max-gpu (gpu=4): only op3 matches
    const maxGpu = spectrum.find(t => t.tier === 'max-gpu')!
    expect(maxGpu.availableOperators).toBe(1)
  })

  it('filters operators by TEE using typed field', async () => {
    const client = makeClient()
    mockFetch.mockResolvedValueOnce(mockOperatorsResponse([
      { id: 'op1', gpuCount: 2, teeAttested: false, models: [{ modelId: 'm', inputPrice: 0.003, outputPrice: 0 }] },
      { id: 'op2', gpuCount: 2, teeAttested: true, models: [{ modelId: 'm', inputPrice: 0.005, outputPrice: 0 }] },
    ]))

    const spectrum = await client.pricingSpectrum({ model: 'm', tiers: 7 })

    const nonTee = spectrum.find(t => t.tier === 'multi-gpu')!
    expect(nonTee.availableOperators).toBe(2)

    const tee = spectrum.find(t => t.tier === 'multi-gpu-tee')!
    expect(tee.availableOperators).toBe(1)
    expect(tee.cheapestPrice).toBe(0.005)
  })

  it('returns "no operators" when none match', async () => {
    const client = makeClient()
    mockFetch.mockResolvedValueOnce(mockOperatorsResponse([]))

    const spectrum = await client.pricingSpectrum({ tiers: 3 })

    spectrum.forEach(tier => {
      expect(tier.availableOperators).toBe(0)
      expect(tier.operatorsWithModel).toBe(0)
      expect(tier.cheapest).toBe('no operators for this config')
      expect(tier.cheapestPrice).toBeUndefined()
    })
  })

  it('excludes operators that do not serve the requested model', async () => {
    const client = makeClient()
    mockFetch.mockResolvedValueOnce(mockOperatorsResponse([
      { id: 'op1', gpuCount: 1, models: [{ modelId: 'llama', inputPrice: 0.001, outputPrice: 0 }] },
      { id: 'op2', gpuCount: 1, models: [{ modelId: 'qwen', inputPrice: 0.002, outputPrice: 0 }] },
    ]))

    const spectrum = await client.pricingSpectrum({ model: 'llama', tiers: 2 })
    const gpuTier = spectrum.find(t => t.config.gpu >= 1)

    // Both operators match GPU requirements, but only op1 serves 'llama'
    expect(gpuTier!.availableOperators).toBe(2)
    expect(gpuTier!.operatorsWithModel).toBe(1)
    expect(gpuTier!.cheapestPrice).toBe(0.001)
    expect(gpuTier!.priciestPrice).toBeUndefined() // only one price point
  })

  it('clamps tiers to valid range', async () => {
    const client = makeClient()
    mockFetch.mockResolvedValueOnce(mockOperatorsResponse([]))

    const spectrum0 = await client.pricingSpectrum({ tiers: 0 })
    expect(spectrum0.length).toBe(1)

    mockFetch.mockResolvedValueOnce(mockOperatorsResponse([]))
    const spectrum100 = await client.pricingSpectrum({ tiers: 100 })
    expect(spectrum100.length).toBe(7) // capped at ALL_TIERS.length
  })

  it('makes exactly 1 API call', async () => {
    const client = makeClient()
    mockFetch.mockResolvedValueOnce(mockOperatorsResponse([]))

    await client.pricingSpectrum({ tiers: 3 })

    // Only fetches operators — no separate models() call needed
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('sorts prices ascending (cheapest first)', async () => {
    const client = makeClient()
    mockFetch.mockResolvedValueOnce(mockOperatorsResponse([
      { id: 'expensive', gpuCount: 1, models: [{ modelId: 'm', inputPrice: 0.999, outputPrice: 0 }] },
      { id: 'cheap', gpuCount: 1, models: [{ modelId: 'm', inputPrice: 0.001, outputPrice: 0 }] },
      { id: 'mid', gpuCount: 1, models: [{ modelId: 'm', inputPrice: 0.050, outputPrice: 0 }] },
    ]))

    const spectrum = await client.pricingSpectrum({ model: 'm', tiers: 2 })
    const gpuTier = spectrum.find(t => t.config.gpu >= 1)!

    expect(gpuTier.cheapestPrice).toBe(0.001)
    expect(gpuTier.priciestPrice).toBe(0.999)
  })

  it('omits priciestPrice when all operators have same price', async () => {
    const client = makeClient()
    mockFetch.mockResolvedValueOnce(mockOperatorsResponse([
      { id: 'op1', gpuCount: 1, models: [{ modelId: 'm', inputPrice: 0.005, outputPrice: 0 }] },
      { id: 'op2', gpuCount: 1, models: [{ modelId: 'm', inputPrice: 0.005, outputPrice: 0 }] },
    ]))

    const spectrum = await client.pricingSpectrum({ model: 'm', tiers: 2 })
    const gpuTier = spectrum.find(t => t.config.gpu >= 1)!

    expect(gpuTier.cheapestPrice).toBe(0.005)
    expect(gpuTier.priciestPrice).toBeUndefined()
    expect(gpuTier.priciest).toBeUndefined()
  })
})
