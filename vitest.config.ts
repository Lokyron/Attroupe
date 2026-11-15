import { defineConfig } from 'vitest/config';

// Les tests vivent tous dans app/tests/ (voir §2 et §8 de l'architecture).
export default defineConfig({
  test: {
    include: ['app/tests/**/*.test.ts'],
    environment: 'node',
  },
});
