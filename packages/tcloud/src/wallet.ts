/**
 * Wallet management — BIP-39 mnemonics, BIP-44 HD derivation, encrypted storage.
 *
 * Standards used:
 * - BIP-39: mnemonic generation + seed derivation (@scure/bip39)
 * - BIP-32: HD key derivation (@scure/bip32)
 * - BIP-44: derivation path m/44'/60'/0'/0/N (Ethereum standard)
 * - AES-256-GCM: key encryption at rest (Node.js crypto)
 * - PBKDF2-SHA256: passphrase → encryption key (210K iterations, OWASP 2023 recommendation)
 * - viem: address derivation + EIP-712 signing
 *
 * Two wallet types:
 * - Funding wallet: user's real wallet for depositing into shielded pool.
 *   Created from BIP-39 mnemonic. Used once for deposit, then never again.
 * - Spending wallet: ephemeral secp256k1 keypair for SpendAuth signatures.
 *   NOT derived from mnemonic — fully random for unlinkability.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
// @ts-ignore — subpath export works at runtime, TS can't resolve it with bundler moduleResolution
import { wordlist } from '@scure/bip39/wordlists/english'
import { HDKey } from '@scure/bip32'
import { privateKeyToAccount } from 'viem/accounts'
import { keccak256, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem'

const CONFIG_DIR = path.join(process.env.HOME || '~', '.tcloud')
const WALLETS_FILE = path.join(CONFIG_DIR, 'wallets.json')
const FUNDING_FILE = path.join(CONFIG_DIR, 'funding.enc')

// BIP-44 path for Ethereum: m/44'/60'/0'/0/{index}
const ETH_DERIVATION_BASE = "m/44'/60'/0'/0"

// OWASP 2023: minimum 210,000 iterations for PBKDF2-SHA256
const PBKDF2_ITERATIONS = 210_000

export interface SpendingWallet {
  privateKey: Hex
  address: string
  commitment: Hex
  salt: Hex
  label?: string
  createdAt: string
}

export interface FundingWallet {
  address: string
  mnemonic?: string // only available immediately after creation
}

// ── Encryption (AES-256-GCM + PBKDF2) ──────────────────────

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, 'sha256')
}

export function encrypt(data: string, passphrase: string): string {
  const salt = crypto.randomBytes(16)
  const key = deriveKey(passphrase, salt)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return JSON.stringify({
    v: 1, // version for future migration
    kdf: 'pbkdf2-sha256',
    kdfIterations: PBKDF2_ITERATIONS,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  })
}

export function decrypt(encryptedJson: string, passphrase: string): string {
  const parsed = JSON.parse(encryptedJson)
  const iterations = parsed.kdfIterations || PBKDF2_ITERATIONS
  const key = deriveKey(passphrase, Buffer.from(parsed.salt, 'hex'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'))
  return decipher.update(parsed.data, 'hex', 'utf-8') + decipher.final('utf-8')
}

// ── Spending Wallet (ephemeral, random) ─────────────────────

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
}

/**
 * Generate an ephemeral spending wallet.
 * NOT derived from a mnemonic — fully random for unlinkability.
 * The commitment is keccak256(abi.encode(address, salt)) matching the ShieldedCredits contract.
 */
export function generateSpendingWallet(label?: string): SpendingWallet {
  const privateKey = ('0x' + crypto.randomBytes(32).toString('hex')) as Hex
  const salt = ('0x' + crypto.randomBytes(32).toString('hex')) as Hex
  const account = privateKeyToAccount(privateKey)

  // Commitment matches ShieldedCredits.sol: keccak256(abi.encode(spendingKey, salt))
  const commitment = keccak256(
    encodeAbiParameters(parseAbiParameters('address, bytes32'), [account.address, salt])
  )

  return {
    privateKey,
    address: account.address,
    commitment,
    salt,
    label,
    createdAt: new Date().toISOString(),
  }
}

export function loadSpendingWallets(): SpendingWallet[] {
  ensureDir()
  try { return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8')) }
  catch { return [] }
}

export function saveSpendingWallets(wallets: SpendingWallet[]) {
  ensureDir()
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2), { mode: 0o600 })
}

// ── Funding Wallet (BIP-39 mnemonic, BIP-44 derivation) ────

/**
 * Generate a new BIP-39 mnemonic (128 bits = 12 words).
 */
export function createMnemonic(): string {
  return generateMnemonic(wordlist, 128)
}

/**
 * Validate a BIP-39 mnemonic.
 */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist)
}

/**
 * Derive an Ethereum address from a mnemonic using BIP-44.
 * Path: m/44'/60'/0'/0/{index}
 */
export function deriveFromMnemonic(mnemonic: string, index: number = 0): { privateKey: Hex; address: string } {
  const seed = mnemonicToSeedSync(mnemonic)
  const hdKey = HDKey.fromMasterSeed(seed)
  const child = hdKey.derive(`${ETH_DERIVATION_BASE}/${index}`)

  if (!child.privateKey) throw new Error('Failed to derive private key')

  const privateKey = ('0x' + Buffer.from(child.privateKey).toString('hex')) as Hex
  const account = privateKeyToAccount(privateKey)

  return { privateKey, address: account.address }
}

/**
 * Create a new funding wallet with a fresh BIP-39 mnemonic.
 * The mnemonic is returned for the user to write down.
 * After this, call saveFundingWallet to encrypt and persist.
 */
export function createFundingWallet(): { wallet: FundingWallet; mnemonic: string; privateKey: Hex } {
  const mnemonic = createMnemonic()
  const { privateKey, address } = deriveFromMnemonic(mnemonic, 0)
  return { wallet: { address }, mnemonic, privateKey }
}

/**
 * Import a funding wallet from an existing mnemonic or private key.
 */
export function importFundingWallet(input: string): { wallet: FundingWallet; privateKey: Hex } {
  // Check if it's a mnemonic or a private key
  if (input.startsWith('0x') && input.length === 66) {
    // Raw private key
    const account = privateKeyToAccount(input as Hex)
    return { wallet: { address: account.address }, privateKey: input as Hex }
  }

  // Mnemonic
  if (!isValidMnemonic(input)) {
    throw new Error('Invalid mnemonic. Must be 12 or 24 BIP-39 words.')
  }

  const { privateKey, address } = deriveFromMnemonic(input, 0)
  return { wallet: { address, mnemonic: input }, privateKey }
}

/**
 * Save funding wallet encrypted with a passphrase.
 */
export function saveFundingWallet(privateKey: Hex, passphrase: string, mnemonic?: string) {
  ensureDir()
  const data = JSON.stringify({ privateKey, mnemonic: mnemonic || null })
  const encrypted = encrypt(data, passphrase)
  fs.writeFileSync(FUNDING_FILE, encrypted, { mode: 0o600 })
}

/**
 * Load and decrypt funding wallet.
 */
export function loadFundingWallet(passphrase: string): { privateKey: Hex; address: string; mnemonic?: string } | null {
  try {
    const encrypted = fs.readFileSync(FUNDING_FILE, 'utf-8')
    const data = JSON.parse(decrypt(encrypted, passphrase))
    const account = privateKeyToAccount(data.privateKey as Hex)
    return { privateKey: data.privateKey, address: account.address, mnemonic: data.mnemonic || undefined }
  } catch {
    return null
  }
}

export function hasFundingWallet(): boolean {
  return fs.existsSync(FUNDING_FILE)
}
