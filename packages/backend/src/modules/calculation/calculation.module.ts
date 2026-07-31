/**
 * 计算引擎模块
 *
 * 提供：
 * - XirrService：XIRR Newton-Raphson 计算
 * - NavService：净值份额法计算
 * - CalculationService：单日计算编排（净值 + XIRR）
 * - RecalculationService：批量重算（按日期升序逐日）
 *
 * 依赖方向（无循环依赖）：
 *   TransactionModule/SnapshotModule → CalculationModule → PrismaService（全局）
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
