/**
 * 计算引擎模块
 *
 * 提供：
 * - XirrService：XIRR 适配层（Prisma IO + 调用 finance-core 纯函数）
 * - NavService：净值适配层（Prisma IO + 调用 finance-core 纯函数）
 * - CalculationService：单日计算编排（净值 + XIRR）
 * - RecalculationService：批量重算（按日期升序逐日）
 *
 * 金融算法本体位于 @investment-tracker/finance-core（零依赖纯函数库），
 * 该包不含 Prisma / NestJS 依赖，无需注册为 provider，纯函数直接 import 即可。
 *
 * 依赖方向（无循环依赖）：
 *   TransactionModule/SnapshotModule → CalculationModule → PrismaService（全局）
 *                                                        → finance-core（纯函数）
 */

import { Module } from '@nestjs/common';
import { CalculationService } from './calculation.service';
import { NavService } from './nav.service';
import { XirrService } from './xirr.service';
import { RecalculationService } from './recalculation.service';

@Module({
  providers: [XirrService, NavService, CalculationService, RecalculationService],
  exports: [CalculationService, RecalculationService],
})
export class CalculationModule {}
