/**
 * Streaming — real-time token output via SSE.
 *
 * Run: TCLOUD_API_KEY=sk-tan-... npx tsx examples/03-streaming.ts
 */
import { TCloud } from 'tcloud'

const client = new TCloud({
  apiKey: process.env.TCLOUD_API_KEY,
  model: 'gpt-4o-mini',
})

// Simple streaming — yields text strings
console.log('Streaming response:')
for await (const chunk of client.askStream('Write a haiku about decentralized AI')) {
  process.stdout.write(chunk)
}
console.log('\n')

// Full streaming — yields ChatCompletionChunk objects (for token-level control)
console.log('Full chunks:')
for await (const chunk of client.chatStream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Count to 5' }],
  maxTokens: 50,
})) {
  const content = chunk.choices[0]?.delta?.content
  if (content) process.stdout.write(content)
}
console.log()
