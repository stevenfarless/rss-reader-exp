import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:4173", headless: true, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
  reporter: "list",
  webServer: {
    command: "node tests/serve.js",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 10000
  }
});
