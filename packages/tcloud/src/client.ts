/**
 * Core HTTP client for Tangle AI Cloud.
 * Shared between CLI and SDK.
 */

import type {
  TCloudConfig,
  PrivacyConfig,
  SpendingLimits,
  ChatOptions,
  ChatCompletion,
  ChatCompletionChunk,
  Model,
  Operator,
  CreditBalance,
  SpendAuth,
} from './types'

const DEFAULT_BASE_URL = 'https://api.tangleai.cloud/v1'

/**
 * Route a fetch call through the configured privacy proxy.
 * - direct: standard fetch
 * - relayer: POST to relayer's /relay/proxy or /relay/proxy-stream
 * - socks5: fetch via SOCKS5 proxy agent (requires socks-proxy-agent peer dep)
 */
async function proxiedFetch(
  privacy: PrivacyConfig | undefined,
  url: string,
  init: RequestInit,
  streaming: boolean,
): Promise<Response> {
  if (!privacy || privacy.mode === 'direct') {
    return fetch(url, init)
  }

  if (privacy.mode === 'relayer') {
    if (!privacy.relayerUrl) {
      throw new Error('relayerUrl is required when privacy mode is "relayer"')
    }
    const proxyPath = streaming ? '/relay/proxy-stream' : '/relay/proxy'
    // Extract headers as plain object for the relay payload
    const hdrs: Record<string, string> = {}
    if (init.headers) {
      const entries = init.headers instanceof Headers
        ? Array.from(init.headers.entries())
        : Object.entries(init.headers as Record<string, string>)
      for (const [k, v] of entries) hdrs[k] = v
    }
    return fetch(`${privacy.relayerUrl}${proxyPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: url,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
        headers: hdrs,
      }),
    })
  }

  if (privacy.mode === 'socks5') {
    if (!privacy.socksProxy) {
      throw new Error('socksProxy is required when privacy mode is "socks5"')
    }
    // socks-proxy-agent is an optional peer dependency — install it to use socks5 mode
    // @ts-ignore — optional peer dependency
    const { SocksProxyAgent } = await import('socks-proxy-agent') as { SocksProxyAgent: new (url: string) => unknown }
    const agent = new SocksProxyAgent(privacy.socksProxy)
    return fetch(url, {
      ...init,
      // @ts-expect-error agent is supported by Node's undici but not in the standard RequestInit type
      agent,
    })
  }

  return fetch(url, init)
}

export class TCloudClient {
  readonly baseURL: string
  readonly apiKey?: string
  readonly model: string
  private headers: Record<string, string>
  private spendAuthFn?: () => Promise<SpendAuth>
  private privacy?: PrivacyConfig
  private limits?: SpendingLimits
  private _totalSpent = 0
  private _requestCount = 0

  constructor(config: TCloudConfig = {}) {
    this.baseURL = (config.baseURL || DEFAULT_BASE_URL).replace(/\/$/, '')
    this.apiKey = config.apiKey || process.env.TCLOUD_API_KEY || process.env.OPENAI_API_KEY
    this.model = config.model || 'gpt-4o-mini'
    this.privacy = config.privacy
    this.limits = config.limits

    this.headers = {
      'Content-Type': 'application/json',
      'X-Tangle-Client': 'tcloud-sdk/0.1.0',
    }

    if (this.apiKey) {
      this.headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    if (config.routing?.prefer) {
      this.headers['X-Tangle-Operator'] = config.routing.prefer
    }
    if (config.routing?.region) {
      this.headers['X-Tangle-Region'] = config.routing.region
    }
  }

  /** Set the SpendAuth signer for private mode */
  setSpendAuthSigner(fn: () => Promise<SpendAuth>) {
    this.spendAuthFn = fn
  }

  /** Current metering stats */
  get usage() {
    return {
      totalSpent: this._totalSpent,
      requestCount: this._requestCount,
      limits: this.limits ? { ...this.limits } : undefined,
    }
  }

  /** Check spending limits before a request. Throws TCloudError if blocked. */
  private checkLimits() {
    if (!this.limits) return

    if (this.limits.maxRequests && this._requestCount >= this.limits.maxRequests) {
      this.limits.onLimitReached?.({ type: 'requests', current: this._requestCount, limit: this.limits.maxRequests })
      throw new TCloudError(429, `Request limit reached (${this._requestCount}/${this.limits.maxRequests})`)
    }

    if (this.limits.maxTotalSpend && this._totalSpent >= this.limits.maxTotalSpend) {
      this.limits.onLimitReached?.({ type: 'total', current: this._totalSpent, limit: this.limits.maxTotalSpend })
      throw new TCloudError(429, `Spending limit reached ($${this._totalSpent.toFixed(6)}/$${this.limits.maxTotalSpend})`)
    }

    // Warn at 80%
    if (this.limits.maxRequests && this.limits.onLimitWarning) {
      const pct = this._requestCount / this.limits.maxRequests
      if (pct >= 0.8) this.limits.onLimitWarning({ type: 'requests', current: this._requestCount, limit: this.limits.maxRequests })
    }
    if (this.limits.maxTotalSpend && this.limits.onLimitWarning) {
      const pct = this._totalSpent / this.limits.maxTotalSpend
      if (pct >= 0.8) this.limits.onLimitWarning({ type: 'total', current: this._totalSpent, limit: this.limits.maxTotalSpend })
    }
  }

  /** Track cost after a response */
  private trackCost(completion: ChatCompletion) {
    this._requestCount++
    if (completion.usage) {
      // Estimate cost from token counts (rough — actual cost depends on model pricing)
      const tokens = completion.usage.total_tokens || 0
      const estimatedCost = tokens * 0.000001 // $1/M tokens fallback
      this._totalSpent += estimatedCost

      if (this.limits?.maxCostPerRequest && estimatedCost > this.limits.maxCostPerRequest) {
        this.limits.onLimitReached?.({ type: 'cost', current: estimatedCost, limit: this.limits.maxCostPerRequest })
      }
    }
  }

  /** Chat completion (non-streaming) */
  async chat(options: ChatOptions): Promise<ChatCompletion> {
    this.checkLimits()

    const headers = { ...this.headers }

    // Attach SpendAuth if in private mode
    if (this.spendAuthFn) {
      const auth = await this.spendAuthFn()
      headers['X-Payment-Signature'] = JSON.stringify(auth)
      delete headers['Authorization'] // don't send API key in private mode
    }

    const res = await proxiedFetch(this.privacy, `${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model || this.model,
        messages: options.messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stream: false,
        stop: options.stop,
        top_p: options.topP,
        frequency_penalty: options.frequencyPenalty,
        presence_penalty: options.presencePenalty,
        response_format: options.responseFormat,
        tools: options.tools,
      }),
    }, false)

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || err.message || res.statusText)
    }

    const completion: ChatCompletion = await res.json()
    this.trackCost(completion)
    return completion
  }

  /** Chat completion (streaming) — returns an async iterator of chunks */
  async *chatStream(options: ChatOptions): AsyncGenerator<ChatCompletionChunk> {
    this.checkLimits()

    const headers = { ...this.headers }

    if (this.spendAuthFn) {
      const auth = await this.spendAuthFn()
      headers['X-Payment-Signature'] = JSON.stringify(auth)
      delete headers['Authorization']
    }

    const res = await proxiedFetch(this.privacy, `${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model || this.model,
        messages: options.messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stream: true,
        stop: options.stop,
        top_p: options.topP,
      }),
    }, true)

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error || err.message || res.statusText)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          this._requestCount++
          return
        }
        try {
          yield JSON.parse(data) as ChatCompletionChunk
        } catch {}
      }
    }
  }

  /** Convenience: send a single message and get the text response */
  async ask(message: string, modelOrOptions?: string | Partial<ChatOptions>): Promise<string> {
    const options = typeof modelOrOptions === 'string'
      ? { model: modelOrOptions }
      : modelOrOptions
    const completion = await this.chat({
      messages: [{ role: 'user', content: message }],
      ...options,
    })
    return completion.choices[0]?.message?.content || ''
  }

  /** Convenience: send a single message and get the full completion (with usage) */
  async askFull(message: string, modelOrOptions?: string | Partial<ChatOptions>): Promise<ChatCompletion> {
    const options = typeof modelOrOptions === 'string'
      ? { model: modelOrOptions }
      : modelOrOptions
    return this.chat({
      messages: [{ role: 'user', content: message }],
      ...options,
    })
  }

  /** Convenience: stream a single message and yield text chunks */
  async *askStream(message: string, modelOrOptions?: string | Partial<ChatOptions>): AsyncGenerator<string> {
    const options = typeof modelOrOptions === 'string'
      ? { model: modelOrOptions }
      : modelOrOptions
    for await (const chunk of this.chatStream({
      messages: [{ role: 'user', content: message }],
      ...options,
    })) {
      const content = chunk.choices[0]?.delta?.content
      if (content) yield content
    }
  }

  /** List available models */
  async models(): Promise<Model[]> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/models`, { headers: this.headers }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to fetch models')
    const data = await res.json()
    return data.data || []
  }

  /** List active operators */
  async operators(): Promise<{ operators: Operator[]; stats: any }> {
    // Operators endpoint is at the API root, not /v1
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    const res = await proxiedFetch(this.privacy, `${apiRoot}/api/operators`, { headers: this.headers }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to fetch operators')
    return res.json()
  }

  /** Get credit balance */
  async credits(): Promise<CreditBalance> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    const res = await proxiedFetch(this.privacy, `${apiRoot}/api/billing`, { headers: this.headers }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to fetch credits')
    return res.json()
  }

  /** Add credits */
  async addCredits(amount: number): Promise<{ balance: number }> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    const res = await proxiedFetch(this.privacy, `${apiRoot}/api/billing`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ amount }),
    }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to add credits')
    return res.json()
  }

  /** Create a new API key */
  async createKey(name: string): Promise<{ key: string; id: string }> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    const res = await proxiedFetch(this.privacy, `${apiRoot}/api/keys`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ name }),
    }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to create API key')
    return res.json()
  }

  /** List API keys */
  async keys(): Promise<{ id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }[]> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    const res = await proxiedFetch(this.privacy, `${apiRoot}/api/keys`, { headers: this.headers }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to fetch keys')
    return res.json()
  }

  /** Revoke an API key */
  async revokeKey(id: string): Promise<void> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    const res = await proxiedFetch(this.privacy, `${apiRoot}/api/keys/${id}`, {
      method: 'DELETE',
      headers: this.headers,
    }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to revoke key')
  }

  /** Search models by name, provider, or capability */
  async searchModels(query: string): Promise<Model[]> {
    const all = await this.models()
    const q = query.toLowerCase()
    return all.filter(m =>
      m.id.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      (m._provider && m._provider.toLowerCase().includes(q))
    )
  }

  /** Estimate cost for a request (without sending it) */
  async estimateCost(options: { model?: string; inputTokens: number; outputTokens: number }): Promise<{ inputCost: number; outputCost: number; total: number }> {
    const models = await this.models()
    const model = models.find(m => m.id === (options.model || this.model))
    if (!model) return { inputCost: 0, outputCost: 0, total: 0 }
    const inputCost = options.inputTokens * parseFloat(model.pricing.prompt)
    const outputCost = options.outputTokens * parseFloat(model.pricing.completion)
    return { inputCost, outputCost, total: inputCost + outputCost }
  }
}

export class TCloudError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'TCloudError'
  }
}
