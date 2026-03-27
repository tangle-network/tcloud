/**
 * Private Router — operator rotation strategies for privacy-preserving inference.
 *
 * Each strategy determines how requests are distributed across operators
 * to minimize the information any single operator can gather about a user's
 * conversation patterns.
 */

export interface OperatorInfo {
  slug: string
  endpointUrl: string
  region: string
  reputationScore: number
  avgLatencyMs: number
  models: string[]
}

export type RoutingStrategy =
  | 'round-robin'      // Cycle through operators sequentially
  | 'random'           // Random operator each request
  | 'geo-distributed'  // Spread across regions
  | 'min-exposure'     // Switch after N requests per operator
  | 'latency-aware'    // Rotate but prefer low-latency operators

export interface PrivateRouterConfig {
  strategy: RoutingStrategy
  /** Max requests to same operator before forced rotation */
  maxRequestsPerOperator: number
  /** Minimum number of distinct operators to use */
  minOperators: number
  /** Region preferences (operators in these regions preferred) */
  preferRegions?: string[]
  /** Exclude specific operators */
  excludeOperators?: string[]
  /** Enable context summarization between operator switches (reduces info leakage) */
  summarizeOnSwitch: boolean
}

interface OperatorUsage {
  slug: string
  requestCount: number
  lastUsedAt: number
}

export class PrivateRouter {
  private config: PrivateRouterConfig
  private operators: OperatorInfo[] = []
  private usage: Map<string, OperatorUsage> = new Map()
  private currentIndex = 0
  private totalRequests = 0

  constructor(config: Partial<PrivateRouterConfig> = {}) {
    this.config = {
      strategy: config.strategy || 'round-robin',
      maxRequestsPerOperator: config.maxRequestsPerOperator || 5,
      minOperators: config.minOperators || 3,
      preferRegions: config.preferRegions,
      excludeOperators: config.excludeOperators,
      summarizeOnSwitch: config.summarizeOnSwitch ?? false,
    }
  }

  /** Set the available operator pool */
  setOperators(operators: OperatorInfo[]) {
    let filtered = operators.filter(
      (o) => !this.config.excludeOperators?.includes(o.slug)
    )
    if (this.config.preferRegions?.length) {
      // Sort preferred regions first, but keep others as fallback
      filtered.sort((a, b) => {
        const aPreferred = this.config.preferRegions!.includes(a.region) ? 0 : 1
        const bPreferred = this.config.preferRegions!.includes(b.region) ? 0 : 1
        return aPreferred - bPreferred
      })
    }
    this.operators = filtered
  }

  /** Select the next operator for a request */
  selectOperator(model: string): OperatorInfo | null {
    const eligible = this.operators.filter((o) => o.models.includes(model))
    if (eligible.length === 0) return null

    this.totalRequests++

    switch (this.config.strategy) {
      case 'round-robin':
        return this.roundRobin(eligible)
      case 'random':
        return this.random(eligible)
      case 'geo-distributed':
        return this.geoDistributed(eligible)
      case 'min-exposure':
        return this.minExposure(eligible)
      case 'latency-aware':
        return this.latencyAware(eligible)
      default:
        return this.roundRobin(eligible)
    }
  }

  /** Should we summarize context before this request? (operator is changing) */
  shouldSummarize(model: string): boolean {
    if (!this.config.summarizeOnSwitch) return false
    const next = this.peekNextOperator(model)
    const last = this.getLastUsedOperator()
    return next !== null && last !== null && next.slug !== last.slug
  }

  /** Get privacy stats */
  getStats() {
    return {
      totalRequests: this.totalRequests,
      operatorsUsed: this.usage.size,
      operatorBreakdown: Array.from(this.usage.values()).map((u) => ({
        slug: u.slug,
        requests: u.requestCount,
        lastUsed: u.lastUsedAt,
      })),
      strategy: this.config.strategy,
    }
  }

  // ─── Strategies ────────────────────────────────────────────

