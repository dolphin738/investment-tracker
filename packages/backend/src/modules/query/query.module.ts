/**
 * 查询模块
 *
 * 提供四维度查询聚合（日/周/月/年 + 期末值/均值）。
 * 🆕 T03 增强：摘要 / 重算 / 回撤 / 多组合对比。
 * 依赖 RecalculationModule（重算编排）。
 */

import { Module } from '@nestjs/common';
import { QueryController } from './query.controller';
import { PortfolioSummaryController } from './summary.controller';
import { QueryService } from './query.service';
import { QueryServiceEnhanced } from './query-enhanced.service';
import { RecalculationModule } from '../recalculation/recalculation.module';

@Module({
  imports: [RecalculationModule],
  controllers: [QueryController, PortfolioSummaryController],
  providers: [QueryService, QueryServiceEnhanced],
})
export class QueryModule {}
