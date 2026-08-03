/**
 * 总资产派生模块
 *
 * 提供：
 * - AssetValuationService：总资产派生层（computeDerived / persistDerived
 *   / upsertManual / deleteRecord / resetToDerived）
 *
 * 依赖：
 * - HoldingModule（HoldingDerivationService）
 * - PrismaService（全局）
 */

import { Module } from '@nestjs/common';
import { AssetValuationService } from './asset-valuation.service';
import { HoldingModule } from '../holding/holding.module';

@Module({
  imports: [HoldingModule],
  providers: [AssetValuationService],
  exports: [AssetValuationService],
})
export class ValuationModule {}
