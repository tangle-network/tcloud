#!/usr/bin/env node

/**
 * tcloud CLI — Tangle AI Cloud command-line interface
 *
 * Uses the same TCloudClient as the SDK. Adds terminal UI, config file
 * management, device flow auth, and interactive chat mode.
 */

import { Command } from 'commander'
import { TCloud } from './index'
import { generateWallet, signSpendAuth, estimateCost, type ShieldedWallet } from './shielded'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'

const CONFIG_DIR = path.join(process.env.HOME || '~', '.tcloud')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const WALLETS_FILE = path.join(CONFIG_DIR, 'wallets.json')

// ─── Config ──────────────────────────────────────────────────

interface CLIConfig {
  apiUrl: string
  apiKey?: string
  defaultModel: string
  chainId: number
}

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
}

function loadConfig(): CLIConfig {
  ensureDir()
  if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
  return { apiUrl: 'https://router.tangle.tools', defaultModel: 'gpt-4o-mini', chainId: 3799 }
}

function saveConfig(c: CLIConfig) {
  ensureDir()
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), { mode: 0o600 })
}

function loadWallets(): (ShieldedWallet & { label?: string; createdAt?: string })[] {
  ensureDir()
  if (fs.existsSync(WALLETS_FILE)) return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'))
  return []
}

function saveWallets(w: any[]) {
  ensureDir()
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(w, null, 2), { mode: 0o600 })
}

function getClient(opts?: { private?: boolean }): TCloud | ReturnType<typeof TCloud.shielded> {
  const config = loadConfig()
  if (opts?.private) {
    const wallets = loadWallets()
    if (wallets.length === 0) {
      console.error('No shielded wallets. Run: tcloud wallet generate')
      process.exit(1)
    }
    return TCloud.shielded({ baseURL: `${config.apiUrl}/v1`, wallet: wallets[0] as ShieldedWallet })
  }
  return new TCloud({ baseURL: `${config.apiUrl}/v1`, apiKey: config.apiKey, model: config.defaultModel })
}

// ─── CLI Setup ──────────────────────────────────────────────

const program = new Command()
program.name('tcloud').description('Tangle AI Cloud CLI').version('0.1.0')

// ── config ──

program.command('config')
  .description('View or update configuration')
  .option('--api-url <url>', 'API base URL')
  .option('--api-key <key>', 'API key')
  .option('--model <model>', 'Default model')
  .option('--chain <id>', 'Chain ID')
  .action((opts) => {
    const c = loadConfig()
    if (opts.apiUrl) c.apiUrl = opts.apiUrl
    if (opts.apiKey) c.apiKey = opts.apiKey
    if (opts.model) c.defaultModel = opts.model
    if (opts.chain) c.chainId = parseInt(opts.chain)
    saveConfig(c)
    console.log(JSON.stringify(c, null, 2))
  })

// ── auth ──

const auth = program.command('auth').description('Authentication')

