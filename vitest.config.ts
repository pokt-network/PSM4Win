import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@core': resolve('src/core') } },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The supplier.sh suites run the real script through bash, several times per test.
    testTimeout: 20_000
  }
})
