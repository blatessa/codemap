import { defineConfig, devices } from '@playwright/test';

// Runs against the Vite dev server, whose mock API serves testdata/shop.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:7782', viewport: { width: 1500, height: 950 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 950 } } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:7782/api/state',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
