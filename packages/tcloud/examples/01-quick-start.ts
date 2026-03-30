/**
 * Quick start — the minimum to get inference working.
 *
 * Run: TCLOUD_API_KEY=sk-tan-... npx tsx examples/01-quick-start.ts
 */
import { TCloud } from 'tcloud'

// Model is set at client creation — every request uses it.
const client = new TCloud({
  apiKey: process.env.TCLOUD_API_KEY,
  model: 'gpt-4o-mini',
})

const answer = await client.ask('What is Tangle Network?')
console.log(answer)
