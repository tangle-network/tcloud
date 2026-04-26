# @tangle-network/tcloud-agent

> Agent run-loop primitive for [Tangle AI Cloud](https://tangle.tools). Runs an `AgentProfile` against a brief, evaluates criterion gates after each iteration, respects budget caps, and streams events. Use it when you need a `run-until-verified` loop over the Tangle sandbox bridge — without rebuilding the iteration / verification / budget plumbing yourself.

[![npm version](https://img.shields.io/npm/v/@tangle-network/tcloud-agent.svg)](https://www.npmjs.com/package/@tangle-network/tcloud-agent)
[![License: MIT/Apache-2.0](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](#license)

## Why

Most agent libraries either (a) ship a giant framework with opinions baked in (LangChain, Claude Agent SDK), or (b) give you a streaming-chat primitive and leave the loop to you (Vercel AI SDK). `tcloud-agent` is the third thing: a **single tight run-loop** that knows about *iterations*, *verification gates*, and *budget* — and nothing else. You bring the profile, the brief, and the criteria; it handles the loop and the streaming.

It composes the [Tangle TCloud SDK](https://www.npmjs.com/package/@tangle-network/tcloud) and runs over the sandbox-harness `BridgeSession`, so every iteration goes through Tangle routing with full control over operators, models, and policies.

---

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
  - [`AgentRunOptions`](#agentrunoptions)
  - [`AgentRunCriterion`](#agentruncriterion)
  - [`AgentBudget`](#agentbudget)
  - [`AgentRunResult` and verdicts](#agentrunresult-and-verdicts)
  - [Streaming events](#streaming-events)
- [Examples](#examples)
  - [Minimal `run()`](#example-1-minimal-run)
  - [Stream events to stdout](#example-2-stream-events-to-stdout)
  - [Cataloged profile + custom criteria](#example-3-cataloged-profile--custom-criteria)
  - [Budget-bounded loop](#example-4-budget-bounded-loop)
  - [Workspace-bound run](#example-5-workspace-bound-run)
  - [Inline `AgentProfile` from `@tangle-network/sandbox`](#example-6-inline-agentprofile)
  - [Resume a session across calls](#example-7-resume-a-session-across-calls)
  - [TangleToolProvider for Pi](#example-8-tangletoolprovider-for-pi)
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

Peer dependencies (only needed for the Pi-extension entry point — skip if you're driving the agent from a server / CLI):

```bash
pnpm add -D @mariozechner/pi-coding-agent @mariozechner/pi-tui
```

Requires Node 20+.

---

## Quick start

```ts
import { TCloud } from '@tangle-network/tcloud'
import { agent } from '@tangle-network/tcloud-agent'

const client = new TCloud({ apiKey: process.env.TCLOUD_API_KEY! })

const result = await agent(client, {
  profile: 'sf-proposer',
  brief: 'Scaffold a Vite + React package and confirm pnpm build passes.',
  criteria: [
    { name: 'build-passes', check: async (ctx) => ({ ok: ctx.lastMessage.includes('pnpm build: ok') }) },
  ],
  budget: { iterations: 5, wallSec: 600, usd: 1 },
}).run()

console.log(result.verdict)        // 'verified' | 'blocked' | 'budget-exhausted' | 'error'
console.log(result.iterations)     // how many turns it took
console.log(result.usd)            // approximate spend (null if upstream didn't report usage)
console.log(result.transcript)     // full conversation
```

Five lines of config, one `await`. The loop runs until *every* criterion returns `{ ok: true }`, the budget exhausts, or an error escapes the bridge.

---

## Concepts

### `AgentRunOptions`

| Field | Type | Description |
|---|---|---|
| `profile` | `AgentProfile \| string` | Inline profile object (from `@tangle-network/sandbox`) or a cataloged profile id resolved server-side |
| `brief` | `string` | First user turn — what the agent is being asked to do |
| `criteria?` | `AgentRunCriterion[]` | Completion gates evaluated after each iteration. Empty/undefined ⇒ first reply verifies. |
| `budget?` | `AgentBudget` | `{ iterations?, wallSec?, usd? }` — first breach exits with `budget-exhausted` |
| `resume?` | `string` | Pass-through to `BridgeOptions.resume` for session continuity |
| `workspace?` | `{ dir: string }` | Bind a local directory; surfaced on `AgentRunContext.workspaceDir` and appended to the brief |
| `unlock?` | `string` | `BridgeOptions.unlock`. Falls back to `process.env.BRIDGE_UNLOCK`. |
| `bridgeUrl?` | `string` | BYOB cli-bridge URL (forwarded to `BridgeOptions.bridgeUrl`) |
| `bridgeBearer?` | `string` | BYOB cli-bridge bearer token |
| `stream?` | `boolean` | `false` to disable SSE — each iteration calls `chat()` non-streaming, emits one `message.delta` per turn. Default `true`. |

### `AgentRunCriterion`

```ts
interface AgentRunCriterion {
  name: string  // stable id; surfaced on result.blockedBy if it fails
  check: (ctx: AgentRunContext) => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string }
}
```

Criteria are checked in order **after each assistant turn**. If any criterion returns `ok: false`, the loop continues to the next iteration with the criterion's `reason` appended as a follow-up user message. When *all* criteria pass, verdict is `verified`.

Empty `criteria` ⇒ the first assistant reply auto-verifies.

### `AgentBudget`

```ts
interface AgentBudget {
  iterations?: number  // max loop iterations
  wallSec?: number     // wall-clock cap; first breach exits
  usd?: number         // best-effort spend cap (relies on ChatCompletion.usage)
}
```

Any field can be omitted. The first breach wins; verdict is `budget-exhausted`.

### `AgentRunResult` and verdicts

```ts
interface AgentRunResult {
  verdict: 'verified' | 'blocked' | 'budget-exhausted' | 'error'
  iterations: number
  wallMs: number
  usd: number | null         // null when no usage was reported
  transcript: { role: 'user' | 'assistant' | 'system'; content: string }[]
  blockedBy?: string         // criterion.name when verdict === 'blocked'
  error?: string             // captured message when verdict === 'error'
}
```

`run()` **never throws** — bridge failures land as `verdict: 'error'` with the message captured. Branch on `verdict`, not on try/catch.

### Streaming events

`stream()` emits `AgentEvent`s in this order per iteration:

```
iteration.start
  → message.delta*           (zero or more, may interleave with tool events)
  → tool.call.start*
  → tool.call.result*
  → iteration.complete
  → criterion.check*         (one per evaluated criterion)
... next iteration, or:
verdict                       (terminal — same payload as run() returns)
```

`tool.call.*` events are reserved in the union and only fire when the upstream bridge surfaces tool parts via non-standard delta fields. Most runs see `iteration.* + message.delta + criterion.check + verdict` only.

---

## Examples

### Example 1: Minimal `run()`

```ts
import { TCloud } from '@tangle-network/tcloud'
import { agent } from '@tangle-network/tcloud-agent'

const client = new TCloud({ apiKey: process.env.TCLOUD_API_KEY! })
const result = await agent(client, {
  profile: 'sf-proposer',
  brief: 'Reply with the literal text "ok".',
}).run()

console.log(result.verdict, '·', result.iterations, 'iter')
```

No criteria, no budget — first reply ⇒ verdict `verified`. Useful for smoke tests.

### Example 2: Stream events to stdout

```ts
for await (const ev of agent(client, opts).stream()) {
  switch (ev.type) {
    case 'iteration.start':
      process.stdout.write(`\n[iter ${ev.iteration}] `)
      break
    case 'message.delta':
      process.stdout.write(ev.text)
      break
    case 'criterion.check':
      process.stdout.write(`\n  ${ev.ok ? '✓' : '✗'} ${ev.name}${ev.reason ? ` — ${ev.reason}` : ''}\n`)
      break
    case 'verdict':
      process.stdout.write(`\n[verdict: ${ev.verdict}, ${ev.iterations} iter, $${ev.usd ?? '?'}]\n`)
      break
  }
}
```

Live observability into the loop — exactly what `run()` consumes internally.

### Example 3: Cataloged profile + custom criteria

```ts
const result = await agent(client, {
  profile: 'sf-proposer',
  brief: 'Scaffold an agent-runtime bundle for a music-producer agent.',
  criteria: [
    {
      name: 'manifest-valid',
      check: async (ctx) => {
        const m = ctx.lastMessage.match(/^\{[\s\S]+\}$/m)
        try {
          JSON.parse(m?.[0] ?? '')
          return { ok: true }
        } catch (err) {
          return { ok: false, reason: `manifest is not valid JSON: ${(err as Error).message}` }
        }
      },
    },
    {
      name: 'has-frontmatter',
      check: async (ctx) => ({
        ok: /^---\n[\s\S]+?\n---/m.test(ctx.lastMessage),
        reason: 'system-prompt.md frontmatter missing',
      }),
    },
  ],
}).run()

if (result.verdict === 'blocked') {
  console.error(`blocked by: ${result.blockedBy}`)
}
```

When a criterion fails, the loop appends `Previous attempt failed: <reason>` as the next user turn — the agent gets to fix it without you re-prompting.

### Example 4: Budget-bounded loop

```ts
const result = await agent(client, {
  profile: 'sf-proposer',
  brief: 'Generate 50 manifest variants and report which pass schema validation.',
  budget: {
    iterations: 8,    // hard cap on loop count
    wallSec: 300,     // 5 minutes wall clock
    usd: 2,           // soft cap — relies on usage reporting
  },
}).run()

if (result.verdict === 'budget-exhausted') {
  console.warn(`stopped at ${result.iterations} iter / ${result.wallMs}ms / $${result.usd}`)
}
```

Caps are checked at iteration boundaries. First breach wins — useful for cron jobs and CI gates.

### Example 5: Workspace-bound run

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const workspace = mkdtempSync(join(tmpdir(), 'agent-run-'))

const result = await agent(client, {
  profile: 'sf-proposer',
  brief: 'Write the manifest into manifest.json under the workspace dir.',
  workspace: { dir: workspace },
  criteria: [
    {
      name: 'file-written',
      check: async (ctx) => {
        const { existsSync } = await import('node:fs')
        return {
          ok: existsSync(`${ctx.workspaceDir}/manifest.json`),
          reason: 'manifest.json missing in workspace',
        }
      },
    },
  ],
}).run()
```

The workspace path is appended to the brief so the agent knows where to `cd`, and surfaces on `ctx.workspaceDir` for filesystem-aware criteria. Pair with the sandbox-harness file write tool.

### Example 6: Inline `AgentProfile`

```ts
import type { AgentProfile } from '@tangle-network/sandbox'

const profile: AgentProfile = {
  name: 'one-off-reviewer',
  systemPrompt: 'You review TypeScript diffs and report PASS or FAIL with a one-line justification.',
  capabilities: { /* ... */ },
}

const result = await agent(client, {
  profile,                            // inline, not cataloged
  brief: 'Review this diff:\n```diff\n... \n```',
}).run()
```

Drop in any `AgentProfile` object directly — no server-side catalog lookup, no extra round-trip.

### Example 7: Resume a session across calls

```ts
const first = await agent(client, {
  profile: 'sf-proposer',
  brief: 'Plan the family scaffold; reply with the plan only.',
}).run()

const second = await agent(client, {
  profile: 'sf-proposer',
  brief: 'Implement the plan you just produced.',
  resume: first.transcript[0]?.content?.startsWith('session:') ? /* extract id */ '' : undefined,
}).run()
```

`resume` forwards to `BridgeOptions.resume` — when the bridge supports it, the second agent starts on top of the first agent's session state.

### Example 8: `TangleToolProvider` for Pi

```ts
import { TangleToolProvider, type CapabilityHandler } from '@tangle-network/tcloud-agent'

const handlers: CapabilityHandler[] = [
  {
    name: 'tangle_search',
    description: 'Search the Tangle docs',
    parameters: { query: { type: 'string' } },
    execute: async ({ query }) => ({
      results: await fetch(`https://docs.tangle.tools/search?q=${encodeURIComponent(query as string)}`).then(r => r.text()),
    }),
  },
]

const provider = new TangleToolProvider({ handlers })
const tools = provider.toOpenAITools()       // hand to your chat call
await provider.invoke('tangle_search', { query: 'sandbox bridge' })
```

Use directly with any OpenAI-compatible chat surface, or register the package as a Pi extension via the `./pi-extension` subpath.

---

## API reference

### `agent(client, options)` / `new Agent(client, options)`

Build a runnable agent. Identical surface — function form is just `new Agent(...)`.

| Method | Signature | Description |
|---|---|---|
| `run` | `(): Promise<AgentRunResult>` | Run to completion. Never throws — failures land on `result.verdict === 'error'`. |
| `stream` | `(): AsyncIterable<AgentEvent>` | Event stream. Final event is always `{ type: 'verdict', ... }`. |

`run()` is a thin consumer of `stream()` — the loop logic lives once.

### Re-exports

`Agent`, `agent`, all `AgentRun*` types, `AgentEvent`, `TextPart`, `ToolPart`, `ToolState`, `TangleToolProvider`, `CapabilityHandler`, `ToolResult`.

### Subpath: `@tangle-network/tcloud-agent/pi-extension`

Drop-in [Pi](https://github.com/mariozechner/pi) extension that registers the agent runner + `TangleToolProvider` into a Pi config. Peer-installable; requires `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui`.

```ts
import tcloudExtension from '@tangle-network/tcloud-agent/pi-extension'

export default {
  extensions: [tcloudExtension],
}
```

---

## Architecture

```
                ┌─────────────────────────────┐
                │  Agent  /  agent()          │
                │  - iteration counter        │
                │  - criteria evaluation      │
                │  - budget tracker           │
                │  - event emitter            │
                └──┬───────────────────┬──────┘
                   │                   │
                   ▼                   ▼
        ┌──────────────────┐   ┌──────────────────┐
        │  TCloudClient    │   │  Sandbox Bridge  │
        │  .bridge(...)    │──▶│  BridgeSession   │
        └──────────────────┘   │  (chat / stream) │
                               └────────┬─────────┘
                                        │
                                        ▼
                                ┌────────────────┐
                                │ Tangle Router  │
                                │  + Operators   │
                                └────────────────┘
```

The runner owns the loop — it does not own the model, the operator, or the wallet. Those live in the TCloud SDK's `bridge()` surface. Want operator rotation? Use [`TCloudClient.rotating()`](https://www.npmjs.com/package/@tangle-network/tcloud) — that's a *client-level* rotation strategy, separate from the agent loop.

---

## Comparison vs alternatives

| | tcloud-agent | LangChain agent | Vercel AI SDK | Claude Agent SDK |
|---|---|---|---|---|
| Loop primitive | ✅ minimal | heavy framework | none (DIY loop) | subprocess runtime |
| Streaming events | ✅ typed union | yes | yes | yes |
| Criterion gates | ✅ first-class | manual | manual | manual |
| Budget caps | ✅ first-class | manual | manual | manual |
| Workspace binding | ✅ first-class | manual | manual | implicit |
| Verdict shape | typed enum | string | string | string |
| Browser-runnable | partial (Node 20+ today) | yes | ✅ | ❌ subprocess |
| Tangle routing / sandbox | ✅ native | adapter | adapter | n/a |

**Use `tcloud-agent` when:** you want a small, opinionated run-loop primitive over Tangle infrastructure with built-in criterion + budget gates. **Skip it when:** you only need a single chat call (use the TCloud SDK directly) or you want a full agent framework with planners / memory / tool registries (LangChain or Mastra).

---

## FAQ

**Q: How does this differ from `@tangle-network/tcloud`?**
A: TCloud is the SDK — single chat / completion / embedding calls, plus `.bridge()` for sandbox-harness sessions and `.rotating()` for operator rotation. tcloud-agent adds the *iteration* / *verification* / *budget* loop on top. Use the SDK directly for one-shot calls; use tcloud-agent when you need run-until-verified semantics.

**Q: What is "the bridge"?**
A: `TCloudClient.bridge(options)` opens a `BridgeSession` that proxies chat traffic through the Tangle sandbox-harness. The agent runs each iteration through that bridge so requests inherit Tangle routing, attestation, and policy enforcement.

**Q: Can I use this without the bridge / sandbox?**
A: The runner depends on `client.bridge(...)`. If you want a plain ChatCompletions agent, the loop logic itself is small — copy it and back it with `client.chat()` directly.

**Q: Are tool calls supported?**
A: The event union reserves `tool.call.*` events. Today they only fire when the bridge surfaces tool parts via non-standard delta fields. Standard OpenAI-shaped tool-call events flow through `message.delta` until the upstream bridge protocol exposes them as separate parts.

**Q: What happened to `PrivateAgent`?**
A: Retired. Operator rotation moved into the SDK as `TCloudClient.rotating()` because it's a per-call concern, not a multi-iteration concern. `tcloud-agent@0.1.0` shipped the old API and is deprecated; `0.3.0+` is the run-loop primitive documented here.

---

## Contributing

Code lives in [tangle-network/tcloud](https://github.com/tangle-network/tcloud) under `packages/tcloud-agent/`.

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
