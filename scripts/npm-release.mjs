// One immutable-byte check for both package workflows and both runner phases.
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const { TARBALL_PATH: tarball, EXPECTED_NAME: name, EXPECTED_VERSION: version,
  EXPECTED_SHA1: expected, ALLOW_PUBLISH: allowPublish, GITHUB_OUTPUT: output } = process.env
if (!tarball || !name || !version || !expected) throw new Error('Missing qualified artifact metadata')
const actual = createHash('sha1').update(readFileSync(tarball)).digest('hex')
if (actual !== expected) throw new Error(`Qualified tarball changed: ${actual} != ${expected}`)
const manifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
if (manifest.name !== name || manifest.version !== version) throw new Error('Qualified package identity changed')
const registry = 'https://registry.npmjs.org'
const url = `${registry}/${encodeURIComponent(name).replace('%40', '@')}/${encodeURIComponent(version)}`

async function registrySha1() {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`npm returned HTTP ${response.status}`)
  const published = await response.json()
  const sha1 = published.dist?.shasum
  if (published.name !== name || published.version !== version || !/^[a-f0-9]{40}$/.test(sha1)) {
    throw new Error('npm returned incomplete or inconsistent immutable version metadata')
  }
  return sha1
}

const existing = await registrySha1()
if (existing && existing !== expected) throw new Error(`${name}@${version} exists with different release bytes`)
if (output) appendFileSync(output, `needed=${existing === null}\n`)
if (existing) {
  console.log(`${name}@${version} already exists with the exact qualified bytes`)
} else if (allowPublish !== 'true') {
  console.log(`${name}@${version} requires trusted publication`)
} else {
  execFileSync('npm', ['publish', tarball, '--access', 'public', '--tag', 'latest', '--provenance', '--registry', registry],
    { stdio: 'inherit' })
  let verified = false
  for (let attempt = 0; attempt < 31; attempt++) {
    const published = await registrySha1()
    if (published === expected) {
      verified = true
      break
    }
    if (published) throw new Error(`${name}@${version} published different bytes`)
    if (attempt < 30) await sleep(10000)
  }
  if (!verified) throw new Error(`${name}@${version} not visible with qualified bytes after five minutes`)
  console.log(`Published and verified ${name}@${version} sha1=${expected}`)
}
