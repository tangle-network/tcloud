import { describe, it, expect } from 'vitest'
import { PrivateRouter, type OperatorInfo } from '../src/private-router'

function makeOperators(count: number, model = 'gpt-4o'): OperatorInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    slug: `op-${i}`,
    endpointUrl: `https://op-${i}.example.com`,
    region: `region-${i % 3}`,
    reputationScore: 90 + i,
    avgLatencyMs: 100 + i * 10,
    models: [model],
  }))
}

describe('PrivateRouter', () => {
  describe('round-robin', () => {
    it('cycles through operators in order', () => {
      const router = new PrivateRouter({ strategy: 'round-robin', minOperators: 1 })
      const ops = makeOperators(3)
      router.setOperators(ops)

      const selected = Array.from({ length: 6 }, () => router.selectOperator('gpt-4o')!.slug)
      expect(selected).toEqual(['op-0', 'op-1', 'op-2', 'op-0', 'op-1', 'op-2'])
    })
  })

  describe('random', () => {
    it('selects from eligible operators', () => {
      const router = new PrivateRouter({ strategy: 'random', minOperators: 1 })
      const ops = makeOperators(5)
      router.setOperators(ops)

      const slugs = new Set<string>()
      for (let i = 0; i < 50; i++) {
        slugs.add(router.selectOperator('gpt-4o')!.slug)
      }
      // With 50 tries and 5 operators, should hit most of them
      expect(slugs.size).toBeGreaterThanOrEqual(3)
    })
  })

  describe('min-exposure', () => {
    it('avoids reusing the same operator consecutively', () => {
      const router = new PrivateRouter({ strategy: 'min-exposure', minOperators: 1 })
      const ops = makeOperators(3)
      router.setOperators(ops)

      let lastSlug = ''
      for (let i = 0; i < 10; i++) {
        const slug = router.selectOperator('gpt-4o')!.slug
        if (i > 0) {
          expect(slug).not.toBe(lastSlug)
        }
        lastSlug = slug
      }
    })

    it('uses all available operators', () => {
      const router = new PrivateRouter({ strategy: 'min-exposure', minOperators: 1 })
      const ops = makeOperators(3)
      router.setOperators(ops)

      const slugs = new Set<string>()
      for (let i = 0; i < 30; i++) {
        slugs.add(router.selectOperator('gpt-4o')!.slug)
      }
      // All operators should be used
      expect(slugs.size).toBe(3)
    })
  })

  describe('geo-distributed', () => {
    it('spreads requests across regions', () => {
      const router = new PrivateRouter({ strategy: 'geo-distributed', minOperators: 1 })
      const ops = makeOperators(6) // 3 regions (0,1,2), 2 ops each
      router.setOperators(ops)

      const regionCounts: Record<string, number> = {}
      for (let i = 0; i < 12; i++) {
        const op = router.selectOperator('gpt-4o')!
        regionCounts[op.region] = (regionCounts[op.region] || 0) + 1
      }
      // All 3 regions should be used
      expect(Object.keys(regionCounts).length).toBe(3)
    })
  })

  describe('latency-aware', () => {
    it('selects from eligible operators using weighted random', () => {
      const router = new PrivateRouter({ strategy: 'latency-aware', minOperators: 1 })
      const ops: OperatorInfo[] = [
        { slug: 'fast', endpointUrl: 'https://fast.example.com', region: 'us', reputationScore: 90, avgLatencyMs: 10, models: ['gpt-4o'] },
        { slug: 'medium', endpointUrl: 'https://medium.example.com', region: 'eu', reputationScore: 90, avgLatencyMs: 200, models: ['gpt-4o'] },
        { slug: 'slow', endpointUrl: 'https://slow.example.com', region: 'ap', reputationScore: 90, avgLatencyMs: 500, models: ['gpt-4o'] },
      ]
      router.setOperators(ops)

      const slugs = new Set<string>()
      for (let i = 0; i < 30; i++) {
        slugs.add(router.selectOperator('gpt-4o')!.slug)
      }
      // Should use multiple operators (weighted random, not deterministic)
      expect(slugs.size).toBeGreaterThanOrEqual(2)
    })
  })

  describe('model filtering', () => {
    it('only selects operators that serve the requested model', () => {
      const router = new PrivateRouter({ strategy: 'round-robin', minOperators: 1 })
      const ops: OperatorInfo[] = [
        { slug: 'op-a', endpointUrl: 'https://a.example.com', region: 'us', reputationScore: 90, avgLatencyMs: 100, models: ['gpt-4o'] },
        { slug: 'op-b', endpointUrl: 'https://b.example.com', region: 'us', reputationScore: 90, avgLatencyMs: 100, models: ['claude-sonnet-4-5'] },
        { slug: 'op-c', endpointUrl: 'https://c.example.com', region: 'us', reputationScore: 90, avgLatencyMs: 100, models: ['gpt-4o', 'claude-sonnet-4-5'] },
      ]
      router.setOperators(ops)

      const selected = Array.from({ length: 4 }, () => router.selectOperator('claude-sonnet-4-5')!.slug)
      expect(selected.every(s => s === 'op-b' || s === 'op-c')).toBe(true)
    })

    it('returns null when no operators serve the model', () => {
      const router = new PrivateRouter({ strategy: 'round-robin', minOperators: 1 })
      router.setOperators(makeOperators(3))
      expect(router.selectOperator('nonexistent-model')).toBeNull()
    })
  })

  describe('minOperators enforcement', () => {
    it('returns null when fewer operators than minOperators', () => {
      const router = new PrivateRouter({ strategy: 'round-robin', minOperators: 3 })
      router.setOperators(makeOperators(2))
      expect(router.selectOperator('gpt-4o')).toBeNull()
    })

    it('allows routing when exactly at minOperators', () => {
      const router = new PrivateRouter({ strategy: 'round-robin', minOperators: 3 })
      router.setOperators(makeOperators(3))
      expect(router.selectOperator('gpt-4o')).not.toBeNull()
    })
  })

  describe('excludeOperators', () => {
    it('filters out excluded operators', () => {
      const router = new PrivateRouter({ strategy: 'round-robin', minOperators: 1, excludeOperators: ['op-1'] })
      router.setOperators(makeOperators(3))

      const slugs = new Set<string>()
      for (let i = 0; i < 10; i++) {
        slugs.add(router.selectOperator('gpt-4o')!.slug)
      }
      expect(slugs.has('op-1')).toBe(false)
    })
  })

  describe('preferRegions', () => {
    it('sorts preferred regions first', () => {
      const router = new PrivateRouter({ strategy: 'round-robin', minOperators: 1, preferRegions: ['region-2'] })
      const ops = makeOperators(6) // regions 0,1,2
      router.setOperators(ops)

      // First selected should be from preferred region
      const first = router.selectOperator('gpt-4o')!
      expect(first.region).toBe('region-2')
    })
  })

  describe('getStats()', () => {
    it('tracks usage stats', () => {
      const router = new PrivateRouter({ strategy: 'round-robin', minOperators: 1 })
      router.setOperators(makeOperators(3))

      router.selectOperator('gpt-4o')
      router.selectOperator('gpt-4o')
      router.selectOperator('gpt-4o')

      const stats = router.getStats()
      expect(stats.totalRequests).toBe(3)
      expect(stats.operatorsUsed).toBe(3)
      expect(stats.strategy).toBe('round-robin')
      expect(stats.operatorBreakdown).toHaveLength(3)
    })
  })

  describe('shouldSummarize()', () => {
    it('returns false when summarizeOnSwitch is disabled', () => {
      const router = new PrivateRouter({ strategy: 'round-robin', minOperators: 1, summarizeOnSwitch: false })
      router.setOperators(makeOperators(3))
      router.selectOperator('gpt-4o')
      expect(router.shouldSummarize('gpt-4o')).toBe(false)
    })

    it('returns true when next operator differs from last', () => {
      const router = new PrivateRouter({ strategy: 'round-robin', minOperators: 1, summarizeOnSwitch: true })
      router.setOperators(makeOperators(3))
      router.selectOperator('gpt-4o') // op-0
      expect(router.shouldSummarize('gpt-4o')).toBe(true) // next is op-1, different
    })
  })
})
