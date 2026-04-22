/**
 * Direct cli-bridge — point the SDK straight at a local cli-bridge,
 * skipping the Tangle Router. cli-bridge is OpenAI-compatible
 * (`/v1/chat/completions`), so the standard chat() / ask() /
 * chatStream() methods work unchanged — only the baseURL changes.
 *
 * Use this when you have your own cli-bridge running (laptop, VPS,
 * docker container, anywhere reachable) and don't need router-side
 * gating, billing, or observability. Your CLI subscriptions on the
 * bridge box pay for the LLM tokens directly.
 *
 * Setup:
 *   1. Clone + run cli-bridge:
 *        gh repo clone drewstone/cli-bridge
 *        cd cli-bridge
 *        # generate a bearer:
 *        echo "BRIDGE_BEARER=$(openssl rand -hex 32)" >> .env.local
 *        echo "BRIDGE_BACKENDS=claude,passthrough" >> .env.local
 *        export $(grep -v '^#' .env.local | xargs) && pnpm exec tsx src/server.ts
 *   2. Authenticate the harness CLI you want to drive:
 *        claude /login        # for claude-code
 *        kimi login           # for kimi-code (pipx install kimi-cli)
 *        codex login          # for codex
 *   3. Run this example:
 *        CLI_BRIDGE_URL=http://127.0.0.1:3344 \
 *        CLI_BRIDGE_BEARER=<value from .env.local> \
 *        npx tsx examples/14-direct-cli-bridge.ts
 */

import { TCloudClient } from '@tangle-network/tcloud'

const URL = process.env.CLI_BRIDGE_URL ?? 'http://127.0.0.1:3344'
const BEARER = process.env.CLI_BRIDGE_BEARER
if (!BEARER) {
  throw new Error('Set CLI_BRIDGE_BEARER (the value of BRIDGE_BEARER from cli-bridge/.env.local)')
}

const client = TCloudClient.fromCliBridge({ url: URL, bearer: BEARER })

// ── 1. One-shot: drives Claude Code on the bridge box ──
const claudeReply = await client.ask('reply with exactly the word OK', 'claude-code/sonnet')
console.log('[claude-code]', claudeReply)

// ── 2. Same shape, different harness — Kimi Code ──
// (requires `kimi login` on the bridge box first)
// const kimiReply = await client.ask('reply with exactly the word OK', 'kimi-code/kimi-for-coding')
// console.log('[kimi-code]', kimiReply)

// ── 3. Streaming — yields content deltas as they arrive ──
process.stdout.write('[claude-code stream] ')
for await (const chunk of client.askStream('write a 6-word haiku about sqlite', 'claude-code/sonnet')) {
  process.stdout.write(chunk)
}
process.stdout.write('\n')

// ── 4. Full chat() with messages array + session_id for resume ──
const completion = await client.chat({
  model: 'claude-code/sonnet',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'list 3 SQL injection patterns' },
  ],
  // @ts-expect-error session_id is cli-bridge-specific; tcloud's
  // ChatOptions doesn't declare it, but the body is forwarded
  // verbatim and cli-bridge picks it up. Use a stable slug to
  // resume the same CLI conversation across calls (e.g. `pr-42`).
  session_id: 'haiku-thread-1',
})
console.log('[chat]', completion.choices[0]?.message?.content)
console.log('[usage]', completion.usage)
