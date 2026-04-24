/**
 * Agent.run — inline AgentProfile + completion gates.
 *
 * Brief: verify a scaffold by running `pnpm install`, then `tsc`, and return
 * an explicit pass/fail line. Budget-gated. No real sandbox required to read
 * this — the call shape is what matters.
 *
 * Run (router-mediated):
 *   TCLOUD_API_KEY=sk-tan-... BRIDGE_UNLOCK=... \
 *     npx tsx packages/tcloud-agent/examples/01-run.ts
 */

import { TCloud } from '@tangle-network/tcloud'
import type { AgentProfile } from '@tangle-network/sandbox'
import { agent } from '../src/agent-runner'

const profile: AgentProfile = {
  name: 'scaffold-verifier',
  description: 'runs pnpm install + tsc against a workspace and reports pass/fail',
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

  const result = await agent(client, {
    profile,
    brief: 'Verify the scaffold at the mounted workspace builds cleanly.',
    workspace: { dir: process.env.WORKSPACE_DIR ?? process.cwd() },
    criteria: [
      {
        name: 'states-verdict',
        check: async (ctx) =>
          /VERDICT:\s*(PASS|FAIL)/i.test(ctx.lastMessage)
            ? { ok: true }
            : { ok: false, reason: 'final message must end with `VERDICT: PASS` or `VERDICT: FAIL: <reason>`' },
      },
      {
        name: 'passed',
        check: async (ctx) =>
          /VERDICT:\s*PASS/i.test(ctx.lastMessage)
            ? { ok: true }
            : { ok: false, reason: 'build did not pass; fix the errors and retry' },
      },
    ],
    budget: { iterations: 4, wallSec: 300 },
    unlock: process.env.BRIDGE_UNLOCK,
    resume: 'scaffold-verify-1',
  }).run()

  console.log(`[${result.verdict}] iterations=${result.iterations} wall=${result.wallMs}ms`)
  if (result.blockedBy) console.log(`blocked by: ${result.blockedBy}`)
  if (result.error) console.log(`error: ${result.error}`)
  console.log('last assistant turn:\n', result.transcript.at(-1)?.content)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
