/**
 * tcloud-agent — Agent run-loop primitive + Tangle tool provider.
 *
 * ```ts
 * import { TCloud } from '@tangle-network/tcloud'
 * import { agent } from '@tangle-network/tcloud-agent'
 *
 * const client = new TCloud({ apiKey: process.env.TCLOUD_API_KEY! })
 * const result = await agent(client, {
 *   profile: 'sf-proposer',
 *   brief: 'Scaffold a package and confirm it builds.',
 *   criteria: [{ name: 'passed', check: async (c) => ({ ok: c.lastMessage.includes('ok') }) }],
 * }).runUntil()
 * ```
 *
 * For per-call operator rotation (the ex-`PrivateAgent` use case) use
 * `TCloudClient.rotating()` from `@tangle-network/tcloud` directly — it's
 * a client, not an agent.
 */

export { TangleToolProvider, type CapabilityHandler, type ToolResult } from './tool-provider'
export {
  Agent,
  agent,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRunContext,
  type AgentRunCriterion,
  type AgentRunVerdict,
  type AgentBudget,
} from './agent-runner'
