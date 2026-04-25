import { createSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createNitroHardwareVerifier,
  createSevSnpHardwareVerifier,
  createTdxHardwareVerifier,
  parseAttestation,
  parseNitroAttestationDocument,
  parseSevSnpReport,
  toHex,
  verifyAttestation,
  verifyAttestationAsync,
} from '../src/index.js'

type TestCborValue =
  | number
  | string
  | Uint8Array
  | TestCborValue[]
  | Map<TestCborValue, TestCborValue>
  | null

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

function signedNitroDocument(options: {
  nonce: Uint8Array
  measurement?: Uint8Array
}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp384r1',
  })
  const measurement = options.measurement ?? Uint8Array.from(Array.from({ length: 48 }, () => 0xbe))
  const protectedHeader = encodeTestCbor(new Map<TestCborValue, TestCborValue>([[1, -35]]))
  const payload = encodeTestCbor(new Map<TestCborValue, TestCborValue>([
    ['module_id', 'test-module'],
    ['digest', 'SHA384'],
    ['timestamp', 1_700_000_000_000],
    ['pcrs', new Map<TestCborValue, TestCborValue>([[0, measurement]])],
    ['certificate', Uint8Array.of(1, 2, 3)],
    ['cabundle', []],
    ['nonce', options.nonce],
  ]))
  const signedPayload = encodeTestCbor(['Signature1', protectedHeader, new Uint8Array(), payload])
  const signer = createSign('sha384')
  signer.update(signedPayload)
  signer.end()
  const signature = signer.sign({
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  })

  return {
    evidence: [...encodeTestCbor([protectedHeader, new Map<TestCborValue, TestCborValue>(), payload, signature])],
    measurement: [...measurement],
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function encodeTestCbor(value: TestCborValue): Uint8Array {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('test CBOR integer must be safe')
    return value >= 0
      ? encodeTestCborTypeAndLength(0, value)
      : encodeTestCborTypeAndLength(1, -1 - value)
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value)
    return concatTestBytes(encodeTestCborTypeAndLength(3, bytes.length), bytes)
  }
  if (value instanceof Uint8Array) {
    return concatTestBytes(encodeTestCborTypeAndLength(2, value.length), value)
  }
  if (Array.isArray(value)) {
    return concatTestBytes(encodeTestCborTypeAndLength(4, value.length), ...value.map(encodeTestCbor))
  }
  if (value instanceof Map) {
    const items: Uint8Array[] = []
    for (const [key, entryValue] of value.entries()) {
      items.push(encodeTestCbor(key), encodeTestCbor(entryValue))
    }
    return concatTestBytes(encodeTestCborTypeAndLength(5, value.size), ...items)
  }
  return Uint8Array.of(0xf6)
}

function encodeTestCborTypeAndLength(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length)
  if (length <= 0xff) return Uint8Array.of((major << 5) | 24, length)
  if (length <= 0xffff) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff)
  if (length <= 0xffffffff) {
    return Uint8Array.of(
      (major << 5) | 26,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    )
  }
  const output = new Uint8Array(9)
  output[0] = (major << 5) | 27
  let remaining = BigInt(length)
  for (let i = 8; i > 0; i--) {
    output[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return output
}

function concatTestBytes(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
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

  it('parses and verifies Nitro COSE attestation documents', () => {
    const challenge = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index + 1))
    const nonce = new Uint8Array(64)
    nonce.set(challenge)
    const signed = signedNitroDocument({ nonce })

    const parsed = parseNitroAttestationDocument(Uint8Array.from(signed.evidence))
    expect(parsed.moduleId).toBe('test-module')
    expect(parsed.pcrs.get(0)).toEqual(Uint8Array.from(signed.measurement))

    const result = verifyAttestation(report({
      tee_type: 'Nitro',
      evidence: signed.evidence,
      measurement: signed.measurement,
    }), {
      acceptedTeeTypes: ['nitro'],
      expectedNonce: challenge,
      hardwareVerifier: createNitroHardwareVerifier({
        publicKeyPem: signed.publicKeyPem,
      }),
    })

    expect(result.valid).toBe(true)
  })

  it('rejects tampered Nitro COSE signatures', () => {
    const nonce = Uint8Array.from(Array.from({ length: 64 }, () => 0x22))
    const signed = signedNitroDocument({ nonce })
    signed.evidence[signed.evidence.length - 1] ^= 0xff

    const result = verifyAttestation(report({
      tee_type: 'Nitro',
      evidence: signed.evidence,
      measurement: signed.measurement,
    }), {
      acceptedTeeTypes: ['nitro'],
      expectedNonce: nonce,
      hardwareVerifier: createNitroHardwareVerifier({
        publicKeyPem: signed.publicKeyPem,
      }),
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Nitro attestation document signature verification failed')
  })

  it('rejects Nitro attestations whose signed PCRs do not match the wrapper measurement', () => {
    const nonce = Uint8Array.from(Array.from({ length: 64 }, () => 0x33))
    const signed = signedNitroDocument({ nonce })
    const badMeasurement = Array.from({ length: 48 }, () => 0xaa)

    const result = verifyAttestation(report({
      tee_type: 'Nitro',
      evidence: signed.evidence,
      measurement: badMeasurement,
    }), {
      acceptedTeeTypes: ['nitro'],
      expectedNonce: nonce,
      hardwareVerifier: createNitroHardwareVerifier({
        publicKeyPem: signed.publicKeyPem,
      }),
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Nitro PCR measurements do not match attestation wrapper measurement')
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
