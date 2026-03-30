/**
 * Cost estimation and usage tracking.
 *
 * Run: TCLOUD_API_KEY=sk-tan-... npx tsx examples/06-cost-and-usage.ts
 */
import { TCloud } from 'tcloud'

const client = new TCloud({
  apiKey: process.env.TCLOUD_API_KEY,
  model: 'gpt-4o',
})

// Estimate cost before sending
const estimate = await client.estimateCost({
  model: 'gpt-4o',
  inputTokens: 1000,
  outputTokens: 500,
})
console.log(`Estimated cost: $${estimate.total.toFixed(6)}`)
console.log(`  Input:  $${estimate.inputCost.toFixed(6)} (1000 tokens)`)
console.log(`  Output: $${estimate.outputCost.toFixed(6)} (500 tokens)`)

// Send request and get actual usage
const full = await client.askFull('Explain quantum computing in one paragraph')
console.log(`\nResponse: ${full.choices[0].message.content?.slice(0, 100)}...`)
console.log(`\nActual usage:`)
console.log(`  Model:   ${full.model}`)
console.log(`  Input:   ${full.usage?.prompt_tokens} tokens`)
console.log(`  Output:  ${full.usage?.completion_tokens} tokens`)
console.log(`  Total:   ${full.usage?.total_tokens} tokens`)

// Check credit balance
const credits = await client.credits()
console.log(`\nBalance: $${credits.balance.toFixed(2)}`)
