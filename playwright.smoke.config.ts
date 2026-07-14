import { defineConfig } from '@playwright/test'

const requestedBaseURL = process.env.BASE_URL || 'http://127.0.0.1:41741'
const requestedURL = new URL(requestedBaseURL)
const baseURL = requestedURL.pathname === '/'
  ? `${requestedURL.origin}/user/local/kubecode`
  : requestedURL.href.replace(/\/$/, '')
const port = requestedURL.port || '41741'
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER
  ? process.env.PLAYWRIGHT_REUSE_SERVER === '1'
  : process.env.CI !== 'true'
const claudeCodeOnboardingStorageState = {
  cookies: [],
  origins: [
    {
      origin: baseURL,
      localStorage: [
        { name: 'tolaria:claude-code-onboarding-dismissed', value: '1' },
      ],
    },
  ],
}

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  workers: 1,
  grep: /@smoke/,
  use: {
    baseURL,
    headless: true,
    storageState: claudeCodeOnboardingStorageState,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node scripts/playwright-kubecode-server.mjs ${port}`,
    url: `${requestedURL.origin}/healthz`,
    reuseExistingServer,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
