import { defineConfig } from 'vitest/config'

// Tests run against a separate database (sutton_test by default), never the one the app uses.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost/sutton_test'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // GROQ_API_KEY is blanked so tests never call the real AI (no cost, no flakiness).
    env: { DATABASE_URL: TEST_DATABASE_URL, GROQ_API_KEY: '' },
    globalSetup: './tests/global-setup.js',
    fileParallelism: false, // API test files share one database
    testTimeout: 20000,
  },
})
