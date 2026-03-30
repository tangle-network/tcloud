/**
 * tcloud-relayer — gas relay for shielded withdrawals
 *
 * Users submit pre-built VAnchorProof structs + gateway call params.
 * The relayer signs and submits on-chain using its own wallet so the
 * user's wallet never appears as msg.sender.
 *
 * Privacy comes from the ZK proofs — the relayer is just a gas station.
 *
 * Env:
 *   RELAYER_PRIVATE_KEY   — funded wallet that pays gas
 *   RPC_URL               — JSON-RPC endpoint
 *   GATEWAY_ADDRESS       — ShieldedGateway contract
 *   PORT                  — HTTP port (default 3030)
 */

import { Hono } from 'hono'
import { ethers } from 'ethers'
import { stream as honoStream } from 'hono/streaming'

// ── Config ────────────────────────────────────────────────────────────────────

const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY
const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8545'
const GATEWAY_ADDRESS = process.env.GATEWAY_ADDRESS
const PORT = Number(process.env.PORT ?? '3030')

if (!RELAYER_PRIVATE_KEY) throw new Error('RELAYER_PRIVATE_KEY is required')
if (!GATEWAY_ADDRESS) throw new Error('GATEWAY_ADDRESS is required')

const provider = new ethers.JsonRpcProvider(RPC_URL)
const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider)

// Minimal gateway ABI — only the two functions we relay
const GATEWAY_ABI = [
  'function shieldedFundCredits(tuple(bytes proof, bytes auxPublicInputs, bytes externalData, bytes publicInputs, bytes encryptions) anchorProof, bytes32 commitment, address spendingKey) external payable',
  'function shieldedFundService(tuple(bytes proof, bytes auxPublicInputs, bytes externalData, bytes publicInputs, bytes encryptions) anchorProof, uint64 serviceId) external payable',
  'function withdrawCredits(bytes32 commitment, address recipient, uint256 amount, uint256 nonce, bytes signature) external',
]

const gateway = new ethers.Contract(GATEWAY_ADDRESS, GATEWAY_ABI, relayerWallet)

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnchorProof {
  proof: string        // hex bytes
  auxPublicInputs: string
  externalData: string
  publicInputs: string
  encryptions: string
}

interface FundCreditsBody {
  anchorProof: AnchorProof
  commitment: string   // bytes32 hex
  spendingKey: string  // address
}

interface WithdrawBody {
  commitment: string
  recipient: string
  amount: string       // decimal string to avoid JS bigint serialization issues
  nonce: string
  signature: string    // EIP-712 signature from the spending key
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toAnchorProofTuple(p: AnchorProof) {
  return {
    proof: ethers.getBytes(p.proof),
    auxPublicInputs: ethers.getBytes(p.auxPublicInputs),
    externalData: ethers.getBytes(p.externalData),
    publicInputs: ethers.getBytes(p.publicInputs),
    encryptions: ethers.getBytes(p.encryptions),
  }
}

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Rate Limiter ─────────────────────────────────────────────────────────────

const PROXY_RATE_LIMIT = 100 // requests per minute per source IP
const RATE_WINDOW_MS = 60_000

const rateCounts = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateCounts.get(ip)
  if (!entry || now >= entry.resetAt) {
    rateCounts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= PROXY_RATE_LIMIT
}

// Purge expired entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateCounts) {
    if (now >= entry.resetAt) rateCounts.delete(ip)
  }
}, 5 * 60_000)

// Headers stripped from proxied requests to hide the client's identity
const STRIPPED_HEADERS = new Set([
  'user-agent',
  'x-forwarded-for',
  'x-real-ip',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'forwarded',
  'via',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-originating-ip',
  'referer',
  'origin',
])

// ── Proxy Types ──────────────────────────────────────────────────────────────

interface ProxyRequestBody {
  target: string
  body: object
  headers: Record<string, string>
}

// ── Routes ────────────────────────────────────────────────────────────────────

