/**
 * Core HTTP client for Tangle AI Cloud.
 * Shared between CLI and SDK.
 */

import type {
  TCloudConfig,
  PrivacyConfig,
  SpendingLimits,
  RetryConfig,
  ChatOptions,
  ChatCompletion,
  ChatCompletionChunk,
  Model,
  Operator,
  CreditBalance,
  SpendAuth,
  EmbeddingOptions,
  EmbeddingResponse,
  ImageGenerateOptions,
  ImageResponse,
  RerankOptions,
  RerankResponse,
  CompletionOptions,
  CompletionResponse,
  TranscriptionResponse,
  FineTuningJobOptions,
  FineTuningJob,
  BatchRequest,
  BatchJobResponse,
  VideoGenerateOptions,
  VideoResponse,
  AvatarGenerateRequest,
  AvatarGenerateResponse,
  AvatarJobStatus,
  JobEvent,
  WatchJobOptions,
} from './types'
import { PrivateRouter, type OperatorInfo } from './private-router'

const DEFAULT_BASE_URL = 'https://router.tangle.tools/v1'

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

const DEFAULT_RETRY: Required<RetryConfig> = {
  maxRetries: 3,
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
  multiplier: 2,
  retryableStatuses: [429, 500, 502, 503, 504],
}

const DEFAULT_TIMEOUT_MS = 60_000

export class TCloudClient {
  readonly baseURL: string
  readonly apiKey?: string
  readonly model: string
  private headers: Record<string, string>
  private spendAuthFn?: () => Promise<SpendAuth>
  private privacy?: PrivacyConfig
  private limits?: SpendingLimits
  private retryConfig: Required<RetryConfig> | null
  private timeoutMs: number
  private _totalSpent = 0
  private _requestCount = 0
  readonly privateRouter?: PrivateRouter
  private _cachedOperators: OperatorInfo[] = []
  private _operatorsCachedAt = 0
  private static readonly OPERATORS_TTL_MS = 5 * 60 * 1000

