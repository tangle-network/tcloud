import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('tcloud CLI version', () => {
  it('uses package metadata instead of a hardcoded version', async () => {
    const source = await readFile(resolve('src/cli.ts'), 'utf-8')

    expect(source).toContain('.version(packageVersion())')
    expect(source).not.toContain(".version('0.1.0')")
  })
})
