export type TeeType =
  | 'tdx'
  | 'nitro'
  | 'sev-snp'
  | 'phala-dstack'
  | 'gcp'
  | 'azure'
  | 'none'

export interface ParsedAttestation {
  teeType: TeeType
  rawTeeType: string
  evidence: Uint8Array
  measurement: Uint8Array
  timestamp: number
}

export interface AttestationPolicy {
  /**
   * Accepted TEE backends. Empty means any non-None TEE.
   */
  acceptedTeeTypes?: TeeType[]
  /**
   * Hex-encoded measurements accepted by the caller. Empty means any
   * measurement is accepted.
   */
  acceptedMeasurements?: string[]
  /**
   * Expected caller challenge, as hex or bytes. For TDX/SEV reports this must
   * be present in signed report data inside the evidence.
   */
  expectedNonce?: string | Uint8Array
  /**
   * Maximum allowed report age in seconds.
   */
  maxAgeSeconds?: number
  /**
   * Current time override for tests, in unix seconds.
   */
  now?: number
  /**
   * Hardware quote signature verification is not implemented in this package
   * yet. The default is fail-closed. Set true only in development or when a
   * separate verifier already authenticated the quote.
   */
  allowUnverifiedHardware?: boolean
}

export interface AttestationVerificationResult {
  valid: boolean
  attestation?: ParsedAttestation
  errors: string[]
}

interface RuntimeAttestationJson {
  tee_type?: unknown
  evidence?: unknown
  measurement?: unknown
  timestamp?: unknown
}

export function parseAttestation(
  value: string | RuntimeAttestationJson,
): ParsedAttestation {
  const raw = typeof value === 'string' ? JSON.parse(value) as RuntimeAttestationJson : value
  const rawTeeType = stringField(raw.tee_type, 'tee_type')

  return {
    teeType: normalizeTeeType(rawTeeType),
    rawTeeType,
    evidence: bytesField(raw.evidence, 'evidence'),
    measurement: bytesField(raw.measurement, 'measurement'),
    timestamp: numberField(raw.timestamp, 'timestamp'),
  }
}

export function verifyAttestation(
  value: string | RuntimeAttestationJson,
  policy: AttestationPolicy = {},
): AttestationVerificationResult {
  const errors: string[] = []
  let attestation: ParsedAttestation

  try {
    attestation = parseAttestation(value)
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    }
  }

  const acceptedTeeTypes = policy.acceptedTeeTypes?.length
    ? policy.acceptedTeeTypes
    : (['tdx', 'nitro', 'sev-snp', 'phala-dstack', 'gcp', 'azure'] satisfies TeeType[])

  if (!acceptedTeeTypes.includes(attestation.teeType)) {
    errors.push(`TEE type ${attestation.teeType} is not accepted`)
  }

  if (attestation.evidence.length === 0) {
    errors.push('attestation evidence is empty')
  }

  if (attestation.measurement.length === 0) {
    errors.push('attestation measurement is empty')
  }

  if (policy.maxAgeSeconds != null) {
    const now = policy.now ?? Math.floor(Date.now() / 1000)
    if (attestation.timestamp > now + 60) {
      errors.push('attestation timestamp is in the future')
    } else if (now - attestation.timestamp > policy.maxAgeSeconds) {
      errors.push(`attestation is older than ${policy.maxAgeSeconds} seconds`)
    }
  }

  if (policy.acceptedMeasurements?.length) {
    const measurementHex = toHex(attestation.measurement)
    const accepted = new Set(policy.acceptedMeasurements.map(normalizeHex))
    if (!accepted.has(measurementHex)) {
      errors.push('attestation measurement is not in the accepted allowlist')
    }
  }

  if (policy.expectedNonce != null) {
    const nonce = nonceReportData(policy.expectedNonce)
    if (!constantTimeContainsSubarray(attestation.evidence, nonce)) {
      errors.push('attestation evidence does not contain the expected nonce report data')
    }
  }

  if (!policy.allowUnverifiedHardware) {
    errors.push(
      `hardware quote signature verification is required but not implemented for ${attestation.teeType}; set allowUnverifiedHardware only after external verification`,
    )
  }

  return {
    valid: errors.length === 0,
    attestation,
    errors,
  }
}

export function assertAttestation(
  value: string | RuntimeAttestationJson,
  policy: AttestationPolicy = {},
): ParsedAttestation {
  const result = verifyAttestation(value, policy)
  if (!result.valid) {
    throw new Error(result.errors.join('; '))
  }
  return result.attestation!
}

export function normalizeTeeType(value: string): TeeType {
  switch (value.toLowerCase().replace(/_/g, '-')) {
    case 'tdx':
      return 'tdx'
    case 'nitro':
    case 'aws-nitro':
      return 'nitro'
    case 'sev':
    case 'sev-snp':
      return 'sev-snp'
    case 'phala':
    case 'phala-dstack':
      return 'phala-dstack'
    case 'gcp':
    case 'gcp-confidential-space':
    case 'confidential-space':
      return 'gcp'
    case 'azure':
    case 'azure-confidential-compute':
      return 'azure'
    case 'none':
      return 'none'
    default:
      throw new Error(`unsupported TEE type: ${value}`)
  }
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`attestation ${field} must be a non-empty string`)
  }
  return value
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`attestation ${field} must be a finite number`)
  }
  return value
}

function bytesField(value: unknown, field: string): Uint8Array {
  if (!Array.isArray(value)) {
    throw new Error(`attestation ${field} must be a byte array`)
  }

  return Uint8Array.from(value.map((byte) => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`attestation ${field} contains a non-byte value`)
    }
    return byte
  }))
}

function nonceReportData(value: string | Uint8Array): Uint8Array {
  const nonce = typeof value === 'string'
    ? fromHex(value)
    : value

  if (nonce.length < 32 || nonce.length > 64) {
    throw new Error(`attestation nonce must be 32-64 bytes, got ${nonce.length}`)
  }

  const reportData = new Uint8Array(64)
  reportData.set(nonce)
  return reportData
}

function fromHex(value: string): Uint8Array {
  const normalized = normalizeHex(value)
  if (normalized.length % 2 !== 0) {
    throw new Error('hex value must have even length')
  }

  const bytes = new Uint8Array(normalized.length / 2)
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16)
  }
  return bytes
}

function normalizeHex(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]*$/.test(normalized)) {
    throw new Error('hex value contains non-hex characters')
  }
  return normalized
}

function constantTimeContainsSubarray(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false

  let found = 0
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let diff = 0
    for (let j = 0; j < needle.length; j++) {
      diff |= haystack[i + j] ^ needle[j]
    }
    found |= (diff - 1) >>> 31
  }

  return found === 1
}
