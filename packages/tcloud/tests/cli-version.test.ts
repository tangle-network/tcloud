import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
})
