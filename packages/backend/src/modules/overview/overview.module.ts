/**
 * 概览数据聚合模块
 *
 * 组合调用现有 service，提供只读聚合视图。
 * 不写任何数据。
 */

import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

@Module({
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class OverviewModule {}
