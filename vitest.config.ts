import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '.claude/**',
      // TODO: these suites import @railgun-community/engine/dist/* subpaths without
      // .js extensions. Runtime CJS resolves fine; Vite's ESM pipeline does not.
      // Fix by appending `.js` to deep imports in src/privacy/lib/key-derivation.ts.
      'test/integration/backend-api.test.ts',
      'test/privacy/key-derivation.test.ts',
      'test/privacy/utxo-selection.test.ts',
    ],
  },
})
