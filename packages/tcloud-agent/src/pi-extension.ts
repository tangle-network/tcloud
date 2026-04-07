/**
 * tcloud Pi Extension — Transparent private AI inference.
 *
 * Two modes of operation:
 *
 * 1. TRANSPARENT PROXY: Register tcloud as a custom model provider in Pi.
 *    ALL inference goes through Tangle AI Cloud with x402 payments from
 *    a shielded wallet. Pi agent doesn't know or care.
 *
 * 2. TOOL MODE: Provide tcloud_chat tool for agent to call when it needs
 *    private inference alongside its normal provider.
 *
 * Zero config works immediately (anonymous rate-limited).
 * `tcloud wallet create` + `tcloud credits fund` enables full privacy.
 *
 * The wallet manages two keys:
 * - Funding key: used once to deposit into VAnchor shielded pool
 * - Spending key: ephemeral, signs x402 SpendAuth per request, rotated
 */

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import { TCloudClient } from '@tangle-network/tcloud'
import { signSpendAuth, generateWallet, type ShieldedWallet } from '@tangle-network/tcloud/shielded'
import type { Hex } from 'viem'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { TangleToolProvider } from './tool-provider'

const TCLOUD_API_URL = process.env.TCLOUD_API_URL || 'https://router.tangle.tools/v1'
const TCLOUD_MODEL = process.env.TCLOUD_MODEL || 'gpt-4o-mini'
const CONFIG_DIR = path.join(process.env.HOME || '~', '.tcloud')
const WALLETS_FILE = path.join(CONFIG_DIR, 'wallets.json')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

type Level = 'anonymous' | 'authenticated' | 'shielded'

interface SessionState {
  level: Level
  apiKey: string | null
  wallet: WalletData | null
  nonce: bigint
  totalRequests: number
  operatorsRotated: number
  currentOperator: string | null
}

interface WalletData {
  fundingAddress?: string   // real wallet, used for deposits
  spendingPrivateKey: string // ephemeral, signs x402
  spendingAddress: string
  commitment: string
  salt: string
}

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
}

function loadConfig(): { apiKey?: string; apiUrl?: string; model?: string } {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) } catch { return {} }
}

function loadWallet(): WalletData | null {
  try {
    const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'))
    return wallets[0] || null
  } catch { return null }
}

const SHIELDED_CHAIN_ID = parseInt(process.env.SHIELDED_CHAIN_ID || '3799')
const SHIELDED_CREDITS_ADDRESS = (process.env.SHIELDED_CREDITS_ADDRESS || '0x0000000000000000000000000000000000000000') as Hex

async function buildSpendAuthHeader(wallet: WalletData, nonce: bigint): Promise<string> {
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 300)
  const shieldedWallet: ShieldedWallet = {
    privateKey: wallet.spendingPrivateKey as Hex,
    address: wallet.spendingAddress,
    commitment: wallet.commitment as Hex,
    salt: wallet.salt as Hex,
  }
  const auth = await signSpendAuth(shieldedWallet, {
    serviceId: 1n,
    jobIndex: 0,
    amount: 1_000_000n, // $1 authorization in tsUSD base units
    operator: '0x0000000000000000000000000000000000000000' as Hex, // gateway selects
    nonce,
    expiry,
    chainId: SHIELDED_CHAIN_ID,
    creditsAddress: SHIELDED_CREDITS_ADDRESS,
  })
  return JSON.stringify(auth)
}

