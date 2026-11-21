import { defineConfig } from 'vitest/config'
import { offlineQpdf } from './build/qpdf-engine.mjs'

export default defineConfig({
  plugins: [offlineQpdf()],
  test: { environment: 'node', include: ['src/**/*.test.ts', 'electron/**/*.test.ts'] },
})
