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
} = {}): TCloudClient & { wallet: ShieldedWallet } {
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

  return Object.assign(client, { wallet })
}
