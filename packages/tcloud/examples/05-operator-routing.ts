/**
 * Operator routing — control which operator serves your request.
 *
 * The gateway selects operators by composite score:
 *   reputation (40%) + latency (30%) + price (30%)
 *
 * You can override this with explicit preferences.
 *
 * Run: TCLOUD_API_KEY=sk-tan-... npx tsx examples/05-operator-routing.ts
 */
import { TCloud } from 'tcloud'

// Route to a specific operator
const client = new TCloud({
  apiKey: process.env.TCLOUD_API_KEY,
  model: 'gpt-4o-mini',
  routing: {
    prefer: 'tangle-core',          // specific operator slug
    strategy: 'lowest-latency',     // fallback strategy if preferred unavailable
    region: 'us-east',              // geographic hint
  },
})

const answer = await client.ask('Hello')
console.log(answer)

// List operators to see what's available
const { operators, stats } = await client.operators()
console.log(`\n${stats.activeOperators} active operators:`)
for (const op of operators) {
  console.log(`  ${op.slug} — ${op.models.length} models, ${op.reputationScore}% reputation, ${op.avgLatencyMs}ms avg`)
}