export default function tcloudExtension(pi: ExtensionAPI) {
  const sessions = new Map<string, SessionState>()
  const getKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId()

  const getSession = (ctx: ExtensionContext): SessionState => {
    const key = getKey(ctx)
    if (!sessions.has(key)) {
      const config = loadConfig()
      const wallet = loadWallet()
      const level: Level = wallet ? 'shielded' : config.apiKey ? 'authenticated' : 'anonymous'
      sessions.set(key, {
        level,
        apiKey: config.apiKey || null,
        wallet,
        nonce: 0n,
        totalRequests: 0,
        operatorsRotated: 0,
        currentOperator: null,
      })
    }
    return sessions.get(key)!
  }

  // ── Make an inference request at the detected privacy level ──

  async function inference(session: SessionState, messages: any[], model: string): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }

    if (session.level === 'shielded' && session.wallet) {
      // x402: sign SpendAuth, no API key, operator can't identify us
      headers['X-Payment-Signature'] = await buildSpendAuthHeader(session.wallet, session.nonce++)
    } else if (session.level === 'authenticated' && session.apiKey) {
      headers['Authorization'] = `Bearer ${session.apiKey}`
    }
    // anonymous: no headers, rate-limited

    const res = await fetch(`${TCLOUD_API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, max_tokens: 4096, stream: false }),
    })

    if (res.status === 402) throw new Error('Credits exhausted. Run: tcloud credits fund')
    if (res.status === 429) throw new Error('Rate limited. Run: tcloud auth login')
    if (!res.ok) throw new Error(`tcloud ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`)

    const data = await res.json() as any
    session.totalRequests++

    // Track operator rotation from response headers
    const routedOperator = res.headers.get('x-tangle-routed-operator')
    if (routedOperator && routedOperator !== session.currentOperator) {
      session.operatorsRotated++
      session.currentOperator = routedOperator
    }

    return data.choices?.[0]?.message?.content || ''
  }

  // ── Lifecycle ──

  pi.on('session_start', async (_event, ctx) => {
    getSession(ctx) // init state
    updateWidget(ctx)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    sessions.delete(getKey(ctx))
    if (ctx.hasUI) ctx.ui.setWidget('tcloud', undefined)
  })

  pi.on('before_agent_start', async (event, ctx) => {
    const s = getSession(ctx)
    const hint = s.level === 'shielded'
      ? `\n\n[tcloud: private mode active, ${s.operatorsRotated} operators rotated, ${s.totalRequests} requests]`
      : s.level === 'authenticated'
        ? `\n\n[tcloud: authenticated mode, ${s.totalRequests} requests]`
        : '\n\n[tcloud: anonymous mode — run `tcloud wallet create` in terminal for private access]'
    return { systemPrompt: event.systemPrompt + hint }
  })

  // ── Tools ──

  // Build a TCloudClient that inherits the session's auth headers
  const client = new TCloudClient({
    baseURL: TCLOUD_API_URL,
    apiKey: loadConfig().apiKey,
    model: TCLOUD_MODEL,
  })

  // Wire up SpendAuth signer if a wallet is available
  const wallet = loadWallet()
  if (wallet) {
    let nonce = 0n
    client.setSpendAuthSigner(async () => {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 300)
      const w: ShieldedWallet = {
        privateKey: wallet.spendingPrivateKey as Hex,
        address: wallet.spendingAddress,
        commitment: wallet.commitment as Hex,
        salt: wallet.salt as Hex,
      }
      return signSpendAuth(w, {
        serviceId: 1n,
        jobIndex: 0,
        amount: 1_000_000n,
        operator: '0x0000000000000000000000000000000000000000' as Hex,
        nonce: nonce++,
        expiry,
        chainId: SHIELDED_CHAIN_ID,
        creditsAddress: SHIELDED_CREDITS_ADDRESS,
      })
    })
  }

  const provider = new TangleToolProvider(client)

  // Single unified tool for all AI capabilities
  pi.registerTool({
    name: 'tangle',
    label: 'Tangle AI Services',
    description: provider.getToolDefinition().description,
    parameters: Type.Object({
      capability: Type.Union(
        provider.listCapabilities().map(c => Type.Literal(c)),
        { description: 'Which AI capability to invoke' }
      ),
      input: Type.Any({ description: 'Capability-specific parameters' }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const session = getSession(ctx)
      try {
        const result = await provider.execute(params.capability, params.input)
        session.totalRequests++
        updateWidget(ctx)
        return { details: {}, content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] }
      } catch (e: any) {
        return { details: {}, content: [{ type: 'text' as const, text: e.message }], isError: true }
      }
    },
  })

  // Wallet + credits management from within Pi
  pi.registerTool({
    name: 'tcloud_wallet',
    label: 'Tangle Wallet',
    description: 'Manage tcloud shielded wallet. Actions: status, create (generate new ephemeral wallet), fund_url (get URL to fund credits).',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('status'), Type.Literal('create'), Type.Literal('fund_url')]),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const session = getSession(ctx)

      if (params.action === 'status') {
        return {
          details: {},
          content: [{ type: 'text' as const, text: JSON.stringify({
            level: session.level,
            wallet: session.wallet ? { commitment: session.wallet.commitment.slice(0, 20) + '...', address: session.wallet.spendingAddress } : null,
            requests: session.totalRequests,
            operators: session.operatorsRotated,
          }, null, 2) }],
        }
      }

      if (params.action === 'create') {
        ensureDir()
        const w = generateWallet()
        const wallet: WalletData = {
          spendingPrivateKey: w.privateKey,
          spendingAddress: w.address,
          commitment: w.commitment,
          salt: w.salt,
        }
        const existing = loadWallet() ? JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8')) : []
        existing.push(wallet)
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 })

        session.wallet = wallet
        session.level = 'shielded'
        session.nonce = 0n
        updateWidget(ctx)

        return {
          details: {},
          content: [{ type: 'text' as const, text: `Shielded wallet created.\nCommitment: ${w.commitment}\nAddress: ${w.address}\n\nFund it at: ${TCLOUD_API_URL}/privacy-credits` }],
        }
      }

      if (params.action === 'fund_url') {
        return { details: {}, content: [{ type: 'text' as const, text: `${TCLOUD_API_URL}/privacy-credits` }] }
      }

      return { details: {}, content: [{ type: 'text' as const, text: 'Unknown action' }], isError: true }
    },
  })

  // ── Widget ──

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return
    const s = getSession(ctx)
    const tag = s.level === 'shielded' ? 'priv' : s.level === 'authenticated' ? 'auth' : 'anon'
    const parts = [`[${tag}]`, `${s.totalRequests}req`]
    if (s.level === 'shielded') parts.push(`${s.operatorsRotated}ops`)
    ctx.ui.setWidget('tcloud', { title: 'tcloud', content: parts.join(' '), style: 'compact' } as any)
  }
}
