/**
 * Core HTTP client for Tangle AI Cloud.
 * Shared between CLI and SDK.
 */

import type {
  TCloudConfig,
  ChatOptions,
  ChatCompletion,
  ChatCompletionChunk,
  Model,
  Operator,
  CreditBalance,
  SpendAuth,
} from './types'

const DEFAULT_BASE_URL = 'https://api.tangleai.cloud/v1'

export class TCloudClient {
  readonly baseURL: string
  readonly apiKey?: string
  readonly model: string
  private headers: Record<string, string>
  private spendAuthFn?: () => Promise<SpendAuth>

  constructor(config: TCloudConfig = {}) {
    this.baseURL = (config.baseURL || DEFAULT_BASE_URL).replace(/\/$/, '')
    this.apiKey = config.apiKey || process.env.TCLOUD_API_KEY || process.env.OPENAI_API_KEY
    this.model = config.model || 'gpt-4o-mini'

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

  /** Chat completion (non-streaming) */
  async chat(options: ChatOptions): Promise<ChatCompletion> {
    const headers = { ...this.headers }

    // Attach SpendAuth if in private mode
    if (this.spendAuthFn) {
      const auth = await this.spendAuthFn()
      headers['X-Payment-Signature'] = JSON.stringify(auth)
      delete headers['Authorization'] // don't send API key in private mode
    }

    const res = await fetch(`${this.baseURL}/chat/completions`, {
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
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error || err.message || res.statusText)
    }

    return res.json()
  }

  /** Chat completion (streaming) — returns an async iterator of chunks */
  async *chatStream(options: ChatOptions): AsyncGenerator<ChatCompletionChunk> {
    const headers = { ...this.headers }

    if (this.spendAuthFn) {
      const auth = await this.spendAuthFn()
      headers['X-Payment-Signature'] = JSON.stringify(auth)
      delete headers['Authorization']
    }

    const res = await fetch(`${this.baseURL}/chat/completions`, {
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
    })

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
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data) as ChatCompletionChunk
        } catch {}
      }
    }
  }

  /** Convenience: send a single message and get the text response */
  async ask(message: string, options?: Partial<ChatOptions>): Promise<string> {
    const completion = await this.chat({
      messages: [{ role: 'user', content: message }],
      ...options,
    })
    return completion.choices[0]?.message?.content || ''
  }

  /** Convenience: stream a single message and yield text chunks */
  async *askStream(message: string, options?: Partial<ChatOptions>): AsyncGenerator<string> {
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
    const res = await fetch(`${this.baseURL}/models`, { headers: this.headers })
    if (!res.ok) throw new TCloudError(res.status, 'Failed to fetch models')
    const data = await res.json()
    return data.data || []
  }

  /** List active operators */
  async operators(): Promise<{ operators: Operator[]; stats: any }> {
    // Operators endpoint is at the API root, not /v1
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    const res = await fetch(`${apiRoot}/api/operators`, { headers: this.headers })
    if (!res.ok) throw new TCloudError(res.status, 'Failed to fetch operators')
    return res.json()
  }

  /** Get credit balance */
  async credits(): Promise<CreditBalance> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    const res = await fetch(`${apiRoot}/api/billing`, { headers: this.headers })
    if (!res.ok) throw new TCloudError(res.status, 'Failed to fetch credits')
    return res.json()
  }

  /** Add credits */
  async addCredits(amount: number): Promise<{ balance: number }> {
    const apiRoot = this.baseURL.replace(/\/v1$/, '')
    const res = await fetch(`${apiRoot}/api/billing`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ amount }),
    })
    if (!res.ok) throw new TCloudError(res.status, 'Failed to add credits')
    return res.json()
  }
}

export class TCloudError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'TCloudError'
  }
}
