# tcloud

SDK, CLI, and private agent for [Tangle AI Cloud](https://tangleai.cloud) -- decentralized AI inference with optional privacy via ShieldedCredits.

## Packages

| Package | Description |
|---------|-------------|
| [`tcloud`](./packages/tcloud) | SDK + CLI. Drop-in OpenAI replacement with operator routing and x402 shielded payments. |
| [`tcloud-agent`](./packages/tcloud-agent) | Private AI agent with operator rotation. Pi extension for transparent private inference. |

## Quick Start

```bash
pnpm install
pnpm build
```

### SDK

```ts
import { TCloud } from 'tcloud'

// Standard mode (API key auth)
const client = new TCloud({ apiKey: 'sk-tan-...' })
const response = await client.ask('What is Tangle?')

// Private mode (anonymous, no API key)
const shielded = TCloud.shielded()
const answer = await shielded.ask('Hello from the shadows')
```

### CLI

```bash
# Auth
tcloud auth login          # browser device flow
tcloud auth set-key sk-... # direct key

# Chat
tcloud chat "Hello"
tcloud chat --private "Anonymous hello"
tcloud chat                # interactive mode

# Models & operators
tcloud models
tcloud operators

# Shielded wallet
tcloud wallet generate
tcloud credits balance
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
console.log(agent.getPrivacyStats())
```

## License

MIT