  constructor(config: TCloudConfig = {}) {
    this.baseURL = (config.baseURL || DEFAULT_BASE_URL).replace(/\/$/, '')
    this.apiKey = config.apiKey || process.env.TCLOUD_API_KEY
    this.model = config.model || 'gpt-4o-mini'
    this.privacy = config.privacy
    this.limits = config.limits
    this.retryConfig = config.retry === false ? null : { ...DEFAULT_RETRY, ...config.retry }
    this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS

    this.headers = {
      'Content-Type': 'application/json',
      'X-Tangle-Client': 'tcloud-sdk/0.2.0',
    }

    if (this.apiKey) {
      this.headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    if (config.routing?.mode) {
      this.headers['X-Tangle-Routing'] = config.routing.mode
    }
    if (config.routing?.prefer) {
      this.headers['X-Tangle-Operator'] = config.routing.prefer
    }
    if (config.routing?.blueprintId) {
      this.headers['X-Tangle-Blueprint'] = config.routing.blueprintId
    }
    if (config.routing?.serviceId) {
      this.headers['X-Tangle-Service'] = config.routing.serviceId
    }
    if (config.routing?.region) {
      this.headers['X-Tangle-Region'] = config.routing.region
    }

    if (config.routing?.strategy) {
      const strategyMap: Record<string, import('./private-router').RoutingStrategy> = {
        'round-robin': 'round-robin',
        'lowest-latency': 'latency-aware',
        'lowest-price': 'round-robin',
        'highest-reputation': 'round-robin',
      }
      this.privateRouter = new PrivateRouter({
        strategy: strategyMap[config.routing.strategy] || 'round-robin',
      })
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

  /** Ensure the private router has operators loaded (with TTL-based caching) */
  private async ensureRouterOperators(): Promise<void> {
    if (!this.privateRouter) return
    const now = Date.now()
    if (this._cachedOperators.length > 0 && (now - this._operatorsCachedAt) < TCloudClient.OPERATORS_TTL_MS) {
      return
    }
    const data = await this.operators()
    this._cachedOperators = (data.operators || []).map((op: Operator) => ({
      slug: op.slug,
      endpointUrl: op.endpointUrl,
      region: '',
      reputationScore: op.reputationScore,
      avgLatencyMs: op.avgLatencyMs,
      models: op.models.map((m) => m.modelId),
    }))
    this._operatorsCachedAt = now
    this.privateRouter.setOperators(this._cachedOperators)
  }

  /** Track cost after a response, using actual pricing from response headers when available */
  private trackCost(completion: ChatCompletion, res?: Response) {
    this._requestCount++
    if (completion.usage) {
      let estimatedCost: number
      const inputPrice = res ? parseFloat(res.headers.get('x-tangle-price-input') || '0') : 0
      const outputPrice = res ? parseFloat(res.headers.get('x-tangle-price-output') || '0') : 0

      if (inputPrice > 0 || outputPrice > 0) {
        estimatedCost = (completion.usage.prompt_tokens || 0) * inputPrice
          + (completion.usage.completion_tokens || 0) * outputPrice
      } else {
        const tokens = completion.usage.total_tokens || 0
        estimatedCost = tokens * 0.000001 // $1/M tokens fallback
      }
      this._totalSpent += estimatedCost

      if (this.limits?.maxCostPerRequest && estimatedCost > this.limits.maxCostPerRequest) {
        this.limits.onLimitReached?.({ type: 'cost', current: estimatedCost, limit: this.limits.maxCostPerRequest })
      }
    }
  }

  /**
   * Core fetch with retry + timeout. All helpers build on this.
   * Retries on retryable status codes with exponential backoff + jitter.
   */
  private async _doFetch(url: string, init: RequestInit, streaming: boolean): Promise<Response> {
    const retry = this.retryConfig
    const maxAttempts = retry ? retry.maxRetries + 1 : 1

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      if (this.timeoutMs > 0 && !streaming) {
        timer = setTimeout(() => controller.abort(), this.timeoutMs)
      }

      try {
        const res = await proxiedFetch(this.privacy, url, {
          ...init,
          signal: controller.signal,
        }, streaming)

        if (res.ok) return res

        // Check if retryable
        if (retry && attempt < retry.maxRetries && retry.retryableStatuses.includes(res.status)) {
          const backoff = Math.min(
            retry.initialBackoffMs * Math.pow(retry.multiplier, attempt),
            retry.maxBackoffMs,
          )
          const jitter = backoff * 0.5 * Math.random()
          await new Promise(r => setTimeout(r, backoff + jitter))
          continue
        }

        // Not retryable or exhausted retries
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new TCloudError(res.status, err.error?.message || err.error || err.message || res.statusText)
      } catch (e: any) {
        if (e instanceof TCloudError) throw e
        // Timeout and network errors are retryable
        if (retry && attempt < retry.maxRetries) {
          const backoff = Math.min(
            retry.initialBackoffMs * Math.pow(retry.multiplier, attempt),
            retry.maxBackoffMs,
          )
          await new Promise(r => setTimeout(r, backoff))
          continue
        }
        if (e?.name === 'AbortError') {
          throw new TCloudError(408, `Request timed out after ${this.timeoutMs}ms`)
        }
        throw new TCloudError(0, e?.message || 'Network error')
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    // Should never reach here, but satisfy TypeScript
    throw new TCloudError(0, 'Retry loop exhausted')
  }

  /**
   * Shared request helper for billable JSON API calls.
   * Enforces: checkLimits → fetch with retry/timeout → error parsing → requestCount.
   */
  private async _request<T>(url: string, init: RequestInit & { method?: string } = {}): Promise<T> {
    this.checkLimits()
    const res = await this._doFetch(url, { headers: this.headers, ...init }, false)
    this._requestCount++
    return res.json()
  }

  /**
   * Shared request helper for read-only/non-billable JSON API calls.
   * No limits check, no request counting.
   */
  private async _fetch<T>(url: string, init: RequestInit & { method?: string } = {}): Promise<T> {
    const res = await this._doFetch(url, { headers: this.headers, ...init }, false)
    return res.json()
  }

  /**
   * Shared request helper for billable calls that return non-JSON (e.g. ArrayBuffer).
   */
  private async _requestRaw(url: string, init: RequestInit & { method?: string } = {}): Promise<Response> {
    this.checkLimits()
    const res = await this._doFetch(url, { headers: this.headers, ...init }, false)
    this._requestCount++
    return res
  }

  /**
   * Prepare headers for chat requests — operator routing + SpendAuth.
   * Shared between chat() and chatStream() to eliminate duplication.
   */
  private async _prepareChatRequest(model: string): Promise<{ headers: Record<string, string>; baseURL: string }> {
    const headers = { ...this.headers }

    if (this.spendAuthFn) {
      const auth = await this.spendAuthFn()
      headers['X-Payment-Signature'] = JSON.stringify(auth)
      delete headers['Authorization']
    }

    let baseURL = this.baseURL
    if (this.privateRouter) {
      await this.ensureRouterOperators()
      const operator = this.privateRouter.selectOperator(model)
      if (operator) {
        baseURL = operator.endpointUrl.replace(/\/$/, '')
        headers['X-Tangle-Operator'] = operator.slug
        delete headers['Authorization']
      }
    }

    return { headers, baseURL }
  }

  /** Build the chat completions request body */
  private _chatBody(options: ChatOptions, stream: boolean): string {
    return JSON.stringify({
      model: options.model || this.model,
      messages: options.messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream,
      stop: options.stop,
      top_p: options.topP,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty,
      response_format: options.responseFormat,
      tools: options.tools,
      tool_choice: options.toolChoice,
      ...(options.gateway ? { gateway: options.gateway } : {}),
      ...options.providerOptions,
    })
  }

  /** Chat completion (non-streaming) */
  async chat(options: ChatOptions): Promise<ChatCompletion> {
    this.checkLimits()
    const { headers, baseURL } = await this._prepareChatRequest(options.model || this.model)

    const res = await this._doFetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: this._chatBody(options, false),
    }, false)

    const completion: ChatCompletion = await res.json()
    this.trackCost(completion, res)
    return completion
  }

  /** Chat completion (streaming) — returns an async iterator of chunks */
  async *chatStream(options: ChatOptions): AsyncGenerator<ChatCompletionChunk> {
    this.checkLimits()
    this._requestCount++
    const { headers, baseURL } = await this._prepareChatRequest(options.model || this.model)

    const res = await this._doFetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: this._chatBody(options, true),
    }, true)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      if (buf.length > 1_048_576) throw new TCloudError(502, 'SSE buffer overflow — server sent >1MB without newline')

      const lines = buf.split('\n')
      buf = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
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
    const data = await this._fetch<{ data: Model[] }>(`${this.baseURL}/models`)
    return data.data || []
  }

