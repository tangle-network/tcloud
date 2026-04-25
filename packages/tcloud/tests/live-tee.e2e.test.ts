import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Sandbox } from '@tangle-network/sandbox'
import {
  buildSandboxCreateOptions,
  TCloudSandbox,
  type TCloudSandboxTee,
} from '../src/sandbox'
import { verifyAttestation } from '../src/attestation'

const enabled = process.env.TCLOUD_LIVE_TEE_E2E === '1'
const describeLive = enabled ? describe : describe.skip

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required when TCLOUD_LIVE_TEE_E2E=1`)
  }
  return value
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric value, got ${value}`)
  }
  return parsed
}

function livePolicy() {
  const allowUnverifiedHardware = process.env.TCLOUD_LIVE_TEE_ALLOW_UNVERIFIED_HARDWARE === '1'
  if (!allowUnverifiedHardware) {
    throw new Error(
      'TCLOUD_LIVE_TEE_ALLOW_UNVERIFIED_HARDWARE=1 is currently required because vendor-root quote verification is not implemented yet',
    )
  }
  return {
    maxAgeSeconds: optionalNumber(process.env.TCLOUD_LIVE_TEE_MAX_AGE_SECONDS) ?? 300,
    allowUnverifiedHardware,
  }
}

describeLive('live TEE sandbox attestation', () => {
  it('creates a Tangle-backed confidential sandbox and verifies nonce-bound attestation', async () => {
    const apiKey = requiredEnv('TCLOUD_SANDBOX_API_KEY')
    const baseUrl = process.env.TCLOUD_SANDBOX_URL
    const tee = (process.env.TCLOUD_LIVE_TEE_TYPE ?? 'any') as TCloudSandboxTee
    const nonce = randomBytes(32).toString('hex')
    const client = new Sandbox({ apiKey, baseUrl })
    let sandbox: unknown

    const createOptions = buildSandboxCreateOptions({
      name: `tcloud-live-tee-${Date.now()}`,
      image: process.env.TCLOUD_LIVE_TEE_IMAGE ?? 'ubuntu:24.04',
      backend: process.env.TCLOUD_LIVE_TEE_BACKEND ?? 'opencode',
      tee,
      sealed: process.env.TCLOUD_LIVE_TEE_SEALED === '1' || undefined,
      attestationNonce: nonce,
      cpu: optionalNumber(process.env.TCLOUD_LIVE_TEE_CPU),
      memoryMb: optionalNumber(process.env.TCLOUD_LIVE_TEE_MEMORY_MB),
      diskGb: optionalNumber(process.env.TCLOUD_LIVE_TEE_DISK_GB),
    })

    try {
      sandbox = await client.create(createOptions as never)
      const teeSandbox = sandbox as {
        delete?: () => Promise<void>
        metadata?: Record<string, unknown>
        getTeeAttestation?: (options?: { attestationNonce?: string }) => Promise<{ attestation: unknown }>
      }

      const fetched = await teeSandbox.getTeeAttestation?.({ attestationNonce: nonce })
      const attestation = fetched?.attestation ?? attestationFromMetadata(teeSandbox.metadata)
      expect(attestation).toBeTruthy()

      const verification = verifyAttestation(attestation as any, {
        expectedNonce: nonce,
        ...livePolicy(),
      })

      expect(verification.valid).toBe(true)
      expect(verification.errors).toEqual([])
      expect(verification.attestation?.evidence.length).toBeGreaterThan(0)
      expect(verification.attestation?.measurement.length).toBeGreaterThan(0)
    } finally {
      await (sandbox as { delete?: () => Promise<void> } | undefined)?.delete?.()
    }
  })

  it('exercises the high-level tcloud facade status path', async () => {
    const apiKey = requiredEnv('TCLOUD_SANDBOX_API_KEY')
    const baseUrl = process.env.TCLOUD_SANDBOX_URL
    const tee = (process.env.TCLOUD_LIVE_TEE_TYPE ?? 'any') as TCloudSandboxTee
    const nonce = randomBytes(32).toString('hex')
    const client = new TCloudSandbox({ apiKey, baseUrl })
    const result = await client.create({
      name: `tcloud-live-tee-facade-${Date.now()}`,
      image: process.env.TCLOUD_LIVE_TEE_IMAGE ?? 'ubuntu:24.04',
      backend: process.env.TCLOUD_LIVE_TEE_BACKEND ?? 'opencode',
      tee,
      attestationNonce: nonce,
      attestationPolicy: livePolicy(),
    })

    try {
      expect(result.attestation).toBeTruthy()
      expect(result.verification?.valid).toBe(true)
      expect(result.attestationStatus).toMatchObject({
        requested: true,
        evidenceReturned: true,
        verified: true,
        nonceBound: true,
        errors: [],
      })
      expect(result.attestationNonce).toBe(nonce)
      expect(result.verification?.attestation?.evidence.length).toBeGreaterThan(0)
      expect(result.verification?.attestation?.measurement.length).toBeGreaterThan(0)
    } finally {
      const sandbox = result.sandbox as { delete?: () => Promise<void> }
      await sandbox.delete?.()
    }
  })
})

function attestationFromMetadata(metadata: Record<string, unknown> | undefined): unknown {
  const raw = metadata?.teeAttestationJson
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return JSON.parse(raw)
}
