/**
 * 批量重算模块（统一入口）
 *
 * 提供：
 * - RecalculationService：T1~T5 五类触发事件的统一编排
 *   - recalculateRange：T1~T4（快照层 + 计算层）
 *   - recalculateNavRange：T5（仅计算层）
 *
 * 依赖：
 * - CalculationModule（CalculationService.triggerCalculation）
 * - ValuationModule（AssetValuationService）
 */

import { Module } from '@nestjs/common';
import { RecalculationService } from './recalculation.service';
import { CalculationModule } from '../calculation/calculation.module';
import { ValuationModule } from '../valuation/valuation.module';

@Module({
  imports: [CalculationModule, ValuationModule],
  providers: [RecalculationService],
  exports: [RecalculationService],
})
export class RecalculationModule {}
