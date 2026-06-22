/**
 * Minimal Model Context Protocol (MCP) stdio server exposing Tangle capabilities as tools.
 *
 * Two tools over the Tangle router:
 *   - `web_search`    — live web results (title/url/snippet) via `client.search`.
 *   - `deep_research` — a multi-step synthesized research answer via `client.research`
 *                       (slower/costlier; for cross-source synthesis, not single facts).
 * It is dependency-free on purpose: newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP
 * stdio transport), so ANY consumer mounts it with one config line and zero extra packages:
 *
 *   opencode/claude/codex MCP config:  { "command": ["tcloud", "mcp"] }
 *
 * stdout is the protocol channel — every diagnostic goes to stderr so it never corrupts a frame.
 */
import * as readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { TCloud } from './index'
import type { ResearchProvider, SearchProvider, SearchRecency } from './types'
import { packageVersion } from './version'

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Providers accepted by `web_search` — validated before forwarding so a typo
 *  fails fast with -32602 rather than reaching the router as garbage. */
const SEARCH_PROVIDERS = new Set<SearchProvider>(['perplexity', 'exa', 'you', 'parallel', 'tavily', 'brave'])
/** Providers accepted by `deep_research` (no `brave` — it has no research API). */
const RESEARCH_PROVIDERS = new Set<ResearchProvider>(['perplexity', 'exa', 'you', 'parallel', 'tavily'])
/** Recency windows shared by both tools. */
const RECENCY_WINDOWS = new Set<SearchRecency>(['day', 'week', 'month', 'year'])

/** Protocol versions this server speaks. `initialize` clamps the client's
 *  requested version to one of these; unknown requests fall back to the newest. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26'])
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

const DOMAIN_FILTER_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
}

/** The tools this server advertises: web_search for live results, deep_research for
 *  synthesized multi-step answers — the two grounding tools for research workers. */
const TOOLS: ToolDef[] = [
  {
    name: 'web_search',
    description:
      'Search the web via the Tangle router and return live results (title, url, snippet). Use it to find primary sources and to VERIFY that a citation (paper, PMID/DOI, patent, fact) actually exists before relying on it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        provider: {
          type: 'string',
          description: 'Optional provider: exa | parallel | perplexity | tavily | brave | you.',
        },
        maxResults: { type: 'number', description: 'Optional max number of results.' },
        recency: { type: 'string', description: 'Optional recency window: day | week | month | year.' },
        includeDomains: { ...DOMAIN_FILTER_SCHEMA, description: 'Optional: restrict results to these domains.' },
        excludeDomains: { ...DOMAIN_FILTER_SCHEMA, description: 'Optional: drop results from these domains.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'deep_research',
    description:
      'Run a multi-step DEEP RESEARCH task via the Tangle router: the provider reads many sources and returns one synthesized answer with citations. Slower and costlier than web_search — use it for questions that need cross-source synthesis (current API/version landscapes, comparisons, "state of X"), not single-fact lookups.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The research question.' },
        provider: {
          type: 'string',
          description: 'Optional provider: you | exa | perplexity | tavily | parallel.',
        },
        effort: {
          type: 'string',
          description:
            'Optional depth/cost dial (provider-specific): you lite|standard|deep|exhaustive · perplexity minimal|low|medium|high · exa deep-lite|deep|deep-reasoning · tavily mini|pro|auto · parallel lite|base|core|pro|ultra.',
        },
        maxResults: { type: 'number', description: 'Optional max number of supporting sources.' },
        searchRecency: { type: 'string', description: 'Optional recency window: day | week | month | year.' },
        includeDomains: { ...DOMAIN_FILTER_SCHEMA, description: 'Optional: restrict sources to these domains.' },
        excludeDomains: { ...DOMAIN_FILTER_SCHEMA, description: 'Optional: drop sources from these domains.' },
        outputSchema: {
          type: 'object',
          description: 'Optional JSON schema requesting structured output from the provider.',
        },
      },
      required: ['query'],
    },
  },
]

interface SearchArgs {
  query?: unknown
  provider?: unknown
  maxResults?: unknown
  recency?: unknown
  includeDomains?: unknown
  excludeDomains?: unknown
}

interface ResearchArgs {
  query?: unknown
  provider?: unknown
  effort?: unknown
  maxResults?: unknown
  searchRecency?: unknown
  includeDomains?: unknown
  excludeDomains?: unknown
  outputSchema?: unknown
}

interface JsonRpcRequest {
  id?: unknown
  method?: string
  params?: Record<string, unknown>
}

/** A validation failure that maps to a JSON-RPC -32602 (Invalid params). */
class InvalidParams extends Error {}

/** Transport streams the server reads/writes. Defaults bind to the process
 *  stdio; tests inject in-memory streams. */
export interface McpServerOptions {
  input?: Readable
  output?: Writable
}

/** Coerce an optional maxResults to a forwardable value. Drops NaN / negative
 *  inputs ("best effort optional") rather than failing the whole call. */
function optionalMaxResults(value: unknown): number | undefined {
  if (value == null) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Validate + narrow a string against an allowed set, or throw InvalidParams. */
function requireEnum<T extends string>(value: unknown, allowed: Set<T>, label: string): T | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new InvalidParams(`invalid ${label}: ${String(value)}`)
  }
  return value as T
}

/** Forward only string-array domain filters; ignore anything else. */
function optionalDomains(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const domains = value.filter((d): d is string => typeof d === 'string')
  return domains.length ? domains : undefined
}

