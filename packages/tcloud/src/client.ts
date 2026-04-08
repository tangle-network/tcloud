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
} from './types'

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
      'X-Tangle-Client': 'tcloud-sdk/0.1.4',
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
    this.trackCost(completion, res)
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

  /** Generate embeddings */
  async embeddings(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: options.model || 'text-embedding-3-small',
        input: options.input,
      }),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    this._requestCount++
    return res.json()
  }

  /** Generate images */
  async imageGenerate(options: ImageGenerateOptions): Promise<ImageResponse> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/images/generations`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: options.model || 'dall-e-3',
        prompt: options.prompt,
        n: options.n,
        size: options.size,
        quality: options.quality,
        response_format: options.response_format,
      }),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    this._requestCount++
    return res.json()
  }

  /** Rerank documents by relevance to a query */
  async rerank(options: RerankOptions): Promise<RerankResponse> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/rerank`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: options.model || 'rerank-english-v3.0',
        query: options.query,
        documents: options.documents,
        top_n: options.top_n,
      }),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    this._requestCount++
    return res.json()
  }

  /** Text-to-speech */
  async speech(options: { model?: string; input: string; voice?: string }): Promise<ArrayBuffer> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/audio/speech`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: options.model || 'tts-1',
        input: options.input,
        voice: options.voice || 'alloy',
      }),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    this._requestCount++
    return res.arrayBuffer()
  }

  /** Legacy completions endpoint */
  async completions(options: CompletionOptions): Promise<CompletionResponse> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model: options.model || this.model,
        prompt: options.prompt,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stop: options.stop,
        top_p: options.topP,
      }),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    this._requestCount++
    return res.json()
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

    const res = await proxiedFetch(this.privacy, `${this.baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: formData as any,
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    this._requestCount++
    return res.json()
  }

  /** Create a fine-tuning job */
  async fineTuneCreate(options: FineTuningJobOptions): Promise<FineTuningJob> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/fine_tuning/jobs`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(options),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    this._requestCount++
    return res.json()
  }

  /** List fine-tuning jobs */
  async fineTuneList(): Promise<{ data: FineTuningJob[] }> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/fine_tuning/jobs`, {
      headers: this.headers,
    }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to fetch fine-tuning jobs')
    return res.json()
  }

  /** Submit a batch of chat requests */
  async batch(requests: BatchRequest[]): Promise<BatchJobResponse> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/batch`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ requests }),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    return res.json()
  }

  /** Get batch job status */
  async batchStatus(jobId: string): Promise<BatchJobResponse> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/batch?id=${jobId}`, {
      headers: this.headers,
    }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to fetch batch status')
    return res.json()
  }

  /** Generate video */
  async videoGenerate(options: VideoGenerateOptions): Promise<VideoResponse> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/video/generate`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(options),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    this._requestCount++
    return res.json()
  }

  /** Get video generation status */
  async videoStatus(id: string): Promise<VideoResponse> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/video?id=${id}`, {
      headers: this.headers,
    }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to fetch video status')
    return res.json()
  }

  /** Generate an avatar video (lip-synced talking head from audio + face image).
   *  Returns 202 with a job_id for async polling via avatarJobStatus(). */
  async avatarGenerate(options: AvatarGenerateRequest): Promise<AvatarGenerateResponse> {
    this.checkLimits()

    const headers = { ...this.headers }

    if (this.spendAuthFn) {
      const auth = await this.spendAuthFn()
      headers['X-Payment-Signature'] = JSON.stringify(auth)
      delete headers['Authorization']
    }

    const res = await proxiedFetch(this.privacy, `${this.baseURL}/avatar/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(options),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    this._requestCount++
    return res.json()
  }

  /** Poll an avatar generation job by ID. */
  async avatarJobStatus(jobId: string): Promise<AvatarJobStatus> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/avatar/jobs/${jobId}`, {
      headers: this.headers,
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    return res.json()
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

  // ---------------------------------------------------------------------------
  // Vector Store (requires operator routing — X-Tangle-Service/Blueprint/Operator)
  // ---------------------------------------------------------------------------

  /** Create a vector collection on the operator's vector store */
  async createCollection(options: { name: string; dimensions: number; distance_metric?: string }): Promise<any> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/collections`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(options),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    return res.json()
  }

  /** List collections on the operator's vector store */
  async listCollections(): Promise<any> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/collections`, {
      headers: this.headers,
    }, false)
    if (!res.ok) throw new TCloudError(res.status, 'Failed to list collections')
    return res.json()
  }

  /** Upsert vectors into a collection */
  async upsertVectors(collection: string, vectors: Array<{ id: string; vector: number[]; metadata?: Record<string, any> }>): Promise<any> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/collections/${encodeURIComponent(collection)}/upsert`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ vectors }),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    return res.json()
  }

  /** Similarity search in a collection */
  async queryVectors(collection: string, options: { vector: number[]; top_k?: number; filter?: Record<string, any> }): Promise<any> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/collections/${encodeURIComponent(collection)}/query`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(options),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    return res.json()
  }

  /** RAG query — embed text + search collection in one call */
  async ragQuery(options: { query: string; collection: string; top_k?: number; embedding_model?: string }): Promise<any> {
    const res = await proxiedFetch(this.privacy, `${this.baseURL}/rag`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(options),
    }, false)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }
    return res.json()
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
   * Get a pricing spectrum from cheapest to most premium for a given service.
   * Auto-generates resource configurations along a low→high curve and queries
   * operators for each. Returns sorted results the customer can pick from.
   *
   * @example
   * ```ts
   * const spectrum = await client.pricingSpectrum({
   *   service: 'llm',
   *   model: 'meta-llama/Llama-3.1-70B-Instruct',
   *   tiers: 5,  // how many price points (default 5)
   * })
   * // Returns:
   * // [
   * //   { tier: "basic",    config: { cpu: 4, ram: 16, gpu: 0, tee: false }, price: "$0.001/1K tokens", operators: 12 },
   * //   { tier: "standard", config: { cpu: 8, ram: 32, gpu: 1, tee: false }, price: "$0.003/1K tokens", operators: 8 },
   * //   { tier: "premium",  config: { cpu: 16, ram: 64, gpu: 1, tee: true }, price: "$0.005/1K tokens", operators: 3 },
   * //   ...
   * // ]
   * ```
   */
  async pricingSpectrum(options: {
    service?: string
    model?: string
    tiers?: number
  }): Promise<PricingTier[]> {
    const tiers = options.tiers || 5
    const operators = await this.operators()
    const models = await this.models()

    // Build a spectrum of configs from low to high
    const configs: Array<{ name: string; cpu: number; ram: number; gpu: number; tee: boolean }> = []
    const steps = [
      { name: 'basic',       cpu: 2,  ram: 8,   gpu: 0, tee: false },
      { name: 'standard',    cpu: 4,  ram: 16,  gpu: 0, tee: false },
      { name: 'gpu',         cpu: 8,  ram: 32,  gpu: 1, tee: false },
      { name: 'gpu-premium',  cpu: 16, ram: 64,  gpu: 1, tee: false },
      { name: 'gpu-tee',     cpu: 16, ram: 64,  gpu: 1, tee: true  },
      { name: 'multi-gpu',   cpu: 32, ram: 128, gpu: 2, tee: false },
      { name: 'multi-gpu-tee', cpu: 32, ram: 128, gpu: 2, tee: true },
      { name: 'max',         cpu: 64, ram: 256, gpu: 4, tee: true  },
    ]
    // Pick evenly spaced tiers
    const stride = Math.max(1, Math.floor(steps.length / tiers))
    for (let i = 0; i < steps.length && configs.length < tiers; i += stride) {
      configs.push(steps[i])
    }

    // Query operators for each config
    const results: PricingTier[] = await Promise.all(
      configs.map(async (config) => {
        // Count operators that can serve this config
        const matching = operators.operators.filter((op: any) => {
          const gpu = op.capabilities?.gpuCount || 0
          const tee = op.capabilities?.teeAttested || false
          if (config.gpu > 0 && gpu < config.gpu) return false
          if (config.tee && !tee) return false
          return true
        })

        // Estimate price from the cheapest matching operator's pricing
        const model = models.find(m => m.id === (options.model || this.model))
        let priceEstimate = 'unavailable'
        if (model && matching.length > 0) {
          const basePrice = parseFloat(model.pricing.prompt || '0')
          const multiplier = config.tee ? 1.5 : 1.0
          const gpuMultiplier = config.gpu > 0 ? (1 + config.gpu * 0.5) : 1.0
          priceEstimate = `$${(basePrice * multiplier * gpuMultiplier * 1000).toFixed(4)}/1K tokens`
        }

        return {
          tier: config.name,
          config: {
            cpu: config.cpu,
            ramGb: config.ram,
            gpu: config.gpu,
            tee: config.tee,
          },
          priceEstimate,
          availableOperators: matching.length,
        }
      })
    )

    return results
  }
}

export interface PricingTier {
  tier: string
  config: { cpu: number; ramGb: number; gpu: number; tee: boolean }
  priceEstimate: string
  availableOperators: number
}

export class TCloudError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'TCloudError'
  }
}

export class TCloudError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'TCloudError'
  }
}
