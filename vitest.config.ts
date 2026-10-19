import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['reference/**', 'node_modules/**', 'dist/**'],
    setupFiles: ['tests/helpers/isolate-home.ts'],
    // 全量并行时 sharp 与浏览器测试抢 CPU，默认 5s 超时会误报
    testTimeout: 20_000,
  },
})
