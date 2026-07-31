/**
 * 资产快照模块
 *
 * 依赖 CalculationModule（用于触发单日计算和批量重算）。
 * 依赖方向：SnapshotModule → CalculationModule（单向，无循环依赖）。
 */

import { Module } from '@nestjs/common';
import { SnapshotController } from './snapshot.controller';
import { SnapshotService } from './snapshot.service';
import { CalculationModule } from '../calculation/calculation.module';

@Module({
  imports: [CalculationModule],
  controllers: [SnapshotController],
  providers: [SnapshotService],
  exports: [SnapshotService],
})
export class SnapshotModule {}
