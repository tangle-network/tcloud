import { describe, it, expect, vi } from 'vitest'
import { TCloudClient, TCloudError } from '../src/client'

function makeClient(limits: any, overrides: any = {}) {
  const c = new TCloudClient({ model: 'test', limits, ...overrides })
  return c as any // access private fields for testing
}

describe('SpendingLimits', () => {
  describe('maxRequests', () => {
    it('blocks when request count hits limit', () => {
      const c = makeClient({ maxRequests: 3 })
      c._requestCount = 3
      expect(() => c.checkLimits()).toThrow(/Request limit reached/)
    })

    it('allows requests under limit', () => {
      const c = makeClient({ maxRequests: 10 })
      c._requestCount = 9
      expect(() => c.checkLimits()).not.toThrow()
    })

    it('allows exactly at limit minus 1', () => {
      const c = makeClient({ maxRequests: 5 })
      c._requestCount = 4
      expect(() => c.checkLimits()).not.toThrow()
    })
  })

  describe('maxTotalSpend', () => {
    it('blocks when total spend hits limit', () => {
      const c = makeClient({ maxTotalSpend: 0.50 })
      c._totalSpent = 0.50
      expect(() => c.checkLimits()).toThrow(/Spending limit reached/)
    })

    it('blocks when total spend exceeds limit', () => {
      const c = makeClient({ maxTotalSpend: 0.10 })
      c._totalSpent = 0.15
      expect(() => c.checkLimits()).toThrow(/Spending limit/)
    })

    it('allows under limit', () => {
      const c = makeClient({ maxTotalSpend: 1.0 })
      c._totalSpent = 0.99
      expect(() => c.checkLimits()).not.toThrow()
    })
  })

  describe('warnings', () => {
    it('fires onLimitWarning at 80% of maxRequests', () => {
      const onWarn = vi.fn()
      const c = makeClient({ maxRequests: 10, onLimitWarning: onWarn })
      c._requestCount = 8
      c.checkLimits()
      expect(onWarn).toHaveBeenCalledWith({
        type: 'requests',
        current: 8,
        limit: 10,
      })
    })

    it('fires onLimitWarning at 80% of maxTotalSpend', () => {
      const onWarn = vi.fn()
      const c = makeClient({ maxTotalSpend: 1.0, onLimitWarning: onWarn })
      c._totalSpent = 0.85
      c.checkLimits()
      expect(onWarn).toHaveBeenCalledWith({
        type: 'total',
        current: 0.85,
        limit: 1.0,
      })
    })

    it('does not fire warning below 80%', () => {
      const onWarn = vi.fn()
      const c = makeClient({ maxRequests: 100, onLimitWarning: onWarn })
      c._requestCount = 50
      c.checkLimits()
      expect(onWarn).not.toHaveBeenCalled()
    })

    it('fires onLimitReached when blocked', () => {
      const onReached = vi.fn()
      const c = makeClient({ maxRequests: 5, onLimitReached: onReached })
      c._requestCount = 5
      expect(() => c.checkLimits()).toThrow()
      expect(onReached).toHaveBeenCalledWith({
        type: 'requests',
        current: 5,
        limit: 5,
      })
    })
  })

  describe('trackCost', () => {
    it('increments requestCount', () => {
      const c = makeClient({})
      c.trackCost({ usage: { total_tokens: 100 } })
      expect(c._requestCount).toBe(1)
    })

    it('increments totalSpent from token count', () => {
      const c = makeClient({})
      c.trackCost({ usage: { total_tokens: 1_000_000 } })
      expect(c._totalSpent).toBeCloseTo(1.0) // $1/M tokens
    })

    it('accumulates across multiple calls', () => {
      const c = makeClient({})
      c.trackCost({ usage: { total_tokens: 500_000 } })
      c.trackCost({ usage: { total_tokens: 500_000 } })
      expect(c._requestCount).toBe(2)
      expect(c._totalSpent).toBeCloseTo(1.0)
    })

    it('handles missing usage gracefully', () => {
      const c = makeClient({})
      c.trackCost({})
      expect(c._requestCount).toBe(1)
      expect(c._totalSpent).toBe(0)
    })

    it('fires maxCostPerRequest callback when single request is expensive', () => {
      const onReached = vi.fn()
      const c = makeClient({ maxCostPerRequest: 0.001, onLimitReached: onReached })
      c.trackCost({ usage: { total_tokens: 10_000 } }) // $0.01 > $0.001
      expect(onReached).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'cost' })
      )
    })
  })

  describe('usage getter', () => {
    it('returns current metering state', () => {
      const c = makeClient({ maxRequests: 10 })
      c._requestCount = 3
      c._totalSpent = 0.05
      const u = c.usage
      expect(u.totalSpent).toBe(0.05)
      expect(u.requestCount).toBe(3)
      expect(u.limits?.maxRequests).toBe(10)
    })

    it('returns undefined limits when not configured', () => {
      const c = new TCloudClient({ model: 'test' })
      expect(c.usage.limits).toBeUndefined()
    })
  })

  describe('no limits configured', () => {
    it('never blocks regardless of usage', () => {
      const c = makeClient(undefined)
      c._requestCount = 999_999
      c._totalSpent = 999_999
      expect(() => c.checkLimits()).not.toThrow()
    })
  })

  describe('error type', () => {
    it('throws TCloudError with status 429', () => {
      const c = makeClient({ maxRequests: 1 })
      c._requestCount = 1
      try {
        c.checkLimits()
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(TCloudError)
        expect((e as TCloudError).status).toBe(429)
      }
    })
  })
})
