import { defineConfig } from '@playwright/test'

const requestedBaseURL = process.env.BASE_URL ?? 'http://127.0.0.1:41741'
const requestedURL = new URL(requestedBaseURL)
const baseURL = requestedURL.pathname === '/'
  ? `${requestedURL.origin}/user/local/kubecode`
  : requestedURL.href.replace(/\/$/, '')
const port = requestedURL.port || '41741'

export default defineConfig({
  grep: /@smoke/,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  retries: 1,
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL,
    headless: true,
  },
  webServer: {
    command: `node scripts/playwright-kubecode-server.mjs ${port}`,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER
      ? process.env.PLAYWRIGHT_REUSE_SERVER === '1'
      : process.env.CI !== 'true',
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 120_000,
    url: `${requestedURL.origin}/healthz`,
  },
  workers: 1,
})
