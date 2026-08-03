/**
 * 持仓模块（方案B）
 *
 * 方案B 持仓不落库，由 HoldingDerivationService 按 SecurityTrade 流水实时推导。
 * 旧的方案A HoldingService（持仓快照 CRUD，基于已不存在的 Holding 模型）已删除。
 *
 * 提供：
 * - HoldingController：只读端点 GET /api/portfolios/:portfolioId/holdings
 * - HoldingDerivationService：供本模块 controller 与 OverviewModule / ValuationModule 消费
 *
 * 注意：不依赖 CalculationModule。
 */

import { Module } from '@nestjs/common';
import { HoldingController } from './holding.controller';
import { HoldingDerivationService } from './holding-derivation.service';

@Module({
  controllers: [HoldingController],
  providers: [HoldingDerivationService],
  exports: [HoldingDerivationService],
})
export class HoldingModule {}
