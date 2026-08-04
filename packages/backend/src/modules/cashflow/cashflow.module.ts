/**
 * CashFlow Module — 出入金流水管理
 *
 * 依赖 RecalculationModule（用于 recalculateRange 触发）。
 */

import { Module } from '@nestjs/common';
import { CashFlowController } from './cashflow.controller';
import { CashFlowService } from './cashflow.service';
import { RecalculationModule } from '../recalculation/recalculation.module';

@Module({
  imports: [RecalculationModule],
  controllers: [CashFlowController],
  providers: [CashFlowService],
  exports: [CashFlowService],
})
export class CashFlowModule {}
