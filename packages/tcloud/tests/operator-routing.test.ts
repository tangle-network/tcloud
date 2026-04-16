/**
 * Operator routing tests — verify the tcloud SDK correctly sends
 * X-Tangle-* headers and the router processes them.
 *
 * These tests verify:
 * 1. SDK attaches routing headers when configured
 * 2. Router correctly rejects requests to non-existent services/blueprints
 * 3. Router returns structured errors for invalid routing
 *
 * Requires: TCLOUD_API_KEY=sk-tan-xxx
 * Run: TCLOUD_API_KEY=sk-tan-xxx npx vitest run tests/operator-routing.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { TCloud } from '../src/index'

const API_KEY = process.env.TCLOUD_API_KEY
const describeIf = (condition: boolean) => condition ? describe : describe.skip

describeIf(!!API_KEY)('operator routing via tcloud SDK', () => {
  describe('non-existent service/blueprint returns structured error', () => {
    it('serviceId that does not exist returns "not available" error', async () => {
      const client = new TCloud({
        apiKey: API_KEY,
        routing: { serviceId: '99999' },
        timeout: 15_000,
        retry: false,
      })

      await expect(
        client.chat({
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: 'test' }],
          maxTokens: 5,
        })
      ).rejects.toThrow(/not available|no operators/i)
    })

    it('blueprintId that does not exist returns structured error', async () => {
      const client = new TCloud({
        apiKey: API_KEY,
        routing: { blueprintId: '99999' },
        timeout: 15_000,
        retry: false,
      })

      await expect(
        client.chat({
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: 'test' }],
          maxTokens: 5,
        })
      ).rejects.toThrow(/no operators|not available/i)
    })

    it('non-existent operator address returns error', async () => {
      const client = new TCloud({
        apiKey: API_KEY,
        routing: {
          mode: 'operator',
          prefer: '0x0000000000000000000000000000000000000000',
        },
        timeout: 15_000,
        retry: false,
      })

      await expect(
        client.chat({
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: 'test' }],
          maxTokens: 5,
        })
      ).rejects.toThrow()
    })

    it('embedding with non-existent service returns error', async () => {
      const client = new TCloud({
        apiKey: API_KEY,
        routing: { serviceId: '99999' },
        timeout: 15_000,
        retry: false,
      })

      await expect(
        client.embeddings({
          model: 'openai/text-embedding-3-small',
          input: 'test',
        })
      ).rejects.toThrow(/not available|no operators/i)
    })
  })

  describe('without routing headers, requests work normally', () => {
    it('chat without routing goes to provider', async () => {
      const client = new TCloud({
        apiKey: API_KEY,
        timeout: 30_000,
      })

      const result = await client.chat({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say "routing bypass ok"' }],
        maxTokens: 10,
      })

      expect(result.choices.length).toBeGreaterThan(0)
      expect(result.choices[0].message.content).toBeTruthy()
    })
  })
})
