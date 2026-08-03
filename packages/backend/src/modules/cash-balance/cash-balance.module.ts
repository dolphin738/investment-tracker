/**
 * CashBalance Module — 现金余额管理
 */

import { Module } from '@nestjs/common';
import { CashBalanceController } from './cash-balance.controller';
import { CashBalanceService } from './cash-balance.service';
import { CalculationModule } from '../calculation/calculation.module';

@Module({
  imports: [CalculationModule],
  controllers: [CashBalanceController],
  providers: [CashBalanceService],
  exports: [CashBalanceService],
})
export class CashBalanceModule {}
