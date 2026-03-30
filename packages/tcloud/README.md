# tcloud

TypeScript SDK and CLI for [Tangle AI Cloud](https://tangleai.cloud) — decentralized LLM inference with operator routing, reputation-based selection, and anonymous payments via ShieldedCredits.

Zero framework dependencies. Pure `fetch` + SSE. Works in Node.js, Deno, Bun, and edge runtimes.

## Table of Contents

- [Installation](#installation)
- [SDK](#sdk)
  - [Quick Start](#quick-start)
  - [Model Selection](#model-selection)
  - [Streaming](#streaming)
  - [Full Chat Completion](#full-chat-completion)
  - [Private Inference](#private-inference)
  - [Operator Routing](#operator-routing)
  - [Models and Operators](#models-and-operators)
  - [API Key Management](#api-key-management)
  - [Cost Estimation](#cost-estimation)
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

const client = new TCloud({ apiKey: 'sk-tan-...' })

const answer = await client.ask('What is Tangle Network?')
console.log(answer)
```

### Model Selection

Pass a model as the second argument to `ask`, `askStream`, or `askFull`:

```ts
// Default model (gpt-4o-mini)
await client.ask('Hello')

// Override with model string
await client.ask('Hello', 'claude-sonnet-4-6')
await client.ask('Hello', 'meta-llama/llama-4-maverick')

// Override with full options
await client.ask('Hello', { model: 'gpt-4o', temperature: 0.5 })

// Get full response (with model name, token usage, cost)
const full = await client.askFull('Hello', 'gpt-4o')
console.log(full.model, full.usage?.total_tokens)
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
})

console.log(completion.choices[0].message.content)
```

### Private Inference

Anonymous inference with no API key. Uses EIP-712 SpendAuth signatures — the operator verifies payment without learning your identity.

```ts
import { TCloud } from 'tcloud'

const client = TCloud.shielded()
const answer = await client.ask('Hello from the shadows')
```

Under the hood: generates an ephemeral wallet, signs a SpendAuth payload, and sends it as an `X-Payment-Signature` header. The operator validates the cryptographic proof and serves inference without knowing who you are.

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
const models = await client.models()
models.forEach(m => console.log(m.id, m._provider))

// Search models by name, provider, or capability
const llamas = await client.searchModels('llama')
const anthropic = await client.searchModels('anthropic')

// List active operators with stats
const { operators, stats } = await client.operators()
console.log(`${stats.activeOperators} operators serving ${stats.totalModels} models`)

// Check credit balance
const credits = await client.credits()
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
})
console.log(`Estimated: $${cost.total.toFixed(6)}`)
// { inputCost: 0.005, outputCost: 0.0075, total: 0.0125 }
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
tcloud config --api-url https://api.tangleai.cloud
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
  baseURL: 'https://api.tangleai.cloud/v1',
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
  baseURL: 'https://api.tangleai.cloud/v1',
})

const { text } = await generateText({
  model: tangle('meta-llama/llama-4-maverick'),
  prompt: 'What is decentralized AI?',
})
```

## Examples

See the [`examples/`](./examples/) directory:

- [`basic-chat.ts`](./examples/basic-chat.ts) — Simple chat completion
- [`streaming.ts`](./examples/streaming.ts) — Streaming responses
- [`private-inference.ts`](./examples/private-inference.ts) — Anonymous inference with ShieldedCredits
- [`openai-compat.ts`](./examples/openai-compat.ts) — Using the OpenAI SDK
- [`vercel-ai.ts`](./examples/vercel-ai.ts) — Using the Vercel AI SDK

## License

[Apache-2.0](./LICENSE)
