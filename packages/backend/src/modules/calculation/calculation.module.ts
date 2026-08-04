/**
 * 计算引擎模块
 *
 * 提供：
 * - XirrService：XIRR 适配层（Prisma IO + 调用 finance-core 纯函数）
 * - NavService：净值适配层（Prisma IO + 调用 finance-core 纯函数）
 * - CalculationService：单日计算编排（净值 + XIRR）
 *
 * 批量重算编排（RecalculationService）已迁至 RecalculationModule，
 * 该模块不再导出 RecalculationService。
 *
 * 金融算法本体位于 @investment-tracker/finance-core（零依赖纯函数库），
 * 该包不含 Prisma / NestJS 依赖，无需注册为 provider，纯函数直接 import 即可。
 *
 * 依赖方向（无循环依赖）：
 *   RecalculationModule → CalculationModule → PrismaService（全局）
 *                                           → finance-core（纯函数）
 */

import { Module } from '@nestjs/common';
import { CalculationService } from './calculation.service';
import { NavService } from './nav.service';
import { XirrService } from './xirr.service';

@Module({
  providers: [XirrService, NavService, CalculationService],
  exports: [CalculationService],
})
export class CalculationModule {}
