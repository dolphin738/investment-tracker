/**
 * SecurityTrade Module — 证券买卖流水管理
 *
 * 依赖 RecalculationModule（用于 recalculateRange 触发）。
 */

import { Module } from '@nestjs/common';
import { SecurityTradeController } from './security-trade.controller';
import { SecurityTradeService } from './security-trade.service';
import { RecalculationModule } from '../recalculation/recalculation.module';

@Module({
  imports: [RecalculationModule],
  controllers: [SecurityTradeController],
  providers: [SecurityTradeService],
  exports: [SecurityTradeService],
})
export class SecurityTradeModule {}
