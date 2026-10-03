import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/core/test/**/*.test.ts'],
          exclude: ['packages/core/test/**/*.int.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/core/test/**/*.int.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
