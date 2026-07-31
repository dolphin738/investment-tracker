/**
 * 交易管理模块
 *
 * 依赖 CalculationModule（用于触发单日计算和批量重算）。
 * 依赖方向：TransactionModule → CalculationModule（单向，无循环依赖）。
 */

import { Module } from '@nestjs/common';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { CalculationModule } from '../calculation/calculation.module';

@Module({
  imports: [CalculationModule],
  controllers: [TransactionController],
  providers: [TransactionService],
  exports: [TransactionService],
})
export class TransactionModule {}
