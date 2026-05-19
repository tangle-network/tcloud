/**
 * tcloud-agent — Agent primitive (run + stream).
 *
 * A run-loop wrapper over a sandbox-capable AgentSessionTransport.
 * Feeds an initial brief, executes a sandbox agent turn, evaluates a list of
 * completion criteria, and iterates — feeding failure reasons back in — until
 * all criteria pass or a budget gate fires.
 *
 * Two consumer surfaces:
 *
 *   1. `agent(client, opts).run(): Promise<AgentRunResult>` — awaits the final
 *      verdict.
 *   2. `agent(client, opts).stream(): AsyncIterable<AgentEvent>` — observes
 *      iterations, mid-iteration message deltas, criterion checks, and a
 *      terminal `verdict` event. `run()` is a thin consumer of `stream()`.
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
 * }).run()
 * ```
 *
 * Design:
 * - Cataloged profile (string): routed as `model: '<profile-id>'`.
 * - Inline profile (object): passed through typed sandbox transport fields.
 * - Criteria evaluated in order after each assistant turn. First failure
 *   drives the next iteration's user prompt. All-pass returns `verified`.
 * - Budget gates: `iterations` (count), `wallSec` (wall clock), `usd`
 *   (best-effort from `ChatCompletion.usage` when the upstream fills it in).
 * - Errors from the bridge are captured as a `verdict: 'error'` event, not
 *   thrown out of the iterable (same contract as `run()`).
 */

import type { AgentProfile, PromptOptions, PromptResult, SandboxEvent, SandboxInstance } from '@tangle-network/sandbox'
import { TCloudClient, type ChatCompletion, type ChatCompletionChunk, type ChatMessage } from '@tangle-network/tcloud'

// ── Part types (wrappers over the sandbox SDK session-gateway shape) ─────────
//
// The sandbox SDK defines these in its `session-gateway/agent-connection.ts`
// (and canonically in `@tangle-network/agent-interface`). That package isn't
// published to the registry yet and older `@tangle-network/sandbox` builds do not
// re-export them, so we redeclare the minimal shape locally and re-export it
// for consumers. When the interface package ships we can flip these to a
// direct re-export without churning the consumer surface.

/** Text delta emitted by the sandbox sidecar as the model streams tokens. */
export interface TextPart {
  type: 'text'
  id: string
  sessionID: string
  messageID: string
  text: string
}

/** Execution state for a single tool call. Mirrors the sandbox SDK union. */
export interface ToolState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'error'
  input?: Record<string, unknown>
  output?: unknown
  error?: string
}

/** Tool-call part emitted mid-iteration when the agent invokes a tool. */
export interface ToolPart {
  type: 'tool'
  id: string
  sessionID: string
  messageID: string
  tool: string
  state: ToolState
}

// ── Run-loop domain types ────────────────────────────────────────────────────

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
  /** Workspace directory requested for the transport, if any. */
  workspaceDir?: string
}

export interface AgentSessionStart {
  profile: AgentProfile | string
  resume?: string
  unlock?: string
  bridgeUrl?: string
  bridgeBearer?: string
  workspace?: { dir: string }
}

export interface AgentSessionChatOptions {
  messages: ChatMessage[]
  sandbox?: {
    agentProfile?: AgentProfile
    sessionId?: string
  }
}

export interface AgentSession {
  id?: string
  chat(options: AgentSessionChatOptions): Promise<ChatCompletion>
  chatStream(options: AgentSessionChatOptions): AsyncIterable<ChatCompletionChunk>
}

