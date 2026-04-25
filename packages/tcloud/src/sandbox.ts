import { Sandbox } from '@tangle-network/sandbox'
import { randomBytes } from 'node:crypto'
import {
  type AttestationPolicy,
  type AttestationVerificationResult,
  verifyAttestation,
} from '@tangle-network/tcloud-attestation'

export type TCloudSandboxTee =
  | 'any'
  | 'tdx'
  | 'nitro'
  | 'sev-snp'
  | 'phala-dstack'
  | 'gcp'
  | 'azure'
  | (string & {})

export interface TCloudSandboxCreateOptions {
  name?: string
  image?: string
  environment?: string
  ssh?: boolean
  cpu?: number
  memoryMb?: number
  diskGb?: number
  gitUrl?: string
  gitRef?: string
  backend?: 'opencode' | 'claude-code' | 'codex' | 'amp' | (string & {})
  tee?: TCloudSandboxTee
  sealed?: boolean
  attestationNonce?: string | 'auto'
  verify?: boolean
  attestationPolicy?: Omit<AttestationPolicy, 'expectedNonce'>
}

export interface TCloudSandboxAttestationStatus {
  requested: boolean
  evidenceReturned: boolean
  verified: boolean
  nonceBound: boolean
  errors: string[]
}

export interface TCloudSandboxCreateResult {
  sandbox: unknown
  attestation?: unknown
  verification?: AttestationVerificationResult
  attestationNonce?: string
  attestationStatus: TCloudSandboxAttestationStatus
}

export interface TCloudSandboxConfig {
  apiKey: string
  baseUrl?: string
  timeoutMs?: number
}

const DEFAULT_SANDBOX_URL = 'https://sandbox.tangle.tools'

export class TCloudSandbox {
  private readonly client: Sandbox

  constructor(config: TCloudSandboxConfig) {
    this.client = new Sandbox({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? DEFAULT_SANDBOX_URL,
      timeoutMs: config.timeoutMs,
    })
  }

  async create(options: TCloudSandboxCreateOptions): Promise<TCloudSandboxCreateResult> {
    const effectiveVerify = shouldVerifyAttestation(options)
    const createOptions = buildSandboxCreateOptions({
      ...options,
      verify: effectiveVerify,
    })
    const sandbox = await this.client.create(createOptions as Parameters<Sandbox['create']>[0])

    let attestation = attestationFromMetadata((sandbox as any).metadata)
    if ((effectiveVerify || createOptions.confidential?.attestationNonce) && !attestation) {
      const getTeeAttestation = (sandbox as any).getTeeAttestation
      if (typeof getTeeAttestation !== 'function') {
        throw new Error('Installed @tangle-network/sandbox does not expose TEE attestation fetching')
      }
      attestation = (await getTeeAttestation.call(
        sandbox,
        createOptions.confidential?.attestationNonce
          ? { attestationNonce: createOptions.confidential.attestationNonce }
          : undefined,
      )).attestation
    }

    if (effectiveVerify && !attestation) {
      throw new Error('TEE attestation verification requested but no evidence was returned')
    }

    const verification = effectiveVerify
      ? verifyAttestation(attestation as any, {
          ...options.attestationPolicy,
          expectedNonce: createOptions.confidential?.attestationNonce,
        })
      : undefined

    if (verification && !verification.valid) {
      throw new Error(`TEE attestation verification failed: ${verification.errors.join('; ')}`)
    }

    return {
      sandbox,
      attestation,
      verification,
      attestationNonce: createOptions.confidential?.attestationNonce,
      attestationStatus: {
        requested: Boolean(options.tee),
        evidenceReturned: Boolean(attestation),
        verified: Boolean(verification?.valid),
        nonceBound: Boolean(createOptions.confidential?.attestationNonce && verification?.valid),
        errors: verification?.errors ?? [],
      },
    }
  }
}

export function buildSandboxCreateOptions(options: TCloudSandboxCreateOptions): any {
  if (!options.tee && (options.sealed || options.attestationNonce || options.verify)) {
    throw new Error('TEE options require a tee value')
  }

  const shouldGenerateNonce =
    options.attestationNonce === 'auto' ||
    (shouldVerifyAttestation(options) && !options.attestationNonce)
  const attestationNonce = shouldGenerateNonce
    ? generateAttestationNonce()
    : options.attestationNonce

  return {
    name: options.name,
    environment: options.environment ?? options.image,
    sshEnabled: options.ssh || undefined,
    git: options.gitUrl
      ? {
          url: options.gitUrl,
          ref: options.gitRef,
        }
      : undefined,
    resources:
      options.cpu || options.memoryMb || options.diskGb
        ? {
            cpuCores: options.cpu,
            memoryMB: options.memoryMb,
            diskGB: options.diskGb,
          }
        : undefined,
    backend: options.backend ? { type: options.backend } : undefined,
    confidential: options.tee
      ? {
          tee: options.tee,
          sealed: options.sealed || undefined,
          attestationNonce,
          attestationRefresh: Boolean(attestationNonce),
        }
      : undefined,
  }
}

export function shouldVerifyAttestation(options: Pick<TCloudSandboxCreateOptions, 'tee' | 'verify'>): boolean {
  return Boolean(options.tee || options.verify)
}

function generateAttestationNonce(bytes = 32): string {
  return Array.from(randomBytes(bytes))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function attestationFromMetadata(metadata: Record<string, unknown> | undefined): unknown {
  const raw = metadata?.teeAttestationJson
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
