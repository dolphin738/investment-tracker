/**
 * 持仓管理模块
 *
 * 提供持仓快照 CRUD + upsert + 汇总聚合 + 同步至资产快照。
 * 注意：不依赖 CalculationModule。
 * sync-snapshot 通过 SnapshotModule 间接触发计算（C-09 允许）。
 */

import { Module } from '@nestjs/common';
import { HoldingController } from './holding.controller';
import { HoldingService } from './holding.service';
import { SnapshotModule } from '../snapshot/snapshot.module';

@Module({
  imports: [SnapshotModule],
  controllers: [HoldingController],
  providers: [HoldingService],
  exports: [HoldingService],
})
export class HoldingModule {}
