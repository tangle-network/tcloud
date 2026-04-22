/**
 * Sandbox harness — agents-as-addressable-models.
 *
 * The cli-bridge `sandbox` backend wraps the Tangle sandbox-api and
 * accepts an AgentProfile (cataloged or inline) per request. Each
 * profile = a complete agent definition: prompt + model + tools +
 * permissions + MCP servers + resources. Once published as a profile
 * id, an agent is addressable as an OpenAI model id:
 *
 *   model: "sandbox/<profile-id>"      // cataloged
 *   model: "sandbox" + agent_profile   // inline (for ephemeral / per-call)
 *
 * Anything that speaks OpenAI completions (this SDK, LangChain, AI SDK,
 * curl) can dispatch to a named agent. Means benchmarking N profiles is
 * `Promise.all(profiles.map(p => client.ask(prompt, `sandbox/${p}`)))`
 * and orchestration just composes profile ids.
 *
 * Run:
 *   TCLOUD_API_KEY=sk-tan-...
 *   BRIDGE_UNLOCK=...                  # router gate
 *   npx tsx examples/15-sandbox-agents.ts
 *
 * For local-only (point at your own cli-bridge, no router):
 *   CLI_BRIDGE_URL=http://127.0.0.1:3344 CLI_BRIDGE_BEARER=...
 *   npx tsx examples/15-sandbox-agents.ts --direct
 */

import { TCloudClient } from '@tangle-network/tcloud'
import type { AgentProfile } from '@tangle-network/sandbox'

const direct = process.argv.includes('--direct')

// ── Path A: router-mediated (default) ─────────────────────────────
const router = new TCloudClient({
  apiKey: process.env.TCLOUD_API_KEY!,
  baseURL: 'https://router.tangle.tools/api',
})

if (!direct) {
  // 1) Cataloged profile by id — assumes the operator published a
  //    `sf-proposer` AgentProfile to cli-bridge's profiles/ dir
  const session = router.bridge({
    harness: 'sandbox',
    model: 'sf-proposer',
    unlock: process.env.BRIDGE_UNLOCK!,
    resume: 'demo-1',
  })
  console.log('[catalog]', await session.ask('summarize what you do in one sentence'))

  // 2) Benchmarking pattern — same prompt, N profiles, parallel
  const profiles = ['sf-proposer', 'sf-reviewer-cheap', 'sf-reviewer-thorough']
  const prompt = 'list 3 SQL injection patterns'
  const results = await Promise.all(profiles.map((p) =>
    router.bridge({ harness: 'sandbox', model: p, unlock: process.env.BRIDGE_UNLOCK!, resume: `bench-${p}` }).ask(prompt)
  ))
  console.log('[benchmark]')
  profiles.forEach((p, i) => console.log(`  ${p.padEnd(24)} → ${results[i]?.slice(0, 80)}…`))
}

// ── Path B: direct local cli-bridge (no router) ───────────────────
if (direct) {
  const local = TCloudClient.fromCliBridge({
    url: process.env.CLI_BRIDGE_URL ?? 'http://127.0.0.1:3344',
    bearer: process.env.CLI_BRIDGE_BEARER!,
  })

  // 3) Inline AgentProfile — define the agent in the request body, no
  //    pre-publish. Sandbox handles skill/plugin/MCP/package
  //    provisioning per the profile. Useful for ephemeral / per-call
  //    agents where you don't want to maintain a profile catalog.
  const inline: AgentProfile = {
    name: 'haiku-bot',
    description: 'writes a 3-line haiku on any topic',
    prompt: { systemPrompt: 'You write a 3-line haiku, exactly 5-7-5 syllables. No commentary.' },
    model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    permissions: { Read: 'deny', Write: 'deny', Bash: 'deny' },
    tools: { Read: false, Write: false, Bash: false },
  }
  const completion = await local.chat({
    model: 'sandbox',
    messages: [{ role: 'user', content: 'topic: distributed systems' }],
    // @ts-expect-error agent_profile is cli-bridge's sandbox-backend
    // body field; tcloud's ChatOptions doesn't declare it, but the
    // body is forwarded verbatim.
    agent_profile: inline,
  })
  console.log('[inline]', completion.choices[0]?.message?.content)
}
