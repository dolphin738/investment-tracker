/**
 * 资产快照模块（方案B）
 *
 * 依赖 RecalculationModule（用于 T5 recalculateNavRange 触发）。
 * 依赖 ValuationModule（F3/F4 委托 AssetValuationService.deleteRecord /
 * resetToDerived 正确回填/恢复系统值；无循环依赖，ValuationModule 仅依赖 HoldingModule）。
 */

import { Module } from '@nestjs/common';
import { SnapshotController } from './snapshot.controller';
import { SnapshotService } from './snapshot.service';
import { RecalculationModule } from '../recalculation/recalculation.module';
import { ValuationModule } from '../valuation/valuation.module';

@Module({
  imports: [RecalculationModule, ValuationModule],
  controllers: [SnapshotController],
  providers: [SnapshotService],
  exports: [SnapshotService],
})
export class SnapshotModule {}
