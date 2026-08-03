/**
 * SecurityTrade Module — 证券买卖流水管理
 */

import { Module } from '@nestjs/common';
import { SecurityTradeController } from './security-trade.controller';
import { SecurityTradeService } from './security-trade.service';
import { CalculationModule } from '../calculation/calculation.module';

@Module({
  imports: [CalculationModule],
  controllers: [SecurityTradeController],
  providers: [SecurityTradeService],
  exports: [SecurityTradeService],
})
export class SecurityTradeModule {}
