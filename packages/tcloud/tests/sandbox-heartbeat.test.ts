import { describe, expect, it, vi } from 'vitest'
import {
  createTeeAttestationChallenge,
  startTeeAttestationHeartbeat,
} from '../src/sandbox'

const NOW = 1_700_000_000

function attestation(nonceHex: string) {
  const bytes = nonceHex.match(/../g)?.map(byte => Number.parseInt(byte, 16)) ?? []
  return {
    tee_type: 'Tdx',
    evidence: [9, 9, ...bytes, 8, 8],
    measurement: [0xbe, 0xef],
    timestamp: NOW,
  }
}

describe('TCloudSandbox attestation heartbeat', () => {
  it('builds context-bound 64-byte attestation challenges', () => {
    const challenge = createTeeAttestationChallenge('session-1:result-hash')

    expect(challenge.nonce).toMatch(/^[0-9a-f]{128}$/)
    expect(challenge.randomHex).toMatch(/^[0-9a-f]{64}$/)
    expect(challenge.contextHashHex).toMatch(/^[0-9a-f]{64}$/)
    expect(challenge.nonce).toBe(`${challenge.randomHex}${challenge.contextHashHex}`)
  })

  it('fetches and verifies nonce-bound heartbeat attestations', async () => {
    const getTeeAttestation = vi.fn(async (options?: { attestationNonce?: string }) => ({
      sandbox_id: 'sandbox-tee',
      attestation: attestation(options?.attestationNonce ?? ''),
    }))
    const sandbox = { getTeeAttestation }

    const heartbeat = startTeeAttestationHeartbeat(sandbox, {
      tee: 'tdx',
      immediate: false,
      sessionId: 'session-1',
      attestationPolicy: {
        allowUnverifiedHardware: true,
        maxAgeSeconds: 60,
        now: NOW + 10,
      },
    })

    const sample = await heartbeat.ping()
    heartbeat.stop()

    expect(sample.context).toBe('session-1:1')
    expect(sample.nonce).toMatch(/^[0-9a-f]{128}$/)
    expect(sample.verification.valid).toBe(true)
    expect(heartbeat.latest).toBe(sample)
  })

  it('runs async hardware verification through the heartbeat loop', async () => {
    const getTeeAttestation = vi.fn(async (options?: { attestationNonce?: string }) => ({
      sandbox_id: 'sandbox-tee',
      attestation: attestation(options?.attestationNonce ?? ''),
    }))
    const hardwareVerifier = vi.fn(async (attestation: { teeType: string }) => ({
      valid: attestation.teeType === 'tdx',
    }))
    const heartbeat = startTeeAttestationHeartbeat(
      { getTeeAttestation },
      {
        tee: 'tdx',
        immediate: false,
        attestationPolicy: { hardwareVerifier },
      },
    )

    const sample = await heartbeat.ping()
    heartbeat.stop()

    expect(sample.verification.valid).toBe(true)
    expect(hardwareVerifier).toHaveBeenCalledWith(expect.objectContaining({
      teeType: 'tdx',
    }))
  })

  it('fails closed on invalid heartbeat evidence', async () => {
    const heartbeat = startTeeAttestationHeartbeat(
      {
        getTeeAttestation: vi.fn(async () => ({
          sandbox_id: 'sandbox-tee',
          attestation: attestation('11'.repeat(32)),
        })),
      },
      {
        tee: 'tdx',
        immediate: false,
        attestationPolicy: { allowUnverifiedHardware: true },
      },
    )

    await expect(heartbeat.ping()).rejects.toThrow(
      'TEE attestation heartbeat verification failed',
    )
    heartbeat.stop()
  })
})
