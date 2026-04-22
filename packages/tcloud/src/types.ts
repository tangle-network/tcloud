/** Core types for the tcloud SDK */

export interface TCloudConfig {
  /** API base URL (default: https://router.tangle.tools/v1) */
  baseURL?: string
  /** Platform API URL for billing/keys (default: https://id.tangle.tools) */
  platformURL?: string
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
  /** Retry configuration for transient failures */
  retry?: RetryConfig | false
  /** Default request timeout in ms (default: 60000). Set 0 to disable. */
  timeout?: number
}

export interface RetryConfig {
  /** Max retry attempts (default: 3) */
  maxRetries?: number
  /** Initial backoff in ms (default: 500) */
  initialBackoffMs?: number
  /** Max backoff in ms (default: 30000) */
  maxBackoffMs?: number
  /** Backoff multiplier (default: 2) */
  multiplier?: number
  /** HTTP status codes that trigger retry (default: [429, 500, 502, 503, 504]) */
  retryableStatuses?: number[]
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

/** Gateway-level options for routing, compliance, and inference strategies. */
export interface GatewayOptions {
  /** BYOK: per-request provider credentials. Zero markup. */
  byok?: Record<string, Array<{ apiKey?: string }>>
  /** Route only through ZDR-verified providers. */
  zeroDataRetention?: boolean
  /** Route only through providers that don't train on prompts. */
  disallowPromptTraining?: boolean
  /** Inject cache_control markers for providers that need them. */
  caching?: 'auto' | false
  /** Provider priority order. */
  order?: string[]
  /** Restrict to these providers only. */
  only?: string[]
  /** Fallback model list tried in order. */
  models?: string[]
  /** Per-provider or global timeout (ms, clamped 1s–120s). */
  timeout?: number | Record<string, number>
  /** Smart routing hint. 'quality' auto-enables RSA. */
  optimize?: 'cost' | 'latency' | 'quality'
  /** Disable response cache for this request. */
  cache?: boolean
  /**
   * RSA / MoA: population-based quality amplification.
   * Spawns N parallel calls, aggregates K at a time, refines over T rounds.
   * Add `models` for Mixture-of-Agents (diverse models per slot).
   */
  rsa?: {
    n?: number
    k?: number
    t?: number
    /** MoA: diverse models for generation (round-robin). Aggregation uses primary model. */
    models?: string[]
  }
  /**
   * Best-of-N: generate N candidates, score, return the winner.
   * Scorer: webhook (your HTTP endpoint) or llm (LLM-as-judge).
   */
  bestOfN?: {
    n?: number
    /** Diverse models for generation (round-robin). */
    models?: string[]
    scorer:
      | { type: 'webhook'; url: string; timeout?: number }
      | { type: 'llm'; model: string; prompt: string }
  }
}

/**
 * Bridge options — route a single chat call through the Tangle Router's
 * cli-bridge short-circuit. The bridge drives subscription-backed CLIs
 * (Claude Code, Codex, Kimi Code, opencode) as OpenAI-compatible
 * harnesses with persistent session resume.
 *
 * When `bridge` is set, the client:
 *   1. Rewrites `model` to `bridge/<harness>/<model>` (or `bridge/<harness>`
 *      if no model is given — uses the harness default)
 *   2. Injects `X-Bridge-Unlock` with the caller's unlock token
 *   3. Injects `X-Resume` so follow-up calls with the same id resume
 *      the CLI's native session (no re-tokenizing prior turns)
 *   4. Optionally injects BYOB headers `X-Bridge-Url` + `X-Bridge-Bearer`
 *      if the caller wants to target their own cli-bridge instance
 *      (requires the router to be deployed with CLI_BRIDGE_BYOB_ENABLED)
 */
export interface BridgeOptions {
  /** Which harness to drive. Picks the backend on the bridge. */
  harness: 'claude' | 'claudish' | 'codex' | 'opencode' | 'kimi' | 'openai' | 'anthropic' | 'moonshot' | 'zai'
  /** Model id inside the harness (e.g. `sonnet`, `kimi-for-coding`, `gpt-5-codex`). Omit for harness default. */
  model?: string
  /** Router-issued unlock token. Required unless operator has disabled the gate. */
  unlock: string
  /** Stable caller-owned id for session resume. Map one id per logical conversation. */
  resume?: string
  /** BYOB: point at your own cli-bridge instance. Router must have BYOB enabled. */
  bridgeUrl?: string
  /** BYOB: bearer your cli-bridge expects. */
  bridgeBearer?: string
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
  /** Tool choice strategy or specific tool */
  toolChoice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }
  /**
   * Gateway options: routing, compliance, inference strategies (RSA/MoA/Best-of-N).
   * Sent as `body.gateway` to the Router.
   */
  gateway?: GatewayOptions
  /**
   * Provider-specific parameters passed through to the upstream API.
   * These are spread into the request body alongside standard fields.
   * Example: `{ thinking: { type: 'enabled', budget_tokens: 8000 } }`
   */
  providerOptions?: Record<string, unknown>
  /**
   * Route this call through the Tangle Router's cli-bridge short-circuit.
   * See {@link BridgeOptions}. When set, `model` is rewritten to
   * `bridge/<harness>/<model>` and bridge headers are injected.
   */
  bridge?: BridgeOptions
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

// ── API Key Types ──

export interface CreateKeyOptions {
  name: string
  /** Explicit parent key ID. When omitted and calling with an API key,
   * the new key is auto-parented to the calling key. */
  parentKeyId?: string
  product?: 'router' | 'sandbox' | 'evals' | 'blueprint-agent'
  projectId?: string
  budgetUsd?: number
  allowedModels?: string[]
  rpmLimit?: number
  /** ISO 8601 datetime. Must be in the future. */
  expiresAt?: string
}

export interface CreatedKey {
  id: string
  key: string
  prefix: string
  name: string
  product: string | null
  budgetUsd: number | null
  budgetRemaining: number | null
}

export interface ApiKeyInfo {
  id: string
  keyPrefix: string
  name: string
  parentKeyId: string | null
  product: string | null
  projectId: string | null
  budgetUsd: number | null
  budgetSpent: number
  allowedModels: string[] | null
  rpmLimit: number | null
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export interface UpdateKeyOptions {
  name?: string
  budgetUsd?: number
  allowedModels?: string[]
  rpmLimit?: number | null
  expiresAt?: string | null
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
  /** SSE bearer token (replaces API key for operator SSE auth) */
  sseToken?: string
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
