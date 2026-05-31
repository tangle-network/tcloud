import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

async function cliHelp(command: string): Promise<string> {
  const { stdout } = await execFileAsync('pnpm', ['exec', 'tsx', 'src/cli.ts', command, '--help'], {
    cwd: resolve('.'),
    timeout: 20_000,
  })
  return stdout
}

describe('tcloud CLI version', () => {
  it('uses package metadata instead of a hardcoded version', async () => {
    const source = await readFile(resolve('src/cli.ts'), 'utf-8')

    expect(source).toContain('.version(packageVersion())')
    expect(source).not.toContain(".version('0.1.0')")
  })

  it.each([
    ['image-generate', ['--prompt <prompt>', '--response-format <format>']],
    ['search', ['--provider <provider>', '--max-results <n>', '--include-domain <domain...>']],
    ['video-generate', ['--provider <provider>', '--aspect-ratio <ratio>', '--callback-url <url>']],
    ['speech', ['--input <text>', '--output <file>']],
    ['transcribe', ['--language <language>', '--prompt <prompt>']],
    ['avatar-generate', ['--audio-url <url>', '--output-format <format>']],
  ])('parses %s help with expected options', async (command, expectedOptions) => {
    const help = await cliHelp(command)

    expect(help).toContain(`Usage: tcloud ${command}`)
    for (const option of expectedOptions) {
      expect(help).toContain(option)
    }
  })

  it('prefers TANGLE_API_KEY over legacy TCLOUD_API_KEY', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tcloud-cli-env-'))
    try {
      const { stdout } = await execFileAsync('pnpm', ['exec', 'tsx', 'src/cli.ts', 'auth', 'status'], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: home,
          TANGLE_API_KEY: 'sk-tan-canonical-primary-1234',
          TCLOUD_API_KEY: 'sk-tan-legacy-secondary-9999',
        },
        timeout: 20_000,
      })

      expect(stdout).toContain('Authenticated: sk-tan-canonica...1234')
      expect(stdout).not.toContain('legacy')
      expect(stdout).not.toContain('9999')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
