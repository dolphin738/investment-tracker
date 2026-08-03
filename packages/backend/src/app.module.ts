/**
 * AppModule — NestJS 根模块（方案B）
 *
 * 导入所有业务模块 + ConfigModule.forRoot + 全局 JWT 守卫。
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { SecurityModule } from './modules/security/security.module';
import { CashFlowModule } from './modules/cashflow/cashflow.module';
import { SecurityTradeModule } from './modules/security-trade/security-trade.module';
import { SecurityPriceModule } from './modules/security-price/security-price.module';
import { CashBalanceModule } from './modules/cash-balance/cash-balance.module';
import { SnapshotModule } from './modules/snapshot/snapshot.module';
import { AccountModule } from './modules/account/account.module';
import { OverviewModule } from './modules/overview/overview.module';
import { QueryModule } from './modules/query/query.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

@Module({
  imports: [
    // 全局配置（环境变量）
    ConfigModule.forRoot({ isGlobal: true }),
    // 全局 Prisma
    PrismaModule,
    // 认证模块
    AuthModule,
    // 业务 CRUD 模块
    PortfolioModule,
    SecurityModule,
    CashFlowModule,
    SecurityTradeModule,
    SecurityPriceModule,
    CashBalanceModule,
    SnapshotModule,
    // 只读聚合 / 账户统计模块
    AccountModule,
    OverviewModule,
    QueryModule,
  ],
  controllers: [],
  providers: [
    // 🔴 全局 JWT 守卫：所有路由默认需认证，@Public() 可跳过
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
