/**
 * 持仓管理模块
 *
 * 提供持仓快照 CRUD + upsert + 汇总聚合。
 * 注意：不依赖 CalculationModule，不触发任何计算（C-09 约束）。
 */

import { Module } from '@nestjs/common';
import { HoldingController } from './holding.controller';
import { HoldingService } from './holding.service';

@Module({
  controllers: [HoldingController],
  providers: [HoldingService],
  exports: [HoldingService],
})
export class HoldingModule {}
