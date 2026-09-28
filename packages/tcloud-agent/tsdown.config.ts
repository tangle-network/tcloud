import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/pi-extension.ts'],
  format: ['esm'],
  platform: 'node',
  dts: true,
  clean: true,
  fixedExtension: false,
})
