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
import { TCloudSandbox, type TCloudSandboxTee } from './sandbox'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { spawn } from 'child_process'

const CONFIG_DIR = path.join(process.env.HOME || '~', '.tcloud')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const WALLETS_FILE = path.join(CONFIG_DIR, 'wallets.json')

// ─── Config ──────────────────────────────────────────────────

interface CLIConfig {
  apiUrl: string
  sandboxUrl?: string
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

function requireApiKey(config: CLIConfig): string {
  if (!config.apiKey) {
    console.error('No API key. Run: tcloud login')
    process.exit(1)
  }
  return config.apiKey
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number, got ${String(value)}`)
  }
  return parsed
}

function teeType(value: string | undefined): TCloudSandboxTee | undefined {
  if (!value) return undefined
  return value.toLowerCase() as TCloudSandboxTee
}

function packageVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { version?: unknown }
    if (typeof packageJson.version === 'string') return packageJson.version
  } catch {
    // Keep the CLI usable if package metadata is unavailable in a dev bundle.
  }
  return '0.0.0'
}

// ─── CLI Setup ──────────────────────────────────────────────

const program = new Command()
program.name('tcloud').description('Tangle AI Cloud CLI').version(packageVersion())

// ── config ──

program.command('config')
  .description('View or update configuration')
  .option('--api-url <url>', 'API base URL')
  .option('--sandbox-url <url>', 'Sandbox API base URL')
  .option('--api-key <key>', 'API key')
  .option('--model <model>', 'Default model')
  .option('--chain <id>', 'Chain ID')
  .action((opts) => {
    const c = loadConfig()
    if (opts.apiUrl) c.apiUrl = opts.apiUrl
    if (opts.sandboxUrl) c.sandboxUrl = opts.sandboxUrl
    if (opts.apiKey) c.apiKey = opts.apiKey
    if (opts.model) c.defaultModel = opts.model
    if (opts.chain) c.chainId = parseInt(opts.chain)
    saveConfig(c)
    console.log(JSON.stringify(c, null, 2))
  })

// ── auth ──

const auth = program.command('auth').description('Authentication')

function openBrowser(url: string): boolean {
  if (process.env.NO_BROWSER || process.env.CI) return false
  if (!process.stdout.isTTY) return false
  try {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open'
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true })
    child.unref()
    return true
  } catch { return false }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

async function runDeviceFlow(mode: 'signup' | 'login'): Promise<void> {
  const config = loadConfig()

  const initRes = await fetch(`${config.apiUrl}/api/auth/device`, { method: 'POST' })
  if (!initRes.ok) {
    console.error(`\n  ✗ Auth server returned ${initRes.status}.`)
    process.exit(1)
  }
  const d = await initRes.json() as {
    device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number
  }

  // Deep-link the code into the URL so one click authenticates.
  const urlWithCode = `${d.verification_url}?user_code=${encodeURIComponent(d.user_code)}`
  const opened = openBrowser(urlWithCode)

  // Turso-style presentation block
  const header = mode === 'signup' ? 'Creating your Tangle account' : 'Signing you in'
  console.log(`\n  ${header}\n`)
  console.log(`  ${opened ? 'Browser opened:' : 'Open this URL:'}`)
  console.log(`  ${urlWithCode}\n`)
  console.log(`  Verification code: ${d.user_code}\n`)

  const deadline = Date.now() + (d.expires_in || 600) * 1000
  const interval = Math.max(2, d.interval || 5) * 1000
  const spinnerEnabled = process.stdout.isTTY && !process.env.CI
  let frame = 0

  function tickSpinner() {
    if (!spinnerEnabled) return
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000))
    process.stdout.write(`\r  ${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} waiting for browser confirmation (${remaining}s remaining)  `)
  }

  const spinnerTimer = spinnerEnabled ? setInterval(tickSpinner, 100) : null
  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, interval))
      const r = await fetch(`${config.apiUrl}/api/auth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: d.device_code }),
      })
      const t = await r.json() as { access_token?: string; error?: string }
      if (t.access_token) {
        config.apiKey = t.access_token
        saveConfig(config)
        if (spinnerTimer) { clearInterval(spinnerTimer); process.stdout.write('\r' + ' '.repeat(80) + '\r') }
        console.log(`  ✓ Authenticated`)
        console.log(`  ✓ API key saved to ${CONFIG_FILE}\n`)
        console.log(`  Try it:`)
        console.log(`    tcloud whoami`)
        console.log(`    tcloud chat "hello world"\n`)
        return
      }
      if (t.error === 'expired_token') {
        if (spinnerTimer) { clearInterval(spinnerTimer); process.stdout.write('\r' + ' '.repeat(80) + '\r') }
        console.error(`  ✗ Code expired. Run 'tcloud auth ${mode}' again.`)
        process.exit(1)
      }
    }
    if (spinnerTimer) { clearInterval(spinnerTimer); process.stdout.write('\r' + ' '.repeat(80) + '\r') }
    console.error(`  ✗ Timed out after ${Math.round((d.expires_in || 600) / 60)} minutes.`)
    process.exit(1)
  } finally {
    if (spinnerTimer) clearInterval(spinnerTimer)
  }
}

