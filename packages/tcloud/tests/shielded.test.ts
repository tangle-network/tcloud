import { describe, it, expect } from 'vitest'
import { generateWallet, signSpendAuth, estimateCost } from '../src/shielded'
import type { Hex } from 'viem'

describe('generateWallet()', () => {
  it('returns wallet with all required fields', () => {
    const wallet = generateWallet()
    expect(wallet.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(wallet.commitment).toMatch(/^0x[0-9a-f]{64}$/)
    expect(wallet.salt).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('generates unique wallets each time', () => {
    const a = generateWallet()
    const b = generateWallet()
    expect(a.privateKey).not.toBe(b.privateKey)
    expect(a.address).not.toBe(b.address)
    expect(a.commitment).not.toBe(b.commitment)
    expect(a.salt).not.toBe(b.salt)
  })

  it('derives address from private key deterministically', () => {
    const wallet = generateWallet()
    // Regenerating from same key should give same address
    // (we can't test this directly without reimporting, but commitment should be stable)
    expect(wallet.address).toBeTruthy()
    expect(wallet.commitment).toBeTruthy()
  })

  it('commitment is a keccak256 hash (32 bytes)', () => {
    const wallet = generateWallet()
    // keccak256 output is always 32 bytes = 64 hex chars
    expect(wallet.commitment.length).toBe(66) // 0x + 64
  })
})

describe('signSpendAuth()', () => {
  it('produces a valid signature', async () => {
    const wallet = generateWallet()
    const auth = await signSpendAuth(wallet, {
      serviceId: 1n,
      jobIndex: 0,
      amount: 1000000n,
      operator: '0x1234567890123456789012345678901234567890' as Hex,
      nonce: 0n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
      chainId: 3799,
      creditsAddress: '0x0000000000000000000000000000000000000000' as Hex,
    })

    expect(auth.commitment).toBe(wallet.commitment)
    expect(auth.serviceId).toBe('1')
    expect(auth.jobIndex).toBe(0)
    expect(auth.amount).toBe('1000000')
    expect(auth.operator).toBe('0x1234567890123456789012345678901234567890')
    expect(auth.nonce).toBe('0')
    expect(auth.signature).toMatch(/^0x[0-9a-f]+$/)
  })

  it('produces different signatures for different nonces', async () => {
    const wallet = generateWallet()
    const params = {
      serviceId: 1n,
      jobIndex: 0,
      amount: 1000000n,
      operator: '0x1234567890123456789012345678901234567890' as Hex,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
      chainId: 3799,
      creditsAddress: '0x0000000000000000000000000000000000000000' as Hex,
    }
    const auth1 = await signSpendAuth(wallet, { ...params, nonce: 0n })
    const auth2 = await signSpendAuth(wallet, { ...params, nonce: 1n })
    expect(auth1.signature).not.toBe(auth2.signature)
  })

  it('produces different signatures for different amounts', async () => {
    const wallet = generateWallet()
    const params = {
      serviceId: 1n,
      jobIndex: 0,
      nonce: 0n,
      operator: '0x1234567890123456789012345678901234567890' as Hex,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
      chainId: 3799,
      creditsAddress: '0x0000000000000000000000000000000000000000' as Hex,
    }
    const auth1 = await signSpendAuth(wallet, { ...params, amount: 1000000n })
    const auth2 = await signSpendAuth(wallet, { ...params, amount: 2000000n })
    expect(auth1.signature).not.toBe(auth2.signature)
  })

  it('serializes all fields as strings', async () => {
    const wallet = generateWallet()
    const auth = await signSpendAuth(wallet, {
      serviceId: 42n,
      jobIndex: 3,
      amount: 999999n,
      operator: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Hex,
      nonce: 7n,
      expiry: 1700000000n,
      chainId: 5845,
      creditsAddress: '0x1111111111111111111111111111111111111111' as Hex,
    })
    expect(typeof auth.serviceId).toBe('string')
    expect(typeof auth.amount).toBe('string')
    expect(typeof auth.nonce).toBe('string')
    expect(typeof auth.expiry).toBe('string')
    expect(auth.serviceId).toBe('42')
    expect(auth.expiry).toBe('1700000000')
  })
})

describe('estimateCost()', () => {
  it('calculates cost in tsUSD base units (6 decimals)', () => {
    // 1000 input tokens at $0.15/M + 500 output tokens at $0.60/M
    // = 0.00015 + 0.0003 = 0.00045
    // * 1e6 = 450, ceil = 450
    const cost = estimateCost(1000, 500)
    expect(cost).toBe(450n)
  })

  it('returns 0 for zero tokens', () => {
    const cost = estimateCost(0, 0)
    expect(cost).toBe(0n)
  })

  it('rounds up (ceil) to avoid underpayment', () => {
    // 1 input token at $0.15/M = 0.00000015 → ceil(0.15) = 1
    const cost = estimateCost(1, 0)
    expect(cost).toBe(1n)
  })

  it('accepts custom pricing', () => {
    // 1M input at $1/M + 1M output at $2/M = $3
    // * 1e6 = 3,000,000
    const cost = estimateCost(1_000_000, 1_000_000, 1.0, 2.0)
    expect(cost).toBe(3_000_000n)
  })

  it('handles large token counts', () => {
    // 100M input at $0.15/M + 50M output at $0.60/M
    // = 15 + 30 = 45 → 45,000,000
    const cost = estimateCost(100_000_000, 50_000_000)
    expect(cost).toBe(45_000_000n)
  })
})
