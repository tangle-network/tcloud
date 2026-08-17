import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { exactFirstPartyPins, isExactPin } from './check-cohort-ranges.mjs'

const CLOSED = [
  '1.2.3',
  'v1.2.3',
  '=1.2.3',
  '= 1.2.3',
  '  1.2.3  ',
  '1.2.3-rc.1',
  '1.2.3+build.5',
  '1.2.3 || 1.2.4',
  'workspace:*',
  'workspace:',
  'workspace:1.2.3',
]

const OPEN = [
  '^1.0.0',
  '~1.2.0',
  '>=0.147.0 <0.148.0',
  '>1.2.3',
  '1.0.x',
  '1.x',
  '*',
  'latest',
  'workspace:^',
  'workspace:~',
  'npm:@tangle-network/other@^1.0.0',
  '1.2.3 || ^2.0.0',
]

test('isExactPin refuses every spelling of a closed version set', () => {
  for (const spec of CLOSED) assert.equal(isExactPin(spec), true, spec)
})

test('isExactPin accepts a spec that admits more than a closed set', () => {
  for (const spec of OPEN) assert.equal(isExactPin(spec), false, spec)
})

test('isExactPin accepts a non-string spec', () => {
  assert.equal(isExactPin(undefined), false)
  assert.equal(isExactPin({ version: '1.2.3' }), false)
})

test('exactFirstPartyPins reports one line per offending section and name', () => {
  assert.deepEqual(
    exactFirstPartyPins({
      dependencies: { '@tangle-network/sandbox': '0.27.1' },
      optionalDependencies: { '@tangle-network/agent-interface': '^1.0.0' },
      peerDependencies: { '@tangle-network/tcloud': 'workspace:*' },
    }),
    [
      'dependencies.@tangle-network/sandbox = 0.27.1',
      'peerDependencies.@tangle-network/tcloud = workspace:*',
    ],
  )
})

test('exactFirstPartyPins ignores third-party exact pins', () => {
  assert.deepEqual(exactFirstPartyPins({ dependencies: { viem: '2.48.4' } }), [])
})

test('exactFirstPartyPins reports nothing for a manifest with no checked sections', () => {
  assert.deepEqual(exactFirstPartyPins({}), [])
})

test('every publishable workspace manifest passes the gate', () => {
  const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages')
  let checked = 0
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8'),
    )
    if (manifest.private === true) continue
    assert.deepEqual(exactFirstPartyPins(manifest), [], manifest.name)
    checked += 1
  }
  assert.ok(checked > 0, 'found no publishable workspace manifest to check')
})

test('every publishable workspace manifest runs the gate before it publishes', () => {
  const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages')
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8'),
    )
    if (manifest.private === true) continue
    assert.match(
      manifest.scripts?.prepublishOnly ?? '',
      /check-cohort-ranges\.mjs/,
      `${manifest.name} publishes without running the cohort-range gate`,
    )
  }
})
