import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The protocol tests start the bundled dist/cli.js over stdio: bundle it first.
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
