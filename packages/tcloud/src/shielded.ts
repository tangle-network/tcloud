/**
 * tcloud/shielded — Ephemeral wallet generation, SpendAuth signing, private inference.
 *
 * import { TCloud } from 'tcloud'
 * const client = TCloud.shielded()  // anonymous, no API key
 */

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { keccak256, encodeAbiParameters, parseAbiParameters, concat, toBytes, type Hex } from 'viem'
import { TCloudClient } from './client'
import type { TCloudConfig, SpendAuth } from './types'

export { type SpendAuth } from './types'

const SPEND_TYPEHASH = keccak256(
  toBytes(
    'SpendAuthorization(bytes32 commitment,uint64 serviceId,uint8 jobIndex,uint256 amount,address operator,uint256 nonce,uint64 expiry)'
  )
)

const DEFAULT_DOMAIN = {
  name: 'ShieldedCredits',
  version: '1',
}

export interface ShieldedWallet {
  /** Ephemeral spending private key (hex) */
  privateKey: Hex
  /** Derived address */
  address: string
  /** Credit account commitment */
  commitment: Hex
  /** Random salt */
  salt: Hex
}

/** Generate a new ephemeral shielded wallet */
export function generateWallet(): ShieldedWallet {
  const privateKeyBytes = crypto.getRandomValues(new Uint8Array(32))
  const privateKey = ('0x' + Array.from(privateKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('')) as Hex
  const saltBytes = crypto.getRandomValues(new Uint8Array(32))
  const salt = ('0x' + Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('')) as Hex

  const account = privateKeyToAccount(privateKey)
  const commitment = keccak256(
    encodeAbiParameters(
      parseAbiParameters('address, bytes32'),
      [account.address, salt]
    )
  )

  return { privateKey, address: account.address, commitment, salt }
}

/** Sign a SpendAuth for a request */
export async function signSpendAuth(
  wallet: ShieldedWallet,
  params: {
    serviceId: bigint
    jobIndex: number
    amount: bigint
    operator: Hex
    nonce: bigint
    expiry: bigint
    chainId: number
    creditsAddress: Hex
  }
): Promise<SpendAuth> {
  const account = privateKeyToAccount(wallet.privateKey)

  const domainSeparator = keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
      [
        keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(toBytes(DEFAULT_DOMAIN.name)),
        keccak256(toBytes(DEFAULT_DOMAIN.version)),
        BigInt(params.chainId),
        params.creditsAddress,
      ]
    )
  )

  const structHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, bytes32, uint64, uint8, uint256, address, uint256, uint64'),
      [
        SPEND_TYPEHASH,
        wallet.commitment,
        params.serviceId,
        params.jobIndex,
        params.amount,
        params.operator,
        params.nonce,
        params.expiry,
      ]
    )
  )

  const digest = keccak256(
    concat([toBytes('0x1901' as Hex), toBytes(domainSeparator), toBytes(structHash)])
  )

  const signature = await account.sign({ hash: digest })

  return {
    commitment: wallet.commitment,
    serviceId: params.serviceId.toString(),
    jobIndex: params.jobIndex,
    amount: params.amount.toString(),
    operator: params.operator,
    nonce: params.nonce.toString(),
    expiry: params.expiry.toString(),
    signature,
  }
}

/** Estimate cost in tsUSD base units (6 decimals) */
export function estimateCost(inputTokens: number, maxOutputTokens: number, inputPricePerM = 0.15, outputPricePerM = 0.60): bigint {
  const cost = (inputTokens / 1_000_000) * inputPricePerM + (maxOutputTokens / 1_000_000) * outputPricePerM
  return BigInt(Math.ceil(cost * 1_000_000)) // 6 decimal places
}

export interface AutoReplenishOptions {
  minBalance: bigint
  replenishAmount: bigint
  checkIntervalMs?: number
  fundingSource: 'relayer' | 'direct'
  relayerUrl?: string
  fundingWalletKey?: Hex
  tokenAddress?: Hex
}

interface BalanceMonitor {
  lastBalance: bigint
  timer: ReturnType<typeof setInterval> | null
  replenishing: boolean
}

/**
 * Create a shielded TCloudClient that signs SpendAuth automatically.
 * Every request is anonymous — no API key, no identity.
 */
