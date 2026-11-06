import { describe, expect, it } from 'vitest'
import { recoverTypedDataAddress, hashTypedData, type Hex } from 'viem'
import {
  buildSpendAuthMessage, generateWallet, signSpendAuth,
  SHIELDED_CREDITS_DOMAIN, SPEND_AUTH_TYPES,
} from '@tangle-network/tcloud/shielded'

describe('published ShieldedCredits signing contract', () => {
  it('builds and signs the contract wire format and binds every spending field', async () => {
    const wallet = generateWallet()
    const params = { commitment: wallet.commitment, serviceId: 7n, jobIndex: 3,
      amount: 1_500_000n, operator: `0x${'cd'.repeat(20)}` as Hex, nonce: 42n, expiry: 1_900_000_000n }
    const chainId = 5845, creditsAddress = `0x${'ef'.repeat(20)}` as Hex
    const typed = buildSpendAuthMessage(params, chainId, creditsAddress)
    expect(SHIELDED_CREDITS_DOMAIN).toEqual({ name: 'ShieldedCredits', version: '1' })
    expect(SPEND_AUTH_TYPES.SpendAuthorization.map(f => `${f.type} ${f.name}`).join(',')).toBe(
      'bytes32 commitment,uint64 serviceId,uint8 jobIndex,uint256 amount,address operator,uint256 nonce,uint64 expiry')
    const signed = await signSpendAuth(wallet, { ...params, chainId, creditsAddress })
    const wire = JSON.parse(JSON.stringify(signed))
    expect(wire).toEqual({ ...params, serviceId: '7', amount: '1500000', nonce: '42', expiry: '1900000000', signature: signed.signature })
    const rehydrated = { ...wire, serviceId: BigInt(wire.serviceId), amount: BigInt(wire.amount), nonce: BigInt(wire.nonce), expiry: BigInt(wire.expiry) }
    expect(hashTypedData(buildSpendAuthMessage(rehydrated, chainId, creditsAddress))).toBe(hashTypedData(typed))
    const recover = (message: typeof typed) => recoverTypedDataAddress({ ...message, signature: signed.signature as Hex })
    expect((await recover(typed)).toLowerCase()).toBe(wallet.address.toLowerCase())
    for (const patch of [{ serviceId: 8n }, { jobIndex: 4 }, { amount: 1n }, { nonce: 43n }, { expiry: 1n },
      { operator: `0x${'12'.repeat(20)}` }, { commitment: `0x${'ab'.repeat(32)}` }]) {
      expect((await recover(buildSpendAuthMessage({ ...params, ...patch }, chainId, creditsAddress))).toLowerCase()).not.toBe(wallet.address.toLowerCase())
    }
    for (const [chain, address] of [[3799, creditsAddress], [chainId, `0x${'11'.repeat(20)}`]] as const) {
      expect((await recover(buildSpendAuthMessage(params, chain, address))).toLowerCase()).not.toBe(wallet.address.toLowerCase())
    }
  })
})
