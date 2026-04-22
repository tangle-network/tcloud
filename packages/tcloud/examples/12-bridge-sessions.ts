/**
 * Bridge sessions — drive subscription-backed coding CLIs (Claude Code,
 * Codex, Kimi Code, opencode, claudish) through the Tangle Router as
 * OpenAI-compatible harnesses with persistent session resume.
 *
 * Each call with the same `resume` id lands on the same CLI conversation,
 * so prior turns don't get re-tokenized on every round trip.
 *
 * Run:
 *   TCLOUD_API_KEY=sk-tan-... \
 *   BRIDGE_UNLOCK=... \
 *   npx tsx examples/12-bridge-sessions.ts
 */

import { TCloudClient } from '@tangle-network/tcloud'

const tcloud = new TCloudClient({
  apiKey: process.env.TCLOUD_API_KEY!,
  baseURL: 'https://router.tangle.tools/api',
})

const UNLOCK = process.env.BRIDGE_UNLOCK!

// ── 1. One-shot through Claude Code (Claude Max subscription) ──
const claude = tcloud.bridge({
  harness: 'claude-code',
  model: 'sonnet',
  unlock: UNLOCK,
  resume: 'quickstart-claude',
})

console.log('claude:', await claude.ask('say hi in 3 words'))

// ── 2. Kimi Code (Kimi For Coding subscription) — streaming ──
const kimi = tcloud.bridge({
  harness: 'kimi-code',
  model: 'kimi-for-coding',
  unlock: UNLOCK,
  resume: 'quickstart-kimi',
})

process.stdout.write('kimi: ')
for await (const delta of kimi.stream('write a one-line haiku about sqlite')) {
  process.stdout.write(delta)
}
process.stdout.write('\n')

// ── 3. Session resume — follow-up call keeps context ──
await claude.ask('remember the number 42')
const recall = await claude.ask('what number did I just tell you?')
console.log('claude recall:', recall) // references 42 without re-sending the first message

// ── 4. Branch a conversation — same harness, different resume id ──
const claudeTicket = claude.withResume('ticket-123')
console.log('separate thread:', await claudeTicket.ask('new topic: say hello'))

// ── 5. Swap the model, keep the lineage ──
const claudeOpus = claude.withModel('opus')
console.log('claude opus:', await claudeOpus.ask('what model are you?'))

// ── 6. Codex — your ChatGPT subscription ──
const codex = tcloud.bridge({
  harness: 'codex',
  model: 'gpt-5-codex',
  unlock: UNLOCK,
  resume: 'quickstart-codex',
})
console.log('codex:', await codex.ask('what is 2+2?'))

// ── 7. Turn-based (full chat history) ──
const reply = await claude.turn([
  { role: 'system', content: 'You are a terse reviewer.' },
  { role: 'user', content: 'What is the one thing I should do today?' },
])
console.log('claude turn:', reply)
