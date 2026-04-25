import { afterEach, describe, expect, it, vi } from 'vitest'

const NOW = 1_700_000_000

function attestation(nonceHex: string) {
  return {
    tee_type: 'tdx',
    evidence: [9, 9, ...nonceReportData(nonceHex), 8, 8],
    measurement: [0xbe, 0xef],
    timestamp: NOW,
  }
}

function nitroAttestation(nonceHex: string) {
  return {
    ...attestation(nonceHex),
    tee_type: 'Nitro',
  }
}

function sevAttestation(nonceHex: string) {
  return {
    ...attestation(nonceHex),
    tee_type: 'Sev',
  }
}

function nonceReportData(nonceHex: string): number[] {
  const bytes = nonceHex.match(/../g)?.map(byte => Number.parseInt(byte, 16)) ?? []
  const reportData = new Array(64).fill(0)
  bytes.forEach((byte, index) => {
    reportData[index] = byte
  })
  return reportData
}

describe('TCloudSandbox.create', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('@tangle-network/sandbox')
    vi.unstubAllGlobals()
  })

  it('verifies TEE attestation by default and exposes status', async () => {
    const nonce = '11'.repeat(32)
    const createdSandbox = {
      id: 'sandbox-1',
      metadata: {
        teeAttestationJson: JSON.stringify(attestation(nonce)),
      },
    }
    const create = vi.fn(async () => createdSandbox)

    vi.doMock('@tangle-network/sandbox', () => ({
      Sandbox: vi.fn(function Sandbox() {
        return { create }
      }),
    }))

    const { TCloudSandbox } = await import('../src/sandbox')
    const client = new TCloudSandbox({ apiKey: 'test-key' })
    const result = await client.create({
      tee: 'tdx',
      attestationNonce: nonce,
      attestationPolicy: {
        allowUnverifiedHardware: true,
        maxAgeSeconds: 60,
        now: NOW + 10,
      },
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      confidential: expect.objectContaining({
        tee: 'tdx',
        attestationNonce: nonce,
        attestationRefresh: true,
      }),
    }))
    expect(result.verification?.valid).toBe(true)
    expect(result.attestationStatus).toEqual({
      requested: true,
      evidenceReturned: true,
      verified: true,
      nonceBound: true,
      errors: [],
    })
  })

  it('fails closed for TEE requests when hardware verification is not allowed', async () => {
    const nonce = '22'.repeat(32)
    const create = vi.fn(async () => ({
      id: 'sandbox-2',
      metadata: {
        teeAttestationJson: JSON.stringify(attestation(nonce)),
      },
    }))

    vi.doMock('@tangle-network/sandbox', () => ({
      Sandbox: vi.fn(function Sandbox() {
        return { create }
      }),
    }))

    const { TCloudSandbox } = await import('../src/sandbox')
    const client = new TCloudSandbox({ apiKey: 'test-key' })

    await expect(client.create({
      tee: 'tdx',
      attestationNonce: nonce,
    })).rejects.toThrow('raw TDREPORT evidence is not remotely verifiable')
  })

  it('fails closed when returned attestation type does not match requested TEE', async () => {
    const nonce = '44'.repeat(32)
    const create = vi.fn(async () => ({
      id: 'sandbox-4',
      metadata: {
        teeAttestationJson: JSON.stringify(nitroAttestation(nonce)),
      },
    }))

    vi.doMock('@tangle-network/sandbox', () => ({
      Sandbox: vi.fn(function Sandbox() {
        return { create }
      }),
    }))

    const { TCloudSandbox } = await import('../src/sandbox')
    const client = new TCloudSandbox({ apiKey: 'test-key' })

    await expect(client.create({
      tee: 'tdx',
      attestationNonce: nonce,
      attestationPolicy: {
        allowUnverifiedHardware: true,
      },
    })).rejects.toThrow('TEE type nitro is not accepted')
  })

  it('accepts provider requests only when attestation matches their hardware class', async () => {
    const nonce = '55'.repeat(32)
    const create = vi.fn(async () => ({
      id: 'sandbox-5',
      metadata: {
        teeAttestationJson: JSON.stringify(sevAttestation(nonce)),
      },
    }))

    vi.doMock('@tangle-network/sandbox', () => ({
      Sandbox: vi.fn(function Sandbox() {
        return { create }
      }),
    }))

    const { TCloudSandbox } = await import('../src/sandbox')
    const client = new TCloudSandbox({ apiKey: 'test-key' })
    const result = await client.create({
      tee: 'azure',
      attestationNonce: nonce,
      attestationPolicy: {
        allowUnverifiedHardware: true,
      },
    })

    expect(result.verification?.valid).toBe(true)
    expect(result.verification?.attestation?.teeType).toBe('sev-snp')
  })

  it('rejects conflicting caller attestation policy before creation', async () => {
    const create = vi.fn(async () => ({ id: 'sandbox-6', metadata: {} }))

    vi.doMock('@tangle-network/sandbox', () => ({
      Sandbox: vi.fn(function Sandbox() {
        return { create }
      }),
    }))

    const { TCloudSandbox } = await import('../src/sandbox')
    const client = new TCloudSandbox({ apiKey: 'test-key' })

    await expect(client.create({
      tee: 'tdx',
      attestationPolicy: {
        acceptedTeeTypes: ['nitro'],
        allowUnverifiedHardware: true,
      },
    })).rejects.toThrow('TEE attestation policy does not accept requested TEE type tdx')
    expect(create).not.toHaveBeenCalled()
  })

  it('fetches nonce-bound attestation when metadata does not include evidence', async () => {
    const nonce = '33'.repeat(32)
    const getTeeAttestation = vi.fn(async () => ({
      attestation: attestation(nonce),
    }))
    const createdSandbox = {
      id: 'sandbox-3',
      metadata: {},
      getTeeAttestation,
    }
    const create = vi.fn(async () => createdSandbox)

    vi.doMock('@tangle-network/sandbox', () => ({
      Sandbox: vi.fn(function Sandbox() {
        return { create }
      }),
    }))

    const { TCloudSandbox } = await import('../src/sandbox')
    const client = new TCloudSandbox({ apiKey: 'test-key' })
    const result = await client.create({
      tee: 'tdx',
      attestationNonce: nonce,
      attestationPolicy: {
        allowUnverifiedHardware: true,
      },
    })

    expect(getTeeAttestation).toHaveBeenCalledWith({ attestationNonce: nonce })
    expect(result.attestationStatus.verified).toBe(true)
    expect(result.attestationStatus.nonceBound).toBe(true)
  })

  it('falls back to sandbox API TEE routes when installed sandbox SDK lacks helpers', async () => {
    const nonce = '66'.repeat(32)
    const createdSandbox = {
      id: 'sandbox-legacy-sdk',
      metadata: {},
    }
    const create = vi.fn(async () => createdSandbox)
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => new Response(
      JSON.stringify({ sandbox_id: 'sandbox-legacy-sdk', attestation: attestation(nonce) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))

    vi.stubGlobal('fetch', fetch)
    vi.doMock('@tangle-network/sandbox', () => ({
      Sandbox: vi.fn(function Sandbox() {
        return { create }
      }),
    }))

    const { TCloudSandbox, startTeeAttestationHeartbeat } = await import('../src/sandbox')
    const client = new TCloudSandbox({
      apiKey: 'test-key',
      baseUrl: 'https://sandbox.example/',
    })
    const result = await client.create({
      tee: 'tdx',
      attestationNonce: nonce,
      attestationPolicy: {
        allowUnverifiedHardware: true,
      },
    })

    expect(fetch).toHaveBeenCalledWith(
      'https://sandbox.example/v1/sandboxes/sandbox-legacy-sdk/tee/attestation',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ attestation_nonce: nonce }),
      }),
    )
    const headers = fetch.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer test-key')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(result.attestationStatus.verified).toBe(true)
    expect(typeof (result.sandbox as any).getTeeAttestation).toBe('function')
    expect(typeof (result.sandbox as any).getTeePublicKey).toBe('function')

    fetch.mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          sandbox_id: 'sandbox-legacy-sdk',
          attestation: attestation(body.attestation_nonce),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    const heartbeat = startTeeAttestationHeartbeat(result.sandbox, {
      tee: 'tdx',
      immediate: false,
      attestationPolicy: {
        allowUnverifiedHardware: true,
      },
    })
    const sample = await heartbeat.ping()
    heartbeat.stop()
    expect(sample.verification.valid).toBe(true)
  })
})