export interface AgentSessionTransport {
  start(input: AgentSessionStart): AgentSession | Promise<AgentSession>
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
  /** Transport session continuity across calls. */
  resume?: string
  /**
   * Workspace requested for transports that can enforce one. The agent loop
   * surfaces it on `AgentRunContext.workspaceDir`; it is not appended to the
   * prompt as an authority signal.
   */
  workspace?: { dir: string }
  /** Router bridge unlock. Falls back to `process.env.BRIDGE_UNLOCK` for router bridge transport. */
  unlock?: string
  /** BYOB cli-bridge URL — forwarded as `BridgeOptions.bridgeUrl`. */
  bridgeUrl?: string
  /** BYOB cli-bridge bearer — forwarded as `BridgeOptions.bridgeBearer`. */
  bridgeBearer?: string
  /** Explicit runtime transport. When omitted, `agent(client, opts)` uses router bridge. */
  transport?: AgentSessionTransport
  /**
   * Opt out of streaming. When `false`, each iteration calls `chat()` in
   * non-streaming mode and the stream yields a single `message.delta` per
   * iteration with the full assistant content. Default: `true`.
   *
   * Intended as an escape hatch for bridges or harnesses that don't support
   * SSE cleanly; `run()` semantics are identical either way.
   */
  stream?: boolean
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

/**
 * Streaming event emitted by {@link Agent.stream}.
 *
 * Ordering within an iteration:
 *   `iteration.start`
 *   → `message.delta`* (zero or more)
 *   → `iteration.complete`
 *   → `criterion.check`* (one per evaluated criterion)
 *
 * The final event of the stream is always a single `verdict` carrying the
 * same payload that `run()` returns.
 */
export type AgentEvent =
  | { type: 'iteration.start';    iteration: number }
  | { type: 'message.delta';      iteration: number; text: string }
  | { type: 'iteration.complete'; iteration: number; message: string }
  | { type: 'criterion.check';    iteration: number; name: string; ok: boolean; reason?: string }
  | { type: 'verdict';            verdict: AgentRunVerdict; iterations: number; wallMs: number; usd: number | null; transcript: AgentRunContext['transcript']; blockedBy?: string; error?: string }

export interface AgentBridgeOptions {
  harness: 'sandbox'
  model?: string
  unlock: string
  resume?: string
  bridgeUrl?: string
  bridgeBearer?: string
}

/** Legacy bridge surface accepted by `agent(client, opts)`. */
type BridgeClient = {
  bridge(cfg: AgentBridgeOptions): AgentSession
}

export interface BridgeTransportDefaults {
  unlock?: string
  bridgeUrl?: string
  bridgeBearer?: string
}

export interface LocalCliBridgeTransportConfig {
  url: string
  bearer: string
  config?: Parameters<typeof TCloudClient.fromCliBridge>[0]['config']
}

export type SandboxPromptRuntime = Pick<SandboxInstance, 'prompt' | 'streamPrompt'>

export interface SandboxSdkTransportOptions {
  sandbox: SandboxPromptRuntime
  sessionId?: string
  backend?: Partial<NonNullable<PromptOptions['backend']>>
  timeoutMs?: number
}

class BridgeAgentSessionTransport implements AgentSessionTransport {
  constructor(
    private readonly client: BridgeClient,
    private readonly defaults: BridgeTransportDefaults = {},
    private readonly direct = false,
  ) {}

  start(input: AgentSessionStart): AgentSession {
    const isInline = typeof input.profile !== 'string'
    const session = this.client.bridge({
      harness: 'sandbox',
      model: isInline
        ? (this.direct ? undefined : 'sandbox')
        : (input.profile as string),
      unlock: input.unlock ?? this.defaults.unlock ?? process.env.BRIDGE_UNLOCK ?? '',
      resume: input.resume,
      bridgeUrl: input.bridgeUrl ?? this.defaults.bridgeUrl,
      bridgeBearer: input.bridgeBearer ?? this.defaults.bridgeBearer,
    })
    const sandbox = isInline
      ? { agentProfile: input.profile as AgentProfile, ...(this.direct && input.resume ? { sessionId: input.resume } : {}) }
      : this.direct && input.resume
        ? { sessionId: input.resume }
        : undefined

    return {
      id: input.resume,
      chat: (options) => session.chat(withSandbox(options, sandbox)),
      chatStream: (options) => session.chatStream(withSandbox(options, sandbox)),
    }
  }
}

class SandboxSdkAgentSessionTransport implements AgentSessionTransport {
  constructor(private readonly options: SandboxSdkTransportOptions) {}

