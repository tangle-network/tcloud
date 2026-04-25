import { X509Certificate, createPublicKey, createVerify } from 'node:crypto'

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
  /**
   * Optional vendor/root verifier. Use this to plug in Intel PCS, AMD KDS,
   * AWS Nitro, or cloud-provider verification without weakening the default
   * fail-closed behavior.
   */
  hardwareVerifier?: HardwareVerifier
}

export interface AttestationVerificationResult {
  valid: boolean
  attestation?: ParsedAttestation
  errors: string[]
}

export interface HardwareVerifierResult {
  valid: boolean
  errors?: string[]
}

export type HardwareVerifier =
  (attestation: ParsedAttestation) => boolean | HardwareVerifierResult

export type AsyncHardwareVerifier =
  (attestation: ParsedAttestation) =>
    | boolean
    | HardwareVerifierResult
    | Promise<boolean | HardwareVerifierResult>

export interface AsyncAttestationPolicy extends Omit<AttestationPolicy, 'hardwareVerifier'> {
  hardwareVerifier?: AsyncHardwareVerifier
}

export interface SevSnpReport {
  version: number
  guestSvn: number
  policy: bigint
  familyId: Uint8Array
  imageId: Uint8Array
  vmpl: number
  signatureAlgorithm: number
  reportData: Uint8Array
  measurement: Uint8Array
  chipId: Uint8Array
  reportedTcb: {
    bootloader: number
    tee: number
    snp: number
    microcode: number
  }
}

export interface SevSnpVerifierOptions {
  /** AMD product line for KDS, e.g. Milan, Genoa, Bergamo, Siena, Turin. */
  productName?: string
  /** VCEK certificate as PEM or DER. When omitted, productName is used to fetch from AMD KDS. */
  vcekCertificate?: string | Uint8Array
  /** VCEK public key PEM. Useful for tests or callers that validate cert chains externally. */
  publicKeyPem?: string
  /** AMD ASK certificate PEM used to verify the VCEK certificate. */
  askCertificatePem?: string
  /** AMD ARK certificate PEM used to verify the ASK certificate. */
  arkCertificatePem?: string
  /** AMD KDS base URL. Defaults to https://kdsintf.amd.com. */
  kdsBaseUrl?: string
  /** Fetch implementation. Defaults to global fetch. */
  fetch?: typeof fetch
  /** Disable AMD KDS cert-chain validation. Use only when VCEK trust is established out of band. */
  skipCertificateChainValidation?: boolean
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
  const parsed = verifyAttestationPolicy(value, policy)
  if (!parsed.attestation || parsed.errors.length > 0) {
    return {
      valid: false,
      attestation: parsed.attestation,
      errors: parsed.errors,
    }
  }

  if (policy.hardwareVerifier) {
    const hardwareResult = policy.hardwareVerifier(parsed.attestation)
    if (isPromiseLike(hardwareResult)) {
      return {
        valid: false,
        attestation: parsed.attestation,
        errors: ['hardwareVerifier returned a Promise; use verifyAttestationAsync'],
      }
    }
    parsed.errors.push(...hardwareVerifierErrors(hardwareResult))
  } else if (!policy.allowUnverifiedHardware) {
    parsed.errors.push(defaultHardwareVerifierError(parsed.attestation.teeType))
  }

  return {
    valid: parsed.errors.length === 0,
    attestation: parsed.attestation,
    errors: parsed.errors,
  }
}

export async function verifyAttestationAsync(
  value: string | RuntimeAttestationJson,
  policy: AsyncAttestationPolicy = {},
): Promise<AttestationVerificationResult> {
  const parsed = verifyAttestationPolicy(value, policy)
  if (!parsed.attestation || parsed.errors.length > 0) {
    return {
      valid: false,
      attestation: parsed.attestation,
      errors: parsed.errors,
    }
  }

  if (policy.hardwareVerifier) {
    parsed.errors.push(...hardwareVerifierErrors(
      await policy.hardwareVerifier(parsed.attestation),
    ))
  } else if (!policy.allowUnverifiedHardware) {
    parsed.errors.push(defaultHardwareVerifierError(parsed.attestation.teeType))
  }

  return {
    valid: parsed.errors.length === 0,
    attestation: parsed.attestation,
    errors: parsed.errors,
  }
}

function verifyAttestationPolicy(
  value: string | RuntimeAttestationJson,
  policy: Omit<AsyncAttestationPolicy, 'hardwareVerifier'>,
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
    if (!attestationContainsReportData(attestation, nonce)) {
      errors.push('attestation evidence does not contain the expected nonce report data')
    }
  }

  return {
    valid: errors.length === 0,
    attestation,
    errors,
  }
}

