import { defineConfig, devices } from '@playwright/test';

// Runs against the Vite dev server, whose mock API serves testdata/shop.
// CODEMAP_E2E_PORT picks another port (say, when two checkouts run e2e at once).
const port = Number(process.env.CODEMAP_E2E_PORT) || 7782;
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 15_000,
  expect: { timeout: 3_000 },
  use: { baseURL: `http://localhost:${port}`, viewport: { width: 1500, height: 950 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 950 } } }],
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}/api/state`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
