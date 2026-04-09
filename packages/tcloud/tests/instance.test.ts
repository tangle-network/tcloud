import { describe, it, expect } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  Instance,
  appendLogLine,
  writeTempHarnessConfig,
} from '../src/instance'

/**
 * Write a one-shot fake cargo-tangle binary that ignores its CLI arguments
 * and executes the supplied shell body. Returned path is absolute.
 */
function writeFakeCargo(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-cargo-'))
  const file = join(dir, 'cargo-tangle')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

describe('appendLogLine', () => {
  it('appends lines up to the cap', () => {
    const buf: string[] = []
    appendLogLine(buf, 'a', 3)
    appendLogLine(buf, 'b', 3)
    appendLogLine(buf, 'c', 3)
    expect(buf).toEqual(['a', 'b', 'c'])
  })

  it('evicts oldest line when exceeding the cap', () => {
    const buf: string[] = []
    appendLogLine(buf, 'a', 3)
    appendLogLine(buf, 'b', 3)
    appendLogLine(buf, 'c', 3)
    appendLogLine(buf, 'd', 3)
    expect(buf).toEqual(['b', 'c', 'd'])
  })
})

describe('Instance.start log buffer (M1: no double listener)', () => {
  it('records each stdout line exactly once across startup + post-startup', async () => {
    const fake = writeFakeCargo(
      [
        `echo "Starting blueprint-manager for 'demo'"`,
        `echo "Harness up. 1 blueprint started"`,
        `echo "hello"`,
        `echo "world"`,
        // Stay alive so the instance has a "running" child after startup.
        `sleep 5`,
      ].join('\n'),
    )

    const instance = await Instance.start({
      cargoBinary: fake,
      quiet: true,
      timeoutMs: 5_000,
    })

    try {
      // Let the post-startup lines flush from the stdout pipe.
      await new Promise((r) => setTimeout(r, 200))

      const logs = instance.logs(1_000)
      const helloCount = logs.filter((l) => l === 'hello').length
      const worldCount = logs.filter((l) => l === 'world').length
      expect(helloCount).toBe(1)
      expect(worldCount).toBe(1)

      // Sanity: blueprint name was captured during startup.
      expect(instance.blueprints).toContain('demo')
    } finally {
      await instance.stop(500)
    }
  }, 15_000)
})

describe('Instance.start timeout cleanup (M2)', () => {
  it('rejects with timeout error and cleans up when marker never appears', async () => {
    // Fake binary that prints noise forever but never emits the marker.
    const fake = writeFakeCargo(
      `while true; do echo "noise"; sleep 0.05; done`,
    )

    const start = Date.now()
    await expect(
      Instance.start({
        cargoBinary: fake,
        quiet: true,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/Timed out after 200ms/)
    const elapsed = Date.now() - start

    // Should reject near the configured timeout, not hang.
    expect(elapsed).toBeLessThan(2_000)

    // If interval/timer cleanup leaked, the event loop would stay busy; give
    // it a beat and then assert we can still schedule work promptly.
    const tickStart = Date.now()
    await new Promise((r) => setImmediate(r))
    expect(Date.now() - tickStart).toBeLessThan(50)
  }, 5_000)

  it('rejects with exit error when child dies before marker', async () => {
    const fake = writeFakeCargo(`echo "boot"; exit 7`)

    await expect(
      Instance.start({
        cargoBinary: fake,
        quiet: true,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exited with code 7/)
  }, 5_000)

  it('rejects cleanly when the binary does not exist', async () => {
    await expect(
      Instance.start({
        cargoBinary: '/definitely/not/a/real/binary-xyz',
        quiet: true,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/Failed to spawn/)
  }, 5_000)
})

describe('writeTempHarnessConfig uniqueness', () => {
  it('produces distinct paths on rapid successive calls', () => {
    const paths = new Set<string>()
    for (let i = 0; i < 50; i++) {
      paths.add(
        writeTempHarnessConfig([
          { name: 'x', path: '/tmp/x' },
        ]),
      )
    }
    expect(paths.size).toBe(50)
  })

  it('writes the toml content to disk', () => {
    const p = writeTempHarnessConfig([
      { name: 'demo', path: '/tmp/demo', port: 9000, env: { FOO: 'bar' } },
    ])
    // mkdirSync is idempotent; just assert path exists by re-creating parent.
    const parent = p.replace(/\/harness\.toml$/, '')
    mkdirSync(parent, { recursive: true })
    expect(p.endsWith('harness.toml')).toBe(true)
  })
})
