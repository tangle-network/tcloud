import { describe, expect, it } from 'vitest'
import { TCloud } from '../src'
import {
  formatModelNotAllowedRefusal,
  parseModelNotAllowed,
  resolveModelWithinAllowList,
} from '../src/decisions'

/**
 * Live e2e for the decision surfaces and key scope against the production
 * router. Gated by TCLOUD_LIVE_DECISIONS_E2E=1 with TCLOUD_API_KEY set —
 * the whole suite costs a fraction of a cent (decisions bills input-only;
 * the spec fixture is ~42 tokens at $0.10/M).
 */
const enabled = process.env.TCLOUD_LIVE_DECISIONS_E2E === '1'
const describeLive = enabled ? describe : describe.skip

const client = enabled
  ? new TCloud({ apiKey: process.env.TCLOUD_API_KEY! })
  : (undefined as unknown as TCloud)

const DECISION_MODEL = process.env.TCLOUD_DECISION_MODEL ?? 'gpt-6-luna'

describeLive('POST /v1/decisions — the native OpenAI wire, live', () => {
  it('answers the spec example with receipts (predicate probability + input-only usage)', async () => {
    const { decision, receipts } = await client.decisions.create({
      model: DECISION_MODEL,
      input: 'The package arrived with a broken screen.',
      questions: [
        { type: 'predicate', name: 'damaged', instructions: 'Does the customer report a damaged item?' },
      ],
    })
    expect(decision.model).toBe(DECISION_MODEL)
    const damaged = decision.answers[0]
    expect(damaged?.type).toBe('predicate')
    if (damaged?.type === 'predicate') {
      expect(damaged.probability).toBeGreaterThan(0.5)
      expect(damaged.name).toBe('damaged')
    }
    expect(decision.usage.input_tokens).toBeGreaterThan(0)
    expect(decision.usage.output_tokens).toBe(0)
    expect(receipts.generationId).toBeTruthy()
    expect(receipts.costUsd).not.toBeNull()
    expect(receipts.costUsd!).toBeLessThan(0.001)
    expect(receipts.providerCostUsd).toBeCloseTo(receipts.costUsd! / 1.2, 5)
  }, 60_000)

  it('answers all three question types in one request, in order', async () => {
    const { decision } = await client.decisions.create({
      model: DECISION_MODEL,
      input: 'Customer writes: the box arrived soaked and two units are dead. Wants a refund, mentions the courier left it in the rain.',
      questions: [
        { type: 'predicate', name: 'water_damage', instructions: 'Does the customer report water damage?' },
        { type: 'choice', name: 'action', instructions: 'Choose the right first response.',
          choices: [{ value: 'refund' }, { value: 'replacement' }, { value: 'deny' }] },
        { type: 'score', name: 'severity', instructions: 'Rate the case severity.',
          levels: [{ label: 'low' }, { label: 'medium' }, { label: 'high' }] },
      ],
    })
    expect(decision.answers).toHaveLength(3)
    expect(decision.answers.map((a) => a.name)).toEqual(['water_damage', 'action', 'severity'])
    const action = decision.answers[1]
    if (action?.type === 'choice') {
      expect(['refund', 'replacement', 'deny']).toContain(action.choice)
      const total = action.probabilities.reduce((sum, p) => sum + p.probability, 0)
      expect(total).toBeCloseTo(1, 1)
    }
  }, 60_000)

  it('replays an identical retry from the idempotent cache without re-charging', async () => {
    const idempotencyKey = `tcloud-e2e-${Date.now()}`
    const options = {
      model: DECISION_MODEL,
      input: 'The report ends with three actionable recommendations.',
      questions: [{ type: 'predicate' as const, name: 'actionable', instructions: 'Does the text contain actionable recommendations?' }],
      idempotencyKey,
    }
    const first = await client.decisions.create(options)
    const second = await client.decisions.create(options)
    expect(second.receipts.replayed).toBe(true)
    expect(second.decision.answers[0]).toEqual(first.decision.answers[0])
    expect(second.decision.usage).toEqual(first.decision.usage)
    if (first.receipts.costUsd !== null && second.receipts.costUsd !== null) {
      expect(second.receipts.costUsd).toBe(first.receipts.costUsd)
    }
  }, 60_000)

  it('refuses a non-decision model with the supported ids named', async () => {
    await expect(client.decisions.create({
      model: 'not-a-decision-model',
      input: 'x',
      questions: [{ type: 'predicate', instructions: 'y' }],
    })).rejects.toMatchObject({ status: 400 })
  }, 60_000)
})

