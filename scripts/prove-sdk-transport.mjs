#!/usr/bin/env node
// Operator proof, not a unit suite. Uses real TCP sockets and the built SDK.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { TCloudClient } from '../packages/tcloud/dist/index.js'

async function cancellation(kind, relayed = false) {
  const abort = new AbortController()
  let requests = 0
  let disconnected = false
  let watchdog
  let abortTimer
  const server = createServer((req, res) => {
    requests++
    req.resume()
    res.once('close', () => { disconnected = true })
    if (kind === 'retry') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"proof retry"}}')
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write('{"choices":[')
      watchdog = setTimeout(() => res.end(']}'), 3000)
    }
    abortTimer = setTimeout(() => abort.abort(new DOMException('operator cancelled', 'AbortError')), 30)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const client = new TCloudClient({
    apiKey: 'local-proof-only', baseURL: `${base}/v1`, timeout: 0,
    retry: { maxRetries: 3, initialBackoffMs: 1500 },
    ...(relayed ? { privacy: { mode: 'relayer', relayerUrl: base } } : {}),
  })
  const started = Date.now()
  try {
    const work = kind === 'search'
      ? client.search({ query: 'proof', signal: abort.signal })
      : client.chat({ messages: [{ role: 'user', content: 'proof' }], signal: abort.signal })
    await assert.rejects(work, { name: 'AbortError' })
    assert.ok(Date.now() - started < 1000, 'abort waited for the response or retry')
    for (let i = 0; i < 50 && !disconnected; i++) await sleep(10)
    assert.equal(disconnected, true, 'server did not see the closed request')
    await sleep(100)
    assert.equal(requests, 1, 'caller cancellation retried')
    console.log(JSON.stringify({ proof: 'cancellation', kind, relayed, requests, disconnected, elapsedMs: Date.now() - started }))
  } finally {
    clearTimeout(watchdog)
    clearTimeout(abortTimer)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

async function receipts() {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const model = JSON.parse(body).model
    const headers = { 'Content-Type': 'application/json' }
    if (model !== 'missing') headers['X-Tangle-Cost-USD'] = model === 'first' ? '0.01' : '0.02'
    res.writeHead(200, headers)
    res.end(JSON.stringify({
      id: model, model, choices: [{ message: { role: 'assistant', content: model } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      tangle: { costUsd: 999, costSource: 'receipt' },
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = new TCloudClient({ apiKey: 'local-proof-only', baseURL: `http://127.0.0.1:${server.address().port}/v1` })
  try {
    const results = await Promise.all(['first', 'second', 'missing'].map(model => client.chat({ model, messages: [{ role: 'user', content: 'proof' }] })))
    assert.equal(results[0].tangle.costUsd, 0.01)
    assert.equal(results[1].tangle.costUsd, 0.02)
    assert.equal(results[2].tangle, undefined, 'missing price was labelled as a receipt')
    console.log(JSON.stringify({ proof: 'per-response-cost', receipts: results.map(r => r.tangle ?? null) }))
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

async function receiptWithoutUsage() {
  let requests = 0
  const reached = []
  const server = createServer((req, res) => {
    requests++
    req.resume()
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Tangle-Cost-USD': '0.033' })
    res.end(JSON.stringify({ id: 'header-only', choices: [{ message: { role: 'assistant', content: 'proof' } }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = new TCloudClient({
    apiKey: 'local-proof-only', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    limits: { maxTotalSpend: 0.03, maxCostPerRequest: 0.02, onLimitReached: event => reached.push(event) },
  })
  try {
    const result = await client.chat({ messages: [{ role: 'user', content: 'proof' }] })
    console.log(JSON.stringify({ proof: 'receipt-without-usage', receipt: result.tangle ?? null, usage: client.usage }))
    assert.deepEqual(result.tangle, { costUsd: 0.033, costSource: 'receipt' })
    assert.equal(client.usage.totalSpent, 0.033)
    assert.deepEqual(reached, [{ type: 'cost', current: 0.033, limit: 0.02 }])
    await assert.rejects(client.chat({ messages: [{ role: 'user', content: 'blocked' }] }), { status: 429 })
    assert.equal(requests, 1, 'spend limit allowed another upstream request')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

await cancellation('chat')
await cancellation('search')
await cancellation('retry')
await cancellation('chat', true)
await receipts()
await receiptWithoutUsage()