const app = new Hono()

/**
 * POST /relay/fund-credits
 *
 * Body: { anchorProof, commitment, spendingKey }
 *
 * Relayer calls ShieldedGateway.shieldedFundCredits() on behalf of the user.
 * The ZK proof inside anchorProof proves ownership of the VAnchor UTXO.
 * The relayer wallet pays gas — the user's wallet never touches the chain.
 */
app.post('/relay/fund-credits', async (c) => {
  let body: FundCreditsBody
  try {
    body = await c.req.json<FundCreditsBody>()
  } catch {
    return jsonError('invalid JSON body')
  }

  const { anchorProof, commitment, spendingKey } = body

  if (!anchorProof || !commitment || !spendingKey) {
    return jsonError('anchorProof, commitment, and spendingKey are required')
  }
  if (!ethers.isHexString(commitment, 32)) {
    return jsonError('commitment must be a 32-byte hex string')
  }
  if (!ethers.isAddress(spendingKey)) {
    return jsonError('spendingKey must be a valid address')
  }

  try {
    const tuple = toAnchorProofTuple(anchorProof)
    const tx: ethers.TransactionResponse = await gateway.shieldedFundCredits(
      tuple,
      commitment,
      spendingKey,
    )
    return c.json({ txHash: tx.hash })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/**
 * POST /relay/withdraw
 *
 * Body: { commitment, recipient, amount, nonce, signature }
 *
 * Relayer calls ShieldedCredits.withdrawCredits() on behalf of the user.
 * The signature is EIP-712 signed by the ephemeral spending key — the user
 * never reveals their real wallet.
 */
app.post('/relay/withdraw', async (c) => {
  let body: WithdrawBody
  try {
    body = await c.req.json<WithdrawBody>()
  } catch {
    return jsonError('invalid JSON body')
  }

  const { commitment, recipient, amount, nonce, signature } = body

  if (!commitment || !recipient || !amount || !nonce || !signature) {
    return jsonError('commitment, recipient, amount, nonce, and signature are required')
  }
  if (!ethers.isHexString(commitment, 32)) {
    return jsonError('commitment must be a 32-byte hex string')
  }
  if (!ethers.isAddress(recipient)) {
    return jsonError('recipient must be a valid address')
  }

  // ShieldedCredits.withdrawCredits is on a separate contract — accept its address
  // in the request body or fall back to env. This keeps the relayer generic.
  const creditsAddress = process.env.CREDITS_ADDRESS
  if (!creditsAddress) {
    return c.json({ error: 'CREDITS_ADDRESS not configured on relayer' }, 503)
  }

  const CREDITS_ABI = [
    'function withdrawCredits(bytes32 commitment, address recipient, uint256 amount, uint256 nonce, bytes signature) external',
  ]
  const credits = new ethers.Contract(creditsAddress, CREDITS_ABI, relayerWallet)

  try {
    const tx: ethers.TransactionResponse = await credits.withdrawCredits(
      commitment,
      recipient,
      BigInt(amount),
      BigInt(nonce),
      ethers.getBytes(signature),
    )
    return c.json({ txHash: tx.hash })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/**
 * POST /relay/proxy
 *
 * Privacy proxy for inference requests.
 * Strips identifying headers and forwards to the target operator endpoint.
 * The operator sees the relayer's IP, not the client's.
 */
app.post('/relay/proxy', async (c) => {
  const sourceIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('cf-connecting-ip')
    || 'unknown'

  if (!checkRateLimit(sourceIp)) {
    return c.json({ error: 'rate limit exceeded — max 100 requests per minute' }, 429)
  }

  let payload: ProxyRequestBody
  try {
    payload = await c.req.json<ProxyRequestBody>()
  } catch {
    return jsonError('invalid JSON body')
  }

  const { target, body, headers: clientHeaders } = payload

  if (!target || typeof target !== 'string') {
    return jsonError('target URL is required')
  }
  if (!body || typeof body !== 'object') {
    return jsonError('body is required and must be an object')
  }

  // Build sanitized headers: start from client-provided headers, strip identifying ones
  const outHeaders: Record<string, string> = {}
  if (clientHeaders) {
    for (const [key, value] of Object.entries(clientHeaders)) {
      if (!STRIPPED_HEADERS.has(key.toLowerCase())) {
        outHeaders[key] = value
      }
    }
  }
  // Ensure content-type
  if (!outHeaders['Content-Type'] && !outHeaders['content-type']) {
    outHeaders['Content-Type'] = 'application/json'
  }

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: outHeaders,
      body: JSON.stringify(body),
    })

    const resHeaders = new Headers()
    resHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json')
    // Forward rate limit headers from upstream if present
    const rlRemaining = upstream.headers.get('X-RateLimit-Remaining')
    if (rlRemaining) resHeaders.set('X-RateLimit-Remaining', rlRemaining)

    const resBody = await upstream.arrayBuffer()
    return new Response(resBody, {
      status: upstream.status,
      headers: resHeaders,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: `proxy fetch failed: ${message}` }, 502)
  }
})

/**
 * POST /relay/proxy-stream
 *
 * Privacy proxy for streaming (SSE) inference requests.
 * Same as /relay/proxy but pipes the SSE stream back to the client.
 */
app.post('/relay/proxy-stream', async (c) => {
  const sourceIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('cf-connecting-ip')
    || 'unknown'

  if (!checkRateLimit(sourceIp)) {
    return c.json({ error: 'rate limit exceeded — max 100 requests per minute' }, 429)
  }

  let payload: ProxyRequestBody
  try {
    payload = await c.req.json<ProxyRequestBody>()
  } catch {
    return jsonError('invalid JSON body')
  }

  const { target, body, headers: clientHeaders } = payload

  if (!target || typeof target !== 'string') {
    return jsonError('target URL is required')
  }
  if (!body || typeof body !== 'object') {
    return jsonError('body is required and must be an object')
  }

  const outHeaders: Record<string, string> = {}
  if (clientHeaders) {
    for (const [key, value] of Object.entries(clientHeaders)) {
      if (!STRIPPED_HEADERS.has(key.toLowerCase())) {
        outHeaders[key] = value
      }
    }
  }
  if (!outHeaders['Content-Type'] && !outHeaders['content-type']) {
    outHeaders['Content-Type'] = 'application/json'
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: outHeaders,
      body: JSON.stringify(body),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: `proxy fetch failed: ${message}` }, 502)
  }

  if (!upstream.ok) {
    const errBody = await upstream.arrayBuffer()
    return new Response(errBody, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
    })
  }

  if (!upstream.body) {
    return c.json({ error: 'upstream returned no body' }, 502)
  }

  // Pipe SSE stream
  return honoStream(c, async (s) => {
    c.header('Content-Type', 'text/event-stream')
    c.header('Cache-Control', 'no-cache')
    c.header('Connection', 'keep-alive')

    const reader = upstream.body!.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await s.write(value)
      }
    } finally {
      reader.releaseLock()
    }
  })
})

/**
 * GET /relay/status
 *
 * Returns relayer address, gas balance, and chain ID.
 * Used by clients to verify the relayer is live and funded.
 */
app.get('/relay/status', async (c) => {
  try {
    const [balance, network] = await Promise.all([
      provider.getBalance(relayerWallet.address),
      provider.getNetwork(),
    ])
    return c.json({
      address: relayerWallet.address,
      gasBalance: balance.toString(),
      chainId: Number(network.chainId),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────

console.log(`tcloud-relayer starting on port ${PORT}`)
console.log(`relayer address: ${relayerWallet.address}`)
console.log(`gateway: ${GATEWAY_ADDRESS}`)
console.log(`rpc: ${RPC_URL}`)

export default {
  port: PORT,
  fetch: app.fetch,
}
