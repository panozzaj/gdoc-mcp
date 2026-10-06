import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // dist/ holds compiled copies of the tests; don't run them twice
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
})
