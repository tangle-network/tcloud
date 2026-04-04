/** Core types for the tcloud SDK */

export interface TCloudConfig {
  /** API base URL (default: https://router.tangle.tools/v1) */
  baseURL?: string
  /** API key for standard (non-private) mode */
  apiKey?: string
  /** Default model */
  model?: string
  /** Operator routing preferences */
  routing?: RoutingConfig
  /** Enable shielded (private) mode */
  shielded?: ShieldedConfig | boolean
  /** Privacy proxy configuration for IP hiding */
  privacy?: PrivacyConfig
  /** Spending limits and metering */
  limits?: SpendingLimits
}

export interface SpendingLimits {
  /** Max USD to spend per request. Rejects if estimated cost exceeds this. */
  maxCostPerRequest?: number
  /** Max USD to spend across all requests in this client's lifetime. Stops at limit. */
  maxTotalSpend?: number
  /** Max requests allowed. Stops at limit. */
  maxRequests?: number
  /** Callback when a limit is approached (80% threshold) */
  onLimitWarning?: (info: { type: 'cost' | 'total' | 'requests'; current: number; limit: number }) => void
  /** Callback when a limit is hit (request blocked) */
  onLimitReached?: (info: { type: 'cost' | 'total' | 'requests'; current: number; limit: number }) => void
}

export interface RoutingConfig {
  /** Preferred operator slug or address */
  prefer?: string
  /** Blueprint ID — route to operators under this Blueprint */
  blueprintId?: string
  /** Service instance ID — route to a specific service instance */
  serviceId?: string
  /** Routing strategy */
  strategy?: 'lowest-latency' | 'lowest-price' | 'highest-reputation' | 'round-robin'
  /** Region filter */
  region?: string
  /** Fallback operator slugs (tried in order) */
  fallback?: string[]
}

export interface EmbeddingOptions {
  model?: string
  input: string | string[]
}

export interface EmbeddingResponse {
  object: string
  data: { object: string; embedding: number[]; index: number }[]
  model: string
  usage: { prompt_tokens: number; total_tokens: number }
}

export interface ImageGenerateOptions {
  model?: string
  prompt: string
  n?: number
  size?: string
  quality?: string
  response_format?: 'url' | 'b64_json'
}

export interface ImageResponse {
  created: number
  data: { url?: string; b64_json?: string; revised_prompt?: string }[]
}

export interface RerankOptions {
  model?: string
  query: string
  documents: string[]
  top_n?: number
}

export interface RerankResponse {
  results: { index: number; relevance_score: number }[]
}

export interface PrivacyConfig {
  /** 'direct' — no proxy (default). 'relayer' — route through tcloud-relayer. 'socks5' — route through SOCKS5 proxy (e.g. Tor). */
  mode: 'direct' | 'relayer' | 'socks5'
  /** Relayer URL for 'relayer' mode (e.g. 'http://localhost:3030') */
  relayerUrl?: string
  /**
   * SOCKS5 proxy URL for 'socks5' mode (e.g. 'socks5://127.0.0.1:9050' for Tor).
   * Requires `socks-proxy-agent` as an optional peer dependency.
   */
  socksProxy?: string
}

export interface ShieldedConfig {
  /** Pre-existing spending private key (hex). If not set, generates ephemeral. */
  spendingKey?: string
  /** Pre-existing commitment. If not set, derives from key. */
  commitment?: string
  /** Chain ID (default: 3799 for Tangle testnet) */
  chainId?: number
  /** ShieldedCredits contract address */
  creditsAddress?: string
  /** Service ID for the blueprint */
  serviceId?: bigint
  /** Privacy proxy configuration for IP hiding */
  privacy?: PrivacyConfig
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}

export interface ChatOptions {
  /** Model to use */
  model?: string
  /** Messages */
  messages: ChatMessage[]
  /** Temperature (0-2) */
  temperature?: number
  /** Max tokens to generate */
  maxTokens?: number
  /** Stream response */
  stream?: boolean
  /** Stop sequences */
  stop?: string | string[]
  /** Top-p sampling */
  topP?: number
  /** Frequency penalty */
  frequencyPenalty?: number
  /** Presence penalty */
  presencePenalty?: number
  /** JSON mode */
  responseFormat?: { type: 'text' | 'json_object' }
  /** Tools / function calling */
  tools?: any[]
}

export interface ChatCompletion {
  id: string
  object: string
  created: number
  model: string
  choices: {
    index: number
    message: ChatMessage
    finish_reason: string
  }[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface ChatCompletionChunk {
  id: string
  object: string
  created: number
  model: string
  choices: {
    index: number
    delta: Partial<ChatMessage>
    finish_reason: string | null
  }[]
}

export interface Model {
  id: string
  name: string
  description?: string
  context_length: number
  pricing: {
    prompt: string
    completion: string
  }
  _provider?: string
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
}

export interface Operator {
  id: string
  slug: string
  name: string
  description?: string
  status: string
  endpointUrl: string
  blueprintType: string
  reputationScore: number
  uptimePercent: number
  avgLatencyMs: number
  totalRequests: number
  stakeTnt: number
  models: { modelId: string; inputPrice: number; outputPrice: number }[]
}

export interface CreditBalance {
  balance: number
  transactions: {
    id: string
    amount: number
    type: string
    description: string
    createdAt: string
  }[]
}

export interface SpendAuth {
  commitment: string
  serviceId: string
  jobIndex: number
  amount: string
  operator: string
  nonce: string
  expiry: string
  signature: string
}
