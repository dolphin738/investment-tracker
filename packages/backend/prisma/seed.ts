/**
 * Prisma 种子数据
 *
 * 生成测试数据：1 个用户 + 1 个组合 + 出入金 + 快照
 * 运行：pnpm --filter backend prisma db seed
 *
 * 对齐方案B Schema：使用 CashFlow 代替旧 Transaction 表。
 */

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('🌱 开始生成种子数据...');

  // ===== 1. 创建测试用户 =====
  const passwordHash = await bcrypt.hash('password123', 10);
  const user = await prisma.user.upsert({
    where: { email: 'demo@investment-tracker.local' },
    update: {},
    create: {
      email: 'demo@investment-tracker.local',
      passwordHash,
      name: '演示用户',
    },
  });
  console.log(`  ✅ 用户已创建: ${user.email} (${user.id})`);

  // ===== 2. 创建投资组合 =====
  const portfolio = await prisma.portfolio.upsert({
    where: { id: 'demo-portfolio-001' },
    update: {},
    create: {
      id: 'demo-portfolio-001',
      userId: user.id,
      name: '沪深300定投组合',
      description: '每月定投沪深300指数基金的长期投资组合',
      currency: 'CNY',
      baseDate: new Date('2024-01-15'),
    },
  });
  console.log(`  ✅ 组合已创建: ${portfolio.name} (${portfolio.id})`);

  // ===== 3. 创建出入金记录（CashFlow） =====
  const cashflows = [
    { date: '2024-01-15', type: 'BUY' as const, amount: 10000, note: '首次入金建仓' },
    { date: '2024-02-15', type: 'BUY' as const, amount: 5000, note: '月度定投' },
    { date: '2024-03-15', type: 'BUY' as const, amount: 5000, note: '月度定投' },
    { date: '2024-04-20', type: 'SELL' as const, amount: 3000, note: '部分出金' },
    { date: '2024-06-15', type: 'BUY' as const, amount: 8000, note: '低位加仓' },
    { date: '2024-09-15', type: 'BUY' as const, amount: 5000, note: '月度定投' },
  ];

  for (const cf of cashflows) {
    await prisma.cashFlow.upsert({
      where: {
        id: `demo-cf-${cf.date}`,
      },
      update: {},
      create: {
        id: `demo-cf-${cf.date}`,
        portfolioId: portfolio.id,
        date: new Date(cf.date),
        type: cf.type,
        amount: cf.amount,
        note: cf.note,
      },
    });
  }
  console.log(`  ✅ 出入金记录已创建: ${cashflows.length} 条`);

  // ===== 4. 创建资产快照 =====
  const snapshots = [
    { date: '2024-01-15', totalAsset: 10000, note: '建仓日快照' },
    { date: '2024-02-15', totalAsset: 15500, note: '定投后市值' },
    { date: '2024-03-15', totalAsset: 20800, note: '定投后市值' },
    { date: '2024-04-20', totalAsset: 18500, note: '出金后市值' },
    { date: '2024-06-15', totalAsset: 27500, note: '加仓后市值' },
    { date: '2024-09-15', totalAsset: 32000, note: '定投后市值' },
    { date: '2024-12-31', totalAsset: 35000, note: '年末快照' },
    { date: '2025-03-15', totalAsset: 36500, note: '季度快照' },
    { date: '2025-06-15', totalAsset: 38200, note: '半年快照' },
  ];

  for (const snap of snapshots) {
    await prisma.assetSnapshot.upsert({
      where: {
        portfolioId_date: {
          portfolioId: portfolio.id,
          date: new Date(snap.date),
        },
      },
      update: {},
      create: {
        portfolioId: portfolio.id,
        date: new Date(snap.date),
        totalAsset: snap.totalAsset,
        source: 'MANUAL',
        valuationFlag: 'MANUAL_INPUT',
        note: snap.note,
      },
    });
  }
  console.log(`  ✅ 资产快照已创建: ${snapshots.length} 条`);

  console.log('🌱 种子数据生成完成！');
  console.log('   登录账号: demo@investment-tracker.local');
  console.log('   登录密码: password123');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error('❌ 种子数据生成失败:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