/**
 * Run the MCP stdio server against an authenticated TCloud client. Resolves when input closes.
 * Handles `initialize`, `tools/list`, `tools/call` (+ ignores notifications, which carry no id).
 *
 * Requests are dispatched without blocking the read loop, so a slow `deep_research`
 * call cannot stall concurrent `web_search` requests — each response carries its
 * own id. Pass `{ input, output }` to drive the transport over arbitrary streams
 * (tests inject in-memory streams); both default to the process stdio.
 */
export async function runMcpServer(client: TCloud, opts: McpServerOptions = {}): Promise<void> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const rl = readline.createInterface({ input })

  const send = (msg: unknown): void => {
    output.write(`${JSON.stringify(msg)}\n`)
  }
  const ok = (id: unknown, result: unknown): void => send({ jsonrpc: '2.0', id, result })
  const fail = (id: unknown, code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } })
  /** Tool execution failed — per MCP spec, surface it as tool content, not a protocol error. */
  const toolError = (id: unknown, message: string): void =>
    ok(id, { content: [{ type: 'text', text: message }], isError: true })

  process.stderr.write('tcloud mcp: web_search + deep_research server ready (stdio)\n')

  async function handleRequest(req: JsonRpcRequest): Promise<void> {
    const { id, method, params } = req
    try {
      if (method === 'initialize') {
        const requested = (params?.protocolVersion as string | undefined) ?? DEFAULT_PROTOCOL_VERSION
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION
        ok(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'tangle-tcloud', version: packageVersion() },
        })
      } else if (method === 'tools/list') {
        ok(id, { tools: TOOLS })
      } else if (method === 'tools/call') {
        const name = params?.name as string | undefined
        if (name === 'web_search') {
          await handleWebSearch(id, (params?.arguments ?? {}) as SearchArgs)
        } else if (name === 'deep_research') {
          await handleDeepResearch(id, (params?.arguments ?? {}) as ResearchArgs)
        } else {
          fail(id, -32602, `unknown tool: ${String(name)}`)
        }
      } else {
        fail(id, -32601, `method not found: ${String(method)}`)
      }
    } catch (e) {
      if (e instanceof InvalidParams) {
        fail(id, -32602, e.message)
      } else {
        // Genuine protocol bug — tool-execution failures are caught upstream.
        fail(id, -32603, e instanceof Error ? e.message : String(e))
      }
    }
  }

  async function handleWebSearch(id: unknown, args: SearchArgs): Promise<void> {
    const query = String(args.query ?? '').trim()
    if (!query) {
      fail(id, -32602, 'web_search requires a non-empty "query"')
      return
    }
    const provider = requireEnum(args.provider, SEARCH_PROVIDERS, 'provider')
    const searchRecency = requireEnum(args.recency, RECENCY_WINDOWS, 'recency')
    const maxResults = optionalMaxResults(args.maxResults)
    const includeDomains = optionalDomains(args.includeDomains)
    const excludeDomains = optionalDomains(args.excludeDomains)
    try {
      const resp = await client.search({
        query,
        ...(provider ? { provider } : {}),
        ...(maxResults != null ? { maxResults } : {}),
        ...(searchRecency ? { searchRecency } : {}),
        ...(includeDomains ? { includeDomains } : {}),
        ...(excludeDomains ? { excludeDomains } : {}),
      })
      const hits = resp.data ?? []
      const text = hits.length
        ? hits
            .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
            .join('\n\n')
        : `No results for "${resp.query ?? query}".`
      ok(id, { content: [{ type: 'text', text }] })
    } catch (e) {
      toolError(id, e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeepResearch(id: unknown, args: ResearchArgs): Promise<void> {
    const query = String(args.query ?? '').trim()
    if (!query) {
      fail(id, -32602, 'deep_research requires a non-empty "query"')
      return
    }
    const provider = requireEnum(args.provider, RESEARCH_PROVIDERS, 'provider')
    const searchRecency = requireEnum(args.searchRecency, RECENCY_WINDOWS, 'searchRecency')
    const maxResults = optionalMaxResults(args.maxResults)
    const includeDomains = optionalDomains(args.includeDomains)
    const excludeDomains = optionalDomains(args.excludeDomains)
    try {
      const resp = await client.research({
        query,
        ...(provider ? { provider } : {}),
        ...(typeof args.effort === 'string' ? { effort: args.effort } : {}),
        ...(maxResults != null ? { maxResults } : {}),
        ...(searchRecency ? { searchRecency } : {}),
        ...(includeDomains ? { includeDomains } : {}),
        ...(excludeDomains ? { excludeDomains } : {}),
        ...(args.outputSchema !== undefined ? { outputSchema: args.outputSchema } : {}),
      })
      const sources = resp.results ?? []
      const sourceList = sources.length
        ? `\n\nSources:\n${sources.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}`).join('\n')}`
        : ''
      const text = `${resp.answer ?? ''}${sourceList}`.trim() || `No research result for "${resp.query ?? query}".`
      ok(id, { content: [{ type: 'text', text }] })
    } catch (e) {
      toolError(id, e instanceof Error ? e.message : String(e))
    }
  }

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let req: JsonRpcRequest
    try {
      req = JSON.parse(trimmed)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }
    // Notifications (no id) get no response per JSON-RPC.
    if (req.id === undefined || req.id === null) continue
    // Fire-and-forget: each response carries its id, so a slow research call
    // never blocks concurrent requests on the read loop.
    void handleRequest(req)
  }
}
