import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['daemon/**/*.{ts,mjs}'],
      exclude: ['daemon/index.ts', 'daemon/**/*.d.mts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
