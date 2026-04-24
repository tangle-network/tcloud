/**
 * Agent.stream — observe iterations + message deltas live.
 *
 * Same brief as 01-run.ts, but consuming the streaming surface: print token
 * deltas as they arrive, tag iteration boundaries, and settle on a terminal
 * `verdict` event.
 *
 *   TCLOUD_API_KEY=sk-tan-... BRIDGE_UNLOCK=... \
 *     npx tsx packages/tcloud-agent/examples/02-stream.ts
 */

import { TCloud } from '@tangle-network/tcloud'
import type { AgentProfile } from '@tangle-network/sandbox'
import { agent } from '../src/agent-runner'

const profile: AgentProfile = {
  name: 'scaffold-verifier',
  prompt: {
    systemPrompt:
      "You verify TypeScript scaffolds. Run `pnpm install` then `pnpm exec tsc --noEmit`. " +
      "Report the outcome on the LAST line as either `VERDICT: PASS` or `VERDICT: FAIL: <reason>`.",
  },
  model: { provider: 'anthropic', default: 'claude-sonnet-4-5' },
  permissions: { Bash: 'allow', Read: 'allow', Write: 'deny' },
  tools: { Bash: true, Read: true, Write: false },
}

async function main() {
  const client = new TCloud({ apiKey: process.env.TCLOUD_API_KEY })

  const events = agent(client, {
    profile,
    brief: 'Verify the scaffold at the mounted workspace builds cleanly.',
    workspace: { dir: process.env.WORKSPACE_DIR ?? process.cwd() },
    criteria: [
      { name: 'states-verdict', check: async (ctx) => /VERDICT:\s*(PASS|FAIL)/i.test(ctx.lastMessage) ? { ok: true } : { ok: false, reason: 'need VERDICT line' } },
      { name: 'passed',         check: async (ctx) => /VERDICT:\s*PASS/i.test(ctx.lastMessage) ? { ok: true } : { ok: false, reason: 'retry' } },
    ],
    budget: { iterations: 4, wallSec: 300 },
    unlock: process.env.BRIDGE_UNLOCK,
  }).stream()

  for await (const ev of events) {
    switch (ev.type) {
      case 'iteration.start':
        process.stdout.write(`\n\n── iter ${ev.iteration} ──\n`)
        break
      case 'message.delta':
        process.stdout.write(ev.text)
        break
      case 'tool.call.start':
        process.stdout.write(`\n[tool ▶ ${ev.tool}]\n`)
        break
      case 'tool.call.result':
        process.stdout.write(`\n[tool ${ev.status === 'completed' ? '✓' : '✗'} ${ev.tool}]\n`)
        break
      case 'criterion.check':
        process.stdout.write(`\n[gate ${ev.ok ? 'pass' : 'fail'}] ${ev.name}${ev.reason ? ` — ${ev.reason}` : ''}\n`)
        break
      case 'iteration.complete':
        // newline to separate from next iteration's header
        break
      case 'verdict':
        process.stdout.write(`\n\n[${ev.verdict}] iterations=${ev.iterations} wall=${ev.wallMs}ms\n`)
        if (ev.blockedBy) process.stdout.write(`blocked by: ${ev.blockedBy}\n`)
        if (ev.error)     process.stdout.write(`error: ${ev.error}\n`)
        break
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
