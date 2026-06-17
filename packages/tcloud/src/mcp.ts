/**
 * Minimal Model Context Protocol (MCP) stdio server exposing Tangle capabilities as tools.
 *
 * The first tool is `web_search` — live web results over the Tangle router (`client.search`).
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

/** The tools this server advertises. web_search is the grounding tool for research workers. */
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
]

interface SearchArgs {
  query?: unknown
  provider?: unknown
  maxResults?: unknown
  recency?: unknown
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

  process.stderr.write('tcloud mcp: web_search server ready (stdio)\n')

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
        if (name !== 'web_search') {
          fail(id, -32602, `unknown tool: ${String(name)}`)
          continue
        }
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
      } else {
        fail(id, -32601, `method not found: ${String(method)}`)
      }
    } catch (e) {
      fail(id, -32603, e instanceof Error ? e.message : String(e))
    }
  }
}