export function parseSevSnpReport(evidence: Uint8Array): SevSnpReport {
  if (evidence.length < SNP_SIGNATURE_S_OFFSET + SNP_SIGNATURE_FIELD_SIZE) {
    throw new Error(`SEV-SNP report is too short: ${evidence.length} bytes`)
  }

  return {
    version: readU32(evidence, 0x00),
    guestSvn: readU32(evidence, 0x04),
    policy: readU64(evidence, 0x08),
    familyId: evidence.slice(0x10, 0x20),
    imageId: evidence.slice(0x20, 0x30),
    vmpl: readU32(evidence, 0x30),
    signatureAlgorithm: readU32(evidence, 0x34),
    reportData: evidence.slice(SNP_REPORT_DATA_OFFSET, SNP_REPORT_DATA_OFFSET + SNP_REPORT_DATA_SIZE),
    measurement: evidence.slice(SNP_MEASUREMENT_OFFSET, SNP_MEASUREMENT_OFFSET + SNP_MEASUREMENT_SIZE),
    chipId: evidence.slice(SNP_CHIP_ID_OFFSET, SNP_CHIP_ID_OFFSET + SNP_CHIP_ID_SIZE),
    reportedTcb: decodeSnpTcb(readU64(evidence, SNP_REPORTED_TCB_OFFSET)),
  }
}

export function createSevSnpHardwareVerifier(
  options: SevSnpVerifierOptions = {},
): AsyncHardwareVerifier {
  return async (attestation) => {
    if (attestation.teeType !== 'sev-snp') {
      return {
        valid: false,
        errors: [`SEV-SNP verifier cannot verify ${attestation.teeType} evidence`],
      }
    }

    let report: SevSnpReport
    try {
      report = parseSevSnpReport(attestation.evidence)
    } catch (error) {
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }

    if (report.signatureAlgorithm !== SNP_ECDSA_P384_SHA384_ALGO) {
      return {
        valid: false,
        errors: [`unsupported SEV-SNP signature algorithm ${report.signatureAlgorithm}`],
      }
    }

    try {
      const publicKey = options.publicKeyPem
        ? createPublicKey(options.publicKeyPem)
        : await vcekPublicKey(attestation, report, options)
      const signature = sevSnpSignatureToIeeeP1363(attestation.evidence)
      const verifier = createVerify('sha384')
      verifier.update(Buffer.from(attestation.evidence.slice(0, SNP_SIGNED_BYTES)))
      verifier.end()
      const valid = verifier.verify({
        key: publicKey,
        dsaEncoding: 'ieee-p1363',
      }, signature)

      return valid
        ? { valid: true }
        : { valid: false, errors: ['SEV-SNP report signature verification failed'] }
    } catch (error) {
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }
  }
}

export function createTdxHardwareVerifier(): HardwareVerifier {
  return (attestation) => {
    if (attestation.teeType !== 'tdx') {
      return {
        valid: false,
        errors: [`TDX verifier cannot verify ${attestation.teeType} evidence`],
      }
    }

    if (attestation.evidence.length === 1024) {
      return {
        valid: false,
        errors: [
          'TDX evidence is a TDREPORT, not a remotely verifiable quote; configure the runtime to return a DCAP TD quote before enabling TDX hardware verification',
        ],
      }
    }

    return {
      valid: false,
      errors: [
        'TDX quote verification is not implemented in tcloud-attestation yet; use Intel DCAP/Trust Authority verifier and pass it as hardwareVerifier',
      ],
    }
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

const SNP_REPORT_DATA_OFFSET = 0x50
const SNP_REPORT_DATA_SIZE = 64
const SNP_MEASUREMENT_OFFSET = 0x90
const SNP_MEASUREMENT_SIZE = 48
const SNP_REPORTED_TCB_OFFSET = 0x180
const SNP_CHIP_ID_OFFSET = 0x1a0
const SNP_CHIP_ID_SIZE = 64
const SNP_SIGNED_BYTES = 0x2a0
const SNP_SIGNATURE_R_OFFSET = 0x2a0
const SNP_SIGNATURE_S_OFFSET = 0x2e8
const SNP_SIGNATURE_FIELD_SIZE = 72
const SNP_ECDSA_P384_SHA384_ALGO = 1

function attestationContainsReportData(attestation: ParsedAttestation, reportData: Uint8Array): boolean {
  if (attestation.teeType === 'sev-snp' && attestation.evidence.length >= SNP_REPORT_DATA_OFFSET + SNP_REPORT_DATA_SIZE) {
    return constantTimeEqual(
      attestation.evidence.slice(SNP_REPORT_DATA_OFFSET, SNP_REPORT_DATA_OFFSET + SNP_REPORT_DATA_SIZE),
      reportData,
    )
  }

  return constantTimeContainsSubarray(attestation.evidence, reportData)
}

function hardwareVerifierErrors(result: boolean | HardwareVerifierResult): string[] {
  const valid = typeof result === 'boolean' ? result : result.valid
  if (valid) return []
  if (typeof result !== 'boolean' && result.errors?.length) return result.errors
  return ['hardware quote signature verification failed']
}

function defaultHardwareVerifierError(teeType: TeeType): string {
  if (teeType === 'tdx') {
    return 'hardware quote signature verification is required for tdx; raw TDREPORT evidence is not remotely verifiable'
  }
  return `hardware quote signature verification is required but not implemented for ${teeType}; set allowUnverifiedHardware only after external verification`
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

async function vcekPublicKey(
  attestation: ParsedAttestation,
  report: SevSnpReport,
  options: SevSnpVerifierOptions,
) {
  const vcek = options.vcekCertificate
    ? new X509Certificate(options.vcekCertificate)
    : await fetchVcekCertificate(report, options)

  if (!options.skipCertificateChainValidation) {
    const chain = options.askCertificatePem && options.arkCertificatePem
      ? {
          ask: new X509Certificate(options.askCertificatePem),
          ark: new X509Certificate(options.arkCertificatePem),
        }
      : await fetchAmdCertificateChain(options)

    if (!vcek.verify(chain.ask.publicKey)) {
      throw new Error('AMD VCEK certificate was not signed by the AMD ASK')
    }
    if (!chain.ask.verify(chain.ark.publicKey)) {
      throw new Error('AMD ASK certificate was not signed by the AMD ARK')
    }
    if (!chain.ark.verify(chain.ark.publicKey)) {
      throw new Error('AMD ARK certificate is not self-signed')
    }
  }

  // Keep this reference so a future lint pass cannot remove the parsed report
  // from the trust path by accident.
  if (!constantTimeEqual(report.measurement, attestation.measurement)) {
    throw new Error('SEV-SNP report measurement does not match attestation wrapper measurement')
  }

  return vcek.publicKey
}

async function fetchVcekCertificate(report: SevSnpReport, options: SevSnpVerifierOptions): Promise<X509Certificate> {
  if (!options.productName) {
    throw new Error('SEV-SNP verification requires productName or vcekCertificate/publicKeyPem')
  }

  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('SEV-SNP verification requires fetch or a supplied VCEK certificate')
  }

  const baseUrl = (options.kdsBaseUrl ?? 'https://kdsintf.amd.com').replace(/\/+$/, '')
  const params = new URLSearchParams({
    blSPL: String(report.reportedTcb.bootloader),
    teeSPL: String(report.reportedTcb.tee),
    snpSPL: String(report.reportedTcb.snp),
    ucodeSPL: String(report.reportedTcb.microcode),
  })
  const url = `${baseUrl}/vcek/v1/${encodeURIComponent(options.productName)}/${toHex(report.chipId)}?${params}`
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`AMD KDS VCEK fetch failed: HTTP ${response.status}`)
  }
  return new X509Certificate(new Uint8Array(await response.arrayBuffer()))
}

