# tcloud

TypeScript SDK and CLI for [Tangle AI Cloud](https://router.tangle.tools) — decentralized LLM inference with operator routing, reputation-based selection, and anonymous payments via ShieldedCredits.

Zero framework dependencies. Pure `fetch` + SSE. Works in Node.js, Deno, Bun, and edge runtimes.

## Table of Contents

- [Installation](#installation)
- [SDK](#sdk)
  - [Quick Start](#quick-start)
  - [Model Selection](#model-selection)
  - [Streaming](#streaming)
  - [Full Chat Completion](#full-chat-completion)
  - [Private Inference](#private-inference)
  - [Embeddings](#embeddings)
  - [Video & Avatar Generation](#video--avatar-generation)
  - [Async Jobs](#async-jobs)
  - [Operator Routing](#operator-routing)
  - [Models and Operators](#models-and-operators)
  - [API Key Management](#api-key-management)
  - [Cost Estimation](#cost-estimation)
  - [Spending Limits](#spending-limits)
- [CLI](#cli)
  - [Authentication](#authentication)
  - [Chat](#chat)
  - [Browse](#browse)
  - [Credits and Keys](#credits-and-keys)
  - [Wallet Management](#wallet-management)
- [Configuration](#configuration)
- [OpenAI SDK Compatibility](#openai-sdk-compatibility)
- [Vercel AI SDK Compatibility](#vercel-ai-sdk-compatibility)
- [Examples](#examples)
- [License](#license)

## Installation

```bash
npm install tcloud
```

Or run the CLI directly:

```bash
npx tcloud chat "What is Tangle?"
```

## SDK

### Quick Start

```ts
import { TCloud } from 'tcloud'

// Set model at client creation — explicit and consistent.
const client = new TCloud({
  apiKey: 'sk-tan-...',
  model: 'gpt-4o-mini',
})

const answer = await client.ask('What is Tangle Network?') // string
console.log(answer)
```

### Model Selection

Model is set at client creation. Override per-request when needed:

```ts
// Default model for all requests
const client = new TCloud({ apiKey: '...', model: 'gpt-4o-mini' })
await client.ask('Hello')  // returns string

// Full control per-request (OpenAI-compatible)
const completion = await client.chat({
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello' }],
  temperature: 0.5,
  maxTokens: 100,
}) // returns ChatCompletion { id, model, choices: [{ index, message, finish_reason }], usage? }

// Get full response with usage stats
const full = await client.askFull('Hello') // returns ChatCompletion
console.log(full.model, full.usage?.total_tokens)

// Search available models
const llamas = await client.searchModels('llama') // returns Model[]
```

### Streaming

```ts
for await (const chunk of client.askStream('Explain zero-knowledge proofs')) {
  process.stdout.write(chunk)
}

// With model override
for await (const chunk of client.askStream('Hello', 'claude-sonnet-4-6')) {
  process.stdout.write(chunk)
}
```

### Full Chat Completion

OpenAI-compatible request/response format:

```ts
const completion = await client.chat({
  model: 'meta-llama/llama-4-maverick',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
  ],
  temperature: 0.7,
  maxTokens: 1024,
}) // returns ChatCompletion

console.log(completion.choices[0].message.content)
// completion.usage => { prompt_tokens, completion_tokens, total_tokens }
```

### Private Inference

Anonymous inference with no API key. Uses EIP-712 SpendAuth signatures — the operator verifies payment without learning your identity.

```ts
import { TCloud } from 'tcloud'

const client = TCloud.shielded()
const answer = await client.ask('Hello from the shadows')
```

Under the hood: generates an ephemeral wallet, signs a SpendAuth payload, and sends it as an `X-Payment-Signature` header. The operator validates the cryptographic proof and serves inference without knowing who you are.

### Embeddings

```ts
const response = await client.embeddings({
  model: 'text-embedding-3-small',
  input: 'What is Tangle?',
}) // returns EmbeddingResponse
// EmbeddingResponse: { object, data: [{ object, embedding: number[], index }], model, usage }
console.log(response.data[0].embedding.length) // 1536
```

### Video & Avatar Generation

```ts
// Generate a video from a text prompt
const video = await client.videoGenerate({
  prompt: 'A sunset over mountains',
  duration: 5,
}) // returns VideoResponse { id, status, url?, error? }

// Generate a talking-head avatar video
const avatar = await client.avatarGenerate({
  audio_url: 'https://example.com/narration.mp3',
  image_url: 'https://example.com/face.jpg',
}) // returns AvatarGenerateResponse { job_id, status, result?, error? }
```

### Async Jobs

Avatar and video generation are asynchronous. Use `watchJob()` for real-time SSE streaming of job progress, or poll with `avatarJobStatus()`.

```ts
// Submit an avatar job
const job = await client.avatarGenerate({
  audio_url: 'https://...',
  image_url: 'https://...',
})
console.log(job.job_id) // 'job-abc123'
console.log(job.status) // 'queued'

// Watch until complete (SSE streaming)
const result = await client.watchJob(job.job_id, {
  onEvent: (e) => console.log(`${e.status} ${e.progress ?? ''}%`),
}) // returns JobEvent { status, progress?, result?, error?, timestamp }
console.log(result.result) // { video_url: 'https://...' }

// Or just poll
const status = await client.avatarJobStatus(job.job_id)
// returns AvatarJobStatus { job_id, status, result?, error? }
```

### Operator Routing

Route requests to specific operators or use strategy-based selection:

```ts
const client = new TCloud({
  apiKey: 'sk-tan-...',
  routing: {
    prefer: 'operator-slug',    // specific operator
    strategy: 'lowest-latency', // or 'lowest-price', 'highest-reputation'
    region: 'us-east',          // geographic preference
  },
})
```

The gateway selects the best operator based on a composite score (reputation 40%, latency 30%, price 30%) and returns the selection in response headers:

```ts
// After a request, check which operator served it:
// X-Tangle-Operator: <slug>
// X-Tangle-Price-Input: <per-token>
// X-Tangle-Price-Output: <per-token>
```

### Models and Operators

```ts
// List all available models
const models = await client.models() // returns Model[]
// Model: { id, name, context_length, pricing: { prompt, completion }, _provider? }
models.forEach(m => console.log(m.id, m._provider))

// Search models by name, provider, or capability
const llamas = await client.searchModels('llama') // returns Model[]
const anthropic = await client.searchModels('anthropic')

// List active operators with stats
const { operators, stats } = await client.operators()
// returns { operators: Operator[], stats: any }
// Operator: { id, slug, name, status, endpointUrl, reputationScore, avgLatencyMs, models, ... }
console.log(`${stats.activeOperators} operators serving ${stats.totalModels} models`)

// Check credit balance
const credits = await client.credits() // returns CreditBalance
// CreditBalance: { balance: number, transactions: [{ id, amount, type, description, createdAt }] }
console.log(`Balance: $${credits.balance}`)
```

### API Key Management

Create, list, and revoke API keys programmatically:

```ts
// Create a new key
const { key, id } = await client.createKey('my-app')
console.log(key) // sk-tan-... (shown once, store it)

// List all keys
const keys = await client.keys()
keys.forEach(k => console.log(k.name, k.prefix, k.lastUsedAt))

// Revoke a key
await client.revokeKey(id)
```

### Cost Estimation

Preview cost before sending a request:

```ts
const cost = await client.estimateCost({
  model: 'gpt-4o',
  inputTokens: 1000,
  outputTokens: 500,
}) // returns { inputCost: number, outputCost: number, total: number }
console.log(`Estimated: $${cost.total.toFixed(6)}`)
// { inputCost: 0.005, outputCost: 0.0075, total: 0.0125 }
```

### Spending Limits

Prevent runaway costs with per-request and total budget caps:

```ts
const client = new TCloud({
  apiKey: 'sk-tan-...',
  model: 'gpt-4o-mini',
  limits: {
    maxCostPerRequest: 0.01,     // $0.01 max per request
    maxTotalSpend: 1.00,         // $1.00 lifetime budget
    maxRequests: 100,            // hard request cap
    onLimitWarning: (info) => {
      console.warn(`${info.type} at ${info.current}/${info.limit}`)
    },
  },
})

// Requests that would exceed limits are blocked with TCloudError (429)
await client.ask('Hello')

// Check metering
const { totalSpent, requestCount } = client.usage
```

## CLI

### Authentication

```bash
tcloud auth login              # Browser-based device flow
tcloud auth set-key sk-tan-... # Set key directly
tcloud auth status             # Check current auth
```

### Chat

```bash
tcloud chat "Explain zero-knowledge proofs"
tcloud chat -m meta-llama/llama-4-maverick "Hello"
tcloud chat --private "Anonymous request"  # ShieldedCredits mode
tcloud chat                                # Interactive mode
```

### Browse

```bash
tcloud models                  # List available models
tcloud models -s llama         # Search models
tcloud operators               # List active operators
```

### Credits and Keys

```bash
tcloud credits balance         # Check balance
tcloud credits add 10          # Add credits
tcloud keys create my-app      # Create a new API key
tcloud keys list               # List keys
```

### Wallet Management

For private inference, manage ephemeral wallets:

```bash
tcloud wallet generate                    # Create wallet
tcloud wallet generate -l "research"      # With label
tcloud wallet list                        # List wallets
```

Wallets use BIP-39 mnemonics with BIP-44 derivation. Private keys are encrypted at rest with AES-256-GCM (PBKDF2 210K iterations).

## Configuration

Config stored in `~/.tcloud/config.json`:

```bash
tcloud config --api-url https://router.tangle.tools
tcloud config --model gpt-4o-mini
```

Environment variables:
- `TCLOUD_API_KEY` — API key (primary)
- `OPENAI_API_KEY` — Fallback API key (works because the API is OpenAI-compatible)
- `TCLOUD_BASE_URL` — Override API base URL

## OpenAI SDK Compatibility

tcloud's API is OpenAI-compatible. You can use the OpenAI SDK directly:

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: 'sk-tan-...',
  baseURL: 'https://router.tangle.tools/v1',
})

const completion = await client.chat.completions.create({
  model: 'meta-llama/llama-4-maverick',
  messages: [{ role: 'user', content: 'Hello' }],
})
```

## Vercel AI SDK Compatibility

Use with the Vercel AI SDK's OpenAI provider:

```ts
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'

const tangle = createOpenAI({
  apiKey: 'sk-tan-...',
  baseURL: 'https://router.tangle.tools/v1',
})

const { text } = await generateText({
  model: tangle('meta-llama/llama-4-maverick'),
  prompt: 'What is decentralized AI?',
})
```

## Examples

See the [`examples/`](./examples/) directory — each is a self-contained script:

| # | Example | What it shows |
|---|---------|---------------|
| 01 | [Quick Start](./examples/01-quick-start.ts) | Minimum viable setup |
| 02 | [Model Selection](./examples/02-model-selection.ts) | Three ways to pick a model, search, browse |
| 03 | [Streaming](./examples/03-streaming.ts) | Real-time SSE output, text + chunk modes |
| 04 | [Private Inference](./examples/04-private-inference.ts) | ShieldedCredits, ephemeral wallets, auto-replenish |
| 05 | [Operator Routing](./examples/05-operator-routing.ts) | Prefer operator, strategy, region, list operators |
| 06 | [Cost & Usage](./examples/06-cost-and-usage.ts) | Estimate cost, track tokens, check balance |
| 07 | [API Keys](./examples/07-api-keys.ts) | Create, list, revoke keys programmatically |
| 08 | [OpenAI SDK](./examples/08-openai-compat.ts) | Drop-in replacement via baseURL |
| 09 | [Vercel AI SDK](./examples/09-vercel-ai-sdk.ts) | generateText + streamText with Tangle |
| 10 | [Spending Limits](./examples/10-spending-limits.ts) | Budget caps, request limits, warning callbacks |

Run any example:
```bash
TCLOUD_API_KEY=sk-tan-... npx tsx examples/01-quick-start.ts
```

## License

[Apache-2.0](./LICENSE)
