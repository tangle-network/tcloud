# tcloud

TypeScript SDK, CLI, agent, and relayer for [Tangle AI Cloud](https://tangleai.cloud) — decentralized LLM inference with operator routing, reputation-based selection, and anonymous payments via ShieldedCredits.

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| [`tcloud`](./packages/tcloud/) | SDK + CLI — OpenAI-compatible client with operator routing and x402 payments | `npm install tcloud` |
| [`tcloud-agent`](./packages/tcloud-agent/) | Private inference agent with operator rotation + Pi extension | — |
| [`tcloud-relayer`](./packages/tcloud-relayer/) | Gas relay + privacy proxy for shielded payments | — |

## Quick Start

```bash
npm install tcloud
npx tcloud chat "What is Tangle?"
```

### SDK

```ts
import { TCloud } from 'tcloud'

const client = new TCloud({ apiKey: 'sk-tan-...' })
const answer = await client.ask('What is Tangle?')

// Streaming
for await (const chunk of client.askStream('Explain decentralized AI')) {
  process.stdout.write(chunk)
}

// Private mode (anonymous, no API key)
const shielded = TCloud.shielded()
const private_answer = await shielded.ask('Hello from the shadows')
```

### CLI

```bash
tcloud auth set-key sk-tan-...   # authenticate
tcloud chat "Hello"              # chat
tcloud chat --private "Anon"     # anonymous inference
tcloud models                    # list models
tcloud operators                 # list operators
tcloud wallet generate           # create shielded wallet
tcloud credits balance           # check credits
```

### Private Agent

```ts
import { PrivateAgent } from 'tcloud-agent'

const agent = new PrivateAgent({
  apiUrl: 'https://api.tangleai.cloud',
  routing: { strategy: 'min-exposure' },
})
await agent.init()
const response = await agent.chat('Hello privately')
```

## Architecture

```
tcloud (SDK + CLI)
  ├── TCloudClient — pure fetch, zero deps, OpenAI-compatible
  ├── CLI — chat, models, operators, credits, wallet
  └── ShieldedClient — EIP-712 SpendAuth, auto-replenish, privacy proxy

tcloud-agent
  ├── PrivateAgent — conversation management, context summarization
  ├── PrivateRouter — round-robin, random, geo, min-exposure, latency-aware
  └── Pi extension — tcloud_infer + tcloud_wallet tools

tcloud-relayer
  ├── /relay/fund-credits — gas relay for shielded deposits
  ├── /relay/withdraw — gas relay for withdrawals
  ├── /relay/proxy — privacy proxy (strips identifying headers)
  └── /relay/proxy-stream — SSE privacy proxy for streaming
```

## Development

```bash
pnpm install
pnpm build            # build all packages
pnpm dev              # dev mode for SDK/CLI
pnpm dev:relayer      # dev mode for relayer
```

## License

[Apache-2.0](./packages/tcloud/LICENSE)
