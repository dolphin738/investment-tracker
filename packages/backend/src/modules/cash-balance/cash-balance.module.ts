/**
 * CashBalance Module — 现金余额管理
 *
 * 依赖 RecalculationModule（用于 recalculateRange 触发）。
 */

import { Module } from '@nestjs/common';
import { CashBalanceController } from './cash-balance.controller';
import { CashBalanceService } from './cash-balance.service';
import { RecalculationModule } from '../recalculation/recalculation.module';

@Module({
  imports: [RecalculationModule],
  controllers: [CashBalanceController],
  providers: [CashBalanceService],
  exports: [CashBalanceService],
})
export class CashBalanceModule {}