  /** List active operators */
  async operators(): Promise<{ operators: Operator[]; stats: any }> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    return this._fetch(`${apiRoot}/api/operators`)
  }

  /** Get credit balance */
  async credits(): Promise<CreditBalance> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    return this._fetch(`${apiRoot}/api/billing`)
  }

  /** Add credits */
  async addCredits(amount: number): Promise<{ balance: number }> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    return this._fetch(`${apiRoot}/api/billing`, {
      method: 'POST',
      body: JSON.stringify({ amount }),
    })
  }

  /** Create a new API key */
  async createKey(name: string): Promise<{ key: string; id: string }> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    return this._fetch(`${apiRoot}/api/keys`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  }

  /** List API keys */
  async keys(): Promise<{ id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }[]> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    return this._fetch(`${apiRoot}/api/keys`)
  }

  /** Revoke an API key */
  async revokeKey(id: string): Promise<void> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    const res = await proxiedFetch(this.privacy, `${apiRoot}/api/keys/${id}`, {
      method: 'DELETE',
      headers: this.headers,
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || err.message || res.statusText)
    }
  }

  /** Generate embeddings */
  async embeddings(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    return this._request(`${this.baseURL}/embeddings`, {
      method: 'POST',
      body: JSON.stringify({
        model: options.model || 'text-embedding-3-small',
        input: options.input,
      }),
    })
  }

  /** Generate images */
  async imageGenerate(options: ImageGenerateOptions): Promise<ImageResponse> {
    return this._request(`${this.baseURL}/images/generations`, {
      method: 'POST',
      body: JSON.stringify({
        model: options.model || 'dall-e-3',
        prompt: options.prompt,
        n: options.n,
        size: options.size,
        quality: options.quality,
        response_format: options.response_format,
      }),
    })
  }

  /** Rerank documents by relevance to a query */
  async rerank(options: RerankOptions): Promise<RerankResponse> {
    return this._request(`${this.baseURL}/rerank`, {
      method: 'POST',
      body: JSON.stringify({
        model: options.model || 'rerank-english-v3.0',
        query: options.query,
        documents: options.documents,
        top_n: options.top_n,
      }),
    })
  }

  /** Text-to-speech */
  async speech(options: { model?: string; input: string; voice?: string }): Promise<ArrayBuffer> {
    const res = await this._requestRaw(`${this.baseURL}/audio/speech`, {
      method: 'POST',
      body: JSON.stringify({
        model: options.model || 'tts-1',
        input: options.input,
        voice: options.voice || 'alloy',
      }),
    })
    return res.arrayBuffer()
  }

  /** Legacy completions endpoint */
  async completions(options: CompletionOptions): Promise<CompletionResponse> {
    return this._request(`${this.baseURL}/completions`, {
      method: 'POST',
      body: JSON.stringify({
        model: options.model || this.model,
        prompt: options.prompt,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stop: options.stop,
        top_p: options.topP,
      }),
    })
  }

  /** Audio transcription (speech-to-text) */
  async transcribe(file: Blob, options?: { model?: string; language?: string; prompt?: string }): Promise<TranscriptionResponse> {
    const formData = new FormData()
    formData.append('file', file, 'audio.webm')
    formData.append('model', options?.model || 'whisper-1')
    if (options?.language) formData.append('language', options.language)
    if (options?.prompt) formData.append('prompt', options.prompt)

    const headers = { ...this.headers }
    delete headers['Content-Type'] // let FormData set it

    this.checkLimits()
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: formData as any,
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || err.message || res.statusText)
    }
    this._requestCount++
    return res.json()
  }

  /** Create a fine-tuning job */
  async fineTuneCreate(options: FineTuningJobOptions): Promise<FineTuningJob> {
    return this._request(`${this.baseURL}/fine_tuning/jobs`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  }

  /** List fine-tuning jobs */
  async fineTuneList(): Promise<{ data: FineTuningJob[] }> {
    return this._fetch(`${this.baseURL}/fine_tuning/jobs`)
  }

  /** Submit a batch of chat requests */
  async batch(requests: BatchRequest[]): Promise<BatchJobResponse> {
    return this._request(`${this.baseURL}/batch`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    })
  }

  /** Get batch job status */
  async batchStatus(jobId: string): Promise<BatchJobResponse> {
    return this._fetch(`${this.baseURL}/batch?id=${jobId}`)
  }

  /** Generate video */
  async videoGenerate(options: VideoGenerateOptions): Promise<VideoResponse> {
    return this._request(`${this.baseURL}/video/generate`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  }

  /** Get video generation status */
  async videoStatus(id: string): Promise<VideoResponse> {
    return this._fetch(`${this.baseURL}/video?id=${id}`)
  }

  /** Generate an avatar video (lip-synced talking head from audio + face image).
   *  Returns 202 with a job_id for async polling via avatarJobStatus(). */
  async avatarGenerate(options: AvatarGenerateRequest): Promise<AvatarGenerateResponse> {
    return this._request(`${this.baseURL}/avatar/generate`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  }

  /** Poll an avatar generation job by ID. */
  async avatarJobStatus(jobId: string): Promise<AvatarJobStatus> {
    return this._fetch(`${this.baseURL}/avatar/jobs/${jobId}`)
  }

  /** Poll an avatar job until it reaches a terminal state (completed/failed).
   *  Returns the final job status. Throws on failure. */
  async pollAvatarJob(jobId: string, options?: { intervalMs?: number; timeoutMs?: number }): Promise<AvatarJobStatus> {
    const interval = options?.intervalMs ?? 5000
    const timeout = options?.timeoutMs ?? 300_000
    const deadline = Date.now() + timeout

    while (Date.now() < deadline) {
      const job = await this.avatarJobStatus(jobId)
      if (job.status === 'completed') return job
      if (job.status === 'failed') {
        throw new TCloudError(500, job.error || `Avatar job ${jobId} failed`)
      }
      await new Promise(r => setTimeout(r, interval))
    }
    throw new TCloudError(408, `Avatar job ${jobId} timed out after ${timeout}ms`)
  }

  /**
   * Watch an async job via SSE until it reaches a terminal state.
   * Works with avatar, video, and training blueprint operators.
   *
   * @param jobId - The job ID returned by the creation endpoint
   * @param options - Optional: operatorUrl override, onEvent callback
   * @returns The final JobEvent (completed/failed/cancelled)
   */
  async watchJob(jobId: string, options?: WatchJobOptions): Promise<JobEvent> {
    const base = options?.operatorUrl?.replace(/\/$/, '') || this.baseURL
    const url = `${base}/v1/jobs/${encodeURIComponent(jobId)}/events`
    const timeout = options?.timeout ?? 300_000

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const watchHeaders: Record<string, string> = {
        ...this.headers,
        Accept: 'text/event-stream',
      }
      // When connecting to an operator URL, don't leak the API key.
      // The job ID itself is the capability token for operator auth.
      if (options?.operatorUrl) {
        delete watchHeaders['Authorization']
      }
      // SSE token overrides any existing Authorization header
      if (options?.sseToken) {
        watchHeaders['Authorization'] = `Bearer ${options.sseToken}`
      }

      const res = await proxiedFetch(this.privacy, url, {
        headers: watchHeaders,
        signal: controller.signal,
      }, true)

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          throw new TCloudError(502, `SSE stream ended without terminal event for job ${jobId}`)
        }
        buf += decoder.decode(value, { stream: true })
        if (buf.length > 1_048_576) throw new TCloudError(502, 'SSE buffer overflow — server sent >1MB without newline')

        const lines = buf.split('\n')
        buf = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (!data || data === '[DONE]') continue

          let event: JobEvent
          try {
            event = JSON.parse(data) as JobEvent
          } catch {
            continue
          }

          try {
            options?.onEvent?.(event)
          } catch (cbErr) {
            console.error('watchJob onEvent callback error:', cbErr)
          }

          if (terminalStatuses.has(event.status)) {
            return event
          }
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new TCloudError(408, `Job ${jobId} timed out after ${timeout}ms`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------------------------------------------------------------------------
  // Vector Store (requires operator routing — X-Tangle-Service/Blueprint/Operator)
  // ---------------------------------------------------------------------------

  /** Create a vector collection on the operator's vector store */
  async createCollection(options: { name: string; dimensions: number; distance_metric?: string }): Promise<any> {
    return this._request(`${this.baseURL}/collections`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  }

  /** List collections on the operator's vector store */
  async listCollections(): Promise<any> {
    return this._fetch(`${this.baseURL}/collections`)
  }

  /** Upsert vectors into a collection */
  async upsertVectors(collection: string, vectors: Array<{ id: string; vector: number[]; metadata?: Record<string, any> }>): Promise<any> {
    return this._request(`${this.baseURL}/collections/${encodeURIComponent(collection)}/upsert`, {
      method: 'POST',
      body: JSON.stringify({ vectors }),
    })
  }

  /** Similarity search in a collection */
  async queryVectors(collection: string, options: { vector: number[]; top_k?: number; filter?: Record<string, any> }): Promise<any> {
    return this._request(`${this.baseURL}/collections/${encodeURIComponent(collection)}/query`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  }

  /** RAG query — embed text + search collection in one call */
  async ragQuery(options: { query: string; collection: string; top_k?: number; embedding_model?: string }): Promise<any> {
    return this._request(`${this.baseURL}/rag`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
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

  /**
   * Get a pricing spectrum across resource tiers for a model.
   *
   * Uses REAL per-operator pricing from `operator.models[].inputPrice`.
   * Each tier filters operators by GPU count and TEE capability, then
   * reports the cheapest and most expensive operator for that config.
   *
   * @param options.model - Model ID to price (falls back to client default)
   * @param options.tiers - Number of tiers (1-7, default 5)
   */
  async pricingSpectrum(options: {
    model?: string
    tiers?: number
  }): Promise<PricingTier[]> {
    const requestedTiers = Math.max(1, Math.min(options.tiers ?? 5, ALL_TIERS.length))
    const modelId = options.model || this.model

    const selected = selectTiers(ALL_TIERS, requestedTiers)

    const operatorData = await this.operators()
    const allOperators: Operator[] = operatorData.operators || []

    return selected.map((tier) => {
      // Filter by GPU + TEE using typed Operator fields
      const matching = allOperators.filter((op) => {
        if (tier.gpu > 0 && (op.gpuCount ?? 0) < tier.gpu) return false
        if (tier.tee && !op.teeAttested) return false
        return true
      })

      // Per-operator pricing for the target model
      const prices = matching
        .map((op) => op.models.find(m => m.modelId === modelId)?.inputPrice)
        .filter((p): p is number => p != null && p > 0)
        .sort((a, b) => a - b)

      const cheapestPrice = prices[0]
      const priciestPrice = prices.length > 1 ? prices[prices.length - 1] : undefined

      return {
        tier: tier.name,
        config: tier,
        cheapestPrice,
        priciestPrice: priciestPrice !== cheapestPrice ? priciestPrice : undefined,
        cheapest: cheapestPrice != null
          ? formatPrice(cheapestPrice)
          : 'no operators for this config',
        priciest: priciestPrice != null && priciestPrice !== cheapestPrice
          ? formatPrice(priciestPrice)
          : undefined,
        availableOperators: matching.length,
        operatorsWithModel: prices.length,
      }
    })
  }

  // ── Eval ──────────────────────────────────────────────────────────────

  private get _apiRoot() { return this.baseURL.replace(/\/v1$/, '') }

  async eval(opts: {
    models: string[]
    scenarios: Array<{ id: string; prompt: string; rubric?: string; category?: string; expectedContains?: string[]; maxLatencyMs?: number }>
    judge?: string; iterations?: number; systemPrompt?: string
  }): Promise<{ results: Array<{ model: string; summary: any; scenarios: any[] }> }> {
    return this._request(`${this._apiRoot}/api/eval`, { method: 'POST', body: JSON.stringify(opts) })
  }

  async createSuite(opts: { name: string; scenarios: Array<{ id: string; prompt: string; rubric?: string }>; models: string[]; judge?: string; iterations?: number; tags?: string[] }): Promise<{ suite: { id: string; name: string } }> {
    return this._request(`${this._apiRoot}/api/eval/suites`, { method: 'POST', body: JSON.stringify(opts) })
  }

  async listSuites(): Promise<{ suites: Array<{ id: string; name: string; models: string[] }> }> {
    return this._fetch(`${this._apiRoot}/api/eval/suites`)
  }

  async runSuite(suiteId: string, opts?: { baseline?: boolean; concurrency?: number }): Promise<any> {
    return this._request(`${this._apiRoot}/api/eval/suites/${suiteId}/runs`, { method: 'POST', body: JSON.stringify(opts || {}) })
  }

  async listRuns(suiteId: string): Promise<any> {
    return this._fetch(`${this._apiRoot}/api/eval/suites/${suiteId}/runs`)
  }

  async getRun(runId: string): Promise<any> {
    return this._fetch(`${this._apiRoot}/api/eval/runs/${runId}`)
  }

  async setBaseline(runId: string): Promise<void> {
    await this._request(`${this._apiRoot}/api/eval/runs/${runId}`, { method: 'PATCH', body: JSON.stringify({ baseline: true }) })
  }

  // ── Sandbox ──────────────────────────────────────────────────────────

  async sandboxPricing(opts?: { cpu?: number; ram?: number; disk?: number }): Promise<{ pricing: { hourlyRate: number; perMinuteRate: number }; plan: string; limits: { maxCpu: number; maxRamGb: number; maxDiskGb: number }; balance: number; canAfford: { minutes: number; hours: number } }> {
    const p = new URLSearchParams()
    if (opts?.cpu) p.set('cpu', String(opts.cpu))
    if (opts?.ram) p.set('ram', String(opts.ram))
    if (opts?.disk) p.set('disk', String(opts.disk))
    return this._fetch(`${this._apiRoot}/api/sandbox/pricing?${p}`)
  }

  async sandboxStatus(): Promise<{ linked: boolean; keyPrefix?: string; gatewayUrl?: string }> {
    return this._fetch(`${this._apiRoot}/api/sandbox/link-key`)
  }

  async sandboxProvision(): Promise<{ provisioned: boolean; minutesRemaining?: number }> {
    return this._request(`${this._apiRoot}/api/sandbox/provision`, { method: 'POST' })
  }

  async sandboxCreate(opts: { model?: string; harness?: 'claude-code' | 'codex' | 'opencode' | 'amp' | 'factory'; cpu?: number; ram?: number; storage?: number; gitUrl?: string; systemPrompt?: string }): Promise<{ sessionId: string; harness: string; model: string; minutesRemaining?: number }> {
    return this._request(`${this._apiRoot}/api/sandbox/sessions`, { method: 'POST', body: JSON.stringify(opts) })
  }

  async sandboxList(): Promise<{ sessions: Array<{ id: string; status: string; model: string; harness: string }> }> {
    return this._fetch(`${this._apiRoot}/api/sandbox/sessions`)
  }

  async sandboxStats(sandboxId: string): Promise<{ config: { cpu: number; ramGb: number; diskGb: number }; uptime: number; computeMinutes: number; live?: { cpuPercent: number; memoryUsedMb: number; memoryTotalMb: number } }> {
    return this._fetch(`${this._apiRoot}/api/sandbox/stats/${sandboxId}`)
  }

  async sandboxDestroy(sessionId: string): Promise<{ deleted: boolean }> {
    return this._request(`${this._apiRoot}/api/sandbox/sessions/${sessionId}`, { method: 'DELETE' })
  }

  // ── User Info ────────────────────────────────────────────────────────

  async userInfo(): Promise<{ user: { id: string; email: string; name?: string }; balance: number; subscription: { plan: string; status: string } | null; usage: Record<string, { cost: number; count: number }> }> {
    return this._fetch(`${this._apiRoot}/api/auth/userinfo`)
  }

}

// ── Pricing helpers ──────────────────────────────────────────────────────

const ALL_TIERS: TierConfig[] = [
  { name: 'cpu-only',      cpu: 4,  ramGb: 16,  gpu: 0, tee: false },
  { name: 'gpu',           cpu: 8,  ramGb: 32,  gpu: 1, tee: false },
  { name: 'gpu-tee',       cpu: 8,  ramGb: 32,  gpu: 1, tee: true  },
  { name: 'multi-gpu',     cpu: 32, ramGb: 128, gpu: 2, tee: false },
  { name: 'multi-gpu-tee', cpu: 32, ramGb: 128, gpu: 2, tee: true  },
  { name: 'max-gpu',       cpu: 64, ramGb: 256, gpu: 4, tee: false },
  { name: 'max-gpu-tee',   cpu: 64, ramGb: 256, gpu: 4, tee: true  },
]

/** Select N evenly-spaced items, always including first and last. */
export function selectTiers(all: TierConfig[], n: number): TierConfig[] {
  if (n >= all.length) return [...all]
  if (n <= 1) return [all[0]]
  if (n === 2) return [all[0], all[all.length - 1]]
  const result: TierConfig[] = [all[0]]
  const step = (all.length - 1) / (n - 1)
  for (let i = 1; i < n - 1; i++) {
    result.push(all[Math.round(i * step)])
  }
  result.push(all[all.length - 1])
  return result
}

function formatPrice(pricePerToken: number): string {
  return `$${(pricePerToken * 1000).toFixed(6)}/1K tokens`
}

export interface TierConfig {
  name: string
  cpu: number
  ramGb: number
  gpu: number
  tee: boolean
}

export interface PricingTier {
  tier: string
  config: TierConfig
  /** Raw cheapest per-input-token price (for programmatic use) */
  cheapestPrice?: number
  /** Raw priciest per-input-token price (undefined if same as cheapest) */
  priciestPrice?: number
  /** Formatted cheapest price */
  cheapest: string
  /** Formatted priciest price (undefined if only one price point) */
  priciest?: string
  /** Operators matching GPU/TEE requirements */
  availableOperators: number
  /** Operators that also serve the requested model at a listed price */
  operatorsWithModel: number
}

export class TCloudError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'TCloudError'
  }
}
