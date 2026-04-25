import { describe, expect, it } from 'vitest'
import { normalizeTeeType, verifyAttestation } from '../src/attestation'

describe('tcloud attestation subpath', () => {
  it('re-exports verifier helpers', () => {
    expect(normalizeTeeType('Tdx')).toBe('tdx')

    const result = verifyAttestation({
      tee_type: 'Tdx',
      evidence: [1, 2, 3],
      measurement: [4, 5, 6],
      timestamp: 1770000000,
    }, {
      allowUnverifiedHardware: true,
      now: 1770000000,
      maxAgeSeconds: 60,
    })

    expect(result.valid).toBe(true)
  })
})
