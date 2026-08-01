/**
 * 根模块
 *
 * 引入所有业务模块：
 * - PrismaModule（全局数据层，T01）
 * - AuthModule（认证：注册/登录/JWT）
 * - PortfolioModule（组合管理 CRUD + 摘要聚合）
 * - TransactionModule（交易管理 CRUD + 触发重算）
 * - SnapshotModule（资产快照 upsert + 触发计算）
 * - CalculationModule（计算引擎：XIRR + 净值 + 批量重算）
 * - QueryModule（四维度查询聚合）
 * - UploadModule（文件上传：头像）
 * - SecurityModule（标的主数据 CRUD，T02）
 * - HoldingModule（持仓管理 CRUD + 汇总，T02）
 * - DividendModule（分红记录 CRUD，T02）
 * - FeeModule（费用记录 CRUD，T02）
 * - PreferenceModule（用户偏好设置，T02）
 * - OverviewModule（概览数据聚合，T02）
 * - AccountModule（账户统计）
 *
 * 全局注册：
 * - APP_FILTER：HttpExceptionFilter（统一错误响应）
 * - APP_INTERCEPTOR：TransformInterceptor（统一成功响应信封）
 * - APP_GUARD：JwtAuthGuard（全局 JWT 认证，@Public() 跳过）
 */

import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { TransactionModule } from './modules/transaction/transaction.module';
import { SnapshotModule } from './modules/snapshot/snapshot.module';
import { CalculationModule } from './modules/calculation/calculation.module';
import { QueryModule } from './modules/query/query.module';
import { UploadModule } from './modules/upload/upload.module';
import { AccountModule } from './modules/account/account.module';
import { SecurityModule } from './modules/security/security.module';
import { HoldingModule } from './modules/holding/holding.module';
import { DividendModule } from './modules/dividend/dividend.module';
import { FeeModule } from './modules/fee/fee.module';
import { PreferenceModule } from './modules/preference/preference.module';
import { OverviewModule } from './modules/overview/overview.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

@Module({
  imports: [
    // 环境变量配置（从 .env 文件加载）
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // 数据层（全局）
    PrismaModule,
    // 业务模块
    AuthModule,
    PortfolioModule,
    CalculationModule,
    TransactionModule,
    SnapshotModule,
    QueryModule,
    UploadModule,
    AccountModule,
    // T02 新增模块
    SecurityModule,
    HoldingModule,
    DividendModule,
    FeeModule,
    PreferenceModule,
    OverviewModule,
  ],
  providers: [
    // 全局异常过滤器（统一错误响应 { code, data: null, message }）
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // 全局响应转换拦截器（统一成功响应 { code: 0, data, message: 'success' }）
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    // 全局 JWT 认证守卫（@Public() 标记的路由跳过认证）
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
