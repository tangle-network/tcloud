/**
 * API key management — create, list, revoke keys programmatically.
 *
 * Run: TCLOUD_API_KEY=sk-tan-... npx tsx examples/07-api-keys.ts
 */
import { TCloud } from 'tcloud'

const client = new TCloud({ apiKey: process.env.TCLOUD_API_KEY })

// Create a new key
const { key, id } = await client.createKey('my-app-production')
console.log(`Created key: ${key}`)
console.log(`  ID: ${id}`)
console.log(`  Store this key securely — it won't be shown again.`)

// List all keys
const keys = await client.keys()
console.log(`\n${keys.length} keys:`)
for (const k of keys) {
  console.log(`  ${k.name} (${k.prefix}...) — last used: ${k.lastUsedAt || 'never'}`)
}

// Revoke the key we just created
await client.revokeKey(id)
console.log(`\nRevoked key ${id}`)
