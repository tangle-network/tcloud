import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cli.ts',
    'src/mcp.ts',
    'src/shielded.ts',
    'src/instance.ts',
    'src/attestation.ts',
    'src/sandbox.ts',
  ],
  format: ['esm', 'cjs'],
  platform: 'node',
  dts: true,
  clean: true,
  fixedExtension: false,
})