async function fetchAmdCertificateChain(options: SevSnpVerifierOptions): Promise<{
  ask: X509Certificate
  ark: X509Certificate
}> {
  if (!options.productName) {
    throw new Error('AMD certificate chain validation requires productName or supplied ASK/ARK certificates')
  }

  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('AMD certificate chain validation requires fetch or supplied ASK/ARK certificates')
  }

  const baseUrl = (options.kdsBaseUrl ?? 'https://kdsintf.amd.com').replace(/\/+$/, '')
  const response = await fetchImpl(`${baseUrl}/vcek/v1/${encodeURIComponent(options.productName)}/cert_chain`)
  if (!response.ok) {
    throw new Error(`AMD KDS certificate chain fetch failed: HTTP ${response.status}`)
  }

  const pem = await response.text()
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
  if (certs.length < 2) {
    throw new Error('AMD KDS certificate chain did not contain ASK and ARK certificates')
  }

  const first = new X509Certificate(certs[0]!)
  const second = new X509Certificate(certs[1]!)
  if (first.verify(second.publicKey) && second.verify(second.publicKey)) {
    return { ask: first, ark: second }
  }
  if (second.verify(first.publicKey) && first.verify(first.publicKey)) {
    return { ask: second, ark: first }
  }

  throw new Error('AMD KDS certificate chain did not contain a valid ASK/ARK pair')
}

function sevSnpSignatureToIeeeP1363(evidence: Uint8Array): Buffer {
  const r = littleEndianP384Integer(evidence.slice(
    SNP_SIGNATURE_R_OFFSET,
    SNP_SIGNATURE_R_OFFSET + SNP_SIGNATURE_FIELD_SIZE,
  ))
  const s = littleEndianP384Integer(evidence.slice(
    SNP_SIGNATURE_S_OFFSET,
    SNP_SIGNATURE_S_OFFSET + SNP_SIGNATURE_FIELD_SIZE,
  ))
  return Buffer.concat([r, s])
}

function littleEndianP384Integer(value: Uint8Array): Buffer {
  return Buffer.from(value.slice(0, 48)).reverse()
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true)
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true)
}

function decodeSnpTcb(value: bigint): SevSnpReport['reportedTcb'] {
  return {
    bootloader: Number(value & 0xffn),
    tee: Number((value >> 8n) & 0xffn),
    snp: Number((value >> 48n) & 0xffn),
    microcode: Number((value >> 56n) & 0xffn),
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i]
  }
  return diff === 0
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
