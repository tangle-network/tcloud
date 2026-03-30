/**
 * Private inference — anonymous requests via ShieldedCredits.
 *
 * No API key. No account. The operator verifies payment cryptographically
 * without learning your identity.
 *
 * How it works:
 * 1. Generates an ephemeral secp256k1 keypair
 * 2. Derives a commitment: keccak256(address, salt)
 * 3. Before each request, signs an EIP-712 SpendAuth message
 * 4. Sends the signature as X-Payment-Signature header
 * 5. Operator verifies on-chain, serves inference, claims payment
 *
 * Run: npx tsx examples/04-private-inference.ts
 */
import { TCloud } from 'tcloud'

const client = TCloud.shielded({
  model: 'gpt-4o-mini',
  // Optional: route through a privacy relay to hide your IP
  // privacy: { mode: 'relayer', relayerUrl: 'http://localhost:8787' },
})

const answer = await client.ask('What are zero-knowledge proofs?')
console.log(answer)

// Auto-replenish: monitor balance and fund when low
// TCloud.shielded({
//   autoReplenish: {
//     minBalance: 1000n,
//     replenishAmount: 10000n,
//     fundingSource: 'relayer',
//     relayerUrl: 'http://localhost:8787',
//   },
// })
