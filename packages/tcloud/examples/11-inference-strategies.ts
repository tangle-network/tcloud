/**
 * Inference strategies: RSA, MoA, Best-of-N
 *
 * Population-based quality amplification through the Tangle Router.
 * These strategies generate multiple candidates in parallel and refine
 * or score them to produce a higher-quality answer than a single call.
 */
import { TCloud } from '@tangle-network/tcloud'

const t = new TCloud({ apiKey: process.env.TANGLE_API_KEY! })

// --- RSA: Opus-quality reasoning at Flash prices ---
// Generate 16 candidates, aggregate 4 at a time, refine over 5 rounds
const rsa = await t.chat({
  model: 'google/gemini-2.5-flash',
  messages: [{ role: 'user', content: 'Prove that sqrt(2) is irrational.' }],
  gateway: {
    rsa: { n: 16, k: 4, t: 5 },
  },
})
console.log('RSA:', rsa.choices[0].message.content)

// --- MoA: cross-model diversity ---
// 4 different models generate candidates, Claude aggregates
const moa = await t.chat({
  model: 'anthropic/claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Design a rate limiter for a distributed system.' }],
  gateway: {
    rsa: {
      n: 4,
      k: 3,
      t: 2,
      models: [
        'anthropic/claude-sonnet-4-6',
        'google/gemini-2.5-flash',
        'openai/gpt-4o',
        'deepseek/deepseek-chat',
      ],
    },
  },
})
console.log('MoA:', moa.choices[0].message.content)

// --- Best-of-N with LLM judge ---
// 5 candidates, scored by a cheap model, winner returned
const bon = await t.chat({
  model: 'anthropic/claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Write a TypeScript debounce function.' }],
  gateway: {
    bestOfN: {
      n: 5,
      scorer: {
        type: 'llm',
        model: 'google/gemini-2.5-flash',
        prompt: 'Score this code for correctness, type safety, and edge case handling. Return {"score": 0-100, "reason": "..."}',
      },
    },
  },
})
console.log('Best-of-N:', bon.choices[0].message.content)

// --- Best-of-N with webhook scorer ---
// Your CF Worker evaluates candidates with custom logic
const bonWebhook = await t.chat({
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'Generate a SQL query to find duplicate customers.' }],
  gateway: {
    bestOfN: {
      n: 4,
      scorer: {
        type: 'webhook',
        url: 'https://my-scorer.my-domain.workers.dev',
        timeout: 5000,
      },
    },
  },
})
console.log('Best-of-N (webhook):', bonWebhook.choices[0].message.content)

// --- Shortcut: optimize: 'quality' auto-enables RSA ---
const quality = await t.chat({
  model: 'google/gemini-2.5-flash',
  messages: [{ role: 'user', content: 'Explain monads in 3 sentences.' }],
  gateway: { optimize: 'quality' },
})
console.log('Quality mode:', quality.choices[0].message.content)
