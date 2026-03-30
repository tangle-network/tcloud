/**
 * tcloud's API is OpenAI-compatible.
 * You can use the OpenAI SDK directly — just point it at Tangle.
 */
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: process.env.TCLOUD_API_KEY,
  baseURL: 'https://api.tangleai.cloud/v1',
})

const completion = await client.chat.completions.create({
  model: 'meta-llama/llama-4-maverick',
  messages: [{ role: 'user', content: 'Hello from the OpenAI SDK!' }],
})

console.log(completion.choices[0].message.content)
