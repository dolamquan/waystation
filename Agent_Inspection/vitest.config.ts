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
      // Entry points: covered end to end by spawning them, which v8 coverage cannot see.
      exclude: ['daemon/index.ts', 'daemon/cli/attach.ts', 'daemon/**/*.d.mts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
