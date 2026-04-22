/**
 * Bridge-backed chat loop — a minimal REPL that builds on a persistent
 * bridge session so each turn resumes instead of replaying history.
 *
 * This is the pattern for any chat app: pick a harness, pick a stable
 * resume id per conversation (could be a DB row id, a user/thread pair,
 * a PR number), and .stream() your way through turns.
 *
 * Run:
 *   TCLOUD_API_KEY=sk-tan-... \
 *   BRIDGE_UNLOCK=... \
 *   HARNESS=kimi MODEL=kimi-for-coding \
 *   npx tsx examples/13-bridge-chat-app.ts
 */

import { TCloudClient } from '@tangle-network/tcloud'
import readline from 'node:readline/promises'

const HARNESS = (process.env.HARNESS ?? 'claude-code') as
  'claude-code' | 'claudish' | 'codex' | 'opencode' | 'kimi-code'
const MODEL = process.env.MODEL // optional; falls back to harness default
const RESUME = process.env.RESUME ?? `chat-${Date.now()}`

const tcloud = new TCloudClient({
  apiKey: process.env.TCLOUD_API_KEY!,
  baseURL: 'https://router.tangle.tools/api',
})

const session = tcloud.bridge({
  harness: HARNESS,
  ...(MODEL ? { model: MODEL } : {}),
  unlock: process.env.BRIDGE_UNLOCK!,
  resume: RESUME,
})

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
console.log(`[${session.model}]  resume=${session.resume}`)
console.log('Type /quit to exit.\n')

while (true) {
  const input = (await rl.question('> ')).trim()
  if (!input) continue
  if (input === '/quit') break

  process.stdout.write('\n')
  for await (const delta of session.stream(input)) {
    process.stdout.write(delta)
  }
  process.stdout.write('\n\n')
}

rl.close()
