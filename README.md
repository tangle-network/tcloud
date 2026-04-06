# tcloud

TypeScript SDK, CLI, and private inference agent for [Tangle AI Cloud](https://router.tangle.tools) — decentralized LLM inference with operator routing, reputation-based selection, and anonymous payments via ShieldedCredits.

**`npm install @tangle-network/tcloud`**

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`@tangle-network/tcloud`](./packages/tcloud/) | SDK + CLI | [![npm](https://img.shields.io/npm/v/@tangle-network/tcloud)](https://www.npmjs.com/package/@tangle-network/tcloud) |
| [`tcloud-agent`](./packages/tcloud-agent/) | Private inference agent + Pi extension | — |

## Quick Start

```ts
import { TCloud } from '@tangle-network/tcloud'

const client = new TCloud({ apiKey: 'sk-tan-...' })

// Chat
const answer = await client.ask('What is Tangle?')

// Streaming
for await (const chunk of client.askStream('Explain decentralized AI')) {
  process.stdout.write(chunk)
}

// Private mode (anonymous, no API key needed)
const shielded = TCloud.shielded()
await shielded.ask('Hello from the shadows')
```

## All Endpoints

The SDK covers every endpoint the router serves:

```ts
// Chat (OpenAI-compatible)
await client.chat({ model: 'gpt-4o', messages: [...] })
await client.chatStream({ model: 'claude-sonnet-4-5', messages: [...] })
await client.ask('Quick question')

// Completions (legacy)
await client.completions({ prompt: 'Hello,' })

// Embeddings
await client.embeddings({ model: 'text-embedding-3-small', input: 'Hello world' })

// Images
await client.imageGenerate({ model: 'dall-e-3', prompt: 'A cat in space' })

// Audio
await client.speech({ model: 'tts-1', input: 'Hello', voice: 'alloy' })
await client.transcribe(audioBlob)

// Rerank
await client.rerank({ query: 'AI', documents: ['doc1', 'doc2'] })

// Fine-tuning
await client.fineTuneCreate({ model: 'gpt-4o-mini', training_file: 'file-abc123' })
await client.fineTuneList()

// Batch
await client.batch([{ model: 'gpt-4o', messages: [...] }])
await client.batchStatus('batch-id')

// Video
await client.videoGenerate({ prompt: 'A sunset timelapse' })
await client.videoStatus('video-id')

// Models & operators
await client.models()
await client.searchModels('llama')
await client.operators()
```

## Blueprint Routing

Route requests to specific Tangle Blueprint operators:

```ts
const client = new TCloud({
  apiKey: 'sk-tan-...',
  routing: {
    mode: 'operator',           // 'operator' | 'provider' | 'auto'
    blueprintId: '1',           // route to operators under this Blueprint
    serviceId: '42',            // pin to a specific service instance
    prefer: '0x70997970...',    // pin to a specific operator address
    strategy: 'lowest-latency', // routing strategy
  },
})
```

## Private Agent

```ts
import { PrivateAgent } from 'tcloud-agent'

const agent = new PrivateAgent({
  apiUrl: 'https://router.tangle.tools/v1',
  routing: { strategy: 'min-exposure' },
})
await agent.init()
const response = await agent.chat('Hello privately')
console.log(agent.getPrivacyStats())
```

Rotation strategies: `round-robin`, `random`, `geo-distributed`, `min-exposure`, `latency-aware`

## CLI

```bash
npx tcloud chat "Hello"              # chat
npx tcloud chat --private "Anon"     # anonymous inference
npx tcloud models                    # list models
npx tcloud operators                 # list operators
npx tcloud wallet generate           # create shielded wallet
npx tcloud credits balance           # check credits
```

## Architecture

```
@tangle-network/tcloud (SDK + CLI)
  ├── TCloudClient — OpenAI-compatible, covers all 11 v1 endpoints
  ├── ShieldedClient — EIP-712 SpendAuth, auto-replenish, privacy proxy
  ├── Routing — X-Tangle-Blueprint / Service / Operator / Routing headers
  └── CLI — chat, models, operators, credits, wallet

tcloud-agent
  ├── PrivateAgent — operator rotation, wallet lifecycle, context summarization
  ├── PrivateRouter — 5 strategies (round-robin, random, geo, min-exposure, latency)
  └── Pi extension — tcloud_infer + tcloud_wallet tools (Pi 0.65+)
```

## License

[Apache-2.0](./packages/tcloud/LICENSE)
