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
  /** Routing mode: 'operator' (Tangle operators only), 'provider' (direct APIs only), 'auto' (try operators, fall back to providers) */
  mode?: 'operator' | 'provider' | 'auto'
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

export interface CompletionOptions {
  model?: string
  prompt: string
  temperature?: number
  maxTokens?: number
  stop?: string | string[]
  topP?: number
}

export interface CompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: { text: string; index: number; finish_reason: string }[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface TranscriptionOptions {
  model?: string
  /** Audio file as a Blob or File */
  file: Blob
  language?: string
  prompt?: string
  response_format?: 'json' | 'text' | 'srt' | 'vtt'
}

export interface TranscriptionResponse {
  text: string
}

export interface FineTuningJobOptions {
  model: string
  training_file: string
  hyperparameters?: {
    n_epochs?: number | 'auto'
    batch_size?: number | 'auto'
    learning_rate_multiplier?: number | 'auto'
  }
  suffix?: string
}

export interface FineTuningJob {
  id: string
  object: string
  model: string
  status: string
  created_at: number
  finished_at: number | null
  fine_tuned_model: string | null
  error: { code: string; message: string } | null
}

export interface BatchRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
}

export interface BatchJobResponse {
  id: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  total_items: number
  completed: number
  failed: number
  results: ({ status: 'fulfilled'; data: ChatCompletion } | { status: 'rejected'; error: string })[] | null
  error: string | null
  created_at: string
  completed_at: string | null
}

export interface VideoGenerateOptions {
  model?: string
  prompt: string
  duration?: number
  resolution?: string
}

export interface VideoResponse {
  id: string
  status: string
  url?: string
  error?: string
}

/** Request body for POST /v1/avatar/generate */
export interface AvatarGenerateRequest {
  /** URL to narration audio (wav/mp3) */
  audio_url: string
  /** URL to face image, OR omit and use avatar_id */
  image_url?: string
  /** Preset avatar identifier (provider-specific) */
  avatar_id?: string
  /** Target duration in seconds (capped by operator's max_duration_seconds) */
  duration_seconds?: number
  /** Output format (default: "mp4") */
  output_format?: string
}

/** Response from POST /v1/avatar/generate (202 Accepted) */
export interface AvatarGenerateResponse {
  job_id: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  result?: AvatarResult
  error?: string
}

/** Result payload within a completed avatar job */
export interface AvatarResult {
  video_url: string
  duration_seconds: number
  format: string
}

/** Response from GET /v1/avatar/jobs/:id */
export interface AvatarJobStatus {
  job_id: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  result?: AvatarResult
  error?: string
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
  /** GPU model name (e.g. "A100", "H100") */
  gpuModel?: string
  /** Number of GPUs available */
  gpuCount?: number
  /** Total VRAM across all GPUs in MiB */
  totalVramMib?: number
  /** Whether this operator is TEE-attested */
  teeAttested?: boolean
  /** TEE provider if attested (e.g. "aws_nitro") */
  teeProvider?: string
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

/** Status event from an async job SSE stream */
export interface JobEvent {
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'
  progress?: number
  result?: Record<string, unknown>
  error?: string
  timestamp: number
}

/** Options for watchJob() */
export interface WatchJobOptions {
  /** Operator endpoint URL (if not using default routing) */
  operatorUrl?: string
  /** Callback for each event (useful for progress tracking) */
  onEvent?: (event: JobEvent) => void
  /** Timeout in ms (default: 5 minutes) */
  timeout?: number
  /** Model to route to (for operator discovery) */
  model?: string
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
