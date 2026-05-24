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

import { TCloudClient, TCloudError, type RotatingClientConfig } from './client'
import { createShieldedClient, generateWallet } from './shielded'
import { TCloudSandbox, type TCloudSandboxConfig } from './sandbox'
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
   * Create a client that rotates operators per call.
   * See {@link TCloudClient.rotating} for semantics.
   *
   * ```ts
   * const client = TCloud.rotating({
   *   apiKey: process.env.TANGLE_API_KEY,
   *   routing: { strategy: 'min-exposure' },
   * })
   * const stats = client.getRotationStats()
   * ```
   */
  static rotating(config?: RotatingClientConfig): TCloudClient {
    return TCloudClient.rotating(config)
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

  /**
   * Create a Sandbox SDK client using this TCloud client's API key by default.
   *
   * ```ts
   * const tcloud = new TCloud({ apiKey })
   * const sandbox = await tcloud.sandbox().create({ name: 'runner' })
   * ```
   */
  sandbox(config: Partial<TCloudSandboxConfig> = {}): TCloudSandbox {
    const apiKey = config.apiKey ?? this.apiKey
    if (!apiKey) throw new Error('TCloud.sandbox() requires an apiKey')
    return new TCloudSandbox({ ...config, apiKey })
  }

  /** Create a standalone Sandbox SDK client. */
  static sandbox(config: TCloudSandboxConfig): TCloudSandbox {
    return new TCloudSandbox(config)
  }
}

// Re-export everything
export {
  TCloudClient,
  TCloudError,
  BridgeSession,
  type PricingTier,
  type TierConfig,
  type RotatingClientConfig,
  type RotatingRoutingConfig,
  type RotationStats,
} from './client'
export { createShieldedClient, generateWallet, signSpendAuth, estimateCost } from './shielded'
export {
  TCloudSandbox,
  createTeeAttestationChallenge,
  generateAttestationNonce,
  startTeeAttestationHeartbeat,
} from './sandbox'
export type {
  TCloudSandboxAttestationStatus,
  TCloudSandboxConfig,
  TCloudSandboxCreateOptions,
  TCloudSandboxCreateResult,
  TCloudSandboxTee,
  TCloudTeeAttestationChallenge,
  TCloudTeeAttestationHeartbeat,
  TCloudTeeAttestationHeartbeatOptions,
  TCloudTeeAttestationHeartbeatSample,
} from './sandbox'
export type {
  TCloudConfig,
  PrivacyConfig,
  SpendingLimits,
  RetryConfig,
  ChatMessage,
  ChatOptions,
  GatewayOptions,
  BridgeOptions,
  SandboxChatOptions,
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
  ImageEditAttachment,
  ImageEditOptions,
  ImageGenerateOptions,
  ImageResponse,
  RerankOptions,
  RerankResponse,
  SearchProvider,
  SearchRecency,
  SearchOptions,
  SearchHit,
  SearchResponse,
  CompletionOptions,
  CompletionResponse,
  TranscriptionResponse,
  FineTuningJobOptions,
  FineTuningJob,
  BatchRequest,
  BatchJobResponse,
  VideoGenerateOptions,
  VideoResponse,
  AvatarGenerateRequest,
  AvatarGenerateResponse,
  AvatarResult,
  AvatarJobStatus,
  JobEvent,
  WatchJobOptions,
  CreateKeyOptions,
  CreatedKey,
  ApiKeyInfo,
  UpdateKeyOptions,
} from './types'
export type { ShieldedWallet } from './shielded'
export { PrivateRouter, type PrivateRouterConfig, type RoutingStrategy, type OperatorInfo } from './private-router'
export {
  assertAttestation,
  createNitroHardwareVerifier,
  createSevSnpHardwareVerifier,
  createTdxHardwareVerifier,
  normalizeTeeType,
  parseAttestation,
  parseNitroAttestationDocument,
  parseSevSnpReport,
  toHex,
  verifyAttestation,
  verifyAttestationAsync,
} from '@tangle-network/tcloud-attestation'
export type {
  AsyncAttestationPolicy,
  AsyncHardwareVerifier,
  AttestationPolicy,
  AttestationVerificationResult,
  HardwareVerifier,
  HardwareVerifierResult,
  NitroAttestationDocument,
  NitroVerifierOptions,
  ParsedAttestation,
  SevSnpReport,
  SevSnpVerifierOptions,
  TeeType,
} from '@tangle-network/tcloud-attestation'

// Re-export agent profile types from sandbox SDK
export type {
  AgentProfile,
  AgentProfilePrompt,
  AgentProfileModelHints,
  AgentProfilePermissionValue,
  AgentProfileMcpServer,
  AgentProfileResources,
  AgentProfileCapabilities,
  // Subagents the harness can dispatch — same shape physim's specialist
  // dispatcher consumes. Re-export keeps callers on tcloud as the single
  // entry point instead of pulling sandbox in directly.
  AgentSubagentProfile,
  AgentProfileFileMount,
  AgentProfileResourceRef,
  AgentProfileValidationResult,
  AgentProfileValidationIssue,
} from '@tangle-network/sandbox'
