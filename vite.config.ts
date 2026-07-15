/// <reference types="vitest/config" />
import path from 'node:path'

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const vitestCoverageDirectory = process.env.VITEST_COVERAGE_DIR ?? 'coverage'
const apiTarget = process.env.KUBECODE_DEV_SERVER ?? 'http://127.0.0.1:8888'

export default defineConfig({
  base: './',
  cacheDir: process.env.KUBECODE_VITE_CACHE_DIR,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    allowedHosts: true,
    port: 5202,
    proxy: {
      '/api': {
        target: apiTarget,
        ws: true,
      },
    },
    strictPort: true,
  },
  build: {
    target: 'es2022',
  },
  test: {
    coverage: {
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/test/**',
        'src/kubecode/api.ts',
        'src/kubecode/CodeEditor.tsx',
        'src/kubecode/ContextWorkbench.tsx',
        'src/kubecode/TerminalView.tsx',
        'src/kubecode/TerminalWorkspace.tsx',
        'src/mock-tauri.ts',
        'src/main.tsx',
        'src/types.ts',
        'src/hooks/useMcpBridge.ts',
        'src/hooks/useAiAgent.ts',
        'src/utils/ai-chat.ts',
        'src/utils/ai-agent.ts',
        'src/components/ui/dropdown-menu.tsx',
        'src/components/ui/scroll-area.tsx',
        'src/components/ui/select.tsx',
        'src/components/ui/separator.tsx',
        'src/components/ui/tabs.tsx',
        'src/components/ui/tooltip.tsx',
        'src/components/ui/card.tsx',
      ],
      include: ['src/kubecode/**/*.{ts,tsx}'],
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: vitestCoverageDirectory,
      thresholds: {
        branches: 70,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
    environment: 'jsdom',
    globals: true,
    include: ['src/kubecode/**/*.{test,spec}.{ts,tsx}'],
    maxWorkers: process.env.VITEST_MAX_WORKERS ?? 4,
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 10_000,
  },
})
