/**
 * Decision-surface service group for {@link TCloudClient}: the native
 * OpenAI Decisions wire, the System One wire, and the key's own scope
 * (allow-list, budgets) with its per-client cache.
 * Internal module — the public surface is the client's methods.
 *
 * Two wires, one job (see src/decisions.ts): /v1/decisions is OpenAI's
 * native wire served verbatim (per-question refusals flow through);
 * /v1/systemone is the fleet's translated, strictly-validated wire. Both
 * are billable (input-only at the row's reviewed rate) and idempotent.
 */

import type { ClientContext } from './client-core'
import type {
  DecisionCreateOptions,
  DecisionReceipts,
  DecisionResponse,
  DecisionResult,
  KeyScopeInfo,
  SystemOneEvaluateOptions,
  SystemOneResult,
  SystemOneResultBody,
} from './decisions'

const ALLOWED_MODELS_TTL_MS = 5 * 60_000

/** Cost + identity receipts off a decision-surface response. */
function receiptsFrom(res: Response): DecisionReceipts {
  const num = (name: string): number | null => {
    const raw = res.headers.get(name)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return {
    generationId: res.headers.get('X-Generation-Id'),
    servedModel: res.headers.get('X-Tangle-Served-Model'),
    costUsd: num('X-Tangle-Cost-USD'),
    providerCostUsd: num('X-Tangle-Provider-Cost-USD'),
    maxCostUsd: num('X-Tangle-Max-Cost-USD'),
    replayed: res.headers.get('X-Idempotent-Replay') === 'true',
  }
}

export async function createDecision(ctx: ClientContext, options: DecisionCreateOptions): Promise<DecisionResult> {
  const headers: Record<string, string> = {}
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  if (options.maxCostUsd !== undefined) headers['X-Tangle-Max-Cost-USD'] = String(options.maxCostUsd)
  // Verbatim pass-through: only the model rides as a first-class field —
  // every OpenAI extension (prompt cache, safety id, item inputs) keeps
  // its native shape end to end.
  const body: Record<string, unknown> = {
    model: options.model,
    input: options.input,
    questions: options.questions,
    ...(options.safetyIdentifier !== undefined ? { safety_identifier: options.safetyIdentifier } : {}),
    ...(options.promptCacheKey !== undefined ? { prompt_cache_key: options.promptCacheKey } : {}),
  }
  const res = await ctx.requestWithResponse(`${ctx.baseURL}/decisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  })
  const decision = await res.json() as DecisionResponse
  return { decision, receipts: receiptsFrom(res) }
}

export async function systemone(ctx: ClientContext, options: SystemOneEvaluateOptions): Promise<SystemOneResult> {
  const headers: Record<string, string> = {}
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
  if (options.maxCostUsd !== undefined) headers['X-Tangle-Max-Cost-USD'] = String(options.maxCostUsd)
  const res = await ctx.requestWithResponse(`${ctx.baseURL}/systemone`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: options.model,
      state: options.state,
      questions: options.questions,
    }),
    signal: options.signal,
  })
  const result = await res.json() as SystemOneResultBody
  return { result, receipts: receiptsFrom(res) }
}

export async function keyInfo(ctx: ClientContext): Promise<KeyScopeInfo> {
  const raw = await ctx.fetch<{ data: Record<string, unknown> }>(`${ctx.baseURL}/key`)
  const data = raw?.data ?? {}
  const allowed = data.allowed_models
  const usage = (data.usage ?? {}) as Record<string, unknown>
  const monthly = Number(usage.monthly ?? 0)
  const remaining = typeof data.limit_remaining === 'number' ? data.limit_remaining : null
  return {
    allowedModels: Array.isArray(allowed) && allowed.length > 0 ? (allowed as string[]) : null,
    limit: typeof data.limit === 'number' ? data.limit : null,
    limitRemaining: remaining,
    limitReset: data.limit_reset === 'monthly' ? 'monthly' : null,
    rateLimitRequests: typeof data.rate_limit === 'object' && data.rate_limit !== null
      ? typeof (data.rate_limit as { requests?: unknown }).requests === 'number'
        ? (data.rate_limit as { requests: number }).requests
        : null
      : null,
    expiresAt: typeof data.expires_at === 'string' ? data.expires_at : null,
  }
}

/** One client's cached allow-list; `refresh` forces a re-read. */
export class AllowedModelsCache {
  private entry: { models: string[] | null; at: number } | null = null

  async get(loadKeyInfo: () => Promise<KeyScopeInfo>, refresh = false): Promise<string[] | null> {
    const now = Date.now()
    if (!refresh && this.entry && now - this.entry.at < ALLOWED_MODELS_TTL_MS) {
      return this.entry.models
    }
    const info = await loadKeyInfo()
    this.entry = { models: info.allowedModels, at: now }
    return info.allowedModels
  }
}
