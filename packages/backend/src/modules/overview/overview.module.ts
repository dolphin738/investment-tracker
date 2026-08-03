/**
 * 概览数据聚合模块
 *
 * 组合调用现有 service，提供只读聚合视图。
 * 持仓汇总由 HoldingModule 的 HoldingDerivationService 派生（方案B）。
 * 不写任何数据。
 */

import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';
import { HoldingModule } from '../holding/holding.module';

@Module({
  imports: [HoldingModule],
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class OverviewModule {}