auth.command('signup').description('Create an account via browser (device flow)').action(() => runDeviceFlow('signup'))
auth.command('login').description('Log in via browser (device flow)').action(() => runDeviceFlow('login'))

auth.command('logout').description('Remove stored credentials').action(() => {
  const c = loadConfig()
  delete c.apiKey
  saveConfig(c)
  console.log(`  ✓ Logged out. Config kept at ${CONFIG_FILE}.`)
})

auth.command('set-key').description('Set API key directly').argument('<key>').action((key) => {
  const c = loadConfig(); c.apiKey = key; saveConfig(c); console.log('  ✓ API key saved.')
})

auth.command('status').description('Show auth status').action(() => {
  const c = loadConfig()
  console.log(c.apiKey ? `  ✓ Authenticated: ${c.apiKey.slice(0, 15)}...${c.apiKey.slice(-4)}` : '  ✗ Not authenticated. Run: tcloud auth signup')
  const w = loadWallets()
  if (w.length) console.log(`  Shielded wallets: ${w.length}`)
})

auth.command('whoami').description('Show logged-in account details').action(async () => {
  const c = loadConfig()
  if (!c.apiKey) { console.log('  ✗ Not authenticated. Run: tcloud auth signup'); return }
  try {
    const res = await fetch(`${c.apiUrl}/api/auth/userinfo`, {
      headers: { Authorization: `Bearer ${c.apiKey}` },
    })
    if (!res.ok) {
      console.log(`  ✗ Auth check failed (${res.status}). Your key may be revoked — run: tcloud auth login`)
      return
    }
    const me = await res.json() as any
    const user = me.user ?? {}
    const sub = me.subscription
    console.log(`  Email:   ${user.email ?? 'n/a'}`)
    console.log(`  User:    ${user.name ?? user.id ?? 'n/a'}`)
    console.log(`  Plan:    ${sub?.plan ?? 'free'}`)
    console.log(`  Balance: $${Number(me.balance ?? 0).toFixed(4)}`)
    console.log(`  Key:     ${c.apiKey.slice(0, 15)}...${c.apiKey.slice(-4)}`)
    console.log(`  API:     ${c.apiUrl}`)
  } catch (e: any) {
    console.log(`  ✗ ${e.message ?? e}`)
  }
})

