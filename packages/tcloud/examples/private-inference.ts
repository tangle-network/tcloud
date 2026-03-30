import { TCloud } from 'tcloud'

// ShieldedCredits: anonymous inference with no API key.
// Generates an ephemeral wallet and signs EIP-712 SpendAuth per request.
const client = TCloud.shielded()

const answer = await client.ask('What are zero-knowledge proofs?')
console.log(answer)
