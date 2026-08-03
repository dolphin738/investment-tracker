/**
 * 持仓模块（方案B）
 *
 * 方案B 持仓不落库，由 HoldingDerivationService 按 SecurityTrade 流水实时推导。
 * 旧的方案A HoldingService（持仓快照 CRUD，基于已不存在的 Holding 模型）已删除。
 *
 * 仅提供 HoldingDerivationService，供 OverviewModule / ValuationModule 等消费。
 * 注意：不依赖 CalculationModule。
 */

import { Module } from '@nestjs/common';
import { HoldingDerivationService } from './holding-derivation.service';

@Module({
  providers: [HoldingDerivationService],
  exports: [HoldingDerivationService],
})
export class HoldingModule {}