export function createShieldedClient(config: TCloudConfig & {
  wallet?: ShieldedWallet
  operatorAddress?: Hex
  chainId?: number
  creditsAddress?: Hex
  serviceId?: bigint
  autoReplenish?: AutoReplenishOptions
} = {}): TCloudClient & { wallet: ShieldedWallet, stopAutoReplenish: () => void } {
  const wallet = config.wallet || generateWallet()
  const chainId = config.chainId || 3799
  const creditsAddress = config.creditsAddress || '0x0000000000000000000000000000000000000000' as Hex
  const operatorAddress = config.operatorAddress || '0x0000000000000000000000000000000000000000' as Hex
  const serviceId = config.serviceId || 1n

  let nonce = 0n

  const client = new TCloudClient({
    ...config,
    apiKey: undefined, // no API key in private mode
  })

  client.setSpendAuthSigner(async () => {
    const currentNonce = nonce++
    const amount = estimateCost(500, 4096) // estimate for a typical request
    const buffered = amount + (amount / 5n) // 20% buffer

    return signSpendAuth(wallet, {
      serviceId,
      jobIndex: 0,
      amount: buffered,
      operator: operatorAddress,
      nonce: currentNonce,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
      chainId,
      creditsAddress,
    })
  })

  // Auto-replenish: lightweight balance polling + relayer/direct funding
  const monitor: BalanceMonitor = { lastBalance: 0n, timer: null, replenishing: false }

  if (config.autoReplenish) {
    const ar = config.autoReplenish
    const intervalMs = ar.checkIntervalMs ?? 30_000

    const check = async () => {
      try {
        const balance = await fetchBalance(wallet.commitment, creditsAddress, chainId)
        monitor.lastBalance = balance

        if (balance < ar.minBalance && !monitor.replenishing) {
          monitor.replenishing = true
          try {
            if (ar.fundingSource === 'relayer') {
              await replenishViaRelayer(ar.relayerUrl!, wallet.commitment, wallet.privateKey)
            } else {
              await replenishDirect(
                ar.fundingWalletKey!,
                ar.tokenAddress!,
                ar.replenishAmount,
                wallet.commitment,
                wallet.address as Hex,
                creditsAddress,
                chainId,
              )
            }
            monitor.lastBalance = await fetchBalance(wallet.commitment, creditsAddress, chainId)
            console.log(`[tcloud/shielded] replenished. balance=${monitor.lastBalance}`)
          } finally {
            monitor.replenishing = false
          }
        }
      } catch (err) {
        console.error('[tcloud/shielded] auto-replenish error:', err instanceof Error ? err.message : String(err))
      }
    }

    void check()
    monitor.timer = setInterval(() => void check(), intervalMs)
  }

  function stopAutoReplenish() {
    if (monitor.timer) {
      clearInterval(monitor.timer)
      monitor.timer = null
    }
  }

  return Object.assign(client, { wallet, stopAutoReplenish })
}

// Helpers for auto-replenish (inline to avoid cross-package dependency on tangle-ai-cloud)

const GET_ACCOUNT_ABI = [{
  type: 'function' as const,
  name: 'getAccount' as const,
  inputs: [{ name: 'commitment', type: 'bytes32' as const }],
  outputs: [{
    name: '' as const,
    type: 'tuple' as const,
    components: [
      { name: 'spendingKey', type: 'address' as const },
      { name: 'token', type: 'address' as const },
      { name: 'balance', type: 'uint256' as const },
      { name: 'totalFunded', type: 'uint256' as const },
      { name: 'totalSpent', type: 'uint256' as const },
      { name: 'nonce', type: 'uint256' as const },
    ],
  }],
  stateMutability: 'view' as const,
}] as const

const FUND_CREDITS_ABI = [{
  type: 'function' as const,
  name: 'fundCredits' as const,
  inputs: [
    { name: 'token', type: 'address' as const },
    { name: 'amount', type: 'uint256' as const },
    { name: 'commitment', type: 'bytes32' as const },
    { name: 'spendingKey', type: 'address' as const },
  ],
  outputs: [],
  stateMutability: 'nonpayable' as const,
}] as const

const ERC20_APPROVE_ABI = [{
  type: 'function' as const,
  name: 'approve' as const,
  inputs: [
    { name: 'spender', type: 'address' as const },
    { name: 'amount', type: 'uint256' as const },
  ],
  outputs: [{ name: '', type: 'bool' as const }],
  stateMutability: 'nonpayable' as const,
}] as const

function makeChain(chainId: number, rpcUrl: string) {
  return {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }
}

function getRpcUrl(chainId: number): string {
  if (chainId === 3799) return 'https://testnet-rpc.tangle.tools'
  if (chainId === 5845) return 'https://rpc.tangle.tools'
  return 'http://localhost:8545'
}

async function fetchBalance(commitment: Hex, creditsAddress: Hex, chainId: number): Promise<bigint> {
  const { createPublicClient, http } = await import('viem')
  const rpcUrl = getRpcUrl(chainId)
  const client = createPublicClient({ chain: makeChain(chainId, rpcUrl), transport: http(rpcUrl) })
  const result = await client.readContract({
    address: creditsAddress,
    abi: GET_ACCOUNT_ABI,
    functionName: 'getAccount',
    args: [commitment],
  }) as any
  return result.balance as bigint
}

async function replenishViaRelayer(relayerUrl: string, commitment: Hex, spendingKey: Hex): Promise<void> {
  const res = await fetch(`${relayerUrl.replace(/\/$/, '')}/relay/fund-credits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      anchorProof: { proof: '0x', auxPublicInputs: '0x', externalData: '0x', publicInputs: '0x', encryptions: '0x' },
      commitment,
      spendingKey,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`relayer fund-credits failed (${res.status}): ${body}`)
  }
}

async function replenishDirect(
  fundingKey: Hex,
  tokenAddress: Hex,
  amount: bigint,
  commitment: Hex,
  spendingKeyAddress: Hex,
  creditsAddress: Hex,
  chainId: number,
): Promise<void> {
  const { createPublicClient, createWalletClient, http } = await import('viem')
  const { privateKeyToAccount: toAccount } = await import('viem/accounts')
  const rpcUrl = getRpcUrl(chainId)
  const chain = makeChain(chainId, rpcUrl)
  const account = toAccount(fundingKey)
  const pub = createPublicClient({ chain, transport: http(rpcUrl) })
  const wal = createWalletClient({ account, chain, transport: http(rpcUrl) })

  const approveHash = await wal.writeContract({
    address: tokenAddress,
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [creditsAddress, amount],
  } as any)
  await pub.waitForTransactionReceipt({ hash: approveHash })

  const fundHash = await wal.writeContract({
    address: creditsAddress,
    abi: FUND_CREDITS_ABI,
    functionName: 'fundCredits',
    args: [tokenAddress, amount, commitment, spendingKeyAddress],
  } as any)
  const receipt = await pub.waitForTransactionReceipt({ hash: fundHash })
  if (receipt.status !== 'success') {
    throw new Error(`fundCredits reverted (tx: ${fundHash})`)
  }
}
