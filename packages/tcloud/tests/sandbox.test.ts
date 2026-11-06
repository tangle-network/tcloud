import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildSandboxCreateOptions, shouldVerifyAttestation, TCloudSandbox } from '../src/sandbox'

describe('tcloud sandbox facade', () => {
  it('maps tcloud options to sandbox create options', () => {
    const options = buildSandboxCreateOptions({
      name: 'tee-box',
      image: 'ubuntu:24.04',
      ssh: true,
      cpu: 2,
      memoryMb: 4096,
      diskGb: 20,
      gitUrl: 'https://github.com/tangle-network/tcloud.git',
      gitRef: 'develop',
      backend: 'codex',
      tee: 'tdx',
      sealed: true,
      attestationNonce: 'auto',
    })

    expect(options).toMatchObject({
      name: 'tee-box',
      environment: 'ubuntu:24.04',
      sshEnabled: true,
      git: {
        url: 'https://github.com/tangle-network/tcloud.git',
        ref: 'develop',
      },
      resources: {
        cpuCores: 2,
        memoryMB: 4096,
        diskGB: 20,
      },
      backend: { type: 'codex' },
      confidential: {
        tee: 'tdx',
        sealed: true,
        attestationRefresh: true,
      },
    })
    expect(options.confidential.attestationNonce).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not request confidential routing unless tee is set', () => {
    expect(buildSandboxCreateOptions({ name: 'plain' })).toMatchObject({
      name: 'plain',
      confidential: undefined,
    })
  })

  it('sends the GPU lease budget and accelerator through the Sandbox HTTP API', async () => {
    const accelerator = { kind: 'nvidia-a100', count: 1, memoryMB: 40960 }
    const gpuLease = { provider: 'runpod' as const, maxSpendUsd: 1, maxLifetimeSeconds: 300 }
    const received: unknown[] = []
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      received.push({ path: req.url, authorization: req.headers.authorization, body })
      res.setHeader('Content-Type', 'application/json')
      res.statusCode = body.gpuLease ? 201 : 400
      res.end(JSON.stringify(body.gpuLease
        ? { id: 'gpu-proof', status: 'running', metadata: {} }
        : { error: 'GPU lease options required', code: 'GPU_LEASE_OPTIONS_REQUIRED' }))
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as { port: number }
    try {
      const client = new TCloudSandbox({ apiKey: 'local-proof', baseUrl: `http://127.0.0.1:${address.port}` })
      const result = await client.create({ accelerator, gpuLease })
      expect((result.sandbox as { id: string }).id).toBe('gpu-proof')
      expect(received).toEqual([expect.objectContaining({
        path: '/v1/sandboxes', authorization: 'Bearer local-proof',
        body: expect.objectContaining({ resources: expect.objectContaining({ accelerator }), gpuLease }),
      })])
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('omits resources when neither cpu/mem/disk nor accelerator is set', () => {
    expect(buildSandboxCreateOptions({ name: 'cpu-only' }).resources).toBeUndefined()
  })

  it('rejects TEE-only options without a tee request', () => {
    expect(() => buildSandboxCreateOptions({
      name: 'bad',
      attestationNonce: 'auto',
    })).toThrow('TEE options require a tee value')
  })

  it('rejects malformed caller nonce challenges before creation', () => {
    expect(() => buildSandboxCreateOptions({
      name: 'bad-nonce',
      tee: 'tdx',
      attestationNonce: '11',
    })).toThrow('attestation nonce must be 32-64 bytes, got 1')

    expect(() => buildSandboxCreateOptions({
      name: 'bad-nonce',
      tee: 'tdx',
      attestationNonce: 'zz'.repeat(32),
    })).toThrow('attestation nonce must be hex')
  })

  it('generates a nonce when verification is requested', () => {
    const options = buildSandboxCreateOptions({
      name: 'verified',
      tee: 'nitro',
      verify: true,
    })

    expect(options.confidential.attestationNonce).toMatch(/^[0-9a-f]{64}$/)
    expect(options.confidential.attestationRefresh).toBe(true)
  })

  it('verifies TEE requests by default', () => {
    expect(shouldVerifyAttestation({ tee: 'tdx' })).toBe(true)
    expect(shouldVerifyAttestation({ tee: 'tdx', verify: false })).toBe(true)
    expect(shouldVerifyAttestation({ verify: true })).toBe(true)

    const options = buildSandboxCreateOptions({
      name: 'default-verified',
      tee: 'nitro',
    })

    expect(options.confidential.attestationNonce).toMatch(/^[0-9a-f]{64}$/)
    expect(options.confidential.attestationRefresh).toBe(true)
  })
})
