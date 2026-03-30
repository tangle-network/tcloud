/**
 * OpenAI SDK compatibility — use the OpenAI SDK with Tangle's API.
 *
 * The API is OpenAI-compatible, so any tool that works with OpenAI
 * works with Tangle by changing the base URL.
 *
 * Run: npm install openai && TCLOUD_API_KEY=sk-tan-... npx tsx examples/08-openai-compat.ts
 */
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: process.env.TCLOUD_API_KEY,
  baseURL: 'https://router.tangle.tools/v1',
})

const completion = await client.chat.completions.create({
  model: 'meta-llama/llama-4-maverick',
  messages: [{ role: 'user', content: 'Hello from the OpenAI SDK!' }],
})

console.log(completion.choices[0].message.content)
