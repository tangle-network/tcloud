/**
 * Vercel AI SDK compatibility — use Tangle with the AI SDK.
 *
 * The OpenAI provider works because Tangle exposes an OpenAI-compatible API.
 *
 * Run: npm install ai @ai-sdk/openai && TCLOUD_API_KEY=sk-tan-... npx tsx examples/09-vercel-ai-sdk.ts
 */
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, streamText } from 'ai'

const tangle = createOpenAI({
  apiKey: process.env.TCLOUD_API_KEY,
  baseURL: 'https://api.tangleai.cloud/v1',
})

// Non-streaming
const { text } = await generateText({
  model: tangle('meta-llama/llama-4-maverick'),
  prompt: 'What is decentralized AI?',
})
console.log(text)

// Streaming
const result = streamText({
  model: tangle('gpt-4o-mini'),
  prompt: 'Explain operator routing in 3 sentences.',
})

for await (const chunk of result.textStream) {
  process.stdout.write(chunk)
}
console.log()