  start(input: AgentSessionStart): AgentSession {
    const sandbox = this.options.sandbox
    const sessionId = input.resume ?? this.options.sessionId
    const promptOptions: PromptOptions = {
      sessionId,
      timeoutMs: this.options.timeoutMs,
      backend: {
        ...(this.options.backend ?? {}),
        profile: input.profile,
      },
      context: input.workspace?.dir ? { workspaceDir: input.workspace.dir } : undefined,
    }

    return {
      id: sessionId,
      chat: async (options) => {
        const result = await sandbox.prompt(lastUserText(options.messages), promptOptionsForTurn(promptOptions, options))
        return completionFromPromptResult(result)
      },
      async *chatStream(options) {
        for await (const event of sandbox.streamPrompt(lastUserText(options.messages), promptOptionsForTurn(promptOptions, options))) {
          const text = textFromSandboxEvent(event)
          if (text) yield chunkFromText(text)
        }
      },
    }
  }
}

export function routerBridgeTransport(client: BridgeClient, defaults: BridgeTransportDefaults = {}): AgentSessionTransport {
  return new BridgeAgentSessionTransport(client, defaults, false)
}

export function localCliBridgeTransport(
  clientOrConfig: BridgeClient | LocalCliBridgeTransportConfig,
  defaults: BridgeTransportDefaults = {},
): AgentSessionTransport {
  const client = isLocalCliBridgeConfig(clientOrConfig)
    ? TCloudClient.fromCliBridge(clientOrConfig)
    : clientOrConfig
  return new BridgeAgentSessionTransport(client, defaults, true)
}

export function sandboxSdkTransport(options: SandboxSdkTransportOptions): AgentSessionTransport {
  return new SandboxSdkAgentSessionTransport(options)
}

/**
 * Run-loop around a sandbox-capable transport session.
 *
 * - {@link Agent.run} returns `Promise<AgentRunResult>` — awaits the final
 *   verdict.
 * - {@link Agent.stream} returns `AsyncIterable<AgentEvent>` — observes
 *   iterations, message deltas, criterion checks, and a terminal `verdict`.
 *
 * `run()` is a thin consumer of `stream()` — the loop logic lives once, in
 * `stream()`.
 */
export class Agent {
  private readonly client?: BridgeClient
  private readonly options: AgentRunOptions

  constructor(options: AgentRunOptions)
  constructor(client: BridgeClient, options: AgentRunOptions)
  constructor(clientOrOptions: BridgeClient | AgentRunOptions, options?: AgentRunOptions) {
    if (options) {
      this.client = clientOrOptions as BridgeClient
      this.options = options
    } else {
      this.options = clientOrOptions as AgentRunOptions
    }
  }

  /**
   * Execute the loop and return the final verdict. Never throws; failures
   * are captured on the result as `verdict: 'error'`.
   */
  async run(): Promise<AgentRunResult> {
    let verdictEvent: (AgentEvent & { type: 'verdict' }) | null = null
    for await (const ev of this.stream()) {
      if (ev.type === 'verdict') verdictEvent = ev
    }
    if (!verdictEvent) {
      throw new Error('Agent.stream() ended without emitting a verdict event')
    }
    const { type: _t, ...rest } = verdictEvent
    return rest as AgentRunResult
  }