// Top-level aliases — turso-style ergonomics: `tcloud signup` works as well as `tcloud auth signup`.
program.command('signup').description('Create an account via browser (alias for `auth signup`)').action(() => runDeviceFlow('signup'))
program.command('login').description('Log in via browser (alias for `auth login`)').action(() => runDeviceFlow('login'))
program.command('logout').description('Remove stored credentials (alias for `auth logout`)').action(() => {
  const c = loadConfig(); delete c.apiKey; saveConfig(c)
  console.log(`  ✓ Logged out.`)
})
program.command('whoami').description('Show logged-in account (alias for `auth whoami`)').action(async () => {
  const c = loadConfig()
  if (!c.apiKey) { console.log('  ✗ Not authenticated. Run: tcloud signup'); return }
  try {
    const res = await fetch(`${c.apiUrl}/api/auth/userinfo`, { headers: { Authorization: `Bearer ${c.apiKey}` } })
    if (!res.ok) { console.log(`  ✗ Auth failed (${res.status}). Run: tcloud login`); return }
    const me = await res.json() as any
    const user = me.user ?? {}
    const sub = me.subscription
    console.log(`  ${user.email ?? user.name ?? user.id}  ·  $${Number(me.balance ?? 0).toFixed(4)}  ·  ${sub?.plan ?? 'free'}`)
  } catch (e: any) { console.log(`  ✗ ${e.message ?? e}`) }
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

// ── sandbox ──

const sandbox = program.command('sandbox').description('Sandbox workflows')

sandbox.command('create')
  .description('Create a sandbox')
  .option('--name <name>', 'Sandbox name')
  .option('--image <image>', 'Sandbox image or environment')
  .option('--environment <environment>', 'Sandbox environment')
  .option('--ssh', 'Enable SSH')
  .option('--cpu <cores>', 'CPU cores')
  .option('--memory <mb>', 'Memory in MB')
  .option('--disk <gb>', 'Disk in GB')
  .option('--git-url <url>', 'Git repository URL')
  .option('--git-ref <ref>', 'Git ref')
  .option('--backend <type>', 'Agent backend')
  .option('--tee <type>', 'Require a TEE backend: any, tdx, nitro, sev-snp, phala-dstack, gcp, azure')
  .option('--sealed', 'Require sealed secret support')
  .option('--attestation-nonce <hex|auto>', 'Attach a caller challenge nonce')
  .option('--verify', 'Verify returned attestation evidence (default when --tee is set)')
  .option('--allow-unverified-hardware', 'Allow structural attestation checks before vendor-root verification is available')
  .option('--sandbox-url <url>', 'Sandbox API base URL')
  .option('--json', 'Print JSON')
  .action(async (opts) => {
    try {
      const config = loadConfig()
      const client = new TCloudSandbox({
        apiKey: requireApiKey(config),
        baseUrl: opts.sandboxUrl ?? config.sandboxUrl,
      })
      const result = await client.create({
        name: opts.name,
        image: opts.image,
        environment: opts.environment,
        ssh: Boolean(opts.ssh),
        cpu: optionalNumber(opts.cpu),
        memoryMb: optionalNumber(opts.memory),
        diskGb: optionalNumber(opts.disk),
        gitUrl: opts.gitUrl,
        gitRef: opts.gitRef,
        backend: opts.backend,
        tee: teeType(opts.tee),
        sealed: Boolean(opts.sealed),
        attestationNonce: opts.attestationNonce,
        verify: Boolean(opts.verify || opts.tee),
        attestationPolicy: {
          allowUnverifiedHardware: Boolean(opts.allowUnverifiedHardware),
        },
      })

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      const box = result.sandbox as any
      console.log(`Sandbox created: ${box.id ?? 'unknown'}`)
      if (box.status) console.log(`Status: ${box.status}`)
      if (opts.tee) {
        const status = result.attestationStatus
        console.log(`TEE: ${opts.tee}`)
        console.log(`Attestation: ${status.verified ? 'verified' : status.evidenceReturned ? 'unverified' : 'not returned'}`)
        console.log(`Nonce bound: ${status.nonceBound ? 'yes' : 'no'}`)
        if (result.attestationNonce) console.log(`Attestation nonce: ${result.attestationNonce}`)
      }
    } catch (e: any) {
      console.error('Error:', e.message)
      process.exit(1)
    }
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
    if (data.url) {
      console.log(`Checkout URL: ${data.url}`)
      console.log('Complete payment to add credits.')
    }
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
