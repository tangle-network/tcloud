# @tangle-network/tcloud-agent

> Private autonomous AI agent for [Tangle AI Cloud](https://tangle.tools) — operator rotation, shielded credits, conversation summarization on operator switch. Build agents whose inference path no single operator can fully observe.

[![npm version](https://img.shields.io/npm/v/@tangle-network/tcloud-agent.svg)](https://www.npmjs.com/package/@tangle-network/tcloud-agent)
[![License: MIT/Apache-2.0](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)

## Why

Most agents leak their entire reasoning trail to a single LLM provider. Even "private" deployments concentrate logs, prompts, and tool I/O at one operator. **`tcloud-agent` rotates operators per request**, signs each call with a fresh shielded SpendAuth, and (optionally) summarizes context when switching — so no single operator sees a coherent slice of the conversation.

It composes the [TCloud SDK](https://www.npmjs.com/package/@tangle-network/tcloud) with a routing strategy, ephemeral wallets, and an agent loop you can drive directly or attach to [Pi](https://github.com/mariozechner/pi) / Claude Code.

---

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
  - [Standalone agent](#standalone-agent)
  - [Pi extension](#pi-extension)
  - [Claude Code skill](#claude-code-skill)
- [Privacy model](#privacy-model)
- [Configuration](#configuration)
  - [`PrivateAgentConfig`](#privateagentconfig)
  - [Routing strategies](#routing-strategies)
  - [Wallet rotation](#wallet-rotation)
  - [Context summarization](#context-summarization)
- [Examples](#examples)
  - [Minimum viable agent](#example-1-minimum-viable-agent)
  - [Pre-funded shielded wallet](#example-2-pre-funded-shielded-wallet)
  - [Strict privacy mode](#example-3-strict-privacy-mode)
  - [Multi-turn conversation with stats](#example-4-multi-turn-conversation-with-stats)
  - [Custom tool provider](#example-5-custom-tool-provider)
  - [Pi extension registration](#example-6-pi-extension-registration)
  - [Direct PrivateRouter usage](#example-7-direct-privaterouter-usage)
- [API reference](#api-reference)
- [Architecture](#architecture)
- [Comparison vs alternatives](#comparison-vs-alternatives)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## Install

```bash
pnpm add @tangle-network/tcloud-agent @tangle-network/tcloud
# npm install / yarn add also work
```

Peer dependencies (only needed for Pi-extension mode — skip if using as a standalone agent):

```bash
pnpm add -D @mariozechner/pi-coding-agent @mariozechner/pi-tui
```

Requires Node 20+.

---

## Quick start

### Standalone agent

```ts
import { PrivateAgent } from '@tangle-network/tcloud-agent'

const agent = new PrivateAgent({
  apiUrl: 'https://router.tangle.tools/v1',
  routing: { strategy: 'min-exposure' },
})

await agent.init()
const reply = await agent.chat('Summarize the latest research on RAG eval.')
console.log(reply)
console.log(agent.getPrivacyStats())
// → { totalRequests: 1, uniqueOperators: 1, avgExposure: 1.0, walletRotations: 0 }
```

The agent picks an operator, signs a SpendAuth, calls inference, and rotates on the next turn.

### Pi extension

If you use [Pi](https://github.com/mariozechner/pi), tcloud-agent ships as a drop-in extension. ALL inference goes through Tangle AI Cloud — Pi doesn't know it's been swapped.

```ts
// in your pi config
import tcloudExtension from '@tangle-network/tcloud-agent/pi-extension'

export default {
  extensions: [tcloudExtension],
}
```

Anonymous (rate-limited) works zero-config. `tcloud wallet create && tcloud credits fund` upgrades to full privacy.

### Claude Code skill

Wrap `PrivateAgent` in a `/tcloud` skill that routes prompts through rotating operators. Useful when you want to keep parts of a conversation off any single provider's logs.

```ts
// .claude/skills/tcloud/skill.ts
import { PrivateAgent } from '@tangle-network/tcloud-agent'

export async function ask(prompt: string): Promise<string> {
  const agent = new PrivateAgent({
    apiUrl: 'https://router.tangle.tools/v1',
    routing: { strategy: 'round-robin', maxRequestsPerOperator: 1 },
  })
  await agent.init()
  return agent.chat(prompt)
}
```

---

## Privacy model

| Threat | Mitigation |
|---|---|
| Single operator sees the whole conversation | Operators rotate per N requests (configurable, default 5) |
| Operator correlates requests via wallet address | Ephemeral shielded wallet per session, rotated every N turns |
| New operator gets stitched-together history | Optional summarization on switch — only the summary crosses the boundary |
| Replay attacks across operators | Each call signs a fresh SpendAuth + nonce |
| Long-running session leaks via timing | Wallet rotation ceiling (`maxTurnsPerWallet`) caps observable session length |

**Out of scope:** the Tangle gateway sees operator selection metadata (slug, region). If your threat model excludes the gateway, run a self-hosted gateway and point `apiUrl` there.

---

## Configuration

### `PrivateAgentConfig`

```ts
interface PrivateAgentConfig {
  /** Tangle AI Cloud API base URL */
  apiUrl: string
  /** Pre-existing shielded wallet (omit to generate ephemeral) */
  wallet?: { privateKey: string; commitment: string; salt: string }
  /** Operator routing strategy (see below) */
  routing?: Partial<PrivateRouterConfig>
  /** Inference model (default: gpt-4o-mini) */
  model?: string
  /** Cheaper model for context summarization (default: gpt-4o-mini) */
  summaryModel?: string
  /** Tangle chain id (default: 3799) */
  chainId?: number
  /** Override the credits contract address */
  creditsAddress?: string
  /** Auto-rotate wallet every N turns (default: 50) */
  maxTurnsPerWallet?: number
  /** Summarize context when switching operators (default: true) */
  summarizeOnSwitch?: boolean
}
```

### Routing strategies

| Strategy | Behavior | Use when |
|---|---|---|
| `min-exposure` | Picks the operator who has seen the fewest requests this session | You want maximum operator diversity (default) |
| `round-robin` | Cycles through operators in order | You want predictable rotation, simpler reasoning |
| `lowest-latency` | Picks the operator with the best observed p50 | Latency > privacy spread |
| `weighted-reputation` | Reputation-weighted selection | You trust reputation scores |

Set via `routing.strategy`.

### Wallet rotation

```ts
new PrivateAgent({
  apiUrl,
  maxTurnsPerWallet: 10,   // rotate after 10 turns
})
```

When the ceiling hits, the agent generates a new shielded wallet, funds it from the VAnchor pool (or fails if `wallet` was provided), and resets `turnCount`. Operators correlating across the rotation see two distinct wallet addresses with no on-chain link.

### Context summarization

When the router signals a switch (`shouldSummarize()`), the agent calls the **summary model** (cheaper) to compress the prior conversation into 2–4 sentences. The new operator receives only that summary, not the full transcript.

Disable for cost-sensitive workloads:

```ts
new PrivateAgent({ apiUrl, summarizeOnSwitch: false })
```

---

## Examples

### Example 1: Minimum viable agent

```ts
import { PrivateAgent } from '@tangle-network/tcloud-agent'

const agent = new PrivateAgent({ apiUrl: 'https://router.tangle.tools/v1' })
await agent.init()
console.log(await agent.chat('What is the capital of France?'))
```

Anonymous mode — rate-limited but zero setup.

### Example 2: Pre-funded shielded wallet

```ts
import { PrivateAgent } from '@tangle-network/tcloud-agent'

const agent = new PrivateAgent({
  apiUrl: 'https://router.tangle.tools/v1',
  wallet: {
    privateKey: process.env.SHIELDED_PK!,
    commitment: process.env.SHIELDED_COMMITMENT!,
    salt: process.env.SHIELDED_SALT!,
  },
})

await agent.init()
const reply = await agent.chat('Draft a confidential vendor brief')
```

Use a wallet you funded with `tcloud credits fund` for higher rate limits and persistent identity across sessions.

### Example 3: Strict privacy mode

```ts
const agent = new PrivateAgent({
  apiUrl: 'https://router.tangle.tools/v1',
  routing: {
    strategy: 'min-exposure',
    maxRequestsPerOperator: 1,   // every request gets a fresh operator
    minOperators: 5,             // refuse to start with fewer than 5 in pool
  },
  maxTurnsPerWallet: 5,           // ephemeral wallet every 5 turns
  summarizeOnSwitch: true,
})

await agent.init()
```

Maximum operator spread, frequent wallet rotation, summary-on-switch — every request is a privacy boundary. Cost-aware: each rotation incurs a summarization call.

### Example 4: Multi-turn conversation with stats

```ts
const agent = new PrivateAgent({ apiUrl: 'https://router.tangle.tools/v1' })
await agent.init()

await agent.chat('I am researching dietary patterns in athletes.')
await agent.chat('What does the literature say about creatine timing?')
await agent.chat('Build me a 7-day meal plan.')

console.log(agent.getPrivacyStats())
// → {
//     totalRequests: 3,
//     uniqueOperators: 2,
//     avgExposure: 1.5,
//     walletRotations: 0,
//     conversationLength: 6
//   }

// Inspect what each operator saw
for (const msg of agent.getConversation()) {
  console.log(`[${msg.operator ?? 'self'}] ${msg.role}: ${msg.content.slice(0, 80)}`)
}
```

### Example 5: Custom tool provider

```ts
import { PrivateAgent, TangleToolProvider, type CapabilityHandler } from '@tangle-network/tcloud-agent'

const handlers: CapabilityHandler[] = [
  {
    name: 'search_arxiv',
    description: 'Search arXiv for a query',
    parameters: { query: { type: 'string' } },
    execute: async ({ query }) => {
      const res = await fetch(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=5`)
      return { results: await res.text() }
    },
  },
]

const tools = new TangleToolProvider({ handlers })
const agent = new PrivateAgent({
  apiUrl: 'https://router.tangle.tools/v1',
  // pass tools to inference via your own request adapter — see API ref
})
```

### Example 6: Pi extension registration

```ts
// pi.config.ts
import tcloudExtension from '@tangle-network/tcloud-agent/pi-extension'

export default {
  extensions: [
    tcloudExtension,
    // your other extensions...
  ],
}
```

After registration, all Pi-driven inference flows through Tangle AI Cloud. Pi will use your shielded wallet automatically if you've run `tcloud wallet create` + `tcloud credits fund`.

### Example 7: Direct `PrivateRouter` usage

Sometimes you don't want the full agent — just the rotation logic:

```ts
import { PrivateRouter, type OperatorInfo } from '@tangle-network/tcloud-agent'

const router = new PrivateRouter({
  strategy: 'round-robin',
  maxRequestsPerOperator: 3,
  minOperators: 2,
})

const operators: OperatorInfo[] = await fetchOperators()
router.setOperators(operators)

for (const message of messages) {
  const op = router.selectOperator('gpt-4o-mini')
  if (router.shouldSummarize('gpt-4o-mini')) {
    // your summarization step
  }
  await callOperator(op, message)
}
```

Useful when you have your own conversation manager but want operator rotation as a primitive.

---

## API reference

### `PrivateAgent`

| Method | Signature | Description |
|---|---|---|
| `constructor` | `(config: PrivateAgentConfig)` | Build an agent. Does not contact the network. |
| `init` | `(): Promise<void>` | Fetches the operator pool from the gateway. Required before `chat`. |
| `chat` | `(message: string): Promise<string>` | One conversational turn. Selects operator, signs SpendAuth, inferences, returns assistant reply. |
| `getPrivacyStats` | `(): { totalRequests, uniqueOperators, avgExposure, walletRotations, conversationLength }` | Privacy telemetry for the current session. |
| `getConversation` | `(): ConversationMessage[]` | Full message history (useful for inspection). |
| `clearConversation` | `(): void` | Reset history without rotating wallet. |
| `setSystemPrompt` | `(prompt: string): void` | Replace or set the system prompt for subsequent turns. |

### `PrivateRouter`

Re-exported from `@tangle-network/tcloud`. See the [TCloud SDK docs](https://www.npmjs.com/package/@tangle-network/tcloud) for full reference.

### `TangleToolProvider`

Helper for building OpenAI-tool-call-compatible tool registries against Tangle gateway capabilities.

```ts
class TangleToolProvider {
  constructor(opts: { handlers: CapabilityHandler[] })
  toOpenAITools(): OpenAITool[]
  invoke(name: string, args: unknown): Promise<ToolResult>
}
```

---

## Architecture

```
                     ┌──────────────────────────────────┐
                     │  PrivateAgent                    │
                     │  - conversation state            │
                     │  - turn counter                  │
                     │  - wallet rotation               │
                     └──┬───────────────────────────────┘
                        │
       ┌────────────────┴───────────────────┐
       │                                    │
       ▼                                    ▼
┌─────────────────┐               ┌──────────────────────┐
│ PrivateRouter   │               │ Shielded Wallet      │
│ - strategy      │               │ - signSpendAuth()    │
│ - operator pool │               │ - generateWallet()   │
│ - exposure map  │               │ - VAnchor funding    │
└─────────────────┘               └──────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────┐
│ Operator (rotates per request)              │
│ - signed SpendAuth + nonce                  │
│ - cannot link to prior operator's session   │
└─────────────────────────────────────────────┘
```

The agent owns conversation state. The router owns operator selection. The wallet owns spend authorization. Each layer is replaceable independently — you can swap routing strategies, plug in your own wallet manager, or drive the router directly without the agent loop.

---

## Comparison vs alternatives

| | tcloud-agent | LangChain agent | Vercel AI SDK | Claude Agent SDK |
|---|---|---|---|---|
| Browser-runnable | partial | yes | yes | no (subprocess) |
| Multi-operator privacy | ✅ | ❌ | ❌ | ❌ |
| Operator rotation | ✅ built-in | ❌ | ❌ | ❌ |
| Shielded payments | ✅ | ❌ | ❌ | ❌ |
| Tool calls | ✅ | ✅ | ✅ | ✅ |
| Streaming | via TCloud SDK | ✅ | ✅ | ✅ |
| Conversation summarization | ✅ on operator switch | manual | manual | manual |

**Use tcloud-agent when:** the privacy property (no single operator sees a coherent conversation slice) is load-bearing to your product. Otherwise, Vercel AI SDK + `@ai-sdk/openai-compatible` against the Tangle router gives you 90% of the ergonomics with a smaller surface.

---

## FAQ

**Q: Does this require crypto on-chain to use?**
A: No. Anonymous mode (rate-limited) needs zero setup. Shielded mode requires a funded wallet, which you create via the `tcloud` CLI; that's an on-chain action.

**Q: How does this differ from running a single private LLM provider?**
A: A single private provider sees your entire conversation. tcloud-agent splits the conversation across multiple operators with explicit summarization at each boundary, so no single operator can reconstruct the full thread.

**Q: Can I use this in the browser?**
A: The core `PrivateAgent` runs in Node 20+ today (uses `viem` + `crypto`). The `PrivateRouter` is browser-safe. Browser support for the full agent is on the roadmap once SpendAuth signing has a WASM path.

**Q: What models are available?**
A: Whatever the Tangle router operators advertise. As of publish time: Claude (haiku/sonnet/opus), GPT-4o, DeepSeek, Llama 3.1, Gemini 2.5 Flash. Free-tier models work without funded credits.

**Q: How is this different from `@tangle-network/tcloud`?**
A: `@tangle-network/tcloud` is the SDK (chat, embeddings, image, tools). `@tangle-network/tcloud-agent` adds the agent loop, privacy router, and wallet rotation on top of it. Use the SDK directly if you only need a single-operator inference call.

---

## Contributing

PRs welcome. The code lives in [tangle-network/tcloud](https://github.com/tangle-network/tcloud) (the `packages/tcloud-agent/` directory).

```bash
git clone https://github.com/tangle-network/tcloud
cd tcloud
pnpm install
pnpm --filter @tangle-network/tcloud-agent build
pnpm --filter @tangle-network/tcloud-agent test
```

---

## License

Dual-licensed under either:

- [MIT License](./LICENSE-MIT)
- [Apache License 2.0](./LICENSE-APACHE)

at your option.