  /**
   * Execute the loop and yield {@link AgentEvent}s as the run progresses.
   * Terminates with exactly one `verdict` event; errors surface as
   * `verdict: 'error'`, not a thrown exception out of the iterable.
   */
  async *stream(): AsyncIterable<AgentEvent> {
    const start = Date.now()
    const transcript: AgentRunContext['transcript'] = []
    const criteria = this.options.criteria ?? []
    const budget = this.options.budget ?? {}
    const maxIter = budget.iterations ?? 8
    const wantStream = this.options.stream !== false && budget.usd == null
    const transport = this.options.transport ?? (this.client ? routerBridgeTransport(this.client) : undefined)
    if (!transport) {
      throw new Error('Agent requires either agent(client, options) or options.transport')
    }
    const session = await transport.start({
      profile: this.options.profile,
      resume: this.options.resume,
      unlock: this.options.unlock,
      bridgeUrl: this.options.bridgeUrl,
      bridgeBearer: this.options.bridgeBearer,
      workspace: this.options.workspace,
    })

    let nextUserTurn = this.options.brief

    let iteration = 0
    let usd: number | null = null
    let blockedBy: string | undefined

    const buildVerdict = (
      verdict: AgentRunVerdict,
      extra: { error?: string } = {},
    ): AgentEvent & { type: 'verdict' } => ({
      type: 'verdict',
      verdict,
      iterations: iteration,
      wallMs: Date.now() - start,
      usd,
      transcript,
      ...(blockedBy != null ? { blockedBy } : {}),
      ...(extra.error != null ? { error: extra.error } : {}),
    })

    while (iteration < maxIter) {
      iteration++

      // Wall-clock budget check BEFORE the expensive call — first breach exits.
      if (budget.wallSec != null && (Date.now() - start) / 1000 >= budget.wallSec) {
        // Pre-call breach: the current iteration number was just incremented
        // but we haven't done the work. Report `iterations` as the last
        // fully-executed iteration (iteration - 1).
        yield {
          type: 'verdict',
          verdict: 'budget-exhausted',
          iterations: iteration - 1,
          wallMs: Date.now() - start,
          usd,
          transcript,
          ...(blockedBy != null ? { blockedBy } : {}),
        }
        return
      }

      yield { type: 'iteration.start', iteration }

      const userMsg: ChatMessage = { role: 'user', content: nextUserTurn }
      transcript.push({ role: 'user', content: nextUserTurn })

      let assistantContent = ''
      try {
        if (wantStream) {
          // Streaming path — accumulate deltas + yield them as they arrive.
          const chunks = session.chatStream({
            messages: [userMsg],
          })
          for await (const chunk of chunks) {
            const delta = extractDelta(chunk)
            if (delta) {
              assistantContent += delta
              yield { type: 'message.delta', iteration, text: delta }
            }
          }
        } else {
          // Non-streaming fallback — single full-message delta.
          const completion = await session.chat({
            messages: [userMsg],
          })
          assistantContent = completion.choices?.[0]?.message?.content ?? ''
          if (assistantContent) {
            yield { type: 'message.delta', iteration, text: assistantContent }
          }
          const priced = extractUsd(completion)
          if (priced != null) usd = (usd ?? 0) + priced
        }
      } catch (err) {
        transcript.push({ role: 'assistant', content: assistantContent })
        yield buildVerdict('error', {
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }

      transcript.push({ role: 'assistant', content: assistantContent })
      yield { type: 'iteration.complete', iteration, message: assistantContent }

      if (budget.usd != null && usd != null && usd > budget.usd) {
        yield buildVerdict('budget-exhausted')
        return
      }
      if (budget.wallSec != null && (Date.now() - start) / 1000 >= budget.wallSec) {
        yield buildVerdict('budget-exhausted')
        return
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
        yield {
          type: 'criterion.check',
          iteration,
          name: c.name,
          ok: out.ok,
          ...(out.reason != null ? { reason: out.reason } : {}),
        }
        if (!out.ok) {
          failedReason = out.reason ?? `criterion '${c.name}' failed`
          failedName = c.name
          break
        }
      }

      if (!failedName) {
        yield buildVerdict('verified')
        return
      }

      blockedBy = failedName
      nextUserTurn = `criterion '${failedName}' failed: ${failedReason}\n\nPlease address and respond.`
    }

    // Iteration cap reached — distinguish from blocked by preserving blockedBy.
    yield buildVerdict('budget-exhausted')
  }
}

/** Convenience factory. `agent(client, opts)` uses router bridge; `agent(opts)` requires `opts.transport`. */
export function agent(client: BridgeClient, options: AgentRunOptions): Agent
export function agent(options: AgentRunOptions): Agent
export function agent(clientOrOptions: BridgeClient | AgentRunOptions, options?: AgentRunOptions): Agent {
  return options ? new Agent(clientOrOptions as BridgeClient, options) : new Agent(clientOrOptions as AgentRunOptions)
}

/** Pull the text delta out of a ChatCompletionChunk. Tolerant of odd shapes. */
function extractDelta(chunk: ChatCompletionChunk): string {
  const content = chunk.choices?.[0]?.delta?.content
  return typeof content === 'string' ? content : ''
}

/**
 * Pull a USD figure out of a ChatCompletion. Tangle's router surfaces
 * `usage.cost_usd` on priced operators; when it's absent we return null so
 * the caller can distinguish "$0" from "unknown".
 *
 * Kept around for the non-streaming path; the streaming SSE body doesn't
 * carry usage fields on the final chunk today, so streamed runs report
 * `usd: null` until the router surfaces usage on the final chunk.
 */
function extractUsd(completion: { usage?: unknown }): number | null {
  const usage = completion.usage as { cost_usd?: number; costUsd?: number } | undefined
  if (!usage) return null
  if (typeof usage.cost_usd === 'number') return usage.cost_usd
  if (typeof usage.costUsd === 'number') return usage.costUsd
  return null
}

function isLocalCliBridgeConfig(value: BridgeClient | LocalCliBridgeTransportConfig): value is LocalCliBridgeTransportConfig {
  return typeof (value as LocalCliBridgeTransportConfig).url === 'string'
}

function withSandbox(
  options: AgentSessionChatOptions,
  sandbox: AgentSessionChatOptions['sandbox'] | undefined,
): AgentSessionChatOptions {
  return sandbox ? { ...options, sandbox: mergeSandbox(options.sandbox, sandbox) } : options
}

function mergeSandbox(
  base: AgentSessionChatOptions['sandbox'] | undefined,
  overlay: NonNullable<AgentSessionChatOptions['sandbox']>,
): NonNullable<AgentSessionChatOptions['sandbox']> {
  return { ...(base ?? {}), ...overlay }
}

function promptOptionsForTurn(base: PromptOptions, turn: AgentSessionChatOptions): PromptOptions {
  return {
    ...base,
    sessionId: turn.sandbox?.sessionId ?? base.sessionId,
    backend: {
      ...(base.backend ?? {}),
      ...(turn.sandbox?.agentProfile ? { profile: turn.sandbox.agentProfile } : {}),
    },
  }
}

function lastUserText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  if (!last) return ''
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
}

function completionFromPromptResult(result: PromptResult): ChatCompletion {
  if (!result.success) {
    throw new Error(result.error ?? 'Sandbox prompt failed')
  }
  return {
    id: result.traceId ?? `sandbox-prompt-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'sandbox-sdk',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.response ?? '' },
        finish_reason: 'stop',
      },
    ],
    usage: result.usage
      ? {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        }
      : undefined,
  }
}

function chunkFromText(text: string): ChatCompletionChunk {
  return {
    id: `sandbox-chunk-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'sandbox-sdk',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }
}

function textFromSandboxEvent(event: SandboxEvent): string {
  const data = event.data as Record<string, unknown>
  for (const key of ['text', 'delta', 'content', 'message', 'response']) {
    const value = data[key]
    if (typeof value === 'string') return value
  }
  return ''
}
