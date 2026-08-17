/**
 * e2e/auth.spec.ts — 认证冒烟（§12 矩阵 · auth 域）
 *
 * 覆盖：登录页渲染 → 校验拦截（邮箱/密码）→ 登录成功跳转首页。
 */

import { test, expect } from '@playwright/test';
import { installMockApi } from './fixtures/mock-api';

test.describe('认证', () => {
  test.beforeEach(async ({ page }) => {
    installMockApi(page);
  });

  test('登录页渲染：邮箱 + 密码 + 提交按钮', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /登录/ })).toBeVisible();
  });

  test('空提交被校验拦截（邮箱/密码错误提示）', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /登录/ }).click();
    await expect(page.getByText('请输入有效的邮箱')).toBeVisible();
    await expect(page.getByText('密码至少 6 位')).toBeVisible();
  });

  test('登录成功 → 跳转首页并展示组合数据', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('you@example.com').fill('user@example.com');
    await page.locator('input[type="password"]').fill('secret123');
    await page.getByRole('button', { name: /登录/ }).click();

    // 登录成功 → 路由守卫放行 → 首页加载组合摘要（主区域卡片）
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('main').getByText('主组合')).toBeVisible();
  });
});
