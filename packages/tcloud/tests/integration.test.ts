/**
 * Integration tests against the live router.tangle.tools.
 * Requires TCLOUD_API_KEY env var set.
 * Run with: TCLOUD_API_KEY=sk-tan-xxx vitest run tests/integration.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { TCloud } from '../src/index'
import type { ChatCompletion, Model } from '../src/types'

const API_KEY = process.env.TCLOUD_API_KEY

const describeIf = (condition: boolean) => condition ? describe : describe.skip

describeIf(!!API_KEY)('integration: router.tangle.tools', () => {
  let client: InstanceType<typeof TCloud>

  beforeAll(() => {
    client = new TCloud({
      apiKey: API_KEY,
      timeout: 30_000,
      retry: { maxRetries: 2, initialBackoffMs: 1000 },
    })
  })

  describe('models', () => {
    let models: Model[]

    it('lists available models', async () => {
      models = await client.models()
      expect(models.length).toBeGreaterThan(0)
      console.log(`  Models available: ${models.length}`)
    })

    it('models have required fields', () => {
      const m = models[0]
      expect(m.id).toBeTruthy()
      expect(m.name).toBeTruthy()
      expect(typeof m.context_length).toBe('number')
      expect(m.pricing).toBeDefined()
      expect(m.pricing.prompt).toBeDefined()
      expect(m.pricing.completion).toBeDefined()
    })

    it('searchModels filters correctly', async () => {
      const results = await client.searchModels('gpt-4o')
      expect(results.length).toBeGreaterThan(0)
      expect(results.every(m => m.id.includes('gpt-4o') || m.name.toLowerCase().includes('gpt-4o'))).toBe(true)
    })
  })

  describe('chat completion', () => {
    it('returns a valid completion', async () => {
      const result = await client.chat({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say exactly: hello tcloud' }],
        maxTokens: 20,
        temperature: 0,
      })
      expect(result.id).toBeTruthy()
      expect(result.choices.length).toBeGreaterThan(0)
      expect(result.choices[0].message.content).toBeTruthy()
      expect(result.usage).toBeDefined()
      expect(result.usage!.prompt_tokens).toBeGreaterThan(0)
      expect(result.usage!.completion_tokens).toBeGreaterThan(0)
      console.log(`  Response: "${result.choices[0].message.content}"`)
      console.log(`  Tokens: ${result.usage!.prompt_tokens} in / ${result.usage!.completion_tokens} out`)
    })

    it('ask() convenience method works', async () => {
      const text = await client.ask('Say exactly: ping', 'gpt-4o-mini')
      expect(text).toBeTruthy()
      expect(text.length).toBeGreaterThan(0)
      console.log(`  ask() response: "${text}"`)
    })

    it('tracks usage stats', async () => {
      const before = client.usage.requestCount
      await client.ask('Say hi', { model: 'gpt-4o-mini', maxTokens: 5 })
      expect(client.usage.requestCount).toBe(before + 1)
      expect(client.usage.totalSpent).toBeGreaterThan(0)
      console.log(`  Total spent: $${client.usage.totalSpent.toFixed(6)}`)
    })
  })

  describe('streaming', () => {
    it('chatStream yields chunks', async () => {
      const chunks: string[] = []
      for await (const chunk of client.chatStream({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Count from 1 to 5' }],
        maxTokens: 50,
      })) {
        const content = chunk.choices[0]?.delta?.content
        if (content) chunks.push(content)
      }
      expect(chunks.length).toBeGreaterThan(0)
      const full = chunks.join('')
      console.log(`  Stream: "${full}" (${chunks.length} chunks)`)
    })

    it('askStream yields text', async () => {
      const parts: string[] = []
      for await (const text of client.askStream('Say hello', { model: 'gpt-4o-mini', maxTokens: 10 })) {
        parts.push(text)
      }
      expect(parts.length).toBeGreaterThan(0)
      console.log(`  askStream: "${parts.join('')}" (${parts.length} parts)`)
    })
  })

  describe('credits', () => {
    it('returns credit balance', async () => {
      const credits = await client.credits()
      expect(typeof credits.balance).toBe('number')
      console.log(`  Balance: $${credits.balance}`)
    })
  })

  describe('cost estimation', () => {
    it('estimates cost for a request', async () => {
      const estimate = await client.estimateCost({
        model: 'gpt-4o-mini',
        inputTokens: 1000,
        outputTokens: 500,
      })
      expect(estimate.total).toBeGreaterThan(0)
      console.log(`  Estimated: $${estimate.total.toFixed(6)} (in: $${estimate.inputCost.toFixed(6)}, out: $${estimate.outputCost.toFixed(6)})`)
    })
  })

  describe('providerOptions pass-through', () => {
    it('works with response_format json_object', async () => {
      const result = await client.chat({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Respond in JSON only' },
          { role: 'user', content: 'Return {"status":"ok"}' },
        ],
        responseFormat: { type: 'json_object' },
        maxTokens: 20,
      })
      const content = result.choices[0].message.content
      expect(() => JSON.parse(content)).not.toThrow()
      console.log(`  JSON response: ${content}`)
    })
  })

  describe('retry behavior', () => {
    it('handles rate limits gracefully (no 429 expected, but retry config is set)', () => {
      // This test just validates the client was configured with retry
      const cfg = (client as any).retryConfig
      expect(cfg).toBeTruthy()
      expect(cfg.maxRetries).toBe(2)
      expect(cfg.retryableStatuses).toContain(429)
    })
  })
})
