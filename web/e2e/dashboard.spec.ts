/**
 * e2e/dashboard.spec.ts — 概览首页冒烟（§12 矩阵 · overview 域）
 *
 * 覆盖：登录态下首页渲染组合名称 + 总资产卡片（overview + summary 双查询驱动）。
 */

import { test, expect } from '@playwright/test';
import { installMockApi, seedAuth } from './fixtures/mock-api';

test.describe('概览首页', () => {
  test.beforeEach(async ({ page }) => {
    installMockApi(page);
    seedAuth(page);
  });

  test('登录态下渲染组合名与总资产', async ({ page }) => {
    await page.goto('/');
    // 组合选择器/标题
    await expect(page.getByText('主组合').first()).toBeVisible();
    // 当前总资产（overview.totalAsset = 128000.00 → ¥128,000.00）
    await expect(page.getByText('¥128,000.00').first()).toBeVisible();
    // 净投入（netInvested = 100000.00）
    await expect(page.getByText('¥100,000.00').first()).toBeVisible();
  });
});
