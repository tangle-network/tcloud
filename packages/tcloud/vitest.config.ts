import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@tangle-network/tcloud-attestation': new URL('../tcloud-attestation/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
