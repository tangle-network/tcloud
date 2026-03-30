/**
 * Model selection — three ways to pick a model.
 *
 * Run: TCLOUD_API_KEY=sk-tan-... npx tsx examples/02-model-selection.ts
 */
import { TCloud } from 'tcloud'

// 1. Set at client creation (recommended — explicit, one place to change)
const client = new TCloud({
  apiKey: process.env.TCLOUD_API_KEY,
  model: 'meta-llama/llama-4-maverick',
})

const answer1 = await client.ask('Hello from Llama')
console.log('[default model]', answer1)

// 2. Override per-request with full options (when you need control)
const completion = await client.chat({
  model: 'claude-sonnet-4-6',
  messages: [
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: 'What is 2+2?' },
  ],
  temperature: 0,
  maxTokens: 50,
})
console.log('[claude]', completion.choices[0].message.content)

// 3. Shorthand override (for scripts and REPL)
const answer3 = await client.ask('Hello from GPT', 'gpt-4o')
console.log('[gpt-4o]', answer3)

// Browse available models
const models = await client.models()
console.log(`\n${models.length} models available:`)
models.slice(0, 10).forEach(m => console.log(`  ${m.id} (${m._provider})`))

// Search by name
const llamas = await client.searchModels('llama')
console.log(`\n${llamas.length} llama models found`)
