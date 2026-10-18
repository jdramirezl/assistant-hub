import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: process.env.LIVE ? [] : ['tests/live/**'],
    env: { NODE_ENV: 'test', MASTRA_TELEMETRY_DISABLED: '1' },
    testTimeout: 20_000,
  },
});
