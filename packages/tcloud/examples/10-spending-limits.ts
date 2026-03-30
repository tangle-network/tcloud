/**
 * Spending limits — prevent runaway costs.
 *
 * Set per-request cost caps, total budget limits, and request count limits.
 * The client blocks requests that would exceed limits BEFORE sending them.
 *
 * Run: TCLOUD_API_KEY=sk-tan-... npx tsx examples/10-spending-limits.ts
 */
import { TCloud } from 'tcloud'

const client = new TCloud({
  apiKey: process.env.TCLOUD_API_KEY,
  model: 'gpt-4o-mini',
  limits: {
    // Hard caps — requests blocked when exceeded
    maxCostPerRequest: 0.01,     // $0.01 max per request
    maxTotalSpend: 0.10,         // $0.10 budget for this client's lifetime
    maxRequests: 50,             // 50 requests max

    // Callbacks — get notified before you hit the wall
    onLimitWarning: (info) => {
      console.warn(`⚠️  ${info.type} limit at ${((info.current / info.limit) * 100).toFixed(0)}% (${info.current}/${info.limit})`)
    },
    onLimitReached: (info) => {
      console.error(`🛑 ${info.type} limit reached: ${info.current}/${info.limit}`)
    },
  },
})

// Send a few requests — metering tracks each one
for (let i = 0; i < 3; i++) {
  try {
    const answer = await client.ask(`Say "${i}" and nothing else`)
    console.log(`Request ${i + 1}: ${answer.trim()}`)
  } catch (err: any) {
    console.log(`Request ${i + 1}: blocked — ${err.message}`)
    break
  }
}

// Check cumulative usage
const { totalSpent, requestCount } = client.usage
console.log(`\nTotal: ${requestCount} requests, $${totalSpent.toFixed(6)} spent`)
