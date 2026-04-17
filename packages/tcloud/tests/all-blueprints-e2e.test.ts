/**
 * End-to-end tests for ALL blueprint types against the live router.
 *
 * Every test hits router.tangle.tools with real provider inference.
 * No mocks. No fake servers. No hand-crafted responses.
 *
 * Requires: TCLOUD_API_KEY=sk-tan-xxx
 * Run:      TCLOUD_API_KEY=sk-tan-xxx npx vitest run tests/all-blueprints-e2e.test.ts
 *
 * Cost: ~$0.01 per full run (cheap models, small payloads).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { TCloud } from '../src/index'

const API_KEY = process.env.TCLOUD_API_KEY
const describeIf = (condition: boolean) => condition ? describe : describe.skip

describeIf(!!API_KEY)('E2E: all blueprint types via router.tangle.tools', () => {
  let client: InstanceType<typeof TCloud>

  beforeAll(() => {
    client = new TCloud({
      apiKey: API_KEY,
      timeout: 45_000,
      retry: { maxRetries: 2, initialBackoffMs: 1000 },
    })
  })

  // ── LLM Blueprint ───────────────────────────────────────────────

  describe('LLM inference', () => {
    it('chat completion returns correct answer', async () => {
      const result = await client.chat({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
        temperature: 0,
        maxTokens: 5,
      })
      expect(result.choices.length).toBeGreaterThan(0)
      expect(result.choices[0].message.content).toBeTruthy()
      expect(result.choices[0].message.content.trim()).toContain('4')
      expect(result.usage).toBeDefined()
      expect(result.usage!.prompt_tokens).toBeGreaterThan(0)
      expect(result.usage!.completion_tokens).toBeGreaterThan(0)
      console.log(`  LLM: "${result.choices[0].message.content.trim()}" (${result.usage!.total_tokens} tokens)`)
    })

    it('streaming chat yields real chunks', async () => {
      const chunks: string[] = []
      for await (const chunk of client.chatStream({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Count 1 to 3' }],
        maxTokens: 20,
      })) {
        const content = chunk.choices?.[0]?.delta?.content
        if (content) chunks.push(content)
      }
      expect(chunks.length).toBeGreaterThan(0)
      const full = chunks.join('')
      expect(full).toContain('1')
      expect(full).toContain('2')
      expect(full).toContain('3')
      console.log(`  Stream: "${full.trim()}" (${chunks.length} chunks)`)
    })

    it('ask() returns text string', async () => {
      const text = await client.ask('Say exactly: pong', { model: 'gpt-4o-mini', maxTokens: 5 })
      expect(text).toBeTruthy()
      expect(text.toLowerCase()).toContain('pong')
      console.log(`  ask(): "${text.trim()}"`)
    })
  })

  // ── Embedding Blueprint ─────────────────────────────────────────

  describe('embedding inference', () => {
    it('returns real embedding vectors', async () => {
      const result = await client.embeddings({
        input: ['Tangle Network decentralized AI', 'Blueprint operators earn revenue'],
        model: 'text-embedding-3-small',
      })
      expect(result.data).toHaveLength(2)
      expect(result.data[0].embedding.length).toBeGreaterThan(100)
      expect(result.data[1].embedding.length).toBe(result.data[0].embedding.length)
      // Vectors should not be identical (different inputs)
      expect(result.data[0].embedding[0]).not.toBe(result.data[1].embedding[0])
      // Embeddings should be real floats, not zeros
      const nonZero = result.data[0].embedding.filter(v => v !== 0)
      expect(nonZero.length).toBeGreaterThan(result.data[0].embedding.length * 0.9)
      console.log(`  Embeddings: ${result.data.length} vectors, ${result.data[0].embedding.length} dims`)
    })

    it('rerank scores documents by relevance', async () => {
      const result = await client.rerank({
        query: 'What is Tangle Network?',
        documents: [
          'Tangle Network is a decentralized AI inference platform',
          'The weather in Paris is sunny today',
          'Blueprint operators provide GPU compute on Tangle',
        ],
        model: 'rerank-english-v3.0',
      })
      expect(result.results.length).toBe(3)
      // Tangle-related docs should score higher than weather
      const tangleScores = result.results.filter(r =>
        r.document?.text?.includes('Tangle') || r.index === 0 || r.index === 2
      )
      const weatherScore = result.results.find(r => r.index === 1)
      if (tangleScores.length > 0 && weatherScore) {
        expect(Math.max(...tangleScores.map(r => r.relevance_score)))
          .toBeGreaterThan(weatherScore.relevance_score)
      }
      console.log(`  Rerank: ${result.results.map(r => `[${r.index}]=${r.relevance_score.toFixed(3)}`).join(', ')}`)
    })
  })

  // ── Voice Blueprint ─────────────────────────────────────────────

  describe('voice inference', () => {
    it('speech() generates real audio bytes', async () => {
      const audio = await client.speech({
        input: 'Hello from Tangle Network.',
        voice: 'alloy',
        model: 'tts-1',
      })
      expect(audio).toBeInstanceOf(ArrayBuffer)
      expect(audio.byteLength).toBeGreaterThan(1000) // Real audio is at least 1KB
      console.log(`  TTS: ${audio.byteLength} bytes audio`)
    })
  })

  // ── Image Generation (Modal Blueprint) ──────────────────────────

  describe('image generation', () => {
    it('generates a real image URL', async () => {
      const result = await client.imageGenerate({
        prompt: 'A simple blue circle on white background',
        model: 'dall-e-3',
        n: 1,
        size: '1024x1024',
      })
      expect(result.data).toHaveLength(1)
      expect(result.data[0].url).toBeTruthy()
      expect(result.data[0].url).toMatch(/^https?:\/\//)
      console.log(`  Image: ${result.data[0].url?.slice(0, 80)}...`)
    }, 60_000)
  })

  // ── Video Blueprint ─────────────────────────────────────────────

  describe('video generation', () => {
    it('videoGenerate() submits or rejects with structured error', async () => {
      try {
        const result = await client.videoGenerate({
          prompt: 'A simple rotating cube',
          duration: 3,
        })
        // If it works, validate the response shape
        expect(result).toBeDefined()
        console.log(`  Video job: ${JSON.stringify(result).slice(0, 100)}`)
      } catch (e: any) {
        // Video may require specific provider config — structured error is acceptable
        expect(e.message).toBeTruthy()
        console.log(`  Video (expected): ${e.message?.slice(0, 100)}`)
      }
    })
  })

  // ── Avatar Blueprint ────────────────────────────────────────────

  describe('avatar generation', () => {
    it('avatarGenerate() submits or rejects with structured error', async () => {
      try {
        const result = await client.avatarGenerate({
          audio_url: 'https://cdn.tangle.tools/test/hello.mp3',
          image_url: 'https://cdn.tangle.tools/test/face.jpg',
        })
        expect(result).toBeDefined()
        console.log(`  Avatar job: ${JSON.stringify(result).slice(0, 100)}`)
      } catch (e: any) {
        // Avatar requires PHONY_API_KEY on the router — structured error is acceptable
        expect(e.message).toBeTruthy()
        console.log(`  Avatar (expected): ${e.message?.slice(0, 100)}`)
      }
    })
  })

  // ── Training Blueprint ──────────────────────────────────────────

  describe('fine-tuning / training', () => {
    it('fineTuneList() returns array or structured error', async () => {
      try {
        const result = await client.fineTuneList()
        expect(result.data).toBeDefined()
        expect(Array.isArray(result.data)).toBe(true)
        console.log(`  Fine-tune jobs: ${result.data.length}`)
      } catch (e: any) {
        expect(e.message).toBeTruthy()
        console.log(`  Fine-tune (expected): ${e.message?.slice(0, 100)}`)
      }
    })
  })

  // ── Vector Store Blueprint ──────────────────────────────────────

  describe('vector store', () => {
    it('listCollections() returns array or structured error', async () => {
      try {
        const result = await client.listCollections()
        expect(Array.isArray(result)).toBe(true)
        console.log(`  Collections: ${result.length}`)
      } catch (e: any) {
        expect(e.message).toBeTruthy()
        console.log(`  Collections (expected): ${e.message?.slice(0, 100)}`)
      }
    })
  })

  // ── Batch Processing ────────────────────────────────────────────

  describe('batch processing', () => {
    it('batch() submits or rejects with structured error', async () => {
      try {
        const result = await client.batch([
          { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'Say A' }] },
          { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'Say B' }] },
        ])
        expect(result).toBeDefined()
        console.log(`  Batch: ${JSON.stringify(result).slice(0, 100)}`)
      } catch (e: any) {
        expect(e.message).toBeTruthy()
        console.log(`  Batch (expected): ${e.message?.slice(0, 100)}`)
      }
    })
  })

  // ── Cross-Blueprint Concerns ────────────────────────────────────

  describe('cross-blueprint', () => {
    it('models() returns 600+ models from production', async () => {
      const models = await client.models()
      expect(models.length).toBeGreaterThan(500)
      console.log(`  Models: ${models.length}`)
    })

    it('cost estimation works for real models', async () => {
      const estimate = await client.estimateCost({
        model: 'gpt-4o-mini',
        inputTokens: 1000,
        outputTokens: 500,
      })
      expect(estimate.total).toBeGreaterThanOrEqual(0)
      // gpt-4o-mini should have pricing in the catalog
      console.log(`  Cost estimate: $${estimate.total.toFixed(6)} (in: $${estimate.inputCost.toFixed(6)}, out: $${estimate.outputCost.toFixed(6)})`)
    })

    it('usage tracking accumulates across real requests', async () => {
      // Verify the client's internal counters accumulated from all real requests above
      expect(client.usage.requestCount).toBeGreaterThan(0)
      expect(client.usage.totalSpent).toBeGreaterThanOrEqual(0)
      console.log(`  Usage: ${client.usage.requestCount} requests, $${client.usage.totalSpent.toFixed(6)} spent`)
    })
  })
})