auth.command('login').description('Log in via browser (device flow)').action(async () => {
  const config = loadConfig()
  try {
    const res = await fetch(`${config.apiUrl}/api/auth/device`, { method: 'POST' })
    if (!res.ok) { console.error('Auth server error'); process.exit(1) }
    const d = await res.json() as any
    console.log(`\n  Open: ${d.verification_url}\n  Code: ${d.user_code}\n\n  Waiting...`)
    const deadline = Date.now() + (d.expires_in || 600) * 1000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, (d.interval || 5) * 1000))
      const r = await fetch(`${config.apiUrl}/api/auth/device/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: d.device_code }),
      })
      const t = await r.json() as any
      if (t.access_token) { config.apiKey = t.access_token; saveConfig(config); console.log('\n  Authenticated!'); return }
      if (t.error === 'expired_token') { console.error('\n  Code expired.'); process.exit(1) }
      process.stdout.write('.')
    }
    console.error('\n  Timed out.')
  } catch (e: any) { console.error('Failed:', e.message) }
})

auth.command('set-key').description('Set API key directly').argument('<key>').action((key) => {
  const c = loadConfig(); c.apiKey = key; saveConfig(c); console.log('API key saved.')
})

auth.command('status').description('Show auth status').action(() => {
  const c = loadConfig()
  console.log(c.apiKey ? `Authenticated: ${c.apiKey.slice(0, 15)}...` : 'Not authenticated')
  const w = loadWallets()
  if (w.length) console.log(`Shielded wallets: ${w.length}`)
})

// ── wallet ──

const wallet = program.command('wallet').description('Shielded wallet management')

wallet.command('generate').description('Generate ephemeral wallet').option('-l, --label <name>').action((opts) => {
  const w = generateWallet()
  const wallets = loadWallets()
  wallets.push({ ...w, label: opts.label, createdAt: new Date().toISOString() })
  saveWallets(wallets)
  console.log(`Wallet generated:`)
  console.log(`  Address:    ${w.address}`)
  console.log(`  Commitment: ${w.commitment}`)
  console.log(`  Saved to:   ${WALLETS_FILE}`)
  console.log(`\nFund with: tcloud credits fund`)
})

wallet.command('list').description('List wallets').action(() => {
  const wallets = loadWallets()
  if (!wallets.length) { console.log('No wallets. Run: tcloud wallet generate'); return }
  wallets.forEach((w: any, i: number) => console.log(`  [${i}] ${(w.label || 'default').padEnd(15)} ${w.commitment.slice(0, 20)}...`))
})

// ── chat ──

program.command('chat')
  .description('Chat with a model')
  .argument('[message]', 'Message (or interactive if omitted)')
  .option('-m, --model <model>', 'Model')
  .option('--private', 'Use shielded credits (anonymous)')
  .option('--stream', 'Stream output', true)
  .action(async (message, opts) => {
    const client = getClient({ private: opts.private })
    const model = opts.model || loadConfig().defaultModel

    if (!message) {
      // Interactive mode
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      console.log(`tcloud chat — ${model}${opts.private ? ' (private)' : ''}\nCtrl+C to exit.\n`)
      const ask = () => rl.question('> ', async (input) => {
        if (!input.trim()) { ask(); return }
        try {
          for await (const chunk of client.askStream(input.trim(), { model })) {
            process.stdout.write(chunk)
          }
          process.stdout.write('\n\n')
        } catch (e: any) { console.error('Error:', e.message) }
        ask()
      })
      ask()
      return
    }

    try {
      if (opts.stream) {
        for await (const chunk of client.askStream(message, { model })) {
          process.stdout.write(chunk)
        }
        process.stdout.write('\n')
      } else {
        const completion = await client.askFull(message, { model })
        const text = completion.choices[0]?.message?.content || ''
        const usedModel = completion.model || model
        const usage = completion.usage
        process.stdout.write(`[${usedModel}] ${text}\n`)
        if (usage) {
          const cost = usage.total_tokens * 0.000001 // rough estimate
          process.stdout.write(`  \u21B3 ${usage.total_tokens} tokens \u00B7 $${cost.toFixed(6)}\n`)
        }
      }
    } catch (e: any) {
      console.error('Error:', e.message)
      if (e.status === 402) console.error('Add credits: tcloud credits fund')
    }
  })

// ── models ──

program.command('models')
  .description('List available models')
  .option('-s, --search <query>', 'Search')
  .action(async (opts) => {
    const client = getClient()
    try {
      let models = await client.models()
      if (opts.search) {
        const q = opts.search.toLowerCase()
        models = models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      }
      console.log(`${models.length} models:`)
      models.slice(0, 30).forEach(m => console.log(`  ${m.id.padEnd(40)} ${m.name || ''}`))
      if (models.length > 30) console.log(`  ... +${models.length - 30} more`)
    } catch (e: any) { console.error('Error:', e.message) }
  })

// ── operators ──

program.command('operators')
  .description('List active operators')
  .action(async () => {
    const client = getClient()
    try {
      const { operators, stats } = await client.operators()
      console.log(`${stats.activeOperators} operators, ${stats.totalModels} models:\n`)
      operators.forEach((o: any) =>
        console.log(`  ${o.slug.padEnd(20)} ${o.status.padEnd(10)} ${String(o.models.length).padEnd(3)} models  ${o.reputationScore}% rep  ${o.avgLatencyMs}ms`)
      )
    } catch (e: any) { console.error('Error:', e.message) }
  })

// ── credits ──

const credits = program.command('credits').description('Credit management')

credits.command('balance').description('Check balance').action(async () => {
  const client = getClient()
  try {
    const data = await client.credits()
    console.log(`Balance: $${data.balance.toFixed(4)}`)
    if (data.transactions.length) {
      console.log('\nRecent transactions:')
      data.transactions.slice(0, 5).forEach((t: any) =>
        console.log(`  ${t.amount > 0 ? '+' : ''}$${Math.abs(t.amount).toFixed(4).padEnd(10)} ${t.description}`)
      )
    }
  } catch (e: any) { console.error('Error:', e.message) }
})

credits.command('add').description('Add credits').argument('<amount>').action(async (amount) => {
  const client = getClient()
  try {
    const data = await client.addCredits(parseFloat(amount))
    console.log(`Credits added. New balance: $${data.balance.toFixed(4)}`)
  } catch (e: any) { console.error('Error:', e.message) }
})

credits.command('fund').description('Fund shielded credits from pool').action(() => {
  console.log('Shielded credit funding requires integration with the VAnchor pool.')
  console.log('See: https://docs.tangle.tools/privacy/funding')
})

// ── keys ──

const keys = program.command('keys').description('API key management')

keys.command('create').description('Create API key').argument('<name>').action(async (name) => {
  const config = loadConfig()
  try {
    const res = await fetch(`${config.apiUrl}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ name }),
    })
    const data = await res.json() as any
    if (data.key) { console.log(`Key created: ${data.key}\nSave this — shown once only.`) }
    else console.error('Error:', data.error)
  } catch (e: any) { console.error('Error:', e.message) }
})

keys.command('list').description('List API keys').action(async () => {
  const config = loadConfig()
  try {
    const res = await fetch(`${config.apiUrl}/api/keys`, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    })
    const data = await res.json() as any
    if (data.keys?.length) data.keys.forEach((k: any) => console.log(`  ${k.id.slice(0, 8)} ${k.name.padEnd(20)} ${k.keyPrefix}`))
    else console.log('No keys.')
  } catch (e: any) { console.error('Error:', e.message) }
})

program.parse()
