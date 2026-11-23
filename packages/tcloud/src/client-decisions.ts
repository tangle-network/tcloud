import { defineService } from './client-service'
import {
  resolveModelWithinAllowList,
  type DecisionCreateOptions,
  type DecisionResponse,
  type DecisionResult,
  type DecisionReceipts,
  type KeyScopeInfo,
  type ModelWithinAllowListResolution,
  type SystemOneEvaluateOptions,
  type SystemOneResult,
  type SystemOneResultBody,
} from './decisions'

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

const ALLOWED_MODELS_TTL_MS = 5 * 60_000

export function createDecisions(request: (path: string, init: RequestInit) => Promise<Response>) {
  return {
    create: async (options: DecisionCreateOptions): Promise<DecisionResult> => {
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
      const res = await request('/decisions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
      const decision = await res.json() as DecisionResponse
      return { decision, receipts: receiptsFrom(res) }
    },
  }
}

export const decisionMethods = defineService({
  /** The System One wire (fleet judges): state + named questions, answers by name. */
  async systemone(options: SystemOneEvaluateOptions): Promise<SystemOneResult> {
    const headers: Record<string, string> = {}
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
    if (options.maxCostUsd !== undefined) headers['X-Tangle-Max-Cost-USD'] = String(options.maxCostUsd)
    const res = await this._requestWithResponse(`${this.baseURL}/systemone`, {
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
  },

  /**
   * This key's own scope, live: `GET /v1/key` — the allow-list in its
   * positive form (null = unscoped), budgets, rate limit, expiry. Scoped
   * callers route within `allowedModels` BEFORE a first refusal.
   */
  async keyInfo(): Promise<KeyScopeInfo> {
    const raw = await this._fetch<{ data: Record<string, unknown> }>(`${this.baseURL}/key`)
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
  },

  /**
   * The key's model allow-list (null when unscoped), cached five minutes.
   * `refresh: true` forces a re-read — key rotations and allow-list edits
   * land here first.
   */
  async allowedModels(options: { refresh?: boolean } = {}): Promise<string[] | null> {
    const now = Date.now()
    if (!options.refresh && this._allowedModelsCache && now - this._allowedModelsCache.at < ALLOWED_MODELS_TTL_MS) {
      return this._allowedModelsCache.models
    }
    const info = await this.keyInfo()
    this._allowedModelsCache = { models: info.allowedModels, at: now }
    return info.allowedModels
  },

  /**
   * Resolve a model request against this key's allow-list (live, cached):
   * permitted → `{status:'allowed'}`; a permitted fallback → rerouted with
   * the blocked model named; nothing permitted → refused carrying the set —
   * never a silent downgrade. Throws nothing; callers surface `refused`
   * with `formatModelNotAllowedRefusal`.
   */
  async resolveModel(requested: string, options: { fallbacks?: readonly string[]; refresh?: boolean } = {}): Promise<ModelWithinAllowListResolution> {
    const allowedModels = await this.allowedModels({ refresh: options.refresh })
    return resolveModelWithinAllowList({ requested, allowedModels, fallbacks: options.fallbacks })
  },
})