  private roundRobin(eligible: OperatorInfo[]): OperatorInfo {
    const op = eligible[this.currentIndex % eligible.length]
    this.currentIndex++
    this.recordUsage(op)
    return op
  }

  private random(eligible: OperatorInfo[]): OperatorInfo {
    const idx = Math.floor(Math.random() * eligible.length)
    const op = eligible[idx]
    this.recordUsage(op)
    return op
  }

  private geoDistributed(eligible: OperatorInfo[]): OperatorInfo {
    // Group by region, pick from least-used region
    const regionUsage = new Map<string, number>()
    for (const op of eligible) {
      const usage = this.usage.get(op.slug)?.requestCount || 0
      const current = regionUsage.get(op.region) || 0
      regionUsage.set(op.region, current + usage)
    }
    const sortedRegions = [...regionUsage.entries()].sort((a, b) => a[1] - b[1])
    const targetRegion = sortedRegions[0]?.[0]
    const regionOps = eligible.filter((o) => o.region === targetRegion)
    const op = regionOps[Math.floor(Math.random() * regionOps.length)] || eligible[0]
    this.recordUsage(op)
    return op
  }

  private minExposure(eligible: OperatorInfo[]): OperatorInfo {
    // Pick the operator with the fewest requests, switching if any hit the max
    const lastUsed = this.getLastUsedOperator()
    if (lastUsed) {
      const lastUsage = this.usage.get(lastUsed.slug)
      if (lastUsage && lastUsage.requestCount >= this.config.maxRequestsPerOperator) {
        // Force switch — pick the least-used operator
        const others = eligible.filter((o) => o.slug !== lastUsed.slug)
        if (others.length > 0) {
          const sorted = others.sort(
            (a, b) => (this.usage.get(a.slug)?.requestCount || 0) - (this.usage.get(b.slug)?.requestCount || 0)
          )
          const op = sorted[0]
          this.recordUsage(op)
          return op
        }
      }
    }
    // Otherwise use current operator
    const op = lastUsed || eligible[0]
    this.recordUsage(op)
    return op
  }

  private latencyAware(eligible: OperatorInfo[]): OperatorInfo {
    // Weighted random: lower latency = higher probability, but still rotate
    const weights = eligible.map((o) => {
      const latencyWeight = 1 / Math.max(o.avgLatencyMs, 10)
      const usagePenalty = (this.usage.get(o.slug)?.requestCount || 0) * 0.1
      return Math.max(latencyWeight - usagePenalty, 0.01)
    })
    const totalWeight = weights.reduce((s, w) => s + w, 0)
    let r = Math.random() * totalWeight
    for (let i = 0; i < eligible.length; i++) {
      r -= weights[i]
      if (r <= 0) {
        this.recordUsage(eligible[i])
        return eligible[i]
      }
    }
    const op = eligible[eligible.length - 1]
    this.recordUsage(op)
    return op
  }

  // ─── Helpers ───────────────────────────────────────────────

  private recordUsage(op: OperatorInfo) {
    const existing = this.usage.get(op.slug)
    this.usage.set(op.slug, {
      slug: op.slug,
      requestCount: (existing?.requestCount || 0) + 1,
      lastUsedAt: Date.now(),
    })
  }

  private getLastUsedOperator(): OperatorInfo | null {
    let latest: OperatorUsage | null = null
    for (const u of this.usage.values()) {
      if (!latest || u.lastUsedAt > latest.lastUsedAt) latest = u
    }
    if (!latest) return null
    return this.operators.find((o) => o.slug === latest!.slug) || null
  }

  private peekNextOperator(model: string): OperatorInfo | null {
    // Preview which operator would be selected without recording
    const eligible = this.operators.filter((o) => o.models.includes(model))
    if (eligible.length === 0) return null
    if (this.config.strategy === 'round-robin') {
      return eligible[this.currentIndex % eligible.length]
    }
    return eligible[0]
  }
}
