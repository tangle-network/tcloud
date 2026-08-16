#!/usr/bin/env node
/**
 * Fail a workspace manifest that would publish an exact first-party version pin.
 *
 * An exact pin names one version and refuses every other, so a consumer that
 * already holds a later `@tangle-network/*` package installs a SECOND physical
 * copy of the pinned one. Two copies of `@tangle-network/agent-interface` in a
 * tree means two class identities and `instanceof` answering false across them.
 *
 * The range shape follows the depended-on package's own versioning: a caret
 * from 1.0.0, where a minor is additive; the narrower `>=X.Y.Z <X.Y+1.0` window
 * below 1.0, where a minor may remove.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(repoRoot, 'packages')
const exactVersion = /^\d+\.\d+\.\d+(?:[-+].*)?$/
const failures = []

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const manifestPath = join(packagesDir, entry.name, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    continue
  }
  if (manifest.private === true) continue
  const offenders = []
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith('@tangle-network/')) continue
      if (typeof spec === 'string' && exactVersion.test(spec)) {
        offenders.push(`${section}.${name} = ${spec}`)
      }
    }
  }
  if (offenders.length > 0) {
    failures.push(
      `${manifest.name} publishes exact first-party version pins, which duplicate the package for every consumer already holding a later one:\n${offenders
        .map((line) => `  ${line}`)
        .join('\n')}`,
    )
    continue
  }
  process.stdout.write(`${manifest.name}@${manifest.version} declares first-party ranges only\n`)
}

if (failures.length > 0) {
  process.stderr.write(
    `${failures.join('\n\n')}\nDeclare a range instead: a caret from 1.0.0, or ">=X.Y.Z <X.Y+1.0" below it.\n`,
  )
  process.exit(1)
}
