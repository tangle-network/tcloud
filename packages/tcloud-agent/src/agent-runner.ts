/**
 * tcloud-agent — Agent (run-until) primitive
 *
 * A run-loop wrapper on top of `TCloudClient.bridge({ harness: 'sandbox', ... })`.
 * Feeds an initial brief, executes a sandbox agent turn, evaluates a list of
 * completion criteria, and iterates — feeding failure reasons back in — until
 * all criteria pass or a budget gate fires.
 *
 * Usage:
 *
 * ```ts
 * import { TCloud } from '@tangle-network/tcloud'
 * import { agent } from '@tangle-network/tcloud-agent'
 *
 * const client = new TCloud({ apiKey: process.env.TCLOUD_API_KEY! })
 * const result = await agent(client, {
 *   profile: 'sf-proposer',
 *   brief: 'Scaffold a viteesm package and verify it builds.',
 *   criteria: [
 *     {
 *       name: 'claims-build-success',
 *       check: async (ctx) => ctx.lastMessage.toLowerCase().includes('build passed')
 *         ? { ok: true }
 *         : { ok: false, reason: 'did not state that the build passed; run `pnpm -w build` and confirm' },
 *     },
 *   ],
 *   budget: { iterations: 3, wallSec: 120 },
 *   unlock: process.env.BRIDGE_UNLOCK,
 * }).runUntil()
 * ```
 *
 * Design:
 * - Cataloged profile (string): routed as `model: '<profile-id>'`.
 * - Inline profile (object): routed as `model: 'sandbox'` with the profile
 *   forwarded in the request body as `agent_profile` (the cli-bridge sandbox
 *   backend key — see `packages/tcloud/examples/15-sandbox-agents.ts`). The
 *   body key is injected via `ChatOptions.providerOptions` which the tcloud
 *   client spreads into the request body verbatim.
 * - Criteria evaluated in order after each assistant turn. First failure
 *   drives the next iteration's user prompt. All-pass returns `verified`.
 * - Budget gates: `iterations` (count), `wallSec` (wall clock), `usd`
 *   (best-effort from `ChatCompletion.usage` when the upstream fills it in).
 * - Errors from the bridge are captured on the result, not thrown.
 */

import type { AgentProfile } from '@tangle-network/sandbox'
import type { TCloudClient, BridgeSession, ChatCompletion, ChatMessage } from '@tangle-network/tcloud'

/** A completion gate evaluated after each assistant turn. */
export interface AgentRunCriterion {
  /** Stable id used in `AgentRunResult.blockedBy`. */
  name: string
  /** Return `ok: true` to pass; `ok: false` with `reason` to drive the next iteration. */
  check: (ctx: AgentRunContext) => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string }
}

/** Gates that short-circuit the run regardless of criteria. */
export interface AgentBudget {
  /** Wall-clock cap in seconds. First breach exits with `budget-exhausted`. */
  wallSec?: number
  /**
   * Spend cap in USD (best-effort). Relies on `ChatCompletion.usage`; if the
   * bridge doesn't emit usage fields the accounting stays at 0.
   */
  usd?: number
  /** Max loop iterations. */
  iterations?: number
}

export interface AgentRunContext {
  /** 1-based iteration counter (matches what the loop just completed). */
  iteration: number
  /** Assistant text from the just-completed turn. */
  lastMessage: string
  /** Full transcript including the just-completed turn. */
  transcript: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  /** Local workspace directory (echoed from `AgentRunOptions.workspace.dir` if set). */
  workspaceDir?: string
}

export interface AgentRunOptions {
  /** Inline `AgentProfile` object or a cataloged profile id. */
  profile: AgentProfile | string
  /** First user turn. */
  brief: string
  /** Optional completion gates. Empty/undefined => the first assistant reply verifies. */
  criteria?: AgentRunCriterion[]
  /** Stop conditions orthogonal to criteria. */
  budget?: AgentBudget
  /** `BridgeOptions.resume` — session continuity across calls. */
  resume?: string
  /**
   * Bind a local workspace directory that the agent can reference in the
   * brief. Surfaced on `AgentRunContext.workspaceDir`; the path is appended
   * to the first user turn so the agent knows where to cd.
   */
  workspace?: { dir: string }
  /** `BridgeOptions.unlock`. Falls back to `process.env.BRIDGE_UNLOCK`. */
  unlock?: string
  /** BYOB cli-bridge URL — forwarded as `BridgeOptions.bridgeUrl`. */
  bridgeUrl?: string
  /** BYOB cli-bridge bearer — forwarded as `BridgeOptions.bridgeBearer`. */
  bridgeBearer?: string
}

export type AgentRunVerdict = 'verified' | 'blocked' | 'budget-exhausted' | 'error'

export interface AgentRunResult {
  verdict: AgentRunVerdict
  iterations: number
  /** Wall-clock elapsed in milliseconds. */
  wallMs: number
  /** Approximate spend in USD; `null` when no usage was reported. */
  usd: number | null
  transcript: AgentRunContext['transcript']
  /** Criterion.name of the first failing gate, when `verdict === 'blocked'`. */
  blockedBy?: string
  /** Captured error message, when `verdict === 'error'`. */
  error?: string
}

