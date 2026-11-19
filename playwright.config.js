import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT || "4173";
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.js",
  timeout: 30000,
  workers: 1,
  webServer: { command: `PORT=${port} node tools/serve.mjs`, url: origin + "/standalone/", reuseExistingServer: false },
  use: { baseURL: origin, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "firefox", use: devices["Desktop Firefox"], testMatch: "**/{standalone,assist-panel}.spec.js" },
    { name: "webkit", use: devices["Desktop Safari"], testMatch: "**/{standalone,assist-panel}.spec.js" },
  ],
});
