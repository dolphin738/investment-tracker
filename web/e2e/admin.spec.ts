/**
 * e2e/admin.spec.ts — 管理端冒烟（§12 矩阵 · admin 域）
 *
 * 覆盖：
 * 1. 非管理员 → 无权限提示（路由/页面双守卫）
 * 2. 管理员 → 接口 API 来源模块渲染提供方
 * 3. 「接口分类管理」模块 → 分类行渲染 + DynamicIcon（Task #18 改造）
 *    按 c.icon 字符串动态渲染 lucide 图标（svg）
 */

import { test, expect } from '@playwright/test';
import {
  installMockApi,
  seedAuth,
  MOCK_USER,
} from './fixtures/mock-api';

test.describe('管理端', () => {
  test.beforeEach(async ({ page }) => {
    installMockApi(page);
  });

  test('非管理员显示无权限', async ({ page }) => {
    // 普通用户角色（role 默认 user）
    await page.addInitScript(
      ([token, user]) => {
        localStorage.setItem('investment_tracker_token', token);
        localStorage.setItem('investment_tracker_user', JSON.stringify(user));
      },
      [ 'e2e-fake-jwt-token', { ...MOCK_USER, role: 'user' } ] as const,
    );
    await page.goto('/admin');
    await expect(page.getByText('无权限访问该页面')).toBeVisible();
  });

  test('管理员：接口 API 来源渲染提供方', async ({ page }) => {
    seedAuth(page);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: '金融数据接口' })).toBeVisible();
    await expect(page.getByText('腾讯财经').first()).toBeVisible();
  });

  test('管理员：接口分类管理渲染分类 + DynamicIcon 图标（Task #18 验收）', async ({ page }) => {
    seedAuth(page);
    await page.goto('/admin');
    await page.getByRole('button', { name: '接口分类管理' }).click();

    // 分类行（含系统分类种子：证券列表 / 证券行情）——注意说明文案里也含「证券行情」，
    // 必须限定在表格行内断言避免 strict mode 冲突
    const categoryRow = page.locator('tr', { hasText: '证券行情' });
    await expect(categoryRow).toBeVisible();
    await expect(page.locator('tr', { hasText: '证券列表' })).toBeVisible();

    // DynamicIcon：分类行内渲染出 lucide svg 图标（字符串名 → 动态组件）
    await expect(categoryRow.locator('svg').first()).toBeVisible();
  });
});
