import { describe, expect, it } from 'vitest'
import {
  parseAttestation,
  toHex,
  verifyAttestation,
} from '../src/index.js'

function report(overrides: Record<string, unknown> = {}) {
  return {
    tee_type: 'Tdx',
    evidence: [1, 2, 3],
    measurement: [0xbe, 0xef],
    timestamp: 1_700_000_000,
    ...overrides,
  }
}

describe('tcloud-attestation', () => {
  it('parses runtime attestation JSON', () => {
    const parsed = parseAttestation(JSON.stringify(report()))

    expect(parsed.teeType).toBe('tdx')
    expect(toHex(parsed.measurement)).toBe('beef')
    expect(parsed.timestamp).toBe(1_700_000_000)
  })

  it('normalizes supported cloud TEE labels', () => {
    expect(parseAttestation(report({ tee_type: 'gcp-confidential-space' })).teeType).toBe('gcp')
    expect(parseAttestation(report({ tee_type: 'azure-confidential-compute' })).teeType).toBe('azure')
  })

  it('checks policy fields but fails closed without hardware verification', () => {
    const result = verifyAttestation(report(), {
      acceptedTeeTypes: ['tdx'],
      acceptedMeasurements: ['beef'],
      maxAgeSeconds: 60,
      now: 1_700_000_010,
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'hardware quote signature verification is required but not implemented for tdx; set allowUnverifiedHardware only after external verification',
    )
  })

  it('can be used after a separate hardware verifier authenticated the quote', () => {
    const result = verifyAttestation(report(), {
      acceptedTeeTypes: ['tdx'],
      acceptedMeasurements: ['0xbeef'],
      maxAgeSeconds: 60,
      now: 1_700_000_010,
      allowUnverifiedHardware: true,
    })

    expect(result.valid).toBe(true)
  })

  it('requires nonce report data to appear in evidence', () => {
    const nonce = Uint8Array.from(Array.from({ length: 32 }, () => 0x11))
    const reportData = new Uint8Array(64)
    reportData.set(nonce)

    const ok = verifyAttestation(report({
      evidence: [9, 9, ...reportData, 8, 8],
    }), {
      expectedNonce: nonce,
      allowUnverifiedHardware: true,
    })

    const bad = verifyAttestation(report(), {
      expectedNonce: nonce,
      allowUnverifiedHardware: true,
    })

    expect(ok.valid).toBe(true)
    expect(bad.valid).toBe(false)
    expect(bad.errors).toContain(
      'attestation evidence does not contain the expected nonce report data',
    )
  })

  it('rejects attestation timestamps beyond clock skew', () => {
    const result = verifyAttestation(report({
      timestamp: 1_700_000_071,
    }), {
      maxAgeSeconds: 60,
      now: 1_700_000_010,
      allowUnverifiedHardware: true,
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('attestation timestamp is in the future')
  })

  it('throws on invalid accepted measurement hex', () => {
    expect(() => verifyAttestation(report(), {
      acceptedMeasurements: ['0xgg'],
      allowUnverifiedHardware: true,
    })).toThrow('hex value contains non-hex characters')
  })

  it('throws on empty nonce challenges', () => {
    expect(() => verifyAttestation(report(), {
      expectedNonce: new Uint8Array(),
      allowUnverifiedHardware: true,
    })).toThrow('attestation nonce must be 32-64 bytes, got 0')

    expect(() => verifyAttestation(report(), {
      expectedNonce: '',
      allowUnverifiedHardware: true,
    })).toThrow('attestation nonce must be 32-64 bytes, got 0')
  })
})
