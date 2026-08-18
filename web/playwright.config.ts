import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E 冒烟/验收配置（Task #17 · 按 §12 功能矩阵验收）。
 *
 * 形态：纯前端验收 —— 用 page.route 拦截全部 `/api/**` 返回 fixture JSON
 * （见 e2e/fixtures/mock-api.ts），不依赖真实后端/数据库：
 * - 沙箱无 Postgres、双栈共用同一后端，前端行为等价性才是迁移验收目标；
 * - 零数据污染、完全确定性，CI 可直接跑。
 *
 * webServer：web（Vue3）的 vite dev（:5174）。API 请求被 route 拦截，
 * 不会打到 vite proxy / :3000。
 */
export default defineConfig({
  testDir: './e2e',
  // 全部用例共享同一套 route mock 数据，串行避免并发干扰
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
