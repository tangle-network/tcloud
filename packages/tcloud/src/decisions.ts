/**
 * Decision surfaces and key-scope utilities — the client half of the
 * router's decision-model features.
 *
 * Two wires, one job (structured judgment):
 *
 *  - **Decisions** (`POST /v1/decisions`) — OpenAI's native wire, served
 *    verbatim by Router: `input` + up to 200 typed questions
 *    (`predicate` / `choice` / `score`), answers in question order, any
 *    question may answer `refusal` instead. The request body passes through
 *    byte-for-byte (only `model` is rewritten upstream), so every OpenAI
 *    field — `prompt_cache_key`, `prompt_cache_options`, `safety_identifier`,
 *    item-array inputs — keeps native semantics. Use this surface when the
 *    caller is OpenAI-SDK-shaped.
 *
 *  - **System One** (`POST /v1/systemone`) — the fleet's decision wire
 *    (TypeSafe-originated; agent-eval's `systemone/protocol` owns the
 *    canonical contract): `state` + named `noul`/`score`/`choice` questions,
 *    answers keyed by name, strict validation, calibrated profiles. OpenAI's
 *    row is served through a translation; per-question refusals fail the
 *    whole evaluation rather than silently answering fewer questions. Use
 *    this surface for judges and policy machinery.
 *
 * Both carry the router rails: durable idempotent replay, `X-Tangle-Max-Cost-USD`
 * limits, and `X-Tangle-Cost-USD` receipts. Billing is input-only at the
 * row's reviewed rate (the spec's own example bills `output_tokens: 0`).
 */

// ── Decisions: the OpenAI wire (mirrors openai/openai-openapi createDecision) ──

/** A typed question. `instructions` is required by the API. */
export type DecisionQuestion =
  | { type: 'predicate'; name?: string; instructions: string }
  | { type: 'choice'; name?: string; instructions: string; choices: Array<{ value: string | boolean; description?: string }> }
  | { type: 'score'; name?: string; instructions: string; levels: Array<{ label: string; description?: string }> }

/** One answer per question, in order; any question may answer refusal instead. */
export type DecisionAnswer =
  | { type: 'predicate'; name: string | null; probability: number }
  | { type: 'choice'; name: string | null; choice: string | boolean; probabilities: Array<{ value: string | boolean; probability: number }>; confidence: number }
  | { type: 'score'; name: string | null; score: number; probabilities: Array<{ value: number; label: string; probability: number }>; confidence: number }
  | { type: 'refusal'; name: string | null }

export interface DecisionUsage {
  input_tokens: number
  input_tokens_details?: { cached_tokens: number; cache_write_tokens: number }
  output_tokens: number
  output_tokens_details?: { reasoning_tokens: number }
  total_tokens: number
}

/** `POST /v1/decisions` request. Extra OpenAI fields ride along verbatim. */
export interface DecisionCreateOptions {
  model: string
  input: string | ReadonlyArray<Record<string, unknown>>
  questions: ReadonlyArray<DecisionQuestion>
  /** Opaque caller-scoped end-user identifier (≤128 chars). */
  safetyIdentifier?: string
  /** Partition prompt-cache reuse by caller key (≤64 chars). */
  promptCacheKey?: string
  /** Retry safety: identical key + body replays the settled outcome. */
  idempotencyKey?: string
  /** Per-call cost ceiling (USD); the router refuses above it (402). */
  maxCostUsd?: number
  signal?: AbortSignal
}

export interface DecisionResponse {
  model: string
  answers: DecisionAnswer[]
  usage: DecisionUsage
}

/** Cost + identity receipts from the router, beside the answer. */
export interface DecisionReceipts {
  generationId: string | null
  servedModel: string | null
  costUsd: number | null
  providerCostUsd: number | null
  maxCostUsd: number | null
  replayed: boolean
}

export interface DecisionResult {
  decision: DecisionResponse
  receipts: DecisionReceipts
}

// ── System One: the fleet wire (canonical owner: @tangle-network/agent-eval
//    systemone/protocol; these local types mirror it so the SDK stays
//    dependency-free) ──

export type SystemOneState = string | Record<string, unknown> | ReadonlyArray<unknown>

export type SystemOneQuestion =
  | { type: 'noul'; instructions?: string | SystemOneState | null; criteria?: { true?: string | SystemOneState | null; false?: string | SystemOneState | null } | null }
  | { type: 'score'; instructions?: string | SystemOneState | null; criteria: ReadonlyArray<string | SystemOneState> }
  | { type: 'choice'; instructions?: string | SystemOneState | null; criteria: Record<string, string | SystemOneState | null> }

export type SystemOneAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number; legend: Record<string, unknown>; probabilities: Record<string, number> }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }

export interface SystemOneEvaluateOptions {
  /** A System One row id or bare id (e.g. `openai/gpt-6-luna`, `jev-1.13.0`). */
  model: string
  state: SystemOneState
  questions: Record<string, SystemOneQuestion>
  idempotencyKey?: string
  maxCostUsd?: number
  signal?: AbortSignal
}

