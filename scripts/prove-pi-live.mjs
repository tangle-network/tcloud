#!/usr/bin/env node
// Run in a fresh HOME so an unrelated saved wallet cannot replace the API key.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

assert.ok(process.env.TANGLE_API_KEY, 'Set a funded TANGLE_API_KEY without printing it')
assert.equal(existsSync(join(process.env.HOME ?? '', '.tcloud', 'wallets.json')), false, 'Use a fresh HOME for this key-funded proof')
const tools = new Map()
const events = new Map()
const { default: extension } = await import('../packages/tcloud-agent/dist/pi-extension.js')
extension({
  on(name, callback) { events.set(name, callback) },
  registerTool(tool) { tools.set(tool.name, tool) },
})
const ctx = { hasUI: false, sessionManager: { getSessionId: () => 'sweep4-live-proof' } }
await events.get('session_start')?.({}, ctx)
const tool = tools.get('tangle')
assert.ok(tool, 'Pi did not register the real tangle tool')
const marker = `pi-tcloud-ok-${randomUUID()}`
const input = {
  model: process.env.TCLOUD_MODEL || 'gpt-4o-mini',
  messages: [{ role: 'user', content: `Reply with exactly ${marker}` }],
  max_tokens: 1200,
}
const result = await tool.execute('sweep4-proof', { capability: 'chat', input }, undefined, undefined, ctx)
assert.notEqual(result.isError, true, 'Pi tool returned an error')
const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
assert.ok(text.includes(marker), 'Reply omitted the unique request marker')
console.log(JSON.stringify({ proof: 'built-pi-tool', marker, input, response: JSON.parse(text) }, null, 2))
await events.get('session_shutdown')?.({}, ctx)
