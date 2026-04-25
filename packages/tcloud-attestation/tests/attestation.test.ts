import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createSevSnpHardwareVerifier,
  createTdxHardwareVerifier,
  parseAttestation,
  parseSevSnpReport,
  toHex,
  verifyAttestation,
  verifyAttestationAsync,
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

function signedSevSnpReport(nonce: Uint8Array) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp384r1',
  })
  const evidence = Buffer.alloc(4000)
  evidence.writeUInt32LE(3, 0x00)
  evidence.writeUInt32LE(0, 0x04)
  evidence.writeBigUInt64LE(0n, 0x08)
  evidence.writeUInt32LE(0, 0x30)
  evidence.writeUInt32LE(1, 0x34)
  evidence.set(nonce, 0x50)
  evidence.fill(0xbe, 0x90, 0x90 + 48)
  evidence.fill(0xab, 0x1a0, 0x1a0 + 64)
  evidence.writeBigUInt64LE(0x0700000000000102n, 0x180)

  const signer = createSign('sha384')
  signer.update(evidence.subarray(0, 0x2a0))
  signer.end()
  const signature = signer.sign({
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  evidence.set(Buffer.from(signature.subarray(0, 48)).reverse(), 0x2a0)
  evidence.set(Buffer.from(signature.subarray(48, 96)).reverse(), 0x2e8)

  return {
    evidence: [...evidence],
    measurement: [...evidence.subarray(0x90, 0x90 + 48)],
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
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
      'hardware quote signature verification is required for tdx; raw TDREPORT evidence is not remotely verifiable',
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

  it('accepts a vendor hardware verifier hook without allowUnverifiedHardware', () => {
    const result = verifyAttestation(report(), {
      acceptedTeeTypes: ['tdx'],
      hardwareVerifier: (attestation) => attestation.teeType === 'tdx',
    })

    expect(result.valid).toBe(true)
  })

  it('fails closed when a vendor hardware verifier rejects the quote', () => {
    const result = verifyAttestation(report(), {
      acceptedTeeTypes: ['tdx'],
      hardwareVerifier: () => ({
        valid: false,
        errors: ['Intel PCS quote verification failed'],
      }),
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Intel PCS quote verification failed')
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

  it('strictly checks SEV-SNP nonce report_data and verifies the P-384 report signature', async () => {
    const nonce = Uint8Array.from(Array.from({ length: 64 }, (_, index) => index))
    const signed = signedSevSnpReport(nonce)

    const result = await verifyAttestationAsync(report({
      tee_type: 'Sev',
      evidence: signed.evidence,
      measurement: signed.measurement,
    }), {
      acceptedTeeTypes: ['sev-snp'],
      expectedNonce: nonce,
      hardwareVerifier: createSevSnpHardwareVerifier({
        publicKeyPem: signed.publicKeyPem,
      }),
    })

    expect(result.valid).toBe(true)
    const parsed = parseSevSnpReport(Uint8Array.from(signed.evidence))
    expect(parsed.reportedTcb).toEqual({
      bootloader: 2,
      tee: 1,
      snp: 0,
      microcode: 7,
    })
  })

  it('rejects tampered SEV-SNP report signatures', async () => {
    const nonce = Uint8Array.from(Array.from({ length: 64 }, () => 0x11))
    const signed = signedSevSnpReport(nonce)
    signed.evidence[0x90] ^= 0xff

    const result = await verifyAttestationAsync(report({
      tee_type: 'Sev',
      evidence: signed.evidence,
      measurement: signed.measurement,
    }), {
      acceptedTeeTypes: ['sev-snp'],
      expectedNonce: nonce,
      hardwareVerifier: createSevSnpHardwareVerifier({
        publicKeyPem: signed.publicKeyPem,
      }),
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('SEV-SNP report signature verification failed')
  })

  it('rejects raw TDX TDREPORT evidence as not remotely verifiable', () => {
    const result = verifyAttestation(report({
      tee_type: 'Tdx',
      evidence: Array.from({ length: 1024 }, () => 1),
      measurement: Array.from({ length: 48 }, () => 2),
    }), {
      hardwareVerifier: createTdxHardwareVerifier(),
    })

    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('TDREPORT, not a remotely verifiable quote')
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
