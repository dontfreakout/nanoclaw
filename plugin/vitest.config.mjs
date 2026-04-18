import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['plugin/**/*.test.mjs', 'plugin/**/*.test.ts'],
    environment: 'node',
  },
});
