/**
 * tcloud — Tangle AI Cloud SDK
 *
 * Drop-in replacement for the OpenAI SDK with decentralized operator routing
 * and optional privacy via ShieldedCredits.
 *
 * Usage:
 *
 * ```ts
 * // Standard mode (like OpenAI SDK)
 * import { TCloud } from 'tcloud'
 * const client = new TCloud({ apiKey: 'sk-tan-...' })
 * const response = await client.ask('What is Tangle?')
 *
 * // Private mode (anonymous, no API key)
 * const private = TCloud.shielded()
 * const response = await private.ask('What is Tangle?')
 * // SpendAuth signed automatically, operator never knows who you are
 *
 * // Streaming
 * for await (const chunk of client.askStream('Tell me a story')) {
 *   process.stdout.write(chunk)
 * }
 *
 * // Full OpenAI-compatible options
 * const completion = await client.chat({
 *   model: 'meta-llama/llama-4-maverick',
 *   messages: [
 *     { role: 'system', content: 'You are helpful.' },
 *     { role: 'user', content: 'Hello' },
 *   ],
 *   temperature: 0.7,
 *   maxTokens: 1024,
 * })
 * ```
 */

import { TCloudClient, TCloudError } from './client'
import { createShieldedClient, generateWallet } from './shielded'
import type { TCloudConfig, ShieldedConfig } from './types'

export class TCloud extends TCloudClient {
  constructor(config?: TCloudConfig) {
    super(config)
  }

  /**
   * Create a standard client with API key authentication.
   *
   * ```ts
   * const client = TCloud.create({ apiKey: 'sk-tan-...' })
   * ```
   */
  static create(config?: TCloudConfig): TCloud {
    return new TCloud(config)
  }

  /**
   * Create a shielded (private) client.
   * Generates an ephemeral wallet and signs SpendAuth automatically.
   * No API key needed. The operator never learns your identity.
   *
   * ```ts
   * const client = TCloud.shielded()
   * const response = await client.ask('Hello from the shadows')
   * console.log(client.wallet.commitment) // anonymous credit account
   * ```
   */
  static shielded(config?: TCloudConfig & {
    wallet?: import('./shielded').ShieldedWallet
    operatorAddress?: `0x${string}`
    chainId?: number
    creditsAddress?: `0x${string}`
    serviceId?: bigint
  }) {
    return createShieldedClient(config)
  }

  /**
   * Generate a new ephemeral wallet (without creating a client).
   *
   * ```ts
   * const wallet = TCloud.generateWallet()
   * console.log(wallet.address, wallet.commitment)
   * ```
   */
  static generateWallet = generateWallet
}

// Re-export everything
export { TCloudClient, TCloudError } from './client'
export { createShieldedClient, generateWallet, signSpendAuth, estimateCost } from './shielded'
export type {
  TCloudConfig,
  PrivacyConfig,
  SpendingLimits,
  ChatMessage,
  ChatOptions,
  ChatCompletion,
  ChatCompletionChunk,
  Model,
  Operator,
  CreditBalance,
  SpendAuth,
  RoutingConfig,
  ShieldedConfig,
  EmbeddingOptions,
  EmbeddingResponse,
  ImageGenerateOptions,
  ImageResponse,
  RerankOptions,
  RerankResponse,
} from './types'
export type { ShieldedWallet } from './shielded'
