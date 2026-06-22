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
import type { TCloud } from './index'

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
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
}

interface ResearchArgs {
  query?: unknown
  provider?: unknown
  effort?: unknown
  maxResults?: unknown
}

/**
 * Run the MCP stdio server against an authenticated TCloud client. Resolves when stdin closes.
 * Handles `initialize`, `tools/list`, `tools/call` (+ ignores notifications, which carry no id).
 */
export async function runMcpServer(client: TCloud): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin })
  const send = (msg: unknown): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`)
  }
  const ok = (id: unknown, result: unknown): void => send({ jsonrpc: '2.0', id, result })
  const fail = (id: unknown, code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } })

  process.stderr.write('tcloud mcp: web_search + deep_research server ready (stdio)\n')

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let req: { id?: unknown; method?: string; params?: Record<string, unknown> }
    try {
      req = JSON.parse(trimmed)
    } catch {
      continue // not JSON — ignore (never crash the transport)
    }
    const { id, method, params } = req
    // Notifications (no id) get no response per JSON-RPC.
    if (id === undefined || id === null) continue

    try {
      if (method === 'initialize') {
        const requested = (params?.protocolVersion as string | undefined) ?? '2025-06-18'
        ok(id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: 'tangle-tcloud', version: '0.1.0' },
        })
      } else if (method === 'tools/list') {
        ok(id, { tools: TOOLS })
      } else if (method === 'tools/call') {
        const name = params?.name as string | undefined
        if (name === 'web_search') {
          const args = (params?.arguments ?? {}) as SearchArgs
          const query = String(args.query ?? '').trim()
          if (!query) {
            fail(id, -32602, 'web_search requires a non-empty "query"')
            continue
          }
          const resp = await client.search({
            query,
            ...(typeof args.provider === 'string' ? { provider: args.provider as never } : {}),
            ...(args.maxResults != null ? { maxResults: Number(args.maxResults) } : {}),
            ...(typeof args.recency === 'string' ? { searchRecency: args.recency as never } : {}),
          })
          const hits = resp.data ?? []
          const text = hits.length
            ? hits
                .map(
                  (h, i) =>
                    `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`,
                )
                .join('\n\n')
            : `No results for "${resp.query ?? query}".`
          ok(id, { content: [{ type: 'text', text }] })
        } else if (name === 'deep_research') {
          const args = (params?.arguments ?? {}) as ResearchArgs
          const query = String(args.query ?? '').trim()
          if (!query) {
            fail(id, -32602, 'deep_research requires a non-empty "query"')
            continue
          }
          const resp = await client.research({
            query,
            ...(typeof args.provider === 'string' ? { provider: args.provider as never } : {}),
            ...(typeof args.effort === 'string' ? { effort: args.effort } : {}),
            ...(args.maxResults != null ? { maxResults: Number(args.maxResults) } : {}),
          })
          const sources = resp.results ?? []
          const sourceList = sources.length
            ? `\n\nSources:\n${sources.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}`).join('\n')}`
            : ''
          const text = `${resp.answer ?? ''}${sourceList}`.trim() || `No research result for "${resp.query ?? query}".`
          ok(id, { content: [{ type: 'text', text }] })
        } else {
          fail(id, -32602, `unknown tool: ${String(name)}`)
        }
      } else {
        fail(id, -32601, `method not found: ${String(method)}`)
      }
    } catch (e) {
      fail(id, -32603, e instanceof Error ? e.message : String(e))
    }
  }
}