export interface SystemOneResultBody {
  model: string
  answers: Record<string, SystemOneAnswer>
  usage: { input_tokens: number; output_tokens: number }
}

export interface SystemOneResult {
  result: SystemOneResultBody
  receipts: DecisionReceipts
}

// ── Key scope: the allow-list's positive form (GET /v1/key) ──

export interface KeyScopeInfo {
  /** The key's model allow-list, or null when the key is unscoped. A scoped
   *  caller routes within this set BEFORE its first refusal. */
  allowedModels: string[] | null
  limit: number | null
  limitRemaining: number | null
  limitReset: 'monthly' | null
  rateLimitRequests: number | null
  expiresAt: string | null
}

/** Parse the allowed-model set out of a router `model_not_allowed` refusal —
 *  both refusal shapes name it after `Allowed:`. Null when the message
 *  carries no set (an unexpected shape; do not guess). */
export function parseModelNotAllowed(message: string): string[] | null {
  const match = /Allowed:\s*([^\n]+?)(?:\.\s*)?$/.exec(message)
  if (!match?.[1]) return null
  const allowed = match[1].split(',').map((id) => id.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  return allowed.length > 0 ? allowed : null
}

export type ModelWithinAllowListResolution =
  | { status: 'allowed'; model: string; rerouted: false }
  | { status: 'rerouted'; model: string; rerouted: true; blockedModel: string }
  | { status: 'refused'; model: null; allowedModels: readonly string[] }

/** Resolve a model request against a key's allow-list: unscoped or permitted
 *  → allowed; a permitted fallback → rerouted (the blocked model named);
 *  nothing permitted → refused with the set (fail loud, never silently
 *  downgrade — a different model is a different decision-maker). */
export function resolveModelWithinAllowList(input: {
  requested: string
  allowedModels?: readonly string[] | null
  fallbacks?: readonly string[]
}): ModelWithinAllowListResolution {
  const allowed = input.allowedModels
  if (!allowed || allowed.length === 0) return { status: 'allowed', model: input.requested, rerouted: false }
  if (allowed.includes(input.requested)) return { status: 'allowed', model: input.requested, rerouted: false }
  const fallback = (input.fallbacks ?? []).find((id) => allowed.includes(id))
  if (fallback !== undefined) return { status: 'rerouted', model: fallback, rerouted: true, blockedModel: input.requested }
  return { status: 'refused', model: null, allowedModels: allowed }
}

/** The loud, correctable refusal: blocked model, allowed set, the fix. */
export function formatModelNotAllowedRefusal(input: { requested: string; allowedModels: readonly string[] }): string {
  return (
    `Model "${input.requested}" is not in this key's allow-list. `
    + `Allowed: ${input.allowedModels.join(', ')}. `
    + 'Route to an allowed model or widen the key\u2019s allow-list.'
  )
}

// ── Budget-derived delegated mint ──
//
// The platform RESERVES a child key's budget against its parent's REMAINING:
// an ask above remaining is a hard refusal, and a flat default silently
// breaks every workspace whose parent holds less (proven live 2026-10-09:
// parent $5 → ask $5 ok / $25 refused on every mint). Canonical owner:
// @tangle-network/agent-app ./spend; vendored here so SDK consumers without
// the app shell get the same contract.

export const MIN_CHILD_KEY_BUDGET_USD = 0.5

/** The source key is exhausted — correctable, both numbers on the error. */
export class ParentBudgetExhaustedError extends Error {
  readonly requestedUsd: number
  readonly parentRemainingUsd: number
  constructor(requestedUsd: number, parentRemainingUsd: number) {
    super(
      `workspace source key has no budget remaining ($${parentRemainingUsd.toFixed(2)}) — `
      + `top up or raise its cap before sandbox turns (the mint would have asked $${requestedUsd.toFixed(2)})`,
    )
    this.name = 'ParentBudgetExhaustedError'
    this.requestedUsd = requestedUsd
    this.parentRemainingUsd = parentRemainingUsd
  }
}

/** Derive a child key's budget ask from the parent's remaining budget:
 *  unknown parent → the configured ask stands; exhausted → correctable
 *  error before any mint; otherwise max(min, min(requested, floor-to-cents
 *  remaining)). Never above a known remaining, never below the platform
 *  minimum. */
export function deriveChildBudgetUsd(input: {
  requestedUsd: number
  parentRemainingUsd?: number | null
  minChildUsd?: number
}): number {
  const minChildUsd = input.minChildUsd ?? MIN_CHILD_KEY_BUDGET_USD
  if (!Number.isFinite(input.requestedUsd) || input.requestedUsd <= 0) {
    throw new Error(`deriveChildBudgetUsd: requestedUsd must be a finite positive USD amount (got ${input.requestedUsd})`)
  }
  const ceiling = input.parentRemainingUsd
  if (!(typeof ceiling === 'number' && Number.isFinite(ceiling))) return input.requestedUsd
  if (ceiling <= 0) throw new ParentBudgetExhaustedError(input.requestedUsd, ceiling)
  return Math.max(minChildUsd, Math.min(input.requestedUsd, Math.floor(ceiling * 100) / 100))
}