/** Bridge surface the runner depends on — keeps tests fake-able. */
type BridgeClient = Pick<TCloudClient, 'bridge'>

/**
 * Run-loop around a sandbox-harness BridgeSession. The run loop itself is in
 * {@link Agent.runUntil}; prefer the {@link agent} factory for call-sites.
 */
export class Agent {
  constructor(private readonly client: BridgeClient, private readonly options: AgentRunOptions) {}

  /** Execute the loop. Never throws; failures are captured on the result. */
  async runUntil(): Promise<AgentRunResult> {
    const start = Date.now()
    const transcript: AgentRunContext['transcript'] = []
    const criteria = this.options.criteria ?? []
    const budget = this.options.budget ?? {}
    const maxIter = budget.iterations ?? 8

    const unlock = this.options.unlock ?? process.env.BRIDGE_UNLOCK ?? ''
    const isInline = typeof this.options.profile !== 'string'
    const session: BridgeSession = this.client.bridge({
      harness: 'sandbox',
      model: isInline ? 'sandbox' : (this.options.profile as string),
      unlock,
      resume: this.options.resume,
      bridgeUrl: this.options.bridgeUrl,
      bridgeBearer: this.options.bridgeBearer,
    })

    const providerOptions: Record<string, unknown> | undefined = isInline
      ? { agent_profile: this.options.profile as AgentProfile }
      : undefined

    let nextUserTurn = this.options.workspace?.dir
      ? `${this.options.brief}\n\n[workspace: ${this.options.workspace.dir}]`
      : this.options.brief

    let iteration = 0
    let usd: number | null = null
    let blockedBy: string | undefined

    while (iteration < maxIter) {
      iteration++

      // Wall-clock budget check BEFORE the expensive call — first breach exits.
      if (budget.wallSec != null && (Date.now() - start) / 1000 >= budget.wallSec) {
        return {
          verdict: 'budget-exhausted',
          iterations: iteration - 1,
          wallMs: Date.now() - start,
          usd,
          transcript,
          blockedBy,
        }
      }

      const userMsg: ChatMessage = { role: 'user', content: nextUserTurn }
      transcript.push({ role: 'user', content: nextUserTurn })

      let completion: ChatCompletion
      try {
        completion = await session.chat({
          messages: [userMsg],
          ...(providerOptions ? { providerOptions } : {}),
        })
      } catch (err) {
        return {
          verdict: 'error',
          iterations: iteration,
          wallMs: Date.now() - start,
          usd,
          transcript,
          error: err instanceof Error ? err.message : String(err),
        }
      }

      const assistantContent = completion.choices?.[0]?.message?.content ?? ''
      transcript.push({ role: 'assistant', content: assistantContent })

      // Best-effort USD from usage. Most sandbox runs won't emit price
      // fields; leave usd at null when nothing comes back.
      const priced = extractUsd(completion)
      if (priced != null) usd = (usd ?? 0) + priced

      if (budget.usd != null && usd != null && usd > budget.usd) {
        return {
          verdict: 'budget-exhausted',
          iterations: iteration,
          wallMs: Date.now() - start,
          usd,
          transcript,
          blockedBy,
        }
      }
      if (budget.wallSec != null && (Date.now() - start) / 1000 >= budget.wallSec) {
        return {
          verdict: 'budget-exhausted',
          iterations: iteration,
          wallMs: Date.now() - start,
          usd,
          transcript,
          blockedBy,
        }
      }

      const ctx: AgentRunContext = {
        iteration,
        lastMessage: assistantContent,
        transcript,
        workspaceDir: this.options.workspace?.dir,
      }

      // All-pass => verified. First-fail => feed reason to next iteration.
      let failedReason: string | undefined
      let failedName: string | undefined
      for (const c of criteria) {
        const out = await c.check(ctx)
        if (!out.ok) {
          failedReason = out.reason ?? `criterion '${c.name}' failed`
          failedName = c.name
          break
        }
      }

      if (!failedName) {
        return {
          verdict: 'verified',
          iterations: iteration,
          wallMs: Date.now() - start,
          usd,
          transcript,
        }
      }

      blockedBy = failedName
      nextUserTurn = `criterion '${failedName}' failed: ${failedReason}\n\nPlease address and respond.`
    }

    // Iteration cap reached — distinguish from blocked by preserving blockedBy.
    return {
      verdict: 'budget-exhausted',
      iterations: iteration,
      wallMs: Date.now() - start,
      usd,
      transcript,
      blockedBy,
    }
  }
}

/** Convenience factory that mirrors the `TCloudClient.bridge()` style. */
export function agent(client: BridgeClient, options: AgentRunOptions): Agent {
  return new Agent(client, options)
}

/**
 * Pull a USD figure out of a ChatCompletion. Tangle's router surfaces
 * `usage.cost_usd` on priced operators; when it's absent we return null so
 * the caller can distinguish "$0" from "unknown".
 */
function extractUsd(completion: ChatCompletion): number | null {
  const usage = (completion as unknown as { usage?: { cost_usd?: number; costUsd?: number } }).usage
  if (!usage) return null
  if (typeof usage.cost_usd === 'number') return usage.cost_usd
  if (typeof usage.costUsd === 'number') return usage.costUsd
  return null
}
