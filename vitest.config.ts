import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests share a single in-memory MongoDB and global Mongoose
    // models. Run files serially so afterEach collection-clears in one file
    // never race a test in another file sharing the same connection.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/scripts/**'],
    },
  },
  resolve: {
    alias: {
      // Mirror the NodeNext `#/` subpath import map (package.json#imports +
      // tsconfig#paths) so test files and production code resolve identically.
      // Vite rewrites the trailing `.js` specifier to the real `.ts` source.
      '#/': resolve(__dirname, './src/'),
    },
  },
})
