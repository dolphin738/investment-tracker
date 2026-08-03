/**
 * 资产快照模块（方案B）
 *
 * 依赖 CalculationModule（用于 T5 recalculateNavRange 触发）。
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