describeLive('POST /v1/systemone — the fleet wire, live (via the OpenAI translation row)', () => {
  it('answers named noul questions by name, input-only, with receipts', async () => {
    const { result, receipts } = await client.systemone({
      model: 'openai/gpt-6-luna',
      state: 'The package arrived with a broken screen.',
      questions: {
        damaged: { type: 'noul', instructions: 'Does the customer report a damaged item?' },
      },
    })
    expect(result.model).toBe('openai/gpt-6-luna')
    const damaged = result.answers.damaged
    expect(damaged?.type).toBe('noul')
    if (damaged?.type === 'noul') expect(damaged.noul).toBeGreaterThan(0.5)
    expect(result.usage.output_tokens).toBe(0)
    expect(receipts.costUsd).not.toBeNull()
    expect(receipts.costUsd!).toBeLessThan(0.001)
  }, 60_000)

  it('answers score and choice questions with calibrated distributions', async () => {
    const { result } = await client.systemone({
      model: 'openai/gpt-6-luna',
      state: 'The filing cites 37 precedents, of which 31 support the motion; the opposing brief concedes the standard but disputes application.',
      questions: {
        strength: { type: 'score', instructions: 'How strong is the motion?', criteria: ['weak', 'moderate', 'strong'] },
        outcome: { type: 'choice', instructions: 'Predict the ruling.', criteria: { granted: null, denied: null } },
      },
    })
    const strength = result.answers.strength
    if (strength?.type === 'score') {
      expect(Object.keys(strength.probabilities)).toEqual(['0', '1', '2'])
      const total = Object.values(strength.probabilities).reduce((a, b) => a + b, 0)
      expect(total).toBeCloseTo(1, 1)
      expect(strength.legend).toEqual({ '0': 'weak', '1': 'moderate', '2': 'strong' })
    }
    const outcome = result.answers.outcome
    if (outcome?.type === 'choice') {
      expect(['granted', 'denied']).toContain(outcome.choice)
      expect(outcome.probabilities.granted + outcome.probabilities.denied).toBeCloseTo(1, 1)
    }
  }, 60_000)
})

describeLive('GET /v1/key — the key scope, live', () => {
  it('reads the live scope: allow-list shape, budgets, rate limit', async () => {
    const info = await client.keyInfo()
    expect(info.allowedModels === null || Array.isArray(info.allowedModels)).toBe(true)
    expect(info.rateLimitRequests === null || typeof info.rateLimitRequests === 'number').toBe(true)
    const allowed = await client.allowedModels({ refresh: true })
    expect(allowed).toEqual(info.allowedModels)
    if (info.allowedModels !== null) {
      const resolution = await client.resolveModel(info.allowedModels[0]!)
      expect(resolution.status).toBe('allowed')
    }
  }, 60_000)
})

// Pure utilities stay ungated — they pin against the router's refusal text.
describe('allow-list utilities (no network)', () => {
  it('the parse→resolve→format chain round-trips a live-shaped refusal', () => {
    const refusal = 'Model "gpt-6-luna" is not in this key\'s allow-list. Allowed: glm-5.3, glm-5-turbo.'
    const allowed = parseModelNotAllowed(refusal)!
    expect(allowed).toEqual(['glm-5.3', 'glm-5-turbo'])
    const rerouted = resolveModelWithinAllowList({ requested: 'gpt-6-luna', allowedModels: allowed, fallbacks: ['glm-5-turbo'] })
    expect(rerouted).toEqual({ status: 'rerouted', model: 'glm-5-turbo', rerouted: true, blockedModel: 'gpt-6-luna' })
    const refused = resolveModelWithinAllowList({ requested: 'gpt-6-luna', allowedModels: allowed, fallbacks: ['glm-5'] })
    expect(refused.status).toBe('refused')
    if (refused.status === 'refused') {
      expect(formatModelNotAllowedRefusal({ requested: 'gpt-6-luna', allowedModels: refused.allowedModels }))
        .toContain('Allowed: glm-5.3, glm-5-turbo.')
    }
  })
})
