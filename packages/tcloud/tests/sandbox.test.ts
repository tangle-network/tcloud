import { describe, expect, it } from 'vitest'
import { buildSandboxCreateOptions } from '../src/sandbox'

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

  it('rejects TEE-only options without a tee request', () => {
    expect(() => buildSandboxCreateOptions({
      name: 'bad',
      attestationNonce: 'auto',
    })).toThrow('TEE options require a tee value')
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
})
